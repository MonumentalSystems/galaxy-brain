import assert from "node:assert/strict"
import test from "node:test"

import {
  AUTHORIZED_TASK_PLAN_GRAPH_SOURCE_SCHEMA_ID,
  buildAuthorizedTaskPlanGraphSource,
} from "../lib/authorized-task-plan-graph-source.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import { createGalaxyObjectProjection } from "../lib/object-projection.js"
import { projectUnifiedGraph } from "../lib/unified-graph.js"

const scope = Object.freeze({
  tenantId: "123e4567-e89b-42d3-a456-426614174001",
  workspaceId: "tenant-catalog",
})
const planId = "123e4567-e89b-42d3-a456-426614174000"
const hash = "a".repeat(64)

function record(overrides = {}) {
  return {
    id: planId,
    tenant_id: scope.tenantId,
    ham_task_id: "task-1",
    created_by_principal_id: "123e4567-e89b-42d3-a456-426614174002",
    title: "Investigate the mechanism",
    schema_version: "gb.task-plan.v1",
    current_version: 3,
    current_content_hash: hash,
    current_spec: {
      schema: "gb.task-plan.v1",
      task: { kind: "galaxy.ham.task", id: "task-1", version: 7 },
      goal: "Compare the evidence, branch the challenge, then join the findings.",
      nodes: [
        { id: "research", kind: "research", title: "Research", goal: "Collect evidence.", position: { x: 0, y: 0 }, config: {} },
        { id: "challenge", kind: "challenge", title: "Challenge", goal: "Test the premise.", position: { x: 200, y: -80 }, config: {} },
        { id: "join", kind: "join", title: "Join", goal: "Reconcile the findings.", position: { x: 400, y: 0 }, config: {} },
      ],
      edges: [
        { id: "branch-edge", source: "research", target: "challenge", kind: "branch" },
        { id: "evidence-edge", source: "challenge", target: "join", kind: "evidence" },
        { id: "join-edge", source: "research", target: "join", kind: "join" },
      ],
    },
    provenance: {},
    created_at: "2026-09-25T00:00:00Z",
    updated_at: "2026-09-25T00:00:00Z",
    ...overrides,
  }
}

function input(overrides = {}) {
  return {
    schemaId: AUTHORIZED_TASK_PLAN_GRAPH_SOURCE_SCHEMA_ID,
    scope,
    query: { mode: "task", scale: "task", lens: "explore" },
    providerStatus: "ready",
    plans: [{ authorized: true, scope, record: record() }],
    sourceLimit: 32,
    priorityRefs: [],
    ...overrides,
  }
}

function refs() {
  const revision = `sha256:${hash}`
  return {
    task: createGalaxyObjectReference("ham.task", "task-1"),
    plan: createGalaxyObjectReference("task-plan", planId, { mode: "pinned", revision }),
    research: createGalaxyObjectReference("task-plan.job", `${planId}/research`, { mode: "pinned", revision }),
    challenge: createGalaxyObjectReference("task-plan.job", `${planId}/challenge`, { mode: "pinned", revision }),
    join: createGalaxyObjectReference("task-plan.job", `${planId}/join`, { mode: "pinned", revision }),
  }
}

