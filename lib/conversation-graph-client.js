import { parseGalaxyObjectReference, serializeGalaxyObjectReference } from "./galaxy-object-reference.js"
import { createGalaxyObjectProjection } from "./object-projection.js"

export const CONVERSATION_GRAPH_SCHEMA_ID = "gb.conversation.v1"
export const CONVERSATION_PAGE_LIMIT = 500
export const CONVERSATION_TURN_LIMIT = 1_000
export const CONVERSATION_TURN_CONTENT_MAX_BYTES = 65_536

const PAGE_KEYS = new Set([
  "schemaId", "conversationId", "workspaceId", "ref", "title", "goal", "version",
  "contentHash", "artifactRefs", "provenance", "turns", "contextTurns", "edges",
  "continuation", "graphProjectionInput",
])
const CONTINUATION_KEYS = new Set([
  "afterOrdinal", "limit", "hasMore", "nextAfterOrdinal", "version", "contentHash",
])
const TURN_KEYS = new Set([
  "turnId", "ordinal", "role", "content", "artifactRefs", "provenance", "ref", "contentHash", "createdAt",
])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256_REVISION = /^sha256:[0-9a-f]{64}$/u
const TURN_ROLES = new Set(["user", "assistant", "system", "tool"])
const INVALID_CONTENT_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u

function invalid(message) {
  throw new TypeError(`Invalid ${CONVERSATION_GRAPH_SCHEMA_ID}: ${message}`)
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`)
  return value
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${label}.${key} is not part of the contract`)
  }
}

function canonicalReference(value, kind, label) {
  const parsed = parseGalaxyObjectReference(value)
  if (!parsed || parsed.format !== "canonical" || parsed.kind !== kind || parsed.selector.mode !== "pinned") {
    invalid(`${label} must be an exact pinned ${kind} reference`)
  }
  if (!SHA256_REVISION.test(parsed.selector.revision)) invalid(`${label} must use a SHA-256 revision`)
  return { parsed, wire: serializeGalaxyObjectReference(parsed) }
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
}

/** Read one explicitly supplied canonical graph query parameter without fallback. */
export function canonicalGraphQueryParameter(parameters, name) {
  if (!parameters || typeof parameters.has !== "function" || typeof parameters.get !== "function"
    || typeof parameters.getAll !== "function" || !["ref", "conversation"].includes(name)) {
    invalid("query parameter reader is invalid")
  }
  if (!parameters.has(name)) return null
  const values = parameters.getAll(name)
  if (values.length !== 1) invalid(`${name} must be supplied exactly once`)
  const parsed = parseGalaxyObjectReference(values[0])
  if (!parsed || parsed.format !== "canonical") invalid(`${name} must be a canonical Galaxy object reference`)
  return serializeGalaxyObjectReference(parsed)
}

/** Resolve an exact chat plus optional exact selected turn from URL values. */
export function resolveConversationGraphSelection({ reference = null, conversationReference = null } = {}) {
  const selected = reference === null ? null : parseGalaxyObjectReference(reference)
  if (reference !== null && (!selected || selected.format !== "canonical" || !["chat", "turn"].includes(selected.kind))) {
    invalid("reference must name a canonical chat or turn")
  }
  if (selected && (selected.selector.mode !== "pinned" || !SHA256_REVISION.test(selected.selector.revision))) {
    invalid("reference must pin an exact SHA-256 revision")
  }
  const explicitConversation = conversationReference === null
    ? null
    : canonicalReference(conversationReference, "chat", "conversationReference")
  const selectedConversation = selected?.kind === "chat"
    ? canonicalReference(reference, "chat", "reference")
    : null
  if (explicitConversation && selectedConversation && explicitConversation.wire !== selectedConversation.wire) {
    invalid("reference and conversationReference disagree")
  }
  const conversation = explicitConversation || selectedConversation
  if (!conversation) {
    if (selected?.kind === "turn") invalid("an exact turn requires its exact conversationReference")
    return null
  }
  return Object.freeze({
    conversationId: conversation.parsed.id,
    conversationReference: conversation.wire,
    selectedReference: selected ? serializeGalaxyObjectReference(selected) : conversation.wire,
  })
}

