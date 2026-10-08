import {
  createGalaxyObjectReference,
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "./galaxy-object-reference.js"
import { readBoundedResponseText } from "./bounded-response.js"

export const CONVERSATION_JOIN_MAX_RESPONSE_BYTES = 65_536
export const CONVERSATION_JOIN_MAX_MESSAGE_BYTES = 65_536
export const CONVERSATION_JOIN_MIN_PARENTS = 2
export const CONVERSATION_JOIN_MAX_PARENTS = 8
const CONVERSATION_JOIN_RECOVERY_STORAGE_PREFIX = "galaxy-brain:conversation-join-recovery:v1"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/u
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u
const PREPARE_KEYS = new Set([
  "conversationReference", "parentTurnReferences", "expectedVersion", "message",
])
const INTENT_KEYS = new Set([
  "schemaId", "conversationId", "conversationReference", "parentTurnIds",
  "parentTurnReferences", "expectedVersion", "message", "idempotencyKey", "requestBody",
])
const RECEIPT_KEYS = new Set([
  "schemaId", "conversationId", "version", "contentHash", "revisionId",
  "turnId", "operation", "replayed",
])
const RECOVERY_KEYS = new Set(["schemaId", "tenantId", "target", "intent"])
const RECOVERY_TARGET_KEYS = new Set([
  "tenantId", "conversationReference", "parentTurnReferences", "expectedVersion", "labels",
])

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConversationJoinError("invalid_request", `${label} is invalid.`)
  }
  return value
}

function exactKeys(value, expected, label) {
  if (Object.keys(value).some((key) => !expected.has(key)) || Object.keys(value).length !== expected.size) {
    throw new ConversationJoinError("invalid_request", `${label} is invalid.`)
  }
}

function exactPinnedReference(value, kind, label) {
  const parsed = typeof value === "string" ? parseGalaxyObjectReference(value) : null
  if (!parsed || parsed.format !== "canonical" || parsed.kind !== kind
    || parsed.selector.mode !== "pinned" || !CONTENT_HASH.test(parsed.selector.revision)) {
    throw new ConversationJoinError("invalid_request", `${label} must be an exact pinned ${kind} reference.`)
  }
  const wire = serializeGalaxyObjectReference(parsed)
  if (wire !== value || !UUID.test(parsed.id)) {
    throw new ConversationJoinError("invalid_request", `${label} is not canonical.`)
  }
  return { parsed, wire }
}

function exactParentReferences(value) {
  if (!Array.isArray(value)
    || value.length < CONVERSATION_JOIN_MIN_PARENTS
    || value.length > CONVERSATION_JOIN_MAX_PARENTS) {
    throw new ConversationJoinError("invalid_request", "A join requires two to eight exact parent turns.")
  }
  const parents = value.map((reference, index) => (
    exactPinnedReference(reference, "turn", `Parent turn reference ${index + 1}`)
  ))
  const identities = parents.map((parent) => parent.wire)
  const ids = parents.map((parent) => parent.parsed.id)
  if (new Set(identities).size !== identities.length || new Set(ids).size !== ids.length) {
    throw new ConversationJoinError("invalid_request", "Join parent turns must be distinct.")
  }
  return parents
}

function message(value) {
  if (typeof value !== "string" || !value || value !== value.trim() || CONTROL.test(value)
    || new TextEncoder().encode(value).byteLength > CONVERSATION_JOIN_MAX_MESSAGE_BYTES) {
    throw new ConversationJoinError(
      "invalid_request",
      "The join message must be non-empty bounded text without control characters.",
    )
  }
  return value
}

function idempotencyKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,200}$/u.test(value)) {
    throw new ConversationJoinError("invalid_request", "The join request identity is invalid.")
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

function sameStringArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index])
}

export class ConversationJoinError extends Error {
  constructor(code, message, { ambiguous = false, status = null } = {}) {
    super(message)
    this.name = "ConversationJoinError"
    this.code = code
    this.ambiguous = ambiguous
    this.status = status
  }
}

/**
 * Derive exact turn tips suitable for a join without trusting visual layout.
 * Any contradictory or explicitly partial structural data fails closed.
 */
