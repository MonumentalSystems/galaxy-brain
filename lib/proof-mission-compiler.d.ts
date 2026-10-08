export type ProofMissionCompilerInput = {
  sourceProofDagBytes: Uint8Array
  missionId: string
  mainTargetId: string
  milestoneTargetIds?: string[]
  relationDirection: "prerequisite-to-dependent"
}

export type ProofMissionDocument = {
  schema_id: "galaxy.proof-dag.v1"
  graph_id: string
  graph_kind: "mission"
  title: string
  mission: {
    main_target_id: string
    curated_milestone_target_ids: string[]
  }
  provenance: {
    source_graph: {
      graph_id: string
      graph_kind: "repository-field"
      content_sha256: string
    }
    compiler: "galaxy.proof-mission-compiler.v1"
  }
  targets: Array<{
    target_id: string
    target_kind: string
    title: string
    natural_language_summary: string
    category: string
    source_id?: string
    source_label?: string
    formal_binding: {
      status: string
      module_ids?: string[]
      declaration_ids?: string[]
      binding_kind?: string
      mapping_rule?: string
      declaration_equivalence_claimed?: boolean
    }
  }>
  relations: Array<{
    relation_id: string
    relation_type: string
    prerequisite_target_id: string
    dependent_target_id: string
    source_edge_id?: string
    assertion_level?: string
    formal_correspondence?: {
      status: string
      support_kind: string | null
      declaration_path: string[] | null
      dependency_kinds_by_step: string[][]
    }
    bridge_nomination?: {
      nominated: boolean
      reason: string
    }
  }>
}

export type ProofMissionDraftDocument = {
  schema_id: "galaxy.proof-mission-draft.v1"
  source_graph: {
    graph_id: string
    graph_kind: "repository-field"
    content_sha256: string
  }
  selection: {
    mission_id: string
    main_target_id: string
    curated_milestone_target_ids: string[]
    relation_direction: "prerequisite-to-dependent"
  }
  mission_dag: ProofMissionDocument
}

export const PROOF_MISSION_COMPILER_LIMITS: Readonly<{
  sourceBytes: number
  targets: number
  relations: number
  milestones: number
}>

export function compileProofMission(input: ProofMissionCompilerInput): Promise<ProofMissionDraftDocument>
