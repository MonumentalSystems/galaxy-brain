import { NextRequest } from "next/server"

import { isApiKey, resolveApiKey } from "@/lib/api-keys"
import { authRequestIdentifier, rateLimitResponse, takeAuthRateLimit } from "@/lib/auth-rate-limit"
import { consumeChallengeByPurposePrefix } from "@/lib/auth-tokens"
import { ensureAppSchema, getPool } from "@/lib/db"
import {
  GENEROUS_CONNECT_PURPOSE_PREFIX,
  parseGenerousConnectionPurpose,
} from "@/lib/generous-connect"

const CODE = /^[A-Za-z0-9_-]{43}$/

export async function POST(request: NextRequest) {
  const requestIdentifier = await authRequestIdentifier(request)
  if (!(await takeAuthRateLimit("generous-connect-exchange", requestIdentifier, 20, 60))) {
    return rateLimitResponse()
  }
  const authorization = request.headers.get("authorization") || ""
  const presented = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : ""
  const identity = isApiKey(presented) ? await resolveApiKey(presented) : null
  if (!identity) return Response.json({ error: "Unauthorized" }, { status: 401 })
  const body = await request.json().catch(() => ({})) as { code?: unknown }
  if (typeof body.code !== "string" || !CODE.test(body.code)) {
    return Response.json({ error: "Invalid authorization code" }, { status: 400 })
  }
  const consumed = await consumeChallengeByPurposePrefix(body.code, GENEROUS_CONNECT_PURPOSE_PREFIX)
  if (!consumed) {
    return Response.json({ error: "Authorization code expired or already used" }, { status: 400 })
  }
  const connection = parseGenerousConnectionPurpose(consumed.purpose)
  if (!connection || connection.tenantId !== identity.tenantId) {
    return Response.json({ error: "Authorization tenant does not match the integration" }, { status: 403 })
  }

  await ensureAppSchema()
  const result = await getPool().query<{
    principalId: string
    tenantId: string
    nostrPubkey: string
  }>(
    `SELECT u.principal_id AS "principalId", m.tenant_id AS "tenantId", k.pubkey AS "nostrPubkey"
       FROM app_users u
       JOIN app_principals p ON p.id = u.principal_id AND p.status = 'active'
       JOIN app_tenant_memberships m
         ON m.principal_id = u.principal_id AND m.tenant_id = $2::uuid
       JOIN app_tenants t ON t.id = m.tenant_id AND t.status = 'active'
       JOIN app_nostr_keys k ON k.user_id = u.id AND k.pubkey = $3
      WHERE u.id = $1
      LIMIT 1`,
    [consumed.userId, connection.tenantId, connection.nostrPubkey],
  )
  const linked = result.rows[0]
  if (!linked) return Response.json({ error: "Linked Galaxy identity is no longer active" }, { status: 403 })
  return Response.json(linked, { headers: { "Cache-Control": "no-store" } })
}
