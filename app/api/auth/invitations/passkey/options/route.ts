import { generateRegistrationOptions } from "@simplewebauthn/server"

import { getWebAuthnConfig } from "@/lib/auth-config"
import { assertSameAuthOrigin, AuthRequestError, readBoundedAuthJson } from "@/lib/auth-request"
import { authRequestIdentifier, takeAuthRateLimit } from "@/lib/auth-rate-limit"
import { isInviteToken } from "@/lib/auth-security"
import { hashAuthToken, rememberChallenge } from "@/lib/auth-tokens"
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
      takeAuthRateLimit("personal-invite-redeem-ip", requestIdentifier, 20, 15 * 60),
      takeAuthRateLimit("personal-invite-redeem-token", hashAuthToken(token), 10, 15 * 60),
    ])
    if (!requestAllowed || !invitationAllowed) {
      return respond({ error: "Too many invitation attempts. Wait before trying again." }, 429)
    }

    const result = await getPool().query(
      `SELECT invitation.id, invitation.email, invitation.name
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
    const invitation = result.rows[0]
    if (!invitation) return respond({ error: "This invitation is invalid, expired, or already used." }, 410)

    const { rpID, rpName } = getWebAuthnConfig()
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: new TextEncoder().encode(invitation.id),
      userName: invitation.email,
      userDisplayName: invitation.name || invitation.email,
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
    })
    await rememberChallenge(options.challenge, `passkey-invite:${invitation.id}`, null)
    return respond(options)
  } catch (error: unknown) {
    if (error instanceof AuthRequestError) return respond({ error: error.message }, error.status)
    console.error("Invitation passkey setup failed", error)
    return respond({ error: "Passkey setup could not start." }, 500)
  }
}
