import type { ActiveObjectLinkRow } from "../authorized-graph-source"
import type { GalaxyCanvasPlacement } from "./galaxy-canvas-adapter"

export type AtlasAuthoredRelation =
  | "related"
  | "cites"
  | "part_of"
  | "derived_from"
  | "context_for"
  | "formalized_by"
  | "defined_in"
  | "implements"
  | "depends_on"
  | "documents"
  | "corresponds_to"

export const ATLAS_AUTHORED_RELATIONS: readonly Readonly<{
  id: AtlasAuthoredRelation
  label: string
}>[]

export type AtlasAuthoredRelationRequest = Readonly<{
  from_ref: string
  to_ref: string
  relation: AtlasAuthoredRelation
  basis: "authored"
  provenance: Readonly<{
    source: "manual"
    source_system: "galaxy.atlas.relation-composer.v1"
  }>
  idempotency_key: string
}>

export function inspectAtlasAuthoredRelationEndpoint(value: unknown):
  | Readonly<{ ok: true; ref: string }>
  | Readonly<{ ok: false; code: "exact_reference_required" }>

export function resolveAtlasAuthoredRelationEndpoint(
  requestedRef: string,
  hydration: Readonly<{
    status: string
    requestedRef?: string
    resolvedRef?: string
    projection?: Readonly<{ ref?: string }>
  }> | undefined,
):
  | Readonly<{ ok: true; ref: string }>
  | Readonly<{ ok: false; code: "exact_reference_required" }>

export function projectAtlasExactRelationPlacements(
  placements: readonly GalaxyCanvasPlacement[],
  hydrationByReference: Readonly<Record<string, Readonly<{
    status: string
    requestedRef?: string
    resolvedRef?: string
    projection?: Readonly<{ ref?: string }>
  }>>>,
): GalaxyCanvasPlacement[]

export function atlasAuthoredRelationEligibility(
  selection: { readonly relationRef: string | null } | null | undefined,
  referenceCounts: ReadonlyMap<string, number>,
): Readonly<{ ok: true; ref: string }> | Readonly<{ ok: false; reason: string }>

export function prepareAtlasAuthoredRelation(input: {
  fromRef: unknown
  toRef: unknown
  relation: unknown
  idempotencyKey: unknown
}): AtlasAuthoredRelationRequest

export function validateAtlasAuthoredRelationReceipt(
  value: unknown,
  request: AtlasAuthoredRelationRequest,
): ActiveObjectLinkRow

export function mergeAtlasAuthoredRelation(
  current: readonly ActiveObjectLinkRow[],
  confirmed: ActiveObjectLinkRow,
): readonly ActiveObjectLinkRow[]

export function reconcileAtlasObjectLinks(
  current: readonly ActiveObjectLinkRow[],
  refreshes: readonly Readonly<{
    links: readonly ActiveObjectLinkRow[]
  }>[],
): readonly ActiveObjectLinkRow[]

export type AtlasAuthoredRelationRecoveryScope = Readonly<{
  tenantId: string
  principalId: string
  canvasId: string
}>

export type AtlasAuthoredRelationRecovery = Readonly<{
  schemaId: "gb.atlas-authored-relation-recovery.v1"
  source: Readonly<{ placementId: string; label: string; relationRef: string }>
  target: Readonly<{ placementId: string; label: string; relationRef: string }>
  request: AtlasAuthoredRelationRequest
}>

export function writeAtlasAuthoredRelationRecovery(
  storage: Pick<Storage, "setItem">,
  scope: AtlasAuthoredRelationRecoveryScope,
  draft: Omit<AtlasAuthoredRelationRecovery, "schemaId">,
): AtlasAuthoredRelationRecovery

export function readAtlasAuthoredRelationRecovery(
  storage: Pick<Storage, "getItem" | "removeItem">,
  scope: AtlasAuthoredRelationRecoveryScope,
): AtlasAuthoredRelationRecovery | null

export function removeAtlasAuthoredRelationRecovery(
  storage: Pick<Storage, "removeItem">,
  scope: AtlasAuthoredRelationRecoveryScope,
): void
