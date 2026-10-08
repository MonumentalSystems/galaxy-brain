import assert from "node:assert/strict"
import { createHash, webcrypto } from "node:crypto"
import test from "node:test"
import { readFile } from "node:fs/promises"
import vm from "node:vm"
import ts from "typescript"
import { createTaskPlanDraftGuard, createTaskPlanLatestRequestGuard } from "../lib/task-plan-draft-guard.js"
import {
  createGalaxyObjectReference,
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "../lib/galaxy-object-reference.js"

const source = await readFile(new URL("../lib/task-plan.ts", import.meta.url), "utf8")
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const sandbox = {
  exports: {},
  crypto: webcrypto,
  TextEncoder,
  require(specifier) {
    if (specifier === "@/lib/galaxy-object-reference.js") {
      return { parseGalaxyObjectReference, serializeGalaxyObjectReference }
    }
    throw new Error(`Unexpected task-plan dependency: ${specifier}`)
  },
}
vm.runInNewContext(compiled, sandbox)

const {
  TASK_PLAN_EDGE_KINDS,
  appendTaskPlanEdge,
  authorizedPinnedTaskResourceRefs,
  createStarterTaskPlan,
  createTaskPlanTitle,
  getTaskConstructorCloseDecision,
  previewTaskPlanProposal,
  removeTaskPlanNodes,
} = sandbox.exports

const pinnedAnchor = createGalaxyObjectReference("document.anchor", `sha256:${"d".repeat(64)}`, {
  mode: "pinned",
  revision: `sha256:${"e".repeat(64)}`,
})

function plan() {
  return {
    schema: "gb.task-plan.v1",
    task: { kind: "galaxy.ham.task", id: "task-1" },
    goal: "Test safe node removal.",
    nodes: [
      { id: "context", kind: "context", title: "Context", goal: "", position: { x: 0, y: 0 }, config: {} },
      { id: "artifact", kind: "artifact", title: "Artifact", goal: "", position: { x: 1, y: 0 }, config: {} },
    ],
    edges: [
      { id: "context-artifact", source: "context", target: "artifact", kind: "control" },
    ],
  }
}

function savedRecord() {
  return {
    id: "123e4567-e89b-42d3-a456-426614174000",
    tenant_id: "123e4567-e89b-42d3-a456-426614174001",
    ham_task_id: "task-1",
    created_by_principal_id: "123e4567-e89b-42d3-a456-426614174002",
    title: "Test plan",
    schema_version: "gb.task-plan.v1",
    current_version: 3,
    current_content_hash: "a".repeat(64),
    current_spec: { ...plan(), task: { kind: "galaxy.ham.task", id: "task-1", version: 7 } },
    provenance: {},
    created_at: "2026-09-25T00:00:00Z",
    updated_at: "2026-09-25T00:00:00Z",
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonicalJson)
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]))
}

function bindProposalHash(candidate) {
  const { proposalHash: _proposalHash, ...content } = candidate
  const digest = createHash("sha256").update(JSON.stringify(canonicalJson(content)), "utf8").digest("hex")
  return { ...candidate, proposalHash: `sha256:${digest}` }
}

function proposal(overrides = {}) {
  const source = {
    schemaId: "gb.task-plan-proposal.v1",
    requestHash: `sha256:${"b".repeat(64)}`,
    scope: "task-local-work",
    effect: "proposal",
    action: "challenge",
    base: {
      taskPlanId: savedRecord().id,
      taskPlanVersion: 3,
      taskPlanContentHash: "a".repeat(64),
      hamTaskId: "task-1",
      hamTaskVersion: 7,
    },
    sourceJobIds: ["context"],
    inputRefs: [],
    operations: [
      {
        op: "node.add",
        node: {
          id: "challenge-proposal",
          kind: "challenge",
          title: "Challenge the premise",
          goal: "Test the source claim.",
          position: { x: 320, y: 200 },
          config: { instruction: "Look for disconfirming evidence." },
        },
      },
      {
        op: "edge.add",
        edge: { id: "proposal-edge", source: "context", target: "challenge-proposal", kind: "evidence" },
      },
    ],
    summary: "Proposed challenge structure with 2 additive operations.",
    proposalHash: `sha256:${"0".repeat(64)}`,
  }
  const result = { ...source, ...overrides }
  if (!Object.hasOwn(overrides, "summary") && (Object.hasOwn(overrides, "action") || Object.hasOwn(overrides, "operations"))) {
    result.summary = `Proposed ${result.action} structure with ${result.operations.length} additive operations.`
  }
  return bindProposalHash(result)
}

