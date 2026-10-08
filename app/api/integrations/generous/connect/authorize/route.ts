import { getCurrentUser } from "@/lib/auth"
import { getAuthOrigin } from "@/lib/auth-config"
import { createAuthToken, rememberChallenge } from "@/lib/auth-tokens"
import {
  generousConnectionPurpose,
  isAllowedGenerousCallback,
  isValidGenerousState,
} from "@/lib/generous-connect"

export async function POST(request: Request) {
  if (request.headers.get("origin") !== getAuthOrigin()) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 })
  }
  const user = await getCurrentUser()
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 })
  if (user.authMethod !== "nostr" || !user.nostrPubkey) {
    return Response.json({ error: "Sign in with Nostr before connecting." }, { status: 403 })
  }
  const body = await request.json().catch(() => ({})) as { callback?: unknown; state?: unknown }
  if (!isAllowedGenerousCallback(body.callback) || !isValidGenerousState(body.state)) {
    return Response.json({ error: "Invalid connection request." }, { status: 400 })
  }

  const code = createAuthToken()
  await rememberChallenge(
    code,
    generousConnectionPurpose(user.tenantId, user.nostrPubkey),
    user.id,
    300,
  )
  const redirectUrl = new URL(body.callback)
  redirectUrl.searchParams.set("code", code)
  redirectUrl.searchParams.set("state", body.state)
  return Response.json({ redirectUrl: redirectUrl.toString() })
}
