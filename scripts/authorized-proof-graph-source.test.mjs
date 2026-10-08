import assert from "node:assert/strict"
import test from "node:test"

import { buildAuthorizedProofGraphSource } from "../lib/authorized-proof-graph-source.js"
import { createGalaxyObjectReference, parseGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import { projectUnifiedGraph } from "../lib/unified-graph.js"

const HASH = "a".repeat(64)
const CANDIDATE = "b".repeat(64)
const RECEIPT = "c".repeat(64)
const scope = Object.freeze({
  tenantId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "proof-workspace",
})

function query() {
  return {
    rootRef: null,
    mode: "mixed",
    lens: "explore",
    scale: "project",
    viewport: null,
    filters: {},
    validAt: null,
    knownAt: null,
    cursor: null,
  }
}

function dag(graphKind = "mission", graphId = "prototime") {
  return {
    schema_id: "galaxy.proof-dag.v1",
    graph_id: graphId,
    graph_kind: graphKind,
    title: "Proto-time mission",
    targets: [
      {
        target_id: "foundation",
        title: "Foundation",
        natural_language_summary: "Establish the base theorem.",
        category: "theorem",
        target_kind: "formal-target",
        formal_binding: { status: "mapped" },
      },
      {
        target_id: "main",
        title: "Main theorem",
        natural_language_summary: "Prove the mission target.",
        category: "theorem",
        target_kind: "formal-target",
        formal_binding: { status: "mapped" },
      },
    ],
    relations: [{
      relation_id: "foundation-required-by-main",
      relation_type: "DEPENDS_ON",
      prerequisite_target_id: "foundation",
      dependent_target_id: "main",
    }],
  }
}

function acceptedWorkState(overrides = {}) {
  return {
    schema_id: "galaxy.proof-work-state.v1",
    workspace_id: "prototime",
    graph_ref: { graph_id: "prototime", content_sha256: HASH },
    version: 7,
    updated_at: "2026-09-23T12:00:00Z",
    items: [{
      node_id: "foundation",
      version: 3,
      work: { status: "closed", claim: null, hyades: null, blocker: null },
      proof: {
        status: "verified",
        candidate_sha256: CANDIDATE,
        verification: {
          method: "hyades-run",
          authority: {
            principal_id: "22222222-2222-4222-8222-222222222222",
            nostr_pubkey: "d".repeat(64),
            principal_kind: "agent",
          },
          receipt_id: "receipt-foundation",
          receipt_sha256: RECEIPT,
          outcome: "accepted",
          solution_sha256: CANDIDATE,
          source_commit: "e".repeat(40),
          lean_toolchain: "leanprover/lean4:v4.30.0",
          mathlib_revision: "f".repeat(40),
          sorry_free: true,
          verified_at: "2026-09-23T11:00:00Z",
          hyades: { workflow_id: "proof-v1", run_id: "run-1", status: "completed" },
        },
      },
      external: {
        rosetta: { node_id: "lean:foundation", status: "published" },
        prove2me: { theorem_id: "p2m-foundation", status: "accepted" },
      },
    }],
    ...overrides,
  }
}

function taskBoundWorkState() {
  const state = acceptedWorkState()
  state.items[0].work.task_id = "task-foundation"
  state.items[0].work.linked_task_count = 2
  return state
}

function input(overrides = {}) {
  return {
    schemaId: "gb.authorized-proof-graph-source.v1",
    authorized: true,
    activateCoordination: true,
    scope,
    query: query(),
    proofDag: dag(),
    proofDagSha256: HASH,
    workState: acceptedWorkState(),
    ...overrides,
  }
}

test("projects exact immutable proof identity and keeps work, proof, verification, and interoperability in node state", () => {
  const result = buildAuthorizedProofGraphSource(input())
  const graph = projectUnifiedGraph(result.graphInput, { maxNodes: 100, maxEdges: 100 })
  const graphNode = graph.nodes.find((node) => node.kind === "proof.graph")
  const theoremNodes = graph.nodes.filter((node) => node.kind === "proof.node")

  assert.equal(parseGalaxyObjectReference(graphNode.ref).selector.revision, `sha256:${HASH}`)
  assert.deepEqual(
    theoremNodes.map((node) => parseGalaxyObjectReference(node.ref).id).sort(),
    ["prototime#foundation", "prototime#main"],
  )
  assert.ok(theoremNodes.every((node) => parseGalaxyObjectReference(node.ref).selector.revision === `sha256:${HASH}`))
  assert.ok(theoremNodes.every((node) => node.overlays.proof.workPolicy === "explicit-task-materialization"))

  const authoredDependency = graph.edges.find((edge) => edge.source.resourceMode === "DEPENDS_ON")
  assert.equal(authoredDependency.relation, "required_by")
  assert.equal(authoredDependency.trust, "structure")
  assert.ok(graph.edges.every((edge) => edge.trust === "structure"))
  const states = result.graphInput.proofContexts[0].nodeStates
  const foundation = states.find((state) => parseGalaxyObjectReference(state.nodeRef).id.endsWith("#foundation"))
  const main = states.find((state) => parseGalaxyObjectReference(state.nodeRef).id.endsWith("#main"))
  assert.deepEqual({
    state: foundation.state,
    workStatus: foundation.workStatus,
    proofStatus: foundation.proofStatus,
    candidateSha256: foundation.candidateSha256,
  }, {
    state: "completed",
    workStatus: "closed",
    proofStatus: "verified",
    candidateSha256: CANDIDATE,
  })
  assert.deepEqual(foundation.verification, {
    status: "verified",
    method: "hyades-run",
    evidenceRef: `sha256:${RECEIPT}`,
    solutionSha256: CANDIDATE,
    sorryFree: true,
    verifiedAt: "2026-09-23T11:00:00Z",
  })
  assert.deepEqual(foundation.external, { rosettaStatus: "published", prove2meStatus: "accepted" })
  assert.equal(main.state, "available")
  assert.equal(main.workStatus, undefined)
  assert.equal(result.diagnostics.coordinationActive, true)
})

test("carries an active mission's primary HAM task binding without changing proof truth", () => {
  const result = buildAuthorizedProofGraphSource(input({ workState: taskBoundWorkState() }))
  const state = result.graphInput.proofContexts[0].nodeStates
    .find((item) => parseGalaxyObjectReference(item.nodeRef).id.endsWith("#foundation"))

  assert.equal(state.taskId, "task-foundation")
  assert.equal(state.linkedTaskCount, 2)
  assert.equal(state.proofStatus, "verified")
  assert.deepEqual(result.coordinationBindings, [{
    graphId: "prototime",
    nodeId: "foundation",
    nodeRef: state.nodeRef,
    taskId: "task-foundation",
    linkedTaskCount: 2,
    resourceRef: `proof-packet:sha256:${HASH}/prototime/foundation`,
  }])
})

test("keeps repository fields passive even when imported state contains a live claim and activation is requested", () => {
  const claimed = acceptedWorkState({
    items: [{
      node_id: "foundation",
      version: 1,
      work: {
        status: "claimed",
        claim: {
          claim_id: "claim-1",
          nostr_pubkey: "a".repeat(64),
          claimed_at: "2026-09-23T11:00:00Z",
          expires_at: "2026-09-23T13:00:00Z",
        },
        hyades: null,
        blocker: null,
      },
      proof: { status: "candidate", candidate_sha256: CANDIDATE, verification: null },
      external: {},
    }],
  })
  const result = buildAuthorizedProofGraphSource(input({
    proofDag: dag("repository-field"),
    workState: claimed,
  }))
  const graph = projectUnifiedGraph(result.graphInput, { maxNodes: 100, maxEdges: 100 })

  assert.equal(result.diagnostics.coordinationActive, false)
  assert.equal(result.graphInput.proofContexts[0].coordinationActive, false)
  assert.equal(result.diagnostics.passiveCoordinationItems, 1)
  assert.ok(graph.nodes.filter((node) => node.kind === "proof.node")
    .every((node) => node.overlays.proof.workPolicy === "passive"))
  const state = result.graphInput.proofContexts[0].nodeStates[0]
  assert.equal(state.state, "reference")
  assert.equal(state.workStatus, undefined)
  assert.equal(state.claim, undefined)
  assert.equal(state.taskId, undefined)
  assert.equal(state.linkedTaskCount, undefined)
  assert.equal(state.candidateSha256, undefined)
  assert.deepEqual(result.coordinationBindings, [])
  assert.equal(JSON.stringify(graph).includes("claim-1"), false)
})

test("renders an authorized DAG without requiring or synthesizing proof work state", () => {
  const result = buildAuthorizedProofGraphSource(input({
    proofDag: dag("repository-field"),
    workState: null,
  }))
  const graph = projectUnifiedGraph(result.graphInput, { maxNodes: 100, maxEdges: 100 })

  assert.equal(graph.nodes.length, 3)
  assert.equal(graph.edges.length, 3)
  assert.deepEqual(graph.provenance.providers.map((provider) => provider.provider), ["galaxy.proof-dag"])
  assert.equal(result.diagnostics.coordinationActive, false)
  assert.equal(result.graphInput.proofContexts[0].coordinationActive, false)
  assert.equal(result.diagnostics.passiveCoordinationItems, 0)
  assert.deepEqual(result.graphInput.proofContexts[0].nodeStates, [])
})

test("requires explicit coordination activation even for a campaign or mission", () => {
  const result = buildAuthorizedProofGraphSource(input({ activateCoordination: false }))
  const graph = projectUnifiedGraph(result.graphInput, { maxNodes: 100, maxEdges: 100 })

  assert.equal(result.diagnostics.coordinationActive, false)
  assert.ok(result.graphInput.proofContexts[0].nodeStates.every((state) => state.state === "reference"))
  const foundation = result.graphInput.proofContexts[0].nodeStates.find((state) => state.proofStatus === "verified")
  assert.equal(foundation.workStatus, undefined)
  assert.equal(foundation.candidateSha256, undefined)
  assert.equal(foundation.verification.status, "verified")
  assert.ok(graph.edges.every((edge) => edge.trust === "structure"))
})

test("rejected receipts never become verified node state", () => {
  const rejected = acceptedWorkState()
  rejected.items[0].proof.status = "rejected"
  rejected.items[0].proof.verification.outcome = "rejected"
  rejected.items[0].proof.verification.sorry_free = false
  const result = buildAuthorizedProofGraphSource(input({ workState: rejected }))
  const state = result.graphInput.proofContexts[0].nodeStates.find((item) => item.proofStatus === "rejected")
  assert.equal(state.state, "available")
  assert.equal(state.verification, undefined)
  assert.equal(projectUnifiedGraph(result.graphInput).edges.some((edge) => edge.trust === "verification"), false)
})

test("human-signed receipts remain non-completing and are not projected as verification", () => {
  const humanReceipt = acceptedWorkState()
  humanReceipt.items[0].proof.verification.authority.principal_kind = "human"
  const result = buildAuthorizedProofGraphSource(input({ workState: humanReceipt }))
  const state = result.graphInput.proofContexts[0].nodeStates
    .find((item) => parseGalaxyObjectReference(item.nodeRef).id.endsWith("#foundation"))

  assert.equal(state.state, "available")
  assert.equal(state.proofStatus, undefined)
  assert.equal(state.verification, undefined)
})

test("binds verification to the candidate hash before producing any graph source", () => {
  const mismatched = acceptedWorkState()
  mismatched.items[0].proof.verification.solution_sha256 = "0".repeat(64)
  assert.throws(
    () => buildAuthorizedProofGraphSource(input({ workState: mismatched })),
    /verification does not match proof\.candidate_sha256/u,
  )
})

test("scopes identical theorem IDs to their immutable graph identity", () => {
  const left = buildAuthorizedProofGraphSource(input({ workState: null })).graphInput
  const rightDag = dag("mission", "other-mission")
  const right = buildAuthorizedProofGraphSource(input({
    proofDag: rightDag,
    workState: null,
  })).graphInput
  const leftNode = left.objects.find((item) => item.projection.kind === "proof.node").projection.ref
  const rightNode = right.objects.find((item) => item.projection.kind === "proof.node").projection.ref

  assert.notEqual(leftNode, rightNode)
  assert.equal(parseGalaxyObjectReference(leftNode).id, "prototime#foundation")
  assert.equal(parseGalaxyObjectReference(rightNode).id, "other-mission#foundation")
})

test("bounds the full proof node identity when both graph and theorem IDs are maximal", () => {
  const longGraphId = "g".repeat(512)
  // Deliberately reverse lexical order (and mix case) so this proves that the
  // opaque fallback uses immutable target-array ordinality across runtimes.
  const longNodeId = "z".repeat(512)
  const secondLongNodeId = "A".repeat(512)
  const longDag = {
    schema_id: "galaxy.proof-dag.v1",
    graph_id: longGraphId,
    graph_kind: "repository-field",
    title: "Long identity repository",
    targets: [{
      target_id: longNodeId,
      title: "Long theorem",
      natural_language_summary: "Identity boundary fixture.",
      target_kind: "formal-target",
      formal_binding: { status: "mapped" },
    }, {
      target_id: secondLongNodeId,
      title: "Second long theorem",
      natural_language_summary: "Ordinal identity boundary fixture.",
      target_kind: "formal-target",
      formal_binding: { status: "mapped" },
    }],
    relations: [],
  }
  const source = buildAuthorizedProofGraphSource(input({ proofDag: longDag, workState: null })).graphInput
  const parsed = source.objects
    .filter((item) => item.projection.kind === "proof.node")
    .map((item) => ({
      title: item.projection.title,
      reference: parseGalaxyObjectReference(item.projection.ref),
    }))

  assert.ok(parsed.every(({ reference }) => reference.id.length <= 512))
  assert.equal(parsed.find((item) => item.title === "Long theorem").reference.id, `proof-node-${HASH}-0`)
  assert.equal(parsed.find((item) => item.title === "Second long theorem").reference.id, `proof-node-${HASH}-1`)
  assert.ok(parsed.every(({ reference }) => reference.selector.revision === `sha256:${HASH}`))
})

test("paginates the valid 10,000-target boundary below unified input limits without losing nodes", () => {
  const boundaryDag = {
    schema_id: "galaxy.proof-dag.v1",
    graph_id: "boundary-repository",
    graph_kind: "repository-field",
    title: "Boundary repository",
    targets: Array.from({ length: 10_000 }, (_, index) => ({
      target_id: `target-${String(index).padStart(5, "0")}`,
      title: `Target ${index}`,
      natural_language_summary: "Boundary fixture.",
      target_kind: "formal-target",
      formal_binding: { status: "mapped" },
    })),
    relations: [],
  }
  const first = buildAuthorizedProofGraphSource(input({ proofDag: boundaryDag, workState: null, sourceLimit: 10_000 }))
  assert.equal(first.graphInput.objects.length, 10_000)
  assert.equal(first.graphInput.relations.length, 9_999)
  assert.equal(first.sourceContinuation.hasMore, true)
  assert.equal(first.diagnostics.partial, true)
  assert.ok(first.graphInput.providers.every((provider) => provider.status === "partial"))

  const second = buildAuthorizedProofGraphSource(input({
    proofDag: boundaryDag,
    workState: null,
    sourceLimit: 10_000,
    sourceCursor: first.sourceContinuation.cursor,
  }))
  assert.equal(second.graphInput.objects.length, 2)
  assert.equal(second.graphInput.relations.length, 1)
  assert.equal(second.sourceContinuation.hasMore, false)
  assert.equal(second.diagnostics.partial, true)
  assert.ok(second.graphInput.providers.every((provider) => provider.status === "partial"))
  const nodeRefs = new Set([
    ...first.graphInput.proofContexts[0].nodeRefs,
    ...second.graphInput.proofContexts[0].nodeRefs,
  ])
  assert.equal(nodeRefs.size, 10_000)

  const lateRoot = createGalaxyObjectReference(
    "proof.node",
    "boundary-repository#target-09999",
    { mode: "pinned", revision: `sha256:${HASH}` },
  )
  const focusedInput = input({ proofDag: boundaryDag, workState: null })
  focusedInput.query = { ...query(), rootRef: lateRoot }
  const focused = buildAuthorizedProofGraphSource(focusedInput)
  assert.ok(focused.graphInput.objects.length <= 1_000)
  assert.ok(focused.graphInput.relations.length <= 1_000)
  assert.ok(focused.graphInput.proofContexts[0].nodeRefs.includes(lateRoot))
  const focusedGraph = projectUnifiedGraph(focused.graphInput, { maxNodes: 100, maxEdges: 100 })
  assert.ok(focusedGraph.nodes.some((node) => node.ref === lateRoot))
  assert.ok(focusedGraph.nodes.length >= 2)
  assert.throws(
    () => buildAuthorizedProofGraphSource({
      ...focusedInput,
      sourceCursor: first.sourceContinuation.cursor,
    }),
    /sourceCursor does not belong/u,
  )

  const selected = buildAuthorizedProofGraphSource(input({
    proofDag: boundaryDag,
    workState: null,
    sourceLimit: 500,
    priorityRefs: [lateRoot],
  }))
  assert.ok(selected.graphInput.objects.length <= 500)
  assert.ok(selected.graphInput.relations.length <= 500)
  assert.ok(selected.graphInput.proofContexts[0].nodeRefs.includes(lateRoot))
  assert.equal(selected.sourceContinuation.hasMore, true)
})

test("projects a complete 130-target repository field without dropping containment edges", () => {
  const repositoryDag = {
    schema_id: "galaxy.proof-dag.v1",
    graph_id: "leanproofs",
    graph_kind: "repository-field",
    title: "LeanProofs",
    targets: Array.from({ length: 130 }, (_, index) => ({
      target_id: `target-${String(index).padStart(3, "0")}`,
      title: `Target ${index}`,
      natural_language_summary: "LeanProofs corpus fixture.",
      target_kind: "formal-target",
      formal_binding: { status: "mapped" },
    })),
    relations: [],
  }
  const source = buildAuthorizedProofGraphSource(input({
    proofDag: repositoryDag,
    workState: null,
    sourceLimit: 513,
  }))
  const graph = projectUnifiedGraph(source.graphInput, {
    maxNodes: 1_200,
    maxEdges: 5_000,
    maxFanout: 512,
  })

  assert.equal(source.sourceContinuation.hasMore, false)
  assert.equal(graph.nodes.length, 131)
  assert.equal(graph.edges.filter((edge) => edge.relation === "contains").length, 130)
  assert.deepEqual(graph.continuation, {
    cursor: null,
    hasMore: false,
    omitted: { nodes: 0, edges: 0, fanout: 0 },
    reasons: [],
  })
})

test("paginates dense authored dependencies without exceeding the relation input bound", () => {
  const targets = Array.from({ length: 150 }, (_, index) => ({
    target_id: `dense-${String(index).padStart(3, "0")}`,
    title: `Dense target ${index}`,
    natural_language_summary: "Dense relation fixture.",
    target_kind: "formal-target",
    formal_binding: { status: "mapped" },
  }))
  const relations = []
  for (let source = 0; source < targets.length; source += 1) {
    for (let target = source + 1; target < targets.length; target += 1) {
      relations.push({
        relation_id: `dense-${source}-${target}`,
        relation_type: "DEPENDS_ON",
        prerequisite_target_id: targets[source].target_id,
        dependent_target_id: targets[target].target_id,
      })
    }
  }
  const denseDag = {
    schema_id: "galaxy.proof-dag.v1",
    graph_id: "dense-repository",
    graph_kind: "repository-field",
    title: "Dense repository",
    targets,
    relations,
  }
  let cursor = null
  const relationIds = new Set()
  do {
    const page = buildAuthorizedProofGraphSource(input({
      proofDag: denseDag,
      workState: null,
      sourceCursor: cursor,
      sourceLimit: 10_000,
    }))
    assert.ok(page.graphInput.relations.length <= 10_000)
    page.graphInput.relations
      .filter((item) => item.relation.source.resourceMode === "DEPENDS_ON")
      .forEach((item) => relationIds.add(item.relation.source.recordId))
    cursor = page.sourceContinuation.cursor
  } while (cursor)
  assert.equal(relationIds.size, relations.length)
})

test("fails closed before parsing proof data when the authorization envelope is false", () => {
  const result = buildAuthorizedProofGraphSource(input({
    authorized: false,
    proofDag: { not: "a proof DAG" },
    workState: { not: "work state" },
  }))
  assert.equal(result.diagnostics.omittedUnauthorized, true)
  assert.deepEqual(result.graphInput.objects, [])
  assert.deepEqual(result.graphInput.relations, [])
})
