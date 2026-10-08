import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  canonicalJson,
  assertEmptyTaskPlanRunBody,
  namespaceTaskPlanRunIdempotencyKey,
  parseTaskPlanDispatchIntent,
  parseTaskPlanRevisionRecord,
  parseTaskPlanRunIdempotencyKey,
  parseTaskPlanRunInput,
  parseTaskPlanRunSnapshot,
  projectTaskPlanRunReceipt,
  projectTaskPlanRunStatus,
  readTaskPlanRunJsonBody,
  readTaskPlanRunResponseJson,
  taskPlanSpecSha256,
} from "../lib/task-plan-run-contract.js"
import {
  evaluateTaskPlanRunAccess,
  evaluateTaskPlanRunMutationAuthority,
  resolveTaskPlanRunConfig,
} from "../lib/task-plan-run-config.js"

const TENANT = "00000000-0000-4000-8000-000000000001"
const PRINCIPAL = "10000000-0000-4000-8000-000000000001"
const USER = {
  id: "user-1",
  principalId: PRINCIPAL,
  tenantId: TENANT,
  role: "owner",
  authenticatedAt: "2026-09-26T12:00:00.000Z",
}
const SPEC = {
  schema: "gb.task-plan.v1",
  task: { kind: "galaxy.ham.task", id: "task-1", version: 7 },
  goal: "Investigate",
  nodes: [{ id: "research", kind: "research", title: "Research", goal: "Collect", position: { x: 0, y: 0 }, config: {} }],
  edges: [],
}
const SPEC_JSON = canonicalJson(SPEC)
const SPEC_HASH = taskPlanSpecSha256(SPEC)

function snapshot(overrides = {}) {
  return {
    runId: "run-1",
    phase: "started",
    createdAt: "2026-09-26T12:01:00Z",
    completedAt: null,
    blockReason: null,
    blockedSince: null,
    lastHeartbeatAt: "2026-09-26T12:02:00Z",
    transitions: [{ detail: "must not escape" }],
    error: "provider internals",
    blockDetail: "capacity internals",
    workspace: { secret: true },
    evaluations: [{ secret: true }],
    artifacts: [{ secret: true }],
    wake: {
      tenant: "example-tenant",
      project: "galaxy-brain",
      hamTaskId: "task-1",
      triggerKind: "galaxy-task-plan",
      taskPlanId: "plan-1",
      taskPlanVersion: 2,
      taskPlanContentSha256: "a".repeat(64),
      taskPlanSpecSha256: SPEC_HASH,
      taskPlanSpecJson: SPEC_JSON,
      taskPlanExpectedTaskVersion: 7,
      authority: { secret: true },
    },
    ...overrides,
  }
}

test("dispatch input admits only exact saved revision fences", () => {
  assert.deepEqual(parseTaskPlanRunInput({
    taskPlanId: "plan-1",
    expectedPlanVersion: 2,
    expectedContentHash: "a".repeat(64),
    expectedTaskVersion: 7,
  }), {
    taskPlanId: "plan-1",
    expectedPlanVersion: 2,
    expectedContentHash: "a".repeat(64),
    expectedTaskVersion: 7,
  })
  assert.throws(() => parseTaskPlanRunInput({
    taskPlanId: "plan-1",
    expectedPlanVersion: 2,
    expectedContentHash: "a".repeat(64),
    expectedTaskVersion: 7,
    executor: "caller-controlled",
  }), /unsupported fields/)
  assert.equal(parseTaskPlanRunIdempotencyKey("dispatch:task-1:v7"), "dispatch:task-1:v7")
  assert.throws(() => parseTaskPlanRunIdempotencyKey("x".repeat(201)), /Idempotency-Key/)
  const first = namespaceTaskPlanRunIdempotencyKey("user-1", "dispatch:task-1:v7")
  assert.match(first, /^[0-9a-f]{64}$/)
  assert.equal(first, namespaceTaskPlanRunIdempotencyKey("user-1", "dispatch:task-1:v7"))
  assert.notEqual(first, namespaceTaskPlanRunIdempotencyKey("user-2", "dispatch:task-1:v7"))
})

test("request and response readers enforce declared and streamed byte bounds", async () => {
  await assert.rejects(
    readTaskPlanRunJsonBody(new Request("https://galaxy.example/api/tasks/task-1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "5000" },
      body: "{}",
    })),
    (error) => error.status === 413,
  )
  await assert.rejects(
    readTaskPlanRunResponseJson(new Response("x".repeat(33)), 32, "Hyades"),
    (error) => error.status === 502,
  )
  await assert.doesNotReject(assertEmptyTaskPlanRunBody(new Request("https://galaxy.example/cancel", {
    method: "POST",
  })))
  await assert.rejects(assertEmptyTaskPlanRunBody(new Request("https://galaxy.example/cancel", {
    method: "POST",
    body: "{}",
  })), /accepts no request body/)
})

