function endpointField(endpoint, sourceField, targetField) {
  if (endpoint === "source") return sourceField
  if (endpoint === "target") return targetField
  return null
}

function endpointLabel(display) {
  return typeof display?.title === "string" && display.title.trim()
    ? display.title.trim()
    : "Unavailable reference"
}

/**
 * Resolve an endpoint only through the current runtime edge anchor and node.
 * Edge IDs are deliberately opaque and are never parsed for identity.
 */
export function resolveAtlasRuntimeRelationEndpoint(edge, endpoint, getNode) {
  if (!edge || edge.data?.schemaId !== "gb.canvas.relation.v1" || typeof getNode !== "function") return null
  if (edge.source?.nodeId === edge.target?.nodeId) return null
  const anchor = endpointField(endpoint, edge.source, edge.target)
  if (!anchor || typeof anchor.nodeId !== "string" || !anchor.nodeId) return null
  const node = getNode(anchor.nodeId)
  if (!node || node.id !== anchor.nodeId || node.data?.schemaId !== "gb.canvas.node.v1") return null
  if (node.data.availability !== "resolved") return null
  if (typeof node.data.placementId !== "string" || !node.data.placementId) return null
  return Object.freeze({
    nodeId: node.id,
    placementId: node.data.placementId,
    label: endpointLabel(node.data.display),
  })
}

/**
 * Resolve an accessible-list endpoint only through the authorized projection's
 * explicit placement identity. Missing or mismatched placements fail closed.
 */
export function resolveAtlasProjectedRelationEndpoint(relation, endpoint, getPlacements) {
  if (!relation || typeof getPlacements !== "function") return null
  if (relation.sourcePlacementId === relation.targetPlacementId) return null
  const placementId = endpointField(
    endpoint,
    relation.sourcePlacementId,
    relation.targetPlacementId,
  )
  if (typeof placementId !== "string" || !placementId) return null
  const matches = getPlacements(placementId)
  if (!Array.isArray(matches) || matches.length !== 1) return null
  const [placement] = matches
  if (!placement || placement.id !== placementId) return null
  if (placement.authorized !== true || placement.availability === "unavailable") return null
  return Object.freeze({
    placementId,
    label: endpointLabel(placement.display),
  })
}
