import { normalizeCanvasSnapshot } from "./canvas-snapshot.js"

function placementMap(projection) {
  return new Map(projection.placements.map((placement) => [placement.id, placement]))
}

function unavailablePlacement(item) {
  return {
    id: item.id,
    authorized: false,
    availability: "unavailable",
    subjectRef: item.subjectRef,
    nodeType: item.nodeType,
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    angle: item.angle,
    zIndex: item.zIndex,
    displayMode: item.displayMode,
    collapsed: item.collapsed,
    style: item.style,
  }
}

export function mergeCanvasSnapshot(projection, snapshot) {
  const content = normalizeCanvasSnapshot(snapshot)
  const durable = new Map(content.items.map((item) => [item.id, item]))
  const activeDurableSubjectRefs = new Set(content.items.map((item) => item.subjectRef))
  const removedItems = new Set(content.removedItemIds)
  const removedEdges = new Set(content.removedEdgeIds)
  const livePlacementIds = new Set()
  const placements = projection.placements
    .filter((placement) => (
      !removedItems.has(placement.id) &&
      (
        durable.has(placement.id) ||
        !activeDurableSubjectRefs.has(placement.subjectRef)
      )
    ))
    .map((placement) => {
      const item = durable.get(placement.id)
      if (!item) {
        livePlacementIds.add(placement.id)
        return placement
      }
      if (item.subjectRef !== placement.subjectRef || item.nodeType !== placement.nodeType) {
        return unavailablePlacement(item)
      }
      livePlacementIds.add(placement.id)
      return {
        ...placement,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        angle: item.angle,
        zIndex: item.zIndex,
        displayMode: item.displayMode,
        collapsed: item.collapsed,
        style: item.style,
      }
    })
  const projectedIds = new Set(placements.map((placement) => placement.id))
  for (const item of content.items) {
    if (removedItems.has(item.id) || projectedIds.has(item.id)) continue
    placements.push(unavailablePlacement(item))
  }
  const placementIds = new Set(placements.map((placement) => placement.id))
  const relations = new Map(
    projection.relations
      .filter((relation) => (
        !removedEdges.has(relation.id) &&
        livePlacementIds.has(relation.sourcePlacementId) &&
        livePlacementIds.has(relation.targetPlacementId)
      ))
      .map((relation) => [relation.id, relation]),
  )
  for (const edge of content.edges) {
    if (
      removedEdges.has(edge.id) ||
      !placementIds.has(edge.sourceItemId) ||
      !placementIds.has(edge.targetItemId)
    ) continue
    relations.set(edge.id, {
      id: edge.id,
      sourcePlacementId: edge.sourceItemId,
      targetPlacementId: edge.targetItemId,
      relationType: edge.label || edge.edgeKind,
      trustClass: "presentation",
      owner: "Canvas owner",
      provenance: "Durable presentation edge; no semantic assertion is implied.",
      style: edge.style,
    })
  }
  return {
    placements,
    relations: [...relations.values()].sort((left, right) => left.id.localeCompare(right.id)),
    frames: content.frames ?? [],
  }
}

export function mergeCanvasSnapshotWithPlacementOverrides(projection, snapshot, overrides) {
  return applyCanvasPlacementOverrides(mergeCanvasSnapshot(projection, snapshot), overrides)
}

export function applyCanvasPlacementOverrides(projection, overrides) {
  const geometryByPlacement = new Map(overrides)
  return {
    ...projection,
    placements: projection.placements.map((placement) => {
      const geometry = geometryByPlacement.get(placement.id)
      if (!geometry) return placement
      return {
        ...placement,
        x: geometry.x,
        y: geometry.y,
        width: geometry.width,
        height: geometry.height,
        zIndex: geometry.zIndex,
        ...(geometry.angle === undefined ? {} : { angle: geometry.angle }),
        ...(geometry.displayMode === undefined ? {} : { displayMode: geometry.displayMode }),
        ...(geometry.collapsed === undefined ? {} : { collapsed: geometry.collapsed }),
        ...(geometry.style === undefined ? {} : { style: geometry.style }),
      }
    }),
  }
}

export function snapshotItemFromPlacement(placement, geometry = placement) {
  return normalizeCanvasSnapshot({
    schemaId: "gb.canvas.snapshot.v1",
    items: [{
      id: placement.id,
      subjectRef: placement.subjectRef,
      nodeType: placement.nodeType,
      x: geometry.x,
      y: geometry.y,
      width: geometry.width,
      height: geometry.height,
      angle: geometry.angle ?? placement.angle ?? 0,
      zIndex: geometry.zIndex ?? 0,
      displayMode: geometry.displayMode ?? placement.displayMode ?? "card",
      collapsed: geometry.collapsed ?? placement.collapsed ?? false,
      style: geometry.style ?? placement.style ?? {},
    }],
    edges: [],
  }).items[0]
}

export function commandsForPlacementGeometry(snapshot, projection, placementId, geometry) {
  const content = normalizeCanvasSnapshot(snapshot)
  const placement = placementMap(projection).get(placementId)
  if (!placement) throw new TypeError("Placement is not part of the authorized projection")
  const existing = content.items.find((item) => item.id === placementId)
  if (!existing) {
    return [{ type: "item.place", item: snapshotItemFromPlacement(placement, geometry) }]
  }
  if (existing.subjectRef !== placement.subjectRef || existing.nodeType !== placement.nodeType) {
    throw new TypeError("Durable placement identity does not match the authorized projection")
  }
  const commands = []
  if (existing.x !== geometry.x || existing.y !== geometry.y) {
    commands.push({ type: "item.move", itemId: placementId, position: { x: geometry.x, y: geometry.y } })
  }
  if (existing.width !== geometry.width || existing.height !== geometry.height) {
    commands.push({
      type: "item.resize",
      itemId: placementId,
      size: { width: geometry.width, height: geometry.height },
    })
  }
  if (existing.zIndex !== geometry.zIndex) {
    commands.push({ type: "item.reorder", itemId: placementId, zIndex: geometry.zIndex })
  }
  return commands
}

export function canvasNodeGeometry(node) {
  return {
    x: node.x,
    y: node.y,
    width: node.w,
    height: node.h,
    zIndex: node.z,
  }
}