test("canonical task-plan hashing is stable across object key order", () => {
  const reordered = {
    edges: [], nodes: SPEC.nodes, goal: SPEC.goal,
    task: { version: 7, id: "task-1", kind: "galaxy.ham.task" }, schema: "gb.task-plan.v1",
  }
  assert.equal(canonicalJson(SPEC), canonicalJson(reordered))
  assert.equal(taskPlanSpecSha256(SPEC), taskPlanSpecSha256(reordered))
})

test("immutable task-plan revisions retain exact replay material", () => {
  assert.deepEqual(parseTaskPlanRevisionRecord({
    task_plan_id: "plan-1",
    tenant_id: TENANT,
    version: 2,
    content_hash: "a".repeat(64),
    spec: SPEC,
    provenance: { ignored: true },
  }), {
    taskPlanId: "plan-1",
    tenantId: TENANT,
    version: 2,
    contentHash: "a".repeat(64),
    spec: SPEC,
  })
  assert.throws(() => parseTaskPlanRevisionRecord({
    task_plan_id: "plan-1",
    tenant_id: TENANT,
    version: 2,
    content_hash: "not-a-hash",
    spec: SPEC,
  }), /content hash/)
})

test("durable dispatch intents retain only exact bounded replay identity", () => {
  assert.deepEqual(parseTaskPlanDispatchIntent({
    task_plan_id: "plan-1",
    tenant_id: TENANT,
    task_plan_version: 2,
    task_plan_content_hash: "a".repeat(64),
    ham_task_id: "task-1",
    expected_task_version: 7,
    requested_by_principal_id: PRINCIPAL,
    request_hash: "b".repeat(64),
    replayed: true,
  }), {
    taskPlanId: "plan-1",
    tenantId: TENANT,
    taskPlanVersion: 2,
    taskPlanContentHash: "a".repeat(64),
    taskId: "task-1",
    expectedTaskVersion: 7,
    replayed: true,
  })
})

test("access is tenant and owner-admin bound; mutations also require origin and recent auth", () => {
  const environment = {
    TASK_PLAN_EXECUTOR_GALAXY_TENANT_ID: TENANT,
    AUTH_ORIGIN: "https://galaxy.example",
    TASK_PLAN_EXECUTOR_MAX_SESSION_AGE_MINUTES: "15",
  }
  assert.equal(evaluateTaskPlanRunAccess(USER, environment).allowed, true)
  assert.equal(evaluateTaskPlanRunAccess({ ...USER, role: "member" }, environment).status, 403)
  assert.equal(evaluateTaskPlanRunAccess({ ...USER, tenantId: "00000000-0000-4000-8000-000000000002" }, environment).status, 403)
  assert.equal(evaluateTaskPlanRunMutationAuthority(
    USER, "https://galaxy.example/api/tasks/task-1/runs", "https://galaxy.example", environment,
    Date.parse("2026-09-26T12:10:00Z"),
  ).allowed, true)
  assert.equal(evaluateTaskPlanRunMutationAuthority(
    USER, "https://galaxy.example/api/tasks/task-1/runs", "https://evil.example", environment,
    Date.parse("2026-09-26T12:10:00Z"),
  ).status, 403)
  assert.equal(evaluateTaskPlanRunMutationAuthority(
    USER, "https://galaxy.example/api/tasks/task-1/runs", "https://galaxy.example", environment,
    Date.parse("2026-09-26T12:16:00Z"),
  ).status, 403)
})

test("executor configuration is complete, server-selected, and uses strict server URLs", () => {
  const valid = {
    HYADES_TASK_PLAN_API_INTERNAL: "https://hyades.internal/control/",
    HYADES_TASK_PLAN_OPERATOR_BEARER_TOKEN: "operator",
    HYADES_TASK_PLAN_TENANT: "example-tenant",
    HYADES_TASK_PLAN_HAM_PROJECT: "galaxy-brain",
    GALAXY_API_INTERNAL: "http://galaxy-api:8044/",
    GALAXY_API_PROXY_TOKEN: "proxy",
  }
  assert.deepEqual(resolveTaskPlanRunConfig(valid), {
    baseUrl: "https://hyades.internal/control",
    bearerToken: "operator",
    hyadesTenant: "example-tenant",
    hamProject: "galaxy-brain",
    galaxyApiUrl: "http://galaxy-api:8044",
    galaxyApiToken: "proxy",
  })
  assert.equal(resolveTaskPlanRunConfig({ ...valid, HYADES_TASK_PLAN_API_INTERNAL: "file:///secret" }), null)
  assert.equal(resolveTaskPlanRunConfig({ ...valid, HYADES_TASK_PLAN_API_INTERNAL: "https://user:pass@hyades.internal" }), null)
  assert.equal(resolveTaskPlanRunConfig({ ...valid, HYADES_TASK_PLAN_API_INTERNAL: "https://hyades.internal?a=b" }), null)
  assert.equal(resolveTaskPlanRunConfig({ ...valid, HYADES_TASK_PLAN_API_INTERNAL: "https://hyades.internal/#fragment" }), null)
})

