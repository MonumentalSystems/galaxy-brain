export const TASK_PLAN_PROPOSAL_TOOL_PATH = "/api/agent-tools/task.plan.propose"
export const MAX_TASK_PLAN_PROPOSAL_REQUEST_BYTES = 65_536
export const MAX_TASK_PLAN_PROPOSAL_RESPONSE_BYTES = 70_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const HAM_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u

export class TaskPlanProposalClientError extends Error {
  constructor(code, message, { status = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "TaskPlanProposalClientError"
    this.code = code
    this.status = status
  }
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value)
  return keys.length === expected.size && keys.every((key) => expected.has(key))
}

function invalidBaseline() {
  throw new TaskPlanProposalClientError(
    "invalid-baseline",
    "Save and reload an exact task-plan revision before producing a proposal.",
  )
}

function proposalInputFromRecord(taskPlan, intent) {
  const source = record(taskPlan)
  const spec = record(source?.current_spec)
  const task = record(spec?.task)
  if (
    !source
    || typeof source.id !== "string" || !UUID.test(source.id)
    || !Number.isSafeInteger(source.current_version) || source.current_version < 1
    || typeof source.current_content_hash !== "string" || !SHA256.test(source.current_content_hash)
    || typeof source.ham_task_id !== "string" || !HAM_TASK_ID.test(source.ham_task_id)
    || task?.kind !== "galaxy.ham.task"
    || task.id !== source.ham_task_id
    || !Number.isSafeInteger(task.version) || task.version < 1
  ) invalidBaseline()

  const requested = record(intent)
  if (!requested) {
    throw new TaskPlanProposalClientError("invalid-intent", "Complete the proposal form before submitting it.")
  }
  return {
    taskPlanId: source.id.toLowerCase(),
    expectedVersion: source.current_version,
    expectedContentHash: source.current_content_hash,
    expectedHamTaskId: source.ham_task_id,
    expectedHamTaskVersion: task.version,
    action: requested.action,
    sourceJobIds: requested.sourceJobIds,
    title: requested.title,
    goal: requested.goal,
    instruction: requested.instruction ?? null,
    inputRefs: requested.inputRefs ?? [],
    branches: requested.branches ?? [],
  }
}

export function createTaskPlanProposalRequest(taskPlan, intent) {
  const call = {
    schemaId: "gb.agent-tool-call.v1",
    tool: "task.plan.propose",
    input: proposalInputFromRecord(taskPlan, intent),
  }
  let body
  try {
    body = JSON.stringify(call)
  } catch (error) {
    throw new TaskPlanProposalClientError(
      "invalid-intent",
      "The proposal form contains invalid data.",
      { cause: error },
    )
  }
  if (new TextEncoder().encode(body).byteLength > MAX_TASK_PLAN_PROPOSAL_REQUEST_BYTES) {
    throw new TaskPlanProposalClientError("request-too-large", "The proposal request exceeds 64 KiB.")
  }
  return Object.freeze({ call: Object.freeze(call), body })
}

async function readBoundedText(response) {
  const declared = response.headers.get("content-length")
  if (declared && /^\d+$/u.test(declared) && Number(declared) > MAX_TASK_PLAN_PROPOSAL_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new TaskPlanProposalClientError("response-too-large", "The proposal response was too large.")
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_TASK_PLAN_PROPOSAL_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new TaskPlanProposalClientError("response-too-large", "The proposal response was too large.")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch (error) {
    throw new TaskPlanProposalClientError(
      "invalid-response",
      "Galaxy Brain returned an invalid proposal response.",
      { cause: error },
    )
  }
}

function normalizedError(value, status) {
  const envelope = record(value)
  const detail = record(envelope?.error)
  const safeCode = envelope?.schemaId === "gb.agent-tool-error.v1"
    && hasExactKeys(envelope, new Set(["schemaId", "error"]))
    && detail
    && hasExactKeys(detail, new Set(["code", "message"]))
    && typeof detail.code === "string"
    && /^[a-z0-9_-]{1,80}$/u.test(detail.code)
      ? detail.code
      : "request-failed"
  const message = status === 401 || status === 403
    ? "You are not authorized to produce this task-plan proposal."
    : status === 404
      ? "The task-plan proposal producer or one of its exact inputs is unavailable."
      : status === 409
        ? "The saved task plan changed. Reload it before producing another proposal."
        : status === 413
          ? "The proposal request or response exceeded its bounded contract."
          : status === 422 || status === 400
            ? "The proposal intent is invalid. Review its jobs and pinned inputs."
            : "The task-plan proposal could not be produced."
  return new TaskPlanProposalClientError(safeCode, message, { status })
}

function proposalFromResult(value) {
  const envelope = record(value)
  if (!envelope || !hasExactKeys(envelope, new Set(["schemaId", "tool", "result"]))
    || envelope.schemaId !== "gb.agent-tool-result.v1" || envelope.tool !== "task.plan.propose") {
    throw new TaskPlanProposalClientError("invalid-response", "Galaxy Brain returned an invalid proposal response.")
  }
  const result = record(envelope.result)
  const proposal = record(result?.proposal)
  const base = record(proposal?.base)
  if (!result || !hasExactKeys(result, new Set(["proposal"])) || !proposal || !base
    || typeof base.hamTaskId !== "string" || !HAM_TASK_ID.test(base.hamTaskId)
    || !Number.isSafeInteger(base.hamTaskVersion) || base.hamTaskVersion < 1) {
    throw new TaskPlanProposalClientError("invalid-response", "Galaxy Brain returned an invalid proposal response.")
  }
  // The Task Constructor independently validates the complete proposal shape,
  // exact base, operation union, and cryptographic proposal hash before showing it.
  return proposal
}

export async function requestTaskPlanProposal(taskPlan, intent, options = {}) {
  const { body } = createTaskPlanProposalRequest(taskPlan, intent)
  const fetcher = options.fetcher ?? fetch
  let response
  try {
    response = await fetcher(TASK_PLAN_PROPOSAL_TOOL_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      cache: "no-store",
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal?.aborted || error?.name === "AbortError") throw error
    throw new TaskPlanProposalClientError(
      "network-error",
      "The task-plan proposal service is unavailable.",
      { cause: error },
    )
  }

  const text = await readBoundedText(response)
  let value
  try {
    value = text ? JSON.parse(text) : null
  } catch (error) {
    if (!response.ok) throw normalizedError(null, response.status)
    throw new TaskPlanProposalClientError(
      "invalid-response",
      "Galaxy Brain returned an invalid proposal response.",
      { cause: error },
    )
  }
  if (!response.ok) throw normalizedError(value, response.status)
  return proposalFromResult(value)
}
