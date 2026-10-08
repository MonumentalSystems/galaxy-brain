import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from "d3"

function hashText(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function centerPositions(nodes) {
  const centerX = nodes.reduce((sum, node) => sum + (node.x || 0), 0) / nodes.length
  const centerY = nodes.reduce((sum, node) => sum + (node.y || 0), 0) / nodes.length
  return Object.fromEntries(nodes.map((node) => [
    node.id,
    {
      x: Math.round((node.x || 0) - centerX),
      y: Math.round((node.y || 0) - centerY),
    },
  ]))
}

function boundedLayerLayout(nodes, layerGap, nodeGap) {
  const layerCounts = new Map()
  for (const node of nodes) {
    const layer = Number.isFinite(node.layer) ? node.layer : 0
    layerCounts.set(layer, (layerCounts.get(layer) || 0) + 1)
  }

  const layerIndexes = new Map()
  const positions = nodes.map((node) => {
    const layer = Number.isFinite(node.layer) ? node.layer : 0
    const index = layerIndexes.get(layer) || 0
    layerIndexes.set(layer, index + 1)
    const count = layerCounts.get(layer) || 1
    const jitter = (hashText(node.id) % 17) - 8
    return {
      id: node.id,
      x: layer * layerGap + jitter,
      y: (index - (count - 1) / 2) * nodeGap + jitter,
    }
  })
  return centerPositions(positions)
}

function identitySegment(value) {
  return `${value.length}:${value}`
}

export function proofGraphNodeId(programId, packetId) {
  return `proof:${identitySegment(programId)}${identitySegment(packetId)}`
}

export function proofCampaignNodeId(programId) {
  return `campaign:${identitySegment(programId)}`
}

/**
 * Produce a stable force-directed projection without changing the proof DAG.
 * A light x-force keeps prerequisite depth legible while links, repulsion, and
 * collision reveal the graph's local topology.
 */
export function forceLayoutProofGraph(nodes, edges, options = {}) {
  if (nodes.length === 0) return {}

  const layerGap = options.layerGap ?? 360
  const nodeGap = options.nodeGap ?? 170
  const maxForceNodes = options.maxForceNodes ?? 400
  if (nodes.length > maxForceNodes) return boundedLayerLayout(nodes, layerGap, nodeGap)

  const seed = options.seed ?? hashText(nodes.map((node) => node.id).sort().join("|"))
  const random = seededRandom(seed)
  const simulationNodes = nodes.map((node, index) => {
    const localSeed = hashText(node.id)
    const angle = ((localSeed % 360) * Math.PI) / 180
    const radius = 45 + (localSeed % 7) * 11
    return {
      id: node.id,
      layer: Number.isFinite(node.layer) ? node.layer : 0,
      x: (Number.isFinite(node.layer) ? node.layer : 0) * layerGap + Math.cos(angle) * radius,
      y: Math.sin(angle) * radius + (index % 9) * 7,
    }
  })
  const knownIds = new Set(simulationNodes.map((node) => node.id))
  const simulationLinks = edges
    .filter((edge) => knownIds.has(edge.source) && knownIds.has(edge.target))
    .map((edge) => ({ source: edge.source, target: edge.target }))

  const simulation = forceSimulation(simulationNodes)
    .randomSource(random)
    .alphaDecay(0.038)
    .velocityDecay(0.36)
    .force("link", forceLink(simulationLinks).id((node) => node.id).distance(235).strength(0.62))
    .force("charge", forceManyBody().strength(-310).distanceMax(1_500))
    .force("collision", forceCollide(nodeGap / 2).strength(0.86).iterations(2))
    .force("layer", forceX((node) => node.layer * layerGap).strength(0.15))
    .force("centerline", forceY(0).strength(0.032))
    .stop()

  const ticks = options.iterations ?? 150
  for (let tick = 0; tick < ticks; tick += 1) simulation.tick()
  simulation.stop()
  return centerPositions(simulationNodes)
}
