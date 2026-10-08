import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  assembleConversationGraphPages,
  canonicalGraphQueryParameter,
  CONVERSATION_TURN_CONTENT_MAX_BYTES,
  conversationGraphPagePath,
  conversationMarkdownExportPath,
  resolveConversationGraphRoute,
  resolveConversationGraphSelection,
} from "../lib/conversation-graph-client.js"
import { conversationGraphHref } from "../lib/conversation-collection-client.js"
import { deriveConversationJoinCandidates } from "../lib/conversation-join-client.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import { createGalaxyObjectProjection } from "../lib/object-projection.js"
import { projectUnifiedGraph } from "../lib/unified-graph.js"

const tenantId = "10000000-0000-4000-8000-000000000001"
const conversationId = "30000000-0000-4000-8000-000000000001"
const turnOneId = "40000000-0000-4000-8000-000000000001"
const turnTwoId = "40000000-0000-4000-8000-000000000002"
const digest = (value) => value.repeat(64)
const revision = (value) => `sha256:${digest(value)}`
const scope = { tenantId, workspaceId: "research-main" }
const conversationRef = createGalaxyObjectReference("chat", conversationId, { mode: "pinned", revision: revision("a") })
const turnOneRef = createGalaxyObjectReference("turn", turnOneId, { mode: "pinned", revision: revision("b") })
const turnTwoRef = createGalaxyObjectReference("turn", turnTwoId, { mode: "pinned", revision: revision("c") })

test("exact conversation Markdown export paths carry one encoded pinned chat reference", () => {
  const path = conversationMarkdownExportPath(conversationRef)
  const parsed = new URL(path, "http://galaxy.local")
  assert.equal(parsed.pathname, `/api/eln/conversations/${conversationId}/exports/markdown`)
  assert.deepEqual([...parsed.searchParams.keys()], ["conversation_ref"])
  assert.deepEqual(parsed.searchParams.getAll("conversation_ref"), [conversationRef])
  assert.throws(
    () => conversationMarkdownExportPath(`gb:object:v1:chat:${conversationId}:latest`),
    /exact pinned chat/u,
  )
  assert.throws(() => conversationMarkdownExportPath(turnOneRef), /exact pinned chat/u)
})

function projection(kind, id, ref, hash, title, summary) {
  return {
    scope,
    projection: createGalaxyObjectProjection({
      schemaId: "gb.object-projection.v1",
      ref,
      kind,
      revision: { policy: "pinned", id: hash, contentHash: hash.slice("sha256:".length) },
      title,
      summary,
      mediaType: kind === "chat"
        ? "application/vnd.galaxy.conversation+json"
        : "application/vnd.galaxy.conversation-turn+json",
      representations: [],
      provenance: { provider: "galaxy.conversation", sourceId: id, sourceRevision: hash },
      capabilities: ["open", "inspect"],
    }),
  }
}

function relation(fromRef, toRef, kind, recordId) {
  return {
    scope,
    relation: {
      fromRef,
      toRef,
      relation: kind,
      trust: "structure",
      source: { provider: "galaxy.conversation", recordId },
    },
  }
}

function turnDetail(turnId, ordinal, role, content, ref, contentHash) {
  return {
    turnId,
    ordinal,
    role,
    content,
    artifactRefs: [],
    provenance: { provider: "galaxy.conversation" },
    ref,
    contentHash,
    createdAt: "2026-09-25T12:00:00Z",
  }
}

function page({ afterOrdinal, hasMore, nextAfterOrdinal, objects, relations, turns, contextTurns = [] }) {
  return {
    schemaId: "gb.conversation.v1",
    conversationId,
    workspaceId: scope.workspaceId,
    ref: conversationRef,
    title: "Branching research chat",
    goal: "Compare two proof strategies",
    version: 3,
    contentHash: revision("a"),
    artifactRefs: [],
    provenance: {},
    turns,
    contextTurns,
    edges: [],
    continuation: {
      afterOrdinal,
      limit: 500,
      hasMore,
      nextAfterOrdinal,
      version: 3,
      contentHash: revision("a"),
    },
    graphProjectionInput: {
      schemaId: "gb.graph-projection-input.v1",
      scope,
      query: {
        rootRef: conversationRef,
        mode: "conversation",
        lens: "explore",
        scale: "task",
        viewport: null,
        filters: {},
        validAt: null,
        knownAt: null,
        cursor: null,
      },
      objects,
      external: [],
      links: [],
      relations,
      proofContexts: [],
      providers: [{ scope, provider: "galaxy.conversation", status: "ready", snapshot: revision("a") }],
    },
  }
}

