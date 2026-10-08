import type { Edge, Node } from "@canvas-harness/core"

import type {
  GalaxyCanvasPlacement,
  GalaxyCanvasRelation,
} from "./galaxy-canvas-adapter.js"

export type AtlasRelationEndpointSide = "source" | "target"

export type AtlasRuntimeRelationEndpoint = Readonly<{
  nodeId: Node["id"]
  placementId: string
  label: string
}>

export type AtlasProjectedRelationEndpoint = Readonly<{
  placementId: string
  label: string
}>

export function resolveAtlasRuntimeRelationEndpoint(
  edge: Edge | null | undefined,
  endpoint: AtlasRelationEndpointSide,
  getNode: (nodeId: Node["id"]) => Node | undefined,
): AtlasRuntimeRelationEndpoint | null

export function resolveAtlasProjectedRelationEndpoint(
  relation: GalaxyCanvasRelation | null | undefined,
  endpoint: AtlasRelationEndpointSide,
  getPlacements: (placementId: string) => readonly GalaxyCanvasPlacement[] | undefined,
): AtlasProjectedRelationEndpoint | null
