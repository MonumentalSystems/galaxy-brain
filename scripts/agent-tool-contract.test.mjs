import assert from "node:assert/strict"
import test from "node:test"

import {
  AGENT_TOOL_IDS,
  AgentToolContractError,
  createAgentToolResult,
  parseAgentToolCall,
  serializeAgentToolResult,
} from "../lib/agent-tools/contracts.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"

const GRAPH_REF = Object.freeze({ graphId: "mission-1", contentSha256: "a".repeat(64) })
const TASK_PLAN_ID = "00000000-0000-4000-8000-000000000321"
const DOCUMENT_MARK_AUTHORING_TOOL_IDS = Object.freeze([
  "document.mark.create", "document.mark.update",
])

function surfaceSpec(text = "Review this evidence") {
  return {
    schema: "gb.surface.v1",
    catalog: { id: "generous.a2ui", version: "1" },
    surfaceUpdate: {
      surfaceId: "agent-review",
      components: [{ id: "summary", component: { Text: { text } } }],
    },
    bindings: [],
  }
}

test("the agent contract exposes no document-mark authoring tool", () => {
  for (const id of DOCUMENT_MARK_AUTHORING_TOOL_IDS) assert.equal(AGENT_TOOL_IDS.includes(id), false)
})

test("anchors.create accepts one exact pinned document representation and selector", () => {
  const documentRef = createGalaxyObjectReference("document", "00000000-0000-4000-8000-000000000111", {
    mode: "pinned", revision: `sha256:${"a".repeat(64)}`,
  })
  const value = {
    schemaId: "gb.agent-tool-call.v1",
    tool: "anchors.create",
    input: {
      documentRef,
      representation: {
        id: "00000000-0000-4000-8000-000000000222",
        contentSha256: "b".repeat(64),
      },
      selector: {
        kind: "page-region", page: 2, coordinateSpace: "normalized-page",
        polygon: [0.0000001, 0.2, 0.8, 0.2, 0.8, 0.9, 0.0000001, 0.9],
      },
      idempotencyKey: "anchor-operation-1",
    },
  }
  const call = parseAgentToolCall(value)
  assert.deepEqual(call.input.selector.polygon, [0, 0.2, 0.8, 0.2, 0.8, 0.9, 0, 0.9])
  assert.ok(Object.isFrozen(call.input.representation) && Object.isFrozen(call.input.selector.polygon))

  for (const input of [
    { ...value.input, documentRef: createGalaxyObjectReference("document", "doc") },
    { ...value.input, documentRef: createGalaxyObjectReference("paper", "doc", {
      mode: "pinned", revision: `sha256:${"a".repeat(64)}`,
    }) },
    { ...value.input, representation: { ...value.input.representation, contentSha256: `sha256:${"b".repeat(64)}` } },
    { ...value.input, selector: { ...value.input.selector, unknown: true } },
    { ...value.input, provenance: { source: "caller" } },
  ]) {
    assert.throws(() => parseAgentToolCall({ ...value, input }), AgentToolContractError)
  }
})

function proposalReferences(count, offset = 0) {
  return Array.from({ length: count }, (_, index) => createGalaxyObjectReference(
    "paper", `proposal-paper-${offset + index}`,
    { mode: "pinned", revision: `sha256:${(offset + index + 1).toString(16).padStart(64, "0")}` },
  ))
}