/**
 * Enter the conversation-tree loader only through an explicit conversation
 * route. A bare pinned chat reference remains available to the ordinary
 * Graph/Field object-link neighborhood.
 */
export function resolveConversationGraphRoute({
  reference = null,
  conversationReference = null,
  mode = "mixed",
} = {}) {
  if (conversationReference === null && mode !== "conversation") return null
  return resolveConversationGraphSelection({ reference, conversationReference })
}

/** Build a snapshot-fenced GET path for one bounded conversation page. */
export function conversationGraphPagePath(selection, continuation = null) {
  const selected = resolveConversationGraphSelection({
    reference: selection?.selectedReference,
    conversationReference: selection?.conversationReference,
  })
  if (!selected) invalid("selection is required")
  const conversation = canonicalReference(selected.conversationReference, "chat", "selection.conversationReference")
  const parameters = new URLSearchParams({
    after_ordinal: String(continuation?.afterOrdinal ?? 0),
    limit: String(CONVERSATION_PAGE_LIMIT),
    expected_content_hash: conversation.parsed.selector.revision,
  })
  if (continuation) parameters.set("expected_version", String(continuation.version))
  return `/api/eln/conversations/${encodeURIComponent(selected.conversationId)}?${parameters}`
}

/** Build the one private Markdown export route for an exact pinned chat. */
export function conversationMarkdownExportPath(conversationReference) {
  const conversation = canonicalReference(
    conversationReference,
    "chat",
    "conversationReference",
  )
  return `/api/eln/conversations/${encodeURIComponent(conversation.parsed.id)}/exports/markdown?conversation_ref=${encodeURIComponent(conversation.wire)}`
}

function normalizePage(value, index, expected) {
  const page = record(value, `pages[${index}]`)
  exactKeys(page, PAGE_KEYS, `pages[${index}]`)
  if (page.schemaId !== CONVERSATION_GRAPH_SCHEMA_ID) invalid(`pages[${index}].schemaId is unsupported`)
  if (typeof page.conversationId !== "string" || !UUID.test(page.conversationId)) {
    invalid(`pages[${index}].conversationId must be a UUID`)
  }
  const reference = canonicalReference(page.ref, "chat", `pages[${index}].ref`)
  if (page.conversationId.toLowerCase() !== reference.parsed.id.toLowerCase()) {
    invalid(`pages[${index}] conversation identity disagrees with its reference`)
  }
  if (reference.wire !== expected.conversationReference) invalid(`pages[${index}] changed conversation revision`)
  if (page.contentHash !== reference.parsed.selector.revision) invalid(`pages[${index}].contentHash disagrees with its reference`)
  if (!Number.isSafeInteger(page.version) || page.version < 1) invalid(`pages[${index}].version is invalid`)
  if (typeof page.workspaceId !== "string" || !page.workspaceId || page.workspaceId.length > 128) {
    invalid(`pages[${index}].workspaceId is invalid`)
  }
  if (!Array.isArray(page.turns) || page.turns.length > CONVERSATION_PAGE_LIMIT
    || !Array.isArray(page.contextTurns) || page.contextTurns.length > CONVERSATION_PAGE_LIMIT
    || !Array.isArray(page.edges) || page.edges.length > CONVERSATION_PAGE_LIMIT * 8) {
    invalid(`pages[${index}] exceeds its bounded page contract`)
  }
  const continuation = record(page.continuation, `pages[${index}].continuation`)
  exactKeys(continuation, CONTINUATION_KEYS, `pages[${index}].continuation`)
  if (continuation.version !== page.version || continuation.contentHash !== page.contentHash
    || typeof continuation.hasMore !== "boolean") {
    invalid(`pages[${index}].continuation does not fence the page snapshot`)
  }
  if (!Number.isSafeInteger(continuation.afterOrdinal) || continuation.afterOrdinal < 0
    || !Number.isSafeInteger(continuation.limit) || continuation.limit < 1 || continuation.limit > CONVERSATION_PAGE_LIMIT
    || (continuation.hasMore
      ? !Number.isSafeInteger(continuation.nextAfterOrdinal) || continuation.nextAfterOrdinal <= continuation.afterOrdinal
      : continuation.nextAfterOrdinal !== null)) {
    invalid(`pages[${index}].continuation is malformed`)
  }
  const graphInput = record(page.graphProjectionInput, `pages[${index}].graphProjectionInput`)
  const scope = record(graphInput.scope, `pages[${index}].graphProjectionInput.scope`)
  const query = record(graphInput.query, `pages[${index}].graphProjectionInput.query`)
  if (graphInput.schemaId !== "gb.graph-projection-input.v1" || scope.workspaceId !== page.workspaceId
    || query.rootRef !== reference.wire || query.mode !== "conversation") {
    invalid(`pages[${index}].graphProjectionInput disagrees with the conversation snapshot`)
  }
  return { page, reference, continuation, graphInput }
}

