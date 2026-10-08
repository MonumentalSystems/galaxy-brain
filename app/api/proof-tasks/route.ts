import { NextResponse } from "next/server"

import { getCurrentUser } from "@/lib/auth"

export async function POST() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  return NextResponse.json({
    error: "Direct proof-task materialization is retired. Convert the canonical Galaxy DAG to HAM v3 and dispatch the exact compiled directive through Hyades.",
  }, { status: 410 })
}