test("agent calls are exact, versioned, bounded, and canonical", () => {
  const reference = createGalaxyObjectReference("document", "paper-notes")
  assert.deepEqual(parseAgentToolCall({
    schemaId: "gb.agent-tool-call.v1",
    tool: "objects.get",
    input: { ref: reference },
  }), {
    schemaId: "gb.agent-tool-call.v1",
    tool: "objects.get",
    input: { ref: reference },
  })

  const graph = parseAgentToolCall({
    schemaId: "gb.agent-tool-call.v1",
    tool: "proof.graph.get",
    input: { graphRef: GRAPH_REF, limit: 20 },
  })
  assert.equal(graph.input.limit, 20)
  assert.equal(graph.input.cursor, null)
  assert.ok(Object.isFrozen(graph) && Object.isFrozen(graph.input) && Object.isFrozen(graph.input.graphRef))

  for (const invalid of [
    { schemaId: "gb.agent-tool-call.v1", tool: "objects.get", input: { ref: reference }, tenantId: "caller-owned" },
    { schemaId: "gb.agent-tool-call.v1", tool: "objects.get", input: { ref: reference, url: "https://evil.test" } },
    { schemaId: "gb.agent-tool-call.v1", tool: "canvas.place", input: {} },
    { schemaId: "gb.agent-tool-call.v1", tool: "proof.claim.extra", input: { graphRef: GRAPH_REF } },
    { schemaId: "gb.agent-tool-call.v1", tool: "proof.graph.get", input: { graphRef: { ...GRAPH_REF, extra: true } } },
    { schemaId: "gb.agent-tool-call.v1", tool: "proof.graph.get", input: { graphRef: GRAPH_REF, limit: 2 } },
  ]) assert.throws(() => parseAgentToolCall(invalid), AgentToolContractError)

  assert.throws(() => parseAgentToolCall({
    schemaId: "gb.agent-tool-call.v1",
    tool: "objects.get",
    input: { ref: reference },
  }, "canvas.get"), /must match/)
})

test("proof.claim accepts only version-fenced acquire and release transitions", () => {
  const base = {
    graphRef: GRAPH_REF,
    workspaceId: "mission-1-work",
    nodeId: "lemma:foundation",
    expectedVersion: 4,
    expectedItemVersion: 0,
    action: "acquire",
    leaseSeconds: 900,
    idempotencyKey: "claim-foundation-1",
  }
  const acquire = parseAgentToolCall({
    schemaId: "gb.agent-tool-call.v1", tool: "proof.claim", input: base,
  })
  assert.deepEqual(acquire.input, base)
  assert.ok(Object.isFrozen(acquire.input) && Object.isFrozen(acquire.input.graphRef))

  const release = parseAgentToolCall({
    schemaId: "gb.agent-tool-call.v1", tool: "proof.claim",
    input: { ...base, action: "release", expectedItemVersion: 1, leaseSeconds: undefined },
  })
  assert.equal(release.input.action, "release")
  assert.equal(Object.hasOwn(release.input, "leaseSeconds"), false)

  for (const input of [
    { ...base, action: "renew" },
    { ...base, leaseSeconds: 59 },
    { ...base, leaseSeconds: 86_401 },
    { ...base, action: "release" },
    { ...base, expectedVersion: 0 },
    { ...base, expectedItemVersion: -1 },
    { ...base, tenantId: "caller-owned" },
    { ...base, nostrPubkey: "a".repeat(64) },
    { ...base, idempotencyKey: "short" },
  ]) {
    assert.throws(() => parseAgentToolCall({
      schemaId: "gb.agent-tool-call.v1", tool: "proof.claim", input,
    }), AgentToolContractError)
  }
})

test("objects.search reuses the bounded document corpus query contract without caller authority", () => {
  assert.deepEqual(parseAgentToolCall({
    schemaId: "gb.agent-tool-call.v1",
    tool: "objects.search",
    input: { query: "  helicity vortex  " },
  }).input, { query: "helicity vortex", limit: 8 })

  for (const input of [
    { query: "" },
    { query: "x".repeat(501) },
    { query: "vortex", limit: 21 },
    { query: "vortex", cursor: "next" },
    { query: "vortex", tenantId: "caller-owned" },
    { query: "vortex", endpoint: "https://evil.test" },
  ]) {
    assert.throws(() => parseAgentToolCall({
      schemaId: "gb.agent-tool-call.v1",
      tool: "objects.search",
      input,
    }), (error) => error instanceof AgentToolContractError
      && error.code === "invalid_request")
  }
})

