import { NextResponse } from "next/server"

import { ensureAppSchema, getPool } from "@/lib/db"

export async function GET() {
  try {
    await ensureAppSchema()
    await getPool().query("SELECT 1")
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("Health check failed", error)
    return NextResponse.json({ ok: false }, { status: 503 })
  }
}
