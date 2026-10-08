import { NextResponse } from "next/server"

import { getCurrentUser } from "@/lib/auth"
import { assertEmptyTaskPlanRunBody, TaskPlanRunContractError } from "@/lib/task-plan-run-contract.js"
import { cancelTaskPlanRun, TaskPlanRunProxyError } from "@/lib/task-plan-run-proxy"

type RouteContext = { params: Promise<{ taskId: string; runId: string }> }

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getCurrentUser()
  if (!user) return response({ error: "Unauthorized" }, 401)
  try {
    await assertEmptyTaskPlanRunBody(request)
    const { taskId, runId } = await context.params
    return response(await cancelTaskPlanRun({ request, user, taskId, runId }))
  } catch (error) {
    if (error instanceof TaskPlanRunProxyError || error instanceof TaskPlanRunContractError) {
      return response({ error: error.message }, error.status)
    }
    return response({ error: "Unexpected task-plan run cancellation error" }, 500)
  }
}
