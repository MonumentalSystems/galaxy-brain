import { verifyEvent, type Event as NostrEvent } from "nostr-tools"

import { createSession, hashPassword } from "@/lib/auth"
import { getAuthOrigin } from "@/lib/auth-config"
import { assertSameAuthOrigin, AuthRequestError, readBoundedAuthJson } from "@/lib/auth-request"
import { authRequestIdentifier, takeAuthRateLimit } from "@/lib/auth-rate-limit"
import { isInviteToken, isNostrTimestampFresh, provisionPersonalWorkspaceInvitation } from "@/lib/auth-security"
import {
  consumeChallengeWithClient,
  createAuthToken,
  hashAuthToken,
  hasChallenge,
} from "@/lib/auth-tokens"
import { ensureAppSchema, getPool } from "@/lib/db"

const NO_STORE = { "Cache-Control": "no-store" }

function hasExactTag(event: NostrEvent, name: string, value: string) {
  return event.tags.some((tag) => tag.length === 2 && tag[0] === name && tag[1] === value)
}

function looksLikeNostrEvent(value: unknown): value is NostrEvent {
  if (!value || typeof value !== "object") return false
  const event = value as Partial<NostrEvent>
  return (
    typeof event.id === "string"
    && typeof event.pubkey === "string"
    && typeof event.sig === "string"
    && typeof event.kind === "number"
    && typeof event.created_at === "number"
    && typeof event.content === "string"
    && Array.isArray(event.tags)
    && event.tags.every((tag) => Array.isArray(tag) && tag.every((part) => typeof part === "string"))
  )
}

export async function POST(request: Request) {
  const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE })
  try {
    assertSameAuthOrigin(request)
    const body = await readBoundedAuthJson(request)
    const token = typeof body.token === "string" ? body.token : ""
    const challenge = typeof body.challenge === "string" ? body.challenge : ""
    const event = body.event
    if (!isInviteToken(token) || !challenge || !looksLikeNostrEvent(event)) {
      return respond({ error: "The invitation Nostr response is incomplete." }, 400)
    }

    await ensureAppSchema()
    const requestIdentifier = await authRequestIdentifier(request)
    const [requestAllowed, invitationAllowed] = await Promise.all([
      takeAuthRateLimit("personal-invite-nostr-verify-ip", requestIdentifier, 20, 15 * 60),
      takeAuthRateLimit("personal-invite-nostr-verify-token", hashAuthToken(token), 10, 15 * 60),
    ])
    if (!requestAllowed || !invitationAllowed) {
      return respond({ error: "Too many invitation attempts. Wait before trying again." }, 429)
    }

    const invitationResult = await getPool().query(
      `SELECT id
         FROM app_registration_invitations
        WHERE token_hash = $1
          AND accepted_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > now()
        LIMIT 1`,
      [hashAuthToken(token)],
    )
    const invitationId = invitationResult.rows[0]?.id
    if (!invitationId) return respond({ error: "This invitation is invalid, expired, or already used." }, 410)
    const purpose = `nostr-invite:${invitationId}`

    const expectedUrl = new URL("/api/auth/invitations/nostr/verify", getAuthOrigin()).toString()
    const now = Math.floor(Date.now() / 1000)
    const validShape = (
      event.kind === 27235
      && event.content === ""
      && /^[0-9a-f]{64}$/.test(event.pubkey)
      && isNostrTimestampFresh(event.created_at, now)
      && hasExactTag(event, "u", expectedUrl)
      && hasExactTag(event, "method", "POST")
      && hasExactTag(event, "challenge", challenge)
    )
    let signatureValid = false
    try {
      signatureValid = verifyEvent(event)
    } catch {
      signatureValid = false
    }
    if (!validShape || !signatureValid) {
      return respond({ error: "The Nostr signature is invalid." }, 401)
    }
    if (!(await hasChallenge(challenge, purpose, null))) {
      return respond({ error: "The Nostr request expired. Try again." }, 400)
    }

    const client = await getPool().connect()
    let provisioned: { userId: string; principalId: string; tenantId: string } | null = null
    try {
      await client.query("BEGIN")
      if (!(await consumeChallengeWithClient(client, challenge, purpose, null))) {
        await client.query("ROLLBACK")
        return respond({ error: "The Nostr request was already used." }, 409)
      }
      provisioned = await provisionPersonalWorkspaceInvitation(client, {
        tokenHash: hashAuthToken(token),
        passwordHash: hashPassword(createAuthToken()),
        nostrPubkey: event.pubkey,
        nostrLabel: "Primary Nostr identity",
      })
      if (!provisioned) {
        await client.query("ROLLBACK")
        return respond({ error: "This invitation is invalid, expired, or already used." }, 410)
      }
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally {
      client.release()
    }

    await createSession(provisioned.userId, provisioned.tenantId, { method: "nostr", pubkey: event.pubkey })
    return respond({ ok: true })
  } catch (error: unknown) {
    if (error instanceof AuthRequestError) return respond({ error: error.message }, error.status)
    if ((error as { code?: string })?.code === "23505") {
      return respond({ error: "That email or Nostr key is already registered." }, 409)
    }
    console.error("Invitation Nostr verification failed", error)
    return respond({ error: "The Nostr signature could not be verified." }, 400)
  }
}
