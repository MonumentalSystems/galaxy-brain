import {
  createGalaxyObjectReference,
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "./galaxy-object-reference.js"
import { readBoundedResponseText } from "./bounded-response.js"

export const CONVERSATION_FORK_MAX_RESPONSE_BYTES = 65_536
export const CONVERSATION_FORK_MAX_MESSAGE_BYTES = 65_536
const CONVERSATION_FORK_RECOVERY_STORAGE_PREFIX = "galaxy-brain:conversation-fork-recovery:v1"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/u
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u
const PREPARE_KEYS = new Set([
  "conversationReference", "parentTurnReference", "expectedVersion", "message",
])
const INTENT_KEYS = new Set([
  "schemaId", "conversationId", "conversationReference", "parentTurnId",
  "parentTurnReference", "expectedVersion", "message", "idempotencyKey", "requestBody",
])
const RECEIPT_KEYS = new Set([
  "schemaId", "conversationId", "version", "contentHash", "revisionId",
  "turnId", "operation", "replayed",
])
const RECOVERY_KEYS = new Set(["schemaId", "tenantId", "target", "intent"])
const RECOVERY_TARGET_KEYS = new Set([
  "tenantId", "conversationReference", "parentTurnReference", "expectedVersion", "title",
])

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConversationForkError("invalid_request", `${label} is invalid.`)
  }
  return value
}

function exactKeys(value, expected, label) {
  if (Object.keys(value).some((key) => !expected.has(key)) || Object.keys(value).length !== expected.size) {
    throw new ConversationForkError("invalid_request", `${label} is invalid.`)
  }
}

function exactPinnedReference(value, kind, label) {
  const parsed = typeof value === "string" ? parseGalaxyObjectReference(value) : null
  if (!parsed || parsed.format !== "canonical" || parsed.kind !== kind
    || parsed.selector.mode !== "pinned" || !CONTENT_HASH.test(parsed.selector.revision)) {
    throw new ConversationForkError("invalid_request", `${label} must be an exact pinned ${kind} reference.`)
  }
  const wire = serializeGalaxyObjectReference(parsed)
  if (wire !== value || !UUID.test(parsed.id)) {
    throw new ConversationForkError("invalid_request", `${label} is not canonical.`)
  }
  return { parsed, wire }
}

function message(value) {
  if (typeof value !== "string" || !value || value !== value.trim() || CONTROL.test(value)
    || new TextEncoder().encode(value).byteLength > CONVERSATION_FORK_MAX_MESSAGE_BYTES) {
    throw new ConversationForkError(
      "invalid_request",
      "The fork message must be non-empty bounded text without control characters.",
    )
  }
  return value
}

function idempotencyKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,200}$/u.test(value)) {
    throw new ConversationForkError("invalid_request", "The fork request identity is invalid.")
  }
  return value
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export class ConversationForkError extends Error {
  constructor(code, message, { ambiguous = false, status = null } = {}) {
    super(message)
    this.name = "ConversationForkError"
    this.code = code
    this.ambiguous = ambiguous
    this.status = status
  }
}

/** Freeze one exact fork request so an ambiguous retry cannot change its body or identity. */
export function prepareConversationForkIntent(value, options = {}) {
  const source = record(value, "Fork intent")
  exactKeys(source, PREPARE_KEYS, "Fork intent")
  const conversation = exactPinnedReference(source.conversationReference, "chat", "Conversation reference")
  const parent = exactPinnedReference(source.parentTurnReference, "turn", "Parent turn reference")
  const expectedVersion = source.expectedVersion
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || expectedVersion > 1_000_001) {
    throw new ConversationForkError("invalid_request", "The conversation version is invalid.")
  }
  const key = idempotencyKey(options.idempotencyKey ?? globalThis.crypto?.randomUUID?.())
  const normalizedMessage = message(source.message)
  const request = Object.freeze({
    expected_version: expectedVersion,
    parent_turn_id: parent.parsed.id,
    message: Object.freeze({ role: "user", content: normalizedMessage }),
    artifact_refs: Object.freeze([]),
    provenance: Object.freeze({
      provider: "galaxy.graph",
      sourceRef: parent.wire,
      statement: "User-authored fork from an exact conversation turn.",
    }),
    idempotency_key: key,
  })
  const requestBody = JSON.stringify(request)
  if (new TextEncoder().encode(requestBody).byteLength > 131_072) {
    throw new ConversationForkError("invalid_request", "The fork request exceeds its transport bound.")
  }
  return Object.freeze({
    schemaId: "gb.conversation-fork.intent.v1",
    conversationId: conversation.parsed.id,
    conversationReference: conversation.wire,
    parentTurnId: parent.parsed.id,
    parentTurnReference: parent.wire,
    expectedVersion,
    message: normalizedMessage,
    idempotencyKey: key,
    requestBody,
  })
}

