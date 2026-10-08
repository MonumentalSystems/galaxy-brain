import { NextRequest, NextResponse } from "next/server"

import { getCurrentUser } from "@/lib/auth"
import { projectHamTaskEventPageForBrowser } from "@/lib/ham-task-browser-projection"
import { buildHamTaskEventsBody } from "@/lib/ham-task-contract"
import { fetchHamTask, getHamTaskProjectRef, HamTaskProxyError } from "@/lib/ham-task-proxy"

type RouteContext = {
  params: Promise<{ taskId: string }>
}

export async function GET(request: NextRequest, context: RouteContext) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { taskId } = await context.params
  const cursorValue = request.nextUrl.searchParams.get("cursor")
  const cursor = cursorValue === null ? 0 : Number(cursorValue)
  const requestedLimit = Number(request.nextUrl.searchParams.get("limit") || 100)
  const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 100, 200))
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    return NextResponse.json({ error: "Event cursor must be a non-negative integer" }, { status: 400 })
  }

  try {
    const body = await fetchHamTask("events", {
      user,
      body: buildHamTaskEventsBody(getHamTaskProjectRef(), taskId, cursor, limit),
    })
    return NextResponse.json(projectHamTaskEventPageForBrowser(body))
  } catch (error) {
    if (error instanceof HamTaskProxyError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    return NextResponse.json({ error: "Unexpected task proxy error" }, { status: 500 })
  }
}
