import assert from "node:assert/strict"
import test from "node:test"

import { buildAuthorizedProofGraphSource } from "../lib/authorized-proof-graph-source.js"
import { joinAuthorizedProofHamCoordination } from "../lib/proof-ham-coordination.js"

const HASH = "a".repeat(64)
const scope = Object.freeze({
  tenantId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "proof-workspace",
})

function proofSource() {
  return buildAuthorizedProofGraphSource({
    schemaId: "gb.authorized-proof-graph-source.v1",
    authorized: true,
    activateCoordination: true,
    scope,
    query: { mode: "mixed", lens: "explore", scale: "project", filters: {} },
    proofDag: {
      schema_id: "galaxy.proof-dag.v1",
      graph_id: "prototime",
      graph_kind: "mission",
      title: "Proto-time mission",
      targets: [{
        target_id: "foundation",
        title: "Foundation",
        natural_language_summary: "Establish the base theorem.",
        target_kind: "formal-target",
        formal_binding: { status: "mapped" },
      }],
      relations: [],
    },
    proofDagSha256: HASH,
    workState: {
      schema_id: "galaxy.proof-work-state.v1",
      workspace_id: "prototime",
      graph_ref: { graph_id: "prototime", content_sha256: HASH },
      version: 4,
      updated_at: "2026-09-24T12:00:00Z",
      items: [{
        node_id: "foundation",
        version: 2,
        work: {
          status: "idle",
          claim: null,
          hyades: null,
          blocker: null,
          task_id: "task-foundation",
          linked_task_count: 1,
        },
        proof: { status: "open", candidate_sha256: null, verification: null },
        external: {},
      }],
    },
  })
}

function task(resourceOverrides = {}, taskOverrides = {}) {
  return {
    id: "task-foundation",
    version: 7,
    title: "Prove the foundation",
    goal: "Complete the formal target",
    why: "Coordinate work without claiming proof truth",
    state: "claimed",
    lifecyclePhase: "claimed",
    stage: "Task claimed",
    riskMode: "test",
    expectedEffects: [],
    resources: [{
      id: "resource-foundation",
      resourceRef: `proof-packet:sha256:${HASH}/prototime/foundation`,
      mode: "observe",
      status: "active",
      ...resourceOverrides,
    }],
    conflicts: [],
    projectionSource: "ham",
    ...taskOverrides,
  }
}

function join(tasks, bindings = proofSource().coordinationBindings) {
  return joinAuthorizedProofHamCoordination({
    schemaId: "gb.proof-ham-coordination.v1",
    scope,
    bindings,
    tasks,
  })
}

test("joins an exact authorized HAM task through its active hash-bound proof-packet resource", () => {
  const source = proofSource()
  const before = structuredClone(source.graphInput.proofContexts[0].nodeStates[0])
  const result = join([{ authorized: true, scope, task: task() }], source.coordinationBindings)

  assert.equal(result.relations.length, 1)
  assert.deepEqual(result.relations[0], {
    scope,
    relation: {
      fromRef: source.coordinationBindings[0].nodeRef,
      toRef: "gb:object:v1:ham.task:task-foundation:latest",
      relation: "coordinated_by",
      trust: "structure",
      source: {
        provider: "galaxy.proof-work",
        recordId: "resource-foundation",
        revision: "version:7",
        sourceRef: `proof-packet:sha256:${HASH}/prototime/foundation`,
        resourceMode: "observe",
        resourceStatus: "active",
      },
    },
  })
  assert.deepEqual(result.diagnostics, {
    unauthorizedTasks: 0,
    missingTasks: 0,
    resourceMismatches: 0,
    linked: 1,
  })
  assert.deepEqual(source.graphInput.proofContexts[0].nodeStates[0], before)
  assert.equal(before.proofStatus, "open")
})

test("omits non-active, redacted, unhashed, wrong-node, and wrong-hash task resources", () => {
  const invalidResources = [
    { status: "released" },
    { status: "pending" },
    { status: "unknown" },
    { redacted: true },
    { resourceRef: "proof-packet:prototime/foundation" },
    { resourceRef: `proof-packet:sha256:${HASH}/prototime/other` },
    { resourceRef: `proof-packet:sha256:${"b".repeat(64)}/prototime/foundation` },
  ]
  for (const resource of invalidResources) {
    const result = join([{ authorized: true, scope, task: task(resource) }])
    assert.equal(result.relations.length, 0)
    assert.equal(result.diagnostics.resourceMismatches, 1)
  }
})

test("does not join unauthorized, missing, or spoofed task identities", () => {
  const unauthorized = join([{ authorized: false, scope, task: task() }])
  assert.deepEqual(unauthorized.diagnostics, {
    unauthorizedTasks: 1,
    missingTasks: 1,
    resourceMismatches: 0,
    linked: 0,
  })

  const spoofed = join([{ authorized: true, scope, task: task({}, { id: "task-other" }) }])
  assert.equal(spoofed.relations.length, 0)
  assert.equal(spoofed.diagnostics.missingTasks, 1)
})

test("rejects a binding whose declared graph identity disagrees with the proof-packet resource", () => {
  const [binding] = structuredClone(proofSource().coordinationBindings)
  binding.graphId = "other-program"
  assert.throws(
    () => join([{ authorized: true, scope, task: task() }], [binding]),
    /resourceRef must name graphId/u,
  )
})

test("fails closed when an allegedly authorized task crosses the graph scope", () => {
  assert.throws(() => join([{
    authorized: true,
    scope: { ...scope, workspaceId: "other" },
    task: task(),
  }]), /crosses the tenant or workspace boundary/u)
})