function normalizeIntent(value) {
  const source = record(value, "Fork intent")
  exactKeys(source, INTENT_KEYS, "Fork intent")
  if (source.schemaId !== "gb.conversation-fork.intent.v1") {
    throw new ConversationForkError("invalid_request", "Fork intent schema is unsupported.")
  }
  const conversation = exactPinnedReference(source.conversationReference, "chat", "Conversation reference")
  const parent = exactPinnedReference(source.parentTurnReference, "turn", "Parent turn reference")
  if (source.conversationId !== conversation.parsed.id || source.parentTurnId !== parent.parsed.id
    || !Number.isSafeInteger(source.expectedVersion) || source.expectedVersion < 1
    || source.expectedVersion > 1_000_001 || idempotencyKey(source.idempotencyKey) !== source.idempotencyKey) {
    throw new ConversationForkError("invalid_request", "Fork intent identity is inconsistent.")
  }
  let body
  try {
    body = JSON.parse(source.requestBody)
  } catch {
    throw new ConversationForkError("invalid_request", "Fork request body is invalid.")
  }
  const expected = prepareConversationForkIntent({
    conversationReference: conversation.wire,
    parentTurnReference: parent.wire,
    expectedVersion: source.expectedVersion,
    message: source.message,
  }, { idempotencyKey: source.idempotencyKey })
  if (source.requestBody !== expected.requestBody) {
    throw new ConversationForkError("invalid_request", "Fork request body does not match its frozen intent.")
  }
  return source
}

function normalizeRecovery(value, expectedTenantId = null) {
  const source = record(value, "Fork recovery")
  exactKeys(source, RECOVERY_KEYS, "Fork recovery")
  if (source.schemaId !== "gb.conversation-fork-recovery.v1"
    || typeof source.tenantId !== "string" || !source.tenantId || source.tenantId.length > 128
    || (expectedTenantId !== null && source.tenantId !== expectedTenantId)) {
    throw new ConversationForkError("invalid_request", "Fork recovery authority is invalid.")
  }
  const target = record(source.target, "Fork recovery target")
  exactKeys(target, RECOVERY_TARGET_KEYS, "Fork recovery target")
  const intent = normalizeIntent(source.intent)
  if (target.tenantId !== source.tenantId
    || target.conversationReference !== intent.conversationReference
    || target.parentTurnReference !== intent.parentTurnReference
    || target.expectedVersion !== intent.expectedVersion
    || typeof target.title !== "string" || !target.title.trim() || target.title.length > 1_024
    || CONTROL.test(target.title)) {
    throw new ConversationForkError("invalid_request", "Fork recovery target is inconsistent.")
  }
  return Object.freeze({
    schemaId: "gb.conversation-fork-recovery.v1",
    tenantId: source.tenantId,
    target: Object.freeze({ ...target }),
    intent: Object.freeze({ ...intent }),
  })
}

/** Preserve one ambiguous request identity across Graph route unmounts in this browser tab. */
export function serializeConversationForkRecovery(value) {
  return JSON.stringify(normalizeRecovery(value))
}

/** Restore only a valid recovery belonging to the current tenant authority. */
export function parseConversationForkRecovery(value, tenantId) {
  if (typeof value !== "string" || !value || value.length > 200_000) return null
  try {
    return normalizeRecovery(JSON.parse(value), tenantId)
  } catch {
    return null
  }
}

/** Keep ambiguous identities isolated without deleting another tenant's recovery. */
export function conversationForkRecoveryStorageKey(tenantId) {
  if (typeof tenantId !== "string" || !tenantId || tenantId.length > 128 || CONTROL.test(tenantId)) {
    throw new ConversationForkError("invalid_request", "Fork recovery authority is invalid.")
  }
  return `${CONVERSATION_FORK_RECOVERY_STORAGE_PREFIX}:${encodeURIComponent(tenantId)}`
}

function parseReceipt(value, intent) {
  let source
  try {
    source = record(value, "Fork receipt")
    exactKeys(source, RECEIPT_KEYS, "Fork receipt")
  } catch {
    throw new ConversationForkError("invalid_response", "The conversation service returned an invalid fork receipt.", { ambiguous: true })
  }
  if (source.schemaId !== "gb.conversation.mutation-receipt.v1"
    || source.conversationId !== intent.conversationId
    || source.version !== intent.expectedVersion + 1
    || !CONTENT_HASH.test(source.contentHash)
    || source.contentHash === parseGalaxyObjectReference(intent.conversationReference)?.selector.revision
    || !UUID.test(source.revisionId)
    || !UUID.test(source.turnId)
    || source.operation !== "fork"
    || typeof source.replayed !== "boolean") {
    throw new ConversationForkError("invalid_response", "The conversation service returned an invalid fork receipt.", { ambiguous: true })
  }
  const conversationReference = createGalaxyObjectReference("chat", source.conversationId, {
    mode: "pinned",
    revision: source.contentHash,
  })
  return Object.freeze({ ...source, conversationReference })
}

