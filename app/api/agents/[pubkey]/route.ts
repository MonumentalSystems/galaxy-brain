import { NextRequest, NextResponse } from "next/server"

import { getCurrentUser } from "@/lib/auth"
import { getAuthOrigin } from "@/lib/auth-config"
import { ensureAppSchema, getPool } from "@/lib/db"

type RouteContext = { params: Promise<{ pubkey: string }> }

export async function DELETE(request: NextRequest, context: RouteContext) {
  await ensureAppSchema()
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (user.role !== "owner" && user.role !== "admin") {
    return NextResponse.json({ error: "Tenant administrator access is required" }, { status: 403 })
  }
  if (user.authMethod !== "nostr" || !user.nostrPubkey) {
    return NextResponse.json({ error: "Sign in with Nostr before managing agent identities" }, { status: 403 })
  }
  const origin = request.headers.get("origin")
  let expectedOrigin = false
  try {
    expectedOrigin = Boolean(origin) && new URL(origin!).origin === new URL(getAuthOrigin()).origin
  } catch {
    expectedOrigin = false
  }
  if (!expectedOrigin) {
    return NextResponse.json({ error: "Agent mutation origin is not allowed" }, { status: 403 })
  }

  const { pubkey } = await context.params
  if (!/^[0-9a-f]{64}$/.test(pubkey)) {
    return NextResponse.json({ error: "Agent Nostr public key is invalid" }, { status: 400 })
  }
  const client = await getPool().connect()
  try {
    await client.query("BEGIN")
    const result = await client.query(
      `UPDATE app_principals p
          SET status = 'disabled', updated_at = now()
         FROM app_agents a
        WHERE a.nostr_pubkey = $1 AND p.id = a.principal_id AND a.tenant_id = $2
        RETURNING p.id`,
      [pubkey, user.tenantId],
    )
    if (!result.rowCount) {
      await client.query("ROLLBACK")
      return NextResponse.json({ error: "Agent not found" }, { status: 404 })
    }
    await client.query("COMMIT")
    return NextResponse.json({ disabled: pubkey })
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    console.error("Agent disable failed", error)
    return NextResponse.json({ error: "Agent disable failed" }, { status: 500 })
  } finally {
    client.release()
  }
}
