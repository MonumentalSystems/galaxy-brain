import {
  AgentToolContractError,
  AGENT_TOOL_CALL_SCHEMA_ID,
  MAX_AGENT_TOOL_REQUEST_BYTES,
} from "./contracts.js"
import {
  AGENT_MUTATION_TOOL_IMPLEMENTATIONS,
  AGENT_READ_TOOL_IMPLEMENTATIONS,
} from "./server.js"
import { dispatchAgentTool } from "../plugins/agent-tools.js"

const IMPLEMENTATIONS = Object.freeze({
  ...AGENT_READ_TOOL_IMPLEMENTATIONS,
  ...AGENT_MUTATION_TOOL_IMPLEMENTATIONS,
})

export function createAgentToolCall(tool, input) {
  const call = { schemaId: AGENT_TOOL_CALL_SCHEMA_ID, tool, input }
  if (new TextEncoder().encode(JSON.stringify(call)).byteLength > MAX_AGENT_TOOL_REQUEST_BYTES) {
    throw new AgentToolContractError("request_too_large", "Agent tool request exceeds 64 KiB", 413)
  }
  return call
}

/**
 * The only production seam between an authenticated request and an agent tool
 * implementation. Both the native HTTP route and the MCP adapter use this
 * source-owned dispatcher and its static implementation table.
 */
export async function dispatchAgentToolGateway(callInput, identity, expectedTool) {
  const result = await dispatchAgentTool(callInput, { identity }, {
    expectedTool,
    implementations: IMPLEMENTATIONS,
  })
  if (!result) {
    throw new AgentToolContractError("unknown_tool", "Agent tool is not registered", 404)
  }
  return result
}
