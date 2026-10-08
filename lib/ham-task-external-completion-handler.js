/**
 * Build the external-completion POST handler from explicit server dependencies.
 * Production and tests invoke the same control flow; tests can therefore prove
 * that a mismatched detail response cannot reach the mutation operation.
 */
export function createHamTaskExternalCompletionPost({
  errorResponse,
  fetchHamTask,
  getCurrentUser,
  hamTaskMutationsEnabled,
  json,
  namespaceHamTaskIdempotencyKey,
  parseHamTaskExpectedVersion,
  projectHamTaskDetailForBrowser,
  randomUUID,
}) {
  return async function POST(request, context) {
    const user = await getCurrentUser()
    if (!user) return json({ error: "Unauthorized" }, { status: 401 })
    if (!hamTaskMutationsEnabled()) {
      return json({ error: "HAM task mutations are disabled by Galaxy Brain policy" }, { status: 403 })
    }

    try {
      const { taskId } = await context.params
      const rawInput = await request.json()
      const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
        ? rawInput
        : {}
      let expectedVersion
      try {
        expectedVersion = parseHamTaskExpectedVersion(input.expectedVersion)
      } catch {
        return json(
          { error: "expectedVersion must be a positive safe integer" },
          { status: 400 },
        )
      }
      const summary = typeof input.summary === "string" ? input.summary.trim() : ""
      const performedByRef = typeof input.performedByRef === "string" ? input.performedByRef.trim() : ""
      const references = Array.isArray(input.references)
        ? input.references.map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean)
        : []
      if (!summary || !performedByRef) {
        return json(
          { error: "expectedVersion, summary, and performedByRef are required" },
          { status: 400 },
        )
      }
      if (summary.length > 4_000 || performedByRef.length > 200 || references.length > 50) {
        return json({ error: "External completion input exceeds allowed size" }, { status: 400 })
      }

      const representedRequester = `galaxy-brain:user:${user.id}`
      const task = await fetchHamTask("detail", { user, taskId })
      const projectedTask = projectHamTaskDetailForBrowser(task)
      if (
        !projectedTask ||
        typeof projectedTask.version !== "number" ||
        !Number.isSafeInteger(projectedTask.version) ||
        projectedTask.version < 1
      ) {
        return json(
          { error: "HAM did not provide an authoritative task identifier and version" },
          { status: 409 },
        )
      }
      if (projectedTask.id !== taskId) {
        return json(
          { error: "HAM returned authoritative state for a different task" },
          { status: 409 },
        )
      }
      if (expectedVersion !== projectedTask.version) {
        return json(
          { error: "Task version changed; refresh before recording external completion" },
          { status: 409 },
        )
      }
      if (task.requester_ref !== representedRequester) {
        return json(
          { error: "Only the human who posted this task may reconcile external completion" },
          { status: 403 },
        )
      }

      const clientIdempotencyKey = request.headers.get("Idempotency-Key") || randomUUID()
      const idempotencyKey = namespaceHamTaskIdempotencyKey(user.id, clientIdempotencyKey)
      const body = await fetchHamTask("externalComplete", {
        user,
        taskId,
        idempotencyKey,
        body: {
          action: "record_external_completion",
          expected_version: expectedVersion,
          summary,
          requester_ref: representedRequester,
          performed_by_ref: performedByRef,
          evidence: { references },
          idempotency_key: idempotencyKey,
        },
      })
      const projected = projectHamTaskDetailForBrowser(body)
      if (!projected) {
        return json({ error: "HAM returned a task without a canonical identifier" }, { status: 502 })
      }
      return json(projected)
    } catch (error) {
      return errorResponse(error)
    }
  }
}