export function deriveConversationJoinCandidates(
  projection,
  conversationReference,
  contentHash,
  authorizedTurnReferences,
) {
  try {
    const conversation = exactPinnedReference(conversationReference, "chat", "Conversation reference")
    if (contentHash !== conversation.parsed.selector.revision
      || !projection || typeof projection !== "object" || Array.isArray(projection)
      || !Array.isArray(projection.nodes) || !Array.isArray(projection.edges)
      || !Array.isArray(authorizedTurnReferences)
      || projection.continuation?.hasMore === true
      || (projection.continuation?.omitted && (
        projection.continuation.omitted.nodes > 0
        || projection.continuation.omitted.edges > 0
        || projection.continuation.omitted.fanout > 0
      ))) return []

    const chatNodes = projection.nodes.filter((node) => node?.kind === "chat" && node?.ref === conversation.wire)
    if (chatNodes.length !== 1) return []
    const chat = chatNodes[0]
    if (typeof chat.id !== "string" || !chat.id
      || chat.projection?.ref !== conversation.wire
      || chat.projection?.revision?.policy !== "pinned"
      || chat.projection?.revision?.id !== contentHash
      || chat.projection?.provenance?.sourceId?.toLowerCase() !== conversation.parsed.id.toLowerCase()) return []

    const authorizedTurns = authorizedTurnReferences.map((reference, index) => (
      exactPinnedReference(reference, "turn", `Authorized turn reference ${index + 1}`).wire
    ))
    if (new Set(authorizedTurns).size !== authorizedTurns.length) return []
    const authorizedTurnSet = new Set(authorizedTurns)
    const turnNodes = projection.nodes.filter((node) => node?.kind === "turn")
    if (turnNodes.length !== authorizedTurnSet.size) return []
    const turnById = new Map()
    const turnByRef = new Map()
    for (const node of turnNodes) {
      if (typeof node?.id !== "string" || !node.id || turnById.has(node.id)) return []
      const turn = exactPinnedReference(node.ref, "turn", "Turn reference")
      if (turnByRef.has(turn.wire) || !authorizedTurnSet.has(turn.wire)
        || node.projection?.ref !== turn.wire
        || node.projection?.revision?.policy !== "pinned"
        || node.projection?.revision?.id !== turn.parsed.selector.revision
        || node.projection?.provenance?.sourceId?.toLowerCase() !== turn.parsed.id.toLowerCase()) return []
      turnById.set(node.id, node)
      turnByRef.set(turn.wire, node)
    }

    const outgoing = new Set()
    const structuralRelations = new Set(["continues", "forks", "joins"])
    for (const edge of projection.edges) {
      if (!edge || typeof edge !== "object" || Array.isArray(edge)) return []
      if (edge.relation === "contains") {
        const child = turnById.get(edge.to)
        if (!child || edge.from !== chat.id || edge.fromRef !== chat.ref || edge.toRef !== child.ref) return []
        continue
      }
      if (!structuralRelations.has(edge.relation)) continue
      const parent = turnById.get(edge.from)
      const child = turnById.get(edge.to)
      if (!parent || !child || edge.fromRef !== parent.ref || edge.toRef !== child.ref) return []
      outgoing.add(parent.ref)
    }
    if (authorizedTurns.some((reference) => !turnByRef.has(reference))) return []
    return Object.freeze(turnNodes.filter((node) => !outgoing.has(node.ref)).map((node) => node.ref))
  } catch {
    return []
  }
}

/** Freeze one exact ordered join request so an ambiguous retry cannot change its body or identity. */
export function prepareConversationJoinIntent(value, options = {}) {
  const source = record(value, "Join intent")
  exactKeys(source, PREPARE_KEYS, "Join intent")
  const conversation = exactPinnedReference(source.conversationReference, "chat", "Conversation reference")
  const parents = exactParentReferences(source.parentTurnReferences)
  const expectedVersion = source.expectedVersion
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || expectedVersion > 1_000_001) {
    throw new ConversationJoinError("invalid_request", "The conversation version is invalid.")
  }
  const key = idempotencyKey(options.idempotencyKey ?? globalThis.crypto?.randomUUID?.())
  const normalizedMessage = message(source.message)
  const parentTurnIds = Object.freeze(parents.map((parent) => parent.parsed.id))
  const parentTurnReferences = Object.freeze(parents.map((parent) => parent.wire))
  const request = Object.freeze({
    expected_version: expectedVersion,
    parent_turn_ids: parentTurnIds,
    message: Object.freeze({ role: "user", content: normalizedMessage }),
    artifact_refs: Object.freeze([]),
    provenance: Object.freeze({
      provider: "galaxy.graph",
      sourceRef: conversation.wire,
      statement: "User-authored synthesis of exact conversation turns.",
    }),
    idempotency_key: key,
  })
  const requestBody = JSON.stringify(request)
  if (new TextEncoder().encode(requestBody).byteLength > 131_072) {
    throw new ConversationJoinError("invalid_request", "The join request exceeds its transport bound.")
  }
  return Object.freeze({
    schemaId: "gb.conversation-join.intent.v1",
    conversationId: conversation.parsed.id,
    conversationReference: conversation.wire,
    parentTurnIds,
    parentTurnReferences,
    expectedVersion,
    message: normalizedMessage,
    idempotencyKey: key,
    requestBody,
  })
}

