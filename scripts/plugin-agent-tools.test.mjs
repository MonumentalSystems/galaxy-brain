import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  dispatchAgentReadTool,
  dispatchAgentTool,
  listAgentReadTools,
  listAgentTools,
} from "../lib/plugins/agent-tools.js"

const DOCUMENT_MARK_AUTHORING_TOOL_IDS = Object.freeze([
  "document.mark.create", "document.mark.update",
])

test("only the code-owned read and pure proposal tools are exposed", () => {
  const allTools = listAgentTools()
  const readTools = listAgentReadTools()
  assert.equal(allTools.length, 15)
  assert.equal(readTools.length, 10)
  assert.equal(Object.isFrozen(allTools), true)
  assert.equal(Object.isFrozen(readTools), true)
  for (const id of DOCUMENT_MARK_AUTHORING_TOOL_IDS) {
    assert.equal(allTools.some((tool) => tool.id === id), false)
  }
  assert.deepEqual(readTools.map(({ id, implementationId, readOnly }) => ({ id, implementationId, readOnly })), [
    { id: "canvas.get", implementationId: "builtin.canvas.get", readOnly: true },
    { id: "graph.window.get", implementationId: "builtin.graph.window.get", readOnly: true },
    { id: "ham.memory.search", implementationId: "builtin.ham.memory-search", readOnly: true },
    { id: "objects.get", implementationId: "builtin.objects.get", readOnly: true },
    { id: "objects.representations", implementationId: "builtin.objects.representations", readOnly: true },
    { id: "objects.search", implementationId: "builtin.objects.search", readOnly: true },
    { id: "proof.frontier.get", implementationId: "builtin.proof.frontier.get", readOnly: true },
    { id: "proof.graph.get", implementationId: "builtin.proof.graph.get", readOnly: true },
    { id: "task.plan.get", implementationId: "builtin.task.plan.get", readOnly: true },
    { id: "task.plan.propose", implementationId: "builtin.task.plan.propose", readOnly: true },
  ])
})

test("ham.memory.search is statically owned by HAM while HAM mutation stays absent", () => {
  const registration = listAgentReadTools().find((tool) => tool.id === "ham.memory.search")
  assert.deepEqual(registration, {
    id: "ham.memory.search",
    pluginId: "ham",
    plugin: { id: "ham", displayName: "HAM", version: "1.0.0" },
    implementationId: "builtin.ham.memory-search",
    readOnly: true,
  })
  assert.equal(listAgentTools().some((tool) => tool.id === "ham.memory.write"), false)
})

test("objects.search is statically owned by Atlas and fails closed on descriptor drift", async () => {
  const registration = listAgentReadTools().find((tool) => tool.id === "objects.search")
  assert.deepEqual(registration, {
    id: "objects.search",
    pluginId: "atlas",
    plugin: { id: "atlas", displayName: "Atlas", version: "1.0.0" },
    implementationId: "builtin.objects.search",
    readOnly: true,
  })
  assert.equal(Object.isFrozen(registration), true)
  assert.equal(Object.isFrozen(registration.plugin), true)

  let invoked = false
  const result = await dispatchAgentReadTool({
    schemaId: "gb.agent-tool-call.v1",
    tool: "objects.search",
    input: { query: "vortex" },
  }, { identity: "browser-user" }, {
    expectedTool: "objects.search",
    registry: {
      resolve() {
        return { pluginId: "atlas", handler: { implementationId: "builtin.dynamic-search" } }
      },
    },
    implementations: {
      "builtin.objects.search": async () => {
        invoked = true
        return { result: {} }
      },
    },
  })
  assert.equal(result, null)
  assert.equal(invoked, false)
})

test("the code-owned mutation table exposes only bounded static mutations", () => {
  assert.deepEqual(listAgentTools().filter((tool) => !tool.readOnly).map((tool) => ({
    id: tool.id, implementationId: tool.implementationId, readOnly: tool.readOnly,
  })), [
    { id: "anchors.create", implementationId: "builtin.anchors.create", readOnly: false },
    { id: "canvas.arrange", implementationId: "builtin.canvas.arrange", readOnly: false },
    { id: "proof.claim", implementationId: "builtin.proof.claim", readOnly: false },
    { id: "relations.propose", implementationId: "builtin.relations.propose", readOnly: false },
    { id: "surface.draft.create", implementationId: "builtin.surface.draft.create", readOnly: false },
  ])
})