test("projects one immutable saved plan into task, plan, job, branch, dependency, and join structure", () => {
  const expected = refs()
  const result = buildAuthorizedTaskPlanGraphSource(input())

  assert.equal(result.schemaId, "gb.authorized-task-plan-graph-source-result.v1")
  assert.deepEqual(result.graphInput.objects.map(({ projection }) => projection.ref), [
    expected.plan,
    expected.research,
    expected.challenge,
    expected.join,
  ])
  assert.deepEqual(result.graphInput.objects.map(({ projection }) => projection.revision), [
    { policy: "pinned", id: `sha256:${hash}`, contentHash: hash },
    { policy: "pinned", id: `sha256:${hash}`, contentHash: hash },
    { policy: "pinned", id: `sha256:${hash}`, contentHash: hash },
    { policy: "pinned", id: `sha256:${hash}`, contentHash: hash },
  ])
  assert.deepEqual(result.graphInput.relations.map(({ relation }) => ({
    from: relation.fromRef,
    to: relation.toRef,
    relation: relation.relation,
    recordId: relation.source.recordId,
    mode: relation.source.resourceMode,
  })), [
    { from: expected.task, to: expected.plan, relation: "contains", recordId: `task-plan:${planId}`, mode: "task-plan" },
    { from: expected.plan, to: expected.research, relation: "contains", recordId: "job:research", mode: "research" },
    { from: expected.plan, to: expected.challenge, relation: "contains", recordId: "job:challenge", mode: "challenge" },
    { from: expected.plan, to: expected.join, relation: "contains", recordId: "job:join", mode: "join" },
    { from: expected.research, to: expected.challenge, relation: "forks", recordId: "branch-edge", mode: "branch" },
    { from: expected.join, to: expected.challenge, relation: "depends_on", recordId: "evidence-edge", mode: "evidence" },
    { from: expected.research, to: expected.join, relation: "joins", recordId: "join-edge", mode: "join" },
  ])
  assert.equal(result.graphInput.providers[0].status, "ready")
  assert.deepEqual(result.sourceContinuation, { hasMore: false, omittedPlans: 0, omittedObjects: 0, reasons: [] })
})

test("keeps the task relation only when the separately authorized task node is present", () => {
  const expected = refs()
  const source = buildAuthorizedTaskPlanGraphSource(input())
  const taskProjection = createGalaxyObjectProjection({
    schemaId: "gb.object-projection.v1",
    ref: expected.task,
    kind: "ham.task",
    revision: { policy: "latest", id: null },
    title: "Investigate",
    mediaType: "application/vnd.ham.task+json",
    representations: [],
    provenance: { provider: "ham", sourceId: "task-1", statement: "Authorized task." },
    capabilities: ["open", "inspect", "relate"],
  })
  const graph = projectUnifiedGraph({
    ...source.graphInput,
    objects: [{ scope, projection: taskProjection }, ...source.graphInput.objects],
  }, { maxNodes: 32, maxEdges: 64, maxFanout: 64 })

  assert.equal(graph.nodes.length, 5)
  assert.equal(graph.edges.some((edge) => edge.fromRef === expected.task && edge.toRef === expected.plan), true)
  assert.equal(graph.edges.every((edge) => edge.trust === "structure"), true)
})

test("never projects live run, claim, or executor state from saved plan config", () => {
  const candidate = record()
  candidate.current_spec.nodes[0].config = {
    executorProfile: "agent",
    requiresApproval: false,
    outputRefs: ["gb:object:v1:artifact:output:latest"],
  }
  const serialized = JSON.stringify(buildAuthorizedTaskPlanGraphSource(input({
    plans: [{ authorized: true, scope, record: candidate }],
  })))
  assert.doesNotMatch(serialized, /executorProfile|requiresApproval|outputRefs|claim_id|run_id|dispatch/u)
})

test("accepts canonical multiline and maximum goals while bounding display text independently", () => {
  const candidate = record({
    title: "  Investigate\nthis mechanism  ",
  })
  candidate.current_spec.goal = `Plan\n${"p".repeat(19_995)}`
  candidate.current_spec.nodes[0].title = "  Research\nsource  "
  candidate.current_spec.nodes[0].goal = "g".repeat(4_000)
  const result = buildAuthorizedTaskPlanGraphSource(input({
    plans: [{ authorized: true, scope, record: candidate }],
  }))
  const [plan, job] = result.graphInput.objects.map(({ projection }) => projection)

  assert.equal(plan.title, "Investigate this mechanism")
  assert.equal(Array.from(plan.summary).length, 4_000)
  assert.equal(job.title, "Research source")
  assert.equal(Array.from(job.summary).length, 4_000)
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/u.test(`${plan.title}${plan.summary}${job.title}${job.summary}`), false)
})

