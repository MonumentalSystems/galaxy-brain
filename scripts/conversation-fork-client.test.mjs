import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  CONVERSATION_FORK_MAX_RESPONSE_BYTES,
  ConversationForkError,
  conversationForkReceiptApplies,
  conversationForkRecoveryStorageKey,
  forkConversationTurn,
  parseConversationForkRecovery,
  prepareConversationForkIntent,
  reconcileConversationFork,
  serializeConversationForkRecovery,
} from "../lib/conversation-fork-client.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"

const tenantId = "10000000-0000-4000-8000-000000000001"
const conversationId = "30000000-0000-4000-8000-000000000001"
const parentTurnId = "40000000-0000-4000-8000-000000000001"
const childTurnId = "40000000-0000-4000-8000-000000000002"
const revisionId = "50000000-0000-4000-8000-000000000001"
const revision = (character) => `sha256:${character.repeat(64)}`
const conversationRef = createGalaxyObjectReference("chat", conversationId, { mode: "pinned", revision: revision("a") })
const parentTurnRef = createGalaxyObjectReference("turn", parentTurnId, { mode: "pinned", revision: revision("b") })
const childTurnRef = createGalaxyObjectReference("turn", childTurnId, { mode: "pinned", revision: revision("c") })
const idempotencyKey = "fork-request-0001"

function intent() {
  return prepareConversationForkIntent({
    conversationReference: conversationRef,
    parentTurnReference: parentTurnRef,
    expectedVersion: 3,
    message: "Challenge the current assumption.",
  }, { idempotencyKey })
}

function receipt(overrides = {}) {
  return {
    schemaId: "gb.conversation.mutation-receipt.v1",
    conversationId,
    version: 4,
    contentHash: revision("d"),
    revisionId,
    turnId: childTurnId,
    operation: "fork",
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

test("fork intent freezes one exact branch request without adjacent mutations", () => {
  const prepared = intent()
  assert.ok(Object.isFrozen(prepared))
  assert.deepEqual(JSON.parse(prepared.requestBody), {
    expected_version: 3,
    parent_turn_id: parentTurnId,
    message: { role: "user", content: "Challenge the current assumption." },
    artifact_refs: [],
    provenance: {
      provider: "galaxy.graph",
      sourceRef: parentTurnRef,
      statement: "User-authored fork from an exact conversation turn.",
    },
    idempotency_key: idempotencyKey,
  })
  assert.throws(() => prepareConversationForkIntent({
    conversationReference: conversationRef,
    parentTurnReference: parentTurnRef,
    expectedVersion: 3,
    message: "Branch",
    artifactRefs: ["forbidden"],
  }, { idempotencyKey }), /invalid/u)
  assert.throws(() => prepareConversationForkIntent({
    conversationReference: conversationRef.replace("pinned", "latest"),
    parentTurnReference: parentTurnRef,
    expectedVersion: 3,
    message: "Branch",
  }, { idempotencyKey }), /exact pinned chat/u)
  assert.throws(() => prepareConversationForkIntent({
    conversationReference: conversationRef,
    parentTurnReference: parentTurnRef,
    expectedVersion: 3,
    message: `bad\u0000message`,
  }, { idempotencyKey }), /bounded text/u)
  assert.throws(() => prepareConversationForkIntent({
    conversationReference: conversationRef,
    parentTurnReference: parentTurnRef,
    expectedVersion: 3,
    message: "é".repeat(40_000),
  }, { idempotencyKey }), /bounded text/u)
})

test("fork submission posts one frozen body and validates the exact receipt", async () => {
  const prepared = intent()
  const requests = []
  const fetcher = async (url, options) => {
    requests.push({ url, options })
    return jsonResponse(receipt({ replayed: requests.length > 1 }))
  }
  const first = await forkConversationTurn(prepared, { fetcher })
  const replay = await forkConversationTurn(prepared, { fetcher })
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, `/api/eln/conversations/${conversationId}/forks`)
  assert.equal(requests[0].options.body, prepared.requestBody)
  assert.equal(requests[1].options.body, prepared.requestBody)
  assert.equal(first.version, 4)
  assert.equal(first.conversationReference, createGalaxyObjectReference("chat", conversationId, {
    mode: "pinned",
    revision: revision("d"),
  }))
  assert.equal(replay.replayed, true)

  const tampered = { ...prepared, requestBody: prepared.requestBody.replace("Challenge", "Replace") }
  await assert.rejects(() => forkConversationTurn(tampered, { fetcher }), (error) => (
    error instanceof ConversationForkError && error.code === "invalid_request"
  ))
})

test("fork receipt validation is strict and treats successful invalid bodies as ambiguous", async () => {
  for (const invalid of [
    receipt({ extra: true }),
    receipt({ version: 5 }),
    receipt({ contentHash: revision("a") }),
    receipt({ operation: "append" }),
    receipt({ turnId: "not-a-uuid" }),
  ]) {
    await assert.rejects(
      () => forkConversationTurn(intent(), { fetcher: async () => jsonResponse(invalid) }),
      (error) => error instanceof ConversationForkError
        && error.code === "invalid_response" && error.ambiguous === true,
    )
  }
  await assert.rejects(
    () => forkConversationTurn(intent(), { fetcher: async () => jsonResponse(null) }),
    (error) => error instanceof ConversationForkError
      && error.code === "invalid_response" && error.ambiguous === true,
  )
})

test("fork response reader bounds bytes and redacts stream failures", async () => {
  const oversized = new Response("x".repeat(CONVERSATION_FORK_MAX_RESPONSE_BYTES + 1), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  })
  await assert.rejects(
    () => forkConversationTurn(intent(), { fetcher: async () => oversized }),
    (error) => error instanceof ConversationForkError
      && error.code === "invalid_response" && error.ambiguous === true
      && !error.message.includes("too large"),
  )

  const partial = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"schemaId":"gb.conversation.mutation-receipt.v1"'))
      queueMicrotask(() => controller.error(new Error("private upstream detail")))
    },
  }), { status: 201, headers: { "Content-Type": "application/json" } })
  await assert.rejects(
    () => forkConversationTurn(intent(), { fetcher: async () => partial }),
    (error) => error instanceof ConversationForkError
      && error.code === "invalid_response" && error.ambiguous === true
      && !error.message.includes("private upstream detail"),
  )
})