function pinnedReference(index, idPrefix = "document") {
  return createGalaxyObjectReference("document", `${idPrefix}-${index}`, {
    mode: "pinned",
    revision: `sha256:${index.toString(16).padStart(64, "0")}`,
  })
}

test("node removal preserves a non-empty plan and drops incident edges", () => {
  const next = removeTaskPlanNodes(plan(), new Set(["context"]))
  assert.deepEqual(next.nodes.map((node) => node.id), ["artifact"])
  assert.deepEqual(next.edges, [])
})

test("node removal rejects deleting every job", () => {
  assert.equal(removeTaskPlanNodes(plan(), new Set(["context", "artifact"])), null)
})

test("generated plan titles retain their suffix without exceeding the API limit", () => {
  const title = createTaskPlanTitle("A".repeat(200))
  assert.equal(Array.from(title).length, 200)
  assert.match(title, / · plan$/)

  const unicodeTitle = createTaskPlanTitle("🧠".repeat(200))
  assert.equal(Array.from(unicodeTitle).length, 200)
  assert.match(unicodeTitle, / · plan$/)
})

test("starter context seeds only authorized active read-like pinned task resources", () => {
  const resources = [
    { resourceRef: pinnedAnchor, redacted: false, mode: "read", status: "active" },
    { resourceRef: pinnedAnchor, redacted: false, mode: "observe", status: "active" },
    { resourceRef: "gb:object:v1:document:latest:latest", redacted: false, mode: "read", status: "active" },
    { resourceRef: createGalaxyObjectReference("document", "hidden", { mode: "pinned", revision: `sha256:${"f".repeat(64)}` }), redacted: true, mode: "read", status: "active" },
    { resourceRef: createGalaxyObjectReference("document", "write", { mode: "pinned", revision: `sha256:${"1".repeat(64)}` }), redacted: false, mode: "write", status: "active" },
    { resourceRef: createGalaxyObjectReference("document", "released", { mode: "pinned", revision: `sha256:${"2".repeat(64)}` }), redacted: false, mode: "read", status: "released" },
  ]
  assert.deepEqual([...authorizedPinnedTaskResourceRefs(resources)], [pinnedAnchor])
  const starter = createStarterTaskPlan({
    id: "task-1",
    title: "Review evidence",
    goal: "Use only readable pinned inputs.",
    version: 7,
    resources,
  })
  assert.deepEqual([...(starter.nodes.find((node) => node.id === "context").config.inputRefs ?? [])], [pinnedAnchor])
  assert.equal(starter.task.version, 7)
})

test("shared connection helper accepts every approved kind and normalizes labels", () => {
  for (const kind of TASK_PLAN_EDGE_KINDS) {
    const source = { ...plan(), edges: [] }
    const next = appendTaskPlanEdge(
      source,
      { source: "context", target: "artifact", kind, label: "  supporting path  " },
      () => `edge-${kind}`,
    )
    assert.equal(next.edges[0].kind, kind)
    assert.equal(next.edges[0].label, "supporting path")
    assert.equal(source.edges.length, 0)
  }
  const withoutLabel = appendTaskPlanEdge(
    { ...plan(), edges: [] },
    { source: "context", target: "artifact", kind: "control", label: "   " },
    () => "edge-unlabelled",
  )
  assert.equal("label" in withoutLabel.edges[0], false)

  const parallel = appendTaskPlanEdge(
    plan(),
    { source: "context", target: "artifact", kind: "evidence", label: "separate evidence relation" },
    () => "parallel-evidence",
  )
  assert.equal(parallel.edges.length, 2)
  assert.deepEqual(Array.from(parallel.edges, (edge) => edge.kind), ["control", "evidence"])
})

test("shared connection helper uses bounded opaque IDs for long endpoint identifiers", () => {
  const sourceId = `s${"a".repeat(127)}`
  const targetId = `t${"b".repeat(127)}`
  const source = {
    ...plan(),
    nodes: plan().nodes.map((node, index) => ({ ...node, id: index === 0 ? sourceId : targetId })),
    edges: [],
  }
  const next = appendTaskPlanEdge(
    source,
    { source: sourceId, target: targetId, kind: "evidence" },
    () => "edge-123e4567-e89b-12d3-a456-426614174000",
  )
  assert.equal(next.edges[0].id.length < 128, true)
  assert.doesNotMatch(next.edges[0].id, new RegExp(sourceId))
})

