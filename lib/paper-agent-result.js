import { createHash } from "node:crypto"

import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "./galaxy-object-reference.js"

export const MAX_PAPER_AGENT_RESULT_BYTES = 65_536
export const MAX_PAPER_AGENT_RESULT_REFERENCES = 50
const MAX_PAPER_AGENT_RESULT_CHARACTERS = 20_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const ANCHOR_ID = /^sha256:[0-9a-f]{64}$/u
const TASK_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$/u
const ACTOR_REF = /^[A-Za-z0-9._:-]{1,200}$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u
const RESULT_HASH = /^sha256:[0-9a-f]{64}$/u
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u

function invalid(message) {
  throw new TypeError(`Invalid paper agent result: ${message}`)
}

function exactRecord(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(`${label} contains unsupported fields`)
  }
  return value
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) invalid(`${label} must be a positive safe integer`)
  return value
}

function canonicalEventId(value) {
  if (typeof value === "number") return String(positiveInteger(value, "completion event id"))
  if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/u.test(value)) {
    invalid("completion event id is invalid")
  }
  const parsed = Number(value)
  positiveInteger(parsed, "completion event id")
  return String(parsed)
}

function boundedSummary(value) {
  if (typeof value !== "string" || !value.trim()) invalid("completion summary is required")
  if (
    Array.from(value).length > MAX_PAPER_AGENT_RESULT_CHARACTERS
    || /\u0000|[\ud800-\udfff]/u.test(value)
    || Buffer.byteLength(value, "utf8") > MAX_PAPER_AGENT_RESULT_BYTES
  ) {
    invalid("completion summary exceeds the bounded UTF-8 contract")
  }
  return value.trim()
}

function occurredAt(value) {
  const match = typeof value === "string" && value.length <= 64 ? ISO_TIMESTAMP.exec(value) : null
  if (!match) {
    invalid("completion occurred_at is invalid")
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [
    yearText, monthText, dayText, hourText, minuteText, secondText,
    offsetHourText ?? "0", offsetMinuteText ?? "0",
  ].map((part) => Number.parseInt(part, 10))
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (
    year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
  ) invalid("completion occurred_at is invalid")
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) invalid("completion occurred_at is invalid")
  return value
}

function pinnedEvidenceReference(value) {
  if (typeof value !== "string" || Array.from(value).length > 500) return null
  const parsed = parseGalaxyObjectReference(value)
  if (!parsed || parsed.format !== "canonical" || parsed.selector.mode !== "pinned") return null
  try {
    return serializeGalaxyObjectReference(parsed) === value ? value : null
  } catch {
    return null
  }
}

function evidenceReferences(event) {
  const raw = event?.evidence?.references
  if (!Array.isArray(raw)) invalid("completion evidence.references is required")
  if (raw.length < 1 || raw.length > MAX_PAPER_AGENT_RESULT_REFERENCES) {
    invalid(`completion evidence must contain between 1 and ${MAX_PAPER_AGENT_RESULT_REFERENCES} references`)
  }
  const references = []
  for (const value of raw) {
    const reference = pinnedEvidenceReference(value)
    if (!reference) invalid("completion evidence contains a malformed, noncanonical, or unpinned reference")
    if (references.includes(reference)) invalid("completion evidence references must be unique")
    references.push(reference)
  }
  return references
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value)
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
}

export function parsePaperAgentResultLocation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("location is required")
  const documentRevisionId = value.documentRevisionId
  const anchorId = value.anchorId
  if (typeof documentRevisionId !== "string" || !UUID.test(documentRevisionId)) {
    invalid("documentRevisionId must be a UUID")
  }
  if (typeof anchorId !== "string" || !ANCHOR_ID.test(anchorId)) {
    invalid("anchorId must be a canonical document anchor id")
  }
  return Object.freeze({ documentRevisionId: documentRevisionId.toLowerCase(), anchorId })
}

export function parsePaperAgentResultDecisionInput(value) {
  const input = exactRecord(value, [
    "documentRevisionId", "anchorId", "taskVersion", "eventId",
    "resultHash", "action", "idempotencyKey",
  ], "decision")
  const location = parsePaperAgentResultLocation(input)
  const taskVersion = positiveInteger(input.taskVersion, "taskVersion")
  const eventId = canonicalEventId(input.eventId)
  if (typeof input.resultHash !== "string" || !RESULT_HASH.test(input.resultHash)) {
    invalid("resultHash must be a sha256 reference")
  }
  if (!new Set(["accept", "reject"]).has(input.action)) invalid("action must be accept or reject")
  if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    invalid("idempotencyKey is invalid")
  }
  return Object.freeze({
    ...location,
    taskVersion,
    eventId,
    resultHash: input.resultHash,
    action: input.action,
    idempotencyKey: input.idempotencyKey,
  })
}

