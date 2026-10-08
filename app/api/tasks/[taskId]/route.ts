import { NextResponse } from "next/server"

import { getCurrentUser } from "@/lib/auth"
import { projectHamTaskDetailForBrowser } from "@/lib/ham-task-browser-projection"
import { fetchHamTask, HamTaskProxyError } from "@/lib/ham-task-proxy"

type RouteContext = {
  params: Promise<{ taskId: string }>
}
export async function GET(_request: Request, context: RouteContext) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const { taskId } = await context.params
    const body = await fetchHamTask("detail", { user, taskId })
    const projected = projectHamTaskDetailForBrowser(body)
    if (!projected) {
      return NextResponse.json({ error: "HAM returned a task without a canonical identifier" }, { status: 502 })
    }
    return NextResponse.json(projected)
  } catch (error) {
    if (error instanceof HamTaskProxyError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    return NextResponse.json({ error: "Unexpected task proxy error" }, { status: 500 })
  }
}
