import assert from "node:assert/strict"
import test from "node:test"

import {
  createWorkspaceProjectionCollections,
  filterNodesForWorkspace,
  scopeGraphToWorkspace,
} from "../lib/workspace-node-scope.js"
import { resolveWorkspaceView } from "../lib/workspace-view.js"

test("workspace projection includes descendants but excludes foreign, orphaned, and cyclic nodes", () => {
  const nodes = [
    { id: "root-a", parentId: null },
    { id: "folder-a", parentId: "root-a" },
    { id: "note-a", parentId: "folder-a" },
    { id: "root-b", parentId: null },
    { id: "note-b", parentId: "root-b" },
    { id: "orphan", parentId: "missing" },
    { id: "cycle-1", parentId: "cycle-2" },
    { id: "cycle-2", parentId: "cycle-1" },
  ]

  assert.deepEqual(
    filterNodesForWorkspace(nodes, "root-a").map((node) => node.id),
    ["root-a", "folder-a", "note-a"],
  )
})

test("explicit URL view wins, then the saved default, then the feature fallback", () => {
  const allowedViewModes = ["field", "canvas", "graph", "list"]

  assert.equal(resolveWorkspaceView({ requestedView: "graph", preferredView: "list", allowedViewModes, fallbackView: "field" }), "graph")
  assert.equal(resolveWorkspaceView({ requestedView: null, preferredView: "list", allowedViewModes, fallbackView: "field" }), "list")
  assert.equal(resolveWorkspaceView({ requestedView: "invalid", preferredView: "invalid", allowedViewModes, fallbackView: "field" }), "field")
})

test("List type filters never narrow the Field projection", () => {
  const nodes = [
    { id: "root-a", parentId: null, type: "folder", updatedAt: new Date("2026-01-01T00:00:00Z") },
    { id: "note-a", parentId: "root-a", type: "note", updatedAt: new Date("2026-01-04T00:00:00Z") },
    { id: "document-a", parentId: "root-a", type: "document", updatedAt: new Date("2026-01-03T00:00:00Z") },
    { id: "workflow-a", parentId: "root-a", type: "ai-workflow", updatedAt: new Date("2026-01-02T00:00:00Z") },
    { id: "root-b", parentId: null, type: "folder", updatedAt: new Date("2026-01-01T00:00:00Z") },
    { id: "note-b", parentId: "root-b", type: "note", updatedAt: new Date("2026-01-05T00:00:00Z") },
  ]

  const { fieldNodes, listNodes } = createWorkspaceProjectionCollections(nodes, "root-a", "note")

  assert.deepEqual(fieldNodes.map((node) => node.id), ["note-a", "document-a", "workflow-a"])
  assert.deepEqual(listNodes.map((node) => node.id), ["note-a"])
})

test("the Field cap favors the most recently updated workspace nodes", () => {
  const nodes = [
    { id: "root-a", parentId: null, type: "folder", updatedAt: new Date("2026-01-01T00:00:00Z") },
    ...Array.from({ length: 19 }, (_, index) => ({
      id: `note-${index}`,
      parentId: "root-a",
      type: "note",
      updatedAt: new Date(Date.UTC(2026, 0, index + 1)),
    })),
  ]

  const { fieldNodes } = createWorkspaceProjectionCollections(nodes, "root-a", "all")
  const cappedFieldIds = fieldNodes.slice(0, 18).map((node) => node.id)

  assert.equal(cappedFieldIds[0], "note-18")
  assert.ok(cappedFieldIds.includes("note-18"))
  assert.ok(!cappedFieldIds.includes("note-0"))
})

test("a scoped graph drops edges that leave the workspace", () => {
  const nodes = [
    { id: "root-a", parentId: null },
    { id: "note-a", parentId: "root-a" },
    { id: "note-a2", parentId: "root-a" },
    { id: "root-b", parentId: null },
    { id: "note-b", parentId: "root-b" },
  ]
  const edges = [
    { source: "note-a", target: "note-a2" },
    { source: "note-a", target: "note-b" },
    { source: "note-b", target: "note-a" },
    { source: "note-a", target: "missing" },
  ]

  const scoped = scopeGraphToWorkspace(nodes, edges, "root-a")

  assert.deepEqual(scoped.nodes.map((n) => n.id), ["root-a", "note-a", "note-a2"])
  assert.deepEqual(
    scoped.edges.map((e) => `${e.source}->${e.target}`),
    ["note-a->note-a2"],
  )
})

test("an unscoped graph keeps every node and edge", () => {
  const nodes = [{ id: "a", parentId: null }, { id: "b", parentId: "a" }]
  const edges = [{ source: "a", target: "b" }]

  const scoped = scopeGraphToWorkspace(nodes, edges, "a")
  assert.deepEqual(scoped.nodes.map((n) => n.id), ["a", "b"])
  assert.deepEqual(scoped.edges.length, 1)
})