test("ham.memory.search accepts only the closed search mode union without caller authority", () => {
  assert.deepEqual(parseAgentToolCall({
    schemaId: "gb.agent-tool-call.v1",
    tool: "ham.memory.search",
    input: { query: "  helicity memory  " },
  }).input, {
    query: "helicity memory", mode: "search", topK: 10,
  })
  assert.deepEqual(parseAgentToolCall({
    schemaId: "gb.agent-tool-call.v1",
    tool: "ham.memory.search",
    input: { query: "proof frontier", mode: "multihop", topK: 12, maxHops: 2 },
  }).input, {
    query: "proof frontier", mode: "multihop", topK: 12, maxHops: 2,
  })
  assert.deepEqual(parseAgentToolCall({
    schemaId: "gb.agent-tool-call.v1",
    tool: "ham.memory.search",
    input: {
      query: "state at checkpoint", mode: "temporal", topK: 5,
      asOf: "2026-09-27T12:00:00-04:00", temporalMode: "known_at", includeHistory: false,
    },
  }).input, {
    query: "state at checkpoint", mode: "temporal", topK: 5,
    asOf: "2026-09-27T16:00:00.000Z", temporalMode: "known_at", includeHistory: false,
  })

  for (const input of [
    { query: "" },
    { query: "memory", mode: null },
    { query: "memory", mode: 1 },
    { query: "memory", mode: "SEARCH" },
    { query: "memory", mode: "unknown" },
    { query: "memory", topK: null },
    { query: "memory", topK: "10" },
    { query: "memory", topK: 1.5 },
    { query: "memory", topK: 0 },
    { query: "memory", topK: 51 },
    { query: "memory", maxHops: 1 },
    { query: "memory", mode: "search", includeHistory: true },
    { query: "memory", mode: "multihop", maxHops: null },
    { query: "memory", mode: "multihop", maxHops: "2" },
    { query: "memory", mode: "multihop", maxHops: 1.5 },
    { query: "memory", mode: "multihop", maxHops: -1 },
    { query: "memory", mode: "multihop", maxHops: 3 },
    { query: "memory", mode: "multihop", asOf: "2026-09-27T12:00:00Z" },
    { query: "memory", mode: "temporal" },
    { query: "memory", mode: "temporal", asOf: null },
    { query: "memory", mode: "temporal", asOf: 0 },
    { query: "memory", mode: "temporal", asOf: "" },
    { query: "memory", mode: "temporal", asOf: "not-a-time" },
    { query: "memory", mode: "temporal", asOf: "2026-09-27T12:00:00Z", temporalMode: null },
    { query: "memory", mode: "temporal", asOf: "2026-09-27T12:00:00Z", temporalMode: "latest" },
    { query: "memory", mode: "temporal", asOf: "2026-09-27T12:00:00Z", includeHistory: null },
    { query: "memory", mode: "temporal", asOf: "2026-09-27T12:00:00Z", includeHistory: "false" },
    { query: "memory", mode: "temporal", asOf: "2026-09-27T12:00:00Z", includeHistory: 0 },
    { query: "memory", tenantId: "caller-owned" },
    { query: "memory", endpoint: "https://evil.test" },
    { query: "memory", bearer: "caller-secret" },
    { query: "memory", actorId: "caller-agent" },
  ]) {
    assert.throws(() => parseAgentToolCall({
      schemaId: "gb.agent-tool-call.v1",
      tool: "ham.memory.search",
      input,
    }), (error) => error instanceof AgentToolContractError
      && error.code === "invalid_request")
  }
})

