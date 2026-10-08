import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  buildHamTaskCreateBody,
  buildHamTaskEventsBody,
  buildHamTaskPageBody,
  HAM_TASK_STATUSES,
  namespaceHamTaskIdempotencyKey,
  parseHamTaskAcceptanceCriteria,
  parseHamTaskActivityMode,
  parseHamTaskExpectedVersion,
  parseHumanTaskResources,
  parseHamTaskResources,
} from "../lib/ham-task-contract.js"
import {
  findLocalResourceConflicts,
  formatTaskFreshness,
  mergeTaskPages,
  normalizeTask,
  normalizeTaskEvent,
  normalizeTaskEventPage,
  taskLifecyclePhase,
  taskBucket,
} from "../lib/ham-task-adapter.js"
import {
  projectHamTaskDetailForBrowser,
  projectHamTaskEventPageForBrowser,
  projectHamTaskPageForBrowser,
} from "../lib/ham-task-browser-projection.js"
import { createHamTaskExternalCompletionPost } from "../lib/ham-task-external-completion-handler.js"
import { evaluateHamTaskTenantAccess, resolveHamTaskProxyConfig } from "../lib/ham-task-proxy-config.js"
import { getHamTaskProxyRoute, HAM_TASK_PROXY_OPERATIONS } from "../lib/ham-task-proxy-policy.js"

test("the BFF allowlist exposes human projections and scoped external reconciliation", () => {
  assert.deepEqual(Object.keys(HAM_TASK_PROXY_OPERATIONS).sort(), ["create", "detail", "events", "externalComplete", "page"])
  assert.deepEqual(getHamTaskProxyRoute("create", { projectRef: "galaxy brain" }), {
    method: "POST",
    path: "/projects/galaxy%20brain/tasks",
  })
  assert.deepEqual(getHamTaskProxyRoute("detail", { taskId: "task/42" }), {
    method: "GET",
    path: "/tasks/task%2F42",
  })
  assert.deepEqual(getHamTaskProxyRoute("externalComplete", { taskId: "task/42" }), {
    method: "POST",
    path: "/tasks/task%2F42/respond",
  })
  for (const forbidden of ["claim", "respond", "start-run", "update"]) {
    assert.throws(() => getHamTaskProxyRoute(forbidden, {}), /not allowed/)
  }
})

test("create, queue, and event bodies match the HAM task contract exactly", () => {
  assert.deepEqual(buildHamTaskCreateBody({
    title: "Review the transport",
    goal: "Produce an independent result",
    rationale: "Avoid self-review",
    activityMode: "diagnostic",
    requesterRef: "galaxy-brain:user:human-1",
    idempotencyKey: "idem-1",
    resources: [{ key: "repo:MonumentalSystems/ham", mode: "read" }],
    acceptanceCriteria: ["All checks pass"],
  }), {
    title: "Review the transport",
    goal: "Produce an independent result",
    rationale: "Avoid self-review",
    activity_mode: "diagnostic",
    acceptance_criteria: ["All checks pass"],
    resources: [{ key: "repo:MonumentalSystems/ham", mode: "read" }],
    requester_ref: "galaxy-brain:user:human-1",
    idempotency_key: "idem-1",
  })
  assert.deepEqual(buildHamTaskPageBody("galaxy-brain", "task-cursor", 100), {
    project: "galaxy-brain",
    statuses: [...HAM_TASK_STATUSES],
    cursor: "task-cursor",
    limit: 100,
  })
  assert.deepEqual(buildHamTaskEventsBody("galaxy-brain", "task-1", 9, 50), {
    project: "galaxy-brain",
    task_id: "task-1",
    after_event_id: 9,
    limit: 50,
  })
})

test("affected resource keys follow HAM limits and case-insensitive uniqueness", () => {
  const pinnedAnchor = `gb:object:v1:document.anchor:sha256%3A${"a".repeat(64)}:pinned:sha256%3A${"b".repeat(64)}`
  assert.deepEqual(parseHamTaskResources([
    " repo:MonumentalSystems/ham ",
    "service:ham-production",
    pinnedAnchor,
  ], "write"), [
    { key: "repo:MonumentalSystems/ham", mode: "write" },
    { key: "service:ham-production", mode: "write" },
    { key: pinnedAnchor, mode: "write" },
  ])
  assert.throws(() => parseHamTaskResources(["repo:ham", "REPO:HAM"], "read"), /Duplicate/)
  assert.throws(() => parseHamTaskResources(["repo:ham?unsafe"], "read"), /Invalid resource key/)
  assert.throws(
    () => parseHamTaskResources([
      `gb:object:v1:document.anchor:sha256%3a${"a".repeat(64)}:pinned:sha256%3A${"b".repeat(64)}`,
    ], "read"),
    /Invalid resource key/,
  )
  assert.throws(
    () => parseHamTaskResources(["gb:object:v1:document.anchor:%GG:pinned:sha256%3Ainvalid"], "read"),
    /Invalid resource key/,
  )
  assert.throws(() => parseHamTaskResources(Array.from({ length: 51 }, (_, index) => `repo:${index}`), "read"), /at most 50/)
  assert.throws(() => parseHamTaskResources(["repo:ham"], "admin"), /mode is invalid/)
})

test("generic human task creation cannot claim the reserved proof-packet namespace", async () => {
  for (const resource of [
    "proof-packet:campaign-v1/packet-a",
    `proof-packet:sha256:${"a".repeat(64)}/campaign-v1/packet-a`,
    `PrOoF-PaCkEt:sha256:${"a".repeat(64)}/campaign-v1/packet-a`,
  ]) {
    assert.throws(() => parseHumanTaskResources([resource], "observe"), /reserved for exact-directive Hyades dispatch/)
  }
  assert.deepEqual(parseHumanTaskResources([
    "repo:MonumentalSystems/ham",
    "paper:10000000-0000-4000-8000-000000000001",
    "service:hyades",
  ], "observe"), [
    { key: "repo:MonumentalSystems/ham", mode: "observe" },
    { key: "paper:10000000-0000-4000-8000-000000000001", mode: "observe" },
    { key: "service:hyades", mode: "observe" },
  ])

  const proxy = await readFile(new URL("../lib/ham-task-proxy.ts", import.meta.url), "utf8")
  assert.match(proxy, /resources = parseHumanTaskResources\(resourceKeys, resourceMode\)/)
})

test("resource intent cannot be submitted without a named resource", async () => {
  const proxy = await readFile(new URL("../lib/ham-task-proxy.ts", import.meta.url), "utf8")
  assert.match(proxy, /a resource key is required before selecting resource intent/)
})