test("receipt and snapshot projections fail closed and omit executor internals", () => {
  assert.deepEqual(projectTaskPlanRunReceipt({ receipt: {
    taskId: "task-1",
    runId: "run-1",
    taskPlanId: "plan-1",
    taskPlanVersion: 2,
    taskPlanSpecSha256: SPEC_HASH,
    state: "wake-requested",
    replayed: false,
    authority: { secret: true },
  } }), {
    taskId: "task-1",
    runId: "run-1",
    taskPlanId: "plan-1",
    taskPlanVersion: 2,
    taskPlanSpecSha256: SPEC_HASH,
    state: "wake-requested",
    replayed: false,
  })
  const parsed = parseTaskPlanRunSnapshot(snapshot(), {
    runId: "run-1", taskId: "task-1", hyadesTenant: "example-tenant", hamProject: "galaxy-brain",
  })
  assert.deepEqual(projectTaskPlanRunStatus(parsed), {
    runId: "run-1",
    taskId: "task-1",
    taskPlanId: "plan-1",
    taskPlanVersion: 2,
    taskPlanContentSha256: "a".repeat(64),
    taskPlanSpecSha256: SPEC_HASH,
    expectedTaskVersion: 7,
    phase: "started",
    blockReason: null,
    blockedSince: null,
    lastHeartbeatAt: "2026-09-26T12:02:00Z",
    createdAt: "2026-09-26T12:01:00Z",
    completedAt: null,
  })
  assert.throws(() => parseTaskPlanRunSnapshot(snapshot({
    wake: { ...snapshot().wake, triggerKind: "ham-task-event" },
  })), /not a Galaxy task-plan run/)
  assert.throws(() => parseTaskPlanRunSnapshot(snapshot({
    wake: { ...snapshot().wake, taskPlanSpecSha256: "b".repeat(64) },
  })), /hash is invalid/)
  assert.throws(() => parseTaskPlanRunSnapshot(snapshot({ blockReason: "raw_provider_failure" })), /block reason is invalid/)
})

test("server adapter exposes only POST dispatch, GET status, and POST cancel", async () => {
  const [dispatchRoute, statusRoute, cancelRoute, proxy, api] = await Promise.all([
    readFile(new URL("../app/api/tasks/[taskId]/runs/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/tasks/[taskId]/runs/[runId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/tasks/[taskId]/runs/[runId]/cancel/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/task-plan-run-proxy.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/galaxy-brain-api/server.py", import.meta.url), "utf8"),
  ])
  assert.match(dispatchRoute, /export async function POST/)
  assert.doesNotMatch(dispatchRoute, /export async function GET/)
  assert.match(statusRoute, /export async function GET/)
  assert.doesNotMatch(statusRoute, /export async function POST/)
  assert.match(cancelRoute, /export async function POST/)
  assert.match(cancelRoute, /assertEmptyTaskPlanRunBody/)
  assert.match(proxy, /fetchBoundSnapshot[\s\S]*\/cancel[\s\S]*parseTaskPlanRunSnapshot/u)
  assert.doesNotMatch(
    proxy,
    /plan\.currentVersion\s*!==\s*snapshot\.taskPlanVersion|plan\.currentContentHash\s*!==\s*snapshot\.taskPlanContentSha256/u,
    "a later saved plan revision must not make an immutable run inaccessible",
  )
  assert.match(proxy, /redirect: "error"/)
  assert.match(proxy, /namespaceTaskPlanRunIdempotencyKey/)
  assert.match(proxy, /fetchAuthorizedTask\(options\.user, taskId, false\)/)
  assert.match(proxy, /expectedTaskVersion: options\.input\.expectedTaskVersion/)
  assert.doesNotMatch(proxy, /task\.version !== options\.input\.expectedTaskVersion/)
  assert.match(api, /@app\.get\("\/task-plans\/\{task_plan_id\}\/revisions\/\{version\}"\)/)
  assert.match(api, /@app\.post\("\/task-plans\/\{task_plan_id\}\/dispatch-intents"/)
  assert.match(api, /gb_task_plan_dispatch_intents[\s\S]*FOR UPDATE[\s\S]*replay\["replayed"\] = True/u)
  assert.match(proxy, /reserveTaskPlanDispatchIntent[\s\S]*fetchTaskPlanRevision/u)
  assert.doesNotMatch(proxy, /task\.state === "pending"[\s\S]*task\.version === options\.input\.expectedTaskVersion/u)
  assert.match(proxy, /\[404, 409, 413, 422, 429, 503\]\.includes\(status\)/)
  assert.doesNotMatch(proxy, /\[400, 401, 403, 404/u)
  assert.doesNotMatch(proxy, /components\/|taskPlanSpecJson:\s*receipt|\.transitions|\.workspace|\.artifacts|\.evaluations/u)
})
