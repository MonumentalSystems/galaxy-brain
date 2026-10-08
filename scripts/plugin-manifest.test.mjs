import assert from "node:assert/strict"
import test from "node:test"

import { builtinPluginRegistry } from "../lib/plugins/builtins.js"
import {
  inspectPluginManifest,
  PluginManifestValidationError,
  validatePluginManifest,
} from "../lib/plugins/manifest.js"
import {
  createPluginRegistry,
  PluginRegistryValidationError,
} from "../lib/plugins/registry.js"
import { fixturePluginPackage } from "./fixtures/fixture-plugin.mjs"

function baseManifest(overrides = {}) {
  return {
    schemaId: "galaxy-plugin.v1",
    id: "test-plugin",
    version: "1.0.0",
    contributes: {},
    connections: [],
    ...overrides,
  }
}

test("fixture plugin contributes a command, transform, and projector through registered IDs", () => {
  const registry = createPluginRegistry([fixturePluginPackage])

  assert.equal(registry.getPlugin("fixture-research")?.manifest.version, "1.2.3")
  assert.equal(
    registry.resolve("commands", "fixture.capture")?.handler.implementationId,
    "fixture.capture-command",
  )
  assert.equal(
    registry.resolve("transforms", "fixture.normalize")?.handler.implementationId,
    "fixture.normalize-transform",
  )
  assert.equal(
    registry.resolve("projectors", "fixture.card")?.handler.implementationId,
    "fixture.card-projector",
  )
})

