import type { GalaxyObjectProjection } from "./object-projection"
import type { GalaxyDocumentStructure } from "./ingestion-contract.js"

export interface AtlasExactRepresentationDescriptor {
  readonly contentSha256: string
  readonly contentUrl: string
  readonly documentId: string
  readonly documentRef: string
  readonly identity: string
  readonly kind: "structure" | "markdown" | "text" | "original"
  readonly markdown: boolean
  readonly mediaType: string
  readonly representationId: string
  readonly representationRef: string
  readonly revisionId: string
  readonly revisionSha256: string
}

export class AtlasExactRepresentationError extends Error {}
export const MAX_ATLAS_EXACT_REPRESENTATION_BYTES: number
export const MAX_ATLAS_EXACT_REPRESENTATION_CACHE_BYTES: number
export const MAX_ATLAS_EXACT_REPRESENTATION_CACHE_ENTRIES: number
export const MAX_ATLAS_EXACT_REPRESENTATION_IN_FLIGHT: number
export const MAX_ATLAS_EXACT_REPRESENTATION_QUEUED: number
export function atlasExactRepresentationDescriptor(
  projection: GalaxyObjectProjection | unknown,
  authorizedRevisionId: string,
): AtlasExactRepresentationDescriptor | null
export function loadAtlasExactRepresentation(
  descriptor: AtlasExactRepresentationDescriptor,
  options?: {
    fetcher?: typeof fetch
    signal?: AbortSignal
    digest?: (bytes: Uint8Array) => Promise<string>
    origin?: string
    authorizationScope?: string
  },
): Promise<string>
export function loadAtlasExactRepresentationIfEligible(
  descriptor: AtlasExactRepresentationDescriptor,
  options: {
    eligible: boolean
    fetcher?: typeof fetch
    signal?: AbortSignal
    digest?: (bytes: Uint8Array) => Promise<string>
    origin?: string
    authorizationScope?: string
  },
): Promise<string | null>
export function clearAtlasExactRepresentationCache(authorizationScope?: string): void
export function parseAtlasExactStructure(content: string): GalaxyDocumentStructure | null
