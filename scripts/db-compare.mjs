import { createHash } from "node:crypto"
import process from "node:process"

import pg from "pg"

const { Client } = pg
const sourceMode = process.env.MIGRATION_SOURCE_MODE?.trim() || "neon"
if (!new Set(["neon", "fresh-auth"]).has(sourceMode)) {
  throw new Error("MIGRATION_SOURCE_MODE must be neon or fresh-auth")
}
const urls = {
  neon: process.env.NEON_SOURCE_DATABASE_URL?.trim(),
  api: process.env.GALAXY_API_SOURCE_DATABASE_URL?.trim(),
  target: process.env.GALAXY_TARGET_DATABASE_URL?.trim(),
}

const requiredUrls = sourceMode === "neon" ? Object.entries(urls) : Object.entries(urls).filter(([name]) => name !== "neon")
for (const [name, value] of requiredUrls) {
  if (!value) throw new Error(`${name} database URL is required`)
}

async function snapshot(connectionString, prefix) {
  const client = new Client({ connectionString })
  try {
    await client.connect()
    const tables = await client.query(
      `SELECT tablename
         FROM pg_tables
        WHERE schemaname = 'public' AND tablename LIKE $1 ESCAPE '\\'
        ORDER BY tablename`,
      [`${prefix.replace("_", "\\_")}%`],
    )
    const counts = {}
    for (const { tablename } of tables.rows) {
      if (!new RegExp(`^${prefix}[a-z0-9_]+$`).test(tablename)) {
        throw new Error(`unsafe table name returned by catalog: ${tablename}`)
      }
      const result = await client.query(`SELECT count(*)::bigint AS count FROM public.${tablename}`)
      counts[tablename] = result.rows[0].count
    }

    let identityFingerprint = null
    if (prefix === "app_") {
      const identities = await client.query(`
        SELECT kind, value FROM (
          SELECT 'user' AS kind, id::text AS value FROM app_users
          UNION ALL SELECT 'passkey', id::text FROM app_passkeys
          UNION ALL SELECT 'nostr', id::text FROM app_nostr_keys
        ) identities ORDER BY kind, value
      `)
      identityFingerprint = createHash("sha256")
        .update(JSON.stringify(identities.rows))
        .digest("hex")
    }
    return { counts, identityFingerprint }
  } finally {
    await client.end()
  }
}

const [neon, api, targetApp, targetApi] = await Promise.all([
  sourceMode === "neon" ? snapshot(urls.neon, "app_") : null,
  snapshot(urls.api, "gb_"),
  snapshot(urls.target, "app_"),
  snapshot(urls.target, "gb_"),
])

const mismatches = []
const comparisons = [["Galaxy API", api, targetApi]]
if (sourceMode === "neon") comparisons.unshift(["Neon app", neon, targetApp])
for (const [sourceName, source, target] of comparisons) {
  for (const [table, count] of Object.entries(source.counts)) {
    if (target.counts[table] !== count) {
      mismatches.push(`${sourceName} ${table}: source=${count} target=${target.counts[table] ?? "missing"}`)
    }
  }
}
if (sourceMode === "neon" && neon.identityFingerprint !== targetApp.identityFingerprint) {
  mismatches.push("auth identity fingerprint differs")
}
if (sourceMode === "fresh-auth") {
  const expectedFreshAuthCounts = {
    app_agents: "0",
    app_api_tokens: "0",
    app_auth_challenges: "0",
    app_auth_rate_limits: "0",
    app_nostr_keys: "0",
    app_passkeys: "0",
    app_password_reset_tokens: "0",
    app_principals: "0",
    app_registration_invitations: "0",
    app_sessions: "0",
    app_tenant_memberships: "0",
    app_tenants: "1",
    app_users: "0",
  }
  for (const table of Object.keys(expectedFreshAuthCounts)) {
    if (!(table in targetApp.counts)) mismatches.push(`fresh auth table missing: ${table}`)
  }
  for (const [table, count] of Object.entries(targetApp.counts)) {
    const expected = expectedFreshAuthCounts[table]
    if (expected === undefined) mismatches.push(`unexpected fresh auth table: ${table}`)
    else if (count !== expected) mismatches.push(`fresh auth ${table}: expected=${expected} target=${count}`)
  }
}

console.log(JSON.stringify({
  ok: mismatches.length === 0,
  sourceMode,
  source: { neon, api },
  target: { app: targetApp, api: targetApi },
  mismatches,
}, null, 2))
if (mismatches.length) process.exitCode = 1
