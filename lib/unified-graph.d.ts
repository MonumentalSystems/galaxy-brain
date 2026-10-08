import type { GalaxyObjectProjection } from "./object-projection"

export type GalaxyGraphTrust = "structure" | "assertion" | "verification" | "candidate"
export type GalaxyProofGraphKind = "repository-field" | "campaign" | "mission"

export interface GalaxyGraphScope {
  tenantId: string
  workspaceId: string
}

export interface GalaxyGraphQuery {
  rootRef?: string | null
  mode?: "mixed" | "proof" | "task" | "conversation" | "citation" | "federated"
  lens?: "explore" | "verify" | "compose"
  scale?: "corpus" | "project" | "task" | "run" | "object" | "atomic"
  viewport?: { x: number; y: number; width: number; height: number } | null
  filters?: { kinds?: string[]; relations?: GalaxyGraphRelation[] }
  validAt?: string | null
  knownAt?: string | null
  cursor?: string | null
}

export type GalaxyGraphRelation =
  | "related" | "cites" | "part_of" | "derived_from" | "context_for"
  | "formalized_by" | "defined_in" | "implements" | "depends_on" | "documents"
  | "corresponds_to" | "contains" | "defines" | "imports" | "calls" | "extends"
  | "verifies" | "references" | "supports" | "near" | "supersedes"
  | "superseded_by" | "contradicts" | "verified_by" | "cited_by" | "required_by"
  | "coordinated_by" | "continues" | "forks" | "joins"

export interface ScopedProjection {
  scope: GalaxyGraphScope
  projection: GalaxyObjectProjection
}

export interface ScopedResolvedProjection extends ScopedProjection {
  resolution: {
    authorized: boolean
    tenantId: string
    workspaceId: string
    provider: string
    requestedRef: string
    resolvedRef: string
  }
}

export interface GalaxyGraphSource {
  provider: string
  recordId?: string
  revision?: string
  sourceRef?: string
  extractorVersion?: string
  confidence?: number
  resourceMode?: string
  resourceStatus?: string
}

export interface ScopedGalaxyObjectLink {
  scope: GalaxyGraphScope
  link: {
    id?: string
    from_ref: string
    to_ref: string
    relation: Extract<GalaxyGraphRelation,
      "related" | "cites" | "part_of" | "derived_from" | "context_for" |
      "formalized_by" | "defined_in" | "implements" | "depends_on" | "documents" |
      "corresponds_to">
    basis: "authored" | "imported" | "derived"
    provenance: {
      source: string
      source_system?: string
      source_ref?: string
      source_snapshot?: string
      extractor_version?: string
      confidence?: number
    }
  }
}

export interface ScopedGalaxyGraphRelation {
  scope: GalaxyGraphScope
  relation: {
    fromRef: string
    toRef: string
    relation: GalaxyGraphRelation
    trust: GalaxyGraphTrust
    source: GalaxyGraphSource
    verification?: { status: "verified"; method: string; evidenceRef: string }
  }
}

export interface ScopedProofContext {
  scope: GalaxyGraphScope
  graphRef: string
  graphKind: GalaxyProofGraphKind
  coordinationActive?: boolean
  nodeRefs: string[]
  nodeStates?: Array<{
    nodeRef: string
    state: "reference" | "available" | "claimed" | "running" | "attested" | "completed" | "overridden" | "blocked" | "waiting"
    coordinationLabel: string
    itemVersion?: number
    workStatus?: "idle" | "claimed" | "running" | "submitted" | "blocked" | "closed"
    proofStatus?: "open" | "candidate" | "attested" | "verified" | "rejected" | "overridden" | "superseded"
    claim?: { claimId: string; expiresAt: string }
    run?: { runId: string; status: string }
    taskId?: string
    linkedTaskCount?: number
    candidateSha256?: string
    verification?: {
      status: "verified"
      method: "hyades-run" | "lean-replay" | "signed-report"
      evidenceRef: string
      solutionSha256: string
      sorryFree: true
      verifiedAt: string
    }
    external?: { rosettaStatus?: string; prove2meStatus?: string }
  }>
}

export interface UnifiedGraphInput {
  schemaId: "gb.graph-projection-input.v1"
  scope: GalaxyGraphScope
  query: GalaxyGraphQuery
  objects: ScopedProjection[]
  external?: ScopedResolvedProjection[]
  links?: ScopedGalaxyObjectLink[]
  relations?: ScopedGalaxyGraphRelation[]
  proofContexts?: ScopedProofContext[]
  providers?: Array<{
    scope: GalaxyGraphScope
    provider: string
    status: "ready" | "partial" | "unavailable"
    snapshot?: string
    revision?: string
  }>
}

export interface UnifiedGraphNode {
  id: string
  ref: string
  kind: string
  title: string
  summary?: string
  authority: "galaxy" | "external-resolved"
  projection: GalaxyObjectProjection
  provenance: ReadonlyArray<Record<string, string>>
  overlays: {
    proof?: {
      graphRef: string
      graphKind: GalaxyProofGraphKind
      coordinationActive: boolean
      workPolicy: "passive" | "explicit-task-materialization"
      nodeState?: NonNullable<ScopedProofContext["nodeStates"]>[number]
    }
  }
  projector?: Readonly<{
    plugin: Readonly<{
      id: string
      displayName: string
      version: string
    }> | null
    diagnostic: "projector_unavailable" | null
  }>
  representation?: "glyph" | "label" | "card" | "detail" | "placeholder"
  placeholder?: boolean
  detail?: Readonly<Record<string, unknown>>
}

export interface UnifiedGraphEdge {
  id: string
  from: string
  to: string
  fromRef: string
  toRef: string
  relation: GalaxyGraphRelation
  trust: GalaxyGraphTrust
  source: GalaxyGraphSource
  sourceRelation?: GalaxyGraphRelation
  verification?: { status: "verified"; method: string; evidenceRef: string }
}

export interface UnifiedGraphProjection {
  schemaId: "gb.graph-projection.v1"
  query: Required<GalaxyGraphQuery>
  projectionHash: string
  nodes: ReadonlyArray<UnifiedGraphNode>
  edges: ReadonlyArray<UnifiedGraphEdge>
  aggregates: Readonly<Record<string, unknown>>
  provenance: Readonly<Record<string, unknown>>
  continuation: {
    cursor: string | null
    hasMore: boolean
    omitted: { nodes: number; edges: number; fanout: number }
    reasons: string[]
  }
}

export const GALAXY_GRAPH_PROJECTION_SCHEMA_ID: "gb.graph-projection.v1"
export const GALAXY_GRAPH_INPUT_SCHEMA_ID: "gb.graph-projection-input.v1"
export const GALAXY_GRAPH_TRUST_CLASSES: ReadonlyArray<GalaxyGraphTrust>
export const GALAXY_GRAPH_LINK_RELATIONS: ReadonlyArray<GalaxyGraphRelation>
export const GALAXY_GRAPH_RELATIONS: ReadonlyArray<GalaxyGraphRelation>

export function projectUnifiedGraph(
  input: UnifiedGraphInput | unknown,
  options?: { maxNodes?: number; maxEdges?: number; maxFanout?: number },
): UnifiedGraphProjection

export function deriveUnifiedGraphView(graph: UnifiedGraphProjection, moving?: boolean): UnifiedGraphProjection
