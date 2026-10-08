import type { TaskSummary } from "./types/tasks"

export type ProofPacket = {
  packetId: string
  title: string
  objective: string
  prerequisitePacketIds: string[]
  theoremTargets: Array<Record<string, unknown> & { statement: string }>
  mandatoryControls: Array<Record<string, unknown> & { requirement: string }>
}

export type ProofTaskManifest = {
  schemaId: "ham.audit-program.v3"
  programId: string
  galaxyProofGraphRef: null | {
    schemaId: "galaxy.proof-graph-ref.v1"
    graphId: string
    contentSha256: string
  }
  packets: ProofPacket[]
}

export type ProofDagNode = {
  nodeId: string
  title: string
  objective: string
  category: string
  targetKind: string
  formalBindingStatus: string
  layer: number
  prerequisiteNodeIds: string[]
  theoremTargets: Array<Record<string, unknown> & { statement: string }>
  mandatoryControls: Array<Record<string, unknown> & { requirement: string }>
}

export type ProofDag = {
  schemaId: "galaxy.proof-dag.v1"
  graphId: string
  graphKind: string
  title: string
  contentSha256: string
  taskResourceBinding: "content-hash" | "legacy-program"
  coordinationGraphRef: null | {
    schemaId: "galaxy.proof-graph-ref.v1"
    graphId: string
    contentSha256: string
  }
  nodes: ProofDagNode[]
  edges: Array<{ id: string; source: string; target: string; relationType: string }>
}

export type ProofAuthority = {
  principalId: string
  nostrPubkey: string
  principalKind: "human" | "agent" | "service"
}

export type ProofVerification = {
  method: "hyades-run" | "lean-replay" | "signed-report"
  authority: ProofAuthority
  receiptId: string
  receiptSha256: string
  outcome: string
  solutionSha256: string
  sourceCommit: string
  leanToolchain: string
  mathlibRevision: string
  sorryFree: boolean
  verifiedAt: string
  hyades: null | { workflowId: string; runId: string; status: string }
}

export type ProofWorkItem = {
  nodeId: string
  version: number
  work: {
    status: "idle" | "claimed" | "running" | "submitted" | "blocked" | "closed"
    claim: null | { claimId: string; nostrPubkey: string; claimedAt: string; expiresAt: string }
    hyades: null | { workflowId: string; runId: string; status: string }
    blocker: string
    taskId: string
    linkedTaskCount: number
  }
  proof: {
    status: "open" | "candidate" | "attested" | "verified" | "rejected" | "overridden" | "superseded"
    candidateSha256: string | null
    candidateProvenance: null | {
      sourceCommit: string
      leanToolchain: string
      mathlibRevision: string
    }
    candidateAuthority: ProofAuthority | null
    candidateSubmittedAt: string | null
    attestation: null | {
      method: "external-attestation"
      authority: ProofAuthority
      statement: string
      evidenceSha256: string | null
      attestedAt: string
    }
    verification: ProofVerification | null
    override: null | {
      authority: ProofAuthority
      reason: string
      evidenceSha256: string | null
      overriddenAt: string
    }
  }
  external: Record<string, unknown>
}

export type ProofWorkState = {
  schemaId: "galaxy.proof-work-state.v1"
  workspaceId: string
  graphRef: { graphId: string; contentSha256: string }
  version: number
  updatedAt: string
  items: ProofWorkItem[]
}

export type ProofTaskGraphNode = ProofDagNode & {
  packetId: string
  prerequisitePacketIds: string[]
  workItem: ProofWorkItem | null
  state: "reference" | "available" | "claimed" | "running" | "attested" | "completed" | "overridden" | "blocked" | "waiting"
  coordinationLabel: string
}

export type ProofTaskGraphProjection = {
  programId: string
  proofDag: ProofDag
  workState: ProofWorkState
  nodes: ProofTaskGraphNode[]
  edges: ProofDag["edges"]
}

export function parseProofTaskManifest(input: unknown): ProofTaskManifest
export function parseProofDag(input: unknown, contentSha256: string): ProofDag
export function parseProofWorkState(input: unknown, proofDag: ProofDag): ProofWorkState
export function projectProofTaskGraph(proofDag: ProofDag, workState: ProofWorkState | unknown): ProofTaskGraphProjection
export function proofDagFromHamManifest(manifest: ProofTaskManifest, contentSha256: string): ProofDag
export function proofWorkStateFromHamTasks(proofDag: ProofDag, tasks?: TaskSummary[]): ProofWorkState
export function sha256Text(value: string): Promise<string>
export function proofTaskResourceRef(programId: string, packetId: string, contentSha256?: string | null): string
export function parseProofTaskResourceRef(value: unknown): { programId: string; packetId: string; contentSha256: string | null } | null
export function buildProofTaskGraph(manifest: ProofTaskManifest, tasks?: TaskSummary[]): ProofTaskGraphProjection
