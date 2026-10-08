import type { DurableDocumentRevision } from "./paper-reader-client"
import type { GalaxyObjectProjection } from "./object-projection"
import type { RasterImageManifest } from "./raster-image-contract"

export class ExactImageDocumentError extends Error {}
export interface ExactImageDocumentDescriptor {
  artifactId: string
  byteSize: number
  contentSha256: string
  contentUrl: string
  displayFilename: string
  documentId: string
  documentRef: string
  mediaType: RasterImageManifest["mediaType"]
  rasterImage: RasterImageManifest
  representationId: string
  representationRef: string
  revisionId: string
  revisionSha256: string
  title: string
}
export interface ExactImageObjectUrl {
  readonly url: string
  readonly width: number
  readonly height: number
  revoke(): void
}
export function isExactRasterImageMediaType(value: unknown): boolean
export function exactImageDocumentDescriptor(value: DurableDocumentRevision | unknown, expectedRevisionId: string): ExactImageDocumentDescriptor
export function exactImageProjectionDescriptor(value: GalaxyObjectProjection | unknown, authorizedRevisionId: string): ExactImageDocumentDescriptor
export function loadExactImageObjectUrl(descriptor: ExactImageDocumentDescriptor, options?: {
  fetcher?: typeof fetch
  digest?: (bytes: Uint8Array) => Promise<string>
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
  decodeImage?: (url: string, signal?: AbortSignal) => Promise<{ width: number; height: number }>
  origin?: string
  signal?: AbortSignal
}): Promise<ExactImageObjectUrl>
