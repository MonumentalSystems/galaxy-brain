export const MAX_PAPER_AGENT_RESULT_BYTES: number
export const MAX_PAPER_AGENT_RESULT_REFERENCES: number

export type PaperAgentResultLocation = Readonly<{
  documentRevisionId: string
  anchorId: string
}>

export type PaperAgentResultCandidate = Readonly<{
  schemaId: "gb.paper-agent-result-candidate.v1"
  taskId: string
  taskVersion: number
  eventId: string
  occurredAt: string
  runId: string | null
  performedByRef: string | null
  summary: string
  evidenceRefs: string[]
  resultHash: string
}>

export type PaperAgentResultDecisionInput = PaperAgentResultLocation & Readonly<{
  taskVersion: number
  eventId: string
  resultHash: string
  action: "accept" | "reject"
  idempotencyKey: string
}>

export function parsePaperAgentResultLocation(value: unknown): PaperAgentResultLocation
export function parsePaperAgentResultDecisionInput(value: unknown): PaperAgentResultDecisionInput
export function createPaperAgentResultCandidate(input: {
  taskId: string
  requesterUserId: string
  detail: unknown
  events: unknown[]
}): PaperAgentResultCandidate
export function assertPaperAgentResultCandidateMatch(
  input: Pick<PaperAgentResultDecisionInput, "taskVersion" | "eventId" | "resultHash">,
  candidate: PaperAgentResultCandidate,
): PaperAgentResultCandidate
export function paperAgentResultBackendPath(location: PaperAgentResultLocation, taskId: string): string
export function buildPaperAgentResultDecisionEnvelope(
  input: PaperAgentResultDecisionInput,
  candidate: PaperAgentResultCandidate,
): Readonly<Record<string, unknown>>
export function projectPaperAgentResultReview(
  candidate: PaperAgentResultCandidate,
  backendReview: unknown,
): Readonly<{
  schemaId: "gb.paper-agent-result.v1"
  taskId: string
  taskVersion: number
  eventId: string
  runId: string | null
  resultHash: string
  summary: string
  performedByRef: string | null
  occurredAt: string
  evidenceRefs: string[]
  decision: Readonly<{ action: "accept" | "reject"; acceptedDocumentRef?: string }> | null
}>
