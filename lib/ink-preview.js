import { inkRepresentationContentPath, normalizeInkPlacementDescriptor } from "./canvas/ink-placement.js"
import { MAX_INK_DOCUMENT_BYTES, renderInkDocumentSvg } from "./ink-document.js"

async function boundedBytes(response, isCurrent, signal) {
  const declared = Number(response.headers.get("content-length") || 0)
  if (Number.isFinite(declared) && declared > MAX_INK_DOCUMENT_BYTES) throw new Error("oversized")
  if (!response.body) throw new Error("missing")
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      if (!isCurrent() || signal?.aborted) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      const { done, value } = await reader.read()
      if (!isCurrent() || signal?.aborted) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      if (done) break
      total += value.byteLength
      if (total > MAX_INK_DOCUMENT_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error("oversized")
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

async function sha256(bytes) {
  const exact = new Uint8Array(bytes.byteLength)
  exact.set(bytes)
  const digest = await crypto.subtle.digest("SHA-256", exact.buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Publish a resolved Blob URL only while its owning preview generation remains current. */
export function handoffInkPreviewObjectUrl(url, options) {
  if (url === null) return false
  if (typeof url !== "string" || !url) throw new TypeError("Ink preview URL is invalid")
  if (
    !options || typeof options !== "object"
    || typeof options.isCurrent !== "function"
    || typeof options.publish !== "function"
    || typeof options.revokeObjectUrl !== "function"
  ) throw new TypeError("Ink preview handoff is invalid")
  if (!options.isCurrent()) {
    options.revokeObjectUrl(url)
    return false
  }
  options.publish(url)
  return true
}

/** Fetch, verify, parse, and render one exact immutable ink document. */
export async function loadInkPreviewObjectUrl(value, options = {}) {
  const descriptor = normalizeInkPlacementDescriptor(value)
  const fetcher = options.fetcher ?? globalThis.fetch
  const signal = options.signal
  const isCurrent = options.isCurrent ?? (() => !signal?.aborted)
  const digestBytes = options.digestBytes ?? sha256
  const createObjectUrl = options.createObjectUrl ?? ((blob) => URL.createObjectURL(blob))
  const revokeObjectUrl = options.revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url))
  if (typeof fetcher !== "function" || typeof isCurrent !== "function") throw new TypeError("Ink preview transport is invalid")
  if (!isCurrent() || signal?.aborted) return null

  const response = await fetcher(inkRepresentationContentPath(descriptor), {
    cache: "no-store",
    signal,
    headers: { Accept: "application/json" },
  })
  if (!isCurrent() || signal?.aborted) {
    await response.body?.cancel?.().catch(() => undefined)
    return null
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  if (!response.ok || mediaType !== "application/json") throw new Error("unavailable")
  const bytes = await boundedBytes(response, isCurrent, signal)
  if (!bytes || !isCurrent() || signal?.aborted) return null
  const digest = await digestBytes(bytes)
  if (!isCurrent() || signal?.aborted) return null
  if (digest !== descriptor.contentSha256) throw new Error("mismatch")

  const encoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  const svg = renderInkDocumentSvg(JSON.parse(encoded))
  if (!isCurrent() || signal?.aborted) return null
  const objectUrl = createObjectUrl(new Blob([svg], { type: "image/svg+xml" }))
  if (!isCurrent() || signal?.aborted) {
    revokeObjectUrl(objectUrl)
    return null
  }
  return objectUrl
}
