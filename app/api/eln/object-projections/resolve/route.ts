import { NextRequest, NextResponse } from "next/server"

import {
  assembleObjectProjectionResolutionResponse,
  createObjectProjectionSourceRequest,
  MAX_OBJECT_PROJECTION_REQUEST_BYTES,
  parseObjectProjectionResolutionRequest,
  parseObjectProjectionSourceResponse,
  serializeObjectProjectionResolutionResponse,
} from "@/lib/object-projection-resolution.js"
import {
  ObjectProjectionGatewayError,
  resolveObjectProjectionSources,
} from "@/lib/object-projection-gateway.js"
import { getRequestIdentity } from "@/lib/request-identity"

const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  Pragma: "no-cache",
}

class ProjectionRequestTooLarge extends Error {}

async function readBoundedBytes(request: NextRequest) {
  const declared = Number(request.headers.get("content-length") || 0)
  if (Number.isFinite(declared) && declared > MAX_OBJECT_PROJECTION_REQUEST_BYTES) {
    throw new ProjectionRequestTooLarge()
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
      if (total > MAX_OBJECT_PROJECTION_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new ProjectionRequestTooLarge()
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
  if (mediaType !== "application/json") {
    return jsonError("Content-Type must be application/json", 415)
  }

  try {
    const rawBody = await readBoundedBytes(request)
    const identity = await getRequestIdentity(request, rawBody)
    if (!identity) return jsonError("Unauthorized", 401)

    let parsedJson: unknown
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBody)
      parsedJson = JSON.parse(text)
    } catch {
      return jsonError("Request body must be UTF-8 JSON", 400)
    }

    let publicRequest
    try {
      publicRequest = parseObjectProjectionResolutionRequest(parsedJson)
    } catch {
      return jsonError("Invalid object projection request", 400)
    }

    try {
      const sourceRequest = createObjectProjectionSourceRequest(publicRequest)
      const sourceResponse = parseObjectProjectionSourceResponse(
        await resolveObjectProjectionSources(sourceRequest.references, identity),
        sourceRequest,
      )
      const response = assembleObjectProjectionResolutionResponse(publicRequest, sourceResponse)
      const serialized = serializeObjectProjectionResolutionResponse(response, publicRequest)
      return new NextResponse(serialized, { status: 200, headers: RESPONSE_HEADERS })
    } catch (error) {
      if (error instanceof ObjectProjectionGatewayError) {
        return jsonError("Object projection provider is unavailable", 503)
      }
      // Once the public request is valid, any malformed source, projector
      // drift, or excessive response is a provider failure—not caller input.
      return jsonError("Object projection provider is unavailable", 503)
    }
  } catch (error) {
    if (error instanceof ProjectionRequestTooLarge) {
      return jsonError("Object projection request exceeds 64 KiB", 413)
    }
    return jsonError("Unable to resolve object projections", 500)
  }
}