const chat = projection("chat", conversationId, conversationRef, revision("a"), "Branching research chat", "Compare two proof strategies")
const turnOne = projection("turn", turnOneId, turnOneRef, revision("b"), "User turn 1", "Start with $a^2+b^2$.")
const turnTwo = projection("turn", turnTwoId, turnTwoRef, revision("c"), "Assistant turn 2", "Take the left branch.")
const containsOne = relation(conversationRef, turnOneRef, "contains", `turn:${turnOneId}`)
const turnOneDetail = turnDetail(turnOneId, 1, "user", "Start with $a^2+b^2$.", turnOneRef, revision("b"))
const longExactContent = [
  "## Exact branch analysis",
  "",
  "```lean",
  ...Array.from({ length: 260 }, (_, index) => `have h${index} : True := by trivial -- preserve line ${index}`),
  "```",
  "",
  "$$",
  "\\int_{\\Omega} \\nabla u \\cdot \\nabla v\\,dx = 0",
  "$$",
].join("\n")
const turnTwoDetail = turnDetail(turnTwoId, 2, "assistant", longExactContent, turnTwoRef, revision("c"))

test("explicit ref and conversation query parameters fail closed before fallback parsing", () => {
  assert.equal(canonicalGraphQueryParameter(new URLSearchParams(), "ref"), null)
  assert.equal(canonicalGraphQueryParameter(new URLSearchParams({ ref: turnOneRef }), "ref"), turnOneRef)
  for (const search of ["?ref=", "?ref=not-a-reference", "?ref=gb%3Anode%3Alegacy", "?conversation="]) {
    const parameters = new URLSearchParams(search)
    const name = parameters.has("conversation") ? "conversation" : "ref"
    assert.throws(() => canonicalGraphQueryParameter(parameters, name), /canonical Galaxy object reference/u)
  }
  assert.throws(
    () => canonicalGraphQueryParameter(new URLSearchParams(`ref=${encodeURIComponent(turnOneRef)}&ref=${encodeURIComponent(turnTwoRef)}`), "ref"),
    /exactly once/u,
  )
})

test("exact chat and turn selections retain their canonical pinned identities", () => {
  assert.deepEqual(resolveConversationGraphSelection({ reference: conversationRef }), {
    conversationId,
    conversationReference: conversationRef,
    selectedReference: conversationRef,
  })
  assert.deepEqual(resolveConversationGraphSelection({ conversationReference: conversationRef }), {
    conversationId,
    conversationReference: conversationRef,
    selectedReference: conversationRef,
  })
  const turn = resolveConversationGraphSelection({ reference: turnTwoRef, conversationReference: conversationRef })
  assert.equal(turn.selectedReference, turnTwoRef)
  assert.throws(() => resolveConversationGraphSelection({ reference: turnTwoRef }), /requires its exact conversationReference/u)
  const otherRevision = createGalaxyObjectReference("chat", conversationId, { mode: "pinned", revision: revision("d") })
  assert.throws(() => resolveConversationGraphSelection({
    reference: conversationRef,
    conversationReference: otherRevision,
  }), /disagree/u)
})

test("only explicit conversation routes enter the conversation-tree loader", () => {
  assert.equal(resolveConversationGraphRoute({ reference: conversationRef, mode: "mixed" }), null)
  assert.equal(resolveConversationGraphRoute({ reference: turnTwoRef, mode: "mixed" }), null)

  const modeSelection = resolveConversationGraphRoute({ reference: conversationRef, mode: "conversation" })
  assert.equal(modeSelection.conversationReference, conversationRef)
  assert.equal(modeSelection.selectedReference, conversationRef)

  const explicitSelection = resolveConversationGraphRoute({
    reference: turnTwoRef,
    conversationReference: conversationRef,
    mode: "mixed",
  })
  assert.equal(explicitSelection.conversationReference, conversationRef)
  assert.equal(explicitSelection.selectedReference, turnTwoRef)
})

