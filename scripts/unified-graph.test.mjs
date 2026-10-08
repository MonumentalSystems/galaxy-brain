import assert from "node:assert/strict"
import test from "node:test"

import { createGalaxyObjectReference, parseGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import {
  deriveUnifiedGraphView,
  projectUnifiedGraph,
} from "../lib/unified-graph.js"

const scope = Object.freeze({
  tenantId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "winding-prototime-v1",
})
const otherScope = Object.freeze({
  tenantId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "other",
})
const digest = (character) => character.repeat(64)
const ref = (kind, id, revision = null) => createGalaxyObjectReference(
  kind,
  id,
  revision ? { mode: "pinned", revision } : { mode: "latest" },
)

const paperRef = ref("paper", "arxiv:2401.00001", "rev-1")
const anchorRef = ref("document.anchor", "anchor-1", "anchor-rev-1")
const taskRef = ref("ham.task", "task-1")
const proofGraphRef = ref("proof.graph", "leanproofs", `sha256:${digest("a")}`)
const proofNodeRef = ref("proof.node", "leanproofs#theorem-1", `sha256:${digest("a")}`)

function projection(reference, title, provider = "galaxy", extras = {}) {
  const parsed = parseGalaxyObjectReference(reference)
  const pinned = parsed.selector.mode === "pinned"
  return {
    schemaId: "gb.object-projection.v1",
    ref: reference,
    kind: parsed.kind,
    revision: {
      policy: pinned ? "pinned" : "latest",
      id: pinned ? parsed.selector.revision : null,
      contentHash: digest("b"),
    },
    title,
    summary: `${title} summary`,
    mediaType: parsed.kind === "paper" ? "application/pdf" : "application/json",
    representations: [],
    provenance: { provider, sourceId: `${provider}:${title}` },
    capabilities: ["open", "inspect"],
    ...extras,
  }
}

function envelope(value) {
  return { scope, projection: value }
}

function query(overrides = {}) {
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
    ...overrides,
  }
}

function fixture() {
  return {
    schemaId: "gb.graph-projection-input.v1",
    scope,
    query: query(),
    objects: [
      envelope(projection(paperRef, "Vortex paper")),
      envelope(projection(anchorRef, "Equation 3.12")),
      envelope(projection(taskRef, "Check helicity boundary")),
    ],
    external: [
      {
        scope,
        resolution: {
          authorized: true,
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          provider: "rosetta",
          requestedRef: proofGraphRef,
          resolvedRef: proofGraphRef,
        },
        projection: projection(proofGraphRef, "LeanProofs graph", "rosetta"),
      },
      {
        scope,
        resolution: {
          authorized: true,
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          provider: "rosetta",
          requestedRef: proofNodeRef,
          resolvedRef: proofNodeRef,
        },
        projection: projection(proofNodeRef, "Vortex theorem", "rosetta"),
      },
    ],
    links: [
      {
        scope,
        link: {
          id: "link-anchor-paper",
          from_ref: anchorRef,
          to_ref: paperRef,
          relation: "part_of",
          basis: "derived",
          provenance: { source: "document-store", source_system: "galaxy", source_snapshot: "rev-1" },
        },
      },
      {
        scope,
        link: {
          id: "link-task-anchor",
          from_ref: taskRef,
          to_ref: anchorRef,
          relation: "context_for",
          basis: "authored",
          provenance: { source: "human", source_system: "galaxy" },
        },
      },
    ],
    relations: [
      {
        scope,
        relation: {
          fromRef: proofGraphRef,
          toRef: proofNodeRef,
          relation: "contains",
          trust: "structure",
          source: { provider: "rosetta", revision: `sha256:${digest("a")}` },
        },
      },
      {
        scope,
        relation: {
          fromRef: paperRef,
          toRef: proofNodeRef,
          relation: "supports",
          trust: "candidate",
          source: { provider: "semantic-index", recordId: "search-4" },
        },
      },
      {
        scope,
        relation: {
          fromRef: proofNodeRef,
          toRef: paperRef,
          relation: "verifies",
          trust: "verification",
          source: { provider: "hyades", recordId: "receipt-1" },
          verification: { status: "verified", method: "lean-replay", evidenceRef: "hyades:receipt:1" },
        },
      },
    ],
    proofContexts: [{
      scope,
      graphRef: proofGraphRef,
      graphKind: "repository-field",
      coordinationActive: false,
      nodeRefs: [proofNodeRef],
      nodeStates: [],
    }],
    providers: [
      { scope, provider: "galaxy", status: "ready", snapshot: "workspace-rev-7" },
      { scope, provider: "rosetta", status: "partial", revision: `sha256:${digest("a")}` },
    ],
  }
}

