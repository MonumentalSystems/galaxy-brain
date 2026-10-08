import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  CONVERSATION_JOIN_MAX_RESPONSE_BYTES,
  ConversationJoinError,
  conversationJoinReceiptApplies,
  conversationJoinRecoveryStorageKey,
  deriveConversationJoinCandidates,
  joinConversationTurns,
  parseConversationJoinRecovery,
  prepareConversationJoinIntent,
  reconcileConversationJoin,
  serializeConversationJoinRecovery,
} from "../lib/conversation-join-client.js"
import { createGalaxyObjectReference, parseGalaxyObjectReference } from "../lib/galaxy-object-reference.js"

const tenantId = "10000000-0000-4000-8000-000000000001"
const conversationId = "30000000-0000-4000-8000-000000000001"
const parentOneId = "40000000-0000-4000-8000-000000000001"
const parentTwoId = "40000000-0000-4000-8000-000000000002"
const parentThreeId = "40000000-0000-4000-8000-000000000003"
const childTurnId = "40000000-0000-4000-8000-000000000004"
const revisionId = "50000000-0000-4000-8000-000000000001"
const revision = (character) => `sha256:${character.repeat(64)}`
const conversationRef = createGalaxyObjectReference("chat", conversationId, { mode: "pinned", revision: revision("a") })
const parentOneRef = createGalaxyObjectReference("turn", parentOneId, { mode: "pinned", revision: revision("b") })
const parentTwoRef = createGalaxyObjectReference("turn", parentTwoId, { mode: "pinned", revision: revision("c") })
const parentThreeRef = createGalaxyObjectReference("turn", parentThreeId, { mode: "pinned", revision: revision("d") })
const childTurnRef = createGalaxyObjectReference("turn", childTurnId, { mode: "pinned", revision: revision("e") })
const idempotencyKey = "join-request-0001"

test("the dialog persists the exact retry identity before crossing the dispatch boundary", async () => {
  const dialog = await readFile(new URL("../components/graph/conversation-join-dialog.tsx", import.meta.url), "utf8")
  const persistIndex = dialog.indexOf("onUncertain(intent, capturedTarget)")
  const dispatchIndex = dialog.indexOf("joinConversationTurns(intent, { signal: controller.signal })")
  assert.ok(persistIndex > 0 && dispatchIndex > persistIndex)
  assert.match(dialog, /controller\.signal\.aborted \|\| generationRef\.current !== generation\) return/)
  assert.match(dialog, /onClearUncertain\(\)[\s\S]*onJoined\(receipt/)
})

function intent(parentTurnReferences = [parentOneRef, parentTwoRef]) {
  return prepareConversationJoinIntent({
    conversationReference: conversationRef,
    parentTurnReferences,
    expectedVersion: 7,
    message: "Synthesize the two exact branches.",
  }, { idempotencyKey })
}

function receipt(overrides = {}) {
  return {
    schemaId: "gb.conversation.mutation-receipt.v1",
    conversationId,
    version: 8,
    contentHash: revision("f"),
    revisionId,
    turnId: childTurnId,
    operation: "join",
    replayed: false,
    ...overrides,
  }
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 201,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  })
}

function graphNode(id, kind, ref, sourceId) {
  const parsedRevision = parseGalaxyObjectReference(ref).selector.revision
  return {
    id,
    kind,
    ref,
    projection: {
      ref,
      revision: { policy: "pinned", id: parsedRevision },
      provenance: { sourceId },
    },
  }
}

function graphEdge(from, to, relation) {
  return {
    from: from.id,
    to: to.id,
    fromRef: from.ref,
    toRef: to.ref,
    relation,
  }
}

const chatNode = graphNode("chat-node", "chat", conversationRef, conversationId)
const parentOneNode = graphNode("parent-one", "turn", parentOneRef, parentOneId)
const parentTwoNode = graphNode("parent-two", "turn", parentTwoRef, parentTwoId)
const parentThreeNode = graphNode("parent-three", "turn", parentThreeRef, parentThreeId)
const childNode = graphNode("child", "turn", childTurnRef, childTurnId)

