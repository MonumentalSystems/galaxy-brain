import assert from "node:assert/strict"
import test from "node:test"

import {
  deterministicGraphFallback,
  GRAPH_LAYOUT_FORCE_LIMIT,
  GRAPH_LAYOUT_NODE_LIMIT,
  normalizeGraphLayoutRequest,
} from "../lib/graph-layout-client.js"

function request(nodes = [
  { id: "project", layer: 0 },
  { id: "task", layer: 1 },
]) {
  return {
    schemaId: "gb.graph-layout.v1",
    projectionHash: "sha256:fixture",
    scale: "project",
    nodes,
    edges: nodes.length > 1 ? [{ source: nodes[0].id, target: nodes[1].id }] : [],
  }
}

test("fallback layout is deterministic and keyed by projection plus semantic scale", () => {
  const first = deterministicGraphFallback(request())
  const second = deterministicGraphFallback(request().nodes.reverse() && request())
  assert.equal(first.key, "sha256:fixture:project")
  assert.deepEqual(first, second)
  assert.equal(first.mode, "fallback")
})

test("layout request rejects duplicate nodes and dangling or self edges", () => {
  assert.throws(() => normalizeGraphLayoutRequest(request([{ id: "same" }, { id: "same" }])), /duplicate id/)
  assert.throws(() => normalizeGraphLayoutRequest({
    ...request([{ id: "only" }]),
    edges: [{ source: "only", target: "missing" }],
  }), /invalid endpoints/)
  assert.throws(() => normalizeGraphLayoutRequest({
    ...request([{ id: "only" }]),
    edges: [{ source: "only", target: "only" }],
  }), /invalid endpoints/)
})

test("layout request is bounded independently of the graph source", () => {
  const nodes = Array.from({ length: GRAPH_LAYOUT_NODE_LIMIT + 1 }, (_, index) => ({ id: `node-${index}` }))
  assert.throws(() => normalizeGraphLayoutRequest(request(nodes)), /at most/)
  assert.ok(GRAPH_LAYOUT_FORCE_LIMIT < GRAPH_LAYOUT_NODE_LIMIT)
})

test("fallback remains finite for the largest non-force field", () => {
  const nodes = Array.from({ length: GRAPH_LAYOUT_NODE_LIMIT }, (_, index) => ({ id: `node-${index}`, layer: index % 6 }))
  const result = deterministicGraphFallback({ ...request(nodes), edges: [] })
  assert.equal(Object.keys(result.positions).length, GRAPH_LAYOUT_NODE_LIMIT)
  for (const point of Object.values(result.positions)) {
    assert.equal(Number.isFinite(point.x), true)
    assert.equal(Number.isFinite(point.y), true)
  }
})