/**
 * Reconcile a successful receipt only after the exact returned snapshot is
 * authorized and contains the declared parent -> new-turn fork edge. The new
 * turn reference always comes from that projection; this function never
 * constructs one from a bare identifier.
 */
export function reconcileConversationFork(result, snapshot) {
  let intent
  let receipt
  try {
    intent = normalizeIntent(result?.intent)
    const { conversationReference, ...wireReceipt } = record(result?.receipt, "Fork receipt")
    receipt = parseReceipt(wireReceipt, intent)
    if (conversationReference !== receipt.conversationReference) return null
  } catch {
    return null
  }
  if (receipt.conversationId !== intent.conversationId
    || receipt.version !== intent.expectedVersion + 1
    || typeof result?.tenantId !== "string"
    || snapshot?.conversationReference !== receipt.conversationReference
    || snapshot?.version !== receipt.version
    || snapshot?.contentHash !== receipt.contentHash
    || snapshot?.projection?.provenance?.scope?.tenantId !== result.tenantId) return null
  const nodes = Array.isArray(snapshot.projection.nodes) ? snapshot.projection.nodes : []
  const edges = Array.isArray(snapshot.projection.edges) ? snapshot.projection.edges : []
  const parent = nodes.find((node) => (
    node?.kind === "turn"
    && node.ref === intent.parentTurnReference
    && node.projection?.provenance?.sourceId === intent.parentTurnId
  ))
  const child = nodes.find((node) => (
    node?.kind === "turn"
    && node.projection?.provenance?.sourceId === receipt.turnId
    && typeof node.ref === "string"
  ))
  try {
    if (!parent || !child) return null
    const childReference = exactPinnedReference(child.ref, "turn", "Reconciled turn reference")
    if (child.projection?.ref !== childReference.wire
      || child.projection?.revision?.policy !== "pinned"
      || child.projection?.revision?.id !== childReference.parsed.selector.revision
      || !edges.some((edge) => (
        edge?.relation === "forks"
        && edge.from === parent.id
        && edge.to === child.id
        && edge.fromRef === parent.ref
        && edge.toRef === child.ref
      ))) return null
    return childReference.wire
  } catch {
    return null
  }
}

/** True only when an accepted receipt belongs to this tenant and conversation identity. */
export function conversationForkReceiptApplies(result, tenantId, conversationReference) {
  try {
    const intent = normalizeIntent(result?.intent)
    const { conversationReference: suppliedReference, ...wireReceipt } = record(result?.receipt, "Fork receipt")
    const receipt = parseReceipt(wireReceipt, intent)
    const loaded = exactPinnedReference(conversationReference, "chat", "Conversation reference")
    return result?.tenantId === tenantId
      && suppliedReference === receipt.conversationReference
      && loaded.parsed.id === receipt.conversationId
  } catch {
    return false
  }
}

async function readResponse(response) {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (contentType !== "application/json" || response.redirected) {
    throw new ConversationForkError(
      "invalid_response",
      "The conversation service returned an invalid response.",
      { ambiguous: response.ok || response.status >= 500, status: response.status },
    )
  }
  try {
    return parseJson(await readBoundedResponseText(response, CONVERSATION_FORK_MAX_RESPONSE_BYTES))
  } catch {
    throw new ConversationForkError(
      "invalid_response",
      "The conversation service response could not be verified.",
      { ambiguous: response.ok || response.status >= 500, status: response.status },
    )
  }
}

/** Submit one previously frozen fork request to the existing authoritative route. */
export async function forkConversationTurn(intentValue, options = {}) {
  const intent = normalizeIntent(intentValue)
  const fetcher = options.fetcher ?? globalThis.fetch
  if (typeof fetcher !== "function") {
    throw new ConversationForkError("transport_unavailable", "Conversation transport is unavailable.")
  }
  let response
  try {
    response = await fetcher(`/api/eln/conversations/${encodeURIComponent(intent.conversationId)}/forks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: intent.requestBody,
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error
    throw new ConversationForkError(
      "transport_error",
      "The fork request may have reached the server. Retry the exact frozen request.",
      { ambiguous: true },
    )
  }
  const body = await readResponse(response)
  if (!response.ok) {
    const stale = response.status === 409 && body?.detail?.code === "stale_conversation"
    throw new ConversationForkError(
      stale ? "stale_conversation" : "request_failed",
      stale
        ? "This conversation changed. Open its latest exact snapshot before forking again."
        : "The conversation fork was not accepted.",
      { ambiguous: response.status >= 500, status: response.status },
    )
  }
  return parseReceipt(body, intent)
}