function normalizeTurnDetail(value, label) {
  const turn = record(value, label)
  exactKeys(turn, TURN_KEYS, label)
  if (typeof turn.turnId !== "string" || !UUID.test(turn.turnId)) invalid(`${label}.turnId must be a UUID`)
  const reference = canonicalReference(turn.ref, "turn", `${label}.ref`)
  if (turn.turnId.toLowerCase() !== reference.parsed.id.toLowerCase()) {
    invalid(`${label} identity disagrees with its reference`)
  }
  if (turn.contentHash !== reference.parsed.selector.revision) {
    invalid(`${label}.contentHash disagrees with its reference`)
  }
  if (!Number.isSafeInteger(turn.ordinal) || turn.ordinal < 1 || !TURN_ROLES.has(turn.role)) {
    invalid(`${label} ordinal or role is invalid`)
  }
  if (typeof turn.content !== "string" || !turn.content || turn.content !== turn.content.trim()
    || INVALID_CONTENT_CHARACTERS.test(turn.content)
    || new TextEncoder().encode(turn.content).byteLength > CONVERSATION_TURN_CONTENT_MAX_BYTES) {
    invalid(`${label}.content exceeds the bounded conversation contract`)
  }
  if (!Array.isArray(turn.artifactRefs) || turn.artifactRefs.length > 32
    || !turn.provenance || typeof turn.provenance !== "object" || Array.isArray(turn.provenance)
    || (turn.createdAt !== null && turn.createdAt !== undefined && typeof turn.createdAt !== "string")) {
    invalid(`${label} metadata is malformed`)
  }
  return { reference: reference.wire, turnId: turn.turnId, contentHash: turn.contentHash, content: turn.content }
}

/**
 * Merge snapshot-fenced API pages into the existing strict unified graph input.
 * Context turns may repeat across pages; conflicting duplicates fail closed.
 */
