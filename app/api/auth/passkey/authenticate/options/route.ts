import { generateAuthenticationOptions } from "@simplewebauthn/server"

import { getWebAuthnConfig } from "@/lib/auth-config"
import { authRequestIdentifier, rateLimitResponse, takeAuthRateLimit } from "@/lib/auth-rate-limit"
import { rememberChallenge } from "@/lib/auth-tokens"

export async function POST(request: Request) {
  const requestIdentifier = await authRequestIdentifier(request)
  if (!(await takeAuthRateLimit("passkey-options", requestIdentifier, 10, 60))) {
    return rateLimitResponse()
  }
  const { rpID } = getWebAuthnConfig()
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: [],
    userVerification: "required",
  })
  await rememberChallenge(options.challenge, "passkey-login", null)
  return Response.json(options)
}
