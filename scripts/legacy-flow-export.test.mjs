import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"

const source = await readFile(new URL("../lib/legacy-flow-export.ts", import.meta.url), "utf8")
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const sandbox = { exports: {}, TextEncoder, Date, Object, Set, JSON }
vm.runInNewContext(compiled, sandbox)

const {
  createLegacyFlowExport,
  createLegacyFlowExportFromStorage,
  formatLegacyFlowOptionLabel,
  parseLegacyFlowExport,
  readLegacyFlowStorage,
  LEGACY_FLOW_EXPORT_SCHEMA,
  LEGACY_FLOW_STORAGE_KEY,
} = sandbox.exports

function storageReturning(value) {
  return {
    getItem(key) {
      assert.equal(key, LEGACY_FLOW_STORAGE_KEY)
      return value
    },
  }
}

function flow(overrides = {}) {
  return {
    id: "flow-1",
    name: "Evidence review",
    description: "Compare the evidence.",
    nodes: [
      {
        id: "prompt",
        type: "promptNode",
        position: { x: 10, y: 20 },
        data: { label: "Question", content: "What follows?" },
      },
      {
        id: "model",
        type: "aiNode",
        position: { x: 200, y: 20 },
        data: { label: "Model", model: "provider/model" },
      },
    ],
    edges: [{ id: "prompt-model", source: "prompt", target: "model", type: "smoothstep", label: "then" }],
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-02T00:00:00.000Z"),
    version: 2,
    isPublic: false,
    isTemplate: false,
    tags: ["research", "evidence"],
    owner: "current-user",
    collaborators: [],
    ...overrides,
  }
}

test("export is versioned, deterministic, and round-trips through its parser", () => {
  const first = createLegacyFlowExport([
    flow({ id: "z-flow", tags: ["z", "a"] }),
    flow({ id: "a-flow", nodes: [...flow().nodes].reverse() }),
  ])
  const second = createLegacyFlowExport([
    flow({ id: "a-flow" }),
    flow({ id: "z-flow", tags: ["a", "z"], nodes: [...flow().nodes].reverse() }),
  ])

  assert.ok(first.bundle)
  assert.equal(first.bundle.schema, LEGACY_FLOW_EXPORT_SCHEMA)
  assert.equal(first.json, second.json)
  assert.deepEqual(Array.from(first.bundle.flows, (item) => item.id), ["a-flow", "z-flow"])
  assert.deepEqual(Array.from(first.bundle.flows[1].tags), ["a", "z"])

  const parsed = parseLegacyFlowExport(first.json)
  assert.ok(parsed.bundle)
  assert.equal(parsed.json, first.json)
})

test("duplicate flow names retain stable, non-sensitive option labels", () => {
  const result = createLegacyFlowExport([
    flow({ id: "evidence-a", name: "Evidence review", version: 2 }),
    flow({ id: "evidence-b", name: "Evidence review", version: 7 }),
  ])

  assert.ok(result.bundle)
  const labels = Array.from(result.bundle.flows, formatLegacyFlowOptionLabel)
  assert.deepEqual(labels, [
    "Evidence review · v2 · evidence-a",
    "Evidence review · v7 · evidence-b",
  ])
  assert.equal(new Set(labels).size, result.bundle.flows.length)
  for (const label of labels) {
    assert.ok(!label.includes("owner@example.test"))
    assert.ok(!label.includes("credential"))
  }
})

test("export excludes credentials, sharing identity, arbitrary data, and logs", () => {
  const result = createLegacyFlowExport([flow({
    owner: "owner@example.test",
    collaborators: ["secret-collaborator"],
    isPublic: true,
    nodes: [
      {
        id: "prompt",
        type: "promptNode",
        position: { x: 10, y: 20 },
        data: {
          label: "Question",
          content: "Safe instruction",
          apiKey: "sk-export-must-not-leak",
          credential: "credential-must-not-leak",
          token: "token-must-not-leak",
          chatLog: "chat-log-must-not-leak",
        },
      },
    ],
    edges: [{
      id: "self",
      source: "prompt",
      target: "prompt",
      data: { password: "password-must-not-leak" },
      animated: true,
    }],
  })])

  assert.ok(result.json)
  for (const secret of [
    "owner@example.test",
    "secret-collaborator",
    "sk-export-must-not-leak",
    "credential-must-not-leak",
    "token-must-not-leak",
    "chat-log-must-not-leak",
    "password-must-not-leak",
  ]) {
    assert.ok(!result.json.includes(secret), `export leaked ${secret}`)
  }
  assert.ok(result.diagnostics.some((item) => item.code === "omitted-flow-metadata"))
  assert.ok(result.diagnostics.some((item) => item.code === "omitted-node-data"))
  assert.ok(result.diagnostics.some((item) => item.code === "omitted-edge-data"))
})

test("malformed and over-limit flow state fails closed without partial output", () => {
  for (const flows of [
    null,
    [flow({ nodes: null })],
    [flow({ nodes: [{ id: "node", type: "promptNode", position: { x: Number.NaN, y: 0 }, data: {} }] })],
    [flow({ nodes: Array.from({ length: 129 }, (_, index) => ({ id: `node-${index}`, type: "outputNode", position: { x: index, y: 0 }, data: {} })), edges: [] })],
    [flow({ edges: [{ id: "dangling", source: "prompt", target: "missing" }] })],
    [flow({ edges: [{ source: "prompt", target: "model" }] })],
    [flow({ createdAt: "September 1, 2026" })],
  ]) {
    const result = createLegacyFlowExport(flows)
    assert.equal(result.bundle, null)
    assert.equal(result.json, null)
    assert.ok(result.diagnostics.some((item) => item.level === "error"))
  }

  const tooMany = createLegacyFlowExport(Array.from({ length: 257 }, (_, index) => flow({ id: `flow-${index}` })))
  assert.equal(tooMany.bundle, null)
  assert.ok(tooMany.diagnostics.some((item) => item.code === "flow-limit"))

  const tooLarge = createLegacyFlowExport(Array.from({ length: 110 }, (_, index) => flow({
    id: `large-${index}`,
    description: "x".repeat(20_000),
  })))
  assert.equal(tooLarge.bundle, null)
  assert.ok(tooLarge.diagnostics.some((item) => item.code === "export-size"))
})

