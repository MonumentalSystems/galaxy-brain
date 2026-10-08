import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  assertPaperAgentResultCandidateMatch,
  buildPaperAgentResultDecisionEnvelope,
  createPaperAgentResultCandidate,
  paperAgentResultBackendPath,
  parsePaperAgentResultDecisionInput,
  projectPaperAgentResultReview,
} from "../lib/paper-agent-result.js"

const revisionId = "10000000-0000-4000-8000-000000000001"
const anchorId = `sha256:${"a".repeat(64)}`
const anchorRef = `gb:object:v1:document.anchor:sha256%3A${"a".repeat(64)}:pinned:sha256%3A${"b".repeat(64)}`
const documentRef = `gb:object:v1:document:10000000-0000-4000-8000-000000000002:pinned:sha256%3A${"c".repeat(64)}`

const detail = {
  task_id: "task-enhance-1",
  requester_ref: "galaxy-brain:user:user-1",
  status: "completed",
  version: 9,
}

function completed(overrides = {}) {
  return {
    event_id: 41,
    event_type: "completed",
    task_id: "task-enhance-1",
    task_version: 9,
    occurred_at: "2026-10-03T14:05:06.123Z",
    run_id: "run-enhance-1",
    actor_agent_id: "agent:researcher",
    summary: "Supported, with one important limitation.",
    evidence: { references: [anchorRef, documentRef] },
    ...overrides,
  }
}

function candidate(events = [completed()]) {
  return createPaperAgentResultCandidate({
    taskId: "task-enhance-1",
    requesterUserId: "user-1",
    detail,
    events,
  })
}

test("terminal HAM head and exact completion event produce a deterministic cited candidate", () => {
  const result = candidate([completed({ event_id: 40, summary: "Older" }), completed()])
  assert.equal(result.taskVersion, 9)
  assert.equal(result.eventId, "41")
  assert.equal(result.occurredAt, "2026-10-03T14:05:06.123Z")
  assert.equal(result.runId, "run-enhance-1")
  assert.equal(result.performedByRef, "agent:researcher")
  assert.deepEqual(result.evidenceRefs, [anchorRef, documentRef])
  assert.match(result.resultHash, /^sha256:[0-9a-f]{64}$/u)
  assert.equal(candidate().resultHash, candidate().resultHash)
  assert.throws(() => candidate([completed({ task_version: 8 })]), /terminal head/u)
  assert.throws(() => candidate([completed({ occurred_at: "not-a-time" })]), /occurred_at/u)
  assert.throws(() => candidate([completed({ summary: "x".repeat(20_001) })]), /bounded UTF-8/u)
  assert.throws(() => createPaperAgentResultCandidate({
    taskId: "task-enhance-1", requesterUserId: "other", detail, events: [completed()],
  }), /requester/u)
})

test("citation extraction fails closed instead of dropping malformed or duplicate entries", () => {
  assert.throws(() => candidate([completed({ evidence: { references: [anchorRef, anchorRef] } })]), /unique/u)
  assert.throws(() => candidate([completed({ evidence: { references: [anchorRef, "https://invalid.example"] } })]), /malformed/u)
  assert.throws(() => candidate([completed({ evidence: { references: [] } })]), /between 1 and 50/u)
  assert.throws(() => candidate([completed({
    evidence: { references: Array.from({ length: 51 }, (_, index) => `${anchorRef}${index}`) },
  })]), /between 1 and 50/u)
})

test("explicit external completion may omit a run and uses its declared performer", () => {
  const result = candidate([completed({
    run_id: null,
    actor_agent_id: "galaxy-brain:user:user-1",
    evidence: {
      completion_kind: "external",
      performed_by_ref: "human:external-researcher",
      requester_ref: "galaxy-brain:user:user-1",
      references: [anchorRef],
    },
  })])
  assert.equal(result.runId, null)
  assert.equal(result.performedByRef, "human:external-researcher")

  const anonymous = candidate([completed({
    run_id: null,
    evidence: { completion_kind: "external", performed_by_ref: null, references: [anchorRef] },
  })])
  assert.equal(anonymous.runId, null)
  assert.equal(anonymous.performedByRef, null)
})

