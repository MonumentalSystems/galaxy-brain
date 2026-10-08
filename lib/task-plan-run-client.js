export const TASK_PLAN_RUN_RESPONSE_MAX_BYTES = 32_768

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const RUN_PHASES = new Set([
  "wake-requested", "accepted", "started", "blocked", "completed", "failed", "cancelled", "rejected", "declined",
])
const TERMINAL_RUN_PHASES = new Set(["completed", "failed", "cancelled", "rejected", "declined"])

export class TaskPlanRunClientError extends Error {
  constructor(code, message, { status = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "TaskPlanRunClientError"
    this.code = code
    this.status = status
  }
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null
}

function exactKeys(value, keys) {
  const actual = Object.keys(value)
  return actual.length === keys.size && actual.every((key) => keys.has(key))
}

function stableId(value) {
  return typeof value === "string" && ID_PATTERN.test(value)
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function sha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value)
}

function nullableTimestamp(value) {
  return value === null || (
    typeof value === "string"
    && value.length <= 64
    && Number.isFinite(Date.parse(value))
  )
}

function invalidBaseline() {
  throw new TaskPlanRunClientError(
    "invalid-baseline",
    "Save and reload an exact task-plan revision for this HAM task before starting a run.",
  )
}

function taskPlanRunInput(task, taskPlan) {
  const taskSource = record(task)
  const plan = record(taskPlan)
  const spec = record(plan?.current_spec)
  const binding = record(spec?.task)
  if (
    !taskSource
    || !stableId(taskSource.id)
    || !positiveInteger(taskSource.version)
    || taskSource.state !== "pending"
    || taskSource.activeRun != null
    || !plan
    || !stableId(plan.id)
    || plan.ham_task_id !== taskSource.id
    || !positiveInteger(plan.current_version)
    || !sha256(plan.current_content_hash)
    || spec?.schema !== "gb.task-plan.v1"
    || binding?.kind !== "galaxy.ham.task"
    || binding.id !== taskSource.id
    || binding.version !== taskSource.version
  ) invalidBaseline()
  return Object.freeze({
    taskPlanId: plan.id,
    expectedPlanVersion: plan.current_version,
    expectedContentHash: plan.current_content_hash,
    expectedTaskVersion: taskSource.version,
  })
}

export function taskPlanRunStartBlocker({
  task,
  taskPlan,
  mode = "live",
  loading = false,
  saving = false,
  dirty = false,
  candidatePending = false,
  writeBlocked = false,
  runPresent = false,
}) {
  if (mode !== "live") return "Detached previews cannot start runs."
  if (loading) return "Wait for the exact saved task plan to load."
  if (saving) return "Wait for the current plan save to finish."
  if (writeBlocked) return "Resolve the authoritative plan revision before starting a run."
  if (dirty) return "Save or discard every browser edit before starting the exact saved revision."
  if (candidatePending) return "Review or dismiss the pending task-plan candidate before starting a run."
  if (runPresent) return "This constructor already has a run to review."
  if (task?.state !== "pending") return "Only a pending HAM task can start a run."
  if (task?.activeRun) return "HAM already reports an active run for this task."
  try {
    taskPlanRunInput(task, taskPlan)
    return ""
  } catch {
    return "Save and reload a revision bound to this exact HAM task version before starting a run."
  }
}

function runPath(taskId, runId = "") {
  if (!stableId(taskId) || (runId && !stableId(runId))) {
    throw new TaskPlanRunClientError("invalid-identity", "Choose a valid saved task and run.")
  }
  const base = `/api/tasks/${encodeURIComponent(taskId)}/runs`
  return runId ? `${base}/${encodeURIComponent(runId)}` : base
}

export function createTaskPlanRunRequest(task, taskPlan, idempotencyKey) {
  if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new TaskPlanRunClientError("invalid-idempotency-key", "A stable run request identity is required.")
  }
  const input = taskPlanRunInput(task, taskPlan)
  return Object.freeze({
    path: runPath(task.id),
    body: JSON.stringify(input),
    input,
    idempotencyKey,
  })
}