test("omits unauthorized plans and fails closed on tenant, task, hash, edge, and cycle drift", () => {
  const denied = buildAuthorizedTaskPlanGraphSource(input({
    plans: [{ authorized: false, scope, record: record() }],
  }))
  assert.equal(denied.graphInput.objects.length, 0)
  assert.equal(denied.diagnostics.unauthorized, 1)

  assert.throws(() => buildAuthorizedTaskPlanGraphSource(input({
    plans: [{ authorized: true, scope, record: record({ tenant_id: "123e4567-e89b-42d3-a456-426614174099" }) }],
  })), /outside the authorized tenant/u)
  const wrongTask = record()
  wrongTask.current_spec.task.id = "task-2"
  assert.throws(() => buildAuthorizedTaskPlanGraphSource(input({
    plans: [{ authorized: true, scope, record: wrongTask }],
  })), /task identity is inconsistent/u)
  assert.throws(() => buildAuthorizedTaskPlanGraphSource(input({
    plans: [{ authorized: true, scope, record: record({ current_content_hash: "not-a-hash" }) }],
  })), /must be SHA-256/u)
  const dangling = record()
  dangling.current_spec.edges[0].target = "missing"
  assert.throws(() => buildAuthorizedTaskPlanGraphSource(input({
    plans: [{ authorized: true, scope, record: dangling }],
  })), /edge is invalid/u)
  const cyclic = record()
  cyclic.current_spec.edges.push({ id: "cycle", source: "join", target: "research", kind: "control" })
  assert.throws(() => buildAuthorizedTaskPlanGraphSource(input({
    plans: [{ authorized: true, scope, record: cyclic }],
  })), /contains a cycle/u)
})

test("prioritizes an exact plan as a whole and reports a deterministic bounded continuation", () => {
  const secondId = "123e4567-e89b-42d3-a456-426614174010"
  const secondHash = "b".repeat(64)
  const second = record({ id: secondId, current_content_hash: secondHash, updated_at: "2026-09-24T00:00:00Z" })
  const secondRef = createGalaxyObjectReference("task-plan", secondId, {
    mode: "pinned",
    revision: `sha256:${secondHash}`,
  })
  const result = buildAuthorizedTaskPlanGraphSource(input({
    plans: [
      { authorized: true, scope, record: record({ updated_at: "2026-09-26T00:00:00Z" }) },
      { authorized: true, scope, record: second },
    ],
    sourceLimit: 4,
    priorityRefs: [secondRef],
  }))

  assert.equal(result.graphInput.objects[0].projection.ref, secondRef)
  assert.equal(result.graphInput.objects.length, 4)
  assert.deepEqual(result.sourceContinuation, {
    hasMore: true,
    omittedPlans: 1,
    omittedObjects: 4,
    reasons: ["source-limit"],
  })
  assert.equal(result.graphInput.providers[0].status, "partial")
})

test("requires canonical supported priority references and exact input boundaries", () => {
  assert.throws(() => buildAuthorizedTaskPlanGraphSource(input({ priorityRefs: ["not-a-reference"] })), /must be canonical/u)
  const unsupported = createGalaxyObjectReference("paper", "paper-1")
  assert.throws(() => buildAuthorizedTaskPlanGraphSource(input({ priorityRefs: [unsupported] })), /unsupported/u)
  assert.throws(() => buildAuthorizedTaskPlanGraphSource({ ...input(), hidden: true }), /hidden is not part/u)
  assert.throws(() => buildAuthorizedTaskPlanGraphSource(input({
    plans: [{ authorized: true, scope: { ...scope, workspaceId: "other" }, record: record() }],
  })), /crosses the tenant or workspace boundary/u)
})
