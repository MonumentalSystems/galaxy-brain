import type { GalaxyObjectProjection } from "./object-projection"
import type { CodeGraphNeighborhoodResult } from "./code-graph-provider"
import type { CodeGraphSnapshotReview } from "./code-graph-snapshot-import"

export class CodeGraphSnapshotSourceError extends Error {
  readonly code: string
  constructor(code: string, message: string)
}

export type CodeGraphSnapshotDescriptor = Readonly<{
  sourceRef: string
  projection: GalaxyObjectProjection
  revisionId: string
  representationId: string
  contentSha256: string
  contentUrl: string
}>

export function codeGraphSnapshotDescriptorFromResolution(sourceRef: string, resolution: unknown): CodeGraphSnapshotDescriptor
export function validateCodeGraphLensReferences(
  sourceRef: string | null,
  selectedRef?: string | null,
): Readonly<{ sourceRef: string; selectedRef: string | null }> | null
export function fetchExactCodeGraphSnapshot(
  descriptor: CodeGraphSnapshotDescriptor,
  options?: { fetcher?: typeof fetch; signal?: AbortSignal; baseUrl?: string },
): Promise<Readonly<{ bytes: Uint8Array; rawSha256: string }>>

export class CodeGraphSnapshotSessionClient {
  constructor(workerFactory: () => Worker, options?: {
    resolve?: (references: readonly string[], options: { signal?: AbortSignal }) => Promise<{ results: readonly unknown[] }>
    fetcher?: typeof fetch
    baseUrl?: string
  })
  load(input: {
    tenantId: string
    sourceRef: string
    selectedRef?: string | null
    depth?: number
    limit?: number
    signal?: AbortSignal
  }): Promise<Readonly<{
    descriptor: CodeGraphSnapshotDescriptor
    rawSha256: string
    review: CodeGraphSnapshotReview
    neighborhood: CodeGraphNeighborhoodResult
  }>>
  dispose(): void
}