test("paper resources disclose only canonical UUID references", () => {
  const base = {
    task_id: "task-paper",
    project: "galaxy-brain",
    title: "Review paper",
    goal: "Audit the evidence",
    rationale: "Preserve source coordinates",
    activity_mode: "diagnostic",
    status: "pending",
  }
  const projected = projectHamTaskPageForBrowser({ tasks: [{
    ...base,
    resources: [
      { key: "paper:10000000-0000-4000-8000-000000000001", mode: "read", status: "active" },
      { key: "paper:not-a-canonical-id", mode: "read", status: "active" },
    ],
  }] })
  assert.equal(projected.tasks[0].resources[0].resourceRef, "paper:10000000-0000-4000-8000-000000000001")
  assert.equal(projected.tasks[0].resources[1].resourceRef, "restricted")
})

test("only canonical pinned Galaxy object resources cross the browser task boundary", () => {
  const pinned = `gb:object:v1:document.anchor:sha256%3A${"a".repeat(64)}:pinned:sha256%3A${"b".repeat(64)}`
  const latest = "gb:object:v1:document:document-1:latest"
  const projected = projectHamTaskPageForBrowser({ tasks: [{
    task_id: "task-galaxy-ref",
    project: "galaxy-brain",
    title: "Use exact evidence",
    goal: "Keep a pinned coordinate",
    rationale: "Reviewable task plan",
    activity_mode: "diagnostic",
    status: "pending",
    resources: [
      { key: pinned, mode: "read", status: "active" },
      { key: latest, mode: "read", status: "active" },
    ],
  }] })
  assert.equal(projected.tasks[0].resources[0].resourceRef, pinned)
  assert.equal(projected.tasks[0].resources[0].redacted, false)
  assert.equal(projected.tasks[0].resources[1].resourceRef, "restricted")
  assert.equal(projected.tasks[0].resources[1].redacted, true)
})

test("task proxy configuration fails closed without its dedicated endpoint", () => {
  const legacyOnly = resolveHamTaskProxyConfig("page", {
    HAM_API_INTERNAL: "https://legacy-endpoint-secret.invalid",
    HAM_TASK_READ_BEARER_TOKEN: "observer-secret",
  })
  assert.equal(legacyOnly, null)
  assert.doesNotMatch(JSON.stringify({ config: legacyOnly }), /legacy-endpoint-secret|observer-secret/)

  assert.deepEqual(resolveHamTaskProxyConfig("page", {
    HAM_TASK_API_INTERNAL: "https://tasks.example.internal/",
    HAM_API_INTERNAL: "https://legacy-endpoint-secret.invalid",
    HAM_TASK_READ_BEARER_TOKEN: "observer-token",
  }), {
    baseUrl: "https://tasks.example.internal",
    bearerToken: "observer-token",
    readOnly: true,
  })
  assert.deepEqual(resolveHamTaskProxyConfig("page", {
    HAM_TASK_API_INTERNAL: "https://tasks.example.internal/",
    GALAXY_DEPLOY_HAM_TASK_READ_BEARER_TOKEN: "rotated-observer-token",
    HAM_TASK_READ_BEARER_TOKEN: "",
  }), {
    baseUrl: "https://tasks.example.internal",
    bearerToken: "rotated-observer-token",
    readOnly: true,
  })
  assert.deepEqual(resolveHamTaskProxyConfig("create", {
    HAM_TASK_API_INTERNAL: "https://tasks.example.internal",
    GALAXY_DEPLOY_HAM_TASK_WRITE_BEARER_TOKEN: "rotated-publisher-token",
    HAM_TASK_WRITE_BEARER_TOKEN: "publisher-token",
  }), {
    baseUrl: "https://tasks.example.internal",
    bearerToken: "rotated-publisher-token",
    readOnly: false,
  })
})

test("the deployment-global HAM project is bound to one Galaxy tenant", () => {
  const environment = {
    HAM_TASK_GALAXY_TENANT_ID: "00000000-0000-4000-8000-000000000001",
  }
  assert.deepEqual(evaluateHamTaskTenantAccess({
    tenantId: "00000000-0000-4000-8000-000000000001",
  }, environment), {
    allowed: true,
    tenantId: "00000000-0000-4000-8000-000000000001",
  })
  assert.deepEqual(evaluateHamTaskTenantAccess({
    tenantId: "00000000-0000-4000-8000-000000000002",
  }, environment), {
    allowed: false,
    status: 403,
    message: "HAM task integration is not authorized for this Galaxy tenant",
  })
  assert.equal(evaluateHamTaskTenantAccess({ tenantId: environment.HAM_TASK_GALAXY_TENANT_ID }, {}).status, 503)
  assert.equal(evaluateHamTaskTenantAccess({ tenantId: environment.HAM_TASK_GALAXY_TENANT_ID }, {
    HAM_TASK_GALAXY_TENANT_ID: "not-a-uuid",
  }).status, 503)
})

test("adapter maps the current HAM owner, run, event, resource, and conflict envelope", () => {
  const task = normalizeTask({
    task_id: "task-1",
    project: "galaxy-brain",
    title: "Transport review",
    goal: "Review at exact head",
    rationale: "Make review state visible",
    activity_mode: "test",
    status: "running",
    claimed_by_agent: "codex-dgx",
    resources: [{ key: "repo:ham:pr-42", mode: "write" }],
    run: {
      run_id: "run-1",
      agent_id: "codex-dgx",
      intent: "Checking auth boundaries",
      status: "running",
      updated_at: "2026-08-15T12:05:00Z",
      last_progress_at: "2026-08-15T12:06:00Z",
    },
    latest_event: {
      event_id: "event-2",
      event_type: "progress",
      summary: "Running revocation checks",
      occurred_at: "2026-08-15T12:07:00Z",
    },
    conflicts: [{
      task_id: "task-2",
      title: "Deploy HAM",
      status: "running",
      claimed_by_agent: "claude-dgx",
      resource_key: "repo:ham:pr-42",
      requested_mode: "write",
      active_mode: "write",
      severity: "high",
    }],
  })
  assert.equal(task.owner?.principalId, "codex-dgx")
  assert.equal(task.activeRun?.id, "run-1")
  assert.equal(task.activeRun?.stage, "Checking auth boundaries")
  assert.equal(task.stage, "Running revocation checks")
  assert.equal(task.updatedAt, "2026-08-15T12:07:00Z")
  assert.equal(task.resources[0].resourceRef, "repo:ham:pr-42")
  assert.match(task.conflicts[0].summary, /Deploy HAM/)
  assert.equal(task.riskMode, "test")
  assert.equal(task.lifecyclePhase, "running")
  assert.equal(task.projectionSource, "ham")
  assert.equal(task.lastAuthoritativeEvent?.type, "progress")

  const event = normalizeTaskEvent({
    event_id: "event-3",
    event_type: "blocked",
    actor_agent_id: "codex-dgx",
    evidence: { summary: "Credential lacks task scope" },
    occurred_at: "2026-08-15T12:08:00Z",
  })
  assert.equal(event.actorRef, "codex-dgx")
  assert.equal(event.summary, "Task event")
  assert.deepEqual(event.evidenceRefs, [])

  const eventPage = normalizeTaskEventPage({
    items: [
      { event_id: "event-12", sequence: 12, event_type: "progress", summary: "One" },
      { event_id: "event-13", sequence: 13, event_type: "progress", summary: "Two" },
    ],
    next_cursor: 13,
    has_more: true,
  })
  assert.deepEqual(eventPage.events.map((item) => [item.id, item.sequence]), [["event-12", 12], ["event-13", 13]])
  assert.equal(eventPage.nextCursor, 13)
  assert.equal(eventPage.hasMore, true)
})