test("shared connection helper rejects dangling, self, cyclic, oversized, and colliding edges", () => {
  const source = plan()
  assert.throws(() => appendTaskPlanEdge(source, { source: "missing", target: "artifact", kind: "control" }), /still exist/)
  assert.throws(() => appendTaskPlanEdge(source, { source: "context", target: "context", kind: "control" }), /cannot connect to itself/)
  assert.throws(() => appendTaskPlanEdge(source, { source: "artifact", target: "context", kind: "control" }), /create a cycle/)
  assert.throws(() => appendTaskPlanEdge(
    { ...source, edges: [] },
    { source: "context", target: "artifact", kind: "control", label: "é".repeat(201) },
  ), /at most 200 characters/)
  assert.throws(() => appendTaskPlanEdge(
    { ...source, edges: [] },
    { source: "context", target: "artifact", kind: "control" },
    () => "bad id with spaces",
  ), /unique connection identifier/)
  assert.throws(() => appendTaskPlanEdge(
    source,
    { source: "context", target: "artifact", kind: "data" },
    () => "context-artifact",
  ), /unique connection identifier/)
})

test("shared connection helper enforces the 512-edge boundary", () => {
  const nodes = Array.from({ length: 128 }, (_, index) => ({
    id: `node-${index}`,
    kind: "context",
    title: `Node ${index}`,
    goal: "",
    position: { x: index, y: 0 },
    config: {},
  }))
  const pairs = []
  for (let source = 0; source < nodes.length && pairs.length < 512; source += 1) {
    for (let target = source + 1; target < nodes.length && pairs.length < 512; target += 1) {
      pairs.push([source, target])
    }
  }
  const bounded = {
    ...plan(),
    nodes,
    edges: pairs.slice(0, 511).map(([source, target], index) => ({
      id: `edge-${index}`,
      source: `node-${source}`,
      target: `node-${target}`,
      kind: "control",
    })),
  }
  const [source, target] = pairs[511]
  const full = appendTaskPlanEdge(
    bounded,
    { source: `node-${source}`, target: `node-${target}`, kind: "control" },
    () => "edge-511",
  )
  assert.equal(full.edges.length, 512)
  assert.equal(bounded.edges.length, 511)
  assert.throws(() => appendTaskPlanEdge(
    full,
    { source: "node-0", target: "node-127", kind: "control" },
  ), /at most 512 connections/)
})

test("proposal preview applies exact-base additive operations to a detached plan", async () => {
  const record = savedRecord()
  const before = JSON.stringify(record)
  const preview = await previewTaskPlanProposal(record, proposal())

  assert.equal(JSON.stringify(record), before)
  assert.deepEqual(Array.from(preview.addedNodeIds), ["challenge-proposal"])
  assert.deepEqual(Array.from(preview.addedEdgeIds), ["proposal-edge"])
  assert.equal(preview.spec.nodes.at(-1).id, "challenge-proposal")
  assert.equal(preview.spec.edges.at(-1).id, "proposal-edge")
  assert.notEqual(preview.spec, record.current_spec)
  assert.notEqual(preview.spec.nodes[0], record.current_spec.nodes[0])
  assert.notEqual(preview.spec.nodes.at(-1), proposal().operations[0].node)
  preview.spec.nodes[0].position.x = 999
  assert.equal(record.current_spec.nodes[0].position.x, 0)
})

test("proposal preview cryptographically binds every authoritative candidate field", async () => {
  const record = savedRecord()
  const altered = proposal()
  altered.requestHash = `sha256:${"d".repeat(64)}`
  await assert.rejects(previewTaskPlanProposal(record, altered), /content does not match its proposal hash/)

  const arbitraryHash = proposal()
  arbitraryHash.proposalHash = `sha256:${"e".repeat(64)}`
  await assert.rejects(previewTaskPlanProposal(record, arbitraryHash), /content does not match its proposal hash/)
})

test("verified proposal identity survives in-place mutation of the source candidate", async () => {
  const record = savedRecord()
  const candidate = bindProposalHash(proposal())
  const verifiedHash = candidate.proposalHash
  const pending = previewTaskPlanProposal(record, candidate)
  candidate.proposalHash = `sha256:${"f".repeat(64)}`

  const preview = await pending
  assert.equal(preview.proposalHash, verifiedHash)
  assert.notEqual(preview.proposalHash, candidate.proposalHash)
})

test("proposal preview rejects every stale or mismatched authority base", async () => {
  const record = savedRecord()
  const baseMismatches = [
    { taskPlanId: "123e4567-e89b-42d3-a456-426614174099" },
    { taskPlanVersion: 4 },
    { taskPlanContentHash: "d".repeat(64) },
    { hamTaskId: "task-2" },
    { hamTaskVersion: 8 },
  ]
  for (const mismatch of baseMismatches) {
    const candidate = proposal()
    candidate.base = { ...candidate.base, ...mismatch }
    await assert.rejects(previewTaskPlanProposal(record, candidate), /different or stale/)
  }
})

