import { asNodeId } from "@canvas-harness/core"

export const ATLAS_CONSTELLATION_NODE_TYPE = "atlas.constellation"
export const ATLAS_CONSTELLATION_SCHEMA_ID = "gb.atlas.constellation.v1"
export const ATLAS_CONSTELLATION_FAR_MAX = 64
export const ATLAS_CONSTELLATION_MEDIUM_MAX = 256
export const ATLAS_CONSTELLATION_ZOOM = Object.freeze({
  enterFar: 0.14,
  leaveFar: 0.2,
  enterMedium: 0.46,
  leaveMedium: 0.58,
})

const LEVEL_LIMITS = Object.freeze({
  far: ATLAS_CONSTELLATION_FAR_MAX,
  medium: ATLAS_CONSTELLATION_MEDIUM_MAX,
})
const MIN_MARKER_SIZE = 120
const MAX_MARKER_SIZE = 200
const CELL_INSET_RATIO = 0.12

export function initialAtlasConstellationLevel(zoom) {
  finite(zoom, "zoom")
  if (zoom < ATLAS_CONSTELLATION_ZOOM.leaveFar) return "far"
  if (zoom < ATLAS_CONSTELLATION_ZOOM.leaveMedium) return "medium"
  return "atomic"
}

export function nextAtlasConstellationLevel(zoom, current = "atomic") {
  finite(zoom, "zoom")
  if (current === "far") {
    if (zoom > ATLAS_CONSTELLATION_ZOOM.leaveMedium) return "atomic"
    return zoom > ATLAS_CONSTELLATION_ZOOM.leaveFar ? "medium" : "far"
  }
  if (current === "medium") {
    if (zoom < ATLAS_CONSTELLATION_ZOOM.enterFar) return "far"
    if (zoom > ATLAS_CONSTELLATION_ZOOM.leaveMedium) return "atomic"
    return "medium"
  }
  if (current !== "atomic") invalid("current level must be atomic, medium, or far")
  if (zoom < ATLAS_CONSTELLATION_ZOOM.enterFar) return "far"
  if (zoom < ATLAS_CONSTELLATION_ZOOM.enterMedium) return "medium"
  return "atomic"
}

function invalid(message) {
  throw new TypeError(`Invalid Atlas constellation input: ${message}`)
}

function finite(value, label) {
  if (!Number.isFinite(value)) invalid(`${label} must be finite`)
  return value
}

function sourceGeometry(node, index) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    invalid(`nodes[${index}] must be an object`)
  }
  const x = finite(node.x, `nodes[${index}].x`)
  const y = finite(node.y, `nodes[${index}].y`)
  const w = finite(node.w, `nodes[${index}].w`)
  const h = finite(node.h, `nodes[${index}].h`)
  if (w <= 0 || h <= 0) invalid(`nodes[${index}] dimensions must be positive`)
  const unavailable = node.data?.availability === "unavailable"
  return {
    centerX: x + w / 2,
    centerY: y + h / 2,
    minX: x,
    minY: y,
    maxX: x + w,
    maxY: y + h,
    unavailable,
  }
}

