import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "./galaxy-object-reference.js"

export const CONVERSATION_COLLECTION_LIMIT = 50
export const CONVERSATION_COLLECTION_MAX_ITEMS = 200
export const CONVERSATION_COLLECTION_MAX_PAGES = 4
export const CONVERSATION_COLLECTION_MAX_RESPONSE_BYTES = 1_048_576

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/u
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const CURSOR = /^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u
const SNAPSHOT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u
const CONTRACT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
const DISPLAY_CONTROL = /[\u0000-\u0020\u007f-\u009f]+/gu

function contractError(message = "Conversation collection response is invalid") {
  return new Error(message)
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function hasExactKeys(value, expected) {
  return isRecord(value)
    && Object.keys(value).sort().join("\u0000") === [...expected].sort().join("\u0000")
}

function validScalarText(value) {
  if (typeof value !== "string") return false
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }
  return true
}

function boundedContractText(value, maximumBytes) {
  return validScalarText(value)
    && value.length > 0
    && value === value.trim()
    && !CONTRACT_CONTROL.test(value)
    && new TextEncoder().encode(value).byteLength <= maximumBytes
}

function boundedDisplayText(value, maximumCodePoints) {
  if (!validScalarText(value) || value.length === 0 || Array.from(value).length > maximumCodePoints) return false
  return value === value.replace(DISPLAY_CONTROL, " ").trim()
}

function validTimestamp(value, { snapshot = false } = {}) {
  return typeof value === "string"
    && value.length <= 40
    && (snapshot ? SNAPSHOT_TIMESTAMP : TIMESTAMP).test(value)
    && Number.isFinite(Date.parse(value))
}

function boundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function normalizeWorkspaceId(value) {
  if (value === null) return null
  if (typeof value !== "string" || !WORKSPACE_ID.test(value)) throw contractError("Conversation workspace is invalid")
  return value
}

function normalizeLimit(value) {
  if (!boundedInteger(value, 1, 200)) throw contractError("Conversation collection limit is invalid")
  return value
}

function normalizeCursor(value) {
  if (typeof value !== "string" || value.length > 8_192 || !CURSOR.test(value)) {
    throw contractError("Conversation collection cursor is invalid")
  }
  return value
}

function parseSummary(value, scope) {
  if (!hasExactKeys(value, [
    "schemaId", "conversationId", "workspaceId", "ref", "title", "goalSummary",
    "version", "contentHash", "turnCount", "artifactCount", "createdAt", "updatedAt",
  ])) throw contractError()
  if (value.schemaId !== "gb.conversation.summary.v1") throw contractError()
  if (typeof value.conversationId !== "string" || !UUID.test(value.conversationId)) throw contractError()
  if (typeof value.workspaceId !== "string" || !WORKSPACE_ID.test(value.workspaceId)) throw contractError()
  if (scope.workspaceId !== null && value.workspaceId !== scope.workspaceId) throw contractError()
  if (!CONTENT_HASH.test(value.contentHash)) throw contractError()
  const parsedReference = parseGalaxyObjectReference(value.ref)
  if (
    !parsedReference
    || parsedReference.format !== "canonical"
    || parsedReference.kind !== "chat"
    || parsedReference.id !== value.conversationId
    || parsedReference.selector.mode !== "pinned"
    || parsedReference.selector.revision !== value.contentHash
    || serializeGalaxyObjectReference(parsedReference) !== value.ref
  ) throw contractError()
  if (!boundedContractText(value.title, 240)) throw contractError()
  if (!boundedDisplayText(value.goalSummary, 512)) throw contractError()
  if (!boundedInteger(value.version, 1, 1_000_001)) throw contractError()
  if (!boundedInteger(value.turnCount, 0, 1_000_000) || value.turnCount !== value.version - 1) throw contractError()
  if (!boundedInteger(value.artifactCount, 0, 32)) throw contractError()
  if (!validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt)) throw contractError()
  return Object.freeze({ ...value })
}

/**
 * Build the private aggregate collection URL. Tenant authority is supplied by
 * the authenticated gateway, never by a query parameter.
 */
export function conversationCollectionPath({
  workspaceId = null,
  cursor = null,
  limit = CONVERSATION_COLLECTION_LIMIT,
} = {}) {
  const normalizedLimit = normalizeLimit(limit)
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId)
  const parameters = new URLSearchParams({ limit: String(normalizedLimit) })
  if (normalizedWorkspaceId !== null) parameters.set("workspace_id", normalizedWorkspaceId)
  if (cursor !== null) parameters.set("cursor", normalizeCursor(cursor))
  return `/api/eln/conversations?${parameters}`
}