test("proof.claim is statically owned by Tasks and fails closed on descriptor drift", async () => {
  const registration = listAgentTools().find((tool) => tool.id === "proof.claim")
  assert.deepEqual(registration, {
    id: "proof.claim",
    pluginId: "tasks",
    plugin: { id: "tasks", displayName: "Tasks", version: "1.0.0" },
    implementationId: "builtin.proof.claim",
    readOnly: false,
  })
  let invoked = false
  const call = {
    schemaId: "gb.agent-tool-call.v1",
    tool: "proof.claim",
    input: {
      graphRef: { graphId: "mission-1", contentSha256: "a".repeat(64) },
      workspaceId: "mission-1-work", nodeId: "foundation",
      expectedVersion: 1, expectedItemVersion: 0,
      action: "acquire", leaseSeconds: 300, idempotencyKey: "claim-foundation-1",
    },
  }
  const result = await dispatchAgentTool(call, { identity: "signed-agent" }, {
    registry: {
      resolve() {
        return { pluginId: "tasks", handler: { implementationId: "builtin.dynamic-proof-claim" } }
      },
    },
    implementations: {
      "builtin.proof.claim": async () => {
        invoked = true
        return { result: {} }
      },
    },
  })
  assert.equal(result, null)
  assert.equal(invoked, false)
  assert.equal(await dispatchAgentReadTool(call, {}, {
    implementations: { "builtin.proof.claim": async () => ({ result: {} }) },
  }), null)
})

test("tool descriptors preserve exact frozen manifest identity for every owning plugin", () => {
  const tools = listAgentTools()
  assert.deepEqual(
    [
      tools.find((tool) => tool.id === "anchors.create"),
      tools.find((tool) => tool.id === "canvas.arrange"),
      tools.find((tool) => tool.id === "graph.window.get"),
      tools.find((tool) => tool.id === "proof.claim"),
      tools.find((tool) => tool.id === "surface.draft.create"),
    ].map((tool) => ({ id: tool.id, plugin: tool.plugin })),
    [
      { id: "anchors.create", plugin: { id: "documents", displayName: "Documents", version: "1.0.0" } },
      { id: "canvas.arrange", plugin: { id: "atlas", displayName: "Atlas", version: "1.0.0" } },
      { id: "graph.window.get", plugin: { id: "atlas", displayName: "Atlas", version: "1.0.0" } },
      { id: "proof.claim", plugin: { id: "tasks", displayName: "Tasks", version: "1.0.0" } },
      { id: "surface.draft.create", plugin: { id: "generous", displayName: "Generous", version: "1.0.0" } },
    ],
  )
  for (const tool of tools) {
    assert.equal(Object.isFrozen(tool), true)
    assert.equal(Object.isFrozen(tool.plugin), true)
  }
})

test("manifest ownership disagreement is omitted from discovery and dispatch", async () => {
  const call = {
    schemaId: "gb.agent-tool-call.v1",
    tool: "objects.search",
    input: { query: "vortex" },
  }
  const registrationHandler = {
    kind: "agentTools",
    implementationId: "builtin.objects.search",
  }
  const registration = {
    id: "objects.search",
    pluginId: "forged-owner",
    handler: registrationHandler,
  }
  const plugin = (manifest, handler = registrationHandler) => ({
    manifest,
    handlers: { agentTools: { "objects.search": handler } },
  })
  const cases = [
    {
      name: "missing owning plugin",
      getPlugin: () => null,
    },
    {
      name: "mismatched manifest identity",
      getPlugin: () => plugin({
        id: "other-owner", displayName: "Other", version: "1.0.0",
        contributes: { agentTools: ["objects.search"] },
      }),
    },
    {
      name: "manifest omits the contribution",
      getPlugin: () => plugin({
        id: "forged-owner", displayName: "Forged", version: "1.0.0",
        contributes: { agentTools: [] },
      }),
    },
    {
      name: "registration identity differs from the resolved tool",
      registration: { ...registration, id: "objects.get" },
      getPlugin: () => plugin({
        id: "forged-owner", displayName: "Forged", version: "1.0.0",
        contributes: { agentTools: ["objects.search"] },
      }),
    },
    {
      name: "registration has the wrong contribution kind",
      registration: { ...registration, handler: { ...registrationHandler, kind: "commands" } },
      getPlugin: () => plugin({
        id: "forged-owner", displayName: "Forged", version: "1.0.0",
        contributes: { agentTools: ["objects.search"] },
      }),
    },
    {
      name: "owning package handler names a different implementation",
      getPlugin: () => plugin({
        id: "forged-owner", displayName: "Forged", version: "1.0.0",
        contributes: { agentTools: ["objects.search"] },
      }, { ...registrationHandler, implementationId: "builtin.objects.get" }),
    },
  ]
  for (const item of cases) {
    let invoked = false
    const registry = {
      resolve() { return item.registration ?? registration },
      getPlugin: item.getPlugin,
    }
    assert.equal(listAgentTools(registry).some((tool) => tool.id === "objects.search"), false, item.name)
    const result = await dispatchAgentReadTool(call, {}, {
      registry,
      implementations: {
        "builtin.objects.search": async () => {
          invoked = true
          return { result: {} }
        },
      },
    })
    assert.equal(result, null, item.name)
    assert.equal(invoked, false, item.name)
  }
})

