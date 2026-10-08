import type { GalaxyObjectProjection } from "./object-projection"
import type { AudioOriginalManifest } from "./audio-original-contract"
import type { RasterImageManifest } from "./raster-image-contract"

export type ObjectProjectionSourceKind =
  | "paper"
  | "document"
  | "document.anchor"
  | "eln.experiment"
  | "eln.observation"
  | "ham.task"
  | "ham.memory"
  | "surface"
  | "chat"
  | "proof.graph"
  | "proof.node"

export interface ObjectProjectionResolutionRequest {
  readonly schemaId: "gb.object-projection-resolution-request.v1"
  readonly references: readonly string[]
}

export interface ObjectProjectionSourceRequest {
  readonly schemaId: "gb.object-projection-source-request.v1" | "gb.object-projection-source-request.v2" | "gb.object-projection-source-request.v3"
  readonly references: readonly string[]
}

export interface ObjectProjectionUnavailableResult {
  readonly requestedRef: string
  readonly status: "unavailable"
}

export interface ObjectProjectionOpenHandle {
  readonly rel: "open"
  readonly method: "GET"
  readonly href: string
}

export interface ObjectProjectionResolvedResult {
  readonly requestedRef: string
  readonly status: "resolved"
  readonly resolvedRef: string
  readonly provider: string
  readonly projection: GalaxyObjectProjection
  /** Exact tenant-authorized reader revision; present only for document results. */
  readonly documentRevisionId?: string
  readonly handles: readonly ObjectProjectionOpenHandle[]
}

export type ObjectProjectionResolutionResult =
  | ObjectProjectionUnavailableResult
  | ObjectProjectionResolvedResult

export interface ObjectProjectionResolutionResponse {
  readonly schemaId: "gb.object-projection-resolution-response.v1"
  readonly results: readonly ObjectProjectionResolutionResult[]
}

export interface PaperProjectionSource {
  readonly paper: {
    readonly id: string
    readonly title: string
    readonly abstract?: string
    readonly metadataHash: string
  }
  readonly revision: null | {
    readonly id: string
    readonly metadataHash: string
    readonly document: null | {
      readonly ref: string
      readonly documentId: string
      readonly revisionId: string
      readonly revisionSha256: string
      readonly contentSha256: string
      readonly mediaType: string
      readonly displayFilename: string
    }
  }
}

export interface DocumentProjectionSource {
  readonly documentId: string
  readonly revisionId: string
  readonly revisionSha256: string
  readonly title: string
  readonly displayFilename?: string
  readonly summary?: string
  readonly mediaType: string
  readonly rasterImage?: RasterImageManifest
  readonly audioOriginal?: AudioOriginalManifest
  readonly representations: readonly {
    readonly id: string
    readonly kind: "original" | "document-structure" | "markdown" | "text" | "thumbnail"
    readonly mediaType: string
    readonly contentSha256: string
    readonly label?: string
  }[]
}

export interface DocumentAnchorProjectionSource {
  readonly id: string
  readonly representationSha256: string
  readonly anchorSha256: string
  readonly title?: string
  readonly selector:
    | { readonly kind: "page-region"; readonly page: number }
    | { readonly kind: "text-quote"; readonly exact: string }
    | { readonly kind: "json-pointer"; readonly pointer: string }
}

export interface ElnExperimentProjectionSource {
  readonly id: string
  readonly title: string
  readonly results?: string
  readonly interpretation?: string
  readonly updatedAt: string
}

export interface ElnObservationProjectionSource {
  readonly id: string
  readonly experimentId: string
  readonly version: number
  readonly revisionSha256: string
  readonly body: string
  readonly observedAt: string
  readonly createdAt: string
  readonly createdByPrincipalId: string
}

export interface HamTaskProjectionSource {
  readonly id: string
  readonly title: string
  readonly goal?: string
  readonly why?: string
  readonly version?: number
}

export interface HamMemoryProjectionSource {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly version?: number
}