test("graph.window.get derives the fixed corpus boundary from an exact caller allowlist", () => {
  const rootRef = createGalaxyObjectReference("document", "paper-notes")
  const expandClusterId = `gwc:${"a".repeat(64)}`
  const call = parseAgentToolCall({
    schemaId: "gb.agent-tool-call.v1",
    tool: "graph.window.get",
    input: {
      rootRef,
      viewport: { x: -10, y: 20, width: 800, height: 600 },
      kinds: ["paper", "document"],
      relations: ["related", "cites"],
      expandClusterId,
      cursor: "next_page-1",
    },
  })
  assert.deepEqual(call.input, {
    schemaId: "gb.graph-window-request.v1",
    workspaceId: "tenant-catalog",
    mode: "mixed",
    lens: "explore",
    scale: "corpus",
    viewport: { x: -10, y: 20, width: 800, height: 600 },
    filters: { kinds: ["document", "paper"], relations: ["cites", "related"] },
    rootRef,
    expandClusterId,
    cursor: "next_page-1",
  })
  assert.ok(Object.isFrozen(call.input) && Object.isFrozen(call.input.viewport)
    && Object.isFrozen(call.input.filters) && Object.isFrozen(call.input.filters.kinds))

  for (const input of [
    { workspaceId: "caller-workspace" },
    { tenantId: "caller-tenant" },
    { principalId: "caller-principal" },
    { mode: "mixed" },
    { lens: "explore" },
    { scale: "corpus" },
    { provider: "caller-provider" },
    { endpoint: "https://evil.test" },
    { url: "https://evil.test" },
    { schemaId: "gb.graph-window-request.v1" },
    { kinds: ["chat"] },
    { relations: ["formalized_by"] },
    { cursor: "orphaned" },
    { viewport: { x: 0, y: 0, width: 1, height: 1, extra: true } },
  ]) {
    assert.throws(() => parseAgentToolCall({
      schemaId: "gb.agent-tool-call.v1", tool: "graph.window.get", input,
    }), (error) => error instanceof AgentToolContractError && error.code === "invalid_request")
  }
})

test("canvas.arrange accepts only bounded non-destructive presentation commands", () => {
  const canvasId = "00000000-0000-4000-8000-000000000123"
  const reference = createGalaxyObjectReference("document", "paper-notes")
  const item = {
    id: "paper-notes", subjectRef: reference, nodeType: "galaxy.document",
    x: 12, y: -4, width: 320, height: 220, angle: 0, zIndex: 1,
    displayMode: "card", collapsed: false, style: { accent: "sage" },
  }
  const call = parseAgentToolCall({
    schemaId: "gb.agent-tool-call.v1",
    tool: "canvas.arrange",
    input: {
      canvasId,
      expectedVersion: 4,
      expectedContentHash: `sha256:${"a".repeat(64)}`,
      idempotencyKey: "arrange-operation-1",
      commands: [
        { type: "item.place", item },
        { type: "item.move", itemId: item.id, position: { x: 80, y: 90 } },
        { type: "item.resize", itemId: item.id, size: { width: 400, height: 280 } },
        { type: "item.reorder", itemId: item.id, zIndex: 3 },
        {
          type: "edge.connect",
          edge: {
            id: "visual-link", sourceItemId: "paper-notes", targetItemId: "other-note",
            edgeKind: "related", label: "visual grouping", style: {},
          },
        },
      ],
    },
  })
  assert.equal(call.input.commands.length, 5)
  assert.ok(Object.isFrozen(call.input.commands) && Object.isFrozen(call.input.commands[0].item))

  for (const commands of [
    [{ type: "item.remove", itemId: "paper-notes" }],
    [{ type: "edge.disconnect", edgeId: "visual-link" }],
    [{
      type: "frame.create",
      frame: {
        id: "agent-frame", title: "Agent frame", x: 0, y: 0,
        width: 720, height: 480, tone: "sage",
      },
    }],
    [{ type: "frame.remove", frameId: "agent-frame" }],
    [{
      type: "edge.connect",
      edge: {
        id: "truth-link", sourceItemId: "paper-notes", targetItemId: "other-note",
        edgeKind: "supports", semanticRef: reference, style: {},
      },
    }],
  ]) {
    assert.throws(() => parseAgentToolCall({
      schemaId: "gb.agent-tool-call.v1",
      tool: "canvas.arrange",
      input: {
        canvasId, expectedVersion: 4,
        expectedContentHash: `sha256:${"a".repeat(64)}`,
        idempotencyKey: "arrange-operation-1", commands,
      },
    }), AgentToolContractError)
  }

  for (const style of ["sage", ["sage"], null]) {
    assert.throws(() => parseAgentToolCall({
      schemaId: "gb.agent-tool-call.v1",
      tool: "canvas.arrange",
      input: {
        canvasId, expectedVersion: 4,
        expectedContentHash: `sha256:${"a".repeat(64)}`,
        idempotencyKey: "arrange-operation-1",
        commands: [{ type: "item.place", item: { ...item, style } }],
      },
    }), AgentToolContractError)
  }
})