test("merges authoritative objects, ledger links, and authorized external projections", () => {
  const graph = projectUnifiedGraph(fixture())

  assert.equal(graph.schemaId, "gb.graph-projection.v1")
  assert.deepEqual(Object.keys(graph), [
    "schemaId", "query", "projectionHash", "nodes", "edges", "aggregates", "provenance", "continuation",
  ])
  assert.equal(graph.nodes.length, 5)
  assert.equal(graph.edges.length, 5)
  assert.ok(graph.nodes.every((node) => /^gn:[a-f0-9]{32}(?::\d+)?$/u.test(node.id)))
  assert.equal(new Set(graph.nodes.map((node) => node.id)).size, graph.nodes.length)
  assert.ok(graph.edges.every((edge) => edge.id.startsWith("ge:")))
  assert.ok(graph.edges.every((edge) => graph.nodes.some((node) => node.id === edge.from)))
  assert.equal(graph.edges.find((edge) => edge.source.recordId === "search-4").relation, "near")
  assert.equal(graph.edges.find((edge) => edge.source.recordId === "search-4").sourceRelation, "supports")
  assert.equal(graph.edges.find((edge) => edge.source.recordId === "receipt-1").trust, "verification")
  assert.deepEqual(graph.aggregates.trust, { structure: 2, assertion: 1, verification: 1, candidate: 1 })
  assert.deepEqual(graph.provenance.scope, scope)
  assert.deepEqual(graph.provenance.providers.map(({ provider, status }) => ({ provider, status })), [
    { provider: "galaxy", status: "ready" },
    { provider: "rosetta", status: "partial" },
  ])
  assert.deepEqual(graph.continuation, {
    cursor: null,
    hasMore: false,
    omitted: { nodes: 0, edges: 0, fanout: 0 },
    reasons: [],
  })
})

test("is deterministic across reordered equivalent inputs and gives Galaxy authority precedence", () => {
  const first = fixture()
  first.external.push({
    scope,
    resolution: {
      authorized: true,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      provider: "mirror",
      requestedRef: paperRef,
      resolvedRef: paperRef,
    },
    projection: projection(paperRef, "Stale mirror title", "mirror"),
  })
  const second = structuredClone(first)
  second.objects.reverse()
  second.external.reverse()
  second.links.reverse()
  second.relations.reverse()

  const left = projectUnifiedGraph(first)
  const right = projectUnifiedGraph(second)
  assert.equal(left.projectionHash, right.projectionHash)
  assert.deepEqual(left.nodes, right.nodes)
  assert.deepEqual(left.edges, right.edges)
  const paper = left.nodes.find((node) => node.ref === paperRef)
  assert.equal(paper.title, "Vortex paper")
  assert.equal(paper.authority, "galaxy")
  assert.deepEqual(paper.provenance.map((source) => source.provider), ["galaxy", "mirror"])
})

test("fails closed across tenant and workspace boundaries", () => {
  const crossTenant = fixture()
  crossTenant.objects[0].scope = otherScope
  assert.throws(() => projectUnifiedGraph(crossTenant), /crosses the tenant or workspace boundary/u)

  const crossWorkspaceResolution = fixture()
  crossWorkspaceResolution.external[0].resolution.workspaceId = "other"
  assert.throws(() => projectUnifiedGraph(crossWorkspaceResolution), /crosses the tenant or workspace boundary/u)
})

test("omits unauthorized externals and rejects resolver identity drift", () => {
  const unauthorized = fixture()
  unauthorized.external[0].resolution.authorized = false
  unauthorized.proofContexts = []
  const graph = projectUnifiedGraph(unauthorized)
  assert.equal(graph.nodes.some((node) => node.ref === proofGraphRef), false)
  assert.equal(graph.provenance.diagnostics.unauthorizedExternal, 1)
  assert.equal(graph.provenance.diagnostics.danglingEdges, 1)

  const drift = fixture()
  drift.external[0].resolution.resolvedRef = proofNodeRef
  assert.throws(() => projectUnifiedGraph(drift), /resolvedRef must match projection.ref/u)
})

