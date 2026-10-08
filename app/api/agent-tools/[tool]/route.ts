import { NextRequest, NextResponse } from "next/server"

import {
  AgentToolContractError,
  createAgentToolError,
  MAX_AGENT_TOOL_REQUEST_BYTES,
  serializeAgentToolResult,
} from "@/lib/agent-tools/contracts.js"
import { dispatchAgentToolGateway } from "@/lib/agent-tools/gateway.js"
import { isAgentMutationTool } from "@/lib/plugins/agent-tools.js"
import { getRequestIdentity, getVerifiedNostrRequestIdentity } from "@/lib/request-identity"

const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  Pragma: "no-cache",
}

type RouteContext = {
  params: Promise<{ tool: string }>
}

class AgentToolRequestTooLarge extends Error {}

async function readBoundedBytes(request: NextRequest) {
  const declared = Number(request.headers.get("content-length") || 0)
  if (Number.isFinite(declared) && declared > MAX_AGENT_TOOL_REQUEST_BYTES) {
    throw new AgentToolRequestTooLarge()
  }
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_AGENT_TOOL_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new AgentToolRequestTooLarge()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function response(body: unknown, status: number) {
  return new NextResponse(JSON.stringify(body), { status, headers: RESPONSE_HEADERS })
}

function errorResponse(error: unknown) {
  const normalized = createAgentToolError(error)
  return response(normalized.body, normalized.status)
}

export async function POST(request: NextRequest, context: RouteContext) {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  if (mediaType !== "application/json") {
    return errorResponse(new AgentToolContractError("unsupported_media_type", "Content-Type must be application/json", 415))
  }
  try {
    const rawBody = await readBoundedBytes(request)
    const { tool } = await context.params
    const mutation = isAgentMutationTool(tool)
    const identity = mutation
      ? await getVerifiedNostrRequestIdentity(request, rawBody)
      : await getRequestIdentity(request, rawBody)
    if (!identity) {
      return errorResponse(new AgentToolContractError(
        "unauthorized",
        mutation ? "A fresh Nostr request signature is required" : "Unauthorized",
        401,
      ))
    }

    let input: unknown
    try {
      input = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBody))
    } catch {
      return errorResponse(new AgentToolContractError("invalid_json", "Request body must be UTF-8 JSON", 400))
    }

    const result = await dispatchAgentToolGateway(input, identity, tool)
    return new NextResponse(serializeAgentToolResult(result), { status: 200, headers: RESPONSE_HEADERS })
  } catch (error) {
    if (error instanceof AgentToolRequestTooLarge) {
      return errorResponse(new AgentToolContractError("request_too_large", "Agent tool request exceeds 64 KiB", 413))
    }
    return errorResponse(error)
  }
}
