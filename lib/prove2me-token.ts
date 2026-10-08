import "server-only"

/**
 * Prove2me issues a long-lived API key that is exchanged for a short-lived
 * access token (one hour at the time of writing). Exchanging on every proxied
 * request would add a round trip to each call and burn through the refresh
 * endpoint, so the access token is cached in module scope and refreshed a
 * little before it expires.
 *
 * The API key itself never leaves the server: callers only ever receive the
 * access token, and only this module reads PROVE2ME_API_KEY.
 */

const PROVE2ME_API = process.env.PROVE2ME_API_URL || "https://prove2.me/api/v1"

// Refresh early so a token cannot expire in flight on a slow upstream call.
const EXPIRY_SKEW_SECONDS = 120

type CachedToken = {
  accessToken: string
  expiresAtSeconds: number
}

let cached: CachedToken | null = null
let inFlight: Promise<CachedToken> | null = null

export class Prove2meNotConfigured extends Error {}
export class Prove2meRefreshFailed extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function isFresh(token: CachedToken) {
  return token.expiresAtSeconds - EXPIRY_SKEW_SECONDS > Math.floor(Date.now() / 1000)
}

async function exchangeApiKey(apiKey: string): Promise<CachedToken> {
  const response = await fetch(new URL("agent/refresh", `${PROVE2ME_API}/`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
    cache: "no-store",
  })

  if (!response.ok) {
    throw new Prove2meRefreshFailed(
      response.status,
      `Prove2me rejected the API key with status ${response.status}`,
    )
  }

  const payload = (await response.json()) as { access_token?: unknown; expires_at?: unknown }
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Prove2meRefreshFailed(502, "Prove2me refresh response had no access_token")
  }

  // Fall back to a conservative lifetime if the server stops sending expires_at.
  const expiresAtSeconds = typeof payload.expires_at === "number"
    ? payload.expires_at
    : Math.floor(Date.now() / 1000) + 600

  return { accessToken: payload.access_token, expiresAtSeconds }
}

/**
 * Returns a usable Prove2me access token, refreshing at most once at a time so
 * concurrent proxied requests share a single exchange.
 */
export async function getProve2meAccessToken(): Promise<string> {
  const apiKey = process.env.PROVE2ME_API_KEY
  if (!apiKey) throw new Prove2meNotConfigured("PROVE2ME_API_KEY is not set")

  if (cached && isFresh(cached)) return cached.accessToken
  if (inFlight) return (await inFlight).accessToken

  inFlight = exchangeApiKey(apiKey)
  try {
    cached = await inFlight
    return cached.accessToken
  } finally {
    inFlight = null
  }
}

/** Drops the cached token so the next call re-exchanges. Used after a 401. */
export function invalidateProve2meAccessToken() {
  cached = null
}
