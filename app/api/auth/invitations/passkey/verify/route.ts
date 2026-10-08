import { verifyRegistrationResponse, type RegistrationResponseJSON } from "@simplewebauthn/server"

import { createSession, hashPassword } from "@/lib/auth"
import { getWebAuthnConfig } from "@/lib/auth-config"
import { assertSameAuthOrigin, AuthRequestError, readBoundedAuthJson } from "@/lib/auth-request"
import { authRequestIdentifier, takeAuthRateLimit } from "@/lib/auth-rate-limit"
import { isInviteToken, provisionPersonalWorkspaceInvitation } from "@/lib/auth-security"
import {
  consumeChallengeWithClient,
  createAuthToken,
  hashAuthToken,
  hasChallenge,
} from "@/lib/auth-tokens"
import { ensureAppSchema, getPool } from "@/lib/db"

const NO_STORE = { "Cache-Control": "no-store" }

export async function POST(request: Request) {
  const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE })
  try {
    assertSameAuthOrigin(request)
    const body = await readBoundedAuthJson(request)
    const token = typeof body.token === "string" ? body.token : ""
    const challenge = typeof body.challenge === "string" ? body.challenge : ""
    const response = body.response as RegistrationResponseJSON | undefined
    if (!isInviteToken(token) || !challenge || !response) {
      return respond({ error: "The invitation passkey response is incomplete." }, 400)
    }

    await ensureAppSchema()
    const requestIdentifier = await authRequestIdentifier(request)
    if (!(await takeAuthRateLimit("personal-invite-verify-ip", requestIdentifier, 20, 15 * 60))) {
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
    const purpose = `passkey-invite:${invitationId}`
    if (!(await hasChallenge(challenge, purpose, null))) {
      return respond({ error: "The passkey request expired. Try again." }, 400)
    }

    const { origin, rpID } = getWebAuthnConfig()
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    })
    if (!verification.verified) throw new Error("Passkey verification was not completed.")
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo

    const client = await getPool().connect()
    let provisioned: { userId: string; principalId: string; tenantId: string } | null = null
    try {
      await client.query("BEGIN")
      if (!(await consumeChallengeWithClient(client, challenge, purpose, null))) {
        await client.query("ROLLBACK")
        return respond({ error: "The passkey request was already used." }, 409)
      }
      provisioned = await provisionPersonalWorkspaceInvitation(client, {
        tokenHash: hashAuthToken(token),
        passwordHash: hashPassword(createAuthToken()),
        credential: {
          id: credential.id,
          publicKey: Buffer.from(credential.publicKey),
          counter: credential.counter,
          transports: credential.transports || [],
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
          label: "Primary passkey",
        },
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

    await createSession(provisioned.userId, provisioned.tenantId, { method: "passkey" })
    return respond({ ok: true })
  } catch (error: unknown) {
    if (error instanceof AuthRequestError) return respond({ error: error.message }, error.status)
    if ((error as { code?: string })?.code === "23505") {
      return respond({ error: "That email or passkey is already registered." }, 409)
    }
    console.error("Invitation passkey verification failed", error)
    return respond({ error: "The passkey could not be verified." }, 400)
  }
}
