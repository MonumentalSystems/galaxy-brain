import type { SemanticEntity, SemanticFieldProjection, SemanticRelation } from "./semantic-field"

export type FederatedTrustClass =
  | "deterministic_structure"
  | "authored_assertion"
  | "verified_proof"
  | "semantic_candidate"

export type FederatedObjectKind =
  | "paper"
  | "document"
  | "document.anchor"
  | "code.repo"
  | "code.commit"
  | "code.file"
  | "code.symbol"
  | "code.graph"
  | "proof.graph"
  | "proof.node"
  | "ham.memory"

export interface FederatedSource {
  provider: string
  recordId?: string
  revision?: string
}

export interface FederatedGraphNodeInput {
  ref: string
  title: string
  detail?: string
  happenedAt?: string
  source: FederatedSource
}

export interface FederatedVerification {
  status: "verified"
  method: string
  evidenceRef: string
}

export interface FederatedGraphEdgeInput {
  fromRef: string
  toRef: string
  relation:
    | "contains"
    | "depends_on"
    | "defines"
    | "imports"
    | "calls"
    | "extends"
    | "implements"
    | "verifies"
    | "related"
    | "cites"
    | "part_of"
    | "derived_from"
    | "context_for"
    | "formalized_by"
    | "defined_in"
    | "documents"
    | "corresponds_to"
    | "references"
    | "supports"
    | "near"
    | "supersedes"
    | "superseded_by"
    | "contradicts"
    | "verified_by"
    | "cited_by"
    | "required_by"
  basis: FederatedTrustClass
  source: FederatedSource
  verification?: FederatedVerification
}

export interface FederatedGraphProjection extends SemanticFieldProjection {
  entities: Array<SemanticEntity & {
    sourceReference: string
    sourceKind: FederatedObjectKind
    sources: FederatedSource[]
  }>
  relations: Array<SemanticRelation & {
    basis: FederatedTrustClass
    source: FederatedSource
    sourceRelation?: string
    verification?: FederatedVerification
  }>
  truncation: {
    nodeLimitReached: boolean
    edgeLimitReached: boolean
    fanoutOmissions: number
    rejectedNodes: number
    rejectedEdges: number
    limits: { maxNodes: number; maxEdges: number; maxFanout: number }
  }
}

export interface FederatedLedgerLinkInput {
  id?: string
  from_ref: string
  to_ref: string
  relation:
    | "related"
    | "cites"
    | "part_of"
    | "derived_from"
    | "context_for"
    | "formalized_by"
    | "defined_in"
    | "implements"
    | "depends_on"
    | "documents"
    | "corresponds_to"
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

export function projectFederatedGraph(
  input: {
    nodes: FederatedGraphNodeInput[]
    edges?: FederatedGraphEdgeInput[]
    links?: FederatedLedgerLinkInput[]
  } | unknown,
  options?: { maxNodes?: number; maxEdges?: number; maxFanout?: number },
): FederatedGraphProjection