test("built-ins register HAM and document transforms without exposing destinations in manifests", () => {
  assert.deepEqual(
    builtinPluginRegistry.listPlugins().map((plugin) => plugin.manifest.id),
    ["atlas", "code", "datasources", "docling", "documents", "eln", "generous", "ham", "markitdown", "papers", "plain-text", "sharing", "tasks", "voice", "web-capture"],
  )
  assert.equal(builtinPluginRegistry.resolve("routes", "ham.proxy")?.pluginId, "ham")
  assert.deepEqual(builtinPluginRegistry.resolve("commands", "ham.memory.search.open"), {
    pluginId: "ham",
    id: "ham.memory.search.open",
    handler: { kind: "commands", implementationId: "builtin.ham.memory-search.open" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("agentTools", "ham.memory.search"), {
    pluginId: "ham",
    id: "ham.memory.search",
    handler: { kind: "agentTools", implementationId: "builtin.ham.memory-search" },
  })
  assert.equal(builtinPluginRegistry.resolve("agentTools", "ham.memory.write"), null)
  assert.deepEqual(builtinPluginRegistry.resolve("commands", "document.import"), {
    pluginId: "documents",
    id: "document.import",
    handler: { kind: "commands", implementationId: "builtin.document.import" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("commands", "document.note.create"), {
    pluginId: "documents",
    id: "document.note.create",
    handler: { kind: "commands", implementationId: "builtin.document.note.create" },
  })
  assert.equal(
    builtinPluginRegistry.getPlugin("documents")?.manifest.contributes.agentTools.includes("document.note.create"),
    false,
  )
  assert.equal(builtinPluginRegistry.resolve("sources", "document.upload")?.pluginId, "documents")
  assert.equal(builtinPluginRegistry.resolve("routes", "document.import-route")?.pluginId, "documents")
  assert.equal(builtinPluginRegistry.resolve("sources", "datasource.connected")?.pluginId, "datasources")
  assert.equal(builtinPluginRegistry.resolve("routes", "datasource.proxy")?.pluginId, "datasources")
  assert.deepEqual(builtinPluginRegistry.resolve("sources", "web.capture"), {
    pluginId: "web-capture",
    id: "web.capture",
    handler: { kind: "sources", implementationId: "builtin.web.capture-source" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("commands", "web.capture.open"), {
    pluginId: "web-capture",
    id: "web.capture.open",
    handler: { kind: "commands", implementationId: "builtin.web.capture.open" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("routes", "web.capture-route"), {
    pluginId: "web-capture",
    id: "web.capture-route",
    handler: { kind: "routes", implementationId: "builtin.web.capture-route" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("ingestionPlans", "web.capture-default"), {
    pluginId: "web-capture",
    id: "web.capture-default",
    handler: { kind: "ingestionPlans", implementationId: "builtin.ingestion-plan.web-capture-default" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("sources", "arxiv.pdf"), {
    pluginId: "papers",
    id: "arxiv.pdf",
    handler: { kind: "sources", implementationId: "builtin.arxiv.pdf-source" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("ingestionPlans", "arxiv.fetch-default"), {
    pluginId: "papers",
    id: "arxiv.fetch-default",
    handler: { kind: "ingestionPlans", implementationId: "builtin.ingestion-plan.arxiv-fetch-default" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("routes", "arxiv.private-fetch-route"), {
    pluginId: "papers",
    id: "arxiv.private-fetch-route",
    handler: { kind: "routes", implementationId: "builtin.arxiv.private-fetch-route" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("commands", "paper.import"), {
    pluginId: "papers",
    id: "paper.import",
    handler: { kind: "commands", implementationId: "builtin.paper.import" },
  })
  assert.deepEqual(
    builtinPluginRegistry.getPlugin("papers")?.manifest.contributes.commands,
    ["paper.import"],
  )
  assert.deepEqual(builtinPluginRegistry.resolve("commands", "datasource.manage.open"), {
    pluginId: "datasources",
    id: "datasource.manage.open",
    handler: { kind: "commands", implementationId: "builtin.datasource.manage.open" },
  })
  assert.equal(
    builtinPluginRegistry.resolve("projectors", "paper")?.handler.implementationId,
    "builtin.object-projector.paper",
  )
  assert.equal(
    builtinPluginRegistry.resolve("projectors", "image")?.handler.implementationId,
    "builtin.object-projector.image",
  )
  assert.equal(
    builtinPluginRegistry.resolve("projectors", "ham-memory")?.handler.implementationId,
    "builtin.object-projector.ham-memory",
  )
  assert.deepEqual(builtinPluginRegistry.resolve("projectors", "conversation"), {
    pluginId: "tasks",
    id: "conversation",
    handler: { kind: "projectors", implementationId: "builtin.object-projector.conversation" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("commands", "eln.experiment.create"), {
    pluginId: "eln",
    id: "eln.experiment.create",
    handler: { kind: "commands", implementationId: "builtin.eln.experiment.create" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("commands", "code.editor.open"), {
    pluginId: "code",
    id: "code.editor.open",
    handler: { kind: "commands", implementationId: "builtin.code.editor.open" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("commands", "code.graph.snapshot.import"), {
    pluginId: "code",
    id: "code.graph.snapshot.import",
    handler: { kind: "commands", implementationId: "builtin.code.graph.snapshot.import" },
  })
  assert.deepEqual(builtinPluginRegistry.getPlugin("code")?.manifest.contributes, {
    commands: ["code.editor.open", "code.graph.snapshot.import"],
    sources: ["code.graph.snapshot"],
    transforms: [],
    projectors: ["code"],
    surfaceRenderers: [],
    agentTools: [],
    routes: [],
    ingestionPlans: [],
  })
  assert.equal(
    builtinPluginRegistry.resolve("sources", "code.graph.snapshot")?.handler.implementationId,
    "builtin.code.graph.snapshot-source",
  )
  assert.equal(
    builtinPluginRegistry.resolve("projectors", "code")?.handler.implementationId,
    "builtin.object-projector.code",
  )
  assert.deepEqual(builtinPluginRegistry.resolve("commands", "voice.capture.open"), {
    pluginId: "voice",
    id: "voice.capture.open",
    handler: { kind: "commands", implementationId: "builtin.voice.capture.open" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("commands", "surface.place.open"), {
    pluginId: "generous",
    id: "surface.place.open",
    handler: { kind: "commands", implementationId: "builtin.surface.place.open" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("surfaceRenderers", "generous.a2ui"), {
    pluginId: "generous",
    id: "generous.a2ui",
    handler: {
      kind: "surfaceRenderers",
      implementationId: "builtin.surface-renderer.generous-a2ui",
    },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("commands", "task.plan.open"), {
    pluginId: "tasks",
    id: "task.plan.open",
    handler: { kind: "commands", implementationId: "builtin.task.plan.open" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("commands", "legacy.flow.portability.open"), {
    pluginId: "tasks",
    id: "legacy.flow.portability.open",
    handler: { kind: "commands", implementationId: "builtin.legacy.flow.portability.open" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("commands", "reference.place"), {
    pluginId: "atlas",
    id: "reference.place",
    handler: { kind: "commands", implementationId: "builtin.reference.place" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("commands", "canvas.create.open"), {
    pluginId: "atlas",
    id: "canvas.create.open",
    handler: { kind: "commands", implementationId: "builtin.canvas.create.open" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("commands", "placement.remove"), {
    pluginId: "atlas",
    id: "placement.remove",
    handler: { kind: "commands", implementationId: "builtin.placement.remove" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("commands", "proof.registry.open"), {
    pluginId: "tasks",
    id: "proof.registry.open",
    handler: { kind: "commands", implementationId: "builtin.proof.registry.open" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("agentTools", "objects.search"), {
    pluginId: "atlas",
    id: "objects.search",
    handler: { kind: "agentTools", implementationId: "builtin.objects.search" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("agentTools", "graph.window.get"), {
    pluginId: "atlas",
    id: "graph.window.get",
    handler: { kind: "agentTools", implementationId: "builtin.graph.window.get" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("commands", "share.canvas.create"), {
    pluginId: "sharing",
    id: "share.canvas.create",
    handler: { kind: "commands", implementationId: "builtin.share.canvas.create" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("commands", "share.canvas-conversation.create"), {
    pluginId: "sharing",
    id: "share.canvas-conversation.create",
    handler: { kind: "commands", implementationId: "builtin.share.canvas-conversation.create" },
  })
  assert.deepEqual(builtinPluginRegistry.resolve("commands", "share.selection.create"), {
    pluginId: "sharing",
    id: "share.selection.create",
    handler: { kind: "commands", implementationId: "builtin.share.selection.create" },
  })
  assert.equal(JSON.stringify(builtinPluginRegistry.listPlugins()).includes("http://"), false)
})

test("built-in transform manifests bind only the exact code-owned implementations", () => {
  const expected = [
    ["docling", "docling.convert", "builtin.docling.convert"],
    ["markitdown", "markitdown.convert", "builtin.markitdown.convert"],
    ["plain-text", "plain-text.convert", "builtin.plain-text.convert"],
  ]

  assert.deepEqual(
    builtinPluginRegistry.listPlugins().flatMap((plugin) => (
      plugin.manifest.contributes.transforms.map((id) => [plugin.manifest.id, id])
    )),
    expected.map(([pluginId, id]) => [pluginId, id]),
  )

  for (const [pluginId, id, implementationId] of expected) {
    assert.deepEqual(builtinPluginRegistry.getPlugin(pluginId)?.manifest.contributes.transforms, [id])
    assert.deepEqual(builtinPluginRegistry.resolve("transforms", id), {
      pluginId,
      id,
      handler: { kind: "transforms", implementationId },
    })
  }
})

test("manifest validation canonicalizes omitted contribution lists deterministically", () => {
  const manifest = validatePluginManifest(baseManifest({
    contributes: { commands: ["test.second", "test.first"] },
  }))

  assert.deepEqual(manifest.contributes.commands, ["test.first", "test.second"])
  assert.deepEqual(manifest.contributes.sources, [])
  assert.equal(manifest.displayName, "test-plugin")
  assert.equal(Object.isFrozen(manifest.contributes), true)
})

test("unsupported versions and duplicate IDs have stable diagnostics", () => {
  const result = inspectPluginManifest(baseManifest({
    schemaId: "galaxy-plugin.v2",
    contributes: { commands: ["test.run", "test.run"] },
  }))

  assert.equal(result.ok, false)
  assert.deepEqual(
    result.diagnostics.map(({ code, path }) => ({ code, path })),
    [
      { code: "unsupported_schema", path: "$.schemaId" },
      { code: "duplicate_id", path: "$.contributes.commands[1]" },
    ],
  )
})

test("manifests cannot register URLs, functions, modules, or executable handlers", () => {
  const withUrl = inspectPluginManifest(baseManifest({ endpointUrl: "https://example.invalid" }))
  assert.equal(withUrl.ok, false)
  assert.equal(withUrl.diagnostics[0].code, "forbidden_manifest_field")

  const withFunction = inspectPluginManifest(baseManifest({
    contributes: { commands: [() => undefined] },
  }))
  assert.equal(withFunction.ok, false)
  assert.equal(withFunction.diagnostics[0].code, "invalid_id")

  const withModule = inspectPluginManifest(baseManifest({
    contributes: { reactModule: ["test.card"] },
  }))
  assert.equal(withModule.ok, false)
  assert.equal(withModule.diagnostics[0].code, "forbidden_manifest_field")

  assert.throws(
    () => createPluginRegistry([{
      manifest: baseManifest({ contributes: { commands: ["test.run"] } }),
      handlers: {
        commands: {
          "test.run": {
            kind: "commands",
            implementationId: "test.run-command",
            url: "https://example.invalid/run",
          },
        },
      },
    }]),
    (error) => error instanceof PluginRegistryValidationError
      && error.diagnostics.some((item) => item.code === "forbidden_handler_field"),
  )
})

test("registry rejects missing handlers and duplicate contribution ownership", () => {
  assert.throws(
    () => createPluginRegistry([{
      manifest: baseManifest({ contributes: { commands: ["test.missing"] } }),
      handlers: {},
    }]),
    (error) => error instanceof PluginRegistryValidationError
      && error.diagnostics[0].code === "missing_handler",
  )

  const first = fixturePluginPackage
  const second = {
    manifest: baseManifest({
      id: "second-plugin",
      contributes: { commands: ["fixture.capture"] },
    }),
    handlers: {
      commands: {
        "fixture.capture": { kind: "commands", implementationId: "second.capture-command" },
      },
    },
  }
  assert.throws(
    () => createPluginRegistry([first, second]),
    (error) => error instanceof PluginRegistryValidationError
      && error.diagnostics[0].code === "duplicate_contribution_id",
  )
})

test("validation errors expose all deterministic diagnostics", () => {
  assert.throws(
    () => validatePluginManifest({}),
    (error) => error instanceof PluginManifestValidationError
      && error.diagnostics.map((item) => item.code).join(",")
        === "unsupported_schema,invalid_plugin_id,invalid_plugin_version,invalid_contributions",
  )
})
