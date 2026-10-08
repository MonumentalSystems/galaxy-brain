import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  cancelTaskPlanRun,
  createTaskPlanRunRequest,
  isTaskPlanRunTerminal,
  refreshTaskPlanRun,
  startTaskPlanRun,
  taskPlanRunStartBlocker,
  TaskPlanRunClientError,
} from "../lib/task-plan-run-client.js"

const hash = (character) => character.repeat(64)

function task(overrides = {}) {
  return {
    id: "task-1",
    version: 7,
    state: "pending",
    ...overrides,
  }
}

function plan(overrides = {}) {
  return {
    id: "plan-1",
    ham_task_id: "task-1",
    current_version: 3,
    current_content_hash: hash("a"),
    current_spec: {
      schema: "gb.task-plan.v1",
      task: { kind: "galaxy.ham.task", id: "task-1", version: 7 },
      goal: "Check the exact saved plan",
      nodes: [],
      edges: [],
    },
    ...overrides,
  }
}

function receipt(overrides = {}) {
  return {
    taskId: "task-1",
    runId: "run-1",
    taskPlanId: "plan-1",
    taskPlanVersion: 3,
    taskPlanSpecSha256: hash("b"),
    state: "accepted",
    replayed: false,
    taskPlanContentSha256: hash("a"),
    expectedTaskVersion: 7,
    ...overrides,
  }
}

function snapshot(overrides = {}) {
  return {
    runId: "run-1",
    taskId: "task-1",
    taskPlanId: "plan-1",
    taskPlanVersion: 3,
    taskPlanContentSha256: hash("a"),
    taskPlanSpecSha256: hash("b"),
    expectedTaskVersion: 7,
    phase: "started",
    blockReason: null,
    blockedSince: null,
    lastHeartbeatAt: "2026-09-26T12:00:00Z",
    createdAt: "2026-09-26T11:59:00Z",
    completedAt: null,
    ...overrides,
  }
}

test("run request binds only the exact saved task and plan revisions", () => {
  const request = createTaskPlanRunRequest(task(), plan(), "dispatch-key-1")
  assert.equal(request.path, "/api/tasks/task-1/runs")
  assert.deepEqual(JSON.parse(request.body), {
    taskPlanId: "plan-1",
    expectedPlanVersion: 3,
    expectedContentHash: hash("a"),
    expectedTaskVersion: 7,
  })

  assert.throws(() => createTaskPlanRunRequest(task({ state: "running" }), plan(), "dispatch-key-1"), /Save and reload/)
  assert.throws(() => createTaskPlanRunRequest(task({ activeRun: { id: "run-old", status: "running" } }), plan(), "dispatch-key-1"), /Save and reload/)
  assert.throws(() => createTaskPlanRunRequest(task(), plan({
    current_spec: { ...plan().current_spec, task: { kind: "galaxy.ham.task", id: "task-1", version: 6 } },
  }), "dispatch-key-1"), /Save and reload/)
})

test("start blocker distinguishes browser state from the saved execution baseline", () => {
  const baseline = { task: task(), taskPlan: plan() }
  assert.equal(taskPlanRunStartBlocker(baseline), "")
  assert.match(taskPlanRunStartBlocker({ ...baseline, dirty: true }), /every browser edit/)
  assert.match(taskPlanRunStartBlocker({ ...baseline, candidatePending: true }), /pending task-plan candidate/)
  assert.match(taskPlanRunStartBlocker({ ...baseline, runPresent: true }), /already has a run/)
  assert.match(taskPlanRunStartBlocker({ ...baseline, mode: "preview" }), /Detached previews/)
})

