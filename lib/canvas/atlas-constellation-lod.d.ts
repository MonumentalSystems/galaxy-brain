import type { Edge, Node } from "@canvas-harness/core"

export const ATLAS_CONSTELLATION_NODE_TYPE: "atlas.constellation"
export const ATLAS_CONSTELLATION_SCHEMA_ID: "gb.atlas.constellation.v1"
export const ATLAS_CONSTELLATION_FAR_MAX: 64
export const ATLAS_CONSTELLATION_MEDIUM_MAX: 256
export const ATLAS_CONSTELLATION_ZOOM: Readonly<{
  enterFar: 0.14
  leaveFar: 0.2
  enterMedium: 0.46
  leaveMedium: 0.58
}>

export type AtlasConstellationLevel = "far" | "medium"
export type AtlasSceneLevel = "atomic" | AtlasConstellationLevel

export type AtlasConstellationData = {
  schemaId: typeof ATLAS_CONSTELLATION_SCHEMA_ID
  level: AtlasConstellationLevel
  cell: { column: number; row: number }
  counts: { total: number; resolved: number; unavailable: number }
}

export type AtlasConstellationNode = Node & {
  type: typeof ATLAS_CONSTELLATION_NODE_TYPE
  data: AtlasConstellationData
}

export type AtlasConstellationScene = {
  level: AtlasConstellationLevel
  sourceCount: number
  nodes: AtlasConstellationNode[]
  edges: Edge[]
}

export function deriveAtlasConstellationScene(
  nodes: ReadonlyArray<Pick<Node, "x" | "y" | "w" | "h" | "data">>,
  level: AtlasConstellationLevel,
): AtlasConstellationScene

export function initialAtlasConstellationLevel(zoom: number): AtlasSceneLevel
export function nextAtlasConstellationLevel(
  zoom: number,
  current?: AtlasSceneLevel,
): AtlasSceneLevel

export function paintAtlasConstellationNode(
  ctx: CanvasRenderingContext2D,
  node: Node,
  env?: { zoom?: number },
): void
