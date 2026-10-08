export type ProofMissionIntentInput = {
  sourceGraphId: string
  sourceContentSha256: string
  missionId: string
  mainTargetId: string
  milestoneTargetIds?: readonly string[]
}

export type ProofMissionIntent = Readonly<{
  schema_id: "galaxy.proof-mission-intent.v1"
  source_graph: Readonly<{
    graph_id: string
    graph_kind: "repository-field"
    content_sha256: string
  }>
  mission_id: string
  main_target_id: string
  curated_milestone_target_ids: readonly string[]
  relation_direction: "prerequisite-to-dependent"
}>

export type ProofMissionCandidate = Readonly<{
  schemaId: "galaxy.proof-mission-candidate.v1"
  activationState: "inactive"
  registerable: false
  sourceGraph: Readonly<{
    graphId: string
    graphKind: "repository-field"
    contentSha256: string
  }>
  selection: Readonly<{
    missionId: string
    mainTargetId: string
    milestoneTargetIds: readonly string[]
    relationDirection: "prerequisite-to-dependent"
  }>
  missionContentSha256: string
  missionDag: Record<string, unknown> & {
    schema_id: "galaxy.proof-dag.v1"
    graph_id: string
    graph_kind: "mission"
    targets: unknown[]
    relations: unknown[]
  }
}>

export const MAX_PROOF_MISSION_INTENT_BYTES: 65536
export const MAX_PROOF_MISSION_ACTIVATION_BYTES: 131072

export type ProofMissionActivationInput = ProofMissionIntentInput & {
  expectedMissionContentSha256: string
  verificationSetContentSha256: string
  workspaceId: string
  idempotencyKey: string
}

export type ProofMissionActivationResult = Readonly<{
  schemaId: "galaxy.proof-mission-activation-result.v1"
  activationId: string
  sourceGraph: Readonly<{ graphId: string; contentSha256: string }>
  verificationSetContentSha256: string
  missionGraph: Readonly<{
    graphId: string
    contentSha256: string
    title: string
    targetCount: number
    relationCount: number
  }>
  workspace: Readonly<{
    workspaceId: string
    version: number
    updatedAt: string
    itemCount: number
  }>
  inheritedVerifiedNodeIds: readonly string[]
  initialFrontierNodeIds: readonly string[]
  activatedAt: string
  replayed?: true
}>

export function createProofMissionIntent(input: ProofMissionIntentInput): ProofMissionIntent
export function encodeProofMissionIntent(input: ProofMissionIntentInput): Readonly<{
  intent: ProofMissionIntent
  bytes: Uint8Array
}>
export function normalizeProofMissionCandidate(
  value: unknown,
  expected: ProofMissionIntentInput,
): ProofMissionCandidate
export function encodeProofMissionActivationRequest(
  input: ProofMissionActivationInput,
): Readonly<{ request: Readonly<Record<string, unknown>>; bytes: Uint8Array }>
export function normalizeProofMissionActivationResult(
  value: unknown,
  expected: ProofMissionActivationInput,
): ProofMissionActivationResult
