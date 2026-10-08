import { builtinPluginRegistry } from "./plugins/builtins.js"
import {
  LEGACY_PROXY_DEFINITIONS,
  LEGACY_TRANSFORM_DEFINITIONS,
} from "./plugins/server-definitions.js"

export const PLUGIN_CAPABILITIES = Object.freeze([
  "source", "transform", "executor", "projector", "surface", "sink",
])

export function getPluginDefinition(id) {
  if (!builtinPluginRegistry.getPlugin(id)) return null
  return Object.hasOwn(LEGACY_PROXY_DEFINITIONS, id) ? LEGACY_PROXY_DEFINITIONS[id] : null
}

export function listPluginDefinitions() {
  return Object.keys(LEGACY_PROXY_DEFINITIONS)
    .sort()
    .map((id) => getPluginDefinition(id))
    .filter(Boolean)
}

export function getTransformPluginDefinition(id) {
  const transformId = `${id}.convert`
  if (!builtinPluginRegistry.resolve("transforms", transformId)) return null
  return Object.hasOwn(LEGACY_TRANSFORM_DEFINITIONS, id) ? LEGACY_TRANSFORM_DEFINITIONS[id] : null
}

export function listTransformPluginDefinitions() {
  return Object.keys(LEGACY_TRANSFORM_DEFINITIONS)
    .sort()
    .map((id) => getTransformPluginDefinition(id))
    .filter(Boolean)
}

export function pluginBaseUrl(plugin) {
  return process.env[plugin.baseUrlEnv] || plugin.defaultBaseUrl
}

/** Rejects traversal and empty segments before the path is joined. */
export function isSafePluginPath(path) {
  if (path.length === 0 || path.length > 8) return false
  return path.every((segment) =>
    segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("\\"),
  )
}

/** The scopes a non-human principal needs to reach a plugin. */
export function pluginScopes(pluginId) {
  return [`plugin:${pluginId}`, "plugin:*"]
}