export function createPaperAgentResultCandidate({ taskId, requesterUserId, detail, events }) {
  if (typeof taskId !== "string" || !TASK_ID.test(taskId)) invalid("taskId is invalid")
  if (typeof requesterUserId !== "string" || !requesterUserId) invalid("requesterUserId is required")
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) invalid("HAM task detail is invalid")
  if (detail.task_id !== taskId) invalid("HAM returned a different task")
  if (detail.requester_ref !== `galaxy-brain:user:${requesterUserId}`) {
    invalid("HAM task requester does not match the signed-in human")
  }
  if (detail.status !== "completed") invalid("HAM task is not completed")
  const taskVersion = positiveInteger(detail.version, "HAM task version")
  if (!Array.isArray(events)) invalid("HAM task events are invalid")

  const completions = events.filter((event) => (
    event && typeof event === "object" && !Array.isArray(event)
    && event.event_type === "completed"
    && event.task_id === taskId
    && event.task_version === taskVersion
  ))
  if (completions.length < 1) invalid("HAM task has no completion event bound to its terminal head")
  const event = completions.reduce((latest, candidate) => (
    Number(canonicalEventId(candidate.event_id)) > Number(canonicalEventId(latest.event_id)) ? candidate : latest
  ))
  const eventId = canonicalEventId(event.event_id)
  const summary = boundedSummary(event.summary)
  const completionOccurredAt = occurredAt(event.occurred_at)
  const external = event.evidence?.completion_kind === "external"
  const runId = typeof event.run_id === "string" && TASK_ID.test(event.run_id) ? event.run_id : null
  if (!external && !runId) invalid("completion run id is invalid")
  const externalPerformer = event.evidence?.performed_by_ref
  const performedByRef = external
    ? typeof externalPerformer === "string" && ACTOR_REF.test(externalPerformer) ? externalPerformer : null
    : typeof event.actor_agent_id === "string" && ACTOR_REF.test(event.actor_agent_id)
      ? event.actor_agent_id
      : null
  if (!external && !performedByRef) invalid("completion actor reference is invalid")
  const evidenceRefs = evidenceReferences(event)
  const hashInput = {
    schemaId: "gb.paper-agent-result-candidate.v1",
    taskId,
    taskVersion,
    eventId,
    occurredAt: completionOccurredAt,
    runId,
    performedByRef,
    summary,
    evidenceRefs,
  }
  const resultHash = `sha256:${createHash("sha256").update(canonicalJson(hashInput)).digest("hex")}`
  return Object.freeze({ ...hashInput, resultHash })
}

export function assertPaperAgentResultCandidateMatch(input, candidate) {
  if (
    input.taskVersion !== candidate.taskVersion
    || input.eventId !== candidate.eventId
    || input.resultHash !== candidate.resultHash
  ) invalid("authoritative HAM result changed; refresh before deciding")
  return candidate
}

export function paperAgentResultBackendPath(location, taskId) {
  const normalized = parsePaperAgentResultLocation(location)
  if (typeof taskId !== "string" || !TASK_ID.test(taskId)) invalid("taskId is invalid")
  return `/documents/${encodeURIComponent(normalized.documentRevisionId)}/anchors/${encodeURIComponent(normalized.anchorId)}/agent-results/${encodeURIComponent(taskId)}`
}

export function buildPaperAgentResultDecisionEnvelope(input, candidate) {
  assertPaperAgentResultCandidateMatch(input, candidate)
  return Object.freeze({
    schemaId: "gb.paper-agent-result-decision.v1",
    taskId: candidate.taskId,
    taskVersion: candidate.taskVersion,
    eventId: candidate.eventId,
    occurredAt: candidate.occurredAt,
    runId: candidate.runId,
    resultHash: candidate.resultHash,
    performedByRef: candidate.performedByRef,
    summary: candidate.summary,
    evidenceRefs: [...candidate.evidenceRefs],
    action: input.action,
    idempotencyKey: input.idempotencyKey,
  })
}

export function projectPaperAgentResultReview(candidate, backendReview) {
  const review = backendReview && typeof backendReview === "object" && !Array.isArray(backendReview)
    ? backendReview
    : null
  if (!review || review.schemaId !== "gb.paper-agent-result-review.v1") {
    invalid("Galaxy result review response is invalid")
  }
  for (const [field, expected] of [
    ["taskVersion", candidate.taskVersion],
    ["eventId", candidate.eventId],
    ["resultHash", candidate.resultHash],
  ]) {
    if (review[field] !== undefined && review[field] !== expected) {
      invalid("Galaxy result review does not match the authoritative HAM result")
    }
  }
  let decision
  if (review.reviewState === "accepted" || review.reviewState === "rejected") {
    const action = review.reviewState === "accepted" ? "accept" : "reject"
    let acceptedDocumentRef
    if (action === "accept") {
      const parsed = parseGalaxyObjectReference(review.resultRef)
      try {
        acceptedDocumentRef = parsed?.format === "canonical"
          && parsed.kind === "document"
          && parsed.selector.mode === "pinned"
          && serializeGalaxyObjectReference(parsed) === review.resultRef
          ? review.resultRef
          : null
      } catch {
        acceptedDocumentRef = null
      }
      if (!acceptedDocumentRef) invalid("accepted Galaxy result is missing its exact document reference")
    } else if (review.resultRef !== null && review.resultRef !== undefined) {
      invalid("rejected Galaxy result cannot expose an accepted document reference")
    }
    decision = Object.freeze({ action, ...(acceptedDocumentRef ? { acceptedDocumentRef } : {}) })
  } else if (!new Set(["unreviewed", "pending"]).has(review.reviewState)) {
    invalid("Galaxy result review state is invalid")
  }
  return Object.freeze({
    schemaId: "gb.paper-agent-result.v1",
    taskId: candidate.taskId,
    taskVersion: candidate.taskVersion,
    eventId: candidate.eventId,
    runId: candidate.runId,
    resultHash: candidate.resultHash,
    summary: candidate.summary,
    performedByRef: candidate.performedByRef,
    occurredAt: candidate.occurredAt,
    evidenceRefs: [...candidate.evidenceRefs],
    decision: decision ?? null,
  })
}
