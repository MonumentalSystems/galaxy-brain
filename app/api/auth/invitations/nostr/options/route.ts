import { getAuthOrigin } from "@/lib/auth-config"
import { assertSameAuthOrigin, AuthRequestError, readBoundedAuthJson } from "@/lib/auth-request"
import { authRequestIdentifier, takeAuthRateLimit } from "@/lib/auth-rate-limit"
import { isInviteToken } from "@/lib/auth-security"
import { createAuthToken, hashAuthToken, rememberChallenge } from "@/lib/auth-tokens"
import { ensureAppSchema, getPool } from "@/lib/db"

const NO_STORE = { "Cache-Control": "no-store" }

export async function POST(request: Request) {
  const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE })
  try {
    assertSameAuthOrigin(request)
    const body = await readBoundedAuthJson(request, 8 * 1024)
    const token = typeof body.token === "string" ? body.token : ""
    if (!isInviteToken(token)) return respond({ error: "This invitation link is incomplete." }, 400)

    await ensureAppSchema()
    const requestIdentifier = await authRequestIdentifier(request)
    const [requestAllowed, invitationAllowed] = await Promise.all([
      takeAuthRateLimit("personal-invite-nostr-ip", requestIdentifier, 20, 15 * 60),
      takeAuthRateLimit("personal-invite-nostr-token", hashAuthToken(token), 10, 15 * 60),
    ])
    if (!requestAllowed || !invitationAllowed) {
      return respond({ error: "Too many invitation attempts. Wait before trying again." }, 429)
    }

    const result = await getPool().query(
      `SELECT invitation.id
         FROM app_registration_invitations AS invitation
        WHERE invitation.token_hash = $1
          AND invitation.accepted_at IS NULL
          AND invitation.revoked_at IS NULL
          AND invitation.expires_at > now()
          AND NOT EXISTS (
            SELECT 1 FROM app_users WHERE app_users.email = invitation.email
          )
        LIMIT 1`,
      [hashAuthToken(token)],
    )
    const invitationId = result.rows[0]?.id
    if (!invitationId) return respond({ error: "This invitation is invalid, expired, or already used." }, 410)

    const challenge = createAuthToken()
    await rememberChallenge(challenge, `nostr-invite:${invitationId}`, null)
    return respond({
      challenge,
      url: new URL("/api/auth/invitations/nostr/verify", getAuthOrigin()).toString(),
    })
  } catch (error: unknown) {
    if (error instanceof AuthRequestError) return respond({ error: error.message }, error.status)
    console.error("Invitation Nostr setup failed", error)
    return respond({ error: "Nostr sign-in setup could not start." }, 500)
  }
}