test("requires evidence for verification and never promotes candidates to evidential edges", () => {
  const missingEvidence = fixture()
  delete missingEvidence.relations[2].relation.verification
  assert.throws(() => projectUnifiedGraph(missingEvidence), /verification trust requires evidence/u)

  const graph = projectUnifiedGraph(fixture())
  const candidate = graph.edges.find((edge) => edge.trust === "candidate")
  assert.equal(candidate.relation, "near")
  assert.equal(candidate.sourceRelation, "supports")
})

test("verification evidence and candidate source semantics participate in edge identity and cursors", () => {
  const input = fixture()
  input.relations.push({
    scope,
    relation: {
      ...structuredClone(input.relations[2].relation),
      verification: { status: "verified", method: "lean-replay", evidenceRef: "hyades:receipt:2" },
    },
  })
  const first = projectUnifiedGraph(input)
  const verified = first.edges.filter((edge) => edge.trust === "verification")
  assert.equal(verified.length, 2)
  assert.equal(new Set(verified.map((edge) => edge.id)).size, 2)

  const reordered = structuredClone(input)
  reordered.relations.reverse()
  assert.deepEqual(projectUnifiedGraph(reordered).edges, first.edges)

  const paged = projectUnifiedGraph(input, { maxNodes: 2 })
  const changed = structuredClone(input)
  changed.query.cursor = paged.continuation.cursor
  changed.relations[2].relation.verification.evidenceRef = "hyades:receipt:changed"
  assert.throws(() => projectUnifiedGraph(changed, { maxNodes: 2 }), /cursor does not belong/u)
})

test("opaque graph IDs remain bounded for maximum Unicode canonical references", () => {
  const longRef = ref("paper", "é".repeat(512))
  const input = fixture()
  input.objects.push(envelope(projection(longRef, "Long Unicode reference")))
  const graph = projectUnifiedGraph(input)
  const node = graph.nodes.find((item) => item.ref === longRef)
  assert.ok(node)
  assert.ok(node.id.length < 64)
  assert.equal(new Set(graph.nodes.map((item) => item.id)).size, graph.nodes.length)
})

test("keeps repository fields passive and active proof graphs behind explicit task materialization", () => {
  const passive = projectUnifiedGraph(fixture())
  assert.deepEqual(passive.nodes.find((node) => node.ref === proofNodeRef).overlays.proof, {
    graphRef: proofGraphRef,
    graphKind: "repository-field",
    coordinationActive: false,
    workPolicy: "passive",
  })
  assert.equal(JSON.stringify(passive).includes("claimable"), false)

  const activeInput = fixture()
  activeInput.proofContexts[0].graphKind = "mission"
  activeInput.proofContexts[0].coordinationActive = true
  const active = projectUnifiedGraph(activeInput)
  assert.equal(active.nodes.find((node) => node.ref === proofNodeRef).overlays.proof.workPolicy, "explicit-task-materialization")
  assert.equal(JSON.stringify(active).includes("claimable"), false)
})

test("projects proof-to-HAM coordination as structure without changing proof truth", () => {
  const input = fixture()
  input.proofContexts[0].graphKind = "mission"
  input.proofContexts[0].coordinationActive = true
  input.proofContexts[0].nodeStates = [{
    nodeRef: proofNodeRef,
    state: "available",
    coordinationLabel: "Available through HAM",
    workStatus: "idle",
    proofStatus: "open",
    taskId: "task-1",
    linkedTaskCount: 1,
  }]
  input.relations.push({
    scope,
    relation: {
      fromRef: proofNodeRef,
      toRef: taskRef,
      relation: "coordinated_by",
      trust: "structure",
      source: { provider: "galaxy.proof-work", resourceMode: "read" },
    },
  })

  const graph = projectUnifiedGraph(input)
  const proofNode = graph.nodes.find((node) => node.ref === proofNodeRef)
  const coordination = graph.edges.find((edge) => edge.relation === "coordinated_by")
  assert.equal(proofNode.overlays.proof.nodeState.taskId, "task-1")
  assert.equal(proofNode.overlays.proof.nodeState.linkedTaskCount, 1)
  assert.equal(proofNode.overlays.proof.nodeState.proofStatus, "open")
  assert.equal(proofNode.overlays.proof.nodeState.verification, undefined)
  assert.equal(coordination.trust, "structure")
  assert.equal(coordination.source.provider, "galaxy.proof-work")

  input.proofContexts[0].coordinationActive = false
  assert.throws(
    () => projectUnifiedGraph(input),
    /exposes mutable coordination while coordination is inactive/u,
  )
})