test("stale conflicts are explicit while network and server ambiguity preserve retry identity", async () => {
  await assert.rejects(
    () => forkConversationTurn(intent(), { fetcher: async () => jsonResponse(
      { detail: { code: "stale_conversation" } }, { status: 409 },
    ) }),
    (error) => error instanceof ConversationForkError
      && error.code === "stale_conversation" && error.ambiguous === false,
  )
  await assert.rejects(
    () => forkConversationTurn(intent(), { fetcher: async () => jsonResponse(
      { detail: "internal value" }, { status: 503 },
    ) }),
    (error) => error instanceof ConversationForkError
      && error.code === "request_failed" && error.ambiguous === true
      && !error.message.includes("internal value"),
  )
  await assert.rejects(
    () => forkConversationTurn(intent(), { fetcher: async () => { throw new Error("private network detail") } }),
    (error) => error instanceof ConversationForkError
      && error.code === "transport_error" && error.ambiguous === true
      && !error.message.includes("private network detail"),
  )
})

test("reconciliation derives the exact new turn ref only from a matching authorized forks edge", () => {
  const prepared = intent()
  const forkReceipt = {
    ...receipt(),
    conversationReference: createGalaxyObjectReference("chat", conversationId, {
      mode: "pinned",
      revision: revision("d"),
    }),
  }
  const parentNode = {
    id: "parent-node",
    kind: "turn",
    ref: parentTurnRef,
    projection: { provenance: { sourceId: parentTurnId } },
  }
  const childNode = {
    id: "child-node",
    kind: "turn",
    ref: childTurnRef,
    projection: {
      ref: childTurnRef,
      revision: { policy: "pinned", id: revision("c") },
      provenance: { sourceId: childTurnId },
    },
  }
  const projection = {
    provenance: { scope: { tenantId, workspaceId: "research" } },
    nodes: [parentNode, childNode],
    edges: [{
      from: "parent-node",
      to: "child-node",
      fromRef: parentTurnRef,
      toRef: childTurnRef,
      relation: "forks",
    }],
  }
  const snapshot = {
    conversationReference: forkReceipt.conversationReference,
    version: 4,
    contentHash: revision("d"),
    projection,
  }
  const result = { tenantId, intent: prepared, receipt: forkReceipt }
  assert.equal(reconcileConversationFork(result, snapshot), childTurnRef)
  assert.equal(reconcileConversationFork(result, { ...snapshot, version: 5 }), null)
  assert.equal(reconcileConversationFork({ ...result, tenantId: "other" }, snapshot), null)
  assert.equal(reconcileConversationFork(result, {
    ...snapshot,
    projection: { ...projection, edges: [] },
  }), null)
  assert.equal(reconcileConversationFork(result, {
    ...snapshot,
    projection: { ...projection, nodes: [parentNode, { ...childNode, ref: "not-a-reference" }] },
  }), null)
})

