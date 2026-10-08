import "server-only"

import type { CurrentUser } from "@/lib/auth"
import { normalizeTaskDetail } from "@/lib/ham-task-adapter.js"
import { fetchHamTask, HamTaskProxyError } from "@/lib/ham-task-proxy"
import {
  canonicalJson,
  namespaceTaskPlanRunIdempotencyKey,
  parseTaskPlanDispatchIntent,
  parseTaskPlanRecord,
  parseTaskPlanRevisionRecord,
  parseTaskPlanRunSnapshot,
  projectTaskPlanRunReceipt,
  projectTaskPlanRunStatus,
  readTaskPlanRunResponseJson,
  stableId,
  TASK_PLAN_RUN_RECEIPT_MAX_BYTES,
  TASK_PLAN_RUN_SNAPSHOT_MAX_BYTES,
  TASK_PLAN_STORE_RESPONSE_MAX_BYTES,
  validateTaskPlanSpecBinding,
} from "@/lib/task-plan-run-contract.js"
import {
  evaluateTaskPlanRunAccess,
  evaluateTaskPlanRunMutationAuthority,
  resolveTaskPlanRunConfig,
} from "@/lib/task-plan-run-config.js"

type TaskPlanRunConfig = NonNullable<ReturnType<typeof resolveTaskPlanRunConfig>>

export class TaskPlanRunProxyError extends Error {
  constructor(message: string, public readonly status: number) { super(message) }
}

export function taskPlanRunMutationsEnabled() {
  return process.env.TASK_PLAN_RUN_MUTATIONS === "enabled"
}

function assertAccess(user: CurrentUser) {
  const access = evaluateTaskPlanRunAccess(user, process.env)
  if (!access.allowed) throw new TaskPlanRunProxyError(
    access.message || "Task-plan execution is not authorized",
    access.status || 403,
  )
}

function assertMutationAuthority(request: Request, user: CurrentUser) {
  const authority = evaluateTaskPlanRunMutationAuthority(
    user, request.url, request.headers.get("origin"), process.env,
  )
  if (!authority.allowed) throw new TaskPlanRunProxyError(
    authority.message || "Task-plan execution mutation is not authorized",
    authority.status || 403,
  )
  if (!taskPlanRunMutationsEnabled()) {
    throw new TaskPlanRunProxyError("Task-plan execution mutations are disabled by Galaxy Brain policy", 403)
  }
}

function getConfig(user: CurrentUser) {
  assertAccess(user)
  const config = resolveTaskPlanRunConfig(process.env)
  if (!config) throw new TaskPlanRunProxyError("Task-plan execution is not configured", 503)
  return config
}

function safeUpstreamStatus(status: number) {
  return [404, 409, 413, 422, 429, 503].includes(status) ? status : 502
}

async function fetchJson(
  url: string,
  init: RequestInit,
  maximumBytes: number,
  unavailableMessage: string,
  rejectedMessage: string,
) {
  let response: Response
  try {
    response = await fetch(url, { ...init, cache: "no-store", redirect: "error" })
  } catch {
    throw new TaskPlanRunProxyError(unavailableMessage, 502)
  }
  let body: unknown
  try {
    body = await readTaskPlanRunResponseJson(response, maximumBytes, "Upstream task-plan")
  } catch {
    throw new TaskPlanRunProxyError("Task-plan executor returned an invalid bounded response", 502)
  }
  if (!response.ok) throw new TaskPlanRunProxyError(rejectedMessage, safeUpstreamStatus(response.status))
  return body
}

function galaxyHeaders(config: TaskPlanRunConfig, user: CurrentUser) {
  return {
    Accept: "application/json",
    "X-GB-Proxy-Token": config.galaxyApiToken,
    "X-GB-Tenant-ID": user.tenantId,
    "X-GB-Principal-ID": user.principalId,
    "X-GB-Principal-Kind": "human",
    ...(user.nostrPubkey ? { "X-GB-Nostr-Pubkey": user.nostrPubkey } : {}),
  }
}