test("canvas.arrange accepts exact chat snapshots and rejects follow-latest conversations", () => {
  const canvasId = "00000000-0000-4000-8000-000000000123"
  const arrange = (subjectRef) => parseAgentToolCall({
    schemaId: "gb.agent-tool-call.v1",
    tool: "canvas.arrange",
    input: {
      canvasId,
      expectedVersion: 4,
      expectedContentHash: `sha256:${"a".repeat(64)}`,
      idempotencyKey: "arrange-chat-operation-1",
      commands: [{
        type: "item.place",
        item: {
          id: "research-thread",
          subjectRef,
          nodeType: "galaxy.chat",
          x: 80,
          y: 80,
          width: 420,
          height: 260,
          angle: 0,
          zIndex: 0,
          displayMode: "card",
          collapsed: false,
          style: {},
        },
      }],
    },
  })

  const pinned = createGalaxyObjectReference("chat", "research-thread", {
    mode: "pinned",
    revision: `sha256:${"c".repeat(64)}`,
  })
  const call = arrange(pinned)
  assert.equal(call.input.commands[0].item.subjectRef, pinned)
  assert.equal(call.input.commands[0].item.nodeType, "galaxy.chat")
  assert.equal(call.input.commands[0].item.width, 420)
  assert.equal(call.input.commands[0].item.height, 260)
  assert.ok(Object.isFrozen(call.input.commands[0].item))

  const latest = createGalaxyObjectReference("chat", "research-thread")
  assert.throws(() => arrange(latest), AgentToolContractError)
})

test("relations.propose accepts only pinned durable endpoints and bounded proposal fields", () => {
  const fromRef = createGalaxyObjectReference("document", "paper", { mode: "pinned", revision: `sha256:${"a".repeat(64)}` })
  const toRef = createGalaxyObjectReference("proof.node", "lemma", { mode: "pinned", revision: `sha256:${"b".repeat(64)}` })
  const call = parseAgentToolCall({
    schemaId: "gb.agent-tool-call.v1", tool: "relations.propose",
    input: { fromRef, toRef, relation: "corresponds_to", rationale: "Same formal statement.", idempotencyKey: "relation-proposal-1" },
  })
  assert.equal(call.input.relation, "corresponds_to")
  for (const input of [
    { ...call.input, basis: "derived" },
    { ...call.input, status: "active" },
    { ...call.input, toRef: fromRef },
    { ...call.input, relation: "supports" },
    { ...call.input, rationale: "é".repeat(2049) },
    { ...call.input, idempotencyKey: "proposal/key" },
    { ...call.input, fromRef: createGalaxyObjectReference("document", "paper") },
    { ...call.input, fromRef: createGalaxyObjectReference("document", "paper", { mode: "pinned", revision: "draft" }) },
    { ...call.input, fromRef: createGalaxyObjectReference("chat", "research-thread") },
  ]) assert.throws(() => parseAgentToolCall({ schemaId: "gb.agent-tool-call.v1", tool: "relations.propose", input }), AgentToolContractError)
})

