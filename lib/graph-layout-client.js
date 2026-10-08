export const GRAPH_LAYOUT_SCHEMA_ID = "gb.graph-layout.v1"
export const GRAPH_LAYOUT_FORCE_LIMIT = 360
export const GRAPH_LAYOUT_NODE_LIMIT = 1_200

const SCALES = new Set(["corpus", "project", "task", "run", "object", "atomic"])
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u

function boundedText(value, maximum) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !CONTROL_CHARACTERS.test(value)
    ? value
    : null
}

function hashText(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function finiteLayer(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 32 ? value : 0
}

export function normalizeGraphLayoutRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Graph layout request must be an object")
  }
  if (value.schemaId !== GRAPH_LAYOUT_SCHEMA_ID) {
    throw new TypeError(`Graph layout request must use ${GRAPH_LAYOUT_SCHEMA_ID}`)
  }
  const projectionHash = boundedText(value.projectionHash, 256)
  const scale = boundedText(value.scale, 32)
  if (!projectionHash || !scale || !SCALES.has(scale)) {
    throw new TypeError("Graph layout request has an invalid projection hash or scale")
  }
  if (!Array.isArray(value.nodes) || value.nodes.length > GRAPH_LAYOUT_NODE_LIMIT) {
    throw new TypeError(`Graph layout request supports at most ${GRAPH_LAYOUT_NODE_LIMIT} nodes`)
  }
  const ids = new Set()
  const nodes = value.nodes.map((entry, index) => {
    const id = boundedText(entry?.id, 512)
    if (!id || ids.has(id)) throw new TypeError(`Graph layout node ${index} has an invalid or duplicate id`)
    ids.add(id)
    return { id, layer: finiteLayer(entry.layer) }
  })
  if (!Array.isArray(value.edges) || value.edges.length > GRAPH_LAYOUT_NODE_LIMIT * 4) {
    throw new TypeError("Graph layout request has too many edges")
  }
  const edges = value.edges.flatMap((entry, index) => {
    const source = boundedText(entry?.source, 512)
    const target = boundedText(entry?.target, 512)
    if (!source || !target || source === target || !ids.has(source) || !ids.has(target)) {
      throw new TypeError(`Graph layout edge ${index} has invalid endpoints`)
    }
    return [{ source, target }]
  })
  return { schemaId: GRAPH_LAYOUT_SCHEMA_ID, projectionHash, scale, nodes, edges }
}

/**
 * A deterministic O(n) layout used immediately and whenever force layout is
 * intentionally skipped. It is presentation state only; it never changes the
 * graph projection or canonical object identity.
 */
export function deterministicGraphFallback(value) {
  const request = normalizeGraphLayoutRequest(value)
  const ordered = [...request.nodes].sort((left, right) => left.layer - right.layer || left.id.localeCompare(right.id))
  const byLayer = new Map()
  for (const node of ordered) {
    const entries = byLayer.get(node.layer) || []
    entries.push(node)
    byLayer.set(node.layer, entries)
  }
  const layers = [...byLayer.keys()].sort((left, right) => left - right)
  const positions = {}
  for (const [layerIndex, layer] of layers.entries()) {
    const entries = byLayer.get(layer)
    const radius = 150 + layerIndex * 185
    entries.forEach((node, index) => {
      const phase = ((hashText(`${request.projectionHash}:${node.id}`) % 360) * Math.PI) / 180
      const angle = phase + (Math.PI * 2 * index) / Math.max(1, entries.length)
      positions[node.id] = {
        x: Math.round(Math.cos(angle) * radius),
        y: Math.round(Math.sin(angle) * radius),
      }
    })
  }
  return { key: `${request.projectionHash}:${request.scale}`, positions, mode: "fallback" }
}

export function graphLayoutCacheKey(projectionHash, scale) {
  return `${projectionHash}:${scale}`
}