test("browser decisions are identifier-only and fenced to the refetched result", () => {
  const authoritative = candidate()
  const input = parsePaperAgentResultDecisionInput({
    documentRevisionId: revisionId,
    anchorId,
    taskVersion: authoritative.taskVersion,
    eventId: authoritative.eventId,
    resultHash: authoritative.resultHash,
    action: "accept",
    idempotencyKey: "paper-agent-result:decision-1",
  })
  assert.equal(assertPaperAgentResultCandidateMatch(input, authoritative), authoritative)
  const envelope = buildPaperAgentResultDecisionEnvelope(input, authoritative)
  assert.equal(envelope.summary, authoritative.summary)
  assert.equal(envelope.occurredAt, authoritative.occurredAt)
  assert.deepEqual(envelope.evidenceRefs, authoritative.evidenceRefs)
  assert.throws(() => parsePaperAgentResultDecisionInput({ ...input, summary: "browser-forgery" }), /unsupported/u)
  assert.throws(() => assertPaperAgentResultCandidateMatch({ ...input, eventId: "40" }, authoritative), /changed/u)
  assert.equal(
    paperAgentResultBackendPath(input, authoritative.taskId),
    `/documents/${revisionId}/anchors/sha256%3A${"a".repeat(64)}/agent-results/task-enhance-1`,
  )
})

test("BFF projects the private candidate and backend decision into the flat reader contract", () => {
  const authoritative = candidate()
  const pending = projectPaperAgentResultReview(authoritative, {
    schemaId: "gb.paper-agent-result-review.v1",
    reviewState: "unreviewed",
  })
  assert.equal(pending.schemaId, "gb.paper-agent-result.v1")
  assert.equal(pending.runId, "run-enhance-1")
  assert.equal(pending.performedByRef, "agent:researcher")
  assert.equal(pending.occurredAt, authoritative.occurredAt)
  assert.equal(pending.decision, null)

  const acceptedRef = `gb:object:v1:document:10000000-0000-4000-8000-000000000003:pinned:sha256%3A${"d".repeat(64)}`
  const accepted = projectPaperAgentResultReview(authoritative, {
    schemaId: "gb.paper-agent-result-review.v1",
    reviewState: "accepted",
    taskVersion: authoritative.taskVersion,
    eventId: authoritative.eventId,
    resultHash: authoritative.resultHash,
    resultRef: acceptedRef,
  })
  assert.deepEqual(accepted.decision, { action: "accept", acceptedDocumentRef: acceptedRef })
  assert.throws(() => projectPaperAgentResultReview(authoritative, {
    schemaId: "gb.paper-agent-result-review.v1",
    reviewState: "pending",
    taskVersion: authoritative.taskVersion + 1,
  }), /authoritative HAM result/u)
  assert.throws(() => projectPaperAgentResultReview(authoritative, {
    schemaId: "gb.paper-agent-result-review.v1",
    reviewState: "accepted",
    resultRef: "gb:object:v1:document:unsafe:latest",
  }), /exact document/u)
})

test("dedicated BFF fences HAM reads and generic ELN proxy cannot reach the backend route", async () => {
  const [route, genericProxy, hamProxy] = await Promise.all([
    readFile(new URL("../app/api/paper-agent-results/[taskId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/eln/[...path]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ham-task-proxy.ts", import.meta.url), "utf8"),
  ])
  assert.equal((route.match(/fetchHamTask\("detail"/gu) ?? []).length, 2)
  assert.match(route, /fetchHamTask\("events"/u)
  assert.match(route, /before\.version !== after\.version/u)
  assert.match(route, /assertPaperAgentResultCandidateMatch\(input, candidate\)/u)
  assert.match(route, /X-GB-Paper-Agent-Result-Gateway/u)
  assert.match(route, /X-GB-Human-Session/u)
  assert.match(hamProxy, /operation === "events"[\s\S]*HAM_TASK_EVENTS_RESPONSE_MAX_BYTES/u)
  assert.doesNotMatch(genericProxy, /agent-results/u)
})
