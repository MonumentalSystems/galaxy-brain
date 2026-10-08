import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  createTaskPlanProposalRequest,
  MAX_TASK_PLAN_PROPOSAL_RESPONSE_BYTES,
  requestTaskPlanProposal,
  TASK_PLAN_PROPOSAL_TOOL_PATH,
  TaskPlanProposalClientError,
} from "../lib/task-plan-proposal-client.js"

const PLAN_ID = "30000000-0000-4000-8000-000000000001"

function record(overrides = {}) {
  return {
    id: PLAN_ID,
    tenant_id: "10000000-0000-4000-8000-000000000001",
    ham_task_id: "task-42",
    created_by_principal_id: "20000000-0000-4000-8000-000000000001",
    title: "Plan",
    schema_version: "gb.task-plan.v1",
    current_version: 4,
    current_content_hash: "b".repeat(64),
    current_spec: {
      schema: "gb.task-plan.v1",
      task: { kind: "galaxy.ham.task", id: "task-42", version: 3 },
      goal: "Study the evidence.",
      nodes: [],
      edges: [],
    },
    provenance: {}, created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z",
    ...overrides,
  }
}

function intent(overrides = {}) {
  return {
    action: "challenge",
    sourceJobIds: ["research"],
    title: "Challenge",
    goal: "Seek counterevidence.",
    instruction: null,
    inputRefs: [],
    branches: [],
    ...overrides,
  }
}

function proposal() {
  return {
    schemaId: "gb.task-plan-proposal.v1",
    requestHash: "a".repeat(64),
    scope: "task-local-work",
    effect: "proposal",
    action: "challenge",
    base: {
      taskPlanId: PLAN_ID, taskPlanVersion: 4, taskPlanContentHash: "b".repeat(64),
      hamTaskId: "task-42", hamTaskVersion: 3,
    },
    sourceJobIds: ["research"], inputRefs: [], operations: [],
    summary: "Candidate", proposalHash: `sha256:${"c".repeat(64)}`,
  }
}

function resultResponse(value = proposal()) {
  return new Response(JSON.stringify({
    schemaId: "gb.agent-tool-result.v1",
    tool: "task.plan.propose",
    result: { proposal: value },
  }), { status: 200, headers: { "Content-Type": "application/json" } })
}

test("proposal requests derive every authority field from the loaded saved record", () => {
  const created = createTaskPlanProposalRequest(record(), intent({
    taskPlanId: "attacker", expectedVersion: 99, expectedContentHash: "f".repeat(64),
    expectedHamTaskId: "other", expectedHamTaskVersion: 99,
  }))
  const parsed = JSON.parse(created.body)
  assert.equal(parsed.schemaId, "gb.agent-tool-call.v1")
  assert.equal(parsed.tool, "task.plan.propose")
  assert.deepEqual({
    taskPlanId: parsed.input.taskPlanId,
    expectedVersion: parsed.input.expectedVersion,
    expectedContentHash: parsed.input.expectedContentHash,
    expectedHamTaskId: parsed.input.expectedHamTaskId,
    expectedHamTaskVersion: parsed.input.expectedHamTaskVersion,
  }, {
    taskPlanId: PLAN_ID,
    expectedVersion: 4,
    expectedContentHash: "b".repeat(64),
    expectedHamTaskId: "task-42",
    expectedHamTaskVersion: 3,
  })
  assert.equal(Object.hasOwn(parsed.input, "taskPlanId"), true)
  assert.throws(() => createTaskPlanProposalRequest(
    record({ current_spec: { ...record().current_spec, task: { kind: "galaxy.ham.task", id: "other", version: 3 } } }),
    intent(),
  ), (error) => error instanceof TaskPlanProposalClientError && error.code === "invalid-baseline")
})

test("proposal client uses only the exact agent-tool target and bounded envelope", async () => {
  const calls = []
  const output = await requestTaskPlanProposal(record(), intent(), {
    fetcher: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) })
      return resultResponse()
    },
  })
  assert.equal(output.effect, "proposal")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, TASK_PLAN_PROPOSAL_TOOL_PATH)
  assert.equal(calls[0].init.method, "POST")
  assert.equal(calls[0].init.headers["Content-Type"], "application/json")
  assert.equal(calls[0].init.cache, "no-store")
  assert.equal(calls[0].body.tool, "task.plan.propose")
  assert.doesNotMatch(calls[0].url, /\/api\/(?:tasks|eln)\//u)
})

test("proposal client rejects oversized requests before fetch", async () => {
  let fetched = false
  await assert.rejects(() => requestTaskPlanProposal(record(), intent({ instruction: "x".repeat(70_000) }), {
    fetcher: async () => { fetched = true; return resultResponse() },
  }), (error) => error instanceof TaskPlanProposalClientError && error.code === "request-too-large")
  assert.equal(fetched, false)
})

