import type {
  GalaxyObjectReference,
  GalaxyObjectResolutionRequest,
  GalaxyObjectResolutionScope,
} from "./galaxy-object-reference"
import type { RasterImageManifest } from "./raster-image-contract"
import type { AudioOriginalManifest } from "./audio-original-contract"

export type GalaxyRepresentationKind =
  | "original" | "pdf" | "html" | "markdown" | "text" | "thumbnail"
  | "structure" | "image" | "audio" | "video" | "json" | "surface"

export type GalaxyProjectionCapability =
  | "open" | "annotate" | "place" | "branch" | "cite" | "export" | "inspect" | "relate"

export interface GalaxyRepresentationRef {
  ref: string
  kind: GalaxyRepresentationKind
  mediaType?: string
  contentHash: string | null
  label?: string
}

export interface GalaxyProjectionProvenance {
  provider: string
  sourceId?: string
  sourceRevision?: string
  statement?: string
}

export interface GalaxyObjectProjection {
  schemaId: "gb.object-projection.v1"
  ref: string
  kind: string
  revision: {
    policy: "latest" | "pinned"
    id: string | null
    contentHash: string | null
  }
  title: string
  summary?: string
  mediaType?: string
  representations: readonly GalaxyRepresentationRef[]
  rasterImage?: RasterImageManifest
  audioOriginal?: AudioOriginalManifest
  provenance: GalaxyProjectionProvenance
  capabilities: readonly GalaxyProjectionCapability[]
}

export interface AuthorizedProjectionResolution<T> {
  authorized: true
  value: T
}

export interface GalaxyProjectionResolverAdapter<T = unknown, TContext = unknown> {
  resolve(
    request: GalaxyObjectResolutionRequest,
    context: TContext,
  ): AuthorizedProjectionResolution<T> | null | Promise<AuthorizedProjectionResolution<T> | null>
  project(request: GalaxyObjectResolutionRequest, value: T, context: TContext): unknown | Promise<unknown>
}

export const GALAXY_OBJECT_PROJECTION_SCHEMA_ID: "gb.object-projection.v1"
export const GALAXY_REPRESENTATION_KINDS: readonly GalaxyRepresentationKind[]
export const GALAXY_PROJECTION_CAPABILITIES: readonly GalaxyProjectionCapability[]
export function createGalaxyObjectProjection(input: unknown): GalaxyObjectProjection
export function resolveGalaxyObjectProjection<TContext = unknown>(
  reference: GalaxyObjectReference | string | unknown,
  scope: GalaxyObjectResolutionScope,
  adapters: Partial<Record<string, GalaxyProjectionResolverAdapter<unknown, TContext>>>,
  context: TContext,
): Promise<GalaxyObjectProjection | null>
export function projectionToMarkdownCitation(projection: GalaxyObjectProjection | unknown): string
