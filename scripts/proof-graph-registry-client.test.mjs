import assert from "node:assert/strict"
import test from "node:test"

import {
  createProofGraphSelection,
  normalizeProofGraphList,
  normalizeProofWorkspaceList,
  proofGraphSelectionUrl,
} from "../lib/proof-graph-registry-client.js"

const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)

function summary(overrides = {}) {
  return {
    schemaId: "gb.proof-graph.summary.v1",
    registrationId: "registration-a",
    graphId: "graph-a",
    graphKind: "mission",
    title: "Mission A",
    contentSha256: HASH_A,
    byteSize: 42,
    targetCount: 3,
    relationCount: 2,
    registeredByPrincipalId: "principal-a",
    registeredByNostrPubkey: "c".repeat(64),
    registeredAt: "2026-09-23T12:00:00Z",
    ...overrides,
  }
}

function workspaceList(overrides = {}) {
  return {
    schemaId: "galaxy.proof-workspace-summary-list.v1",
    graph_ref: { graph_id: "graph-a", content_sha256: HASH_A },
    workspaces: [{
      workspace_id: "workspace-a",
      version: 4,
      updated_at: "2026-09-23T12:30:00Z",
      item_count: 3,
    }],
    has_more: false,
    next_offset: null,
    ...overrides,
  }
}

test("registry lists normalize only the strict bounded immutable-summary contract", () => {
  const normalized = normalizeProofGraphList({
    schemaId: "gb.proof-graph.list.v1",
    graphs: [summary()],
    hasMore: true,
    nextOffset: 1,
  })
  assert.equal(normalized.graphs[0].contentSha256, HASH_A)
  assert.equal(normalized.nextOffset, 1)
  assert.ok(Object.isFrozen(normalized))
  assert.ok(Object.isFrozen(normalized.graphs))
  assert.throws(() => normalizeProofGraphList({
    schemaId: "gb.proof-graph.list.v1",
    graphs: [summary(), summary({ registrationId: "registration-b" })],
    hasMore: false,
    nextOffset: null,
  }), /duplicate immutable revisions/u)
  assert.throws(() => normalizeProofGraphList({
    schemaId: "gb.proof-graph.list.v1",
    graphs: [],
    hasMore: true,
    nextOffset: null,
  }), /pagination state is inconsistent/u)
  assert.throws(() => normalizeProofGraphList({
    schemaId: "gb.proof-graph.list.v1",
    graphs: [],
    hasMore: false,
    nextOffset: null,
    unexpected: true,
  }), /not part of the contract/u)
})

test("workspace lists stay pinned to one exact immutable graph revision", () => {
  const expected = { graphId: "graph-a", contentSha256: HASH_A }
  const normalized = normalizeProofWorkspaceList(workspaceList(), expected)
  assert.deepEqual(normalized.graphRef, expected)
  assert.equal(normalized.workspaces[0].workspaceId, "workspace-a")
  assert.throws(() => normalizeProofWorkspaceList(workspaceList({
    graph_ref: { graph_id: "graph-a", content_sha256: HASH_B },
  }), expected), /does not match the selected immutable graph/u)
  assert.throws(() => normalizeProofWorkspaceList(workspaceList({
    workspaces: [workspaceList().workspaces[0], workspaceList().workspaces[0]],
  }), expected), /duplicate identifiers/u)
  assert.throws(() => normalizeProofWorkspaceList(workspaceList({
    workspaces: [{ ...workspaceList().workspaces[0], extra: "drift" }],
  }), expected), /not part of the contract/u)
})

test("repository-field registrations remain passive even when an overlay is supplied", () => {
  const registered = summary({ graphKind: "repository-field" })
  const proofDag = { schema_id: "galaxy.proof-dag.v1", graph_id: "graph-a", graph_kind: "repository-field" }
  const passive = createProofGraphSelection({
    summary: registered,
    proofDag,
    exactBytes: new Uint8Array(42),
  })
  assert.equal(passive.coordinationActive, false)
  assert.equal(passive.workspace, null)
  assert.equal(passive.workState, null)
  assert.throws(() => createProofGraphSelection({
    summary: registered,
    proofDag,
    exactBytes: new Uint8Array(42),
    workspace: { workspaceId: "workspace-a", version: 1, updatedAt: "2026-09-23T12:00:00Z", itemCount: 0 },
    workState: {
      schema_id: "galaxy.proof-work-state.v1",
      workspace_id: "workspace-a",
      graph_ref: { graph_id: "graph-a", content_sha256: HASH_A },
    },
  }), /repository-field graphs are passive/u)
})

test("active selections require the workspace and overlay to bind to the same graph and workspace", () => {
  const registered = summary()
  const proofDag = { schema_id: "galaxy.proof-dag.v1", graph_id: "graph-a", graph_kind: "mission" }
  const workspace = { workspaceId: "workspace-a", version: 1, updatedAt: "2026-09-23T12:00:00Z", itemCount: 3 }
  const workState = {
    schema_id: "galaxy.proof-work-state.v1",
    workspace_id: "workspace-a",
    graph_ref: { graph_id: "graph-a", content_sha256: HASH_A },
  }
  const active = createProofGraphSelection({
    summary: registered,
    proofDag,
    exactBytes: new Uint8Array(42),
    workspace,
    workState,
  })
  assert.equal(active.coordinationActive, true)
  assert.equal(active.workspace.workspaceId, "workspace-a")
  assert.throws(() => createProofGraphSelection({
    summary: registered,
    proofDag,
    exactBytes: new Uint8Array(42),
    workspace,
    workState: { ...workState, workspace_id: "workspace-b" },
  }), /does not match the selected workspace/u)
  assert.throws(() => createProofGraphSelection({
    summary: registered,
    proofDag,
    exactBytes: new Uint8Array(42),
    workspace,
    workState: { ...workState, graph_ref: { graph_id: "graph-a", content_sha256: HASH_B } },
  }), /not bound to the selected immutable graph/u)
  assert.throws(() => createProofGraphSelection({
    summary: registered,
    proofDag,
    exactBytes: new Uint8Array(42),
    workspace,
  }), /must be selected together/u)
})

test("changing the URL graph selection clears a workspace from the previous graph", () => {
  const current = `https://galaxy.example/graph?proofGraph=${HASH_A}&proofWorkspace=workspace-a&view=graph`
  const switched = new URL(proofGraphSelectionUrl(current, { contentSha256: HASH_B, workspaceId: null }))
  assert.equal(switched.searchParams.get("proofGraph"), HASH_B)
  assert.equal(switched.searchParams.has("proofWorkspace"), false)
  assert.equal(switched.searchParams.get("view"), "graph")
  const cleared = new URL(proofGraphSelectionUrl(switched, null))
  assert.equal(cleared.searchParams.has("proofGraph"), false)
  assert.equal(cleared.searchParams.has("proofWorkspace"), false)
})
