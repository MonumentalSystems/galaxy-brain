export const CODE_GRAPH_MAX_DEPTH: 4
export const CODE_GRAPH_MAX_NODES: 250
export const CODE_GRAPH_MAX_EDGES: 2000

export type CodeGraphRepositoryRef = { kind: "repository"; repositoryId: string }
export type CodeGraphFileRef = { kind: "file"; repositoryId: string; path: string }
export type CodeGraphSymbolRef = {
  kind: "symbol"
  repositoryId: string
  path: string
  symbol: string
}
export type CodeGraphRef = CodeGraphRepositoryRef | CodeGraphFileRef | CodeGraphSymbolRef

export interface CodeGraphScope {
  tenantId: string
  authorityScope: string
  repository: {
    repositoryId: string
    commit: string
    snapshotDigest: `sha256:${string}`
  }
}

export interface CodeGraphProvenance {
  provider: string
  providerVersion: string
  repositoryId: string
  commit: string
  snapshotDigest: `sha256:${string}`
}

export interface CodeGraphNode {
  id: string
  kind: CodeGraphRef["kind"]
  ref: CodeGraphRef
  label: string
  repositoryId: string
  commit: string
  path?: string
  symbol?: string
  language?: string
}

export type CodeGraphEdgeType =
  | "contains"
  | "defines"
  | "imports"
  | "calls"
  | "references"
  | "extends"
  | "implements"
  | "depends_on"

export interface CodeGraphEdge {
  id: string
  type: CodeGraphEdgeType
  source: string
  target: string
}

export interface CodeGraphResolveResult {
  schemaId: "galaxy.code-graph.resolve.v1"
  provenance: CodeGraphProvenance
  node: CodeGraphNode
}

export interface CodeGraphNeighborhoodResult {
  schemaId: "galaxy.code-graph.neighborhood.v1"
  provenance: CodeGraphProvenance
  root: CodeGraphNode
  nodes: readonly CodeGraphNode[]
  edges: readonly CodeGraphEdge[]
  depth: number
  limit: number
  truncated: boolean
}

export interface CodeGraphAdapterRequest {
  ref: CodeGraphRef
  scope: CodeGraphScope
}

export interface CodeGraphAdapter {
  provider: string
  version: string
  resolve(request: CodeGraphAdapterRequest): { node: CodeGraphNode } | Promise<{ node: CodeGraphNode }>
  neighbors(request: CodeGraphAdapterRequest & { depth: number; limit: number }): {
    root: CodeGraphNode
    nodes: CodeGraphNode[]
    edges: CodeGraphEdge[]
    truncated: boolean
  } | Promise<{
    root: CodeGraphNode
    nodes: CodeGraphNode[]
    edges: CodeGraphEdge[]
    truncated: boolean
  }>
}

export interface CodeGraphProvider {
  provider: string
  version: string
  resolve(ref: CodeGraphRef, scope: CodeGraphScope): Promise<CodeGraphResolveResult>
  neighbors(
    ref: CodeGraphRef,
    scope: CodeGraphScope,
    depth?: number,
    limit?: number,
  ): Promise<CodeGraphNeighborhoodResult>
}

export interface CodebaseMemoryJsonSnapshot {
  schemaVersion: "codebase-memory.snapshot.v1"
  provider: { name: string; version: string }
  repository: { repositoryId: string; commit: string }
  snapshot: { digest: `sha256:${string}` }
  nodes: Array<Record<string, unknown>>
  edges: Array<Record<string, unknown>>
}

export type GalaxyCodeObjectKind =
  | "code.repo"
  | "code.commit"
  | "code.file"
  | "code.symbol"
  | "code.graph"

export function createCodeGraphProvider(adapter: CodeGraphAdapter): CodeGraphProvider
export function createCodebaseMemoryJsonProvider(snapshot: CodebaseMemoryJsonSnapshot): CodeGraphProvider
export function createCodeGraphObjectId(ref: CodeGraphRef): string
export function parseCodeGraphObjectId(kind: GalaxyCodeObjectKind, value: unknown): CodeGraphRef | null
export function createCodeGraphRevision(commit: string, snapshotDigest: string): string
export function parseCodeGraphRevision(value: unknown): {
  commit: string
  snapshotDigest: `sha256:${string}`
} | null
export function codeGraphRequestFromGalaxyObjectReference(
  reference: unknown,
  authorityScope: { tenantId: string; authorityScope: string },
): { objectKind: GalaxyCodeObjectKind; ref: CodeGraphRef; scope: CodeGraphScope } | null
export function projectCodeGraphEdgeToDurableRelation(edge: CodeGraphEdge): {
  relation: "defined_in" | "implements" | "depends_on"
  fromNodeId: string
  toNodeId: string
} | null
