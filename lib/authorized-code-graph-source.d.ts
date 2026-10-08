import type { GalaxyObjectProjection } from "./object-projection"
import type { CodeGraphNeighborhoodResult, CodeGraphNode } from "./code-graph-provider"
import type { CodeGraphSnapshotReview } from "./code-graph-snapshot-import"
import type { UnifiedGraphInput } from "./unified-graph"

export const AUTHORIZED_CODE_GRAPH_SOURCE_SCHEMA_ID: "gb.authorized-code-graph-source.v1"
export const CODE_GRAPH_AUTHORITY_PROVIDER: "galaxy.code.snapshot"

export function buildAuthorizedCodeGraphSource(input: {
  schemaId: "gb.authorized-code-graph-source.v1"
  authorized: true
  tenantId: string
  sourceRef: string
  sourceProjection: GalaxyObjectProjection
  sourceRepresentationRef: string
  rawSha256: string
  review: CodeGraphSnapshotReview
  neighborhood: CodeGraphNeighborhoodResult
  query?: { scale?: "corpus" | "project" | "task" | "run" | "object" | "atomic" }
}): Promise<Readonly<{
  schemaId: "gb.authorized-code-graph-source-result.v1"
  graphInput: UnifiedGraphInput
  rootReference: string
  graphReference: string
  continuation: Readonly<{ truncated: boolean; omittedNodes: number; omittedEdges: number }>
}>>

export function codeGraphReferenceForNode(node: CodeGraphNode, review: CodeGraphSnapshotReview): string
