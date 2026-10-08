import type { ConfirmedDocumentImport } from "./galaxy-brain-api"
import type { CodeGraphProvider } from "./code-graph-provider"

export const CODE_GRAPH_SNAPSHOT_MEDIA_TYPE: "application/json"
export const MAX_CODE_GRAPH_SNAPSHOT_BYTES: number
export const CODE_GRAPH_SNAPSHOT_SCHEMA_ID: "codebase-memory.snapshot.v1"

export class CodeGraphSnapshotImportError extends Error {
  readonly code: string
  constructor(code: string, message: string)
}

export type CodeGraphSnapshotReview = Readonly<{
  schemaId: "codebase-memory.snapshot.v1"
  contentSha256: string
  byteSize: number
  provider: Readonly<{ name: string; version: string }>
  repository: Readonly<{ repositoryId: string; commit: string }>
  declaredSnapshotDigest: `sha256:${string}`
  nodeCount: number
  edgeCount: number
}>

export function validateCodeGraphSnapshotFileDescriptor(file: Pick<File, "name" | "size" | "type">): Readonly<{
  name: string
  byteSize: number
  mediaType: "application/json"
}>
export function parseCodeGraphSnapshotBytes(input: ArrayBuffer | Uint8Array): Promise<CodeGraphSnapshotReview>
export function openCodeGraphSnapshotProvider(
  input: ArrayBuffer | Uint8Array,
  options?: { maxNodes?: number; maxEdges?: number },
): Promise<Readonly<{ review: CodeGraphSnapshotReview; provider: CodeGraphProvider }>>
export function normalizeCodeGraphSnapshotReview(value: unknown): CodeGraphSnapshotReview
export function createCodeGraphSnapshotImportTitle(review: unknown): string
export function assertCodeGraphSnapshotImportConfirmation(
  confirmation: ConfirmedDocumentImport,
  review: unknown,
  filename: string,
): ConfirmedDocumentImport