function normalizeIntent(value) {
  const source = record(value, "Join intent")
  exactKeys(source, INTENT_KEYS, "Join intent")
  if (source.schemaId !== "gb.conversation-join.intent.v1") {
    throw new ConversationJoinError("invalid_request", "Join intent schema is unsupported.")
  }
  const conversation = exactPinnedReference(source.conversationReference, "chat", "Conversation reference")
  const parents = exactParentReferences(source.parentTurnReferences)
  const parentTurnIds = parents.map((parent) => parent.parsed.id)
  if (source.conversationId !== conversation.parsed.id
    || !sameStringArray(source.parentTurnIds, parentTurnIds)
    || !Number.isSafeInteger(source.expectedVersion) || source.expectedVersion < 1
    || source.expectedVersion > 1_000_001 || idempotencyKey(source.idempotencyKey) !== source.idempotencyKey) {
    throw new ConversationJoinError("invalid_request", "Join intent identity is inconsistent.")
  }
  const expected = prepareConversationJoinIntent({
    conversationReference: conversation.wire,
    parentTurnReferences: parents.map((parent) => parent.wire),
    expectedVersion: source.expectedVersion,
    message: source.message,
  }, { idempotencyKey: source.idempotencyKey })
  if (source.requestBody !== expected.requestBody) {
    throw new ConversationJoinError("invalid_request", "Join request body does not match its frozen intent.")
  }
  return source
}

function normalizeRecovery(value, expectedTenantId = null) {
  const source = record(value, "Join recovery")
  exactKeys(source, RECOVERY_KEYS, "Join recovery")
  if (source.schemaId !== "gb.conversation-join-recovery.v1"
    || typeof source.tenantId !== "string" || !source.tenantId || source.tenantId.length > 128
    || CONTROL.test(source.tenantId)
    || (expectedTenantId !== null && source.tenantId !== expectedTenantId)) {
    throw new ConversationJoinError("invalid_request", "Join recovery authority is invalid.")
  }
  const target = record(source.target, "Join recovery target")
  exactKeys(target, RECOVERY_TARGET_KEYS, "Join recovery target")
  const intent = normalizeIntent(source.intent)
  const labelsValid = Array.isArray(target.labels)
    && target.labels.length === intent.parentTurnReferences.length
    && target.labels.every((label) => (
      typeof label === "string" && label.trim() && label === label.trim()
      && label.length <= 1_024 && !CONTROL.test(label)
    ))
  if (target.tenantId !== source.tenantId
    || target.conversationReference !== intent.conversationReference
    || !sameStringArray(target.parentTurnReferences, intent.parentTurnReferences)
    || target.expectedVersion !== intent.expectedVersion
    || !labelsValid) {
    throw new ConversationJoinError("invalid_request", "Join recovery target is inconsistent.")
  }
  return Object.freeze({
    schemaId: "gb.conversation-join-recovery.v1",
    tenantId: source.tenantId,
    target: Object.freeze({
      ...target,
      parentTurnReferences: Object.freeze([...target.parentTurnReferences]),
      labels: Object.freeze([...target.labels]),
    }),
    intent: Object.freeze({
      ...intent,
      parentTurnIds: Object.freeze([...intent.parentTurnIds]),
      parentTurnReferences: Object.freeze([...intent.parentTurnReferences]),
    }),
  })
}

export function serializeConversationJoinRecovery(value) {
  return JSON.stringify(normalizeRecovery(value))
}

export function parseConversationJoinRecovery(value, tenantId) {
  if (typeof value !== "string" || !value || value.length > 250_000) return null
  try {
    return normalizeRecovery(JSON.parse(value), tenantId)
  } catch {
    return null
  }
}

export function conversationJoinRecoveryStorageKey(tenantId) {
  if (typeof tenantId !== "string" || !tenantId || tenantId.length > 128 || CONTROL.test(tenantId)) {
    throw new ConversationJoinError("invalid_request", "Join recovery authority is invalid.")
  }
  return `${CONVERSATION_JOIN_RECOVERY_STORAGE_PREFIX}:${encodeURIComponent(tenantId)}`
}