test("surface.draft.create accepts one browser-safe bounded definition and pinned evidence only", () => {
  const evidenceRef = createGalaxyObjectReference("document", "paper-notes", {
    mode: "pinned", revision: `sha256:${"a".repeat(64)}`,
  })
  const input = {
    title: "Evidence review",
    spec: surfaceSpec(),
    evidenceRefs: [evidenceRef],
    idempotencyKey: "surface-draft-operation-1",
  }
  const parsed = parseAgentToolCall({
    schemaId: "gb.agent-tool-call.v1",
    tool: "surface.draft.create",
    input,
  })
  assert.deepEqual(parsed.input, input)
  assert.ok(Object.isFrozen(parsed.input.spec)
    && Object.isFrozen(parsed.input.spec.surfaceUpdate.components[0]))

  const secondRef = createGalaxyObjectReference("paper", "paper-2", {
    mode: "pinned", revision: `sha256:${"b".repeat(64)}`,
  })
  for (const invalidInput of [
    { ...input, evidenceRefs: [] },
    { ...input, evidenceRefs: [evidenceRef, evidenceRef] },
    { ...input, evidenceRefs: [createGalaxyObjectReference("document", "paper-notes")] },
    { ...input, evidenceRefs: Array.from({ length: 33 }, (_, index) => createGalaxyObjectReference(
      "artifact", `evidence-${index}`,
      { mode: "pinned", revision: `sha256:${index.toString(16).padStart(64, "0")}` },
    )) },
    { ...input, spec: { ...surfaceSpec(), extra: true } },
    { ...input, spec: { ...surfaceSpec(), catalog: { id: "other", version: "1" } } },
    { ...input, spec: surfaceSpec("javascript:alert(1)") },
    { ...input, spec: surfaceSpec("x".repeat(18_000)), evidenceRefs: [evidenceRef, secondRef], extra: true },
    { ...input, idempotencyKey: "short" },
  ]) {
    assert.throws(() => parseAgentToolCall({
      schemaId: "gb.agent-tool-call.v1", tool: "surface.draft.create", input: invalidInput,
    }), AgentToolContractError)
  }

  const oversized = surfaceSpec("x".repeat(18_000))
  oversized.surfaceUpdate.components.push(
    { id: "second", component: { Text: { text: "y".repeat(18_000) } } },
    { id: "third", component: { Text: { text: "z".repeat(18_000) } } },
  )
  assert.throws(() => parseAgentToolCall({
    schemaId: "gb.agent-tool-call.v1", tool: "surface.draft.create",
    input: { ...input, spec: oversized },
  }), /48 KiB/u)
})

test("task plan proposal calls are exact-base, additive-intent, and pinned-reference only", () => {
  const pinnedRef = createGalaxyObjectReference("paper", "paper-1", {
    mode: "pinned", revision: `sha256:${"b".repeat(64)}`,
  })
  const base = {
    taskPlanId: TASK_PLAN_ID,
    expectedVersion: 3,
    expectedContentHash: "a".repeat(64),
    expectedHamTaskId: "ham-task-1",
    expectedHamTaskVersion: 7,
    action: "branch",
    sourceJobIds: ["research"],
    title: "Parallel review",
    goal: "Explore two bounded alternatives.",
    inputRefs: [pinnedRef],
    branches: [
      { kind: "compare", title: "Compare", goal: "Compare evidence.", inputRefs: [pinnedRef] },
      { kind: "challenge", title: "Challenge", goal: "Challenge assumptions." },
    ],
  }
  const parsed = parseAgentToolCall({
    schemaId: "gb.agent-tool-call.v1",
    tool: "task.plan.propose",
    input: base,
  })
  assert.equal(parsed.input.action, "branch")
  assert.equal(parsed.input.instruction, null)
  assert.equal(parsed.input.branches[1].instruction, null)
  assert.ok(Object.isFrozen(parsed.input.branches) && Object.isFrozen(parsed.input.inputRefs))

  assert.deepEqual(parseAgentToolCall({
    schemaId: "gb.agent-tool-call.v1",
    tool: "task.plan.get",
    input: { taskPlanId: TASK_PLAN_ID },
  }).input, { taskPlanId: TASK_PLAN_ID, hamTaskId: null })
  assert.deepEqual(parseAgentToolCall({
    schemaId: "gb.agent-tool-call.v1",
    tool: "task.plan.get",
    input: { hamTaskId: "ham-task-1" },
  }).input, { taskPlanId: null, hamTaskId: "ham-task-1" })
  assert.throws(() => parseAgentToolCall({
    schemaId: "gb.agent-tool-call.v1",
    tool: "task.plan.get",
    input: { taskPlanId: TASK_PLAN_ID, hamTaskId: "ham-task-1" },
  }), AgentToolContractError)

  for (const invalidInput of [
    { ...base, inputRefs: [createGalaxyObjectReference("paper", "paper-1")] },
    { ...base, action: "execute" },
    { ...base, action: "join", branches: [], sourceJobIds: ["research"] },
    { ...base, branches: [...base.branches, { kind: "run", title: "Run", goal: "Execute." }] },
    { ...base, removeJobIds: ["research"] },
  ]) {
    assert.throws(() => parseAgentToolCall({
      schemaId: "gb.agent-tool-call.v1",
      tool: "task.plan.propose",
      input: invalidInput,
    }), AgentToolContractError)
  }
})

