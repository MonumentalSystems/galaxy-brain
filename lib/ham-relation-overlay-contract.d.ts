export const HAM_RELATION_OVERLAY_REQUEST_SCHEMA_ID: "gb.ham-relation-overlay-request.v1"
export const HAM_RELATION_OVERLAY_RESPONSE_SCHEMA_ID: "gb.ham-relation-overlay-response.v1"
export const HAM_RELATION_OVERLAY_MAX_REFERENCES: 24
export const HAM_RELATION_OVERLAY_MAX_RELATIONS: 240
export const HAM_RELATION_OVERLAY_MAX_LINKS_PER_MEMORY: 64
export const HAM_RELATION_OVERLAY_REQUEST_MAX_BYTES: 65536
export const HAM_RELATION_OVERLAY_RESPONSE_MAX_BYTES: 524288

export interface HamRelationOverlayRequest {
  readonly schemaId: "gb.ham-relation-overlay-request.v1"
  readonly references: readonly string[]
}

export type HamRelationOverlayResult =
  | { readonly requestedRef: string; readonly status: "resolved"; readonly version: number }
  | { readonly requestedRef: string; readonly status: "unavailable" }

export interface HamRelationOverlayRelation {
  readonly kind: "typed" | "lifecycle"
  readonly id: string
  readonly sourceRef: string
  readonly targetRef: string
  readonly relation: "cites" | "verifies" | "contradicts" | "depends-on" | "supersedes" | "superseded_by"
  readonly state: "active"
  readonly version: number
}

export interface HamRelationOverlayResponse {
  readonly schemaId: "gb.ham-relation-overlay-response.v1"
  readonly provider: {
    readonly name: "ham"
    readonly status: "partial" | "unavailable"
    readonly consistency: "follow-latest"
    readonly truncated: boolean
  }
  readonly results: readonly HamRelationOverlayResult[]
  readonly relations: readonly HamRelationOverlayRelation[]
}

export function parseHamRelationOverlayRequest(input: unknown): HamRelationOverlayRequest
export function parseHamRelationOverlayResponse(
  input: unknown,
  request?: HamRelationOverlayRequest | readonly string[],
): HamRelationOverlayResponse
export function serializeHamRelationOverlayResponse(
  response: unknown,
  request?: HamRelationOverlayRequest | readonly string[],
): string
