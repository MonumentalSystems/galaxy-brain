import { randomUUID } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"

import { getCurrentUser } from "@/lib/auth"
import { projectHamTaskDetailForBrowser } from "@/lib/ham-task-browser-projection"
import { namespaceHamTaskIdempotencyKey, parseHamTaskExpectedVersion } from "@/lib/ham-task-contract"
import { createHamTaskExternalCompletionPost } from "@/lib/ham-task-external-completion-handler"
import { fetchHamTask, hamTaskMutationsEnabled, HamTaskProxyError } from "@/lib/ham-task-proxy"

function errorResponse(error: unknown) {
  if (error instanceof HamTaskProxyError) {
    return NextResponse.json({ error: error.message }, { status: error.status })
  }
  return NextResponse.json({ error: "Unexpected task reconciliation error" }, { status: 500 })
}

const externalCompletionPost = createHamTaskExternalCompletionPost({
  errorResponse,
  fetchHamTask,
  getCurrentUser: () => getCurrentUser(),
  hamTaskMutationsEnabled,
  json: NextResponse.json,
  namespaceHamTaskIdempotencyKey,
  parseHamTaskExpectedVersion,
  projectHamTaskDetailForBrowser,
  randomUUID,
})

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ taskId: string }> },
) {
  return externalCompletionPost(request, context)
}