export interface SurfaceProjectionSource {
  readonly id: string
  readonly title: string
  readonly status: "draft" | "promoted" | "archived"
  readonly catalogId: "generous.a2ui"
  readonly currentVersion: number
  readonly currentContentHash: string
  readonly schemaDigest?: string
  readonly catalogDigest?: string
  readonly rendererVersion?: string
  readonly placementEligible: boolean
}

export interface ChatProjectionSource {
  readonly conversationId: string
  readonly workspaceId: string
  readonly title: string
  readonly goalSummary: string
  readonly version: number
  readonly contentSha256: string
  readonly turnCount: number
  readonly branchCount: number
}

export interface ProofGraphProjectionSource {
  readonly graphId: string
  readonly contentSha256: string
  readonly title: string
  readonly objective?: string
  readonly summary?: string
}

export interface ProofNodeProjectionSource {
  readonly nodeRefId: string
  readonly contentSha256: string
  readonly title: string
  readonly objective?: string
  readonly summary?: string
}

export type ObjectProjectionSource =
  | PaperProjectionSource
  | DocumentProjectionSource
  | DocumentAnchorProjectionSource
  | ElnExperimentProjectionSource
  | ElnObservationProjectionSource
  | HamTaskProjectionSource
  | HamMemoryProjectionSource
  | SurfaceProjectionSource
  | ChatProjectionSource
  | ProofGraphProjectionSource
  | ProofNodeProjectionSource

export interface ObjectProjectionResolvedSourceResult {
  readonly requestedRef: string
  readonly status: "resolved"
  readonly resolvedRef: string
  readonly provider: string
  readonly sourceKind: ObjectProjectionSourceKind
  readonly source: ObjectProjectionSource
}

export type ObjectProjectionSourceResult =
  | ObjectProjectionUnavailableResult
  | ObjectProjectionResolvedSourceResult

export interface ObjectProjectionSourceResponse {
  readonly schemaId: "gb.object-projection-source-response.v1" | "gb.object-projection-source-response.v2" | "gb.object-projection-source-response.v3"
  readonly results: readonly ObjectProjectionSourceResult[]
}

export const GALAXY_OBJECT_PROJECTION_RESOLUTION_REQUEST_SCHEMA_ID:
  "gb.object-projection-resolution-request.v1"
export const GALAXY_OBJECT_PROJECTION_RESOLUTION_RESPONSE_SCHEMA_ID:
  "gb.object-projection-resolution-response.v1"
export const GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID:
  "gb.object-projection-source-request.v3"
export const GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID:
  "gb.object-projection-source-response.v3"
export const GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID_V2:
  "gb.object-projection-source-request.v2"
export const GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID_V2:
  "gb.object-projection-source-response.v2"
export const GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID_V1:
  "gb.object-projection-source-request.v1"
export const GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID_V1:
  "gb.object-projection-source-response.v1"
export const MAX_OBJECT_PROJECTION_REFERENCES: 64
export const MAX_OBJECT_PROJECTION_REQUEST_BYTES: 65536
export const MAX_OBJECT_PROJECTION_RESPONSE_BYTES: 2097152

export function parseObjectProjectionResolutionRequest(input: unknown): ObjectProjectionResolutionRequest
export function parseObjectProjectionSourceRequest(input: unknown): ObjectProjectionSourceRequest
export function createObjectProjectionSourceRequest(input: unknown): ObjectProjectionSourceRequest
export function parseObjectProjectionSourceResponse(
  input: unknown,
  request?: unknown | readonly string[],
): ObjectProjectionSourceResponse
export function createObjectProjectionOpenHandles(
  resolvedRef: string,
  documentRevisionId?: string,
): readonly ObjectProjectionOpenHandle[]
export function parseObjectProjectionResolutionResponse(
  input: unknown,
  request?: unknown | readonly string[],
): ObjectProjectionResolutionResponse
export function assembleObjectProjectionResolutionResponse(
  request: unknown,
  sourceResponse: unknown,
): ObjectProjectionResolutionResponse
export function serializeObjectProjectionResolutionResponse(
  input: unknown,
  request?: unknown | readonly string[],
): string
