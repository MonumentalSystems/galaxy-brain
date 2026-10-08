import "server-only"

import { hashAuthToken, createAuthToken } from "@/lib/auth-tokens"
import { ensureAppSchema, getPool } from "@/lib/db"

/**
 * API keys let something outside the browser act for a person: a clipper
 * extension, a script, another service. They are stored the way sessions are —
 * only the SHA-256 hash is persisted, so a database read cannot recover a
 * usable key — and they resolve to the principal who minted them.
 *
 * API keys deliberately do not negotiate permissions. A valid key acts as the
 * person who created it inside that person's tenant. The legacy `scopes`
 * column stays populated with `*` so existing databases remain compatible.
 */

/** Distinguishes a Galaxy Brain key on sight, in logs and in secret scanners. */
const KEY_PREFIX = "gb_live_"

export type ApiKeyRecord = {
  id: string
  label: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

export type ResolvedApiKey = {
  tokenId: string
  principalId: string
  tenantId: string
}

export function isApiKey(candidate: string) {
  return candidate.startsWith(KEY_PREFIX)
}

/**
 * Mints a key for a principal. The plaintext is returned once and never stored;
 * callers must surface it immediately or lose it.
 */
export async function createApiKey(options: {
  tenantId: string
  principalId: string
  label: string
  expiresInDays?: number | null
}): Promise<{ key: string; record: ApiKeyRecord }> {
  await ensureAppSchema()

  const key = `${KEY_PREFIX}${createAuthToken(32)}`
  const expiresAt = options.expiresInDays
    ? new Date(Date.now() + options.expiresInDays * 86_400_000).toISOString()
    : null

  const result = await getPool().query<{
    id: string
    label: string
    created_at: string
    expires_at: string | null
  }>(
    `INSERT INTO app_api_tokens (tenant_id, principal_id, token_hash, label, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, label, created_at, expires_at`,
    [options.tenantId, options.principalId, hashAuthToken(key), options.label, ["*"], expiresAt],
  )

  const row = result.rows[0]
  return {
    key,
    record: {
      id: row.id,
      label: row.label,
      createdAt: row.created_at,
      lastUsedAt: null,
      expiresAt: row.expires_at,
    },
  }
}

/**
 * Resolves a presented key, or null when it is unknown, revoked or expired.
 * Records last_used_at so an unused key is visible as such before revoking it.
 */
export async function resolveApiKey(key: string): Promise<ResolvedApiKey | null> {
  if (!isApiKey(key)) return null
  await ensureAppSchema()

  const result = await getPool().query<{
    id: string
    principal_id: string
    tenant_id: string
  }>(
    `UPDATE app_api_tokens
        SET last_used_at = now()
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      RETURNING id, principal_id, tenant_id`,
    [hashAuthToken(key)],
  )

  const row = result.rows[0]
  if (!row) return null
  return {
    tokenId: row.id,
    principalId: row.principal_id,
    tenantId: row.tenant_id,
  }
}

export async function listApiKeys(principalId: string): Promise<ApiKeyRecord[]> {
  await ensureAppSchema()
  const result = await getPool().query<{
    id: string
    label: string
    created_at: string
    last_used_at: string | null
    expires_at: string | null
  }>(
    `SELECT id, label, created_at, last_used_at, expires_at
       FROM app_api_tokens
      WHERE principal_id = $1 AND revoked_at IS NULL
      ORDER BY created_at DESC`,
    [principalId],
  )
  return result.rows.map((row) => ({
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  }))
}

/** Revocation is a tombstone, so a revoked key's hash can never be reissued. */
export async function revokeApiKey(principalId: string, tokenId: string): Promise<boolean> {
  await ensureAppSchema()
  const result = await getPool().query(
    `UPDATE app_api_tokens
        SET revoked_at = now()
      WHERE id = $1 AND principal_id = $2 AND revoked_at IS NULL`,
    [tokenId, principalId],
  )
  return (result.rowCount ?? 0) > 0
}