test("proposal preview rejects authority, collisions, dangling edges, cycles, and graph caps", async () => {
  const record = savedRecord()
  const authority = proposal()
  authority.operations = authority.operations.map((operation, index) => index === 0
    ? { ...operation, node: { ...operation.node, config: { outputRefs: ["gb:node:x"] } } }
    : operation)
  await assert.rejects(previewTaskPlanProposal(record, authority), /execution or output authority/)

  const collision = proposal()
  collision.operations = collision.operations.map((operation, index) => index === 0
    ? { ...operation, node: { ...operation.node, id: "context" } }
    : operation)
  await assert.rejects(previewTaskPlanProposal(record, collision), /colliding job identifier/)

  const dangling = proposal()
  dangling.operations = dangling.operations.map((operation, index) => index === 1
    ? { ...operation, edge: { ...operation.edge, target: "missing" } }
    : operation)
  await assert.rejects(previewTaskPlanProposal(record, dangling), /still exist/)

  const cyclic = proposal({
    operations: [
      proposal().operations[0],
      { op: "edge.add", edge: { id: "proposal-edge-in", source: "artifact", target: "challenge-proposal", kind: "control" } },
      { op: "edge.add", edge: { id: "proposal-edge-out", source: "challenge-proposal", target: "context", kind: "control" } },
    ],
  })
  await assert.rejects(previewTaskPlanProposal(record, cyclic), /create a cycle/)

  const fullRecord = savedRecord()
  fullRecord.current_spec = {
    ...fullRecord.current_spec,
    nodes: Array.from({ length: 128 }, (_, index) => ({
      id: `node-${index}`,
      kind: "context",
      title: `Node ${index}`,
      goal: "",
      position: { x: index, y: 0 },
      config: {},
    })),
    edges: [],
  }
  const fullProposal = proposal({ sourceJobIds: ["node-0"] })
  await assert.rejects(previewTaskPlanProposal(fullRecord, fullProposal), /at most 128 jobs/)
})

test("proposal preview requires canonical pinned references and an exact ordered operation union", async () => {
  const record = savedRecord()
  const first = pinnedReference(1)
  const second = pinnedReference(2)
  const withRefs = proposal({ inputRefs: [first, second] })
  withRefs.operations = withRefs.operations.map((operation, index) => index === 0
    ? { ...operation, node: { ...operation.node, config: { ...operation.node.config, inputRefs: [first, second] } } }
    : operation)
  assert.deepEqual(Array.from((await previewTaskPlanProposal(record, bindProposalHash(withRefs))).addedNodeIds), ["challenge-proposal"])

  const unpinned = createGalaxyObjectReference("document", "latest-document")
  await assert.rejects(previewTaskPlanProposal(record, proposal({ inputRefs: [unpinned] })), /canonical pinned/)
  await assert.rejects(previewTaskPlanProposal(record, proposal({ inputRefs: ["gb:object:v1:document:bad%2fencoding:pinned:v1"] })), /canonical pinned/)
  await assert.rejects(previewTaskPlanProposal(record, proposal({ inputRefs: [first, first] })), /duplicate reference/)

  const missingFromOperations = proposal({ inputRefs: [first] })
  await assert.rejects(previewTaskPlanProposal(record, missingFromOperations), /do not match its additive operations/)

  const wrongOrder = proposal({ inputRefs: [first, second] })
  wrongOrder.operations = wrongOrder.operations.map((operation, index) => index === 0
    ? { ...operation, node: { ...operation.node, config: { inputRefs: [second, first] } } }
    : operation)
  await assert.rejects(previewTaskPlanProposal(record, wrongOrder), /do not match its additive operations/)

  const duplicateInOperation = proposal({ inputRefs: [first] })
  duplicateInOperation.operations = duplicateInOperation.operations.map((operation, index) => index === 0
    ? { ...operation, node: { ...operation.node, config: { inputRefs: [first, first] } } }
    : operation)
  await assert.rejects(previewTaskPlanProposal(record, duplicateInOperation), /duplicate reference/)
})

