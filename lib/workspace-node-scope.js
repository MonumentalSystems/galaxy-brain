/**
 * Return only nodes rooted in the selected workspace hierarchy.
 *
 * The root folder itself is included so callers can decide whether to render it.
 * Orphans and cycles are excluded instead of being treated as global objects.
 *
 * @template {{ id: string, parentId?: string | null }} T
 * @param {T[]} nodes
 * @param {string} rootFolderId
 * @returns {T[]}
 */
export function filterNodesForWorkspace(nodes, rootFolderId) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]))

  return nodes.filter((node) => {
    if (node.id === rootFolderId) return true

    const visited = new Set([node.id])
    let parentId = node.parentId

    while (parentId) {
      if (parentId === rootFolderId) return true
      if (visited.has(parentId)) return false
      visited.add(parentId)

      const parent = nodesById.get(parentId)
      if (!parent) return false
      parentId = parent.parentId
    }

    return false
  })
}

/**
 * Keep projection-local filters from changing the Field's canonical workspace set.
 *
 * @template {{ id: string, parentId?: string | null, type: string, updatedAt: Date }} T
 * @param {T[]} nodes
 * @param {string} rootFolderId
 * @param {string} listTypeFilter
 * @returns {{ fieldNodes: T[], listNodes: T[] }}
 */
export function createWorkspaceProjectionCollections(nodes, rootFolderId, listTypeFilter) {
  const fieldNodes = filterNodesForWorkspace(nodes, rootFolderId)
    .filter((node) => node.type !== "folder")
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  const listNodes = fieldNodes
    .filter((node) => listTypeFilter === "all" || node.type === listTypeFilter)

  return { fieldNodes, listNodes }
}

/**
 * Scope a knowledge graph to one workspace.
 *
 * Nodes are scoped by the usual hierarchy walk; an edge survives only when
 * both of its endpoints do, so the graph never renders an edge dangling to a
 * node outside the workspace.
 *
 * @template {{ id: string, parentId?: string | null }} N
 * @template {{ source: string, target: string }} E
 * @param {N[]} nodes
 * @param {E[]} edges
 * @param {string} rootFolderId
 * @returns {{ nodes: N[], edges: E[] }}
 */
export function scopeGraphToWorkspace(nodes, edges, rootFolderId) {
  const scopedNodes = filterNodesForWorkspace(nodes, rootFolderId)
  const nodeIds = new Set(scopedNodes.map((node) => node.id))

  return {
    nodes: scopedNodes,
    edges: edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
  }
}
