import assert from "node:assert/strict"
import test from "node:test"

import {
  assignToColumn,
  boardNodes,
  BOARD_LAYOUTS,
  groupIntoColumns,
  isBoardLayout,
  nodeColumn,
  UNSORTED_COLUMN,
} from "../lib/board-layout.js"

const node = (id, overrides = {}) => ({
  id,
  type: "note",
  title: id,
  content: "",
  tags: [],
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
})

test("a board is the nodes parented to it", () => {
  const nodes = [
    node("a", { parentId: "board-1" }),
    node("b", { parentId: "board-2" }),
    node("c", { parentId: "board-1" }),
    node("d"),
  ]
  assert.deepEqual(boardNodes(nodes, "board-1").map((n) => n.id), ["a", "c"])
})

test("unsorted nodes collect rather than disappear", () => {
  const columns = groupIntoColumns([node("a"), node("b")])
  assert.equal(columns.length, 1)
  assert.equal(columns[0].name, UNSORTED_COLUMN)
  assert.deepEqual(columns[0].nodes.map((n) => n.id), ["a", "b"])
})

test("declared columns come first and survive being empty", () => {
  const nodes = [node("a", { metadata: { boardColumn: "Doing" } })]
  const columns = groupIntoColumns(nodes, ["Todo", "Doing", "Done"])

  assert.deepEqual(columns.map((c) => c.name), ["Todo", "Doing", "Done"])
  assert.deepEqual(columns[0].nodes, [], "an empty declared column is a drop target")
  assert.deepEqual(columns[1].nodes.map((n) => n.id), ["a"])
})

test("an empty Unsorted column is dropped, a declared one is kept", () => {
  const sorted = [node("a", { metadata: { boardColumn: "Doing" } })]
  assert.deepEqual(
    groupIntoColumns(sorted, ["Doing"]).map((c) => c.name),
    ["Doing"],
    "nothing is unsorted, so no Unsorted column",
  )
  assert.ok(
    groupIntoColumns(sorted, [UNSORTED_COLUMN, "Doing"]).some((c) => c.name === UNSORTED_COLUMN),
    "but an explicitly declared Unsorted column stays",
  )
})

test("a column that only exists on a node still appears", () => {
  const columns = groupIntoColumns([node("a", { metadata: { boardColumn: "Evidence" } })], ["Todo"])
  assert.deepEqual(columns.map((c) => c.name), ["Todo", "Evidence"])
})

test("cards order by explicit order, then by age", () => {
  const nodes = [
    node("third", { metadata: { boardOrder: 3 } }),
    node("first", { metadata: { boardOrder: 1 } }),
    node("newest", { createdAt: new Date("2026-06-01T00:00:00Z") }),
    node("oldest", { createdAt: new Date("2025-01-01T00:00:00Z") }),
  ]
  // Unordered cards sink below ordered ones and read oldest first.
  assert.deepEqual(
    groupIntoColumns(nodes)[0].nodes.map((n) => n.id),
    ["first", "third", "oldest", "newest"],
  )
})

test("blank or non-string column metadata reads as unsorted", () => {
  assert.equal(nodeColumn(node("a")), UNSORTED_COLUMN)
  assert.equal(nodeColumn(node("a", { metadata: {} })), UNSORTED_COLUMN)
  assert.equal(nodeColumn(node("a", { metadata: { boardColumn: "   " } })), UNSORTED_COLUMN)
  assert.equal(nodeColumn(node("a", { metadata: { boardColumn: 7 } })), UNSORTED_COLUMN)
  assert.equal(nodeColumn(node("a", { metadata: { boardColumn: " Doing " } })), "Doing")
})

test("assigning to a column returns a patch rather than mutating", () => {
  assert.deepEqual(assignToColumn("Doing", 2), { boardColumn: "Doing", boardOrder: 2 })
  assert.deepEqual(assignToColumn("Doing"), { boardColumn: "Doing" }, "order is optional")
  assert.deepEqual(
    assignToColumn(UNSORTED_COLUMN),
    { boardColumn: "" },
    "returning to unsorted clears the column",
  )
})

test("only the known layouts are accepted", () => {
  for (const layout of BOARD_LAYOUTS) assert.equal(isBoardLayout(layout), true)
  for (const bad of ["kanban", "", null, undefined, 3]) assert.equal(isBoardLayout(bad), false)
})
