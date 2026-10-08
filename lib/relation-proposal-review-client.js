import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "./galaxy-object-reference.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const KEY = /^[A-Za-z0-9._:-]{8,200}$/u
const RELATIONS = new Set([
  "related", "cites", "part_of", "derived_from", "context_for",
  "formalized_by", "defined_in", "implements", "depends_on", "documents",
  "corresponds_to",
])

export class RelationProposalReviewError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "RelationProposalReviewError"
    this.code = code
  }
}

function exactObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
}

function exactKeys(value, keys) {
  return exactObject(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
}

function canonicalReference(value) {
  if (typeof value !== "string") return null
  const parsed = parseGalaxyObjectReference(value)
  if (!parsed || parsed.format !== "canonical") return null
  try {
    return serializeGalaxyObjectReference(parsed) === value ? parsed : null
  } catch {
    return null
  }
}

export function parseRelationProposalReviewPage(value) {
  if (!exactKeys(value, ["schemaId", "items", "bounded", "nextCursor"])
    || value.schemaId !== "gb.relation-proposal-review-page.v1"
    || !Array.isArray(value.items)
    || typeof value.bounded !== "boolean"
    || (value.nextCursor !== null && (
      typeof value.nextCursor !== "string" || !/^[A-Za-z0-9_.-]{1,512}$/u.test(value.nextCursor)
    ))
    || value.bounded !== (value.nextCursor !== null)
    || value.items.length > 20) {
    throw new RelationProposalReviewError("invalid_response", "Relation review returned an invalid page.")
  }
  const seen = new Set()
  const items = value.items.map((item) => {
    if (!exactKeys(item, [
      "schemaId", "proposalId", "fromRef", "toRef", "relation", "rationale",
      "source", "currentVersion", "status", "acceptEligible", "createdAt",
    ])
      || item.schemaId !== "gb.relation-proposal-review-item.v1"
      || typeof item.proposalId !== "string" || !UUID.test(item.proposalId)
      || seen.has(item.proposalId)
      || !canonicalReference(item.fromRef)
      || !canonicalReference(item.toRef)
      || item.fromRef === item.toRef
      || !RELATIONS.has(item.relation)
      || typeof item.rationale !== "string" || !item.rationale.trim()
      || new TextEncoder().encode(item.rationale).byteLength > 4096
      || item.source !== "agent-tool"
      || item.currentVersion !== 1
      || item.status !== "pending"
      || typeof item.acceptEligible !== "boolean"
      || item.acceptEligible !== (
        canonicalReference(item.fromRef)?.selector.mode === "pinned"
        && canonicalReference(item.toRef)?.selector.mode === "pinned"
      )
      || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) {
      throw new RelationProposalReviewError("invalid_response", "Relation review returned an invalid proposal.")
    }
    seen.add(item.proposalId)
    return Object.freeze({ ...item })
  })
  return Object.freeze({
    schemaId: "gb.relation-proposal-review-page.v1",
    items: Object.freeze(items),
    bounded: value.bounded,
    nextCursor: value.nextCursor,
  })
}

export function parseRelationProposalDecisionReceipt(value, expected) {
  if (!exactKeys(value, [
    "schemaId", "proposalId", "fromRef", "toRef", "relation", "decision",
    "currentVersion", "objectLinkId", "replayed", "decidedAt",
  ])
    || value.schemaId !== "gb.relation-proposal-decision-receipt.v1"
    || value.proposalId !== expected.proposalId
    || value.fromRef !== expected.fromRef
    || value.toRef !== expected.toRef
    || value.relation !== expected.relation
    || !["accepted", "rejected"].includes(value.decision)
    || value.currentVersion !== 2
    || typeof value.replayed !== "boolean"
    || typeof value.decidedAt !== "string" || !Number.isFinite(Date.parse(value.decidedAt))
    || (value.decision === "accepted" ? typeof value.objectLinkId !== "string" || !UUID.test(value.objectLinkId) : value.objectLinkId !== null)) {
    throw new RelationProposalReviewError("invalid_response", "Relation review returned an invalid decision receipt.")
  }
  return Object.freeze({ ...value })
}

async function json(response) {
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const code = exactObject(body) && typeof body.code === "string" ? body.code : "request_failed"
    const message = exactObject(body) && typeof body.error === "string"
      ? body.error
      : "Relation review is unavailable."
    throw new RelationProposalReviewError(code, message)
  }
  return body
}

export async function fetchRelationProposalReviews(signal, cursor = null) {
  const query = new URLSearchParams()
  if (cursor) query.set("cursor", cursor)
  const response = await fetch(`/api/relation-proposal-reviews${query.size ? `?${query}` : ""}`, {
    cache: "no-store",
    signal,
  })
  return parseRelationProposalReviewPage(await json(response))
}

export async function decideRelationProposal(proposal, decision, reason, idempotencyKey) {
  if (!["accept", "reject"].includes(decision)
    || typeof reason !== "string" || !reason.trim() || reason !== reason.trim()
    || new TextEncoder().encode(reason).byteLength > 4096
    || typeof idempotencyKey !== "string" || !KEY.test(idempotencyKey)) {
    throw new RelationProposalReviewError("invalid_input", "Enter a bounded review reason before deciding.")
  }
  const response = await fetch(`/api/relation-proposal-reviews/${encodeURIComponent(proposal.proposalId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      decision,
      expected_version: proposal.currentVersion,
      reason,
      idempotency_key: idempotencyKey,
    }),
  })
  return parseRelationProposalDecisionReceipt(await json(response), proposal)
}
