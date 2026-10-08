import { getCurrentUser } from "@/lib/auth"
import { getAuthOrigin } from "@/lib/auth-config"
import { authRequestIdentifier, rateLimitResponse, takeAuthRateLimit } from "@/lib/auth-rate-limit"
import { createAuthToken, rememberChallenge } from "@/lib/auth-tokens"

export async function POST(request: Request) {
  const requestIdentifier = await authRequestIdentifier(request)
  if (!(await takeAuthRateLimit("nostr-options", requestIdentifier, 10, 60))) {
    return rateLimitResponse()
  }
  const body = (await request.json().catch(() => ({}))) as { purpose?: string }
  const purpose = body.purpose === "enroll" ? "enroll" : "login"
  const user = purpose === "enroll" ? await getCurrentUser() : null
  if (purpose === "enroll" && !user) {
    return Response.json({ error: "Sign in before adding a Nostr key." }, { status: 401 })
  }

  const challenge = createAuthToken()
  await rememberChallenge(challenge, `nostr-${purpose}`, user?.id || null)
  return Response.json({
    challenge,
    url: new URL("/api/auth/nostr/verify", getAuthOrigin()).toString(),
  })
}
