import { conversationMarkdownExportPath } from "./conversation-graph-client.js"
import { parseGalaxyObjectReference } from "./galaxy-object-reference.js"

export const CONVERSATION_MARKDOWN_EXPORT_MAX_BYTES = 16_777_216
const MEDIA_TYPE = "text/markdown; charset=utf-8"
const SHA256 = /^[0-9a-f]{64}$/u
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu
const UNSAFE_FILENAME = /[<>:"/\\|?*\x00-\x1f\x7f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u

export class ConversationMarkdownDownloadError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "ConversationMarkdownDownloadError"
    this.code = code
  }
}

async function readBoundedBytes(response) {
  const declared = response.headers.get("content-length")
  if (declared !== null && (!/^\d+$/u.test(declared)
    || Number(declared) > CONVERSATION_MARKDOWN_EXPORT_MAX_BYTES)) {
    throw new ConversationMarkdownDownloadError("invalid_response", "Conversation export exceeded its download bound.")
  }
  if (!response.body) {
    throw new ConversationMarkdownDownloadError("invalid_response", "Conversation export returned no content.")
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > CONVERSATION_MARKDOWN_EXPORT_MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new ConversationMarkdownDownloadError("invalid_response", "Conversation export exceeded its download bound.")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (declared !== null && Number(declared) !== total) {
    throw new ConversationMarkdownDownloadError("invalid_response", "Conversation export response length could not be verified.")
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function browserSha256(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new ConversationMarkdownDownloadError("transport_unavailable", "Secure download verification is unavailable.")
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function safeFilename(header, fallback) {
  let candidate = null
  const encoded = /(?:^|;)\s*filename\*=UTF-8''([^;]+)/iu.exec(header || "")
  if (encoded) {
    try {
      candidate = decodeURIComponent(encoded[1])
    } catch {
      candidate = null
    }
  }
  if (!candidate) candidate = /(?:^|;)\s*filename="([^"]+)"/iu.exec(header || "")?.[1] ?? null
  candidate = candidate?.normalize("NFKC") ?? null
  if (!candidate || candidate.length > 180 || !candidate.endsWith(".md")
    || UNSAFE_FILENAME.test(candidate) || WINDOWS_RESERVED.test(candidate)
    || candidate.startsWith(".") || candidate.endsWith(".")) return fallback
  return candidate
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError")
}

export async function fetchConversationMarkdownExport(conversationReference, options = {}) {
  const parsed = parseGalaxyObjectReference(conversationReference)
  const path = conversationMarkdownExportPath(conversationReference)
  const fetcher = options.fetcher ?? globalThis.fetch
  if (typeof fetcher !== "function" || !parsed || parsed.kind !== "chat" || parsed.selector.mode !== "pinned") {
    throw new ConversationMarkdownDownloadError("transport_unavailable", "Conversation download transport is unavailable.")
  }
  let response
  try {
    response = await fetcher(path, {
      method: "GET",
      headers: { Accept: MEDIA_TYPE },
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error
    throw new ConversationMarkdownDownloadError("transport_error", "Conversation Markdown download is unavailable.")
  }
  throwIfAborted(options.signal)
  if (response.redirected) {
    throw new ConversationMarkdownDownloadError("invalid_response", "Conversation export redirected unexpectedly.")
  }
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403
      ? "Conversation export authorization is no longer valid."
      : [404, 409, 413, 422].includes(response.status)
        ? "The exact conversation snapshot is not exportable."
        : "Conversation Markdown download is unavailable."
    throw new ConversationMarkdownDownloadError("request_failed", message)
  }
  if (response.headers.get("content-type")?.toLowerCase() !== MEDIA_TYPE) {
    throw new ConversationMarkdownDownloadError("invalid_response", "Conversation export media type could not be verified.")
  }
  const expectedDigest = response.headers.get("x-content-sha256")
  if (!expectedDigest || !SHA256.test(expectedDigest)
    || response.headers.get("etag") !== `"sha256-${expectedDigest}"`) {
    throw new ConversationMarkdownDownloadError("invalid_response", "Conversation export integrity metadata is invalid.")
  }
  const bytes = await readBoundedBytes(response)
  throwIfAborted(options.signal)
  const digest = await (options.digest ?? browserSha256)(bytes)
  throwIfAborted(options.signal)
  if (digest !== expectedDigest) {
    throw new ConversationMarkdownDownloadError("invalid_response", "Conversation export content failed integrity verification.")
  }
  const revision = parsed.selector.revision.slice("sha256:".length, "sha256:".length + 12)
  return Object.freeze({
    blob: new Blob([bytes], { type: MEDIA_TYPE }),
    filename: safeFilename(response.headers.get("content-disposition"), `conversation--${revision}.md`),
    contentSha256: digest,
    byteLength: bytes.byteLength,
  })
}

export function saveConversationMarkdownExport(exported, options = {}) {
  const documentValue = options.documentValue ?? globalThis.document
  const createObjectURL = options.createObjectURL ?? globalThis.URL?.createObjectURL?.bind(globalThis.URL)
  const revokeObjectURL = options.revokeObjectURL ?? globalThis.URL?.revokeObjectURL?.bind(globalThis.URL)
  const scheduleCleanup = options.scheduleCleanup ?? ((callback) => globalThis.setTimeout(callback, 0))
  if (!documentValue?.body || typeof documentValue.createElement !== "function"
    || typeof createObjectURL !== "function" || typeof revokeObjectURL !== "function"
    || typeof scheduleCleanup !== "function") {
    throw new ConversationMarkdownDownloadError("transport_unavailable", "Browser download controls are unavailable.")
  }
  const objectUrl = createObjectURL(exported.blob)
  const anchor = documentValue.createElement("a")
  anchor.href = objectUrl
  anchor.download = exported.filename
  anchor.hidden = true
  documentValue.body.append(anchor)
  try {
    anchor.click()
    anchor.remove()
    scheduleCleanup(() => revokeObjectURL(objectUrl))
  } catch (error) {
    anchor.remove()
    revokeObjectURL(objectUrl)
    throw error
  }
}

export async function downloadConversationMarkdown(conversationReference, options = {}) {
  const exported = await fetchConversationMarkdownExport(conversationReference, options)
  ;(options.saver ?? saveConversationMarkdownExport)(exported, options)
  return exported
}