test("proposal preview enforces the aggregate 64-reference and final 512 KiB plan bounds", async () => {
  const record = savedRecord()
  const splitRefs = Array.from({ length: 65 }, (_, index) => pinnedReference(index + 10))
  const split = proposal({
    inputRefs: splitRefs.slice(0, 64),
    operations: [
      {
        op: "node.add",
        node: {
          ...proposal().operations[0].node,
          id: "split-first",
          config: { inputRefs: splitRefs.slice(0, 32) },
        },
      },
      {
        op: "node.add",
        node: {
          ...proposal().operations[0].node,
          id: "split-second",
          config: { inputRefs: splitRefs.slice(32) },
        },
      },
      { op: "edge.add", edge: { id: "split-edge", source: "context", target: "split-first", kind: "evidence" } },
    ],
  })
  await assert.rejects(previewTaskPlanProposal(record, split), /at most 64 distinct input references/)

  const largeRecord = savedRecord()
  largeRecord.current_spec = {
    ...largeRecord.current_spec,
    nodes: largeRecord.current_spec.nodes.map((node) => ({
      ...node,
      config: { instruction: "b".repeat(20_000) },
    })),
  }
  const longRefs = Array.from({ length: 64 }, (_, index) => pinnedReference(index + 100, `document-${"x".repeat(380)}`))
  assert.equal(longRefs.every((reference) => Array.from(reference).length <= 500), true)
  const primaryNode = {
    id: "large-branch",
    kind: "branch",
    title: "p".repeat(200),
    goal: "g".repeat(4_000),
    position: { x: 300, y: 200 },
    config: { instruction: "i".repeat(20_000), inputRefs: longRefs },
  }
  const oversizedOperations = [
    { op: "node.add", node: primaryNode },
    { op: "edge.add", edge: { id: "large-incoming", source: "context", target: primaryNode.id, kind: "control" } },
    ...Array.from({ length: 8 }, (_, index) => [
      {
        op: "node.add",
        node: {
          id: `large-arm-${index}`,
          kind: "challenge",
          title: "a".repeat(200),
          goal: "g".repeat(4_000),
          position: { x: 600, y: index * 120 },
          config: { instruction: "i".repeat(20_000), inputRefs: longRefs },
        },
      },
      {
        op: "edge.add",
        edge: { id: `large-arm-edge-${index}`, source: primaryNode.id, target: `large-arm-${index}`, kind: "branch" },
      },
    ]).flat(),
  ]
  const oversized = proposal({
    action: "branch",
    sourceJobIds: ["context"],
    inputRefs: longRefs,
    operations: oversizedOperations,
  })
  await assert.rejects(previewTaskPlanProposal(largeRecord, oversized), /exceeds the 512 KiB plan limit/)
})

test("proposal preview rejects non-normalized summaries, source IDs, and operation shapes", async () => {
  const record = savedRecord()
  await assert.rejects(previewTaskPlanProposal(record, proposal({ summary: " padded " })), /summary is invalid/)
  await assert.rejects(previewTaskPlanProposal(record, proposal({ sourceJobIds: ["bad source"] })), /sources do not match/)
  const extraOperationKey = proposal()
  extraOperationKey.operations = extraOperationKey.operations.map((operation, index) => index === 0
    ? { ...operation, unexpected: true }
    : operation)
  await assert.rejects(previewTaskPlanProposal(record, extraOperationKey), /only additive operations/)

  const mismatchedSource = proposal({ sourceJobIds: ["artifact"] })
  await assert.rejects(previewTaskPlanProposal(record, mismatchedSource), /source connections do not match/)

  for (const nodePatch of [
    { title: " padded " },
    { goal: "" },
    { position: { x: 1.5, y: 2 } },
    { config: { instruction: " padded " } },
    { config: { inputRefs: [] } },
  ]) {
    const malformedNode = proposal()
    malformedNode.operations = malformedNode.operations.map((operation, index) => index === 0
      ? { ...operation, node: { ...operation.node, ...nodePatch } }
      : operation)
    await assert.rejects(previewTaskPlanProposal(record, malformedNode), /proposal contains|Proposal job/)
  }

  const labelledEdge = proposal()
  labelledEdge.operations = labelledEdge.operations.map((operation, index) => index === 1
    ? { ...operation, edge: { ...operation.edge, label: "not produced" } }
    : operation)
  await assert.rejects(previewTaskPlanProposal(record, labelledEdge), /invalid connection payload/)
})

test("constructor close policy waits for saves and confirms dirty drafts", () => {
  assert.equal(getTaskConstructorCloseDecision({ dirty: false, saving: false }), "close")
  assert.equal(getTaskConstructorCloseDecision({ dirty: true, saving: false }), "confirm")
  assert.equal(getTaskConstructorCloseDecision({ dirty: false, saving: false, candidatePending: true }), "confirm")
  assert.equal(getTaskConstructorCloseDecision({ dirty: false, saving: true }), "wait")
  assert.equal(getTaskConstructorCloseDecision({ dirty: true, saving: true, candidatePending: true }), "wait")
  assert.equal(getTaskConstructorCloseDecision({ dirty: false, saving: false, runMutating: true }), "wait")
})

