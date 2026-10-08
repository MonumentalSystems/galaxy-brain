import type { DurableDocumentRevision } from "./paper-reader-client"

export class ExactDocxDocumentError extends Error {}
export type ExactDocxDocumentDescriptor = Readonly<{
  artifactId: string
  byteSize: number
  contentSha256: string
  contentUrl: string
  documentId: string
  documentRef: string
  displayFilename: string
  mediaType: string
  originalFilename: string
  representationId: string
  representationRef: string
  revisionId: string
  revisionSha256: string
  title: string
}>
export function isExactDocxMediaType(value: unknown): boolean
export function exactDocxDocumentDescriptor(
  value: DurableDocumentRevision,
  expectedRevisionId: string,
): ExactDocxDocumentDescriptor
