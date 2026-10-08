import { NextRequest, NextResponse } from "next/server"

import {
  HAM_RELATION_OVERLAY_REQUEST_MAX_BYTES,
  parseHamRelationOverlayRequest,
  serializeHamRelationOverlayResponse,
} from "@/lib/ham-relation-overlay-contract.js"
import {
  HamRelationOverlayProxyError,
  resolveHamRelationOverlay,
} from "@/lib/ham-relation-overlay-proxy.js"
import { getRequestIdentity } from "@/lib/request-identity"

const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  Pragma: "no-cache",
}

class OverlayRequestTooLarge extends Error {}

async function readBoundedBytes(request: NextRequest) {
  const declared = Number(request.headers.get("content-length") || 0)
  if (Number.isFinite(declared) && declared > HAM_RELATION_OVERLAY_REQUEST_MAX_BYTES) {
    throw new OverlayRequestTooLarge()
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
      if (total > HAM_RELATION_OVERLAY_REQUEST_MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new OverlayRequestTooLarge()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function jsonError(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: RESPONSE_HEADERS })
}

export async function POST(request: NextRequest) {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  if (mediaType !== "application/json") return jsonError("Content-Type must be application/json", 415)

  try {
    const rawBody = await readBoundedBytes(request)
    const identity = await getRequestIdentity(request, rawBody)
    if (!identity) return jsonError("Unauthorized", 401)

    let input: unknown
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBody)
      input = JSON.parse(text)
    } catch {
      return jsonError("Request body must be UTF-8 JSON", 400)
    }

    let parsed
    try {
      parsed = parseHamRelationOverlayRequest(input)
    } catch {
      return jsonError("Invalid HAM relation overlay request", 400)
    }

    try {
      const response = await resolveHamRelationOverlay(parsed, identity, process.env, fetch, request.signal)
      return new NextResponse(serializeHamRelationOverlayResponse(response, parsed), {
        status: 200,
        headers: RESPONSE_HEADERS,
      })
    } catch (error) {
      if (error instanceof HamRelationOverlayProxyError) {
        const status = error.status === 403 ? 403 : 503
        return jsonError("HAM relation overlay is unavailable", status)
      }
      return jsonError("HAM relation overlay is unavailable", 503)
    }
  } catch (error) {
    if (error instanceof OverlayRequestTooLarge) {
      return jsonError("HAM relation overlay request exceeds 64 KiB", 413)
    }
    return jsonError("Unable to load HAM relation overlay", 500)
  }
}
