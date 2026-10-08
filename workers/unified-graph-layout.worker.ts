/// <reference lib="webworker" />

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from "d3"

import {
  deterministicGraphFallback,
  GRAPH_LAYOUT_FORCE_LIMIT,
  normalizeGraphLayoutRequest,
  type GraphLayoutRequest,
} from "@/lib/graph-layout-client.js"

type LayoutMessage = { requestId: number; request: GraphLayoutRequest }

function hashText(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function seededRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function forceLayout(request: GraphLayoutRequest) {
  const fallback = deterministicGraphFallback(request)
  if (request.nodes.length === 0 || request.nodes.length > GRAPH_LAYOUT_FORCE_LIMIT) return fallback

  const nodes = request.nodes.map((node) => ({
    id: node.id,
    layer: node.layer || 0,
    x: fallback.positions[node.id]?.x || 0,
    y: fallback.positions[node.id]?.y || 0,
  }))
  const simulation = forceSimulation(nodes)
    .randomSource(seededRandom(hashText(`${request.projectionHash}:${request.scale}`)))
    .alphaDecay(0.045)
    .velocityDecay(0.38)
    .force("link", forceLink(request.edges.map((edge) => ({ ...edge }))).id((node) => (node as { id: string }).id).distance(132).strength(0.58))
    .force("charge", forceManyBody().strength(-230).distanceMax(1_200))
    .force("collision", forceCollide(54).strength(0.9).iterations(2))
    .force("layer", forceX((node) => ((node as { layer: number }).layer - 2) * 185).strength(0.08))
    .force("centerline", forceY(0).strength(0.025))
    .stop()

  for (let tick = 0; tick < 110; tick += 1) simulation.tick()
  simulation.stop()
  const positions = Object.fromEntries(nodes.map((node) => [node.id, {
    x: Math.round(node.x || 0),
    y: Math.round(node.y || 0),
  }]))
  return { key: `${request.projectionHash}:${request.scale}`, positions, mode: "force" as const }
}

self.addEventListener("message", (event: MessageEvent<LayoutMessage>) => {
  const requestId = event.data?.requestId
  try {
    const request = normalizeGraphLayoutRequest(event.data?.request)
    self.postMessage({ requestId, ok: true, result: forceLayout(request) })
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : "Graph layout failed",
    })
  }
})

export {}
