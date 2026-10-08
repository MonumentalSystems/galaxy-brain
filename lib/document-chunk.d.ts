export const CHUNK_SCHEMA_ID: "gb.document-chunk.v1"
export const CHUNK_MANIFEST_SCHEMA_ID: "gb.document-chunk-manifest.v1"
export const CHUNKER_STRUCTURE_ID: "galaxy.document-structure-blocks"
export const CHUNKER_STRUCTURE_VERSION: "1"
export const CHUNKER_TEXT_ID: "galaxy.unicode-code-point-windows"
export const CHUNKER_TEXT_VERSION: "1"
export const DEFAULT_WINDOW_CODE_POINTS: number
export const DEFAULT_OVERLAP_CODE_POINTS: number
export const MAX_WINDOW_CODE_POINTS: number
export const MAX_DOCUMENT_CHUNKS: number
export const MAX_CHUNK_TEXT_BYTES: number
export const MAX_TEXT_REPRESENTATION_BYTES: number

export type DocumentChunkSelector =
  | Readonly<{ kind: "json-pointer"; pointer: `/blocks/${number}` }>
  | Readonly<{
      kind: "text-position"
      unit: "unicode-code-point"
      start: number
      end: number
      overlap: number
    }>

export type DocumentChunk = Readonly<{
  schemaId: "gb.document-chunk.v1"
  id: `sha256:${string}`
  chunkSha256: string
  representationId: string
  representationSha256: string
  ordinal: number
  selector: DocumentChunkSelector
  selectorSha256: string
  textContent: string
  contentSha256: string
  chunkerId: string
  chunkerVersion: string
  chunkerConfigSha256: string
}>

export type DocumentChunkManifest = Readonly<{
  schemaId: "gb.document-chunk-manifest.v1"
  canonicalObject: false
  representationId: string
  representationSha256: string
  representationKind: "document-structure" | "markdown" | "text"
  chunker: Readonly<{
    id: string
    version: string
    config: Readonly<Record<string, string | number>>
    configSha256: string
  }>
  chunkCount: number
  chunks: readonly DocumentChunk[]
}>

export type ChunkableRepresentation = Readonly<{
  representationId: string
  representationSha256: string
  kind: "document-structure" | "markdown" | "text"
  content: unknown
}>

export type DocumentChunkOptions = Readonly<{
  windowCodePoints?: number
  overlapCodePoints?: number
}>

export class DocumentChunkContractError extends Error {}
export function canonicalChunkJson(value: unknown): string
export function currentDocumentChunker(
  kind: "document-structure" | "markdown" | "text",
  options?: DocumentChunkOptions,
): DocumentChunkManifest["chunker"]
export function materializeDocumentChunks(
  representation: ChunkableRepresentation,
  options?: DocumentChunkOptions,
): DocumentChunkManifest
