export type Prove2meGraphNode = {
  node_type: "theorem" | "sketch"
  theorem_id?: string
  node_id?: string
  theorem_name?: string
  theorem_title?: string
  status?: string
  natural_language_statement?: string
}

export type Prove2meGraphEdge = {
  source: string
  target: string
  kind: "sketch" | "structural"
}

export type Prove2meGraph = {
  root_id: string
  nodes: Prove2meGraphNode[]
  edges: Prove2meGraphEdge[]
  has_hidden_deprecated_sketches?: boolean
}

export type ProofDagDocument = {
  schema_id: "galaxy.proof-dag.v1"
  graph_id: string
  graph_kind: string
  title: string
  targets: Array<{
    target_id: string
    target_kind: string
    title: string
    natural_language_summary: string
    category: "prove2me-theorem"
    external: {
      prove2me: {
        theorem_id: string
      }
    }
  }>
  relations: Array<{
    relation_id: string
    relation_type: "REDUCES_TO"
    prerequisite_target_id: string
    dependent_target_id: string
  }>
}

export function prove2meGraphToProofDag(
  graph: Prove2meGraph,
  options?: Record<string, never>,
): ProofDagDocument
