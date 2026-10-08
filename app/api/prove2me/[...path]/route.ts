import { NextRequest, NextResponse } from "next/server"

import {
  getProve2meAccessToken,
  invalidateProve2meAccessToken,
  Prove2meNotConfigured,
  Prove2meRefreshFailed,
} from "@/lib/prove2me-token"
import {
  isAllowedProve2meRead,
  isSafeProve2mePath,
  PROVE2ME_READ_SCOPES,
} from "@/lib/prove2me-scope"
import { getRequestIdentity, identityCanAny } from "@/lib/request-identity"

const PROVE2ME_API = process.env.PROVE2ME_API_URL || "https://prove2.me/api/v1"

type RouteContext = {
  params: Promise<{ path: string[] }>
}

/**
 * Reads Prove2me on behalf of the signed-in principal. The Prove2me credential
 * belongs to the deployment rather than to the caller, so the caller is
 * authorised here and the upstream call carries the deployment's own token.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const identity = await getRequestIdentity(request)
  if (!identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!identityCanAny(identity, PROVE2ME_READ_SCOPES)) {
    return NextResponse.json({ error: "Missing prove2me:read scope" }, { status: 403 })
  }

  const { path } = await context.params
  if (!isSafeProve2mePath(path)) {
    return NextResponse.json({ error: "Invalid Prove2me path" }, { status: 400 })
  }
  if (!isAllowedProve2meRead(path)) {
    return NextResponse.json({ error: "Prove2me path is not proxied" }, { status: 404 })
  }

  let accessToken: string
  try {
    accessToken = await getProve2meAccessToken()
  } catch (error) {
    if (error instanceof Prove2meNotConfigured) {
      return NextResponse.json({ error: "Prove2me is not configured" }, { status: 503 })
    }
    if (error instanceof Prove2meRefreshFailed) {
      return NextResponse.json({ error: "Prove2me credentials were rejected" }, { status: 502 })
    }
    throw error
  }

  const upstreamUrl = new URL(`${path.map(encodeURIComponent).join("/")}`, `${PROVE2ME_API}/`)
  upstreamUrl.search = request.nextUrl.search

  let upstream = await fetch(upstreamUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  })

  // A cached token can still be rejected if it was revoked upstream. Re-exchange
  // once so a stale cache does not surface as a failure to the caller.
  if (upstream.status === 401) {
    invalidateProve2meAccessToken()
    try {
      const retryToken = await getProve2meAccessToken()
      upstream = await fetch(upstreamUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${retryToken}` },
        cache: "no-store",
      })
    } catch {
      return NextResponse.json({ error: "Prove2me credentials were rejected" }, { status: 502 })
    }
  }

  const headers = new Headers()
  headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json")
  for (const name of ["Cache-Control", "ETag", "Link"]) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }

  return new NextResponse(upstream.body, { status: upstream.status, headers })
}
