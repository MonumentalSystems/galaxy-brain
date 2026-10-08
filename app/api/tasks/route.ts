import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "node:crypto"

import { getCurrentUser } from "@/lib/auth"
import { projectHamTaskDetailForBrowser, projectHamTaskPageForBrowser } from "@/lib/ham-task-browser-projection"
import { buildHamTaskPageBody } from "@/lib/ham-task-contract"
import { namespaceHamTaskIdempotencyKey } from "@/lib/ham-task-contract"
import {
  createHumanTaskPayload,
  fetchHamTask,
  getHamTaskProjectRef,
  hamTaskMutationsEnabled,
  HamTaskProxyError,
} from "@/lib/ham-task-proxy"

function errorResponse(error: unknown) {
  if (error instanceof HamTaskProxyError) {
    return NextResponse.json({ error: error.message }, { status: error.status })
  }
  return NextResponse.json({ error: "Unexpected task proxy error" }, { status: 500 })
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const cursor = request.nextUrl.searchParams.get("cursor") || undefined
  const requestedLimit = Number(request.nextUrl.searchParams.get("limit") || 100)
  const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 100, 200))

  try {
    const body = await fetchHamTask("page", {
      user,
      body: buildHamTaskPageBody(getHamTaskProjectRef(), cursor, limit),
    })
    return NextResponse.json(projectHamTaskPageForBrowser(body))
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!hamTaskMutationsEnabled()) {
    return NextResponse.json({ error: "HAM task mutations are disabled by Galaxy Brain policy" }, { status: 403 })
  }

  try {
    const input = await request.json()
    const clientIdempotencyKey = request.headers.get("Idempotency-Key") || randomUUID()
    const idempotencyKey = namespaceHamTaskIdempotencyKey(user.id, clientIdempotencyKey)
    const body = await fetchHamTask("create", {
      user,
      projectRef: getHamTaskProjectRef(),
      body: createHumanTaskPayload(input, user, idempotencyKey),
      idempotencyKey,
    })
    const projected = projectHamTaskDetailForBrowser(body)
    if (!projected) {
      return NextResponse.json({ error: "HAM returned a task without a canonical identifier" }, { status: 502 })
    }
    return NextResponse.json(projected, { status: 201 })
  } catch (error) {
    return errorResponse(error)
  }
}
