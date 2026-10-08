import { NextRequest, NextResponse } from "next/server"

import { getCurrentUser } from "@/lib/auth"
import { getAuthOrigin } from "@/lib/auth-config"
import { ensureAppSchema, getPool } from "@/lib/db"

async function requireTenantManager() {
  const user = await getCurrentUser()
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  if (user.role !== "owner" && user.role !== "admin") {
    return { error: NextResponse.json({ error: "Tenant administrator access is required" }, { status: 403 }) }
  }
  if (user.authMethod !== "nostr" || !user.nostrPubkey) {
    return { error: NextResponse.json({ error: "Sign in with Nostr before managing agent identities" }, { status: 403 }) }
  }
  return { user }
}

function hasExpectedOrigin(request: Request) {
  const origin = request.headers.get("origin")
  if (!origin) return false
  try {
    return new URL(origin).origin === new URL(getAuthOrigin()).origin
  } catch {
    return false
  }
}

export async function GET() {
  await ensureAppSchema()
  const auth = await requireTenantManager()
  if (auth.error) return auth.error
  const result = await getPool().query(
    `SELECT a.nostr_pubkey AS pubkey, a.handle, p.display_name AS "displayName",
            p.status, a.description, a.scopes, a.config,
            a.created_at AS "createdAt", a.last_used_at AS "lastUsedAt"
       FROM app_agents a
       JOIN app_principals p ON p.id = a.principal_id
      WHERE a.tenant_id = $1 AND a.nostr_pubkey IS NOT NULL
      ORDER BY a.created_at`,
    [auth.user.tenantId],
  )
  return NextResponse.json({ agents: result.rows })
}

export async function POST(request: NextRequest) {
  await ensureAppSchema()
  const auth = await requireTenantManager()
  if (auth.error) return auth.error
  if (!hasExpectedOrigin(request)) {
    return NextResponse.json({ error: "Agent mutation origin is not allowed" }, { status: 403 })
  }

  const body = await request.json().catch(() => null)
  const pubkey = typeof body?.pubkey === "string" ? body.pubkey.trim().toLowerCase() : ""
  const handle = typeof body?.handle === "string" ? body.handle.trim().toLowerCase() : ""
  const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : ""
  const description = typeof body?.description === "string" ? body.description.trim() : null
  if (!/^[0-9a-f]{64}$/.test(pubkey)) {
    return NextResponse.json({ error: "Agent Nostr public key must be 64 lowercase hexadecimal characters" }, { status: 400 })
  }
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(handle)) {
    return NextResponse.json({ error: "Agent handle must be 2-63 lowercase letters, digits, _ or -" }, { status: 400 })
  }
  if (!displayName) {
    return NextResponse.json({ error: "Display name is required" }, { status: 400 })
  }

  const client = await getPool().connect()
  try {
    await client.query("BEGIN")
    const principal = await client.query(
      `INSERT INTO app_principals (kind, display_name)
       VALUES ('agent', $1) RETURNING id`,
      [displayName],
    )
    const principalId = principal.rows[0].id
    await client.query(
      `INSERT INTO app_tenant_memberships (tenant_id, principal_id, role)
       VALUES ($1, $2, 'agent')`,
      [auth.user.tenantId, principalId],
    )
    await client.query(
      `INSERT INTO app_agents
         (principal_id, tenant_id, handle, nostr_pubkey, scopes, description, created_by_principal_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [principalId, auth.user.tenantId, handle, pubkey, ["*"], description, auth.user.principalId],
    )
    await client.query("COMMIT")
    return NextResponse.json({
      agent: { pubkey, handle, displayName, description },
      warning: "Only the public key was registered. Keep the nsec on the agent machine.",
    }, { status: 201 })
  } catch (error: any) {
    await client.query("ROLLBACK").catch(() => undefined)
    if (error?.code === "23505") {
      return NextResponse.json({ error: "That agent handle or Nostr public key is already registered" }, { status: 409 })
    }
    if (error?.code === "23514") {
      return NextResponse.json({ error: "A human Nostr key cannot be reused as an agent key" }, { status: 409 })
    }
    console.error("Agent creation failed", error)
    return NextResponse.json({ error: "Agent creation failed" }, { status: 500 })
  } finally {
    client.release()
  }
}