test("derives semantic detail from scale and uses placeholders while moving", () => {
  const input = fixture()
  input.query.scale = "corpus"
  const far = deriveUnifiedGraphView(projectUnifiedGraph(input))
  assert.equal(far.nodes[0].representation, "glyph")
  assert.deepEqual(Object.keys(far.nodes[0].detail), ["kind"])
  assert.deepEqual(far.nodes[0].projector, {
    plugin: {
      id: "documents",
      displayName: "Documents",
      version: "1.0.0",
    },
    diagnostic: null,
  })
  assert.equal(Object.isFrozen(far.nodes[0].projector), true)

  input.query.scale = "atomic"
  const detail = deriveUnifiedGraphView(projectUnifiedGraph(input))
  assert.equal(detail.nodes[0].representation, "detail")
  assert.ok("provenance" in detail.nodes[0].detail)

  const moving = deriveUnifiedGraphView(projectUnifiedGraph(input), true)
  assert.equal(moving.nodes[0].representation, "placeholder")
  assert.equal(moving.nodes[0].placeholder, true)
  assert.deepEqual(moving.nodes[0].projector, far.nodes[0].projector)

  const unknownInput = fixture()
  unknownInput.objects.push(envelope(projection(ref("code.repo", "repo-1"), "Repository")))
  const baseUnknownGraph = projectUnifiedGraph(unknownInput)
  const baseUnknown = baseUnknownGraph.nodes.find((node) => node.kind === "code.repo")
  assert.equal("projector" in baseUnknown, false)
  assert.equal(JSON.stringify(baseUnknownGraph).includes("projector_unavailable"), false)
  const derivedUnknown = deriveUnifiedGraphView(baseUnknownGraph).nodes.find((node) => node.kind === "code.repo")
  assert.deepEqual(Object.keys(derivedUnknown.projector).sort(), ["diagnostic", "plugin"])
  assert.deepEqual(derivedUnknown.projector.plugin, {
    id: "code",
    displayName: "Code editor",
    version: "1.0.0",
  })
  assert.equal(derivedUnknown.projector.diagnostic, null)

  const forgedGraph = {
    ...baseUnknownGraph,
    nodes: baseUnknownGraph.nodes.map((node) => ({
      ...node,
      projector: { plugin: { id: "attacker", displayName: "Healthy", version: "999" }, diagnostic: null },
    })),
  }
  const forgedUnknown = deriveUnifiedGraphView(forgedGraph).nodes.find((node) => node.kind === "code.repo")
  assert.deepEqual(forgedUnknown.projector, derivedUnknown.projector)
})

test("supports deterministic neighborhood filtering and projection-bound continuation cursors", () => {
  const neighborhoodInput = fixture()
  neighborhoodInput.query = query({ rootRef: anchorRef })
  const neighborhood = projectUnifiedGraph(neighborhoodInput)
  assert.deepEqual(new Set(neighborhood.nodes.map((node) => node.ref)), new Set([paperRef, anchorRef, taskRef]))
  assert.equal(neighborhood.edges.length, 2)

  const first = projectUnifiedGraph(fixture(), { maxNodes: 2 })
  assert.equal(first.continuation.hasMore, true)
  const nextInput = fixture()
  nextInput.query.cursor = first.continuation.cursor
  const second = projectUnifiedGraph(nextInput, { maxNodes: 2 })
  assert.equal(first.projectionHash, second.projectionHash)
  assert.equal(new Set([...first.nodes, ...second.nodes].map((node) => node.ref)).size, 4)

  const changed = fixture()
  changed.query.cursor = first.continuation.cursor
  changed.objects[0].projection.title = "Changed title"
  assert.throws(() => projectUnifiedGraph(changed, { maxNodes: 2 }), /cursor does not belong/u)
})