function parseReceipt(value, intent) {
  let source
  try {
    source = record(value, "Join receipt")
    exactKeys(source, RECEIPT_KEYS, "Join receipt")
  } catch {
    throw new ConversationJoinError("invalid_response", "The conversation service returned an invalid join receipt.", { ambiguous: true })
  }
  if (source.schemaId !== "gb.conversation.mutation-receipt.v1"
    || source.conversationId !== intent.conversationId
    || source.version !== intent.expectedVersion + 1
    || !CONTENT_HASH.test(source.contentHash)
    || source.contentHash === parseGalaxyObjectReference(intent.conversationReference)?.selector.revision
    || !UUID.test(source.revisionId)
    || !UUID.test(source.turnId)
    || source.operation !== "join"
    || typeof source.replayed !== "boolean") {
    throw new ConversationJoinError("invalid_response", "The conversation service returned an invalid join receipt.", { ambiguous: true })
  }
  const conversationReference = createGalaxyObjectReference("chat", source.conversationId, {
    mode: "pinned",
    revision: source.contentHash,
  })
  return Object.freeze({ ...source, conversationReference })
}

/** Prove every requested parent joins the returned child in the exact authorized returned snapshot. */
export function reconcileConversationJoin(result, snapshot) {
  let intent
  let receipt
  try {
    intent = normalizeIntent(result?.intent)
    const { conversationReference, ...wireReceipt } = record(result?.receipt, "Join receipt")
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
  const parents = intent.parentTurnReferences.map((parentReference, index) => nodes.find((node) => (
    node?.kind === "turn"
    && node.ref === parentReference
    && node.projection?.provenance?.sourceId === intent.parentTurnIds[index]
  )))
  const children = nodes.filter((node) => (
    node?.kind === "turn"
    && node.projection?.provenance?.sourceId === receipt.turnId
    && typeof node.ref === "string"
  ))
  try {
    if (parents.some((parent) => !parent) || children.length !== 1) return null
    const child = children[0]
    const childReference = exactPinnedReference(child.ref, "turn", "Reconciled turn reference")
    if (child.projection?.ref !== childReference.wire
      || child.projection?.revision?.policy !== "pinned"
      || child.projection?.revision?.id !== childReference.parsed.selector.revision
      || !parents.every((parent) => edges.some((edge) => (
        edge?.relation === "joins"
        && edge.from === parent.id
        && edge.to === child.id
        && edge.fromRef === parent.ref
        && edge.toRef === child.ref
      )))) return null
    return childReference.wire
  } catch {
    return null
  }
}

export function conversationJoinReceiptApplies(result, tenantId, conversationReference) {
  try {
    const intent = normalizeIntent(result?.intent)
    const { conversationReference: suppliedReference, ...wireReceipt } = record(result?.receipt, "Join receipt")
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
    throw new ConversationJoinError(
      "invalid_response",
      "The conversation service returned an invalid response.",
      { ambiguous: response.ok || response.status >= 500, status: response.status },
    )
  }
  try {
    return parseJson(await readBoundedResponseText(response, CONVERSATION_JOIN_MAX_RESPONSE_BYTES))
  } catch {
    throw new ConversationJoinError(
      "invalid_response",
      "The conversation service response could not be verified.",
      { ambiguous: response.ok || response.status >= 500, status: response.status },
    )
  }
}

/** Submit one previously frozen join request to the authoritative conversation route. */
export async function joinConversationTurns(intentValue, options = {}) {
  const intent = normalizeIntent(intentValue)
  const fetcher = options.fetcher ?? globalThis.fetch
  if (typeof fetcher !== "function") {
    throw new ConversationJoinError("transport_unavailable", "Conversation transport is unavailable.")
  }
  let response
  try {
    response = await fetcher(`/api/eln/conversations/${encodeURIComponent(intent.conversationId)}/joins`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: intent.requestBody,
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error
    throw new ConversationJoinError(
      "transport_error",
      "The join request may have reached the server. Retry the exact frozen request.",
      { ambiguous: true },
    )
  }
  const body = await readResponse(response)
  if (!response.ok) {
    const stale = response.status === 409 && body?.detail?.code === "stale_conversation"
    throw new ConversationJoinError(
      stale ? "stale_conversation" : "request_failed",
      stale
        ? "This conversation changed. Open its latest exact snapshot before joining again."
        : "The conversation join was not accepted.",
      { ambiguous: response.status >= 500, status: response.status },
    )
  }
  return parseReceipt(body, intent)
}
