import { createHash } from "node:crypto"

import { readBoundedRequestBody, RequestBodyTooLargeError } from "./bounded-multipart.js"
import { readBoundedResponseText, ResponseBodyTooLargeError } from "./bounded-response.js"

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const SHA_PATTERN = /^[0-9a-f]{64}$/
const RUN_PHASES = new Set([
  "wake-requested", "accepted", "started", "blocked", "completed", "failed", "cancelled", "rejected", "declined",
])
const RUN_BLOCK_REASONS = new Set([
  "missing_authority", "provider_failure", "waiting_capacity", "invalid_contract", "verification_required",
])

export const TASK_PLAN_RUN_REQUEST_MAX_BYTES = 4_096
export const TASK_PLAN_STORE_RESPONSE_MAX_BYTES = 600_000
export const TASK_PLAN_RUN_RECEIPT_MAX_BYTES = 16_384
export const TASK_PLAN_RUN_SNAPSHOT_MAX_BYTES = 1_100_000

export class TaskPlanRunContractError extends Error {
  constructor(message, status = 422) {
    super(message)
    this.name = "TaskPlanRunContractError"
    this.status = status
  }
}

function invalid(message, status = 422) {
  throw new TaskPlanRunContractError(message, status)
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`)
  return value
}

export function stableId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) invalid(`${label} is invalid`)
  return value
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) invalid(`${label} must be a positive integer`)
  return value
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) invalid(`${label} must be lowercase SHA-256 hex`)
  return value
}

function optionalTimestamp(value, label) {
  if (value === null || value === undefined) return null
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    invalid(`${label} is invalid`)
  }
  return value
}

export function parseTaskPlanRunIdempotencyKey(value) {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    invalid("A stable Idempotency-Key of at most 200 characters is required", 400)
  }
  return value
}

export function namespaceTaskPlanRunIdempotencyKey(userId, clientKey) {
  if (typeof userId !== "string" || !userId || userId.length > 200) invalid("Authenticated user identifier is invalid")
  return createHash("sha256").update(`gb-task-plan-run-v1\0${userId}\0${clientKey}`).digest("hex")
}

export function parseTaskPlanRunInput(value) {
  const source = object(value, "Task-plan dispatch body")
  const allowed = new Set(["taskPlanId", "expectedPlanVersion", "expectedContentHash", "expectedTaskVersion"])
  if (Object.keys(source).some((key) => !allowed.has(key))) {
    invalid("Task-plan dispatch body contains unsupported fields", 400)
  }
  return {
    taskPlanId: stableId(source.taskPlanId, "taskPlanId"),
    expectedPlanVersion: positiveInteger(source.expectedPlanVersion, "expectedPlanVersion"),
    expectedContentHash: sha256(source.expectedContentHash, "expectedContentHash"),
    expectedTaskVersion: positiveInteger(source.expectedTaskVersion, "expectedTaskVersion"),
  }
}

export async function readTaskPlanRunJsonBody(request) {
  const declared = request.headers.get("content-length")
  if (declared && /^\d+$/u.test(declared) && Number(declared) > TASK_PLAN_RUN_REQUEST_MAX_BYTES) {
    await request.body?.cancel().catch(() => undefined)
    invalid("Task-plan dispatch body is too large", 413)
  }
  if (!request.body) invalid("Task-plan dispatch body must contain JSON", 400)
  let bytes
  try {
    bytes = await readBoundedRequestBody(request.body, TASK_PLAN_RUN_REQUEST_MAX_BYTES)
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) invalid("Task-plan dispatch body is too large", 413)
    invalid("Task-plan dispatch body could not be read", 400)
  }
  try {
    return parseTaskPlanRunInput(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
  } catch (error) {
    if (error instanceof TaskPlanRunContractError) throw error
    invalid("Task-plan dispatch body must contain valid UTF-8 JSON", 400)
  }
}

export async function assertEmptyTaskPlanRunBody(request) {
  const declared = request.headers.get("content-length")
  if (declared && /^\d+$/u.test(declared) && Number(declared) > 0) {
    await request.body?.cancel().catch(() => undefined)
    invalid("Task-plan run cancellation accepts no request body", 400)
  }
  if (!request.body) return
  let bytes
  try { bytes = await readBoundedRequestBody(request.body, 1) }
  catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      invalid("Task-plan run cancellation accepts no request body", 400)
    }
    invalid("Task-plan run cancellation body could not be read", 400)
  }
  if (bytes.byteLength > 0) invalid("Task-plan run cancellation accepts no request body", 400)
}

export async function readTaskPlanRunResponseJson(response, maximumBytes, label) {
  let text
  try {
    text = await readBoundedResponseText(response, maximumBytes)
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) invalid(`${label} response is too large`, 502)
    invalid(`${label} response could not be read`, 502)
  }
  try { return text ? JSON.parse(text) : null } catch { invalid(`${label} response is not valid JSON`, 502) }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) invalid("Task plan contains non-JSON data")
  return encoded
}

export function taskPlanSpecSha256(spec) {
  return createHash("sha256").update(canonicalJson(spec)).digest("hex")
}

export function parseTaskPlanRecord(value) {
  const source = object(value, "Galaxy task plan")
  const spec = object(source.current_spec, "Galaxy task plan spec")
  return {
    id: stableId(source.id, "task plan id"),
    tenantId: typeof source.tenant_id === "string" ? source.tenant_id : invalid("task plan tenant is invalid"),
    hamTaskId: stableId(source.ham_task_id, "task plan HAM task"),
    createdByPrincipalId: typeof source.created_by_principal_id === "string"
      ? source.created_by_principal_id : invalid("task plan author is invalid"),
    currentVersion: positiveInteger(source.current_version, "task plan version"),
    currentContentHash: sha256(source.current_content_hash, "task plan content hash"),
    spec,
  }
}

export function parseTaskPlanRevisionRecord(value) {
  const source = object(value, "Galaxy task plan revision")
  return {
    taskPlanId: stableId(source.task_plan_id, "task plan revision parent"),
    tenantId: typeof source.tenant_id === "string"
      ? source.tenant_id : invalid("task plan revision tenant is invalid"),
    version: positiveInteger(source.version, "task plan revision version"),
    contentHash: sha256(source.content_hash, "task plan revision content hash"),
    spec: object(source.spec, "task plan revision spec"),
  }
}

export function parseTaskPlanDispatchIntent(value) {
  const source = object(value, "Galaxy task plan dispatch intent")
  return {
    taskPlanId: stableId(source.task_plan_id, "dispatch intent task plan"),
    tenantId: typeof source.tenant_id === "string"
      ? source.tenant_id : invalid("dispatch intent tenant is invalid"),
    taskPlanVersion: positiveInteger(source.task_plan_version, "dispatch intent plan version"),
    taskPlanContentHash: sha256(source.task_plan_content_hash, "dispatch intent plan content hash"),
    taskId: stableId(source.ham_task_id, "dispatch intent HAM task"),
    expectedTaskVersion: positiveInteger(source.expected_task_version, "dispatch intent task version"),
    replayed: source.replayed === true,
  }
}

export function validateTaskPlanSpecBinding(spec, expected) {
  const source = object(spec, "Task plan spec")
  const task = object(source.task, "Task plan task binding")
  if (source.schema !== "gb.task-plan.v1"
    || task.kind !== "galaxy.ham.task"
    || task.id !== expected.taskId
    || task.version !== expected.taskVersion) {
    invalid("Saved plan references a different HAM task version", 409)
  }
  return taskPlanSpecSha256(source)
}

export function projectTaskPlanRunReceipt(value) {
  const root = object(value, "Hyades dispatch envelope")
  const receipt = object(root.receipt, "Hyades dispatch receipt")
  const state = receipt.state
  if (typeof state !== "string" || !RUN_PHASES.has(state)) invalid("Hyades dispatch receipt state is invalid", 502)
  return {
    taskId: stableId(receipt.taskId, "receipt taskId"),
    runId: stableId(receipt.runId, "receipt runId"),
    taskPlanId: stableId(receipt.taskPlanId, "receipt taskPlanId"),
    taskPlanVersion: positiveInteger(receipt.taskPlanVersion, "receipt taskPlanVersion"),
    taskPlanSpecSha256: sha256(receipt.taskPlanSpecSha256, "receipt taskPlanSpecSha256"),
    state,
    replayed: receipt.replayed === true,
  }
}

export function parseTaskPlanRunSnapshot(value, expected = {}) {
  const root = object(value, "Hyades run snapshot")
  const wake = object(root.wake, "Hyades run wake")
  const runId = stableId(root.runId, "runId")
  const taskId = stableId(wake.hamTaskId, "wake.hamTaskId")
  const taskPlanId = stableId(wake.taskPlanId, "wake.taskPlanId")
  const taskPlanVersion = positiveInteger(wake.taskPlanVersion, "wake.taskPlanVersion")
  const taskPlanContentSha256 = sha256(wake.taskPlanContentSha256, "wake.taskPlanContentSha256")
  const taskPlanSpecSha256Value = sha256(wake.taskPlanSpecSha256, "wake.taskPlanSpecSha256")
  const expectedTaskVersion = positiveInteger(wake.taskPlanExpectedTaskVersion, "wake.taskPlanExpectedTaskVersion")
  const phase = root.phase
  if (typeof phase !== "string" || !RUN_PHASES.has(phase)) invalid("Hyades run phase is invalid", 502)
  if (wake.triggerKind !== "galaxy-task-plan") invalid("Hyades run is not a Galaxy task-plan run", 409)
  if (typeof wake.tenant !== "string" || typeof wake.project !== "string") {
    invalid("Hyades run scope is invalid", 502)
  }
  if (expected.runId && runId !== expected.runId) invalid("Hyades returned a different run", 409)
  if (expected.taskId && taskId !== expected.taskId) invalid("Hyades run is bound to a different HAM task", 409)
  if (expected.hyadesTenant && wake.tenant !== expected.hyadesTenant) invalid("Hyades run is bound to a different tenant", 409)
  if (expected.hamProject && wake.project !== expected.hamProject) invalid("Hyades run is bound to a different project", 409)
  if (typeof wake.taskPlanSpecJson !== "string"
    || Buffer.byteLength(wake.taskPlanSpecJson, "utf8") > 512_000) {
    invalid("Hyades run task-plan snapshot is invalid", 502)
  }
  let spec
  try { spec = JSON.parse(wake.taskPlanSpecJson) } catch { invalid("Hyades run task-plan snapshot is invalid", 502) }
  const computedSpecSha256 = validateTaskPlanSpecBinding(spec, { taskId, taskVersion: expectedTaskVersion })
  if (computedSpecSha256 !== taskPlanSpecSha256Value) invalid("Hyades run task-plan hash is invalid", 502)
  const blockReason = root.blockReason == null ? null : root.blockReason
  if (blockReason !== null && (typeof blockReason !== "string" || !RUN_BLOCK_REASONS.has(blockReason))) {
    invalid("Hyades run block reason is invalid", 502)
  }
  if (phase === "blocked" && blockReason === null) invalid("Hyades blocked run has no bounded reason", 502)
  return {
    runId,
    taskId,
    taskPlanId,
    taskPlanVersion,
    taskPlanContentSha256,
    taskPlanSpecSha256: taskPlanSpecSha256Value,
    expectedTaskVersion,
    phase,
    blockReason,
    blockedSince: optionalTimestamp(root.blockedSince, "run blockedSince"),
    lastHeartbeatAt: optionalTimestamp(root.lastHeartbeatAt, "run lastHeartbeatAt"),
    createdAt: optionalTimestamp(root.createdAt, "run createdAt"),
    completedAt: optionalTimestamp(root.completedAt, "run completedAt"),
    spec,
  }
}

export function projectTaskPlanRunStatus(snapshot) {
  return {
    runId: snapshot.runId,
    taskId: snapshot.taskId,
    taskPlanId: snapshot.taskPlanId,
    taskPlanVersion: snapshot.taskPlanVersion,
    taskPlanContentSha256: snapshot.taskPlanContentSha256,
    taskPlanSpecSha256: snapshot.taskPlanSpecSha256,
    expectedTaskVersion: snapshot.expectedTaskVersion,
    phase: snapshot.phase,
    blockReason: snapshot.blockReason,
    blockedSince: snapshot.blockedSince,
    lastHeartbeatAt: snapshot.lastHeartbeatAt,
    createdAt: snapshot.createdAt,
    completedAt: snapshot.completedAt,
  }
}