test("a collection selection URL reloads the exact immutable conversation", () => {
  const url = new URL(conversationGraphHref(conversationRef), "https://galaxy.invalid")
  const selected = resolveConversationGraphSelection({
    reference: canonicalGraphQueryParameter(url.searchParams, "ref"),
    conversationReference: canonicalGraphQueryParameter(url.searchParams, "conversation"),
  })
  assert.equal(selected.conversationId, conversationId)
  assert.equal(selected.conversationReference, conversationRef)
  assert.equal(selected.selectedReference, conversationRef)
  assert.equal(url.searchParams.get("scale"), "task")
})

test("conversation page paths pin every page to the immutable chat revision", () => {
  const selection = resolveConversationGraphSelection({ reference: turnTwoRef, conversationReference: conversationRef })
  const first = new URL(conversationGraphPagePath(selection), "https://galaxy.invalid")
  assert.equal(first.pathname, `/api/eln/conversations/${conversationId}`)
  assert.equal(first.searchParams.get("expected_content_hash"), revision("a"))
  assert.equal(first.searchParams.get("limit"), "500")
  assert.equal(first.searchParams.has("expected_version"), false)
  const next = new URL(conversationGraphPagePath(selection, { afterOrdinal: 500, version: 3 }), "https://galaxy.invalid")
  assert.equal(next.searchParams.get("after_ordinal"), "500")
  assert.equal(next.searchParams.get("expected_version"), "3")
})

test("snapshot-fenced pages merge context turns once and preserve typed branch structure", () => {
  const first = page({
    afterOrdinal: 0,
    hasMore: true,
    nextAfterOrdinal: 1,
    objects: [chat, turnOne],
    relations: [containsOne],
    turns: [turnOneDetail],
  })
  const second = page({
    afterOrdinal: 1,
    hasMore: false,
    nextAfterOrdinal: null,
    objects: [chat, turnOne, turnTwo],
    relations: [containsOne, relation(conversationRef, turnTwoRef, "contains", `turn:${turnTwoId}`), relation(turnOneRef, turnTwoRef, "forks", "edge-fork")],
    turns: [turnTwoDetail],
    contextTurns: [turnOneDetail],
  })
  const assembled = assembleConversationGraphPages([first, second], {
    reference: turnTwoRef,
    conversationReference: conversationRef,
  }, { scale: "project" })
  assert.equal(assembled.loadedTurnCount, 2)
  assert.equal(assembled.hasMore, false)
  assert.equal(assembled.graphInput.objects.length, 3)
  assert.equal(assembled.graphInput.relations.length, 1)
  assert.equal(assembled.graphInput.query.rootRef, null)
  assert.equal(assembled.graphInput.query.mode, "conversation")
  assert.ok(longExactContent.length > 4_000)
  assert.ok(new TextEncoder().encode(longExactContent).byteLength < CONVERSATION_TURN_CONTENT_MAX_BYTES)
  assert.match(longExactContent, /```lean[\s\S]+```/u)
  assert.match(longExactContent, /\$\$\n\\int_\{\\Omega\}[\s\S]+\n\$\$/u)
  assert.equal(assembled.turnContentByReference[turnTwoRef], longExactContent)
  assert.equal(assembled.turnContentByReference[turnTwoRef].split("\n").length, longExactContent.split("\n").length)
  assert.equal(JSON.stringify(assembled.graphInput).includes(longExactContent), false)
  const graph = projectUnifiedGraph(assembled.graphInput)
  assert.equal(graph.nodes.length, 3)
  assert.deepEqual(new Set(graph.edges.map((edge) => edge.relation)), new Set(["forks"]))
  assert.deepEqual(deriveConversationJoinCandidates(
    graph,
    conversationRef,
    revision("a"),
    Object.keys(assembled.turnContentByReference),
  ), [turnTwoRef])
})

