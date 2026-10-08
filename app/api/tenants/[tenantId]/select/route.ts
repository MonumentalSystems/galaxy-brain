import { NextRequest, NextResponse } from "next/server"

import { switchCurrentTenant } from "@/lib/auth"

type RouteContext = { params: Promise<{ tenantId: string }> }

export async function POST(request: NextRequest, context: RouteContext) {
  const expectedOrigin = process.env.AUTH_ORIGIN ? new URL(process.env.AUTH_ORIGIN).origin : ""
  if (!expectedOrigin || request.headers.get("Origin") !== expectedOrigin) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 })
  }
  const { tenantId } = await context.params
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) {
    return NextResponse.json({ error: "Invalid tenant identifier" }, { status: 400 })
  }
  if (!(await switchCurrentTenant(tenantId))) {
    return NextResponse.json({ error: "Active tenant membership not found" }, { status: 404 })
  }
  return NextResponse.json({ tenantId })
}
