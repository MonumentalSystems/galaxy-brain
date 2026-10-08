export const AGENT_TOOL_CALL_SCHEMA_ID: "gb.agent-tool-call.v1"
export const AGENT_TOOL_RESULT_SCHEMA_ID: "gb.agent-tool-result.v1"
export const AGENT_TOOL_ERROR_SCHEMA_ID: "gb.agent-tool-error.v1"
export const MAX_AGENT_TOOL_REQUEST_BYTES: 65536
export const MAX_AGENT_TOOL_RESPONSE_BYTES: 1048576
export const AGENT_READ_TOOL_IDS: readonly [
  "canvas.get",
  "graph.window.get",
  "ham.memory.search",
  "objects.get",
  "objects.representations",
  "objects.search",
  "proof.frontier.get",
  "proof.graph.get",
  "task.plan.get",
  "task.plan.propose",
]
export const AGENT_MUTATION_TOOL_IDS: readonly [
  "anchors.create",
  "canvas.arrange",
  "proof.claim",
  "relations.propose",
  "surface.draft.create",
]
export const AGENT_TOOL_IDS: readonly [
  "canvas.get",
  "graph.window.get",
  "ham.memory.search",
  "objects.get",
  "objects.representations",
  "objects.search",
  "proof.frontier.get",
  "proof.graph.get",
  "task.plan.get",
  "task.plan.propose",
  "anchors.create",
  "canvas.arrange",
  "proof.claim",
  "relations.propose",
  "surface.draft.create",
]

export type AgentReadToolId = typeof AGENT_READ_TOOL_IDS[number]
export type AgentMutationToolId = typeof AGENT_MUTATION_TOOL_IDS[number]
export type AgentToolId = typeof AGENT_TOOL_IDS[number]

export type AgentToolCall = Readonly<{
  schemaId: "gb.agent-tool-call.v1"
  tool: AgentToolId
  input: Readonly<Record<string, unknown>>
}>

export class AgentToolContractError extends TypeError {
  code: string
  status: number
  constructor(code: string, message: string, status?: number)
}

export function parseAgentToolCall(value: unknown, expectedTool?: string): AgentToolCall
export function createAgentToolResult(
  tool: AgentToolId,
  result: Record<string, unknown>,
  pagination?: { cursor: string | null; hasMore: boolean; limit: number } | null,
): Readonly<Record<string, unknown>>
export function serializeAgentToolResult(value: unknown): string
export function createAgentToolError(error: unknown): Readonly<{
  status: number
  body: Readonly<{
    schemaId: "gb.agent-tool-error.v1"
    error: Readonly<{ code: string; message: string }>
  }>
}>
