import { NextRequest, NextResponse } from "next/server"

import { MAX_GRAPH_WINDOW_REQUEST_BYTES } from "@/lib/graph-window-gateway"
import { getRequestIdentity, identityCanAny } from "@/lib/request-identity"

const INTERNAL_GALAXY_API = process.env.GALAXY_API_INTERNAL || "http://localhost:8044"
const MAX_UPSTREAM_RESPONSE_BYTES = 1_048_576
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  Pragma: "no-cache",
}

class BodyTooLarge extends Error {
  constructor(readonly direction: "request" | "response") {
    super(`${direction} body exceeded its bound`)
  }
}

async function boundedBytes(response: Request | Response, maximum: number, direction: BodyTooLarge["direction"]) {
  const declared = Number(response.headers.get("content-length") || 0)
  if (Number.isFinite(declared) && declared > maximum) throw new BodyTooLarge(direction)
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximum) {
        await reader.cancel().catch(() => undefined)
        throw new BodyTooLarge(direction)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function error(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: PRIVATE_HEADERS })
}

export async function POST(request: NextRequest) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return error("Content-Type must be application/json", 415)
  }
  try {
    const body = await boundedBytes(request, MAX_GRAPH_WINDOW_REQUEST_BYTES, "request")
    const identity = await getRequestIdentity(request, body)
    if (!identity) return error("Unauthorized", 401)
    if (!identityCanAny(identity, ["eln:read", "graph:read"])) return error("Forbidden", 403)
    const proxyToken = process.env.GALAXY_API_PROXY_TOKEN
    if (!proxyToken) return error("Graph window provider is not configured", 503)

    const upstream = await fetch(new URL("/graph/window", INTERNAL_GALAXY_API), {
      method: "POST",
      body,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-GB-Proxy-Token": proxyToken,
        "X-GB-Graph-Window-Gateway": "v1",
        "X-GB-Tenant-ID": identity.tenantId,
        "X-GB-Principal-ID": identity.principalId,
        "X-GB-Principal-Kind": identity.kind,
        ...(identity.nostrPubkey ? { "X-GB-Nostr-Pubkey": identity.nostrPubkey } : {}),
      },
    })
    const upstreamBody = await boundedBytes(upstream, MAX_UPSTREAM_RESPONSE_BYTES, "response")
    return new NextResponse(upstreamBody, { status: upstream.status, headers: PRIVATE_HEADERS })
  } catch (cause) {
    if (cause instanceof BodyTooLarge && cause.direction === "request") {
      return error("Graph window request exceeded its bound", 413)
    }
    return error("Graph window provider is unavailable", 503)
  }
}
