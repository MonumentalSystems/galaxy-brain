import { NextRequest, NextResponse } from "next/server"

import { getCurrentUser } from "@/lib/auth"
import {
  HamMemoryContractError,
  HAM_MEMORY_REQUEST_MAX_BYTES,
  HamMemoryUpstreamResponseError,
  parseHamMemoryId,
  parseHamMemoryMutation,
} from "@/lib/ham-memory-contract.js"
import {
  assertHamMemoryMutationOrigin,
  fetchHamMemory,
  HamMemoryProxyError,
  mutateHamMemory,
} from "@/lib/ham-memory-proxy"

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS })
}

function errorResponse(error: unknown) {
  if (error instanceof HamMemoryProxyError) {
    return json({ error: error.message, ...(error.detail ? { detail: error.detail } : {}) }, error.status)
  }
  if (error instanceof HamMemoryUpstreamResponseError) {
    return json({ error: error.message }, 502)
  }
  if (error instanceof HamMemoryContractError) {
    return json({ error: error.message }, error.status)
  }
  if (error instanceof SyntaxError) return json({ error: "Request body must be valid JSON." }, 400)
  return json({ error: "Unexpected HAM memory error" }, 500)
}

async function readBoundedRequestBody(request: NextRequest) {
  const declared = Number(request.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > HAM_MEMORY_REQUEST_MAX_BYTES) {
    throw new HamMemoryContractError("HAM memory request is too large.", 413)
  }
  if (!request.body) return ""
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > HAM_MEMORY_REQUEST_MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new HamMemoryContractError("HAM memory request is too large.", 413)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ memoryId: string }> },
) {
  const user = await getCurrentUser()
  if (!user) return json({ error: "Unauthorized" }, 401)

  try {
    const { memoryId: rawMemoryId } = await context.params
    const memoryId = parseHamMemoryId(rawMemoryId)
    return json(await fetchHamMemory(user, memoryId))
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ memoryId: string }> },
) {
  const user = await getCurrentUser()
  if (!user) return json({ error: "Unauthorized" }, 401)

  try {
    assertHamMemoryMutationOrigin(request)
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new HamMemoryContractError("Content-Type must be application/json.", 415)
    }
    const { memoryId: rawMemoryId } = await context.params
    const memoryId = parseHamMemoryId(rawMemoryId)
    const raw = await readBoundedRequestBody(request)
    if (!raw) throw new HamMemoryContractError("Request body is required.")
    const mutation = parseHamMemoryMutation(JSON.parse(raw))
    return json(await mutateHamMemory(user, memoryId, mutation))
  } catch (error) {
    return errorResponse(error)
  }
}
