import "server-only"

import type { NextRequest } from "next/server"

import { isApiKey, resolveApiKey } from "@/lib/api-keys"
import { getCurrentUser } from "@/lib/auth"
import { ensureAppSchema, getPool } from "@/lib/db"
import { verifyNostrHttpAuth } from "@/lib/nostr-http-auth"

export type RequestIdentity = {
  principalId: string
  tenantId: string
  kind: "human" | "agent" | "service"
  role: "owner" | "admin" | "member" | "agent" | "service"
  scopes: string[]
  nostrPubkey: string | null
}

export async function getRequestIdentity(
  request: NextRequest,
  boundedBody?: Uint8Array,
): Promise<RequestIdentity | null> {
  const user = await getCurrentUser()
  if (user) {
    return {
      principalId: user.principalId,
      tenantId: user.tenantId,
      kind: "human",
      role: user.role,
      scopes: ["*"],
      nostrPubkey: user.nostrPubkey,
    }
  }

  // An API key acts for the principal that minted it throughout that tenant.
  const authorization = request.headers.get("Authorization") || ""
  if (authorization.startsWith("Bearer ")) {
    const presented = authorization.slice("Bearer ".length).trim()
    if (isApiKey(presented)) {
      const resolved = await resolveApiKey(presented)
      if (!resolved) return null
      return {
        principalId: resolved.principalId,
        tenantId: resolved.tenantId,
        kind: "human",
        role: "member",
        scopes: ["*"],
        nostrPubkey: null,
      }
    }
  }

  const event = await verifyNostrHttpAuth(request, undefined, boundedBody)
  if (!event) return null

  await ensureAppSchema()
  const client = await getPool().connect()
  try {
    await client.query("BEGIN")
    await client.query("DELETE FROM app_nostr_auth_events WHERE expires_at <= now()")
    const result = await client.query<{
      principalId: string
      tenantId: string
      kind: RequestIdentity["kind"]
      role: RequestIdentity["role"]
      nostrPubkey: string
    }>(
      `SELECT a.principal_id AS "principalId", a.tenant_id AS "tenantId",
              p.kind, m.role, a.nostr_pubkey AS "nostrPubkey"
         FROM app_agents a
         JOIN app_principals p ON p.id = a.principal_id AND p.status = 'active'
         JOIN app_tenant_memberships m
           ON m.tenant_id = a.tenant_id AND m.principal_id = a.principal_id
         JOIN app_tenants t ON t.id = a.tenant_id AND t.status = 'active'
        WHERE a.nostr_pubkey = $1
        LIMIT 1`,
      [event.pubkey],
    )
    const identity = result.rows[0]
    if (!identity) {
      await client.query("ROLLBACK")
      return null
    }
    const replay = await client.query(
      `INSERT INTO app_nostr_auth_events (event_id, pubkey, expires_at)
       VALUES ($1, $2, now() + interval '3 minutes')
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [event.id, event.pubkey],
    )
    if (replay.rowCount !== 1) {
      await client.query("ROLLBACK")
      return null
    }
    await client.query(
      "UPDATE app_agents SET last_used_at = now() WHERE principal_id = $1",
      [identity.principalId],
    )
    await client.query("COMMIT")
    return { ...identity, scopes: ["*"] }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/**
 * Authenticate a mutation with a fresh, payload-bound NIP-98 event. A browser
 * session may select the tenant, but it cannot substitute for the request
 * signature and its Nostr key must match the event signer exactly.
 */
export async function getVerifiedNostrRequestIdentity(
  request: NextRequest,
  boundedBody: Uint8Array,
): Promise<RequestIdentity | null> {
  const event = await verifyNostrHttpAuth(request, undefined, boundedBody)
  if (!event) return null

  await ensureAppSchema()
  const user = await getCurrentUser()
  let identity: RequestIdentity | null = null
  if (user) {
    if (user.authMethod !== "nostr" || user.nostrPubkey !== event.pubkey) return null
    identity = {
      principalId: user.principalId,
      tenantId: user.tenantId,
      kind: "human",
      role: user.role,
      scopes: ["*"],
      nostrPubkey: user.nostrPubkey,
    }
  }

  const client = await getPool().connect()
  try {
    await client.query("BEGIN")
    if (!identity) {
      const result = await client.query<{
        principalId: string
        tenantId: string
        kind: RequestIdentity["kind"]
        role: RequestIdentity["role"]
        nostrPubkey: string
      }>(
        `SELECT a.principal_id AS "principalId", a.tenant_id AS "tenantId",
                p.kind, m.role, a.nostr_pubkey AS "nostrPubkey"
           FROM app_agents a
           JOIN app_principals p ON p.id = a.principal_id AND p.status = 'active'
           JOIN app_tenant_memberships m
             ON m.tenant_id = a.tenant_id AND m.principal_id = a.principal_id
           JOIN app_tenants t ON t.id = a.tenant_id AND t.status = 'active'
          WHERE a.nostr_pubkey = $1
          LIMIT 1`,
        [event.pubkey],
      )
      identity = result.rows[0] ? { ...result.rows[0], scopes: ["*"] } : null
    }
    if (!identity) {
      await client.query("ROLLBACK")
      return null
    }

    await client.query("DELETE FROM app_nostr_request_events WHERE expires_at <= now()")
    const replay = await client.query(
      `INSERT INTO app_nostr_request_events
         (event_id, tenant_id, principal_id, pubkey, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '3 minutes')
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [event.id, identity.tenantId, identity.principalId, event.pubkey],
    )
    if (replay.rowCount !== 1) {
      await client.query("ROLLBACK")
      return null
    }
    if (identity.kind === "agent") {
      await client.query(
        "UPDATE app_agents SET last_used_at = now() WHERE principal_id = $1",
        [identity.principalId],
      )
    }
    await client.query("COMMIT")
    return { ...identity, scopes: ["*"] }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export function identityCan(identity: RequestIdentity, scope: string) {
  void identity
  void scope
  return true
}

export function identityCanAny(identity: RequestIdentity, scopes: string[]) {
  return scopes.some((scope) => identityCan(identity, scope))
}