test("dispatch resolves the registry descriptor only through the local implementation table", async () => {
  let observed = null
  const result = await dispatchAgentReadTool({
    schemaId: "gb.agent-tool-call.v1",
    tool: "canvas.get",
    input: { canvasId: "00000000-0000-4000-8000-000000000123", limit: 10 },
  }, { identity: "server-context" }, {
    expectedTool: "canvas.get",
    implementations: {
      "builtin.canvas.get": async (input, context) => {
        observed = { input, context }
        return { result: { canvasId: input.canvasId } }
      },
    },
  })
  assert.equal(observed.context.identity, "server-context")
  assert.equal(result.result.canvasId, "00000000-0000-4000-8000-000000000123")

  assert.equal(await dispatchAgentReadTool({
    schemaId: "gb.agent-tool-call.v1",
    tool: "canvas.get",
    input: { canvasId: "00000000-0000-4000-8000-000000000123" },
  }, {}, { implementations: { "https://evil.test/tool": () => ({ result: {} }) } }), null)
})

test("task plan proposal dispatch fails closed when its static plugin descriptor mismatches", async () => {
  let invoked = false
  const result = await dispatchAgentReadTool({
    schemaId: "gb.agent-tool-call.v1",
    tool: "task.plan.propose",
    input: {
      taskPlanId: "30000000-0000-4000-8000-000000000001",
      expectedVersion: 4,
      expectedContentHash: "b".repeat(64),
      expectedHamTaskId: "task-42",
      expectedHamTaskVersion: 3,
      action: "challenge",
      sourceJobIds: ["research"],
      title: "Challenge",
      goal: "Seek counterevidence.",
      instruction: null,
      inputRefs: [],
      branches: [],
    },
  }, { identity: "browser-user" }, {
    expectedTool: "task.plan.propose",
    registry: {
      resolve() {
        return { pluginId: "tasks", handler: { implementationId: "builtin.unapproved-producer" } }
      },
    },
    implementations: {
      "builtin.task.plan.propose": async () => {
        invoked = true
        return { result: { proposal: {} } }
      },
    },
  })
  assert.equal(result, null)
  assert.equal(invoked, false)
})

test("unregistered HAM mutation names are not callable through the read gateway", async () => {
  await assert.rejects(() => dispatchAgentReadTool({
    schemaId: "gb.agent-tool-call.v1",
    tool: "ham.memory.write",
    input: {},
  }, {}, { implementations: { "builtin.ham.memory-write": () => ({ result: {} }) } }), /not registered/)
})

test("mutation dispatch stays in the same static registry and cannot enter the read gateway", async () => {
  const call = {
    schemaId: "gb.agent-tool-call.v1",
    tool: "canvas.arrange",
    input: {
      canvasId: "00000000-0000-4000-8000-000000000123",
      expectedVersion: 1,
      expectedContentHash: `sha256:${"a".repeat(64)}`,
      idempotencyKey: "arrange-operation-1",
      commands: [{ type: "item.move", itemId: "paper-1", position: { x: 1, y: 2 } }],
    },
  }
  assert.equal(await dispatchAgentReadTool(call, {}, {
    implementations: { "builtin.canvas.arrange": async () => ({ result: {} }) },
  }), null)
  const result = await dispatchAgentTool(call, { identity: "signed-agent" }, {
    implementations: {
      "builtin.canvas.arrange": async (input, context) => ({
        result: { canvasId: input.canvasId, actor: context.identity },
      }),
    },
  })
  assert.equal(result.result.actor, "signed-agent")
})

test("dispatcher contains no dynamic module, URL, or code execution seam", async () => {
  const source = await readFile(new URL("../lib/plugins/agent-tools.js", import.meta.url), "utf8")
  assert.doesNotMatch(source, /\bfetch\s*\(|\bimport\s*\(|\beval\s*\(|new Function|implementationUrl|modulePath/)
})