test("ambiguous recovery round-trips only for the same tenant and frozen request identity", () => {
  const prepared = intent()
  const recovery = {
    schemaId: "gb.conversation-fork-recovery.v1",
    tenantId,
    target: {
      tenantId,
      conversationReference: conversationRef,
      parentTurnReference: parentTurnRef,
      expectedVersion: 3,
      title: "Exact parent turn",
    },
    intent: prepared,
  }
  const serialized = serializeConversationForkRecovery(recovery)
  const restored = parseConversationForkRecovery(serialized, tenantId)
  assert.equal(restored.intent.idempotencyKey, idempotencyKey)
  assert.equal(restored.intent.requestBody, prepared.requestBody)
  assert.equal(parseConversationForkRecovery(serialized, "another-tenant"), null)
  assert.equal(parseConversationForkRecovery(serialized.replace(parentTurnId, childTurnId), tenantId), null)
  assert.equal(parseConversationForkRecovery("{".repeat(200_001), tenantId), null)
})

test("tenant-scoped recovery survives an A to B to A authority switch", () => {
  const otherTenant = "10000000-0000-4000-8000-000000000002"
  const prepared = intent()
  const recovery = {
    schemaId: "gb.conversation-fork-recovery.v1",
    tenantId,
    target: {
      tenantId,
      conversationReference: conversationRef,
      parentTurnReference: parentTurnRef,
      expectedVersion: 3,
      title: "Exact parent turn",
    },
    intent: prepared,
  }
  const session = new Map()
  const tenantAKey = conversationForkRecoveryStorageKey(tenantId)
  const tenantBKey = conversationForkRecoveryStorageKey(otherTenant)
  session.set(tenantAKey, serializeConversationForkRecovery(recovery))
  assert.notEqual(tenantAKey, tenantBKey)
  assert.equal(session.get(tenantBKey), undefined)
  assert.equal(parseConversationForkRecovery(session.get(tenantAKey), tenantId)?.intent.idempotencyKey, idempotencyKey)
})

test("accepted receipt scope locks only its tenant and conversation identity", () => {
  const prepared = intent()
  const forkReceipt = {
    ...receipt(),
    conversationReference: createGalaxyObjectReference("chat", conversationId, {
      mode: "pinned",
      revision: revision("d"),
    }),
  }
  const result = { tenantId, intent: prepared, receipt: forkReceipt }
  assert.equal(conversationForkReceiptApplies(result, tenantId, forkReceipt.conversationReference), true)
  assert.equal(conversationForkReceiptApplies(result, "another-tenant", forkReceipt.conversationReference), false)
  assert.equal(conversationForkReceiptApplies(result, tenantId, createGalaxyObjectReference(
    "chat",
    "30000000-0000-4000-8000-000000000099",
    { mode: "pinned", revision: revision("e") },
  )), false)
})

test("Graph exposes the exact-turn fork dialog with bounded and generation-safe gates", async () => {
  const graphClient = await readFile(new URL("../app/graph/graph-client.tsx", import.meta.url), "utf8")
  const graph = await readFile(new URL("../components/graph/unified-graph.tsx", import.meta.url), "utf8")
  const dialog = await readFile(new URL("../components/graph/conversation-fork-dialog.tsx", import.meta.url), "utf8")
  assert.match(graphClient, /loaded\.conversationHasMore[\s\S]*conversationLoadedTurnCount >= CONVERSATION_TURN_LIMIT[\s\S]*uncertainFork \|\| uncertainJoin[\s\S]*pendingForkForLoaded \|\| pendingJoinForLoaded/u)
  assert.match(graphClient, /Object\.hasOwn\(loaded\.turnContentByReference, parentTurnReference\)/u)
  assert.match(graphClient, /conversation\.selector\.revision !== loaded\.conversationContentHash/u)
  assert.match(graphClient, /reconcileConversationFork\(pendingFork/u)
  assert.match(graphClient, /receipt\.conversationReference/u)
  assert.match(graphClient, /sessionStorage\.setItem[\s\S]*serializeConversationForkRecovery/u)
  assert.match(graphClient, /Reload exact receipt snapshot/u)
  assert.match(graphClient, /I understand — stop tracking/u)
  assert.match(graphClient, /setFocusSelectedReference\(reconciledTurnReference\)/u)
  assert.match(graphClient, /loadedRouteSearch !== routeSearch \|\| routedReference !== reference/u)
  assert.doesNotMatch(graphClient, /createGalaxyObjectReference\("turn"/u)
  assert.match(graph, /data-conversation-graph-focus-fallback/u)
  assert.match(graph, /disabled=\{!exactTurnContent \|\| Boolean\(conversationFork\.disabledReason\)\}/u)
  assert.match(graph, /Fork from this turn/u)
  assert.match(dialog, /pendingIntent/u)
  assert.match(dialog, /generationRef\.current !== generation/u)
  assert.match(dialog, /controllerRef\.current\?\.abort\(\)/u)
  assert.match(dialog, /onCloseAutoFocus/u)
  assert.match(dialog, /closeLocked = submitting \|\| retrying/u)
  assert.match(dialog, /I understand — abandon request/u)
  assert.match(dialog, /Retry sends the same frozen body and idempotency key/u)
})