test("applies graph modes instead of presenting inert mode labels", () => {
  const taskInput = fixture()
  taskInput.query = query({ mode: "task" })
  const tasks = projectUnifiedGraph(taskInput)
  assert.deepEqual(tasks.nodes.map((node) => node.ref), [taskRef])
  assert.equal(tasks.edges.length, 0)

  const proofInput = fixture()
  proofInput.query = query({ mode: "proof" })
  const proofs = projectUnifiedGraph(proofInput)
  assert.deepEqual(new Set(proofs.nodes.map((node) => node.ref)), new Set([proofGraphRef, proofNodeRef]))
  assert.equal(proofs.edges.length, 1)

  const federatedInput = fixture()
  federatedInput.query = query({ mode: "federated" })
  const federated = projectUnifiedGraph(federatedInput)
  assert.deepEqual(new Set(federated.nodes.map((node) => node.ref)), new Set([proofGraphRef, proofNodeRef]))
})

test("rejects query dimensions that are declared but not implemented", () => {
  for (const overrides of [
    { lens: "verify" },
    { viewport: { x: 0, y: 0, width: 100, height: 100 } },
    { validAt: "2026-09-23T12:00:00Z" },
    { knownAt: "2026-09-23T12:00:00Z" },
  ]) {
    const input = fixture()
    input.query = query(overrides)
    assert.throws(() => projectUnifiedGraph(input), /not implemented/u)
  }
})

test("provider state participates in projection hashes and invalidates stale cursors", () => {
  const input = fixture()
  const first = projectUnifiedGraph(input, { maxNodes: 2 })
  const changed = fixture()
  changed.query.cursor = first.continuation.cursor
  changed.providers[1].status = "unavailable"
  assert.throws(() => projectUnifiedGraph(changed, { maxNodes: 2 }), /cursor does not belong/u)
})

test("emits a cross-page edge exactly once when its later endpoint arrives", () => {
  const input = fixture()
  input.links = []
  input.relations = [{
    scope,
    relation: {
      fromRef: anchorRef,
      toRef: taskRef,
      relation: "context_for",
      trust: "assertion",
      source: { provider: "galaxy", recordId: "cross-page" },
    },
  }]
  input.proofContexts = []
  input.external = []

  const first = projectUnifiedGraph(input, { maxNodes: 1 })
  assert.equal(first.edges.length, 0)
  input.query.cursor = first.continuation.cursor
  const second = projectUnifiedGraph(input, { maxNodes: 1 })
  input.query.cursor = second.continuation.cursor
  const third = projectUnifiedGraph(input, { maxNodes: 1 })
  const emitted = [...first.edges, ...second.edges, ...third.edges]
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].source.recordId, "cross-page")
  assert.equal(third.continuation.hasMore, false)
})

test("edge-only continuation pages do not repeat nodes", () => {
  const input = fixture()
  const nodes = []
  const edges = []
  for (let page = 0; page < 20; page += 1) {
    const graph = projectUnifiedGraph(input, { maxNodes: 2, maxEdges: 1 })
    nodes.push(...graph.nodes)
    edges.push(...graph.edges)
    if (!graph.continuation.hasMore) break
    input.query.cursor = graph.continuation.cursor
  }
  assert.equal(nodes.length, new Set(nodes.map((node) => node.ref)).size)
  assert.equal(edges.length, new Set(edges.map((edge) => edge.id)).size)
  assert.equal(nodes.length, 5)
  assert.equal(edges.length, 5)
  assert.ok(edges.some((edge) => edge.fromRef === paperRef && edge.toRef === proofNodeRef))
})

test("rejects unknown keys throughout the input contract", () => {
  const top = fixture()
  top.hidden = true
  assert.throws(() => projectUnifiedGraph(top), /input.hidden is not part/u)

  const relation = fixture()
  relation.relations[0].relation.hidden = true
  assert.throws(() => projectUnifiedGraph(relation), /relation.hidden is not part/u)

  const resolution = fixture()
  resolution.external[0].resolution.hidden = true
  assert.throws(() => projectUnifiedGraph(resolution), /resolution.hidden is not part/u)

  const proof = fixture()
  proof.proofContexts[0].hidden = true
  assert.throws(() => projectUnifiedGraph(proof), /proofContexts\[0\].hidden is not part/u)
})

test("deduplicates identical relations and reports dangling edges without inventing nodes", () => {
  const input = fixture()
  input.relations.push(structuredClone(input.relations[0]))
  input.relations.push({
    scope,
    relation: {
      fromRef: paperRef,
      toRef: ref("artifact", "missing"),
      relation: "references",
      trust: "structure",
      source: { provider: "importer" },
    },
  })
  const graph = projectUnifiedGraph(input)
  assert.equal(graph.edges.length, 5)
  assert.equal(graph.provenance.diagnostics.danglingEdges, 1)
})
