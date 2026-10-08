import type { UnifiedGraphInput, GalaxyGraphQuery, GalaxyGraphScope } from "./unified-graph"

export const AUTHORIZED_PROOF_GRAPH_SOURCE_SCHEMA_ID: "gb.authorized-proof-graph-source.v1"
export const AUTHORIZED_PROOF_GRAPH_SOURCE_RESULT_SCHEMA_ID: "gb.authorized-proof-graph-source-result.v1"

export interface AuthorizedProofGraphSourceInput {
  schemaId: "gb.authorized-proof-graph-source.v1"
  authorized: boolean
  activateCoordination?: boolean
  scope: GalaxyGraphScope
  query: GalaxyGraphQuery
  proofDag: unknown
  proofDagSha256: string
  workState?: unknown | null
  sourceCursor?: string | null
  sourceLimit?: number
  priorityRefs?: string[]
}

export interface AuthorizedProofGraphSourceResult {
  schemaId: "gb.authorized-proof-graph-source-result.v1"
  graphInput: UnifiedGraphInput
  sourceContinuation: {
    cursor: string | null
    hasMore: boolean
    omitted: { nodes: number; relations: number }
    reasons: string[]
  }
  coordinationBindings: ReadonlyArray<{
    graphId: string
    nodeId: string
    nodeRef: string
    taskId: string
    linkedTaskCount: number
    resourceRef: string
  }>
  diagnostics: {
    omittedUnauthorized: boolean
    passiveCoordinationItems: number
    coordinationActive?: boolean
    partial: boolean
  }
}

export function buildAuthorizedProofGraphSource(
  input: AuthorizedProofGraphSourceInput | unknown,
): AuthorizedProofGraphSourceResult