test("conversation assembly fails closed on snapshot drift and absent exact turns", () => {
  const first = page({
    afterOrdinal: 0,
    hasMore: false,
    nextAfterOrdinal: null,
    objects: [chat, turnOne],
    relations: [containsOne],
    turns: [turnOneDetail],
  })
  assert.throws(() => assembleConversationGraphPages([first], {
    reference: turnTwoRef,
    conversationReference: conversationRef,
  }), /selected exact reference is absent/u)
  const drift = structuredClone(first)
  drift.contentHash = revision("d")
  assert.throws(() => assembleConversationGraphPages([drift], { reference: conversationRef }), /contentHash disagrees/u)
  const malformed = structuredClone(first)
  malformed.continuation.hasMore = true
  malformed.continuation.nextAfterOrdinal = null
  assert.throws(() => assembleConversationGraphPages([malformed], { reference: conversationRef }), /continuation is malformed/u)
  const identityMismatch = structuredClone(first)
  identityMismatch.turns[0].ref = turnTwoRef
  assert.throws(() => assembleConversationGraphPages([identityMismatch], { reference: conversationRef }), /identity disagrees/u)
  const oversized = structuredClone(first)
  oversized.turns[0].content = "x".repeat(CONVERSATION_TURN_CONTENT_MAX_BYTES + 1)
  assert.throws(() => assembleConversationGraphPages([oversized], { reference: conversationRef }), /bounded conversation contract/u)
})

test("the shared graph surface gives conversation mode semantic labels, lineage, and safe markdown detail", async () => {
  const component = await readFile(new URL("../components/graph/unified-graph.tsx", import.meta.url), "utf8")
  const client = await readFile(new URL("../app/graph/graph-client.tsx", import.meta.url), "utf8")
  const serverContract = await readFile(new URL("../services/galaxy-brain-api/conversation_dag.py", import.meta.url), "utf8")
  assert.match(component, /Immutable conversation atlas/)
  assert.match(component, /Conversation tree/)
  assert.match(component, /CONVERSATION_SCALE_LABEL/)
  assert.match(component, /conversationLayers/)
  assert.match(component, /conversationMode && scale === "corpus"/)
  assert.match(component, /node\.kind === "chat"/)
  assert.match(component, /edge\.relation === "forks"/)
  assert.match(component, /conversationJoin/)
  assert.match(component, /Join selected tips/)
  assert.match(component, /MarkdownRenderer/)
  assert.match(component, /images="omit"/)
  assert.match(component, /scale === "object" \|\| scale === "atomic"/)
  assert.match(component, /content=\{exactTurnContent\}/)
  assert.match(component, /selectedTurnDetail\?\.reference === selected\.ref/)
  assert.doesNotMatch(component, /content=\{selected\.summary\}/)
  assert.match(client, /assembleConversationGraphPages/)
  assert.match(client, /canonicalGraphQueryParameter\(parameters, "ref"\)/)
  assert.match(client, /canonicalGraphQueryParameter\(parameters, "conversation"\)/)
  assert.match(client, /selectedTurnDetail=\{selectedReference && Object\.hasOwn\(loaded\.turnContentByReference, selectedReference\)/)
  assert.match(client, /conversationGraphPagePath/)
  assert.match(client, /fetchConversationMarkdownExport\(reference, \{ signal: controller\.signal \}\)[\s\S]*saveConversationMarkdownExport\(exported\)/)
  assert.match(client, /deriveConversationJoinCandidates/)
  assert.match(client, /reconcileConversationJoin/)
  assert.match(client, /conversationJoinRecoveryStorageKey/)
  assert.match(client, /parentTurnReferences: Object\.freeze\(\[\.\.\.parentTurnReferences\]\)/)
  assert.match(client, /all of its exact parent edges could not be verified/)
  assert.match(client, /loadedRouteSearch !== routeSearch/)
  assert.match(client, /assembled\.graphInput\.scope\.tenantId !== tenantId/)
  assert.doesNotMatch(client, /executeConversation|sendMessage|modelId|rawLog/u)
  assert.equal(CONVERSATION_TURN_CONTENT_MAX_BYTES, 65_536)
  assert.match(serverContract, /_text\(value\["content"\], "message\.content", 65_536\)/)
})
