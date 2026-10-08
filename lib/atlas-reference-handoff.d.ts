import type { GalaxyObjectProjection } from "./object-projection"
import type { ObjectProjectionResolutionResult } from "./object-projection-resolution"

export const ATLAS_REFERENCE_HANDOFF_PARAMETER: "placeRef"

export type AtlasReferenceHandoffFailureCode =
  | "invalid_reference"
  | "noncanonical_reference"
  | "unsupported_kind"
  | "pinned_required"
  | "invalid_revision"

export type AtlasReferenceHandoffInspection =
  | Readonly<{
      ok: true
      subjectRef: string
      kind: "document" | "chat" | "surface"
      objectId: string
      revisionSha256: string
    }>
  | Readonly<{ ok: false; code: AtlasReferenceHandoffFailureCode }>

export type ParsedAtlasReferenceHandoff =
  | Readonly<{ state: "none" }>
  | Readonly<{
      state: "invalid"
      code: AtlasReferenceHandoffFailureCode | "duplicate_intent"
    }>
  | Readonly<{
      state: "ready"
      subjectRef: string
      kind: "document" | "chat" | "surface"
      objectId: string
      revisionSha256: string
    }>

export interface AtlasReferenceHandoffExpectedBinding {
  readonly kind?: "document" | "chat" | "surface"
  readonly objectId?: string
  readonly sourceRevisionId?: string
  readonly revisionSha256?: string
}

export type AuthorizedAtlasReferenceHandoff =
  | Readonly<{
      ok: true
      subjectRef: string
      kind: "document" | "chat" | "surface"
      objectId: string
      sourceRevisionId?: string
      revisionSha256: string
      projection: GalaxyObjectProjection
    }>
  | Readonly<{
      ok: false
      code:
        | AtlasReferenceHandoffFailureCode
        | "unavailable"
        | "identity_mismatch"
        | "source_mismatch"
        | "revision_mismatch"
    }>

export function inspectAtlasReferenceHandoff(value: unknown): AtlasReferenceHandoffInspection
export function atlasReferenceHandoffHref(subjectRef: string): string
export function parseAtlasReferenceHandoff(search: string): ParsedAtlasReferenceHandoff
export function clearAtlasReferenceHandoffHref(href: string): string
export function authorizeAtlasReferenceHandoff(
  subjectRef: string,
  resolution: ObjectProjectionResolutionResult | unknown,
  expected?: AtlasReferenceHandoffExpectedBinding,
): AuthorizedAtlasReferenceHandoff