test("proposal client stream-caps and cancels oversized responses", async () => {
  let cancelled = false
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_TASK_PLAN_PROPOSAL_RESPONSE_BYTES + 1))
    },
    cancel() { cancelled = true },
  })
  await assert.rejects(() => requestTaskPlanProposal(record(), intent(), {
    fetcher: async () => new Response(body, { status: 200 }),
  }), (error) => error instanceof TaskPlanProposalClientError && error.code === "response-too-large")
  assert.equal(cancelled, true)
})

test("proposal client rejects malformed and wrong-tool results before returning candidate content", async () => {
  for (const value of [
    { schemaId: "gb.agent-tool-result.v1", tool: "task.plan.get", result: { proposal: proposal() } },
    { schemaId: "gb.agent-tool-result.v1", tool: "task.plan.propose", result: { proposal: proposal(), secret: true } },
    { schemaId: "gb.agent-tool-result.v1", tool: "task.plan.propose", result: { proposal: null } },
    { schemaId: "gb.agent-tool-result.v1", tool: "task.plan.propose", result: { proposal: { effect: "proposal" } } },
  ]) {
    await assert.rejects(() => requestTaskPlanProposal(record(), intent(), {
      fetcher: async () => new Response(JSON.stringify(value), { status: 200 }),
    }), (error) => error instanceof TaskPlanProposalClientError && error.code === "invalid-response")
  }
})

test("plugin mismatch and provider failures stay normalized without raw details", async () => {
  await assert.rejects(() => requestTaskPlanProposal(record(), intent(), {
    fetcher: async () => new Response(JSON.stringify({
      schemaId: "gb.agent-tool-error.v1",
      error: { code: "unknown_tool", message: "backend secret plugin path" },
    }), { status: 404 }),
  }), (error) => {
    assert.equal(error.code, "unknown_tool")
    assert.equal(error.status, 404)
    assert.doesNotMatch(error.message, /secret|plugin path/u)
    return true
  })
})

test("aborted proposal requests do not become client failures", async () => {
  const controller = new AbortController()
  const operation = requestTaskPlanProposal(record(), intent(), {
    signal: controller.signal,
    fetcher: async (_url, init) => await new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
    }),
  })
  controller.abort()
  await assert.rejects(operation, (error) => error.name === "AbortError")
})

test("human producer is gateway-only, latest-request guarded, and has no HAM or execution seam", async () => {
  const producer = await readFile(new URL("../components/tasks/task-plan-proposal-producer.tsx", import.meta.url), "utf8")
  const review = await readFile(new URL("../components/tasks/task-plan-proposal-preview.tsx", import.meta.url), "utf8")
  const constructor = await readFile(new URL("../components/tasks/task-constructor.tsx", import.meta.url), "utf8")
  const proxy = await readFile(new URL("../app/api/eln/[...path]/route.ts", import.meta.url), "utf8")
  const provider = await readFile(new URL("../services/galaxy-brain-api/server.py", import.meta.url), "utf8")
  assert.match(producer, /requestTaskPlanProposal\(submittedRecord, intent, \{ signal: controller\.signal \}\)/u)
  assert.match(producer, /requestRef\.current !== request \|\| baselineKeyRef\.current !== submittedBaseline/u)
  assert.match(producer, /This does not save a revision, mutate HAM, claim work, or start a run/u)
  assert.doesNotMatch(producer, /galaxyBrainAPI|createTask|fetchHamTask|\/api\/tasks|startRun|dispatch/u)
  assert.match(producer, /task-constructor__panel/u)
  assert.match(review, /task-constructor__candidate/u)
  assert.match(review, /role="status" aria-live="polite" aria-atomic="true"/u)
  assert.doesNotMatch(`${producer}\n${review}`, /#[0-9a-f]{3,8}|rgba?\(/iu)
  assert.match(constructor, /record=\{record\}/u)
  assert.match(constructor, /onProposal=\{setGeneratedProposal\}/u)
  assert.match(constructor, /previewTaskPlanProposal\(baseline, candidate\)/u)
  assert.equal(constructor.match(/galaxyBrainAPI\.(?:createTaskPlan|updateTaskPlan)/gu)?.length, 2)
  assert.match(proxy, /path\[0\] === "task-plans"[\s\S]*path\[2\] === "revisions"[\s\S]*Invalid task plan operation/u)
  assert.match(provider, /def propose_task_plan_structure\([\s\S]*X-GB-Agent-Tool-Gateway[\s\S]*"v1"/u)
})
