import { NextResponse } from "next/server"

import { getCurrentUser } from "@/lib/auth"
import { ensureAppSchema, getPool } from "@/lib/db"

export async function GET() {
  await ensureAppSchema()
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const result = await getPool().query(
    `SELECT t.id, t.slug, t.name, m.role, t.id = $2::uuid AS current
       FROM app_users u
       JOIN app_tenant_memberships m ON m.principal_id = u.principal_id
       JOIN app_tenants t ON t.id = m.tenant_id AND t.status = 'active'
      WHERE u.id = $1
      ORDER BY current DESC, t.name, t.id`,
    [user.id, user.tenantId],
  )
  return NextResponse.json({ tenants: result.rows })
}