function sceneBounds(values) {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const value of values) {
    minX = Math.min(minX, value.minX)
    minY = Math.min(minY, value.minY)
    maxX = Math.max(maxX, value.maxX)
    maxY = Math.max(maxY, value.maxY)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

function gridShape(bounds, maximumBins) {
  const width = Math.max(bounds.w, 1)
  const height = Math.max(bounds.h, 1)
  const aspect = width / height
  let columns = Math.max(1, Math.min(maximumBins, Math.round(Math.sqrt(maximumBins * aspect))))
  let rows = Math.max(1, Math.floor(maximumBins / columns))
  while (columns * rows > maximumBins) rows -= 1
  return { columns, rows }
}

function cellIndex(value, origin, extent, cells) {
  if (cells === 1 || extent <= 0) return 0
  return Math.max(0, Math.min(cells - 1, Math.floor(((value - origin) / extent) * cells)))
}

function markerDimension(cellDimension) {
  return Math.max(MIN_MARKER_SIZE, Math.min(MAX_MARKER_SIZE, cellDimension * (1 - CELL_INSET_RATIO * 2)))
}

function constellationNode(level, bounds, grid, column, row, counts) {
  const cellWidth = Math.max(bounds.w, 1) / grid.columns
  const cellHeight = Math.max(bounds.h, 1) / grid.rows
  const width = markerDimension(cellWidth)
  const height = markerDimension(cellHeight)
  const centerX = bounds.x + (column + 0.5) * cellWidth
  const centerY = bounds.y + (row + 0.5) * cellHeight
  return {
    id: asNodeId(`atlas-constellation:${level}:${column}:${row}`),
    type: ATLAS_CONSTELLATION_NODE_TYPE,
    x: centerX - width / 2,
    y: centerY - height / 2,
    w: width,
    h: height,
    angle: 0,
    z: -10,
    groups: [],
    locked: true,
    data: {
      schemaId: ATLAS_CONSTELLATION_SCHEMA_ID,
      level,
      cell: { column, row },
      counts: {
        total: counts.total,
        resolved: counts.total - counts.unavailable,
        unavailable: counts.unavailable,
      },
    },
  }
}

/**
 * Derive a content-free, read-only overview scene from already-authorized
 * canvas nodes. The result is transient renderer state: it is never a canvas
 * snapshot and deliberately contains no member ids, references, or display
 * content. Relations are omitted until an aggregate-edge contract exists.
 */
export function deriveAtlasConstellationScene(nodes, level) {
  if (!Array.isArray(nodes)) invalid("nodes must be an array")
  const maximumBins = LEVEL_LIMITS[level]
  if (!maximumBins) invalid("level must be far or medium")
  // Presentation frames are atomic canvas chrome, never corpus members.
  // Keep this exclusion at the derivation boundary as well as the caller so
  // no future renderer path can turn frames into semantic-zoom counts.
  const semanticNodes = nodes.filter((node) => node?.data?.schemaId !== "gb.canvas.frame.v1")
  if (semanticNodes.length === 0) {
    return {
      level,
      sourceCount: 0,
      nodes: [],
      edges: [],
    }
  }

  const values = semanticNodes.map(sourceGeometry)
  const bounds = sceneBounds(values)
  const grid = gridShape(bounds, maximumBins)
  const bins = new Map()
  for (const value of values) {
    const column = cellIndex(value.centerX, bounds.x, bounds.w, grid.columns)
    const row = cellIndex(value.centerY, bounds.y, bounds.h, grid.rows)
    const key = row * grid.columns + column
    const counts = bins.get(key) ?? { total: 0, unavailable: 0, column, row }
    counts.total += 1
    if (value.unavailable) counts.unavailable += 1
    bins.set(key, counts)
  }

  const aggregateNodes = [...bins.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, counts]) => constellationNode(
      level,
      bounds,
      grid,
      counts.column,
      counts.row,
      counts,
    ))

  return {
    level,
    sourceCount: semanticNodes.length,
    nodes: aggregateNodes,
    edges: [],
  }
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null
}

/** Cheap canvas-only representation used by both far and medium scenes. */
export function paintAtlasConstellationNode(ctx, node, env = {}) {
  const data = record(node?.data)
  const counts = record(data?.counts)
  const total = Number.isSafeInteger(counts?.total) && counts.total > 0 ? counts.total : 0
  const unavailable = Number.isSafeInteger(counts?.unavailable) && counts.unavailable > 0
    ? Math.min(total, counts.unavailable)
    : 0
  const resolvedRatio = total > 0 ? (total - unavailable) / total : 0
  const zoom = Number.isFinite(env.zoom) ? Math.max(0.05, Math.min(4, env.zoom)) : 1
  const strokeWidth = Math.min(node.w * 0.12, 1.5 / zoom)
  const radius = Math.max(8, Math.min(node.w, node.h) / 2 - 3)
  const centerX = node.w / 2
  const centerY = node.h / 2
  const screenDiameter = Math.min(node.w, node.h) * zoom
  const compact = screenDiameter < 42
  const countFontSize = Math.min(node.h * (compact ? 0.9 : 0.3), (compact ? 10 : 12) / zoom)
  const labelFontSize = Math.min(node.h * 0.16, 10 / zoom)
  const unavailableFontSize = Math.min(node.h * 0.12, 8 / zoom)

  ctx.beginPath()
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2)
  ctx.fillStyle = "#eef3ec"
  ctx.fill()
  ctx.strokeStyle = "#315f49"
  ctx.lineWidth = strokeWidth
  ctx.stroke()

  ctx.beginPath()
  ctx.arc(centerX, centerY, Math.max(3, radius * Math.sqrt(resolvedRatio) * 0.72), 0, Math.PI * 2)
  ctx.fillStyle = "#6d7a68"
  ctx.fill()

  const plateWidth = compact ? countFontSize * 1.65 : radius * 1.7
  const plateHeight = compact
    ? countFontSize * 1.35
    : radius * (unavailable > 0 ? 0.9 : 0.66)
  ctx.fillStyle = "#fffef9"
  ctx.fillRect(centerX - plateWidth / 2, centerY - plateHeight / 2, plateWidth, plateHeight)

  ctx.fillStyle = "#1e2a24"
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.font = `650 ${countFontSize}px system-ui, -apple-system, sans-serif`
  ctx.fillText(
    total > 999 ? `${Math.floor(total / 1000)}k+` : String(total),
    centerX,
    compact ? centerY : centerY - radius * 0.2,
  )
  if (compact) return

  ctx.fillStyle = "#456255"
  ctx.font = `650 ${labelFontSize}px system-ui, -apple-system, sans-serif`
  ctx.fillText(total === 1 ? "placement" : "placements", centerX, centerY + radius * 0.12)
  if (unavailable > 0) {
    ctx.fillStyle = "#8f3f2a"
    ctx.font = `650 ${unavailableFontSize}px system-ui, -apple-system, sans-serif`
    ctx.fillText(`${unavailable} unavailable`, centerX, centerY + radius * 0.38)
  }
}