async function fetchExactTaskPlan(config: TaskPlanRunConfig, user: CurrentUser, planId: string) {
  const body = await fetchJson(
    `${config.galaxyApiUrl}/task-plans/${encodeURIComponent(planId)}`,
    { headers: galaxyHeaders(config, user), signal: AbortSignal.timeout(15_000) },
    TASK_PLAN_STORE_RESPONSE_MAX_BYTES,
    "Galaxy task-plan store is unavailable",
    "Galaxy task-plan store rejected the request",
  )
  try { return parseTaskPlanRecord(body) }
  catch { throw new TaskPlanRunProxyError("Galaxy task-plan store returned an invalid record", 502) }
}

async function fetchTaskPlanRevision(
  config: TaskPlanRunConfig,
  user: CurrentUser,
  planId: string,
  version: number,
) {
  const body = await fetchJson(
    `${config.galaxyApiUrl}/task-plans/${encodeURIComponent(planId)}/revisions/${version}`,
    { headers: galaxyHeaders(config, user), signal: AbortSignal.timeout(15_000) },
    TASK_PLAN_STORE_RESPONSE_MAX_BYTES,
    "Galaxy task-plan store is unavailable",
    "Galaxy task-plan store rejected the request",
  )
  try { return parseTaskPlanRevisionRecord(body) }
  catch { throw new TaskPlanRunProxyError("Galaxy task-plan store returned an invalid revision", 502) }
}

async function reserveTaskPlanDispatchIntent(
  config: TaskPlanRunConfig,
  user: CurrentUser,
  planId: string,
  input: {
    expectedPlanVersion: number
    expectedContentHash: string
    expectedTaskVersion: number
  },
  taskId: string,
  idempotencyKey: string,
) {
  const body = await fetchJson(
    `${config.galaxyApiUrl}/task-plans/${encodeURIComponent(planId)}/dispatch-intents`,
    {
      method: "POST",
      headers: { ...galaxyHeaders(config, user), "Content-Type": "application/json" },
      body: JSON.stringify({
        expected_plan_version: input.expectedPlanVersion,
        expected_content_hash: input.expectedContentHash,
        ham_task_id: taskId,
        expected_task_version: input.expectedTaskVersion,
        idempotency_key: idempotencyKey,
      }),
      signal: AbortSignal.timeout(15_000),
    },
    TASK_PLAN_STORE_RESPONSE_MAX_BYTES,
    "Galaxy task-plan store is unavailable",
    "Galaxy task-plan store rejected the dispatch intent",
  )
  try { return parseTaskPlanDispatchIntent(body) }
  catch { throw new TaskPlanRunProxyError("Galaxy task-plan store returned an invalid dispatch intent", 502) }
}

