import type { AudioOriginalManifest } from "./audio-original-contract"
import type { GalaxyObjectProjection } from "./object-projection"
import type { DurableDocumentRevision } from "./paper-reader-client"
export class ExactAudioDocumentError extends Error {}
export interface ExactAudioDocumentDescriptor {
  artifactId: string
  audioOriginal: AudioOriginalManifest
  byteSize: number
  contentSha256: string
  contentUrl: string
  displayFilename: string
  documentId: string
  documentRef: string
  mediaType: "audio/webm"
  representationId: string
  representationRef: string
  revisionId: string
  revisionSha256: string
  title: string
}
export interface ExactAudioObjectUrl { readonly url: string; revoke(): void }
export function isExactAudioOriginalMediaType(value: unknown): boolean
export function exactAudioDocumentDescriptor(value: DurableDocumentRevision | unknown, expectedRevisionId: string): ExactAudioDocumentDescriptor
export function exactAudioProjectionDescriptor(value: GalaxyObjectProjection | unknown, authorizedRevisionId: string): ExactAudioDocumentDescriptor
export function loadExactAudioObjectUrl(descriptor: ExactAudioDocumentDescriptor, options?: {
  fetcher?: typeof fetch
  digest?: (bytes: Uint8Array) => Promise<string>
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
  origin?: string
  signal?: AbortSignal
}): Promise<ExactAudioObjectUrl>
