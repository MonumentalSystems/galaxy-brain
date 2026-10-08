import { verifyRegistrationResponse, type RegistrationResponseJSON } from "@simplewebauthn/server"

import { getCurrentUser } from "@/lib/auth"
import { getWebAuthnConfig } from "@/lib/auth-config"
import { consumeChallenge, hasChallenge } from "@/lib/auth-tokens"
import { ensureAppSchema, getPool } from "@/lib/db"

export async function POST(request: Request) {
  const user = await getCurrentUser()
  if (!user) return Response.json({ error: "Sign in before adding a passkey." }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as {
    challenge?: string
    label?: string
    response?: RegistrationResponseJSON
  }
  if (!body.challenge || !body.response) {
    return Response.json({ error: "The passkey response is incomplete." }, { status: 400 })
  }
  if (!(await hasChallenge(body.challenge, "passkey-register", user.id))) {
    return Response.json({ error: "The passkey request expired. Try again." }, { status: 400 })
  }

  const { origin, rpID } = getWebAuthnConfig()
  try {
    const verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: body.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    })
    if (!verification.verified) throw new Error("Passkey verification was not completed.")
    if (!(await consumeChallenge(body.challenge, "passkey-register", user.id))) {
      return Response.json({ error: "The passkey request was already used." }, { status: 409 })
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo
    await ensureAppSchema()
    await getPool().query(
      `INSERT INTO app_passkeys
         (user_id, credential_id, public_key, counter, transports, device_type, backed_up, label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        user.id,
        credential.id,
        Buffer.from(credential.publicKey),
        credential.counter,
        credential.transports || [],
        credentialDeviceType,
        credentialBackedUp,
        body.label?.trim() || null,
      ],
    )
    return Response.json({ ok: true })
  } catch (error: any) {
    if (error?.code === "23505") {
      return Response.json({ error: "That passkey is already registered." }, { status: 409 })
    }
    console.error("Passkey registration failed", error)
    return Response.json({ error: "The passkey could not be verified." }, { status: 400 })
  }
}
