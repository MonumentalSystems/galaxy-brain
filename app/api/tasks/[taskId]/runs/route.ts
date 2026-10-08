import { NextResponse } from "next/server"

import { getCurrentUser } from "@/lib/auth"
import {
  parseTaskPlanRunIdempotencyKey,
  readTaskPlanRunJsonBody,
  TaskPlanRunContractError,
} from "@/lib/task-plan-run-contract.js"
import { dispatchTaskPlanRun, TaskPlanRunProxyError } from "@/lib/task-plan-run-proxy"

type RouteContext = { params: Promise<{ taskId: string }> }

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getCurrentUser()
  if (!user) return response({ error: "Unauthorized" }, 401)
  try {
    const { taskId } = await context.params
    const idempotencyKey = parseTaskPlanRunIdempotencyKey(request.headers.get("Idempotency-Key"))
    const input = await readTaskPlanRunJsonBody(request) as {
      taskPlanId: string
      expectedPlanVersion: number
      expectedContentHash: string
      expectedTaskVersion: number
    }
    return response(await dispatchTaskPlanRun({ request, user, taskId, input, idempotencyKey }))
  } catch (error) {
    if (error instanceof TaskPlanRunProxyError || error instanceof TaskPlanRunContractError) {
      return response({ error: error.message }, error.status)
    }
    return response({ error: "Unexpected task-plan dispatch error" }, 500)
  }
}
