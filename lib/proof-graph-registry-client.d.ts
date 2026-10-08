export type ProofGraphKind = "repository-field" | "campaign" | "mission"

export interface ProofGraphSummary {
  schemaId: "gb.proof-graph.summary.v1"
  registrationId: string
  graphId: string
  graphKind: ProofGraphKind
  title: string
  contentSha256: string
  byteSize: number
  targetCount: number
  relationCount: number
  registeredByPrincipalId: string
  registeredByNostrPubkey: string
  registeredAt: string
  replayed?: true
}

export interface ProofWorkspaceSummary {
  workspaceId: string
  version: number
  updatedAt: string
  itemCount: number
}

export interface ProofVerificationSetSummary {
  schemaId: "gb.proof-verification-set.summary.v1"
  registrationId: string
  graphRef: { graphId: string; contentSha256: string }
  contentSha256: string
  byteSize: number
  itemCount: number
  registeredByPrincipalId: string
  registeredByNostrPubkey: string
  registeredAt: string
  replayed?: true
}

export interface ProofGraphList {
  schemaId: "gb.proof-graph.list.v1"
  graphs: readonly ProofGraphSummary[]
  hasMore: boolean
  nextOffset: number | null
}

export interface ProofWorkspaceList {
  schemaId: "galaxy.proof-workspace-summary-list.v1"
  graphRef: { graphId: string; contentSha256: string }
  workspaces: readonly ProofWorkspaceSummary[]
  hasMore: boolean
  nextOffset: number | null
}

export interface ProofGraphSelection {
  summary: ProofGraphSummary
  proofDag: Record<string, unknown>
  exactBytes: Uint8Array
  workspace: ProofWorkspaceSummary | null
  workState: Record<string, unknown> | null
  coordinationActive: boolean
}

export const PROOF_GRAPH_SELECTION_EVENT: "galaxy:proof-graph-selection-change"

export function normalizeProofGraphSummary(value: unknown): ProofGraphSummary
export function normalizeProofGraphList(value: unknown): ProofGraphList
export function normalizeProofWorkspaceList(
  value: unknown,
  expectedGraph: { graphId: string; contentSha256: string },
): ProofWorkspaceList
export function normalizeProofVerificationSetList(
  value: unknown,
  expectedGraph: { graphId: string; contentSha256: string },
): Readonly<{
  schemaId: "gb.proof-verification-set.list.v1"
  verificationSets: readonly ProofVerificationSetSummary[]
  hasMore: boolean
  nextOffset: number | null
}>
export function encodeEmptyProofVerificationSet(
  graph: { graphId: string; contentSha256: string },
): Readonly<{
  artifact: Readonly<{
    schema_id: "galaxy.proof-verification-set.v1"
    graph_ref: Readonly<{ graph_id: string; content_sha256: string }>
    items: readonly []
  }>
  bytes: Uint8Array
}>
export function createProofGraphSelection(input: {
  summary: unknown
  proofDag: unknown
  exactBytes: Uint8Array
  workspace?: unknown | null
  workState?: unknown | null
}): ProofGraphSelection
export function proofRegistryErrorMessage(status: number, body: unknown, fallback: string): string
export function proofGraphDigestFromReference(reference: unknown): string | null
export function proofGraphSelectionFromUrl(currentUrl: string): Readonly<{
  graphHash: string
  workspaceId: string
}>
export function proofGraphSelectionUrl(
  currentUrl: string,
  selection: { contentSha256: string; workspaceId?: string | null } | null,
): string
export function proofRegistryPresenterUrl(currentUrl: string, open: boolean): string
