import assert from "node:assert/strict"
import test from "node:test"

import {
  createGraphWindowRequest,
  parseGraphWindowResponse,
} from "./graph-window-contract.js"

const cluster = Object.freeze({
  id: `gwc:${"a".repeat(64)}`,
  provider: "galaxy.document",
  kind: "document",
  label: "Documents",
  count: 1,
  countStatus: "exact",
  expandable: true,
  bounds: { x: 0, y: 0, width: 240, height: 150 },
})

function response(request) {
  return {
    schemaId: "gb.graph-window.v1",
    consistency: "follow-latest",
    query: Object.fromEntries(Object.entries(request).filter(([key]) => key !== "schemaId")),
    windowHash: "b".repeat(64),
    clusters: [cluster],
    members: request.expandClusterId ? [{
      ref: `gb:object:v1:document:50000000-0000-4000-8000-000000000001:pinned:sha256%3A${"c".repeat(64)}`,
      clusterId: cluster.id,
      provider: cluster.provider,
      kind: cluster.kind,
      title: "Exact document",
      updatedAt: "2026-09-25T12:00:00Z",
    }] : [],
    edges: [],
    focus: request.rootRef ? { ref: request.rootRef } : null,
    providers: [{ provider: "galaxy.document", status: "ready", count: 1 }],
    provenance: {
      workspaceId: "tenant-catalog",
      source: "tenant-scoped PostgreSQL aggregate window",
      memberReferences: "exact-pinned-only",
    },
    continuation: { cursor: null, hasMore: false, model: "replace-page" },
  }
}

test("creates the fixed corpus window request", () => {
  assert.deepEqual(createGraphWindowRequest(), {
    schemaId: "gb.graph-window-request.v1",
    workspaceId: "tenant-catalog",
    mode: "mixed",
    lens: "explore",
    scale: "corpus",
    viewport: null,
    filters: { kinds: [], relations: [] },
    rootRef: null,
    expandClusterId: null,
    cursor: null,
  })
  assert.throws(() => createGraphWindowRequest({ mode: "citation" }), /mode is unsupported/)
  assert.doesNotThrow(() => createGraphWindowRequest({
    viewport: { x: 1_000_000, y: -1_000_000, width: 1, height: 1 },
  }))
  assert.throws(() => createGraphWindowRequest({
    viewport: { x: 1_000_001, y: 0, width: 1, height: 1 },
  }), /outside the supported field/)
})

test("accepts only exact pinned members of the selected aggregate", () => {
  const request = createGraphWindowRequest({ expandClusterId: cluster.id })
  const parsed = parseGraphWindowResponse(response(request), request)
  assert.equal(parsed.members.length, 1)
  assert.match(parsed.members[0].ref, /:pinned:/)

  const mutable = response(request)
  mutable.members[0].ref = "gb:object:v1:document:50000000-0000-4000-8000-000000000001:latest"
  assert.throws(() => parseGraphWindowResponse(mutable, request), /exact and pinned/)
})

test("rejects a response for a different query", () => {
  const request = createGraphWindowRequest()
  const changed = response(request)
  changed.query.mode = "citation"
  assert.throws(() => parseGraphWindowResponse(changed, request), /unsupported|does not match/)
})

test("round-trips one exact proof graph as authorized corpus context", () => {
  const proofReference = `gb:object:v1:proof.graph:winding-prototime:pinned:sha256%3A${"d".repeat(64)}`
  const request = createGraphWindowRequest({ rootRef: proofReference })
  const parsed = parseGraphWindowResponse(response(request), request)
  assert.equal(parsed.query.rootRef, proofReference)
  assert.deepEqual(parsed.focus, { ref: proofReference })

  const changed = response(request)
  changed.focus.ref = `gb:object:v1:proof.graph:other:pinned:sha256%3A${"e".repeat(64)}`
  assert.throws(() => parseGraphWindowResponse(changed, request), /focus does not match/u)

  const omitted = response(request)
  omitted.focus = null
  assert.throws(() => parseGraphWindowResponse(omitted, request), /focus does not match/u)
})

test("rejects unbounded members and invented aggregate edges", () => {
  const request = createGraphWindowRequest({ expandClusterId: cluster.id })
  const tooMany = response(request)
  tooMany.members = Array.from({ length: 201 }, () => tooMany.members[0])
  assert.throws(() => parseGraphWindowResponse(tooMany, request), /members are not bounded/)

  const edge = response(request)
  edge.edges = [{ from: cluster.id, to: cluster.id }]
  assert.throws(() => parseGraphWindowResponse(edge, request), /does not emit aggregate edges/)
})

test("rejects duplicate and open-ended provider metadata", () => {
  const request = createGraphWindowRequest()
  const duplicate = response(request)
  duplicate.providers.push({ ...duplicate.providers[0] })
  assert.throws(() => parseGraphWindowResponse(duplicate, request), /providers contain duplicates/)

  const openEnded = response(request)
  openEnded.providers[0].debug = "not part of the wire contract"
  assert.throws(() => parseGraphWindowResponse(openEnded, request), /providers\[0\] is invalid/)
})