test("human idempotency keys are stable and isolated by requester", () => {
  const first = namespaceHamTaskIdempotencyKey("human-1", "retry-key")
  assert.equal(first, namespaceHamTaskIdempotencyKey("human-1", "retry-key"))
  assert.notEqual(first, namespaceHamTaskIdempotencyKey("human-2", "retry-key"))
  assert.match(first, /^galaxy-brain:[0-9a-f]{64}$/)
  assert.throws(() => namespaceHamTaskIdempotencyKey("human-1", ""), /1 to 200/)
})

test("activity mode and acceptance criteria reject malformed or oversized input", () => {
  assert.equal(parseHamTaskActivityMode("production"), "production")
  assert.throws(() => parseHamTaskActivityMode("production "), /invalid/i)
  assert.deepEqual(parseHamTaskAcceptanceCriteria([" one ", "", "two"]), ["one", "two"])
  assert.throws(
    () => parseHamTaskAcceptanceCriteria(Array.from({ length: 51 }, () => "criterion")),
    /allowed size/i,
  )
})

test("external completion versions require exact positive safe integers", async () => {
  const coercionTrap = {
    get [Symbol.toPrimitive]() { throw new Error("external-version-primitive-secret") },
    valueOf() { throw new Error("external-version-valueOf-secret") },
    toString() { throw new Error("external-version-toString-secret") },
  }
  assert.equal(parseHamTaskExpectedVersion(1), 1)
  assert.equal(parseHamTaskExpectedVersion(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)
  for (const malformed of ["1", [1], true, false, coercionTrap, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseHamTaskExpectedVersion(malformed), /positive safe integer/)
  }
  const route = await readFile(
    new URL("../app/api/tasks/[taskId]/external-completion/route.ts", import.meta.url),
    "utf8",
  )
  const handler = await readFile(
    new URL("../lib/ham-task-external-completion-handler.js", import.meta.url),
    "utf8",
  )
  assert.match(route, /createHamTaskExternalCompletionPost/)
  assert.match(handler, /parseHamTaskExpectedVersion\(input\.expectedVersion\)/)
  assert.doesNotMatch(handler, /Number\(input\.expectedVersion\)/)
  const dialog = await readFile(
    new URL("../components/tasks/task-detail-dialog.tsx", import.meta.url),
    "utf8",
  )
  assert.match(dialog, /function hasActionableVersion/)
  assert.match(dialog, /allowMutations && hasActionableVersion\(detail\)/)
  assert.match(dialog, /if \(!hasActionableVersion\(detail\) \|\| reconciling\)/)

  for (const malformed of [undefined, "1", [1], true, false, coercionTrap, 0, -1, 1.5]) {
    const detail = projectHamTaskDetailForBrowser({
      task_id: "task-version-guard",
      status: "pending",
      version: malformed,
    })
    assert.equal(detail?.version, undefined)
    assert.equal("version" in detail, false)
  }
  const currentHamDetail = projectHamTaskDetailForBrowser({
    task_id: "7a0f4d4e-8b8c-4cc1-a9f3-7c89dc427101",
    status: "pending",
    version: 7,
  })
  assert.equal(currentHamDetail?.version, 7)
})

test("external completion POST binds the fetched canonical task to the route target", async () => {
  const routeTaskId = "task-route-target"
  const request = {
    headers: new Headers({ "Idempotency-Key": "route-level-idempotency" }),
    async json() {
      return {
        expectedVersion: 7,
        summary: "Completed outside the tracked run",
        performedByRef: "human:owner",
        references: [],
      }
    },
  }

  function buildPost(fetchedTaskId) {
    const calls = []
    const POST = createHamTaskExternalCompletionPost({
      errorResponse(error) { throw error },
      async fetchHamTask(operation, options) {
        calls.push({ operation, options })
        if (operation === "detail") {
          return {
            task_id: fetchedTaskId,
            version: 7,
            status: "pending",
            requester_ref: "galaxy-brain:user:owner-1",
          }
        }
        if (operation === "externalComplete") {
          return {
            task_id: options.taskId,
            version: 8,
            status: "completed",
            requester_ref: "galaxy-brain:user:owner-1",
          }
        }
        throw new Error(`Unexpected operation: ${operation}`)
      },
      async getCurrentUser() { return { id: "owner-1" } },
      hamTaskMutationsEnabled() { return true },
      json(body, init = {}) { return { body, status: init.status ?? 200 } },
      namespaceHamTaskIdempotencyKey,
      parseHamTaskExpectedVersion,
      projectHamTaskDetailForBrowser,
      randomUUID() { return "unused-random-id" },
    })
    return { POST, calls }
  }

  const mismatch = buildPost("task-different")
  const rejected = await mismatch.POST(request, { params: Promise.resolve({ taskId: routeTaskId }) })
  assert.equal(rejected.status, 409)
  assert.match(rejected.body.error, /different task/)
  assert.deepEqual(mismatch.calls.map((call) => call.operation), ["detail"])
  assert.equal(mismatch.calls.filter((call) => call.operation === "externalComplete").length, 0)

  const match = buildPost(routeTaskId)
  const accepted = await match.POST(request, { params: Promise.resolve({ taskId: routeTaskId }) })
  assert.equal(accepted.status, 200)
  const mutations = match.calls.filter((call) => call.operation === "externalComplete")
  assert.equal(mutations.length, 1)
  assert.equal(mutations[0].options.taskId, routeTaskId)
  assert.deepEqual(match.calls.map((call) => call.operation), ["detail", "externalComplete"])
})

test("task buckets expose acceptance and failure states without fake progress", () => {
  assert.equal(taskBucket("pending"), "available")
  assert.equal(taskBucket("running"), "active")
  assert.equal(taskBucket("needs_clarification"), "needs-attention")
  assert.equal(taskBucket("stalled"), "needs-attention")
  assert.equal(taskBucket("review_required"), "review-done")
  assert.equal(formatTaskFreshness("2026-08-15T12:00:00Z", Date.parse("2026-08-15T12:31:00Z")), "Updated 31 minutes ago")
})

test("lifecycle phases do not conflate request, delivery, claim, run, waiting, review, and terminal state", () => {
  assert.equal(taskLifecyclePhase("pending", "posted"), "requested")
  assert.equal(taskLifecyclePhase("pending", "wake_acknowledged"), "delivered")
  assert.equal(taskLifecyclePhase("claimed", "claimed"), "claimed")
  assert.equal(taskLifecyclePhase("running", "run_started"), "running")
  assert.equal(taskLifecyclePhase("blocked", "blocked"), "waiting")
  assert.equal(taskLifecyclePhase("pending", "review_required"), "review")
  assert.equal(taskLifecyclePhase("completed", "completed"), "terminal")
  assert.equal(taskLifecyclePhase("mystery", "mystery"), "unknown")
})

test("browser metadata accepts exact primitive schema types without coercion", () => {
  const coercionTrap = {
    secret: "coercion-object-secret",
    get [Symbol.toPrimitive]() { throw new Error("primitive-getter-coercion-secret") },
    valueOf() { throw new Error("valueOf-coercion-secret") },
    toString() { throw new Error("toString-coercion-secret") },
  }
  const taskPage = projectHamTaskPageForBrowser({
    cursor: [1],
    next_cursor: true,
    items: [
      { task_id: "task-array-version", title: "Array", version: [9] },
      { task_id: "task-boolean-version", title: "Boolean", version: true },
      { task_id: "task-string-version", title: "String", version: "9" },
      { task_id: "task-object-version", title: "Object", version: coercionTrap },
      { task_id: "task-missing-version", title: "Missing" },
      { task_id: "task-zero-version", title: "Zero", version: 0 },
      { task_id: "task-negative-version", title: "Negative", version: -1 },
      { task_id: "task-fraction-version", title: "Fraction", version: 1.5 },
      { task_id: "task-valid-version", title: "Valid", version: 9 },
    ],
  })
  assert.equal(taskPage.cursor, undefined)
  assert.equal(taskPage.nextCursor, undefined)
  assert.deepEqual(taskPage.tasks.map((task) => task.version), [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 9])
  for (const task of taskPage.tasks.slice(0, -1)) assert.equal("version" in task, false)
  assert.doesNotMatch(JSON.stringify(taskPage), /coercion-object-secret|primitive-getter-coercion-secret|valueOf-coercion-secret|toString-coercion-secret/)

  const eventPage = projectHamTaskEventPageForBrowser({
    cursor: [1],
    next_cursor: true,
    has_more: "false",
    items: [
      { event_id: "event-array-sequence", sequence: [9], event_type: "progress" },
      { event_id: "event-boolean-sequence", sequence: true, event_type: "progress" },
      { event_id: "event-string-sequence", sequence: "9", event_type: "progress" },
      { event_id: coercionTrap, sequence: coercionTrap, event_type: "progress" },
      { event_id: "event-valid-sequence", sequence: 9, event_type: "progress" },
    ],
  })
  assert.equal(eventPage.cursor, undefined)
  assert.equal(eventPage.nextCursor, undefined)
  assert.equal(eventPage.hasMore, false)
  assert.deepEqual(eventPage.events.map((event) => event.sequence), [undefined, undefined, undefined, 9])
  assert.deepEqual(eventPage.events.map((event) => event.id), [
    "event-array-sequence",
    "event-boolean-sequence",
    "event-string-sequence",
    "event-valid-sequence",
  ])
  assert.doesNotMatch(JSON.stringify(eventPage), /coercion-object-secret|primitive-getter-coercion-secret|valueOf-coercion-secret|toString-coercion-secret/)

  for (const malformed of ["false", [false], coercionTrap]) {
    assert.equal(projectHamTaskEventPageForBrowser({ has_more: malformed }).hasMore, false)
  }
  assert.equal(projectHamTaskEventPageForBrowser({ has_more: true }).hasMore, true)
})

test("malformed canonical IDs are dropped without page-local merge keys", () => {
  const firstTaskPage = projectHamTaskPageForBrowser({
    items: [
      { title: "Missing ID", version: 1 },
      { task_id: ["task-array"], title: "Array ID", version: 1 },
      { task_id: true, title: "Boolean ID", version: 1 },
      { task_id: { toString() { throw new Error("task-id-secret") } }, title: "Object ID", version: 1 },
      { task_id: "task-valid-one", title: "First canonical row", version: 1 },
      { task_id: "task-valid-one", title: "Duplicate canonical row", version: 1 },
    ],
  })
  const secondTaskPage = projectHamTaskPageForBrowser({
    items: [
      { task_id: null, title: "Null ID", version: 2 },
      { task_id: "../task-path", title: "Path ID", version: 2 },
      { task_id: "task-valid-two", title: "Second canonical row", version: 2 },
    ],
  })
  assert.deepEqual(firstTaskPage.tasks.map((task) => task.id), ["task-valid-one"])
  assert.equal(firstTaskPage.tasks[0].title, "First canonical row")
  assert.deepEqual(secondTaskPage.tasks.map((task) => task.id), ["task-valid-two"])
  assert.equal(projectHamTaskDetailForBrowser({ title: "Missing detail ID", version: 1 }), undefined)
  assert.equal(projectHamTaskDetailForBrowser({ task_id: ["bad"], version: 1 }), undefined)
  const mergedTasks = mergeTaskPages(firstTaskPage.tasks, secondTaskPage.tasks)
  assert.deepEqual(new Set(mergedTasks.map((task) => task.id)).size, mergedTasks.length)
  assert.deepEqual(mergedTasks.map((task) => task.id).sort(), ["task-valid-one", "task-valid-two"])
  assert.doesNotMatch(JSON.stringify({ firstTaskPage, secondTaskPage, mergedTasks }), /unknown-task|restricted-task|task-id-secret/)

  const firstEventPage = projectHamTaskEventPageForBrowser({
    items: [
      { event_type: "progress", sequence: 90 },
      { event_id: [91], event_type: "progress", sequence: 91 },
      { event_id: false, event_type: "progress", sequence: 92 },
      { event_id: { toString() { throw new Error("event-id-secret") } }, event_type: "progress", sequence: 93 },
      { event_id: 48101, event_type: "progress" },
      { event_id: 48101, event_type: "progress" },
    ],
  })
  const secondEventPage = projectHamTaskEventPageForBrowser({
    items: [
      { event_id: null, event_type: "progress", sequence: 94 },
      { event_id: 48102, event_type: "progress" },
    ],
  })
  const repeatedPoll = projectHamTaskEventPageForBrowser({
    items: [{ event_id: 48101, event_type: "progress" }],
  })
  assert.deepEqual(firstEventPage.events.map((event) => event.id), ["event-48101"])
  assert.deepEqual(secondEventPage.events.map((event) => event.id), ["event-48102"])
  assert.deepEqual(repeatedPoll.events.map((event) => event.id), ["event-48101"])
  const mergedEvents = new Map()
  for (const event of [...firstEventPage.events, ...secondEventPage.events, ...repeatedPoll.events]) {
    if (!mergedEvents.has(event.id)) mergedEvents.set(event.id, event)
  }
  assert.equal(mergedEvents.size, 2)
  assert.deepEqual([...mergedEvents.keys()], ["event-48101", "event-48102"])
  assert.doesNotMatch(JSON.stringify({ firstEventPage, secondEventPage, repeatedPoll }), /event-0|event-id-secret/)
})

test("browser timestamps require canonical calendar-valid RFC3339 values", () => {
  const coercionTrap = {
    secret: "timestamp-object-secret",
    valueOf() { throw new Error("timestamp-valueOf-secret") },
    toString() { throw new Error("timestamp-toString-secret") },
  }
  const valid = [
    "2024-02-29T23:59:59Z",
    "2000-02-29T00:00:00.123456789+00:00",
    "2026-04-30T12:00:00-23:59",
    "2026-08-19 03:21:22.123456+00:00",
    "2026-08-19 03:21:22Z",
  ]
  const invalid = [
    "2026-02-31T12:00:00Z",
    "2026-04-31T12:00:00Z",
    "2025-02-29T12:00:00Z",
    "1900-02-29T12:00:00Z",
    "2026-00-01T12:00:00Z",
    "2026-13-01T12:00:00Z",
    "2026-01-00T12:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T23:60:00Z",
    "2026-01-01T23:59:60Z",
    "2026-01-01T12:00:00+24:00",
    "2026-01-01T12:00:00+00:60",
    "2026-01-01T12:00:00z",
  ]
  const timestamps = [...valid, ...invalid, coercionTrap]
  const page = projectHamTaskEventPageForBrowser({
    items: timestamps.map((occurredAt, index) => ({
      event_id: `timestamp-event-${index}`,
      event_type: "progress",
      occurred_at: occurredAt,
    })),
  })
  assert.deepEqual(page.events.slice(0, valid.length).map((event) => event.occurredAt), valid)
  assert.deepEqual(page.events.slice(valid.length).map((event) => event.occurredAt), Array(invalid.length + 1).fill(undefined))
  assert.doesNotMatch(JSON.stringify(page), /timestamp-object-secret|timestamp-valueOf-secret|timestamp-toString-secret/)
})

test("current HAM task and event wire fixtures retain pagination, time, and identity", () => {
  // Shape copied from current HAM /tasks/page output: task cursors use
  // updated_at.isoformat()|task_id, while response timestamps use str(datetime).
  const taskId = "7a0f4d4e-8b8c-4cc1-a9f3-7c89dc427101"
  const runId = "1a57d8e0-5355-46f0-94aa-b12eed4b81a9"
  const taskCursor = `2026-08-19T03:21:22.123456+00:00|${taskId}`
  const taskPage = projectHamTaskPageForBrowser({
    items: [{
      task_id: taskId,
      project: "galaxy-brain",
      version: 7,
      title: "Review current HAM output",
      goal: "Keep the browser projection wire-compatible",
      rationale: "Exercise the production response shape",
      status: "running",
      requested_by_agent: "service:galaxy.dispatcher",
      claimed_by_agent: "service:codex.reviewer",
      created_at: "2026-08-19 03:20:00.000001+00:00",
      updated_at: "2026-08-19 03:21:22.123456+00:00",
      run: {
        run_id: runId,
        status: "running",
        last_progress_at: "2026-08-19 03:21:20.654321+00:00",
      },
      latest_event: {
        event_type: "progress",
        occurred_at: "2026-08-19 03:21:22.123456+00:00",
      },
    }],
    next_cursor: taskCursor,
  })
  assert.equal(taskPage.nextCursor, taskCursor)
  assert.equal(taskPage.tasks[0].id, taskId)
  assert.equal(taskPage.tasks[0].createdAt, "2026-08-19 03:20:00.000001+00:00")
  assert.equal(taskPage.tasks[0].updatedAt, "2026-08-19 03:21:22.123456+00:00")
  assert.equal(taskPage.tasks[0].activeRun?.heartbeatAt, "2026-08-19 03:21:20.654321+00:00")
  assert.equal(taskPage.tasks[0].owner?.principalId, "service:codex.reviewer")
  assert.equal(taskPage.tasks[0].requestedByAgent, "service:galaxy.dispatcher")

  for (const malformedCursor of [
    `2026-08-19 03:21:22.123456+00:00|${taskId}`,
    `2026-02-31T03:21:22.123456+00:00|${taskId}`,
    `2026-08-19T03:21:22.123456+00:00|../${taskId}`,
    `2026-08-19T03:21:22.123456+00:00|${taskId}|extra`,
    `${"x".repeat(513)}`,
  ]) {
    assert.equal(projectHamTaskPageForBrowser({ next_cursor: malformedCursor }).nextCursor, undefined)
  }

  // HAM event_id is a JSON number backed by bigint. The derived browser key
  // must remain stable across page boundaries and repeated polling.
  const eventFixture = (eventId) => ({
    items: [{
      event_id: eventId,
      event_type: "progress",
      actor_agent_id: "service:codex.reviewer",
      run_id: runId,
      occurred_at: "2026-08-19 03:21:22.123456+00:00",
    }],
    next_cursor: eventId,
    has_more: true,
  })
  const firstPage = projectHamTaskEventPageForBrowser(eventFixture(48101))
  const secondPage = projectHamTaskEventPageForBrowser(eventFixture(48102))
  const repeatedPoll = projectHamTaskEventPageForBrowser(eventFixture(48101))
  assert.equal(firstPage.events[0].id, "event-48101")
  assert.equal(secondPage.events[0].id, "event-48102")
  assert.equal(repeatedPoll.events[0].id, firstPage.events[0].id)
  assert.equal(new Set([firstPage.events[0].id, secondPage.events[0].id]).size, 2)
  assert.equal(firstPage.events[0].sequence, 48101)
  assert.equal(firstPage.nextCursor, 48101)
  assert.equal(firstPage.hasMore, true)
  assert.equal(firstPage.events[0].actorRef, "service:codex.reviewer")
  assert.equal(firstPage.events[0].runId, runId)
  assert.equal(firstPage.events[0].occurredAt, "2026-08-19 03:21:22.123456+00:00")
})

test("browser projection redacts private topology and arbitrary evidence before serialization", () => {
  const rawTask = {
    task_id: "task-private",
    project: "galaxy-brain",
    title: "Run an evaluation",
    goal: "Measure behavior",
    rationale: "Coordinate the run",
    status: "running",
    stage: "credential=task-stage-secret host=task-stage-host path=/task/stage/private",
    run: {
      run_id: "run-safe-4",
      status: "running",
      intent: "credential=run-intent-secret host=run-intent-host path=/run/intent/private",
    },
    resources: [
      { key: "machine:dgx00/private-silo", mode: "exclusive" },
      { key: "path:/srv/example/private-silo", mode: "read" },
      { key: "volume:postgres-production-secret", mode: "write" },
      { key: "arbitrary-prefix:private-resource-name", mode: "read" },
      { key: "repo:MonumentalSystems/ham", mode: "read" },
      { key: "service:ham-runtime", mode: "observe" },
    ],
    conflicts: [
      {
        task_id: "task-other",
        resource_key: "machine:dgx00/private-silo",
        severity: "blocking",
      },
      {
        task_id: "task-path",
        resource_key: "path:/srv/example/private-silo",
        severity: "warning",
        summary: "Path /srv/example/private-silo overlaps",
      },
      {
        task_id: "task-volume",
        resource_key: "volume:postgres-production-secret",
        severity: "blocking",
        summary: "Volume postgres-production-secret overlaps",
      },
      {
        task_id: "task-unknown",
        resource_key: "arbitrary-prefix:private-resource-name",
        severity: "warning",
        summary: "Unknown private-resource-name overlaps",
      },
      {
        task_id: "task-repo",
        resource_key: "repo:MonumentalSystems/ham",
        severity: "warning",
      },
    ],
    latest_event: {
      event_type: "progress",
      summary: "credential=latest-summary-secret host=latest-host path=/latest/private",
      occurred_at: "2026-08-18T12:00:00Z",
    },
    source_refs: [
      "https://github.com/MonumentalSystems/ham/issues/../source-traversal-secret",
      { summary: "task:nested-source-object-secret" },
      "https://private.example/internal/topology",
    ],
  }
  const rawMessageTask = {
    task_id: "task-latest-message",
    project: "galaxy-brain",
    title: "Wait for input",
    goal: "Exercise categorical projection",
    rationale: "Keep raw event messages server-side",
    status: "blocked",
    latest_event: {
      event_type: "blocked",
      message: "credential=latest-message-secret host=latest-message-host path=/latest/message/private",
    },
  }
  const page = projectHamTaskPageForBrowser({ items: [rawTask, rawMessageTask] })
  assert.equal(page.tasks[0].resources[0].resourceRef, "restricted")
  assert.equal(page.tasks[0].resources[0].resourceType, "compute")
  assert.equal(page.tasks[0].resources[0].redacted, true)
  assert.equal(page.tasks[0].resources[1].resourceRef, "restricted")
  assert.equal(page.tasks[0].resources[1].resourceType, "storage or runtime")
  assert.equal(page.tasks[0].resources[2].resourceRef, "restricted")
  assert.equal(page.tasks[0].resources[3].resourceRef, "restricted")
  assert.equal(page.tasks[0].resources[4].resourceRef, "repo:MonumentalSystems/ham")
  assert.equal(page.tasks[0].resources[5].resourceRef, "service:ham-runtime")
  assert.equal(page.tasks[0].conflicts[0].resourceRef, undefined)
  assert.equal(page.tasks[0].conflicts[1].resourceRef, undefined)
  assert.equal(page.tasks[0].conflicts[2].resourceRef, undefined)
  assert.equal(page.tasks[0].conflicts[3].resourceRef, undefined)
  assert.equal(page.tasks[0].conflicts[4].resourceRef, "repo:MonumentalSystems/ham")
  assert.match(page.tasks[0].conflicts[1].summary, /restricted resource/)
  assert.match(page.tasks[0].conflicts[2].summary, /restricted resource/)
  assert.match(page.tasks[0].conflicts[3].summary, /restricted resource/)
  assert.equal(page.tasks[0].stage, "Progress reported")
  assert.equal(page.tasks[0].lastAuthoritativeEvent?.summary, "Progress reported")
  assert.equal(page.tasks[0].activeRun?.stage, "Run in progress")
  assert.equal(page.tasks[1].stage, "Task blocked")
  assert.equal(page.tasks[1].lastAuthoritativeEvent?.summary, "Task blocked")
  assert.doesNotMatch(
    JSON.stringify(page),
    /dgx00|private-silo|\/home\/ms|postgres-production-secret|private-resource-name|Path .* overlaps|Volume .* overlaps|Unknown .* overlaps|latest-summary-secret|latest-host|\/latest\/private|latest-message-secret|latest-message-host|\/latest\/message\/private|task-stage-secret|task-stage-host|\/task\/stage\/private|run-intent-secret|run-intent-host|\/run\/intent\/private/,
  )

  const detail = projectHamTaskDetailForBrowser(rawTask)
  assert.deepEqual(detail.sourceRefs, [])
  assert.doesNotMatch(JSON.stringify(detail), /source-traversal-secret|nested-source-object-secret|private\.example/)

  const events = projectHamTaskEventPageForBrowser({
    items: [
      {
        event_id: 4,
        event_type: "progress",
        summary: "credential=top-summary-secret host=top-host-secret path=/top/private",
        actor_agent_id: "../actor-ref-secret",
        run_id: "run:/run-id-secret",
        evidence: {
          references: [
            "run:run-4",
            "run:../run-traversal-secret",
            "https://github.com/owner/repo/issues/../evidence-traversal-secret",
            "https://github.com/../repo/issues/1",
            { summary: "task:nested-object-secret" },
            ["task:nested-array-secret"],
          ],
          credential: "must-never-reach-browser",
          execution_context: { host: "dgx00" },
        },
      },
      {
        event_id: 5,
        event_type: "progress",
        message: "credential=top-message-secret host=message-host-secret path=/message/private",
        actor_agent_id: "agent-safe-5",
        run_id: "run-safe-5",
        evidence: {
          summary: "credential=evidence-secret host=evidence-host path=/evidence/private",
          message: "evidence-message-secret",
          nested: {
            credential: "nested-evidence-secret",
            host: "nested-host",
            path: "/nested/evidence/private",
          },
        },
      },
      {
        event_id: 6,
        event_type: "progress",
        data: {
          message: "data-message-secret path=/data/private",
          nested: {
            credential: "nested-data-secret",
            host: "data-host",
            path: "/nested/data/private",
          },
        },
      },
      {
        event_id: 7,
        event_type: "event-type-secret",
        occurred_at: "timestamp-secret",
        evidence_refs: ["task:top-level-evidence-secret"],
        payload: "payload-secret host=payload-host path=/payload/private",
      },
    ],
  })
  assert.deepEqual(events.events.map((event) => event.evidenceRefs), [[], [], [], []])
  assert.deepEqual(events.events.map((event) => event.summary), [
    "Progress reported", "Progress reported", "Progress reported", "Task event",
  ])
  assert.equal(events.events[3].type, "event")
  assert.equal(events.events[3].occurredAt, undefined)
  assert.equal(events.events[0].actorRef, undefined)
  assert.equal(events.events[0].runId, undefined)
  assert.equal(events.events[1].actorRef, "agent-safe-5")
  assert.equal(events.events[1].runId, "run-safe-5")
  assert.doesNotMatch(
    JSON.stringify(events),
    /top-summary-secret|top-host-secret|\/top\/private|actor-ref-secret|run-id-secret|top-message-secret|message-host-secret|\/message\/private|must-never-reach-browser|execution_context|dgx00|evidence-secret|evidence-host|evidence-message-secret|nested-evidence-secret|nested-host|data-message-secret|nested-data-secret|data-host|payload-secret|payload-host|run-traversal-secret|evidence-traversal-secret|nested-object-secret|nested-array-secret|event-type-secret|timestamp-secret|top-level-evidence-secret|\/evidence\/private|\/data\/private|\/payload\/private|\/nested\/evidence\/private|\/nested\/data\/private/,
  )
})

test("repository disclosure accepts only unambiguous owner and repository components", () => {
  const validRefs = [
    "repo:MonumentalSystems/ham",
    "repo:openai/openai-python",
    "repo:owner/.github",
    "repo:owner/repo_name",
  ]
  const invalidRefs = [
    "repo:../secret",
    "repo:./secret",
    "repo:owner/..",
    "repo:owner/.",
    "repo:/repo",
    "repo:owner/",
    "repo:owner//repo",
    "repo:owner/repo/extra",
    "repo:owner\\repo",
    "repo:owner%2Frepo",
    "repo:%2e%2e/secret",
    "repo:owner/%2e%2e",
    "repo:owner/repo?query",
    "repo:owner/repo#fragment",
    "repo:owner:repo",
    "repo:owner/repo%00",
    "repo:-owner/repo",
    "repo:owner-/repo",
    "repo:owner--name/repo",
    "repo:owner/repo ",
    "repo:owner／repo",
    "repo:owner∕repo",
  ]
  const makeTask = (resourceRef, index) => ({
    task_id: `task-repo-${index}`,
    project: "galaxy-brain",
    title: "Inspect a repository",
    goal: "Verify browser disclosure",
    status: "running",
    resources: [{ key: resourceRef, mode: "read" }],
    conflicts: [{
      task_id: `task-related-${index}`,
      resource_key: resourceRef,
      severity: "warning",
      summary: `Raw conflict on ${resourceRef}`,
    }],
  })
  const page = projectHamTaskPageForBrowser({
    items: [...validRefs, ...invalidRefs].map(makeTask),
  })

  for (const [index, resourceRef] of validRefs.entries()) {
    const task = page.tasks[index]
    assert.equal(task.resources[0].resourceRef, resourceRef)
    assert.equal(task.resources[0].redacted, false)
    assert.equal(task.conflicts[0].resourceRef, resourceRef)
    assert.match(task.conflicts[0].summary, new RegExp(`${resourceRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.$`))
  }

  for (const [offset, resourceRef] of invalidRefs.entries()) {
    const task = page.tasks[validRefs.length + offset]
    assert.equal(task.resources[0].resourceRef, "restricted")
    assert.equal(task.resources[0].redacted, true)
    assert.equal(task.conflicts[0].resourceRef, undefined)
    assert.equal(task.conflicts[0].summary, "A restricted resource overlaps with this task.")
    assert.equal(JSON.stringify(task).includes(resourceRef), false)
  }
})

test("resource disclosure requires an exact canonical raw class prefix", () => {
  const malformedPrefixes = [
    " repo",
    "repo ",
    "repo\t",
    "repo\n",
    "repo\r",
    "repo\0",
    "\trepo",
    "\nrepo",
    "\rrepo",
    "\0repo",
    "repo\u0001",
    "repo\u007f",
    "\u00a0repo",
    "repo\u00a0",
    "\u2003repo",
    "repo\u2003",
    "\u200brepo",
    "repo\u200b",
    "repo\u2028",
    "repo\u2029",
    "REPO",
    "Repo",
  ]
  const rawTasks = malformedPrefixes.map((prefix, index) => {
    const marker = `prefix-private-secret-${index}`
    const resourceRef = `${prefix}:owner/${marker}`
    return {
      task_id: `task-prefix-${index}`,
      project: "galaxy-brain",
      title: "Inspect a resource class",
      goal: "Verify exact prefix matching",
      status: "running",
      resources: [{ key: resourceRef, mode: "read" }],
      conflicts: [{
        task_id: `task-prefix-related-${index}`,
        resource_key: resourceRef,
        severity: "warning",
        summary: `Raw conflict on ${resourceRef}`,
      }],
    }
  })
  const page = projectHamTaskPageForBrowser({ items: rawTasks })

  for (const [index, task] of page.tasks.entries()) {
    assert.equal(task.resources[0].resourceRef, "restricted")
    assert.equal(task.resources[0].resourceClass, "restricted")
    assert.equal(task.resources[0].redacted, true)
    assert.equal(task.conflicts[0].resourceRef, undefined)
    assert.equal(task.conflicts[0].summary, "A restricted resource overlaps with this task.")
    assert.equal(JSON.stringify(task).includes(`prefix-private-secret-${index}`), false)
  }
})

test("only overlapping active write-like resources produce local warnings", () => {
  const base = {
    projectRef: "galaxy-brain", version: 1, goal: "g", why: "w", state: "running",
    stage: "working", riskMode: "diagnostic", expectedEffects: [], conflicts: [],
    createdAt: "2026-08-15T12:00:00Z", updatedAt: "2026-08-15T12:01:00Z",
  }
  const conflicts = findLocalResourceConflicts([
    { ...base, id: "one", title: "One", resources: [{ id: "r1", resourceRef: "repo:x", mode: "read", status: "active" }] },
    { ...base, id: "two", title: "Two", resources: [{ id: "r2", resourceRef: "repo:x", mode: "write", status: "active" }] },
  ])
  assert.match(conflicts.get("one")[0], /Two/)
  assert.match(conflicts.get("two")[0], /One/)

  const redacted = findLocalResourceConflicts([
    { ...base, id: "redacted-one", title: "Hidden one", resources: [{ id: "r3", resourceRef: "restricted", mode: "exclusive", status: "active", redacted: true }] },
    { ...base, id: "redacted-two", title: "Hidden two", resources: [{ id: "r4", resourceRef: "restricted", mode: "exclusive", status: "active", redacted: true }] },
  ])
  assert.equal(redacted.size, 0)
})

test("all task proxy routes enforce a signed-in Galaxy Brain user", async () => {
  const routeFiles = [
    "../app/api/tasks/route.ts",
    "../app/api/tasks/[taskId]/route.ts",
    "../app/api/tasks/[taskId]/events/route.ts",
    "../app/api/tasks/[taskId]/external-completion/route.ts",
  ]
  const externalCompletionHandler = await readFile(
    new URL("../lib/ham-task-external-completion-handler.js", import.meta.url),
    "utf8",
  )
  for (const path of routeFiles) {
    const route = await readFile(new URL(path, import.meta.url), "utf8")
    const source = path.includes("external-completion")
      ? `${route}\n${externalCompletionHandler}`
      : route
    assert.match(source, /getCurrentUser\(\)/)
    assert.match(source, /if \(!user\).*Unauthorized.*401/)
    assert.doesNotMatch(source, /error\.body/)
  }
})

test("deployment docs separate transport credentials from project roles and execution authority", async () => {
  const env = await readFile(new URL("../.env.example", import.meta.url), "utf8")
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8")
  const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8")
  const proxy = await readFile(new URL("../lib/ham-task-proxy.ts", import.meta.url), "utf8")
  const proxyConfig = await readFile(new URL("../lib/ham-task-proxy-config.js", import.meta.url), "utf8")
  assert.match(env, /HAM_TASK_READ_BEARER_TOKEN=/)
  assert.match(env, /HAM_TASK_MUTATIONS=disabled/)
  assert.match(env, /HAM_TASK_WRITE_BEARER_TOKEN=/)
  assert.match(env, /HAM_TASK_GALAXY_TENANT_ID=/)
  assert.match(readme, /projects label related topics; they do not grant observer,/)
  assert.match(readme, /Hyades alone/)
  assert.match(readme, /GitHub independently/)
  assert.match(env, /Project membership is organizational only/)
  assert.doesNotMatch(env, /task_access=/)
  assert.match(compose, /HAM_TASK_READ_BEARER_TOKEN/)
  assert.match(compose, /GALAXY_DEPLOY_HAM_TASK_READ_BEARER_TOKEN:-\$\{HAM_TASK_READ_BEARER_TOKEN:-\}/)
  assert.match(compose, /HAM_TASK_WRITE_BEARER_TOKEN/)
  assert.match(compose, /HAM_TASK_GALAXY_TENANT_ID/)
  assert.match(proxy, /evaluateHamTaskTenantAccess/)
  assert.match(proxy, /operation === "page" \|\| operation === "detail" \|\| operation === "events"/)
  assert.match(proxyConfig, /HAM_TASK_READ_BEARER_TOKEN/)
  assert.match(proxyConfig, /HAM_TASK_WRITE_BEARER_TOKEN/)
  assert.doesNotMatch(proxy, /HAM_API_INTERNAL/)
  assert.doesNotMatch(proxyConfig, /HAM_API_INTERNAL/)
  assert.doesNotMatch(proxy, /HAM_TASK_API_INTERNAL\s*\|\|/)
  assert.doesNotMatch(proxy, /HAM_ADMIN_API_BEARER_TOKEN|HAM_TASK_API_BEARER_TOKEN/)
})

test("queue controls and task details retain semantic and assistive state", async () => {
  const queue = await readFile(new URL("../components/tasks/task-queue-view.tsx", import.meta.url), "utf8")
  const form = await readFile(new URL("../components/tasks/task-create-form.tsx", import.meta.url), "utf8")
  const detail = await readFile(new URL("../components/tasks/task-detail-dialog.tsx", import.meta.url), "utf8")
  const proxy = await readFile(new URL("../lib/ham-task-proxy.ts", import.meta.url), "utf8")
  const pageRoute = await readFile(new URL("../app/api/tasks/route.ts", import.meta.url), "utf8")
  const detailRoute = await readFile(new URL("../app/api/tasks/[taskId]/route.ts", import.meta.url), "utf8")
  const eventRoute = await readFile(new URL("../app/api/tasks/[taskId]/events/route.ts", import.meta.url), "utf8")
  assert.match(queue, /role="status"/)
  assert.match(queue, /role="alert"/)
  assert.match(queue, /<ul/)
  assert.match(form, /<Label htmlFor=/)
  assert.match(form, /role="alert"/)
  assert.match(form, /idempotencyKeyRef\.current \|\| crypto\.randomUUID\(\)/)
  assert.match(form, /idempotencyKeyRef\.current = idempotencyKey/)
  assert.match(form, /function updateDraft/)
  assert.match(form, /task-acceptance/)
  assert.match(form, /Resource intent \(not permission\)/)
  assert.match(form, /disabled=\{!hasResourceKeys\}/)
  assert.match(detail, /onCloseAutoFocus=/)
  assert.match(detail, /<ol/)
  assert.match(detail, /fetchAllTaskEvents/)
  assert.match(detail, /Record external completion/)
  assert.match(queue, /allowMutations \? <TaskCreateForm/)
  assert.match(queue, /Read-only projection/)
  assert.match(detail, /allowMutations && hasActionableVersion\(detail\)/)
  assert.match(proxy, /parseHamTaskActivityMode/)
  assert.match(proxy, /HAM task mutations are disabled by Galaxy Brain policy/)
  assert.match(pageRoute, /projectHamTaskPageForBrowser/)
  assert.match(detailRoute, /projectHamTaskDetailForBrowser/)
  assert.match(eventRoute, /projectHamTaskEventPageForBrowser/)
  assert.doesNotMatch(`${queue}\n${detail}`, /progress.*%/i)
})
