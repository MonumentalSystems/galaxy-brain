import { NextRequest, NextResponse } from "next/server"

import { getAuthOrigin } from "@/lib/auth-config"
import {
  classifyMcpRequest,
  createGalaxyMcpHandler,
  MAX_MCP_REQUEST_BYTES,
  MAX_MCP_RESPONSE_BYTES,
  mcpRequestTooLargeError,
} from "@/lib/agent-tools/mcp.js"
import { AgentToolContractError, createAgentToolError } from "@/lib/agent-tools/contracts.js"
import { getRequestIdentity, getVerifiedNostrRequestIdentity } from "@/lib/request-identity"

export const runtime = "nodejs"

const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  Pragma: "no-cache",
}

class McpResponseTooLarge extends Error {}

async function readBoundedBytes(body: ReadableStream<Uint8Array> | null, maximum: number) {
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximum) {
        await reader.cancel().catch(() => undefined)
        throw maximum === MAX_MCP_REQUEST_BYTES ? mcpRequestTooLargeError() : new McpResponseTooLarge()
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

function httpError(error: unknown) {
  const normalized = createAgentToolError(error)
  return new NextResponse(JSON.stringify({
    jsonrpc: "2.0",
    id: null,
    error: {
      code: -32600,
      message: "MCP request rejected",
      data: normalized.body,
    },
  }), { status: normalized.status, headers: RESPONSE_HEADERS })
}

function validateBoundary(request: NextRequest) {
  if (request.nextUrl.pathname !== "/mcp" || request.nextUrl.search || request.nextUrl.hash) {
    throw new AgentToolContractError("invalid_endpoint", "MCP endpoint must be exactly /mcp", 404)
  }
  const expected = new URL(getAuthOrigin())
  if ((request.headers.get("host") || "").toLowerCase() !== expected.host.toLowerCase()) {
    throw new AgentToolContractError("invalid_host", "Host is not allowed", 403)
  }
  const origin = request.headers.get("origin")
  if (origin !== null) {
    let actual: URL
    try {
      actual = new URL(origin)
    } catch {
      throw new AgentToolContractError("invalid_origin", "Origin is not allowed", 403)
    }
    if (actual.origin !== expected.origin || origin.replace(/\/$/u, "") !== actual.origin) {
      throw new AgentToolContractError("invalid_origin", "Origin is not allowed", 403)
    }
  }
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  if (mediaType !== "application/json") {
    throw new AgentToolContractError("unsupported_media_type", "Content-Type must be application/json", 415)
  }
  const accept = request.headers.get("accept")
  if (accept && !accept.toLowerCase().includes("application/json")) {
    throw new AgentToolContractError("not_acceptable", "MCP responses require application/json", 406)
  }
  const contentLength = request.headers.get("content-length")
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_MCP_REQUEST_BYTES) {
      throw mcpRequestTooLargeError()
    }
  }
}

async function boundedMcpResponse(response: Response) {
  const declared = response.headers.get("content-length")
  if (declared !== null && (/^\d+$/u.test(declared) ? Number(declared) : Infinity) > MAX_MCP_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new McpResponseTooLarge()
  }
  const contentType = response.headers.get("content-type") || ""
  if (contentType.toLowerCase().includes("text/event-stream")) {
    await response.body?.cancel().catch(() => undefined)
    throw new AgentToolContractError("streaming_not_supported", "Streaming MCP responses are not supported", 500)
  }
  const bytes = await readBoundedBytes(response.body, MAX_MCP_RESPONSE_BYTES)
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.set("Cache-Control", "private, no-store, max-age=0")
  headers.set("Pragma", "no-cache")
  return new NextResponse(bytes.byteLength ? bytes : null, { status: response.status, headers })
}

export async function POST(request: NextRequest) {
  try {
    validateBoundary(request)
    const rawBody = await readBoundedBytes(request.body, MAX_MCP_REQUEST_BYTES)
    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBody))
    } catch {
      throw new AgentToolContractError("invalid_json", "Request body must be UTF-8 JSON", 400)
    }
    if (Array.isArray(parsedBody)) {
      throw new AgentToolContractError("batch_not_supported", "MCP batch requests are not supported", 400)
    }

    const classification = classifyMcpRequest(parsedBody)
    if (classification.method === "subscriptions/listen") {
      throw new AgentToolContractError("streaming_not_supported", "Streaming MCP requests are not supported", 400)
    }
    const identity = classification.mutation
      ? await getVerifiedNostrRequestIdentity(request, rawBody)
      : await getRequestIdentity(request, rawBody)
    if (!identity) {
      throw new AgentToolContractError(
        "unauthorized",
        classification.mutation ? "A fresh Nostr request signature is required" : "Unauthorized",
        401,
      )
    }

    const handler = createGalaxyMcpHandler({
      identity,
      authStrength: classification.mutation ? "fresh-nip98" : "ambient",
    })
    try {
      const sdkRequest = new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: rawBody,
      })
      const response = await handler.fetch(sdkRequest, { parsedBody })
      return await boundedMcpResponse(response)
    } finally {
      await handler.close()
    }
  } catch (error) {
    if (error instanceof McpResponseTooLarge) {
      return httpError(new AgentToolContractError(
        "response_too_large",
        "MCP response exceeds the bounded response contract",
        502,
      ))
    }
    return httpError(error)
  }
}