test("task constructor exposes every approved job kind", async () => {
  const constructor = await readFile(new URL("../components/tasks/task-constructor.tsx", import.meta.url), "utf8")
  const toolbar = constructor.match(/const toolbarKinds:[\s\S]*?\n\]/)?.[0] || ""
  for (const kind of ["context", "research", "transform", "compare", "challenge", "synthesize", "branch", "join", "checkpoint", "artifact"]) {
    assert.match(toolbar, new RegExp(`"${kind}"`))
  }
})

test("task constructor uses the shared theme and one accessible graph focus model", async () => {
  const constructor = await readFile(new URL("../components/tasks/task-constructor.tsx", import.meta.url), "utf8")
  const dialog = await readFile(new URL("../components/tasks/task-constructor-dialog.tsx", import.meta.url), "utf8")
  const preview = await readFile(new URL("../app/dev/task-constructor-preview/page.tsx", import.meta.url), "utf8")
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8")
  const flowNodes = constructor.slice(
    constructor.indexOf("function toFlowNodes"),
    constructor.indexOf("function toFlowEdges"),
  )

  assert.match(styles, /\.task-constructor \{/u)
  assert.match(styles, /\.dark \.task-constructor \{/u)
  assert.match(styles, /\.task-constructor__node\[data-selected="true"\]/u)
  assert.match(styles, /\.task-constructor \.react-flow__edge\.animated path[\s\S]*?animation: none !important/u)
  assert.match(styles, /\.task-constructor-dialog \*,/u)
  assert.match(constructor, /"task-constructor research-workbench/u)
  assert.match(constructor, /function motionDuration\(duration: number\)/u)
  assert.match(constructor, /duration: motionDuration\(250\)/u)
  assert.match(constructor, /nodesFocusable=\{false\}/u)
  assert.doesNotMatch(flowNodes, /ariaLabel/u)
  assert.match(constructor, /aria-pressed=\{selected\}/u)
  assert.match(constructor, /aria-pressed=\{node\.id === selectedNode\.id\}/u)
  assert.match(constructor, /ariaLabel: `\$\{edge\.kind\} connection from/u)
  assert.match(constructor, /research-display mt-1 break-words/u)
  assert.match(constructor, /xl:max-h-\[720px\] xl:overflow-y-auto/u)
  assert.doesNotMatch(constructor, /#[0-9a-f]{3,8}|rgba?\(/iu)

  assert.match(dialog, /className="task-constructor-dialog/u)
  assert.match(preview, /devPreviewsEnabled\(\)/u)
  assert.match(preview, /notFound\(\)/u)
  assert.match(preview, /<TaskConstructor task=\{previewTask\} mode="preview"/u)
  assert.doesNotMatch(preview, /fetch\(|galaxyBrainAPI/u)
})

test("task constructor exposes a labelled keyboard connection form backed by the shared helper", async () => {
  const constructor = await readFile(new URL("../components/tasks/task-constructor.tsx", import.meta.url), "utf8")
  assert.match(constructor, /appendTaskPlanEdge\(spec/)
  assert.match(constructor, />From job</)
  assert.match(constructor, />To job</)
  assert.match(constructor, />Connection kind</)
  assert.match(constructor, />Add connection</)
  assert.match(constructor, /dirty: dirty \|\| connectionDraftDirty/)
  assert.match(constructor, /setConnectionDraftDirty\(true\)/)
  assert.match(constructor, /taskPlanNodeOptionLabel\(node, index\)/)
  assert.match(constructor, /onConnect={onConnect}/)
  assert.match(constructor, /onSubmit=/)
})

test("task constructor reviews proposals without adding a second durable write path", async () => {
  const constructor = await readFile(new URL("../components/tasks/task-constructor.tsx", import.meta.url), "utf8")
  const preview = await readFile(new URL("../components/tasks/task-plan-proposal-preview.tsx", import.meta.url), "utf8")
  assert.match(source, /export async function previewTaskPlanProposal/)
  assert.doesNotMatch(source, /export function buildTaskPlanProposalPreview/)
  assert.match(source, /globalThis\.crypto\.subtle\.digest\("SHA-256"/)
  assert.match(constructor, /previewTaskPlanProposal\(baseline, candidate\)/)
  assert.match(constructor, /proposalVerificationGuard\.begin\(\)/)
  assert.match(constructor, /proposalVerificationGuard\.isLatest\(request\)/)
  assert.match(constructor, /proposalHash: preview\.proposalHash, status: "verified"/)
  assert.match(constructor, /proposalVerification\.candidate !== visibleProposal/)
  assert.match(constructor, /activeProposalCandidate !== visibleProposal/)
  assert.match(constructor, /const activeProposalCandidate = proposalCandidate \?\? generatedProposal/)
  assert.match(constructor, /markChanged\(nextSpec\)/)
  assert.match(constructor, /outcome: "dismissed"/)
  assert.match(constructor, /acknowledgeDismissal\(proposalVerification\.proposalHash\)/)
  assert.match(constructor, /acknowledgeDismissal\(preview\.proposalHash\)/)
  assert.doesNotMatch(constructor, /const candidateHash = candidate\.proposalHash[\s\S]{0,400}outcome: "dismissed"/)
  assert.match(constructor, /outcome: "applied"/)
  assert.match(constructor, /candidatePending: visibleProposal !== null/)
  assert.match(constructor, /activeProposalCandidate\?\.base\.hamTaskId === task\.id/)
  assert.match(constructor, /activeProposalCandidate\.base\.hamTaskVersion === task\.version/)
  assert.match(constructor, /proposalCandidate === visibleProposal\) onProposalDecision/)
  assert.match(constructor, /Candidate applied to the local browser draft\. Save revision to make it durable; nothing was executed\./)
  assert.equal(constructor.match(/galaxyBrainAPI\.(?:createTaskPlan|updateTaskPlan)/g)?.length, 2)
  assert.match(preview, / Dismiss/)
  assert.match(preview, / Apply to local draft/)
  assert.match(preview, /verificationState === "verified"/)
  assert.match(preview, /role="status" aria-live="polite" aria-atomic="true"/)
  assert.match(preview, /task-constructor__candidate/)
  assert.match(preview, /You can dismiss it now/)
  assert.match(preview, /creates no HAM task, and asserts no Galaxy semantic relation/)
  assert.doesNotMatch(preview, /fetch\(|galaxyBrainAPI|node:crypto/)
})

test("constructor dialog guards dirty dismissal and has explicit focus fallbacks", async () => {
  const dialog = await readFile(new URL("../components/tasks/task-constructor-dialog.tsx", import.meta.url), "utf8")
  const queue = await readFile(new URL("../components/tasks/task-queue-view.tsx", import.meta.url), "utf8")
  const atlas = await readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8")
  const presenterHost = await readFile(new URL("../components/atlas/atlas-command-presenter-host.tsx", import.meta.url), "utf8")
  assert.match(dialog, /getTaskConstructorCloseDecision\(interactionState\)/)
  assert.match(dialog, /Discard unsaved task-plan work\?/)
  assert.match(dialog, /proposalCandidate=\{proposalCandidate\}/)
  assert.match(dialog, /candidatePending: false/)
  assert.match(dialog, /runMutating: false/)
  assert.match(dialog, /interactionState\.verifiedCandidate === proposalCandidate/)
  assert.match(dialog, /interactionState\.verifiedTaskId === task\?\.id/)
  assert.match(dialog, /proposalHash: interactionState\.verifiedProposalHash/)
  assert.doesNotMatch(dialog, /proposalHash: proposalCandidate\.proposalHash/)
  assert.match(dialog, /outcome: "dismissed"/)
  assert.match(dialog, /Keep editing/)
  assert.match(dialog, /Discard work/)
  assert.match(dialog, /focusFirstAvailable\(\[returnFocus, fallbackFocus\]/)
  assert.match(queue, /fallbackFocus={queueHeadingRef\.current}/)
  assert.match(atlas, /task=\{\{[\s\S]*returnFocus: constructorReturnFocus/)
  assert.match(presenterHost, /<TaskConstructorDialog \{\.\.\.task\} fallbackFocus=\{fallbackFocus\}/)
})

test("draft guard distinguishes current acknowledgements from newer edits", () => {
  const guard = createTaskPlanDraftGuard("live:task-1:version-1")
  const load = guard.capture("live:task-1:version-1")
  assert.equal(guard.isCurrent(load), true)
  assert.equal(guard.isContextCurrent(load), true)

  guard.edit("live:task-1:version-1")
  assert.equal(guard.isCurrent(load), false)
  assert.equal(guard.isContextCurrent(load), true)

  const save = guard.capture("live:task-1:version-1")
  assert.equal(guard.isCurrent(save), true)
  guard.edit("live:task-1:version-1")
  assert.equal(guard.isCurrent(save), false)
})

test("draft guard invalidates old load and save tokens across task switches", () => {
  const guard = createTaskPlanDraftGuard("live:task-1:version-1")
  const firstTask = guard.capture("live:task-1:version-1")
  const secondTask = guard.enter("live:task-2:version-1")
  assert.equal(guard.isCurrent(firstTask), false)
  assert.equal(guard.isContextCurrent(firstTask), false)
  assert.equal(guard.isCurrent(secondTask), true)
  assert.throws(
    () => guard.edit("live:task-1:version-1"),
    /context changed before the edit/,
  )
})

test("ledger guard ignores an older request that settles after the latest request", async () => {
  const guard = createTaskPlanLatestRequestGuard()
  let resolveOlder
  let resolveLatest
  const older = new Promise((resolve) => { resolveOlder = resolve })
  const latest = new Promise((resolve) => { resolveLatest = resolve })
  let visible = []
  const olderRequest = guard.begin()
  const olderApply = older.then((value) => {
    if (guard.isLatest(olderRequest)) visible = value
  })
  const latestRequest = guard.begin()
  const latestApply = latest.then((value) => {
    if (guard.isLatest(latestRequest)) visible = value
  })

  resolveLatest(["revision-2"])
  await latestApply
  resolveOlder(["revision-1"])
  await olderApply

  assert.deepEqual(visible, ["revision-2"])
})

test("proposal verification guard cannot enable an older candidate after a switch", async () => {
  const guard = createTaskPlanLatestRequestGuard()
  let resolveOlder
  let resolveLatest
  const older = new Promise((resolve) => { resolveOlder = resolve })
  const latest = new Promise((resolve) => { resolveLatest = resolve })
  let applyEnabledFor = null
  const olderRequest = guard.begin()
  const olderCompletion = older.then((candidate) => {
    if (guard.isLatest(olderRequest)) applyEnabledFor = candidate
  })
  const latestRequest = guard.begin()
  const latestCompletion = latest.then((candidate) => {
    if (guard.isLatest(latestRequest)) applyEnabledFor = candidate
  })

  resolveLatest("candidate-2")
  await latestCompletion
  resolveOlder("candidate-1")
  await olderCompletion

  assert.equal(applyEnabledFor, "candidate-2")
})

test("task constructor wires the draft guard through load, write, and ledger refresh", async () => {
  const constructor = await readFile(new URL("../components/tasks/task-constructor.tsx", import.meta.url), "utf8")
  assert.match(constructor, /const loadToken = draftGuard\.capture\(taskContext\)/)
  assert.match(constructor, /draftGuard\.isCurrent\(loadToken\)/)
  assert.match(constructor, /const saveToken = draftGuard\.capture\(taskContext\)/)
  assert.match(constructor, /const submittedSpec = spec/)
  assert.match(constructor, /const submittedTitle = title/)
  assert.match(constructor, /Saved plan revision \$\{nextRecord\.current_version\}; newer changes remain unsaved\./)
  assert.match(constructor, /const refreshRevisionLedger = useCallback/)
  assert.match(constructor, /setLoading\(false\)\s+refreshRevisionLedger\(nextRecord\)/)
  assert.match(constructor, /setSaving\(false\)\s+refreshRevisionLedger\(nextRecord\)/)
  assert.match(constructor, /activeSaveRef\.current !== 0/)
  assert.match(constructor, /setStatus\("Unsaved plan changes\."\)/)
  assert.match(constructor, /nodesDraggable={!loading}/)
  assert.match(constructor, /nodesConnectable={!loading}/)
  assert.match(constructor, /disabled={loading}/)
  assert.match(constructor, /Number\.isSafeInteger\(task\.version\)/)
  assert.match(constructor, /disabled={!hasPinnedTaskVersion \|\| Boolean\(writeResolution\) \|\| loading \|\| saving/)
  assert.match(constructor, /const replayed = nextRecord\.replayed === true/)
  assert.match(constructor, /if \(!replayed && draftGuard\.isCurrent\(saveToken\)\)/)
  assert.match(constructor, /setWriteResolution\(\{ kind: "replay", record: nextRecord \}\)/)
  assert.match(constructor, /setWriteResolution\(\{ kind: "conflict", record: latestRecord \}\)/)
  assert.match(constructor, /Load remote revision/)
  assert.match(constructor, /disabled={saving \|\| activeSaveRef\.current !== 0}/)
  assert.match(constructor, /Retry remote plan/)
  assert.doesNotMatch(constructor, /draftGuard\.enter\(taskContext\)/)
  assert.match(constructor, /spec\.task\.id === task\.id/)
  assert.match(constructor, /nextError instanceof GalaxyBrainAPIError && nextError\.status === 409/)
  assert.match(constructor, /const latestRecord = await galaxyBrainAPI\.getTaskPlanForHamTask\(task\.id\)/)
  assert.match(constructor, /Plan conflict detected\. Load the authoritative plan explicitly to continue saving\./)
})