test("aggregate budget rejects max-count max-prompt input before visiting the tail", () => {
  const nodes = Array.from({ length: 128 }, (_, index) => ({
    id: `prompt-${index}`,
    type: "promptNode",
    position: { x: index, y: 0 },
    data: { label: `Prompt ${index}`, content: "p".repeat(20_000) },
  }))
  Object.defineProperty(nodes, 120, {
    get() {
      throw new Error("normalization read past the incremental budget")
    },
  })

  let result
  assert.doesNotThrow(() => {
    result = createLegacyFlowExport([flow({ nodes, edges: [] })])
  })
  assert.equal(result.bundle, null)
  assert.equal(result.json, null)
  assert.ok(result.diagnostics.some((item) => item.code === "export-size"))
})

test("duplicate identities and oversized semantic fields are rejected", () => {
  const duplicateNode = flow({
    nodes: [
      { id: "same", type: "outputNode", position: { x: 0, y: 0 }, data: {} },
      { id: "same", type: "outputNode", position: { x: 10, y: 0 }, data: {} },
    ],
    edges: [],
  })
  const duplicate = createLegacyFlowExport([duplicateNode])
  assert.equal(duplicate.bundle, null)
  assert.ok(duplicate.diagnostics.some((item) => item.code === "duplicate-node"))

  const oversized = createLegacyFlowExport([flow({ description: "x".repeat(20_001) })])
  assert.equal(oversized.bundle, null)
  assert.ok(oversized.diagnostics.some((item) => item.code === "invalid-flow"))
})

test("prototype-named node types cannot select inherited export field tables", () => {
  for (const type of ["__proto__", "constructor", "toString"]) {
    const result = createLegacyFlowExport([flow({
      nodes: [{
        id: `prototype-${type}`,
        type,
        position: { x: 0, y: 0 },
        data: { label: "Portable label", apiKey: "never-export-this" },
      }],
      edges: [],
    })])
    assert.ok(result.bundle)
    assert.deepEqual(JSON.parse(JSON.stringify(result.bundle.flows[0].nodes[0].data)), { label: "Portable label" })
    assert.ok(!result.json.includes("never-export-this"))
  }
})

test("parser rejects malformed, oversized, and wrong-schema input", () => {
  for (const json of [
    "not json",
    JSON.stringify({ schema: "gb.legacy-flow-export.v0", flows: [] }),
    "x".repeat((2 * 1024 * 1024) + 1),
  ]) {
    const result = parseLegacyFlowExport(json)
    assert.equal(result.bundle, null)
    assert.equal(result.json, null)
    assert.ok(result.diagnostics.some((item) => item.level === "error"))
  }
})

test("storage read distinguishes missing, corrupt, wrong-shape, denied, and unsafe records", () => {
  const missing = readLegacyFlowStorage(storageReturning(null))
  assert.deepEqual(JSON.parse(JSON.stringify(missing)), { ok: true, state: "missing", flows: [] })
  const emptyExport = createLegacyFlowExportFromStorage(storageReturning(null))
  assert.ok(emptyExport.bundle)
  assert.deepEqual(Array.from(emptyExport.bundle.flows), [])

  for (const [storage, code] of [
    [storageReturning("{"), "storage-json"],
    [storageReturning(JSON.stringify({ flow: [] })), "storage-shape"],
    [{ getItem() { throw new Error("denied") } }, "storage-access"],
  ]) {
    const read = readLegacyFlowStorage(storage)
    assert.equal(read.ok, false)
    assert.equal(read.code, code)
    const result = createLegacyFlowExportFromStorage(storage)
    assert.equal(result.bundle, null)
    assert.equal(result.json, null)
    assert.ok(result.diagnostics.some((item) => item.code === code))
  }

  const unsafe = createLegacyFlowExportFromStorage(storageReturning(JSON.stringify([{ id: "unsafe" }])))
  assert.equal(unsafe.bundle, null)
  assert.equal(unsafe.json, null)
  assert.ok(unsafe.diagnostics.some((item) => item.code === "invalid-flow"))
})

test("editor exposes explicit read-only export and raw service export is gone", async () => {
  const [editor, exporter, service, ledger] = await Promise.all([
    readFile(new URL("../components/flow-editor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/flow-export.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/flow-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../docs/LEGACY_RETIREMENT.md", import.meta.url), "utf8"),
  ])
  assert.match(editor, /<FlowExport \/>/)
  assert.match(exporter, /createLegacyFlowExportFromStorage\(safeLocalStorage\(\)\)/)
  assert.doesNotMatch(exporter, /flowService\.getFlows/)
  assert.doesNotMatch(exporter, /setItem|removeItem|clear\(/)
  assert.doesNotMatch(service, /exportFlow\(/)
  const failureGuard = exporter.indexOf("if (!result.bundle || !result.json)")
  const download = exporter.indexOf("URL.createObjectURL")
  const success = exporter.indexOf('title: "Local flow export downloaded"')
  assert.ok(failureGuard >= 0 && download > failureGuard && success > download)
  assert.match(exporter.slice(failureGuard, download), /return/)
  assert.match(ledger, /gb\.legacy-flow-export\.v1/)
  assert.match(ledger, /never\s+uploads, imports, clears, rewrites/)
})