test("start sends the stable client identity and accepts wake without calling it running", async () => {
  let observed
  const result = await startTaskPlanRun(task(), plan(), {
    idempotencyKey: "dispatch-key-1",
    fetcher: async (path, init) => {
      observed = { path, init }
      return new Response(JSON.stringify(receipt({ state: "wake-requested" })), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    },
  })
  assert.equal(observed.path, "/api/tasks/task-1/runs")
  assert.equal(observed.init.headers["Idempotency-Key"], "dispatch-key-1")
  assert.equal(result.state, "wake-requested")
  assert.equal(isTaskPlanRunTerminal(result.state), false)
})

test("refresh and cancel remain bound to the exact task and run", async () => {
  const calls = []
  const fetcher = async (path, init) => {
    calls.push({ path, init })
    const value = path.endsWith("/cancel")
      ? snapshot({ phase: "started" })
      : snapshot({ phase: "blocked", blockReason: "waiting_capacity", blockedSince: "2026-09-26T12:01:00Z" })
    return new Response(JSON.stringify(value), { status: 200 })
  }
  const refreshed = await refreshTaskPlanRun("task-1", "run-1", { fetcher })
  const cancelled = await cancelTaskPlanRun("task-1", "run-1", { fetcher })
  assert.equal(refreshed.phase, "blocked")
  assert.equal(cancelled.phase, "started", "cancellation must preserve the phase returned by Hyades")
  assert.deepEqual(calls.map(({ path, init }) => [path, init.method, init.body]), [
    ["/api/tasks/task-1/runs/run-1", "GET", undefined],
    ["/api/tasks/task-1/runs/run-1/cancel", "POST", undefined],
  ])

  await assert.rejects(
    refreshTaskPlanRun("task-1", "run-1", {
      fetcher: async () => new Response(JSON.stringify(snapshot({ runId: "run-2" })), { status: 200 }),
    }),
    /different run snapshot/,
  )
})

test("client errors never expose raw upstream details", async () => {
  await assert.rejects(
    startTaskPlanRun(task(), plan(), {
      idempotencyKey: "dispatch-key-1",
      fetcher: async () => new Response(JSON.stringify({ error: "postgres host and secret detail" }), { status: 502 }),
    }),
    (error) => {
      assert.equal(error instanceof TaskPlanRunClientError, true)
      assert.equal(error.message.includes("postgres"), false)
      assert.match(error.message, /could not start/)
      return true
    },
  )
})

test("Task Constructor controls preserve retry identity and honest manual lifecycle", async () => {
  const controls = await readFile(new URL("../components/tasks/task-plan-run-controls.tsx", import.meta.url), "utf8")
  const constructor = await readFile(new URL("../components/tasks/task-constructor.tsx", import.meta.url), "utf8")
  const dialog = await readFile(new URL("../components/tasks/task-constructor-dialog.tsx", import.meta.url), "utf8")

  assert.match(controls, /clearIdempotencyKey\(idempotency\.storageKey\)/)
  assert.match(controls, /if \(operationRef\.current\.controller\) return null/)
  assert.match(controls, /operationOwnsSlot\(operation\)/)
  assert.match(controls, /retry-storage-unavailable/)
  assert.match(controls, /No run request was sent because safe retry storage is unavailable/)
  assert.match(controls, /taskPlanContentSha256/)
  assert.match(controls, /stable key remains in session storage after any ambiguous response/)
  assert.match(controls, /Unsaved browser edits and pending proposals are not included/)
  assert.match(controls, /Execution has not been observed|Execution has not yet been observed/)
  assert.match(controls, /nextSnapshot\.phase === "cancelled"/)
  assert.match(controls, /last visible run snapshot was preserved/i)
  assert.doesNotMatch(controls, /setInterval|setTimeout/)
  assert.match(controls, /type TaskRunTone = "core" \| "warning" \| "danger" \| "muted"/)
  assert.match(controls, /task-constructor__notice/)
  assert.match(controls, /data-tone=\{phaseCopy\?\.tone === "muted" \? undefined : phaseCopy\?\.tone\}/)
  assert.equal(controls.match(/className="task-constructor-dialog"/g)?.length, 2)
  assert.doesNotMatch(controls, /#[0-9a-f]{3,8}|rgba?\(/iu)
  assert.match(constructor, /dirty=\{dirty \|\| connectionDraftDirty\}/)
  assert.match(constructor, /candidatePending=\{visibleProposal !== null\}/)
  assert.match(constructor, /onMutationStateChange=\{setRunMutating\}/)
  assert.match(dialog, /interactionState\.runMutating/)
})
