import type { RequestIdentity } from "../request-identity"

export type AgentToolServerContext = {
  identity: RequestIdentity
  environment?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
}

export const AGENT_READ_TOOL_IMPLEMENTATIONS: Readonly<Record<
  string,
  (input: Readonly<Record<string, any>>, context: AgentToolServerContext) => Promise<{
    result: Record<string, unknown>
    pagination?: { cursor: string | null; hasMore: boolean; limit: number }
  }>
>>

export const AGENT_MUTATION_TOOL_IMPLEMENTATIONS: Readonly<Record<
  string,
  (input: Readonly<Record<string, any>>, context: AgentToolServerContext) => Promise<{
    result: Record<string, unknown>
  }>
>>
