import "server-only"

import { randomBytes, scryptSync, timingSafeEqual, createHash } from "crypto"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { ensureAppSchema, getPool } from "@/lib/db"

export const SESSION_COOKIE = "gb_session"

export type CurrentUser = {
  id: string
  principalId: string
  tenantId: string
  role: "owner" | "admin" | "member"
  principalKind: "human"
  email: string
  name: string | null
  authenticatedAt: string
  authMethod: "password" | "passkey" | "nostr"
  nostrPubkey: string | null
}

export type SessionAuthentication =
  | { method: "password" }
  | { method: "passkey" }
  | { method: "nostr"; pubkey: string }

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex")
  const hash = scryptSync(password, salt, 64).toString("hex")
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":")
  if (!salt || !hash) return false
  const candidate = scryptSync(password, salt, 64)
  const expected = Buffer.from(hash, "hex")
  return expected.length === candidate.length && timingSafeEqual(expected, candidate)
}

export async function createSession(
  userId: string,
  requestedTenantId?: string,
  authentication: SessionAuthentication = { method: "password" },
) {
  await ensureAppSchema()
  const token = randomBytes(32).toString("base64url")
  const tokenHash = hashToken(token)
  const days = Number(process.env.AUTH_SESSION_DAYS || 30)

  const result = await getPool().query(
    `WITH chosen_tenant AS MATERIALIZED (
       SELECT m.tenant_id
         FROM app_users u
         JOIN app_principals p ON p.id = u.principal_id AND p.status = 'active'
         JOIN app_tenant_memberships m ON m.principal_id = u.principal_id
         JOIN app_tenants t ON t.id = m.tenant_id AND t.status = 'active'
        WHERE u.id = $1
          AND ($2::uuid IS NULL OR m.tenant_id = $2::uuid)
        ORDER BY
          CASE WHEN m.tenant_id = u.default_tenant_id THEN 0 ELSE 1 END,
          CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
          m.created_at,
          m.tenant_id
        LIMIT 1
     ), remembered_tenant AS (
       UPDATE app_users u
          SET default_tenant_id = chosen.tenant_id
         FROM chosen_tenant chosen
        WHERE u.id = $1
        RETURNING chosen.tenant_id
     )
     INSERT INTO app_sessions
       (user_id, tenant_id, token_hash, expires_at, auth_method, nostr_pubkey)
     SELECT $1, tenant_id, $3, now() + ($4::text || ' days')::interval, $5, $6
       FROM remembered_tenant`,
    [
      userId,
      requestedTenantId || null,
      tokenHash,
      days,
      authentication.method,
      authentication.method === "nostr" ? authentication.pubkey : null,
    ],
  )
  if (result.rowCount !== 1) throw new Error("user has no active tenant membership")

  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: days * 24 * 60 * 60,
  })
}

export async function switchCurrentTenant(tenantId: string) {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (!token) return false
  await ensureAppSchema()
  const client = await getPool().connect()
  try {
    await client.query("BEGIN")
    const membership = await client.query<{ userId: string }>(
      `SELECT u.id AS "userId"
         FROM app_sessions s
         JOIN app_users u ON u.id = s.user_id
         JOIN app_principals p ON p.id = u.principal_id AND p.status = 'active'
         JOIN app_tenant_memberships m ON m.principal_id = u.principal_id
         JOIN app_tenants t ON t.id = m.tenant_id AND t.status = 'active'
        WHERE s.token_hash = $1 AND s.expires_at > now() AND m.tenant_id = $2
        FOR UPDATE OF s, u`,
      [hashToken(token), tenantId],
    )
    if (membership.rowCount !== 1) {
      await client.query("ROLLBACK")
      return false
    }
    await client.query("UPDATE app_sessions SET tenant_id = $1 WHERE token_hash = $2", [
      tenantId,
      hashToken(token),
    ])
    await client.query("UPDATE app_users SET default_tenant_id = $1 WHERE id = $2", [
      tenantId,
      membership.rows[0].userId,
    ])
    await client.query("COMMIT")
    return true
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (!token) return null

  await ensureAppSchema()
  const result = await getPool().query(
    `SELECT u.id, u.principal_id AS "principalId", s.tenant_id AS "tenantId",
            m.role, p.kind AS "principalKind", u.email, u.name,
            s.created_at::text AS "authenticatedAt",
            s.auth_method AS "authMethod", s.nostr_pubkey AS "nostrPubkey"
       FROM app_sessions s
       JOIN app_users u ON u.id = s.user_id
       JOIN app_principals p ON p.id = u.principal_id AND p.status = 'active'
       JOIN app_tenant_memberships m
         ON m.tenant_id = s.tenant_id AND m.principal_id = u.principal_id
       JOIN app_tenants t ON t.id = s.tenant_id AND t.status = 'active'
      WHERE s.token_hash = $1
        AND s.expires_at > now()
      LIMIT 1`,
    [hashToken(token)],
  )

  return result.rows[0] || null
}

export async function requireUser() {
  const user = await getCurrentUser()
  if (!user) redirect("/login")
  return user
}

export async function destroySession() {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (token) {
    await ensureAppSchema()
    await getPool().query("DELETE FROM app_sessions WHERE token_hash = $1", [hashToken(token)])
  }
  cookieStore.delete(SESSION_COOKIE)
}
