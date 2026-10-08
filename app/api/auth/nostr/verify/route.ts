import { verifyEvent, type Event as NostrEvent } from "nostr-tools"

import { createSession, getCurrentUser } from "@/lib/auth"
import { getAuthOrigin } from "@/lib/auth-config"
import { authRequestIdentifier, rateLimitResponse, takeAuthRateLimit } from "@/lib/auth-rate-limit"
import { isNostrTimestampFresh } from "@/lib/auth-security"
import { consumeChallenge, hasChallenge } from "@/lib/auth-tokens"
import { ensureAppSchema, getPool } from "@/lib/db"

function hasExactTag(event: NostrEvent, name: string, value: string) {
  return event.tags.some((tag) => tag.length === 2 && tag[0] === name && tag[1] === value)
}

function looksLikeNostrEvent(value: unknown): value is NostrEvent {
  if (!value || typeof value !== "object") return false
  const event = value as Partial<NostrEvent>
  return (
    typeof event.id === "string" &&
    typeof event.pubkey === "string" &&
    typeof event.sig === "string" &&
    typeof event.kind === "number" &&
    typeof event.created_at === "number" &&
    typeof event.content === "string" &&
    Array.isArray(event.tags) &&
    event.tags.every((tag) => Array.isArray(tag) && tag.every((part) => typeof part === "string"))
  )
}

export async function POST(request: Request) {
  const requestIdentifier = await authRequestIdentifier(request)
  if (!(await takeAuthRateLimit("nostr-verify", requestIdentifier, 20, 60))) {
    return rateLimitResponse()
  }
  const body = (await request.json().catch(() => ({}))) as {
    purpose?: "login" | "enroll"
    challenge?: string
    label?: string
    event?: NostrEvent
  }
  const purpose = body.purpose === "enroll" ? "enroll" : "login"
  const user = purpose === "enroll" ? await getCurrentUser() : null
  if (purpose === "enroll" && !user) {
    return Response.json({ error: "Sign in before adding a Nostr key." }, { status: 401 })
  }
  if (!body.challenge || !looksLikeNostrEvent(body.event)) {
    return Response.json({ error: "The Nostr response is incomplete." }, { status: 400 })
  }

  const expectedUrl = new URL("/api/auth/nostr/verify", getAuthOrigin()).toString()
  const now = Math.floor(Date.now() / 1000)
  const event = body.event
  const validShape =
    event.kind === 27235 &&
    event.content === "" &&
    /^[0-9a-f]{64}$/.test(event.pubkey) &&
    isNostrTimestampFresh(event.created_at, now) &&
    hasExactTag(event, "u", expectedUrl) &&
    hasExactTag(event, "method", "POST") &&
    hasExactTag(event, "challenge", body.challenge)

  let signatureValid = false
  try {
    signatureValid = verifyEvent(event)
  } catch {
    signatureValid = false
  }
  if (!validShape || !signatureValid) {
    return Response.json({ error: "The Nostr signature is invalid." }, { status: 401 })
  }
  if (!(await hasChallenge(body.challenge, `nostr-${purpose}`, user?.id || null))) {
    return Response.json({ error: "The Nostr request expired. Try again." }, { status: 400 })
  }
  if (!(await consumeChallenge(body.challenge, `nostr-${purpose}`, user?.id || null))) {
    return Response.json({ error: "The Nostr request was already used." }, { status: 409 })
  }

  await ensureAppSchema()
  if (purpose === "enroll" && user) {
    try {
      await getPool().query(
        "INSERT INTO app_nostr_keys (user_id, pubkey, label) VALUES ($1, $2, $3)",
        [user.id, event.pubkey, body.label?.trim() || null],
      )
      return Response.json({ ok: true })
    } catch (error: any) {
      if (error?.code === "23505") {
        return Response.json({ error: "That Nostr key is already registered." }, { status: 409 })
      }
      throw error
    }
  }

  const result = await getPool().query(
    "SELECT id, user_id FROM app_nostr_keys WHERE pubkey = $1 LIMIT 1",
    [event.pubkey],
  )
  const key = result.rows[0]
  if (!key) return Response.json({ error: "This Nostr key is not registered here." }, { status: 401 })
  await getPool().query("UPDATE app_nostr_keys SET last_used_at = now() WHERE id = $1", [key.id])
  await createSession(key.user_id, undefined, { method: "nostr", pubkey: event.pubkey })
  return Response.json({ ok: true })
}
