import "server-only"

import { randomBytes } from "crypto"

import {
  consumeChallengeByPurposePrefixRow,
  consumeChallengeRow,
  hashOpaqueToken,
  insertReplacementResetToken,
} from "@/lib/auth-security"
import { ensureAppSchema, getPool } from "@/lib/db"

export function hashAuthToken(token: string) {
  return hashOpaqueToken(token)
}

export async function consumeChallengeByPurposePrefix(
  token: string,
  purposePrefix: string,
): Promise<{ userId: string; purpose: string } | null> {
  await ensureAppSchema()
  return consumeChallengeByPurposePrefixRow(getPool(), hashAuthToken(token), purposePrefix)
}

export async function createRecoveryToken(
  userId: string,
  lifetimeMinutes = 30,
  throttleSeconds = 60,
) {
  await ensureAppSchema()
  const token = createAuthToken()
  const client = await getPool().connect()
  try {
    await client.query("BEGIN")
    const inserted = await insertReplacementResetToken(client, {
      userId,
      tokenHash: hashAuthToken(token),
      lifetimeMinutes,
      throttleSeconds,
    })
    if (!inserted) {
      await client.query("ROLLBACK")
      return null
    }
    await client.query("COMMIT")
    return token
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export function createAuthToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url")
}

export async function rememberChallenge(
  token: string,
  purpose: string,
  userId: string | null,
  lifetimeSeconds = 300,
) {
  await ensureAppSchema()
  await getPool().query("DELETE FROM app_auth_challenges WHERE expires_at <= now()")
  await getPool().query(
    `INSERT INTO app_auth_challenges (token_hash, purpose, user_id, expires_at)
     VALUES ($1, $2, $3, now() + ($4::text || ' seconds')::interval)`,
    [hashAuthToken(token), purpose, userId, lifetimeSeconds],
  )
}

export async function hasChallenge(token: string, purpose: string, userId: string | null) {
  await ensureAppSchema()
  const result = await getPool().query(
    `SELECT 1
       FROM app_auth_challenges
      WHERE token_hash = $1
        AND purpose = $2
        AND user_id IS NOT DISTINCT FROM $3::uuid
        AND expires_at > now()
      LIMIT 1`,
    [hashAuthToken(token), purpose, userId],
  )
  return result.rowCount === 1
}

export async function consumeChallenge(token: string, purpose: string, userId: string | null) {
  await ensureAppSchema()
  return consumeChallengeWithClient(getPool(), token, purpose, userId)
}

export async function consumeChallengeWithClient(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null }> },
  token: string,
  purpose: string,
  userId: string | null,
) {
  return consumeChallengeRow(client, hashAuthToken(token), purpose, userId)
}