function hyadesHeaders(config: TaskPlanRunConfig, user: CurrentUser) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${config.bearerToken}`,
    "Content-Type": "application/json",
    "X-GB-Performed-By": "service:galaxy-brain-task-plan-run",
    "X-GB-Requester-ID": user.id,
    "X-GB-Requester-Type": "human",
  }
}

async function fetchAuthorizedTask(user: CurrentUser, taskId: string, requireStartable: boolean) {
  let rawTask: unknown
  try { rawTask = await fetchHamTask("detail", { user, taskId }) }
  catch (error) {
    if (error instanceof HamTaskProxyError) {
      throw new TaskPlanRunProxyError("HAM task could not be verified", safeUpstreamStatus(error.status))
    }
    throw new TaskPlanRunProxyError("HAM task could not be verified", 502)
  }
  const taskSource = rawTask && typeof rawTask === "object" && "task" in rawTask
    ? (rawTask as { task: unknown }).task : rawTask
  const task = normalizeTaskDetail(taskSource)
  if (task.id !== taskId) throw new TaskPlanRunProxyError("HAM returned a different task", 409)
  if (task.requesterRef !== `galaxy-brain:user:${user.id}`) {
    throw new TaskPlanRunProxyError("Only the Galaxy task requester may access this run", 403)
  }
  if (requireStartable && (task.state !== "pending" || task.activeRun)) {
    throw new TaskPlanRunProxyError("HAM task is not available to start", 409)
  }
  return task
}

function assertPlanOwnerAndScope(plan: ReturnType<typeof parseTaskPlanRecord>, user: CurrentUser, taskId: string) {
  if (plan.tenantId.toLowerCase() !== user.tenantId.toLowerCase() || plan.hamTaskId !== taskId) {
    throw new TaskPlanRunProxyError("Saved plan is not bound to this HAM task and tenant", 409)
  }
  if (plan.createdByPrincipalId.toLowerCase() !== user.principalId.toLowerCase()) {
    throw new TaskPlanRunProxyError("Only the saved plan author may access its run", 403)
  }
}

async function fetchBoundSnapshot(
  config: TaskPlanRunConfig,
  user: CurrentUser,
  taskId: string,
  runId: string,
) {
  const body = await fetchJson(
    `${config.baseUrl}/admin/ham/runs/${encodeURIComponent(runId)}`,
    { headers: hyadesHeaders(config, user), signal: AbortSignal.timeout(15_000) },
    TASK_PLAN_RUN_SNAPSHOT_MAX_BYTES,
    "Hyades task-plan executor is unavailable",
    "Hyades rejected the run status request",
  )
  let snapshot
  try {
    snapshot = parseTaskPlanRunSnapshot(body, {
      runId, taskId, hyadesTenant: config.hyadesTenant, hamProject: config.hamProject,
    })
  } catch {
    throw new TaskPlanRunProxyError("Hyades returned an invalid task-plan run snapshot", 502)
  }
  const plan = await fetchExactTaskPlan(config, user, snapshot.taskPlanId)
  assertPlanOwnerAndScope(plan, user, taskId)
  if (plan.id !== snapshot.taskPlanId) {
    throw new TaskPlanRunProxyError("Galaxy returned a different saved plan", 409)
  }
  return snapshot
}

export async function dispatchTaskPlanRun(options: {
  request: Request
  user: CurrentUser
  taskId: string
  input: {
    taskPlanId: string
    expectedPlanVersion: number
    expectedContentHash: string
    expectedTaskVersion: number
  }
  idempotencyKey: string
}) {
  const taskId = stableId(options.taskId, "taskId")
  const config = getConfig(options.user)
  assertMutationAuthority(options.request, options.user)
  // Authorization is re-read here, but Hyades owns the authoritative
  // pending/version/active-run preflight. Do not reject an advanced task
  // locally: a prior dispatch may have been durably accepted while its HTTP
  // response was lost, and the identical retry must reach Hyades' replay
  // ledger before lifecycle checks run.
  await fetchAuthorizedTask(options.user, taskId, false)
  const plan = await fetchExactTaskPlan(config, options.user, options.input.taskPlanId)
  assertPlanOwnerAndScope(plan, options.user, taskId)
  if (plan.id !== options.input.taskPlanId) {
    throw new TaskPlanRunProxyError("Galaxy returned a different saved plan", 409)
  }
  const downstreamIdempotencyKey = namespaceTaskPlanRunIdempotencyKey(
    options.user.id,
    options.idempotencyKey,
  )
  const intent = await reserveTaskPlanDispatchIntent(
    config,
    options.user,
    plan.id,
    options.input,
    taskId,
    downstreamIdempotencyKey,
  )
  if (intent.taskPlanId !== plan.id
    || intent.tenantId.toLowerCase() !== options.user.tenantId.toLowerCase()
    || intent.taskPlanVersion !== options.input.expectedPlanVersion
    || intent.taskPlanContentHash !== options.input.expectedContentHash
    || intent.taskId !== taskId
    || intent.expectedTaskVersion !== options.input.expectedTaskVersion) {
    throw new TaskPlanRunProxyError("Galaxy returned a mismatched dispatch intent", 502)
  }
  const revision = await fetchTaskPlanRevision(
    config,
    options.user,
    plan.id,
    intent.taskPlanVersion,
  )
  if (revision.taskPlanId !== plan.id
    || revision.tenantId.toLowerCase() !== options.user.tenantId.toLowerCase()
    || revision.version !== options.input.expectedPlanVersion
    || revision.contentHash !== options.input.expectedContentHash) {
    throw new TaskPlanRunProxyError("Saved plan revision does not match the dispatch request", 409)
  }
  const specSha256 = validateTaskPlanSpecBinding(revision.spec, {
    taskId,
    taskVersion: options.input.expectedTaskVersion,
  })
  const specJson = canonicalJson(revision.spec)
  const path = `/admin/ham/projects/${encodeURIComponent(config.hyadesTenant)}/${encodeURIComponent(config.hamProject)}`
    + `/tasks/${encodeURIComponent(taskId)}/task-plan-dispatch`
  const body = await fetchJson(
    `${config.baseUrl}${path}`,
    {
      method: "POST",
      headers: hyadesHeaders(config, options.user),
      body: JSON.stringify({
        taskId,
        expectedTaskVersion: options.input.expectedTaskVersion,
        taskPlanId: plan.id,
        taskPlanVersion: revision.version,
        taskPlanContentSha256: revision.contentHash,
        taskPlanSpecSha256: specSha256,
        taskPlanSpecJson: specJson,
        idempotencyKey: downstreamIdempotencyKey,
      }),
      signal: AbortSignal.timeout(30_000),
    },
    TASK_PLAN_RUN_RECEIPT_MAX_BYTES,
    "Hyades task-plan executor is unavailable",
    "Hyades rejected the task-plan dispatch",
  )
  let receipt
  try { receipt = projectTaskPlanRunReceipt(body) }
  catch { throw new TaskPlanRunProxyError("Hyades returned an invalid task-plan dispatch receipt", 502) }
  if (receipt.taskId !== taskId || receipt.taskPlanId !== plan.id
    || receipt.taskPlanVersion !== revision.version || receipt.taskPlanSpecSha256 !== specSha256) {
    throw new TaskPlanRunProxyError("Hyades returned a mismatched task-plan dispatch receipt", 502)
  }
  return {
    ...receipt,
    taskPlanContentSha256: revision.contentHash,
    expectedTaskVersion: options.input.expectedTaskVersion,
  }
}

export async function getTaskPlanRunStatus(options: {
  user: CurrentUser
  taskId: string
  runId: string
}) {
  const taskId = stableId(options.taskId, "taskId")
  const runId = stableId(options.runId, "runId")
  const config = getConfig(options.user)
  await fetchAuthorizedTask(options.user, taskId, false)
  return projectTaskPlanRunStatus(await fetchBoundSnapshot(config, options.user, taskId, runId))
}

export async function cancelTaskPlanRun(options: {
  request: Request
  user: CurrentUser
  taskId: string
  runId: string
}) {
  const taskId = stableId(options.taskId, "taskId")
  const runId = stableId(options.runId, "runId")
  const config = getConfig(options.user)
  assertMutationAuthority(options.request, options.user)
  await fetchAuthorizedTask(options.user, taskId, false)
  const before = await fetchBoundSnapshot(config, options.user, taskId, runId)
  const body = await fetchJson(
    `${config.baseUrl}/admin/ham/runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: "POST",
      headers: hyadesHeaders(config, options.user),
      body: "{}",
      signal: AbortSignal.timeout(30_000),
    },
    TASK_PLAN_RUN_SNAPSHOT_MAX_BYTES,
    "Hyades task-plan executor is unavailable",
    "Hyades rejected the run cancellation",
  )
  const envelope = body && typeof body === "object" && "run" in body
    ? (body as { run: unknown }).run : null
  let after
  try {
    after = parseTaskPlanRunSnapshot(envelope, {
      runId, taskId, hyadesTenant: config.hyadesTenant, hamProject: config.hamProject,
    })
  } catch {
    throw new TaskPlanRunProxyError("Hyades returned an invalid task-plan run snapshot", 502)
  }
  if (after.taskPlanId !== before.taskPlanId
    || after.taskPlanVersion !== before.taskPlanVersion
    || after.taskPlanContentSha256 !== before.taskPlanContentSha256
    || after.taskPlanSpecSha256 !== before.taskPlanSpecSha256
    || after.expectedTaskVersion !== before.expectedTaskVersion) {
    throw new TaskPlanRunProxyError("Hyades returned a mismatched task-plan run snapshot", 502)
  }
  return projectTaskPlanRunStatus(after)
}
