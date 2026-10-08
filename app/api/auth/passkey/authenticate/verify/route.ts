import {
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server"

import { createSession } from "@/lib/auth"
import { getWebAuthnConfig } from "@/lib/auth-config"
import { authRequestIdentifier, rateLimitResponse, takeAuthRateLimit } from "@/lib/auth-rate-limit"
import { updatePasskeyCounter } from "@/lib/auth-security"
import { consumeChallengeWithClient, hasChallenge } from "@/lib/auth-tokens"
import { ensureAppSchema, getPool } from "@/lib/db"

export async function POST(request: Request) {
  const requestIdentifier = await authRequestIdentifier(request)
  if (!(await takeAuthRateLimit("passkey-verify", requestIdentifier, 20, 60))) {
    return rateLimitResponse()
  }
  const body = (await request.json().catch(() => ({}))) as {
    challenge?: string
    response?: AuthenticationResponseJSON
  }
  if (!body.challenge || !body.response) {
    return Response.json({ error: "The passkey response is incomplete." }, { status: 400 })
  }
  if (!(await hasChallenge(body.challenge, "passkey-login", null))) {
    return Response.json({ error: "The passkey request expired. Try again." }, { status: 400 })
  }

  await ensureAppSchema()
  const { origin, rpID } = getWebAuthnConfig()
  const client = await getPool().connect()
  let userId: string | null = null
  try {
    await client.query("BEGIN")
    const result = await client.query(
      `SELECT id, user_id, credential_id, public_key, counter, transports
         FROM app_passkeys WHERE credential_id = $1 FOR UPDATE`,
      [body.response.id],
    )
    const passkey = result.rows[0]
    if (!passkey) {
      await client.query("ROLLBACK")
      return Response.json({ error: "This passkey is not registered here." }, { status: 401 })
    }

    const verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: body.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: passkey.credential_id,
        publicKey: new Uint8Array(passkey.public_key),
        counter: Number(passkey.counter),
        transports: passkey.transports as AuthenticatorTransportFuture[],
      },
    })
    if (!verification.verified) throw new Error("Passkey verification was not completed.")
    if (!(await consumeChallengeWithClient(client, body.challenge, "passkey-login", null))) {
      await client.query("ROLLBACK")
      return Response.json({ error: "The passkey request was already used." }, { status: 409 })
    }
    const counterUpdated = await updatePasskeyCounter(
      client,
      passkey.id,
      Number(passkey.counter),
      verification.authenticationInfo.newCounter,
    )
    if (!counterUpdated) throw new Error("The passkey counter changed during authentication.")
    userId = passkey.user_id
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    console.error("Passkey authentication failed", error)
    return Response.json({ error: "The passkey could not be verified." }, { status: 401 })
  } finally {
    client.release()
  }

  await createSession(userId!, undefined, { method: "passkey" })
  return Response.json({ ok: true })
}
