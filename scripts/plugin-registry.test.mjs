import assert from "node:assert/strict"
import test from "node:test"

import {
  getPluginDefinition,
  getTransformPluginDefinition,
  isSafePluginPath,
  listPluginDefinitions,
  listTransformPluginDefinitions,
  PLUGIN_CAPABILITIES,
  pluginScopes,
} from "../lib/plugin-registry.js"

test("resolves only registered plugins", () => {
  assert.equal(getPluginDefinition("ham")?.id, "ham")
  assert.equal(getPluginDefinition("unknown"), null)
})

test("does not resolve inherited object properties as plugins", () => {
  // A bare `PLUGINS[id]` lookup would return Object.prototype members here.
  assert.equal(getPluginDefinition("constructor"), null)
  assert.equal(getPluginDefinition("__proto__"), null)
  assert.equal(getPluginDefinition("toString"), null)
})

test("every registered plugin names its upstream configuration", () => {
  for (const plugin of listPluginDefinitions()) {
    assert.ok(plugin.baseUrlEnv, `${plugin.id} must name a base URL env var`)
    assert.ok(plugin.defaultBaseUrl, `${plugin.id} must have a development fallback`)
    assert.ok(plugin.methods.length > 0, `${plugin.id} must allow at least one method`)
    assert.ok(plugin.capabilities.every((capability) => PLUGIN_CAPABILITIES.includes(capability)))
  }
})

test("transforms are capability-declared but not exposed through the general proxy", () => {
  const docling = getTransformPluginDefinition("docling")
  assert.equal(docling?.endpoint, "v1/convert/file")
  assert.equal(docling?.tokenHeader, "X-API-Key")
  assert.equal(docling?.fidelity, "structured")
  assert.equal(docling?.defaultBaseUrl, "")
  assert.equal(docling?.maxFileBytes, 25 * 1024 * 1024)
  const transform = getTransformPluginDefinition("markitdown")
  assert.deepEqual(transform?.capabilities, ["transform"])
  assert.equal(transform?.fidelity, "flat")
  assert.equal(transform?.transport, "service")
  assert.equal(transform?.tokenHeader, "X-GB-Proxy-Token")
  assert.equal(getPluginDefinition("markitdown"), null)
  assert.deepEqual(getTransformPluginDefinition("plain-text")?.capabilities, ["transform"])
  assert.equal(getTransformPluginDefinition("plain-text")?.transport, "local")
  assert.equal(getPluginDefinition("plain-text"), null)
  assert.equal(getTransformPluginDefinition("constructor"), null)
  assert.equal(listTransformPluginDefinitions().length, 3)
})

test("rejects traversal and empty path segments", () => {
  assert.equal(isSafePluginPath(["ingest"]), true)
  assert.equal(isSafePluginPath(["memories", "abc123"]), true)
  assert.equal(isSafePluginPath([]), false)
  assert.equal(isSafePluginPath([".."]), false)
  assert.equal(isSafePluginPath(["a", "..", "b"]), false)
  assert.equal(isSafePluginPath([""]), false)
  assert.equal(isSafePluginPath(["a\\b"]), false)
  assert.equal(isSafePluginPath(new Array(9).fill("a")), false)
})

test("scopes a plugin to its own namespace and a wildcard", () => {
  assert.deepEqual(pluginScopes("ham"), ["plugin:ham", "plugin:*"])
})