async function readBoundedText(response) {
  const declared = response.headers.get("content-length")
  if (declared && /^\d+$/u.test(declared) && Number(declared) > TASK_PLAN_RUN_RESPONSE_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new TaskPlanRunClientError("response-too-large", "The run response exceeded its bounded contract.")
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
      if (total > TASK_PLAN_RUN_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new TaskPlanRunClientError("response-too-large", "The run response exceeded its bounded contract.")
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
    throw new TaskPlanRunClientError("invalid-response", "Galaxy Brain returned an invalid run response.", { cause: error })
  }
}

function safeRequestError(status, action) {
  const operation = action === "start" ? "start the run" : action === "cancel" ? "cancel the run" : "refresh the run"
  const message = status === 401 || status === 403
    ? `You are not authorized to ${operation}.`
    : status === 404
      ? "The exact task, saved plan, or run is no longer available."
      : status === 409
        ? "The task, saved plan, or run changed. Refresh the authoritative state before retrying."
        : status === 413
          ? "The run request or response exceeded its bounded contract."
          : status === 422 || status === 400
            ? "The exact saved task-plan request is invalid. Reload the task constructor before retrying."
            : status === 429
              ? "The run service is busy. Retry this same request later."
              : status === 503
                ? "Task-plan execution is not configured or is temporarily unavailable."
                : `Galaxy Brain could not ${operation}.`
  return new TaskPlanRunClientError("request-failed", message, { status })
}

async function request(path, init, action, options) {
  const fetcher = options.fetcher ?? fetch
  let response
  try {
    response = await fetcher(path, { ...init, cache: "no-store", signal: options.signal })
  } catch (error) {
    if (options.signal?.aborted || error?.name === "AbortError") throw error
    throw new TaskPlanRunClientError("network-error", "The task-plan run service is unavailable.", { cause: error })
  }
  const text = await readBoundedText(response)
  let value
  try {
    value = text ? JSON.parse(text) : null
  } catch (error) {
    if (!response.ok) throw safeRequestError(response.status, action)
    throw new TaskPlanRunClientError("invalid-response", "Galaxy Brain returned an invalid run response.", { cause: error })
  }
  if (!response.ok) throw safeRequestError(response.status, action)
  return value
}

function runReceipt(value) {
  const source = record(value)
  const expected = new Set([
    "taskId", "runId", "taskPlanId", "taskPlanVersion", "taskPlanSpecSha256", "state", "replayed",
    "taskPlanContentSha256", "expectedTaskVersion",
  ])
  if (!source || !exactKeys(source, expected)
    || !stableId(source.taskId) || !stableId(source.runId) || !stableId(source.taskPlanId)
    || !positiveInteger(source.taskPlanVersion) || !positiveInteger(source.expectedTaskVersion)
    || !sha256(source.taskPlanSpecSha256) || !sha256(source.taskPlanContentSha256)
    || !RUN_PHASES.has(source.state) || typeof source.replayed !== "boolean") {
    throw new TaskPlanRunClientError("invalid-response", "Galaxy Brain returned an invalid run receipt.")
  }
  return Object.freeze({ ...source })
}

function runStatus(value) {
  const source = record(value)
  const expected = new Set([
    "runId", "taskId", "taskPlanId", "taskPlanVersion", "taskPlanContentSha256", "taskPlanSpecSha256",
    "expectedTaskVersion", "phase", "blockReason", "blockedSince", "lastHeartbeatAt", "createdAt", "completedAt",
  ])
  if (!source || !exactKeys(source, expected)
    || !stableId(source.runId) || !stableId(source.taskId) || !stableId(source.taskPlanId)
    || !positiveInteger(source.taskPlanVersion) || !positiveInteger(source.expectedTaskVersion)
    || !sha256(source.taskPlanContentSha256) || !sha256(source.taskPlanSpecSha256)
    || !RUN_PHASES.has(source.phase)
    || !(source.blockReason === null || (typeof source.blockReason === "string" && source.blockReason.length <= 80))
    || !nullableTimestamp(source.blockedSince) || !nullableTimestamp(source.lastHeartbeatAt)
    || !nullableTimestamp(source.createdAt) || !nullableTimestamp(source.completedAt)) {
    throw new TaskPlanRunClientError("invalid-response", "Galaxy Brain returned an invalid run snapshot.")
  }
  return Object.freeze({ ...source })
}

export function isTaskPlanRunTerminal(phase) {
  return TERMINAL_RUN_PHASES.has(phase)
}

export async function startTaskPlanRun(task, taskPlan, options) {
  const prepared = createTaskPlanRunRequest(task, taskPlan, options.idempotencyKey)
  const receipt = runReceipt(await request(prepared.path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": prepared.idempotencyKey,
    },
    body: prepared.body,
  }, "start", options))
  if (receipt.taskId !== task.id
    || receipt.taskPlanId !== prepared.input.taskPlanId
    || receipt.taskPlanVersion !== prepared.input.expectedPlanVersion
    || receipt.taskPlanContentSha256 !== prepared.input.expectedContentHash
    || receipt.expectedTaskVersion !== prepared.input.expectedTaskVersion) {
    throw new TaskPlanRunClientError("invalid-response", "Galaxy Brain returned a run receipt for a different saved plan.")
  }
  return receipt
}

export async function refreshTaskPlanRun(taskId, runId, options = {}) {
  const status = runStatus(await request(runPath(taskId, runId), { method: "GET" }, "refresh", options))
  if (status.taskId !== taskId || status.runId !== runId) {
    throw new TaskPlanRunClientError("invalid-response", "Galaxy Brain returned a different run snapshot.")
  }
  return status
}

export async function cancelTaskPlanRun(taskId, runId, options = {}) {
  const status = runStatus(await request(`${runPath(taskId, runId)}/cancel`, { method: "POST" }, "cancel", options))
  if (status.taskId !== taskId || status.runId !== runId) {
    throw new TaskPlanRunClientError("invalid-response", "Galaxy Brain returned a different run snapshot.")
  }
  return status
}
