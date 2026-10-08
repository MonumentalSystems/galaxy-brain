import type { Edge, Node, NodeType } from "@canvas-harness/core"
import type { GalaxySurfaceSpec } from "../types/surfaces"
import type { CanvasSnapshotFrame } from "./canvas-snapshot.js"

export type GalaxyCanvasNodeType =
  | "galaxy.paper"
  | "galaxy.note"
  | "galaxy.document"
  | "galaxy.media"
  | "galaxy.eln-record"
  | "galaxy.task"
  | "galaxy.chat"
  | "galaxy.proof"
  | "galaxy.surface"

export type GalaxyRelationTrustClass = "deterministic" | "asserted" | "verified" | "near" | "presentation"

export type GalaxyCanvasDisplay = {
  title: string
  subtitle?: string
  summary?: string
  revision?: string
  status?: string
  provenance?: string
  href?: string
  markdown?: string
  mediaType?: string
  badges?: string[]
  surfaceSpec?: GalaxySurfaceSpec
}

export type GalaxyCanvasPlacement = {
  id: string
  authorized: boolean
  availability?: "resolved" | "unavailable"
  subjectRef: string
  nodeType: GalaxyCanvasNodeType
  x: number
  y: number
  width: number
  height: number
  angle?: number
  zIndex?: number
  displayMode?: string
  collapsed?: boolean
  style?: Record<string, unknown>
  display: GalaxyCanvasDisplay
}

export type GalaxyCanvasRelation = {
  id: string
  sourcePlacementId: string
  targetPlacementId: string
  relationType: string
  trustClass: GalaxyRelationTrustClass
  owner: string
  provenance?: string
  evidenceRef?: string
  style?: Record<string, unknown>
}

export type GalaxyCanvasProjection = {
  placements: GalaxyCanvasPlacement[]
  relations: GalaxyCanvasRelation[]
  frames?: CanvasSnapshotFrame[]
}

export type GalaxyCanvasFrameData = {
  schemaId: "gb.canvas.frame.v1"
  frameId: string
  tone: CanvasSnapshotFrame["tone"]
}

export type GalaxyCanvasNodeData = {
  schemaId: "gb.canvas.node.v1"
  placementId: string
  subjectRef: string
  availability: "resolved" | "unavailable"
  display: GalaxyCanvasDisplay
  placementState: {
    displayMode: string
    collapsed: boolean
    style: Record<string, unknown>
  }
}

export type GalaxyCanvasRelationData = {
  schemaId: "gb.canvas.relation.v1"
  trustClass: GalaxyRelationTrustClass
  owner: string
  provenance?: string
  evidenceRef?: string
  presentationStyle?: Record<string, unknown>
}

export const GALAXY_CANVAS_NODE_TYPES: readonly GalaxyCanvasNodeType[]
export const GALAXY_RELATION_TRUST_CLASSES: readonly GalaxyRelationTrustClass[]
export const UNAVAILABLE_CANVAS_DISPLAY: Readonly<GalaxyCanvasDisplay>

export function canvasNodeId(placementId: string): Node["id"]
export function canvasEdgeId(relationId: string): Edge["id"]
export function canvasFrameNodeId(frameId: string): Node["id"]
export function projectGalaxyCanvas(input: GalaxyCanvasProjection): {
  nodes: Array<Node & { type: NodeType; data: GalaxyCanvasNodeData | GalaxyCanvasFrameData }>
  edges: Array<Edge & { data: GalaxyCanvasRelationData }>
}
