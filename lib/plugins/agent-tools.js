import {
  AGENT_MUTATION_TOOL_IDS,
  AGENT_READ_TOOL_IDS,
  AGENT_TOOL_IDS,
  createAgentToolResult,
  parseAgentToolCall,
} from "../agent-tools/contracts.js"
import { builtinPluginRegistry } from "./builtins.js"

const ALLOWED_IMPLEMENTATIONS = Object.freeze({
  "anchors.create": "builtin.anchors.create",
  "canvas.arrange": "builtin.canvas.arrange",
  "proof.claim": "builtin.proof.claim",
  "relations.propose": "builtin.relations.propose",
  "surface.draft.create": "builtin.surface.draft.create",
  "canvas.get": "builtin.canvas.get",
  "graph.window.get": "builtin.graph.window.get",
  "ham.memory.search": "builtin.ham.memory-search",
  "objects.get": "builtin.objects.get",
  "objects.representations": "builtin.objects.representations",
  "objects.search": "builtin.objects.search",
  "proof.frontier.get": "builtin.proof.frontier.get",
  "proof.graph.get": "builtin.proof.graph.get",
  "task.plan.get": "builtin.task.plan.get",
  "task.plan.propose": "builtin.task.plan.propose",
})

const READ_TOOL_SET = new Set(AGENT_READ_TOOL_IDS)
const MUTATION_TOOL_SET = new Set(AGENT_MUTATION_TOOL_IDS)

function resolveRegisteredAgentTool(id, registry) {
  const registration = registry.resolve("agentTools", id)
  const expectedImplementation = ALLOWED_IMPLEMENTATIONS[id]
  if (
    !registration
    || registration.id !== id
    || registration.handler?.kind !== "agentTools"
    || registration.handler?.implementationId !== expectedImplementation
    || typeof registry.getPlugin !== "function"
  ) return null
  const registeredPlugin = registry.getPlugin(registration.pluginId)
  const manifest = registeredPlugin?.manifest
  const owningHandler = registeredPlugin?.handlers?.agentTools?.[id]
  if (
    !manifest
    || manifest.id !== registration.pluginId
    || !Array.isArray(manifest.contributes?.agentTools)
    || !manifest.contributes.agentTools.includes(id)
    || owningHandler?.kind !== "agentTools"
    || owningHandler.implementationId !== expectedImplementation
  ) return null
  const plugin = Object.freeze({
    id: manifest.id,
    displayName: manifest.displayName,
    version: manifest.version,
  })
  return Object.freeze({
    id,
    pluginId: registration.pluginId,
    plugin,
    implementationId: expectedImplementation,
    readOnly: READ_TOOL_SET.has(id),
  })
}

export function listAgentTools(registry = builtinPluginRegistry) {
  return Object.freeze(AGENT_TOOL_IDS.flatMap((id) => {
    const tool = resolveRegisteredAgentTool(id, registry)
    return tool ? [tool] : []
  }))
}

export function listAgentReadTools(registry = builtinPluginRegistry) {
  return Object.freeze(listAgentTools(registry).filter((tool) => tool.readOnly))
}

/**
 * Dispatch one validated read tool through source-controlled implementation
 * IDs. Registry data can select only this local table; it cannot supply a URL,
 * module, function, or new authority.
 */
export async function dispatchAgentReadTool(
  callInput,
  context,
  { expectedTool, implementations, registry = builtinPluginRegistry } = {},
) {
  const call = parseAgentToolCall(callInput, expectedTool)
  if (!READ_TOOL_SET.has(call.tool)) return null
  return dispatchValidatedAgentTool(call, context, { implementations, registry })
}

async function dispatchValidatedAgentTool(call, context, { implementations, registry }) {
  const tool = resolveRegisteredAgentTool(call.tool, registry)
  if (!tool) return null
  const implementation = implementations?.[tool.implementationId]
  if (typeof implementation !== "function") return null
  const output = await implementation(call.input, context)
  if (!output || typeof output !== "object" || Array.isArray(output)) return null
  return createAgentToolResult(call.tool, output.result, output.pagination)
}

export async function dispatchAgentTool(
  callInput,
  context,
  { expectedTool, implementations, registry = builtinPluginRegistry } = {},
) {
  const call = parseAgentToolCall(callInput, expectedTool)
  return dispatchValidatedAgentTool(call, context, { implementations, registry })
}

export function isAgentMutationTool(tool) {
  return MUTATION_TOOL_SET.has(tool)
}
