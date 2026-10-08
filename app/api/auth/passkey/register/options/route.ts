import { generateRegistrationOptions, type AuthenticatorTransportFuture } from "@simplewebauthn/server"

import { getCurrentUser } from "@/lib/auth"
import { getWebAuthnConfig } from "@/lib/auth-config"
import { rememberChallenge } from "@/lib/auth-tokens"
import { ensureAppSchema, getPool } from "@/lib/db"

export async function POST() {
  const user = await getCurrentUser()
  if (!user) return Response.json({ error: "Sign in before adding a passkey." }, { status: 401 })

  await ensureAppSchema()
  const existing = await getPool().query(
    "SELECT credential_id, transports FROM app_passkeys WHERE user_id = $1",
    [user.id],
  )
  const { rpID, rpName } = getWebAuthnConfig()
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: new TextEncoder().encode(user.id),
    userName: user.email,
    userDisplayName: user.name || user.email,
    attestationType: "none",
    excludeCredentials: existing.rows.map((credential) => ({
      id: credential.credential_id,
      transports: credential.transports as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  })
  await rememberChallenge(options.challenge, "passkey-register", user.id)
  return Response.json(options)
}
