import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import vm from "node:vm"
import ts from "typescript"

const source = await readFile(new URL("../lib/legacy-flow-task-plan.ts", import.meta.url), "utf8")
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const sandbox = { exports: {}, TextEncoder }
vm.runInNewContext(compiled, sandbox)

const { createLegacyFlowDownloadName, migrateLegacyFlowToTaskPlan } = sandbox.exports

function legacyFlow(overrides = {}) {
  return {
    id: "flow-1",
    name: "Evidence summary",
    description: "Summarize the selected evidence.",
    nodes: [
      {
        id: "prompt / 1",
        type: "promptNode",
        position: { x: 100, y: 120 },
        data: { label: "Question", content: "Compare the evidence." },
      },
      {
        id: "model / 2",
        type: "aiNode",
        position: { x: 400, y: 120 },
        data: { label: "Model", model: "provider/model", temperature: 0.4 },
      },
      {
        id: "output / 3",
        type: "outputNode",
        position: { x: 700, y: 120 },
        data: { label: "Report" },
      },
    ],
    edges: [
      { id: "prompt-model", source: "prompt / 1", target: "model / 2" },
      { id: "model-output", source: "model / 2", target: "output / 3" },
    ],
    ...overrides,
  }
}

test("legacy migration deterministically maps supported nodes to a bounded task plan", () => {
  const first = migrateLegacyFlowToTaskPlan(legacyFlow(), { id: "ham:task:42", version: 3 })
  const second = migrateLegacyFlowToTaskPlan(legacyFlow({ nodes: [...legacyFlow().nodes].reverse() }), { id: "ham:task:42", version: 3 })

  assert.ok(first.plan)
  assert.equal(first.plan.schema, "gb.task-plan.v1")
  assert.deepEqual(JSON.parse(JSON.stringify(first.plan.task)), { kind: "galaxy.ham.task", id: "ham:task:42", version: 3 })
  assert.deepEqual(Array.from(first.plan.nodes, (node) => node.kind), ["transform", "artifact", "context"])
  assert.deepEqual(Array.from(first.plan.edges, (edge) => edge.kind), ["data", "data"])
  assert.equal(JSON.stringify(first.plan), JSON.stringify(second.plan))
  assert.match(first.plan.nodes.find((node) => node.kind === "transform").config.executorProfile, /^legacy-model:/)
  assert.ok(first.diagnostics.some((item) => item.code === "omitted-node-settings" && item.nodeId === "model / 2"))
})

test("unknown node types reject the whole migration instead of disappearing", () => {
  const result = migrateLegacyFlowToTaskPlan(legacyFlow({
    nodes: [...legacyFlow().nodes, { id: "custom", type: "secretPluginNode", position: { x: 0, y: 0 }, data: {} }],
  }), { id: "ham-task-1" })

  assert.equal(result.plan, null)
  assert.ok(result.diagnostics.some((item) => item.code === "unknown-node-type" && item.nodeId === "custom"))
})

test("prototype-named node types are rejected without inherited table lookups", () => {
  for (const type of ["toString", "constructor", "__proto__"]) {
    for (const data of [{}, { label: `Legacy ${type}` }]) {
      let result
      assert.doesNotThrow(() => {
        result = migrateLegacyFlowToTaskPlan(legacyFlow({
          nodes: [{ id: `prototype-${type}`, type, position: { x: 0, y: 0 }, data }],
          edges: [],
        }), { id: "ham-task-1" })
      })
      assert.equal(result.plan, null)
      assert.ok(result.diagnostics.some((item) => (
        item.code === "unknown-node-type"
        && item.nodeId === `prototype-${type}`
      )))
    }
  }
})

test("malformed imported graph entries return diagnostics instead of throwing", () => {
  const invalidNode = migrateLegacyFlowToTaskPlan(legacyFlow({ nodes: [null], edges: [] }), { id: "ham-task-1" })
  assert.equal(invalidNode.plan, null)
  assert.ok(invalidNode.diagnostics.some((item) => item.code === "invalid-node"))

  const invalidEdge = migrateLegacyFlowToTaskPlan(legacyFlow({ edges: [null] }), { id: "ham-task-1" })
  assert.equal(invalidEdge.plan, null)
  assert.ok(invalidEdge.diagnostics.some((item) => item.code === "invalid-edge"))
})

