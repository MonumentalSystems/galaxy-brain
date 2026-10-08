import type { AgentReadToolId, AgentToolCall, AgentToolId } from "../agent-tools/contracts.js"
import type { GalaxyPluginRegistry } from "./registry.js"

export type AgentToolPluginIdentity = Readonly<{
  id: string
  displayName: string
  version: string
}>

export type AgentReadToolDescriptor = Readonly<{
  id: AgentReadToolId
  pluginId: string
  plugin: AgentToolPluginIdentity
  implementationId: string
  readOnly: true
}>

export type AgentToolDescriptor = Readonly<{
  id: AgentToolId
  pluginId: string
  plugin: AgentToolPluginIdentity
  implementationId: string
  readOnly: boolean
}>

export type AgentReadToolImplementation = (
  input: Readonly<Record<string, unknown>>,
  context: any,
) => Promise<{
  result: Record<string, unknown>
  pagination?: { cursor: string | null; hasMore: boolean; limit: number }
}> | {
  result: Record<string, unknown>
  pagination?: { cursor: string | null; hasMore: boolean; limit: number }
}

export function listAgentReadTools(registry?: GalaxyPluginRegistry): readonly AgentReadToolDescriptor[]
export function listAgentTools(registry?: GalaxyPluginRegistry): readonly AgentToolDescriptor[]
export function dispatchAgentReadTool(
  callInput: AgentToolCall | unknown,
  context: any,
  options?: {
    expectedTool?: string
    implementations?: Record<string, AgentReadToolImplementation>
    registry?: GalaxyPluginRegistry
  },
): Promise<Readonly<Record<string, unknown>> | null>
export function dispatchAgentTool(
  callInput: AgentToolCall | unknown,
  context: any,
  options?: {
    expectedTool?: string
    implementations?: Record<string, AgentReadToolImplementation>
    registry?: GalaxyPluginRegistry
  },
): Promise<Readonly<Record<string, unknown>> | null>
export function isAgentMutationTool(tool: string): boolean
