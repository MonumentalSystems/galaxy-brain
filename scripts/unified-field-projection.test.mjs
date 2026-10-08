import assert from "node:assert/strict"
import test from "node:test"

import { projectUnifiedGraphToSemanticField } from "../lib/unified-field-projection.js"

const ref = (kind, id) => `gb:object:v1:${kind}:${encodeURIComponent(id)}:latest`

function node(kind, id, title = id) {
  const reference = ref(kind, id)
  return {
    id: `node-${id}`,
    ref: reference,
    kind,
    title,
    authority: "galaxy",
    projection: {},
    provenance: [{ provider: "galaxy", sourceId: id, sourceRevision: "r1" }],
    overlays: {},
  }
}

function edge(id, from, to, relation, trust = "structure") {
  return {
    id,
    from: `node-${from}`,
    to: `node-${to}`,
    fromRef: from,
    toRef: to,
    relation,
    trust,
    source: { provider: "galaxy", recordId: id, revision: "r1" },
  }
}

function projection() {
  const paper = node("paper", "paper-1", "Paper")
  const document = node("document", "document-1", "Document")
  const anchor = node("document.anchor", "anchor-1", "Equation 3.2")
  const task = node("ham.task", "task-1", "Check the equation")
  const chunk = node("document.chunk", "chunk-1", "Private derived chunk")
  const unknown = node("provider.unknown", "unknown-1", "Unknown provider shape")
  return {
    schemaId: "gb.graph-projection.v1",
    query: {},
    projectionHash: "hash",
    nodes: [paper, document, anchor, task, chunk, unknown],
    edges: [
      edge("e1", document.ref, anchor.ref, "contains"),
      edge("e2", task.ref, anchor.ref, "coordinated_by", "assertion"),
      edge("e3", paper.ref, document.ref, "corresponds_to", "assertion"),
      edge("e4", chunk.ref, document.ref, "contains"),
    ],
    aggregates: {},
    provenance: {
      providers: [
        { provider: "galaxy.paper", status: "partial" },
        { provider: "galaxy.document", status: "ready" },
        { provider: "generous.a2ui", status: "unavailable" },
      ],
    },
    continuation: { cursor: null, hasMore: false, omitted: { nodes: 0, edges: 0, fanout: 0 }, reasons: [] },
  }
}

test("adapts the strict unified graph without loading or mutating source data", () => {
  const graph = projection()
  const before = JSON.stringify(graph)
  const field = projectUnifiedGraphToSemanticField(graph)

  assert.equal(JSON.stringify(graph), before)
  assert.equal(field.entities.length, 4)
  assert.equal(field.relations.length, 3)
  assert.ok(field.entities.every((entity) => entity.sourceReference.startsWith("gb:object:v1:")))
  assert.deepEqual(field.entities.find((entity) => entity.kind === "document")?.sources, [
    { provider: "galaxy", recordId: "document-1", revision: "r1" },
  ])
  assert.equal(field.relations.find((relation) => relation.kind === "coordinated_by")?.basis, "authored_assertion")
  assert.equal(field.truncation.omittedDerivedNodes, 1)
  assert.equal(field.truncation.omittedUnsupportedNodes, 1)
  assert.deepEqual(field.incompleteProviders, [
    { provider: "galaxy.paper", status: "partial" },
    { provider: "generous.a2ui", status: "unavailable" },
  ])
  assert.ok(!field.entities.some((entity) => entity.sourceKind === "document.chunk"))
  assert.ok(!field.entities.some((entity) => entity.sourceKind === "provider.unknown"))
})

test("prioritizes the exact focus and incident neighborhood while keeping edges endpoint-closed", () => {
  const graph = projection()
  const anchorRef = ref("document.anchor", "anchor-1")
  const field = projectUnifiedGraphToSemanticField(graph, {
    focusReference: anchorRef,
    maxNodes: 3,
    maxEdges: 20,
    maxFanout: 20,
  })

  assert.equal(field.entities[0].sourceReference, anchorRef)
  assert.deepEqual(new Set(field.entities.map((entity) => entity.sourceKind)), new Set(["document.anchor", "document", "ham.task"]))
  const entityIds = new Set(field.entities.map((entity) => entity.id))
  assert.ok(field.relations.every((relation) => entityIds.has(relation.from) && entityIds.has(relation.to)))
  assert.deepEqual(field.relations.map((relation) => relation.kind), ["contains", "coordinated_by"])
  assert.equal(field.truncation.nodeLimitReached, true)
})

test("fails closed for anything other than the authorized unified graph contract", () => {
  assert.throws(
    () => projectUnifiedGraphToSemanticField({ schemaId: "gb.surface.v1", nodes: [], edges: [] }),
    /authorized gb\.graph-projection\.v1/u,
  )
})

test("reports fanout clipping as relation truncation", () => {
  const graph = projection()
  const field = projectUnifiedGraphToSemanticField(graph, { maxNodes: 20, maxEdges: 20, maxFanout: 1 })

  assert.ok(field.truncation.fanoutOmissions > 0)
  assert.equal(field.truncation.edgeLimitReached, true)
})

test("keeps saved Task Plans and their atomic jobs visible as task-shaped field objects", () => {
  const plan = node("task-plan", "plan-1", "Saved plan")
  const job = node("task-plan.job", "plan-1/research", "Research")
  const graph = {
    ...projection(),
    nodes: [plan, job],
    edges: [edge("plan-job", plan.ref, job.ref, "contains")],
  }
  const field = projectUnifiedGraphToSemanticField(graph)

  assert.deepEqual(field.entities.map((entity) => [entity.sourceKind, entity.kind]), [
    ["task-plan", "task"],
    ["task-plan.job", "task"],
  ])
  assert.equal(field.relations[0].kind, "contains")
})