/** Parse one exact, bounded discovery page. */
export function parseConversationCollection(value, {
  tenantId,
  workspaceId = null,
  limit = CONVERSATION_COLLECTION_LIMIT,
}) {
  const normalizedLimit = normalizeLimit(limit)
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId)
  if (typeof tenantId !== "string" || !UUID.test(tenantId)) throw contractError("Conversation tenant is invalid")
  if (!hasExactKeys(value, ["schemaId", "snapshotAt", "scope", "conversations", "continuation"])) {
    throw contractError()
  }
  if (value.schemaId !== "gb.conversation.collection.v1" || !validTimestamp(value.snapshotAt, { snapshot: true })) {
    throw contractError()
  }
  if (!hasExactKeys(value.scope, ["tenantId", "workspaceId"])) throw contractError()
  if (value.scope.tenantId !== tenantId || value.scope.workspaceId !== normalizedWorkspaceId) throw contractError()
  if (!Array.isArray(value.conversations) || value.conversations.length > normalizedLimit) throw contractError()
  if (!hasExactKeys(value.continuation, ["limit", "hasMore", "cursor"])) throw contractError()
  if (value.continuation.limit !== normalizedLimit || typeof value.continuation.hasMore !== "boolean") {
    throw contractError()
  }
  if (value.continuation.hasMore) {
    if (value.conversations.length !== normalizedLimit) throw contractError()
    normalizeCursor(value.continuation.cursor)
  } else if (value.continuation.cursor !== null) {
    throw contractError()
  }
  const scope = Object.freeze({ tenantId, workspaceId: normalizedWorkspaceId })
  const conversations = Object.freeze(value.conversations.map((item) => parseSummary(item, scope)))
  const identities = new Set()
  const references = new Set()
  for (let index = 0; index < conversations.length; index += 1) {
    const item = conversations[index]
    if (identities.has(item.conversationId) || references.has(item.ref)) throw contractError()
    if (index > 0 && conversations[index - 1].conversationId <= item.conversationId) throw contractError()
    identities.add(item.conversationId)
    references.add(item.ref)
  }
  return Object.freeze({
    schemaId: "gb.conversation.collection.v1",
    snapshotAt: value.snapshotAt,
    scope,
    conversations,
    continuation: Object.freeze({
      limit: normalizedLimit,
      hasMore: value.continuation.hasMore,
      cursor: value.continuation.cursor,
    }),
  })
}

/** Read JSON without allowing a page to exceed the one MiB browser boundary. */
export async function readConversationCollectionResponse(response, expected) {
  if (!(response instanceof Response) || !response.ok) throw contractError("Conversation collection request failed")
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (contentType !== "application/json") throw contractError()
  const declaredLength = response.headers.get("content-length")
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > CONVERSATION_COLLECTION_MAX_RESPONSE_BYTES) {
      throw contractError()
    }
  }
  if (!response.body) throw contractError()
  const reader = response.body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let bytes = 0
  let text = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > CONVERSATION_COLLECTION_MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw contractError()
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Conversation")) throw error
    throw contractError()
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw contractError()
  }
  return parseConversationCollection(value, expected)
}

export function startConversationCollection(page) {
  if (!page || page.schemaId !== "gb.conversation.collection.v1") throw contractError()
  return Object.freeze({
    snapshotAt: page.snapshotAt,
    scope: page.scope,
    conversations: page.conversations,
    continuation: page.continuation,
    pageCount: 1,
    capped: page.continuation.hasMore && page.conversations.length >= CONVERSATION_COLLECTION_MAX_ITEMS,
  })
}

export function appendConversationCollectionPage(current, next) {
  if (!current || !next || next.schemaId !== "gb.conversation.collection.v1") throw contractError()
  if (!current.continuation.hasMore || !current.continuation.cursor) throw contractError()
  if (current.pageCount >= CONVERSATION_COLLECTION_MAX_PAGES) throw contractError()
  if (
    next.snapshotAt !== current.snapshotAt
    || next.scope.tenantId !== current.scope.tenantId
    || next.scope.workspaceId !== current.scope.workspaceId
    || next.continuation.limit !== current.continuation.limit
  ) throw contractError()
  const conversations = [...current.conversations, ...next.conversations]
  if (conversations.length > CONVERSATION_COLLECTION_MAX_ITEMS) throw contractError()
  const identities = new Set()
  const references = new Set()
  for (let index = 0; index < conversations.length; index += 1) {
    const item = conversations[index]
    if (identities.has(item.conversationId) || references.has(item.ref)) throw contractError()
    if (index > 0 && conversations[index - 1].conversationId <= item.conversationId) throw contractError()
    identities.add(item.conversationId)
    references.add(item.ref)
  }
  const pageCount = current.pageCount + 1
  return Object.freeze({
    snapshotAt: current.snapshotAt,
    scope: current.scope,
    conversations: Object.freeze(conversations),
    continuation: next.continuation,
    pageCount,
    capped: next.continuation.hasMore
      && (pageCount >= CONVERSATION_COLLECTION_MAX_PAGES || conversations.length >= CONVERSATION_COLLECTION_MAX_ITEMS),
  })
}

/** Exact immutable selection URL for a listed chat. */
export function conversationGraphHref(reference) {
  const parsed = parseGalaxyObjectReference(reference)
  if (
    !parsed
    || parsed.format !== "canonical"
    || parsed.kind !== "chat"
    || parsed.selector.mode !== "pinned"
    || !CONTENT_HASH.test(parsed.selector.revision)
    || serializeGalaxyObjectReference(parsed) !== reference
  ) throw contractError("Conversation selection reference is invalid")
  const query = new URLSearchParams({
    mode: "conversation",
    conversation: reference,
    ref: reference,
    scale: "task",
  })
  return `/graph?${query}`
}

export function acceptsConversationCollectionCompletion(captured, current, signal) {
  return Boolean(
    captured
    && current
    && signal
    && signal.aborted === false
    && captured.generation === current.generation
    && captured.tenantId === current.tenantId
    && captured.workspaceId === current.workspaceId
    && captured.cursor === current.cursor,
  )
}
