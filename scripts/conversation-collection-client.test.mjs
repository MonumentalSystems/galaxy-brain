import assert from "node:assert/strict"
import test from "node:test"

import {
  acceptsConversationCollectionCompletion,
  appendConversationCollectionPage,
  CONVERSATION_COLLECTION_MAX_ITEMS,
  CONVERSATION_COLLECTION_MAX_PAGES,
  CONVERSATION_COLLECTION_MAX_RESPONSE_BYTES,
  conversationCollectionPath,
  conversationGraphHref,
  parseConversationCollection,
  readConversationCollectionResponse,
  startConversationCollection,
} from "../lib/conversation-collection-client.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"

const tenantId = "10000000-0000-4000-8000-000000000001"
const workspaceId = "research-main"
const hash = (value) => `sha256:${value.repeat(64)}`
const cursor = (value = "a") => `v2.${value.repeat(12)}.${value.repeat(43)}`
const conversationId = (value) => `30000000-0000-4000-8000-${String(value).padStart(12, "0")}`

function summary(value, overrides = {}) {
  const id = conversationId(value)
  const contentHash = hash(value % 2 ? "a" : "b")
  return {
    schemaId: "gb.conversation.summary.v1",
    conversationId: id,
    workspaceId,
    ref: createGalaxyObjectReference("chat", id, { mode: "pinned", revision: contentHash }),
    title: `Conversation ${value}`,
    goalSummary: `Bounded goal ${value}`,
    version: 3,
    contentHash,
    turnCount: 2,
    artifactCount: 1,
    createdAt: "2026-09-25T12:00:00+00:00",
    updatedAt: "2026-09-25T12:01:00Z",
    ...overrides,
  }
}

function page(values, { hasMore = false, pageCursor = null, snapshotAt = "2026-09-25T12:02:00.000000Z", limit = 50 } = {}) {
  return {
    schemaId: "gb.conversation.collection.v1",
    snapshotAt,
    scope: { tenantId, workspaceId },
    conversations: values.map((value) => typeof value === "number" ? summary(value) : value),
    continuation: { limit, hasMore, cursor: pageCursor },
  }
}

const expected = { tenantId, workspaceId, limit: 50 }

test("collection paths expose only bounded tenant-local filter and opaque cursor fields", () => {
  const path = new URL(conversationCollectionPath({ workspaceId, cursor: cursor(), limit: 50 }), "https://galaxy.invalid")
  assert.equal(path.pathname, "/api/eln/conversations")
  assert.deepEqual([...path.searchParams.keys()], ["limit", "workspace_id", "cursor"])
  assert.equal(path.searchParams.get("workspace_id"), workspaceId)
  assert.equal(path.searchParams.has("tenant_id"), false)
  assert.throws(() => conversationCollectionPath({ limit: 0 }), /limit/u)
  assert.throws(() => conversationCollectionPath({ workspaceId: "other workspace" }), /workspace/u)
  assert.throws(() => conversationCollectionPath({ cursor: "decoded-looking-value" }), /cursor/u)
})

test("one page validates exact summaries, immutable refs, server order, and continuation", () => {
  const values = Array.from({ length: 50 }, (_, index) => 250 - index)
  const normalized = parseConversationCollection(page(values, { hasMore: true, pageCursor: cursor() }), expected)
  assert.equal(normalized.conversations.length, 50)
  assert.equal(normalized.conversations[0].conversationId, conversationId(250))
  assert.equal(normalized.continuation.cursor, cursor())

  for (const mutate of [
    (value) => { value.extra = true },
    (value) => { value.scope.tenantId = "10000000-0000-4000-8000-000000000002" },
    (value) => { value.conversations[0].ref = createGalaxyObjectReference("chat", value.conversations[0].conversationId) },
    (value) => { value.conversations[0].turnCount = 1 },
    (value) => { value.conversations[0].goalSummary = " leading" },
    (value) => { value.conversations[0].title = "x".repeat(241) },
    (value) => { value.conversations[1] = structuredClone(value.conversations[0]) },
    (value) => { value.conversations.reverse() },
    (value) => { value.continuation.cursor = null },
    (value) => { value.conversations.pop() },
  ]) {
    const malformed = page(values, { hasMore: true, pageCursor: cursor() })
    mutate(malformed)
    assert.throws(() => parseConversationCollection(malformed, expected), /Conversation/u)
  }
})