test("task plan proposals cap aggregate distinct input references across every branch", () => {
  const references = proposalReferences(65)
  const base = {
    taskPlanId: TASK_PLAN_ID,
    expectedVersion: 3,
    expectedContentHash: "a".repeat(64),
    expectedHamTaskId: "ham-task-1",
    expectedHamTaskVersion: 7,
    action: "branch",
    sourceJobIds: ["research"],
    title: "Bounded branches",
    goal: "Keep every branch input bounded.",
    inputRefs: references.slice(0, 20),
    branches: [
      { kind: "compare", title: "Compare", goal: "Compare evidence.", inputRefs: references.slice(20, 42) },
      { kind: "challenge", title: "Challenge", goal: "Challenge evidence.", inputRefs: references.slice(42, 64) },
    ],
  }
  const parse = (input) => parseAgentToolCall({
    schemaId: "gb.agent-tool-call.v1", tool: "task.plan.propose", input,
  })

  assert.equal(parse(base).input.branches.length, 2)
  assert.throws(() => parse({
    ...base,
    branches: [base.branches[0], { ...base.branches[1], inputRefs: references.slice(42, 65) }],
  }), (error) => error instanceof AgentToolContractError && /64 distinct/u.test(error.message))

  const duplicateHeavy = {
    ...base,
    inputRefs: references.slice(0, 32),
    branches: [
      { ...base.branches[0], inputRefs: references.slice(0, 64) },
      { ...base.branches[1], inputRefs: references.slice(32, 64) },
    ],
  }
  assert.equal(parse(duplicateHeavy).input.inputRefs.length, 32)
  assert.throws(() => parse({ ...base, inputRefs: [references[0], references[0]] }), /duplicates/u)
})

test("result envelopes have one bounded pagination contract", () => {
  const value = createAgentToolResult("proof.frontier.get", { items: [] }, {
    cursor: null,
    hasMore: false,
    limit: 100,
  })
  assert.deepEqual(value, {
    schemaId: "gb.agent-tool-result.v1",
    tool: "proof.frontier.get",
    result: { items: [] },
    pagination: { cursor: null, hasMore: false, limit: 100 },
  })
  assert.equal(JSON.parse(serializeAgentToolResult(value)).schemaId, "gb.agent-tool-result.v1")
  assert.throws(() => createAgentToolResult("proof.frontier.get", {}, {
    cursor: "gbf1:cursor",
    hasMore: false,
    limit: 100,
  }), /inconsistent/)
  assert.throws(() => serializeAgentToolResult(createAgentToolResult("objects.get", {
    value: "x".repeat(1_048_576),
  })), /exceeds 1 MiB/)
})