test("generated node and edge ID collisions fail closed", () => {
  const collisionA = `${"a".repeat(120)}ml4jeh4zmt`
  const collisionB = `${"a".repeat(120)}ydovaxsf21`
  const collidingNodes = migrateLegacyFlowToTaskPlan(legacyFlow({
    nodes: [
      { id: collisionA, type: "promptNode", position: { x: 0, y: 0 }, data: {} },
      { id: collisionB, type: "promptNode", position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [],
  }), { id: "ham-task-1" })
  assert.equal(collidingNodes.plan, null)
  assert.ok(collidingNodes.diagnostics.some((item) => item.code === "generated-id-collision" && item.nodeId === collisionB))

  const collidingEdges = migrateLegacyFlowToTaskPlan(legacyFlow({
    nodes: legacyFlow().nodes.slice(0, 2),
    edges: [
      { id: collisionA, source: "prompt / 1", target: "model / 2" },
      { id: collisionB, source: "prompt / 1", target: "model / 2" },
    ],
  }), { id: "ham-task-1" })
  assert.equal(collidingEdges.plan, null)
  assert.ok(collidingEdges.diagnostics.some((item) => item.code === "generated-id-collision" && item.edgeId === collisionB))
})

test("plans over the canonical UTF-8 byte limit are rejected before preview", () => {
  const result = migrateLegacyFlowToTaskPlan(legacyFlow({
    nodes: Array.from({ length: 26 }, (_, index) => ({
      id: `prompt-${index}`,
      type: "promptNode",
      position: { x: index * 20, y: 0 },
      data: { content: "🧠".repeat(5_000) },
    })),
    edges: [],
  }), { id: "ham-task-1" })

  assert.equal(result.plan, null)
  assert.ok(result.diagnostics.some((item) => item.code === "plan-size"))
})

test("prompt and description limits fail closed instead of truncating source text", () => {
  const oversizedPrompt = migrateLegacyFlowToTaskPlan(legacyFlow({
    nodes: [{ id: "prompt", type: "promptNode", position: { x: 0, y: 0 }, data: { content: "x".repeat(20_001) } }],
    edges: [],
  }), { id: "ham-task-1" })
  assert.equal(oversizedPrompt.plan, null)
  assert.ok(oversizedPrompt.diagnostics.some((item) => item.code === "prompt-too-long" && item.nodeId === "prompt"))

  const oversizedDescription = migrateLegacyFlowToTaskPlan(legacyFlow({ description: "x".repeat(20_001) }), { id: "ham-task-1" })
  assert.equal(oversizedDescription.plan, null)
  assert.ok(oversizedDescription.diagnostics.some((item) => item.code === "description-too-long"))

  const boundary = migrateLegacyFlowToTaskPlan(legacyFlow({
    description: "d".repeat(20_000),
    nodes: [{ id: "prompt", type: "promptNode", position: { x: 0, y: 0 }, data: { content: "p".repeat(20_000) } }],
    edges: [],
  }), { id: "ham-task-1" })
  assert.ok(boundary.plan)
  assert.equal(boundary.plan.goal.length, 20_000)
  assert.equal(boundary.plan.nodes[0].config.instruction.length, 20_000)

  const exactPrompt = "  preserve prompt whitespace  \n"
  const exactDescription = "  preserve description whitespace  \n"
  const preserved = migrateLegacyFlowToTaskPlan(legacyFlow({
    description: exactDescription,
    nodes: [{ id: "prompt", type: "promptNode", position: { x: 0, y: 0 }, data: { content: exactPrompt } }],
    edges: [],
  }), { id: "ham-task-1" })
  assert.ok(preserved.plan)
  assert.equal(preserved.plan.goal, exactDescription)
  assert.equal(preserved.plan.nodes[0].config.instruction, exactPrompt)

  for (const [field, flow] of [
    ["prompt", legacyFlow({
      nodes: [{ id: "prompt", type: "promptNode", position: { x: 0, y: 0 }, data: { content: ` ${"p".repeat(20_000)}` } }],
      edges: [],
    })],
    ["description", legacyFlow({ description: ` ${"d".repeat(20_000)}` })],
  ]) {
    const result = migrateLegacyFlowToTaskPlan(flow, { id: "ham-task-1" })
    assert.equal(result.plan, null)
    assert.ok(result.diagnostics.some((item) => item.code === `${field}-too-long`))
  }
})

test("memory mode is preserved in config and invalid modes are diagnosed", () => {
  const preserved = migrateLegacyFlowToTaskPlan(legacyFlow({
    nodes: [{ id: "memory", type: "memoryNode", position: { x: 0, y: 0 }, data: { type: "conversation-buffer" } }],
    edges: [],
  }), { id: "ham-task-1" })
  assert.ok(preserved.plan)
  assert.equal(preserved.plan.nodes[0].config.instruction, "Use legacy memory mode: conversation-buffer.")

  const invalid = migrateLegacyFlowToTaskPlan(legacyFlow({
    nodes: [{ id: "memory", type: "memoryNode", position: { x: 0, y: 0 }, data: { type: { mode: "buffer" } } }],
    edges: [],
  }), { id: "ham-task-1" })
  assert.equal(invalid.plan, null)
  assert.ok(invalid.diagnostics.some((item) => item.code === "unsupported-memory-mode" && item.nodeId === "memory"))
})

test("download names are safe for malformed imported flow names", () => {
  for (const malformedName of [null, undefined, 42, { title: "not a string" }]) {
    assert.equal(createLegacyFlowDownloadName(malformedName), "legacy-flow.task-plan.json")
  }
  assert.equal(createLegacyFlowDownloadName("  Evidence review / draft  "), "Evidence-review-draft.task-plan.json")

  const result = migrateLegacyFlowToTaskPlan(legacyFlow({ name: { title: "not a string" }, description: "" }), { id: "ham-task-1" })
  assert.equal(result.plan, null)
  assert.ok(result.diagnostics.some((item) => item.code === "invalid-flow-name"))
})

test("remaining bounded semantic strings are preserved or rejected without truncation", () => {
  const probes = [
    {
      flow: legacyFlow({ nodes: [{ id: "model", type: "aiNode", position: { x: 0, y: 0 }, data: { model: "m".repeat(188) } }], edges: [] }),
      code: "invalid-model-id",
    },
    {
      flow: legacyFlow({ nodes: [{ id: "model", type: "aiNode", position: { x: 0, y: 0 }, data: { model: { provider: "unsafe" } } }], edges: [] }),
      code: "invalid-model-id",
    },
    {
      flow: legacyFlow({ nodes: [{ id: "label", type: "promptNode", position: { x: 0, y: 0 }, data: { label: "l".repeat(201) } }], edges: [] }),
      code: "invalid-node-label",
    },
    {
      flow: legacyFlow({ nodes: [{ id: "label", type: "promptNode", position: { x: 0, y: 0 }, data: { label: { text: "unsafe" } } }], edges: [] }),
      code: "invalid-node-label",
    },
    {
      flow: legacyFlow({ edges: [{ id: "edge", source: "prompt / 1", target: "model / 2", label: { text: "unsafe" } }] }),
      code: "invalid-edge-label",
    },
    {
      flow: legacyFlow({ edges: [{ id: "edge", source: "prompt / 1", target: "model / 2", label: "l".repeat(201) }] }),
      code: "invalid-edge-label",
    },
    { flow: legacyFlow({ name: "n".repeat(201) }), code: "invalid-flow-name" },
  ]
  for (const probe of probes) {
    const result = migrateLegacyFlowToTaskPlan(probe.flow, { id: "ham-task-1" })
    assert.equal(result.plan, null)
    assert.ok(result.diagnostics.some((item) => item.code === probe.code), `expected ${probe.code}`)
  }

  const exactModel = "provider/model-with-exact-id"
  const exactLabel = "Exact node label"
  const exactEdgeLabel = "Exact edge label"
  const preserved = migrateLegacyFlowToTaskPlan(legacyFlow({
    nodes: [
      { id: "model", type: "aiNode", position: { x: 0, y: 0 }, data: { label: exactLabel, model: exactModel } },
      { id: "output", type: "outputNode", position: { x: 100, y: 0 }, data: {} },
    ],
    edges: [{ id: "edge", source: "model", target: "output", label: exactEdgeLabel }],
  }), { id: "ham-task-1" })
  assert.ok(preserved.plan)
  assert.equal(preserved.plan.nodes[0].title, exactLabel)
  assert.equal(preserved.plan.nodes[0].config.executorProfile, `legacy-model:${exactModel}`)
  assert.equal(preserved.plan.edges[0].label, exactEdgeLabel)
})

test("name, label, and memory fields normalize whitespace before canonical bounds", () => {
  const paddedLabel = `  ${"n".repeat(200)}  `
  const paddedEdgeLabel = `  ${"e".repeat(200)}  `
  const result = migrateLegacyFlowToTaskPlan(legacyFlow({
    name: "  Evidence summary  ",
    description: "",
    nodes: [
      { id: "memory", type: "memoryNode", position: { x: 0, y: 0 }, data: { label: paddedLabel, type: "  conversation-buffer  " } },
      { id: "output", type: "outputNode", position: { x: 100, y: 0 }, data: {} },
    ],
    edges: [{ id: "edge", source: "memory", target: "output", label: paddedEdgeLabel }],
  }), { id: "ham-task-1" })

  assert.ok(result.plan)
  assert.equal(result.plan.goal, "Migrate “Evidence summary” into an explicit, versioned task plan.")
  assert.equal(result.plan.nodes[0].title, "n".repeat(200))
  assert.equal(result.plan.nodes[0].config.instruction, "Use legacy memory mode: conversation-buffer.")
  assert.equal(result.plan.edges[0].label, "e".repeat(200))
})

test("model IDs are normalized by rejection and fit the canonical executor profile boundary", () => {
  const boundary = migrateLegacyFlowToTaskPlan(legacyFlow({
    nodes: [{ id: "model", type: "aiNode", position: { x: 0, y: 0 }, data: { model: "m".repeat(187) } }],
    edges: [],
  }), { id: "ham-task-1" })
  assert.ok(boundary.plan)
  assert.equal(boundary.plan.nodes[0].config.executorProfile.length, 200)

  for (const model of ["m".repeat(188), " provider/model", "provider/model "]) {
    const result = migrateLegacyFlowToTaskPlan(legacyFlow({
      nodes: [{ id: "model", type: "aiNode", position: { x: 0, y: 0 }, data: { model } }],
      edges: [],
    }), { id: "ham-task-1" })
    assert.equal(result.plan, null)
    assert.ok(result.diagnostics.some((item) => item.code === "invalid-model-id" && item.nodeId === "model"))
  }
})

test("top-level and semantic runtime probes return diagnostics instead of throwing", () => {
  const probes = [
    { flow: null, task: { id: "ham-task-1" }, code: "invalid-flow" },
    { flow: legacyFlow(), task: null, code: "invalid-task" },
    { flow: legacyFlow(), task: { id: null }, code: "invalid-task-reference" },
    { flow: legacyFlow({ nodes: null }), task: { id: "ham-task-1" }, code: "invalid-flow" },
    { flow: legacyFlow({ edges: null }), task: { id: "ham-task-1" }, code: "invalid-flow" },
    { flow: legacyFlow({ description: { text: "unsafe" } }), task: { id: "ham-task-1" }, code: "invalid-flow-description" },
    {
      flow: legacyFlow({ nodes: [{ id: "prompt", type: "promptNode", position: { x: 0, y: 0 }, data: { content: { text: "unsafe" } } }], edges: [] }),
      task: { id: "ham-task-1" },
      code: "invalid-prompt-content",
    },
  ]

  for (const probe of probes) {
    let result
    assert.doesNotThrow(() => {
      result = migrateLegacyFlowToTaskPlan(probe.flow, probe.task)
    })
    assert.equal(result.plan, null)
    assert.ok(result.diagnostics.some((item) => item.code === probe.code), `expected ${probe.code}`)
  }
})

test("edge settings are either diagnosed as visual or rejected as semantics", () => {
  const visual = migrateLegacyFlowToTaskPlan(legacyFlow({
    edges: [{ id: "edge", source: "prompt / 1", target: "model / 2", type: "smoothstep", animated: true }],
  }), { id: "ham-task-1" })
  assert.ok(visual.plan)
  assert.ok(visual.diagnostics.some((item) => item.code === "omitted-edge-settings" && item.edgeId === "edge"))

  for (const edge of [
    { id: "edge", source: "prompt / 1", target: "model / 2", type: "conditional" },
    { id: "edge", source: "prompt / 1", target: "model / 2", data: { when: "approved" } },
    { id: "edge", source: "prompt / 1", target: "model / 2", condition: "approved" },
  ]) {
    const result = migrateLegacyFlowToTaskPlan(legacyFlow({ edges: [edge] }), { id: "ham-task-1" })
    assert.equal(result.plan, null)
    assert.ok(result.diagnostics.some((item) => item.code === "unsupported-edge-semantics" && item.edgeId === "edge"))
  }
})

test("every node exposed by the legacy editor has an explicit migration mapping", () => {
  const types = [
    "promptNode",
    "memoryNode",
    "knowledgeNode",
    "documentParserNode",
    "vectorDatabaseNode",
    "embeddingNode",
    "chainNode",
    "aiNode",
    "mediaProcessorNode",
    "audioInputNode",
    "transcriptionNode",
    "textToSpeechNode",
    "outputNode",
  ]
  const result = migrateLegacyFlowToTaskPlan(legacyFlow({
    nodes: types.map((type, index) => ({ id: `node-${index + 1}`, type, position: { x: index * 20, y: 0 }, data: {} })),
    edges: [],
  }), { id: "ham-task-1" })

  assert.ok(result.plan)
  assert.equal(result.plan.nodes.length, types.length)
  assert.equal(result.diagnostics.filter((item) => item.level === "error").length, 0)
})

test("cycles and invalid task references fail closed", () => {
  const flow = legacyFlow({
    edges: [...legacyFlow().edges, { id: "return", source: "output / 3", target: "prompt / 1" }],
  })
  const cyclic = migrateLegacyFlowToTaskPlan(flow, { id: "ham-task-1" })
  assert.equal(cyclic.plan, null)
  assert.ok(cyclic.diagnostics.some((item) => item.code === "cyclic-graph"))

  const invalidTask = migrateLegacyFlowToTaskPlan(legacyFlow(), { id: "not a task id" })
  assert.equal(invalidTask.plan, null)
  assert.ok(invalidTask.diagnostics.some((item) => item.code === "invalid-task-reference"))

  const unsafeVersion = migrateLegacyFlowToTaskPlan(legacyFlow(), { id: "ham-task-1", version: Number.MAX_SAFE_INTEGER + 1 })
  assert.equal(unsafeVersion.plan, null)
  assert.ok(unsafeVersion.diagnostics.some((item) => item.code === "invalid-task-version"))
})

test("legacy editor exposes migration but no simulated execution action", async () => {
  const editor = await readFile(new URL("../components/flow-editor.tsx", import.meta.url), "utf8")
  assert.match(editor, /FlowTaskPlanMigration/)
  assert.match(editor, /Save local draft/)
  assert.doesNotMatch(editor, /Run Flow|Flow execution started|Flow execution completed/)
})
