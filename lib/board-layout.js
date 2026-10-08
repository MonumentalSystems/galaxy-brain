/**
 * A research board is a layout over nodes, not a container that owns them.
 *
 * The same KnowledgeNodes that sit on the canvas can be read as columns, a
 * grid, or left where they were placed. Adding a card to a board therefore
 * means creating a node, which already works, and a clipped figure can be
 * dropped onto a board without becoming a different kind of object.
 */

export const BOARD_LAYOUTS = ["columns", "grid", "freeform"]

/** Where a node's column assignment lives, when it has one. */
const COLUMN_KEY = "boardColumn"
const ORDER_KEY = "boardOrder"

export const UNSORTED_COLUMN = "Unsorted"

export function isBoardLayout(value) {
  return typeof value === "string" && BOARD_LAYOUTS.includes(value)
}

/**
 * The column a node belongs to. Nodes that have never been sorted collect in a
 * single named column rather than vanishing, so a board always accounts for
 * everything on it.
 */
export function nodeColumn(node) {
  const raw = node?.metadata?.[COLUMN_KEY]
  if (typeof raw !== "string") return UNSORTED_COLUMN
  const trimmed = raw.trim()
  return trimmed || UNSORTED_COLUMN
}

function nodeOrder(node) {
  const raw = node?.metadata?.[ORDER_KEY]
  return typeof raw === "number" && Number.isFinite(raw) ? raw : Number.MAX_SAFE_INTEGER
}

/** Newest last within a column, so a board reads in the order work happened. */
function byOrderThenAge(a, b) {
  const order = nodeOrder(a) - nodeOrder(b)
  if (order !== 0) return order
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
}

/**
 * Groups nodes into columns for the kanban reading of a board.
 *
 * @param nodes the board's nodes
 * @param columnNames columns to show even when empty, in the order given
 * @returns [{ name, nodes }] with the declared columns first
 */
export function groupIntoColumns(nodes, columnNames = []) {
  const columns = new Map()
  for (const name of columnNames) columns.set(name, [])

  for (const node of nodes) {
    const name = nodeColumn(node)
    if (!columns.has(name)) columns.set(name, [])
    columns.get(name).push(node)
  }

  // An empty Unsorted column is noise; a declared empty column is a drop target.
  if (columns.get(UNSORTED_COLUMN)?.length === 0 && !columnNames.includes(UNSORTED_COLUMN)) {
    columns.delete(UNSORTED_COLUMN)
  }

  return Array.from(columns, ([name, columnNodes]) => ({
    name,
    nodes: columnNodes.sort(byOrderThenAge),
  }))
}

/**
 * The metadata patch that moves a node into a column. Returned rather than
 * applied so the caller owns persistence.
 */
export function assignToColumn(column, order) {
  const patch = { [COLUMN_KEY]: column === UNSORTED_COLUMN ? "" : column }
  if (typeof order === "number" && Number.isFinite(order)) patch[ORDER_KEY] = order
  return patch
}

/** Nodes belonging to a board, which is any node parented to it. */
export function boardNodes(nodes, boardId) {
  return nodes.filter((node) => node.parentId === boardId)
}
