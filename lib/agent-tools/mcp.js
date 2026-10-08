import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server"

import {
  AgentToolContractError,
  AGENT_TOOL_IDS,
  createAgentToolError,
  serializeAgentToolResult,
} from "./contracts.js"
import { createAgentToolCall, dispatchAgentToolGateway } from "./gateway.js"
import { isAgentMutationTool, listAgentTools } from "../plugins/agent-tools.js"

export const MAX_MCP_REQUEST_BYTES = 80 * 1024
export const MAX_MCP_RESPONSE_BYTES = 1_048_576 + (16 * 1024)

const TOOL_DESCRIPTIONS = Object.freeze({
  "anchors.create": "Create or reconcile an anchor against one pinned document representation.",
  "canvas.arrange": "Apply bounded compare-and-swap arrangement commands to an authorized canvas.",
  "relations.propose": "Store an inactive relation proposal between two authorized pinned objects.",
  "surface.draft.create": "Create a reviewable draft Generous surface from bounded presentation data and pinned evidence.",
  "canvas.get": "Read one authorized canvas snapshot page.",
  "graph.window.get": "Read one bounded authorized aggregate graph window with exact pinned member references.",
  "ham.memory.search": "Search bounded authorized HAM memories without fusing HAM ranking into Galaxy relevance.",
  "objects.get": "Read one authorized canonical Galaxy object.",
  "objects.representations": "List bounded representations for one authorized canonical object.",
  "objects.search": "Find bounded exact document passages and pinned object references in the authorized Galaxy corpus.",
  "proof.frontier.get": "Read the active authorized proof-workspace frontier.",
  "proof.graph.get": "Read a bounded passive proof graph page.",
  "proof.claim": "Acquire, renew, or release a bounded Nostr-attributed Galaxy proof-work lease. This does not claim a HAM task, run a prover, or verify a proof.",
  "task.plan.get": "Read one authorized task plan.",
  "task.plan.propose": "Return a bounded task-plan proposal without mutating durable state.",
})

const PERMISSIVE_OBJECT_SCHEMA = fromJsonSchema({
  type: "object",
  additionalProperties: true,
})

function normalizedToolFailure(error) {
  const normalized = createAgentToolError(error)
  return {
    isError: true,
    content: [{ type: "text", text: "Galaxy agent tool failed." }],
    structuredContent: normalized.body,
  }
}

export function createMcpToolSuccess(result) {
  serializeAgentToolResult(result)
  return {
    content: [{ type: "text", text: "Galaxy agent tool completed." }],
    structuredContent: result,
  }
}

function assertStaticCatalog() {
  const registrations = listAgentTools()
  if (registrations.length !== AGENT_TOOL_IDS.length
    || registrations.some((registration, index) => registration.id !== AGENT_TOOL_IDS[index])) {
    throw new Error("Static agent tool catalog is unavailable")
  }
}

export function classifyMcpRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({ method: null, tool: null, mutation: false })
  }
  const method = typeof value.method === "string" ? value.method : null
  const params = value.params
  const tool = method === "tools/call" && params && typeof params === "object"
    && !Array.isArray(params) && typeof params.name === "string"
    ? params.name
    : null
  return Object.freeze({ method, tool, mutation: tool !== null && isAgentMutationTool(tool) })
}

export function createGalaxyMcpHandler(authContext) {
  assertStaticCatalog()
  return createMcpHandler(() => {
    const server = new McpServer({ name: "galaxy-brain", version: "1.0.0" })
    for (const tool of AGENT_TOOL_IDS) {
      server.registerTool(tool, {
        description: TOOL_DESCRIPTIONS[tool],
        inputSchema: PERMISSIVE_OBJECT_SCHEMA,
        annotations: {
          readOnlyHint: !isAgentMutationTool(tool),
          destructiveHint: false,
        },
      }, async (input) => {
        try {
          if (isAgentMutationTool(tool) && authContext.authStrength !== "fresh-nip98") {
            throw new AgentToolContractError(
              "fresh_signature_required",
              "A fresh Nostr request signature is required",
              401,
            )
          }
          const call = createAgentToolCall(tool, input)
          const result = await dispatchAgentToolGateway(call, authContext.identity, tool)
          return createMcpToolSuccess(result)
        } catch (error) {
          return normalizedToolFailure(error)
        }
      })
    }
    return server
  }, {
    legacy: "reject",
    responseMode: "auto",
    maxRequestBodySize: MAX_MCP_REQUEST_BYTES,
    onerror() {},
  })
}

export function mcpRequestTooLargeError() {
  return new AgentToolContractError("request_too_large", "MCP request exceeds 80 KiB", 413)
}