export function assembleConversationGraphPages(pages, selection, query = {}) {
  if (!Array.isArray(pages) || pages.length === 0
    || pages.length > Math.ceil(CONVERSATION_TURN_LIMIT / CONVERSATION_PAGE_LIMIT)) {
    invalid("pages must be a bounded non-empty array")
  }
  const expected = resolveConversationGraphSelection(selection)
  if (!expected) invalid("selection is required")
  const normalized = pages.map((page, index) => normalizePage(page, index, expected))
  const first = normalized[0]
  if (first.continuation.afterOrdinal !== 0) invalid("the first page must begin at ordinal zero")
  const scopeKey = stableStringify(first.graphInput.scope)
  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index]
    if (current.page.version !== first.page.version || current.page.contentHash !== first.page.contentHash
      || stableStringify(current.graphInput.scope) !== scopeKey) {
      invalid(`pages[${index}] crosses the snapshot or authorization scope`)
    }
    if (index > 0) {
      const prior = normalized[index - 1].continuation
      if (!prior.hasMore || current.continuation.afterOrdinal !== prior.nextAfterOrdinal) {
        invalid(`pages[${index}] is not the declared continuation`)
      }
    }
  }
  const objects = new Map()
  const relations = new Map()
  for (const { graphInput } of normalized) {
    if (!Array.isArray(graphInput.objects) || !Array.isArray(graphInput.relations)) {
      invalid("graphProjectionInput objects and relations must be arrays")
    }
    for (const envelope of graphInput.objects) {
      const projection = createGalaxyObjectProjection(envelope?.projection)
      const key = projection.ref
      const serialized = stableStringify(envelope)
      if (objects.has(key) && objects.get(key).serialized !== serialized) invalid(`object ${key} conflicts across pages`)
      objects.set(key, { value: envelope, serialized, projection })
    }
    for (const envelope of graphInput.relations) {
      const relation = envelope?.relation
      const key = stableStringify([
        relation?.fromRef, relation?.toRef, relation?.relation,
        relation?.source?.provider, relation?.source?.recordId,
      ])
      const serialized = stableStringify(envelope)
      if (relations.has(key) && relations.get(key).serialized !== serialized) invalid(`relation ${key} conflicts across pages`)
      relations.set(key, { value: envelope, serialized })
    }
  }
  const turnContent = new Map()
  for (const [pageIndex, { page }] of normalized.entries()) {
    for (const [collectionName, values] of [["turns", page.turns], ["contextTurns", page.contextTurns]]) {
      for (const [turnIndex, value] of values.entries()) {
        const detail = normalizeTurnDetail(value, `pages[${pageIndex}].${collectionName}[${turnIndex}]`)
        const object = objects.get(detail.reference)
        if (!object || object.projection.kind !== "turn"
          || object.projection.provenance.sourceId !== detail.turnId
          || object.projection.revision.id !== detail.contentHash) {
          invalid(`turn detail ${detail.reference} disagrees with its exact projection identity`)
        }
        if (turnContent.has(detail.reference) && turnContent.get(detail.reference) !== detail.content) {
          invalid(`turn detail ${detail.reference} conflicts across pages`)
        }
        turnContent.set(detail.reference, detail.content)
      }
    }
  }
  for (const [reference, object] of objects) {
    if (object.projection.kind === "turn" && !turnContent.has(reference)) {
      invalid(`turn projection ${reference} has no exact bounded content`)
    }
  }
  if (!objects.has(expected.selectedReference)) invalid("selected exact reference is absent from the bounded conversation snapshot")
  const loadedTurnCount = [...objects.keys()].filter((reference) => parseGalaxyObjectReference(reference)?.kind === "turn").length
  if (loadedTurnCount > CONVERSATION_TURN_LIMIT) invalid("conversation snapshot exceeds the turn bound")
  const last = normalized[normalized.length - 1]
  const provider = first.graphInput.providers?.[0]
  return Object.freeze({
    graphInput: {
      schemaId: "gb.graph-projection-input.v1",
      scope: first.graphInput.scope,
      query: {
        ...query,
        // A rootRef would reduce the strict graph query to direct neighbors.
        // Conversation mode already scopes this input, so retain the complete
        // branch DAG and carry exact UI selection separately.
        rootRef: null,
        mode: "conversation",
        lens: "explore",
        viewport: null,
        filters: {},
        validAt: null,
        knownAt: null,
        cursor: null,
      },
      objects: [...objects.values()].map(({ value }) => value),
      external: [],
      links: [],
      // Conversation membership is fixed by this exact, tenant-scoped
      // snapshot. Omitting repeated chat -> turn spokes keeps the shared
      // graph fanout bound available for the meaningful branch DAG.
      relations: [...relations.values()]
        .map(({ value }) => value)
        .filter((envelope) => envelope.relation.relation !== "contains"),
      proofContexts: [],
      providers: [{
        ...provider,
        status: last.continuation.hasMore ? "partial" : "ready",
        snapshot: first.page.contentHash,
      }],
    },
    conversationReference: expected.conversationReference,
    selectedReference: expected.selectedReference,
    version: first.page.version,
    contentHash: first.page.contentHash,
    loadedTurnCount,
    turnContentByReference: Object.freeze(Object.fromEntries(turnContent)),
    hasMore: last.continuation.hasMore,
    nextContinuation: last.continuation.hasMore ? {
      afterOrdinal: last.continuation.nextAfterOrdinal,
      version: first.page.version,
    } : null,
  })
}