test("bounded response reader rejects oversized, invalid UTF-8, and non-JSON responses", async () => {
  const valid = page([3, 2, 1])
  const response = new Response(JSON.stringify(valid), { headers: { "Content-Type": "application/json; charset=utf-8" } })
  assert.equal((await readConversationCollectionResponse(response, expected)).conversations.length, 3)

  await assert.rejects(
    readConversationCollectionResponse(new Response("{}", {
      headers: { "Content-Type": "application/json", "Content-Length": String(CONVERSATION_COLLECTION_MAX_RESPONSE_BYTES + 1) },
    }), expected),
    /Conversation/u,
  )
  await assert.rejects(
    readConversationCollectionResponse(new Response(new Uint8Array([0xff]), {
      headers: { "Content-Type": "application/json" },
    }), expected),
    /Conversation/u,
  )
  await assert.rejects(
    readConversationCollectionResponse(new Response("not json", { headers: { "Content-Type": "text/plain" } }), expected),
    /Conversation/u,
  )
})

test("snapshot pages append without sorting and stop at four pages or 200 summaries", () => {
  const makePage = (maximum, options) => page(
    Array.from({ length: 50 }, (_, index) => maximum - index),
    options,
  )
  let collection = startConversationCollection(parseConversationCollection(
    makePage(250, { hasMore: true, pageCursor: cursor("a") }), expected,
  ))
  collection = appendConversationCollectionPage(collection, parseConversationCollection(
    makePage(200, { hasMore: true, pageCursor: cursor("b") }), expected,
  ))
  collection = appendConversationCollectionPage(collection, parseConversationCollection(
    makePage(150, { hasMore: true, pageCursor: cursor("c") }), expected,
  ))
  collection = appendConversationCollectionPage(collection, parseConversationCollection(
    makePage(100, { hasMore: true, pageCursor: cursor("d") }), expected,
  ))
  assert.equal(collection.pageCount, CONVERSATION_COLLECTION_MAX_PAGES)
  assert.equal(collection.conversations.length, CONVERSATION_COLLECTION_MAX_ITEMS)
  assert.equal(collection.capped, true)
  assert.equal(collection.conversations[49].conversationId, conversationId(201))
  assert.equal(collection.conversations[50].conversationId, conversationId(200))
  assert.throws(() => appendConversationCollectionPage(collection, parseConversationCollection(
    makePage(50, { hasMore: false }), expected,
  )), /Conversation/u)

  const duplicate = parseConversationCollection(makePage(250, { hasMore: true, pageCursor: cursor("e") }), expected)
  const first = startConversationCollection(duplicate)
  assert.throws(() => appendConversationCollectionPage(first, duplicate), /Conversation/u)
  const drift = parseConversationCollection(
    makePage(200, { hasMore: false, snapshotAt: "2026-09-25T12:02:01.000000Z" }), expected,
  )
  assert.throws(() => appendConversationCollectionPage(first, drift), /Conversation/u)
})

test("exact list selections produce the immutable conversation graph URL", () => {
  const item = summary(1)
  const url = new URL(conversationGraphHref(item.ref), "https://galaxy.invalid")
  assert.equal(url.pathname, "/graph")
  assert.deepEqual([...url.searchParams.keys()], ["mode", "conversation", "ref", "scale"])
  assert.equal(url.searchParams.get("mode"), "conversation")
  assert.equal(url.searchParams.get("conversation"), item.ref)
  assert.equal(url.searchParams.get("ref"), item.ref)
  assert.equal(url.searchParams.get("scale"), "task")
  assert.throws(() => conversationGraphHref(createGalaxyObjectReference("chat", item.conversationId)), /selection/u)
})

test("request completions require exact generation, scope, cursor, and a live signal", () => {
  const controller = new AbortController()
  const fence = { generation: 3, tenantId, workspaceId, cursor: cursor() }
  assert.equal(acceptsConversationCollectionCompletion(fence, { ...fence }, controller.signal), true)
  for (const current of [
    { ...fence, generation: 4 },
    { ...fence, tenantId: "10000000-0000-4000-8000-000000000002" },
    { ...fence, workspaceId: "other" },
    { ...fence, cursor: cursor("b") },
  ]) assert.equal(acceptsConversationCollectionCompletion(fence, current, controller.signal), false)
  controller.abort()
  assert.equal(acceptsConversationCollectionCompletion(fence, fence, controller.signal), false)
})
