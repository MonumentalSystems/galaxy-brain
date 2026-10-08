export type RelationProposalReviewItem = Readonly<{
  schemaId: "gb.relation-proposal-review-item.v1"
  proposalId: string
  fromRef: string
  toRef: string
  relation: string
  rationale: string
  source: "agent-tool"
  currentVersion: 1
  status: "pending"
  acceptEligible: boolean
  createdAt: string
}>

export type RelationProposalReviewPage = Readonly<{
  schemaId: "gb.relation-proposal-review-page.v1"
  items: readonly RelationProposalReviewItem[]
  bounded: boolean
  nextCursor: string | null
}>

export type RelationProposalDecisionReceipt = Readonly<{
  schemaId: "gb.relation-proposal-decision-receipt.v1"
  proposalId: string
  fromRef: string
  toRef: string
  relation: string
  decision: "accepted" | "rejected"
  currentVersion: 2
  objectLinkId: string | null
  replayed: boolean
  decidedAt: string
}>

export class RelationProposalReviewError extends Error {
  readonly code: string
}

export function parseRelationProposalReviewPage(value: unknown): RelationProposalReviewPage
export function parseRelationProposalDecisionReceipt(
  value: unknown,
  expected: RelationProposalReviewItem,
): RelationProposalDecisionReceipt
export function fetchRelationProposalReviews(signal?: AbortSignal, cursor?: string | null): Promise<RelationProposalReviewPage>
export function decideRelationProposal(
  proposal: RelationProposalReviewItem,
  decision: "accept" | "reject",
  reason: string,
  idempotencyKey: string,
): Promise<RelationProposalDecisionReceipt>
