import type { GalaxyCanvasPlacement, GalaxyCanvasProjection, GalaxyCanvasRelation } from "./galaxy-canvas-adapter"
import type { ActiveObjectLinkRow } from "../authorized-graph-source"
import type { HamRelationOverlayResponse } from "../ham-relation-overlay-contract.js"
import type { GalaxySurfaceSpec } from "../types/surfaces"

type Authorized = { id: string; authorized: true }

export type AuthorizedWorkspaceNode = Authorized & {
  type: string
  title?: string
  content?: string
  summary?: string
  mediaType?: string
  version?: number
}

export type AuthorizedPaper = Authorized & {
  title?: string
  abstract?: string
  metadataHash?: string
  authors?: Array<{ name?: string }>
  categories?: string[]
}

export type AuthorizedExperiment = Authorized & {
  title?: string
  domain?: string
  hypothesis?: string
  results?: string
  interpretation?: string
  status?: string
  tags?: string[]
  updatedAt?: string
}

export type AuthorizedTask = Authorized & {
  title?: string
  goal?: string
  why?: string
  state?: string
  lifecyclePhase?: string
  riskMode?: string
  version?: number
  resources?: Array<{
    resourceRef?: string
    resourceClass?: string
    redacted?: boolean
  }>
}

export type AuthorizedSurface = Authorized & {
  title?: string
  status?: string
  contentHash?: string
  spec?: GalaxySurfaceSpec
}

export type AuthorizedCanvasSources = {
  workspaceNodes?: AuthorizedWorkspaceNode[]
  papers?: AuthorizedPaper[]
  experiments?: AuthorizedExperiment[]
  tasks?: AuthorizedTask[]
  surfaces?: AuthorizedSurface[]
}

export type AuthorizedObjectLink = ActiveObjectLinkRow

export type AuthorizedObjectLinkEnvelope = {
  authorized: true
  active: true
  link: AuthorizedObjectLink
}

export const AUTHORIZED_CANVAS_SOURCE_LIMIT: number
export function buildAuthorizedCanvasProjection(input?: AuthorizedCanvasSources): GalaxyCanvasProjection
export function projectAuthorizedObjectLinkRelations(
  placements: GalaxyCanvasPlacement[],
  envelopes: AuthorizedObjectLinkEnvelope[],
  options?: { preferredPlacementIds?: string[] },
): GalaxyCanvasRelation[]
export function selectAuthorizedHamRelationReferences(
  placements: GalaxyCanvasPlacement[],
): {
  readonly eligibleCount: number
  readonly references: readonly string[]
  readonly clientTruncated: boolean
}
export function projectAuthorizedHamRelationOverlay(
  placements: GalaxyCanvasPlacement[],
  overlay: HamRelationOverlayResponse | unknown,
  options?: { preferredPlacementIds?: string[] },
): GalaxyCanvasRelation[]