test("join intent freezes ordered distinct exact parents, body, and idempotency identity", () => {
  const prepared = intent([parentTwoRef, parentOneRef])
  assert.ok(Object.isFrozen(prepared))
  assert.ok(Object.isFrozen(prepared.parentTurnIds))
  assert.ok(Object.isFrozen(prepared.parentTurnReferences))
  assert.deepEqual(prepared.parentTurnIds, [parentTwoId, parentOneId])
  assert.deepEqual(JSON.parse(prepared.requestBody), {
    expected_version: 7,
    parent_turn_ids: [parentTwoId, parentOneId],
    message: { role: "user", content: "Synthesize the two exact branches." },
    artifact_refs: [],
    provenance: {
      provider: "galaxy.graph",
      sourceRef: conversationRef,
      statement: "User-authored synthesis of exact conversation turns.",
    },
    idempotency_key: idempotencyKey,
  })
  for (const parentTurnReferences of [
    [parentOneRef],
    [parentOneRef, parentOneRef],
    Array.from({ length: 9 }, (_, index) => createGalaxyObjectReference(
      "turn",
      `40000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
      { mode: "pinned", revision: revision("b") },
    )),
  ]) {
    assert.throws(() => intent(parentTurnReferences), /two to eight|distinct/u)
  }
  assert.throws(() => prepareConversationJoinIntent({
    conversationReference: conversationRef.replace("pinned", "latest"),
    parentTurnReferences: [parentOneRef, parentTwoRef],
    expectedVersion: 7,
    message: "Synthesize.",
  }, { idempotencyKey }), /exact pinned chat/u)
  assert.throws(() => intent([parentOneRef.replace("pinned", "latest"), parentTwoRef]), /exact pinned turn/u)
})

test("join submission posts the exact frozen body and accepts only a join receipt", async () => {
  const prepared = intent()
  const requests = []
  const fetcher = async (url, options) => {
    requests.push({ url, options })
    return jsonResponse(receipt({ replayed: requests.length > 1 }))
  }
  const first = await joinConversationTurns(prepared, { fetcher })
  const replay = await joinConversationTurns(prepared, { fetcher })
  assert.equal(requests[0].url, `/api/eln/conversations/${conversationId}/joins`)
  assert.equal(requests[0].options.body, prepared.requestBody)
  assert.equal(requests[1].options.body, prepared.requestBody)
  assert.equal(first.operation, "join")
  assert.equal(replay.replayed, true)
  assert.equal(first.conversationReference, createGalaxyObjectReference("chat", conversationId, {
    mode: "pinned",
    revision: revision("f"),
  }))

  const reordered = { ...prepared, parentTurnReferences: [parentTwoRef, parentOneRef] }
  await assert.rejects(() => joinConversationTurns(reordered, { fetcher }), (error) => (
    error instanceof ConversationJoinError && error.code === "invalid_request"
  ))
})

test("join receipt and response validation stay bounded, strict, and ambiguity-safe", async () => {
  for (const invalid of [
    receipt({ extra: true }),
    receipt({ version: 9 }),
    receipt({ contentHash: revision("a") }),
    receipt({ operation: "fork" }),
    receipt({ turnId: "not-a-uuid" }),
  ]) {
    await assert.rejects(
      () => joinConversationTurns(intent(), { fetcher: async () => jsonResponse(invalid) }),
      (error) => error instanceof ConversationJoinError
        && error.code === "invalid_response" && error.ambiguous === true,
    )
  }
  const oversized = new Response("x".repeat(CONVERSATION_JOIN_MAX_RESPONSE_BYTES + 1), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  })
  await assert.rejects(
    () => joinConversationTurns(intent(), { fetcher: async () => oversized }),
    (error) => error instanceof ConversationJoinError
      && error.code === "invalid_response" && error.ambiguous === true
      && !error.message.includes("too large"),
  )
  await assert.rejects(
    () => joinConversationTurns(intent(), { fetcher: async () => { throw new Error("private detail") } }),
    (error) => error instanceof ConversationJoinError
      && error.code === "transport_error" && error.ambiguous === true
      && !error.message.includes("private detail"),
  )
})

test("stale conflicts are explicit and server details are not exposed", async () => {
  await assert.rejects(
    () => joinConversationTurns(intent(), { fetcher: async () => jsonResponse(
      { detail: { code: "stale_conversation", message: "secret version" } }, { status: 409 },
    ) }),
    (error) => error instanceof ConversationJoinError
      && error.code === "stale_conversation" && error.ambiguous === false
      && !error.message.includes("secret version"),
  )
  await assert.rejects(
    () => joinConversationTurns(intent(), { fetcher: async () => jsonResponse(
      { detail: "private upstream" }, { status: 503 },
    ) }),
    (error) => error instanceof ConversationJoinError
      && error.code === "request_failed" && error.ambiguous === true
      && !error.message.includes("private upstream"),
  )
})

test("candidate derivation preserves projection order and returns only exact structural tips", () => {
  const projection = {
    nodes: [chatNode, parentTwoNode, parentOneNode, parentThreeNode],
    edges: [
      graphEdge(parentOneNode, parentThreeNode, "forks"),
    ],
    continuation: { hasMore: false, omitted: { nodes: 0, edges: 0, fanout: 0 } },
  }
  assert.deepEqual(
    deriveConversationJoinCandidates(
      projection,
      conversationRef,
      revision("a"),
      [parentOneRef, parentTwoRef, parentThreeRef],
    ),
    [parentTwoRef, parentThreeRef],
  )
  assert.ok(Object.isFrozen(deriveConversationJoinCandidates(
    projection,
    conversationRef,
    revision("a"),
    [parentOneRef, parentTwoRef, parentThreeRef],
  )))
})

test("candidate derivation fails closed on partial, forged, or malformed structure", () => {
  const base = {
    nodes: [chatNode, parentOneNode, parentTwoNode],
    edges: [
      graphEdge(chatNode, parentOneNode, "contains"),
      graphEdge(chatNode, parentTwoNode, "contains"),
    ],
  }
  const cases = [
    { ...base, continuation: { hasMore: true, omitted: { nodes: 1, edges: 0, fanout: 0 } } },
    { ...base, nodes: [chatNode, { ...parentOneNode, ref: "not-a-reference" }, parentTwoNode] },
    { ...base, nodes: [{ ...chatNode, projection: { ...chatNode.projection, revision: { policy: "pinned", id: revision("f") } } }, parentOneNode, parentTwoNode] },
    { ...base, edges: [...base.edges, { ...graphEdge(parentOneNode, parentTwoNode, "joins"), toRef: parentOneRef }] },
  ]
  for (const candidate of cases) {
    assert.deepEqual(deriveConversationJoinCandidates(
      candidate,
      conversationRef,
      revision("a"),
      [parentOneRef, parentTwoRef],
    ), [])
  }
  assert.deepEqual(deriveConversationJoinCandidates(base, conversationRef, revision("a"), [parentOneRef]), [])
  assert.deepEqual(deriveConversationJoinCandidates(base, conversationRef, revision("a"), [parentOneRef, parentThreeRef]), [])
  assert.deepEqual(deriveConversationJoinCandidates(base, conversationRef, revision("f"), [parentOneRef, parentTwoRef]), [])
  assert.deepEqual(deriveConversationJoinCandidates(base, parentOneRef, revision("b"), [parentOneRef, parentTwoRef]), [])
})

test("reconciliation returns the child only when every requested parent joins it", () => {
  const prepared = intent()
  const joinReceipt = {
    ...receipt(),
    conversationReference: createGalaxyObjectReference("chat", conversationId, {
      mode: "pinned",
      revision: revision("f"),
    }),
  }
  const projection = {
    provenance: { scope: { tenantId, workspaceId: "research" } },
    nodes: [parentOneNode, parentTwoNode, childNode],
    edges: [
      graphEdge(parentOneNode, childNode, "joins"),
      graphEdge(parentTwoNode, childNode, "joins"),
    ],
  }
  const snapshot = {
    conversationReference: joinReceipt.conversationReference,
    version: 8,
    contentHash: revision("f"),
    projection,
  }
  const result = { tenantId, intent: prepared, receipt: joinReceipt }
  assert.equal(reconcileConversationJoin(result, snapshot), childTurnRef)
  assert.equal(reconcileConversationJoin(result, {
    ...snapshot,
    projection: { ...projection, edges: [projection.edges[0]] },
  }), null)
  assert.equal(reconcileConversationJoin(result, {
    ...snapshot,
    projection: { ...projection, edges: [projection.edges[0], { ...projection.edges[1], relation: "forks" }] },
  }), null)
  assert.equal(reconcileConversationJoin(result, { ...snapshot, version: 9 }), null)
  assert.equal(reconcileConversationJoin({ ...result, tenantId: "other" }, snapshot), null)
})

test("recovery round-trips only the frozen ordered identity for the same tenant", () => {
  const prepared = intent()
  const recovery = {
    schemaId: "gb.conversation-join-recovery.v1",
    tenantId,
    target: {
      tenantId,
      conversationReference: conversationRef,
      parentTurnReferences: [parentOneRef, parentTwoRef],
      expectedVersion: 7,
      labels: ["First exact tip", "Second exact tip"],
    },
    intent: prepared,
  }
  const serialized = serializeConversationJoinRecovery(recovery)
  const restored = parseConversationJoinRecovery(serialized, tenantId)
  assert.equal(restored.intent.requestBody, prepared.requestBody)
  assert.deepEqual(restored.target.parentTurnReferences, [parentOneRef, parentTwoRef])
  assert.deepEqual(restored.target.labels, ["First exact tip", "Second exact tip"])
  assert.ok(Object.isFrozen(restored.target.parentTurnReferences))
  assert.ok(Object.isFrozen(restored.target.labels))
  assert.equal(parseConversationJoinRecovery(serialized, "another-tenant"), null)
  assert.equal(parseConversationJoinRecovery(serialized.replace(
    `\"parentTurnReferences\":[\"${parentOneRef}\",\"${parentTwoRef}\"]`,
    `\"parentTurnReferences\":[\"${parentTwoRef}\",\"${parentOneRef}\"]`,
  ), tenantId), null)

  const otherTenant = "10000000-0000-4000-8000-000000000002"
  assert.notEqual(conversationJoinRecoveryStorageKey(tenantId), conversationJoinRecoveryStorageKey(otherTenant))
})

test("accepted receipt applies only to its tenant and conversation identity", () => {
  const prepared = intent()
  const joinReceipt = {
    ...receipt(),
    conversationReference: createGalaxyObjectReference("chat", conversationId, {
      mode: "pinned",
      revision: revision("f"),
    }),
  }
  const result = { tenantId, intent: prepared, receipt: joinReceipt }
  assert.equal(conversationJoinReceiptApplies(result, tenantId, joinReceipt.conversationReference), true)
  assert.equal(conversationJoinReceiptApplies(result, "another-tenant", joinReceipt.conversationReference), false)
  assert.equal(conversationJoinReceiptApplies(result, tenantId, createGalaxyObjectReference(
    "chat",
    "30000000-0000-4000-8000-000000000099",
    { mode: "pinned", revision: revision("f") },
  )), false)
})
