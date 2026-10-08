import {
  HAM_RELATION_OVERLAY_REQUEST_SCHEMA_ID,
  HAM_RELATION_OVERLAY_RESPONSE_MAX_BYTES,
  parseHamRelationOverlayRequest,
  parseHamRelationOverlayResponse,
  type HamRelationOverlayResponse,
} from "@/lib/ham-relation-overlay-contract.js"

const ENDPOINT = "/api/ham/relation-overlay"

async function cancelBody(response: Response) {
  await response.body?.cancel().catch(() => undefined)
}

async function boundedJson(response: Response) {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  if (mediaType !== "application/json") {
    await cancelBody(response)
    throw new TypeError("HAM relation overlay response is not JSON")
  }
  const declared = Number(response.headers.get("content-length") || 0)
  if (Number.isFinite(declared) && declared > HAM_RELATION_OVERLAY_RESPONSE_MAX_BYTES) {
    await cancelBody(response)
    throw new RangeError("HAM relation overlay response is too large")
  }
  if (!response.body) throw new TypeError("HAM relation overlay response has no body")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > HAM_RELATION_OVERLAY_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new RangeError("HAM relation overlay response is too large")
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
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body))
}

export async function requestHamRelationOverlay(
  references: readonly string[],
  signal?: AbortSignal,
): Promise<HamRelationOverlayResponse> {
  const request = parseHamRelationOverlayRequest({
    schemaId: HAM_RELATION_OVERLAY_REQUEST_SCHEMA_ID,
    references: [...references],
  })
  const response = await fetch(ENDPOINT, {
    method: "POST",
    cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  })
  if (!response.ok) {
    await cancelBody(response)
    throw new Error("HAM relation overlay is unavailable")
  }
  return parseHamRelationOverlayResponse(await boundedJson(response), request)
}
