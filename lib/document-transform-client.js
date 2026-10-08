export const DOCUMENT_TRANSFORM_RESPONSE_SCHEMA = "gb.document.transform.v1"
import { parseDocumentLocalIndexStatus } from "./document-local-index.js"

export const DOCUMENT_TRANSFORM_OPERATION_SCHEMA = "gb.document-transform-operation.v1"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const RECEIPT_STATUSES = new Set(["success", "partial", "fallback", "failed", "skipped"])
const REPRESENTATION_KINDS = new Set(["original", "document-structure", "markdown", "text", "thumbnail"])
const MAX_REPRESENTATIONS = 128
const MAX_TEXT_CONTENT_CHARS = 8_000_000
const DEFAULT_MAX_POLLS = 8
const DEFAULT_RETRY_MS = 5_000
const MIN_RETRY_MS = 250
const MAX_RETRY_MS = 30_000

export class DocumentTransformClientError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined)
    this.name = "DocumentTransformClientError"
    this.code = code
    this.retryable = options.retryable === true
    this.status = Number.isSafeInteger(options.status) ? options.status : null
  }
}

function invalidResponse(message = "Galaxy Brain returned an invalid document transform response.") {
  throw new DocumentTransformClientError("invalid-response", message, { retryable: true })
}

function normalizedRevisionId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new DocumentTransformClientError(
      "invalid-document-revision",
      "Document analysis requires an exact document revision.",
    )
  }
  return value.toLowerCase()
}

function boundedString(value, label, maximum = 512, { nullable = false } = {}) {
  if (nullable && value === null) return null
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    invalidResponse(`${label} is invalid.`)
  }
  return value
}

function validateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse()
  if (value.schemaId !== undefined && value.schemaId !== "gb.transform-output-manifest.v1") invalidResponse()
  if (value.representations !== undefined) {
    if (!Array.isArray(value.representations) || value.representations.length > MAX_REPRESENTATIONS) invalidResponse()
    for (const representation of value.representations) {
      if (!representation || typeof representation !== "object" || Array.isArray(representation)) invalidResponse()
    }
  }
  return value
}

function validateReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse()
  boundedString(value.id, "Transform receipt id")
  boundedString(value.plugin_id, "Transform plugin id", 128)
  boundedString(value.plugin_version, "Transform plugin version", 128)
  boundedString(value.engine, "Transform engine", 128)
  boundedString(value.engine_version, "Transform engine version", 128)
  if (!SHA256_PATTERN.test(value.config_sha256) || !SHA256_PATTERN.test(value.input_sha256)) invalidResponse()
  if (value.output_sha256 !== null && !SHA256_PATTERN.test(value.output_sha256)) invalidResponse()
  if (value.output_representation_id !== null && value.output_representation_id !== undefined) {
    boundedString(value.output_representation_id, "Output representation id")
  }
  if (!RECEIPT_STATUSES.has(value.status)) invalidResponse()
  if (value.diagnostic_code !== null) boundedString(value.diagnostic_code, "Transform diagnostic code", 128)
  validateManifest(value.output_manifest)
  if (value.fallback_receipt_id !== null) boundedString(value.fallback_receipt_id, "Fallback receipt id")
  boundedString(value.created_at, "Transform receipt time", 128)
  return value
}

function validateReceiptCoherence(receipt, representations, originalDigests) {
  if (!originalDigests.has(receipt.input_sha256)) invalidResponse()
  const successful = new Set(["success", "partial", "fallback"]).has(receipt.status)
  if (successful) {
    if (typeof receipt.output_representation_id !== "string" || !receipt.output_sha256) invalidResponse()
    const output = representations.find((item) => item.id === receipt.output_representation_id)
    if (!output || output.content_sha256 !== receipt.output_sha256) invalidResponse()
  } else if (receipt.output_representation_id != null || receipt.output_sha256 !== null) {
    invalidResponse()
  }
  const manifested = receipt.output_manifest.representations
  if (!Array.isArray(manifested)) invalidResponse()
  const manifestedIds = new Set()
  for (const item of manifested) {
    if (
      typeof item.id !== "string" || manifestedIds.has(item.id)
      || typeof item.kind !== "string" || typeof item.mediaType !== "string"
      || !SHA256_PATTERN.test(item.contentSha256)
    ) invalidResponse()
    manifestedIds.add(item.id)
    const representation = representations.find((candidate) => candidate.id === item.id)
    if (
      !representation || representation.kind !== item.kind
      || representation.media_type !== item.mediaType
      || representation.content_sha256 !== item.contentSha256
    ) invalidResponse()
  }
  if (successful && !manifestedIds.has(receipt.output_representation_id)) invalidResponse()
  if (!successful && manifested.length !== 0) invalidResponse()
}

function validateRepresentation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse()
  boundedString(value.id, "Representation id")
  if (!REPRESENTATION_KINDS.has(value.kind)) invalidResponse()
  boundedString(value.media_type, "Representation media type", 256)
  if (!SHA256_PATTERN.test(value.content_sha256)) invalidResponse()
  if (value.artifact_id !== null && value.artifact_id !== undefined) boundedString(value.artifact_id, "Representation artifact id")
  if (value.kind === "document-structure") {
    if (!value.content || typeof value.content !== "object" || Array.isArray(value.content)) invalidResponse()
  } else if (value.content !== null && typeof value.content !== "string") {
    invalidResponse()
  }
  if (typeof value.content === "string" && value.content.length > MAX_TEXT_CONTENT_CHARS) invalidResponse()
  boundedString(value.created_at, "Representation creation time", 128)
  return value
}

export function validateDocumentTransformResponse(value, expectedRevisionId) {
  const revisionId = normalizedRevisionId(expectedRevisionId)
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse()
  if (
    value.schemaId !== DOCUMENT_TRANSFORM_RESPONSE_SCHEMA
    || value.persisted !== true
    || typeof value.document_revision_id !== "string"
    || value.document_revision_id.toLowerCase() !== revisionId
  ) {
    invalidResponse()
  }
  if (value.status === "running") {
    if (value.replayed !== true && value.replayed !== false) invalidResponse()
    return {
      schemaId: DOCUMENT_TRANSFORM_RESPONSE_SCHEMA,
      persisted: true,
      document_revision_id: revisionId,
      status: "running",
      replayed: value.replayed,
    }
  }
  if (!Array.isArray(value.representations) || value.representations.length > MAX_REPRESENTATIONS) invalidResponse()
  value.representations.forEach(validateRepresentation)
  const representationIds = new Set(value.representations.map((representation) => representation.id))
  if (representationIds.size !== value.representations.length) invalidResponse()
  const originalDigests = new Set(
    value.representations
      .filter((representation) => representation.kind === "original")
      .map((representation) => representation.content_sha256),
  )
  if (originalDigests.size !== 1) invalidResponse()
  const receipt = validateReceipt(value.receipt)
  const fallbackReceipt = value.fallbackReceipt === null ? null : validateReceipt(value.fallbackReceipt)
  validateReceiptCoherence(receipt, value.representations, originalDigests)
  if ((receipt.fallback_receipt_id === null) !== (fallbackReceipt === null)) invalidResponse()
  if (fallbackReceipt) {
    if (receipt.fallback_receipt_id !== fallbackReceipt.id) invalidResponse()
    validateReceiptCoherence(fallbackReceipt, value.representations, originalDigests)
  }
  if (value.replayed !== true && value.replayed !== false) invalidResponse()
  return {
    schemaId: DOCUMENT_TRANSFORM_RESPONSE_SCHEMA,
    persisted: true,
    document_revision_id: revisionId,
    representations: value.representations,
    local_index: parseDocumentLocalIndexStatus(value.local_index),
    receipt,
    fallbackReceipt,
    replayed: value.replayed,
  }
}

export function retryAfterMilliseconds(value, now = Date.now()) {
  if (typeof value !== "string" || !value.trim()) return DEFAULT_RETRY_MS
  const normalized = value.trim()
  let milliseconds
  if (/^\d+(?:\.\d+)?$/.test(normalized)) milliseconds = Number(normalized) * 1_000
  else {
    const date = Date.parse(normalized)
    milliseconds = Number.isFinite(date) ? date - now : DEFAULT_RETRY_MS
  }
  if (!Number.isFinite(milliseconds)) milliseconds = DEFAULT_RETRY_MS
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, Math.ceil(milliseconds)))
}

function operationStorageKey(scope, revisionId, reprocess = false) {
  const normalizedScope = typeof scope === "string" && scope.trim() ? scope.trim() : "default"
  if (normalizedScope.length > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(normalizedScope)) {
    throw new DocumentTransformClientError("invalid-operation-scope", "Document analysis operation scope is invalid.")
  }
  const mode = reprocess ? ":reprocess" : ""
  return `${DOCUMENT_TRANSFORM_OPERATION_SCHEMA}:${encodeURIComponent(normalizedScope)}:${revisionId}${mode}`
}

function readOperation(storage, key, revisionId) {
  let raw
  try {
    raw = storage.getItem(key)
  } catch (error) {
    throw new DocumentTransformClientError(
      "operation-storage-unavailable",
      "Document analysis cannot safely preserve its retry identity.",
      { cause: error },
    )
  }
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    if (
      value?.schemaId !== DOCUMENT_TRANSFORM_OPERATION_SCHEMA
      || value.documentRevisionId !== revisionId
      || typeof value.idempotencyKey !== "string"
      || value.idempotencyKey.length < 8
      || value.idempotencyKey.length > 200
      || [...value.idempotencyKey].some((character) => character.charCodeAt(0) < 33 || character.charCodeAt(0) > 126)
      || typeof value.startedAt !== "string"
    ) {
      throw new Error("invalid operation")
    }
    return value
  } catch {
    try { storage.removeItem(key) } catch { /* A later write reports unavailable storage. */ }
    return null
  }
}

function writeOperation(storage, key, operation) {
  try {
    storage.setItem(key, JSON.stringify(operation))
  } catch (error) {
    throw new DocumentTransformClientError(
      "operation-storage-unavailable",
      "Document analysis cannot safely preserve its retry identity.",
      { cause: error },
    )
  }
}

function clearOperation(storage, key) {
  try { storage.removeItem(key) } catch { /* A terminal server result remains authoritative. */ }
}

function safeHttpError(status, { retryable }) {
  const code = status === 401 || status === 403
    ? "not-authorized"
    : status === 404
      ? "document-not-found"
      : status === 409
        ? "transform-conflict"
        : status === 413
          ? "document-too-large"
          : status === 429
            ? "temporarily-limited"
            : retryable
              ? "service-unavailable"
              : "request-rejected"
  const message = code === "not-authorized"
    ? "You do not have access to analyze this document."
    : code === "document-not-found"
      ? "This exact document revision is no longer available."
      : code === "transform-conflict"
        ? "Document analysis could not reconcile this attempt. Start a new attempt."
        : code === "document-too-large"
          ? "This document is too large to analyze."
          : code === "temporarily-limited"
            ? "Document analysis is temporarily busy."
            : code === "service-unavailable"
              ? "Document analysis is temporarily unavailable."
              : "Document analysis was rejected."
  return new DocumentTransformClientError(code, message, { retryable, status })
}

function abortableDelay(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", onAbort)
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export function createDocumentTransformClient(options = {}) {
  const fetcher = options.fetcher ?? fetch
  const storage = options.storage ?? globalThis.localStorage
  const createIdempotencyKey = options.createIdempotencyKey ?? (() => crypto.randomUUID())
  const delay = options.delay ?? abortableDelay
  const endpointBase = options.endpointBase ?? "/api/eln"
  const maxPolls = options.maxPolls ?? DEFAULT_MAX_POLLS
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function" || typeof storage.removeItem !== "function") {
    throw new DocumentTransformClientError("operation-storage-unavailable", "Document analysis requires durable operation storage.")
  }
  if (!Number.isSafeInteger(maxPolls) || maxPolls < 0 || maxPolls > 100) {
    throw new DocumentTransformClientError("invalid-poll-limit", "Document analysis poll limit is invalid.")
  }

  return {
    async transform(documentRevisionId, requestOptions = {}) {
      const revisionId = normalizedRevisionId(documentRevisionId)
      const reprocess = requestOptions.reprocess === true
      const key = operationStorageKey(requestOptions.scope, revisionId, reprocess)
      let operation = readOperation(storage, key, revisionId)
      if (!operation) {
        const idempotencyKey = createIdempotencyKey()
        if (
          typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 200
          || [...idempotencyKey].some((character) => character.charCodeAt(0) < 33 || character.charCodeAt(0) > 126)
        ) {
          throw new DocumentTransformClientError("invalid-idempotency-key", "Document analysis could not create a retry identity.")
        }
        operation = {
          schemaId: DOCUMENT_TRANSFORM_OPERATION_SCHEMA,
          documentRevisionId: revisionId,
          idempotencyKey,
          startedAt: new Date().toISOString(),
        }
        writeOperation(storage, key, operation)
      }

      for (let poll = 0; poll <= maxPolls; poll += 1) {
        let response
        try {
          response = await fetcher(
            `${endpointBase}/documents/${encodeURIComponent(revisionId)}/transform`,
            {
              method: "POST",
              headers: {
                "Idempotency-Key": operation.idempotencyKey,
                ...(reprocess ? { "X-GB-Transform-Mode": "reprocess" } : {}),
              },
              signal: requestOptions.signal,
            },
          )
        } catch (error) {
          if (requestOptions.signal?.aborted || error?.name === "AbortError") throw error
          throw new DocumentTransformClientError(
            "network-uncertain",
            "The document analysis response was interrupted. Resume to reconcile the same attempt.",
            { retryable: true, cause: error },
          )
        }

        let payload
        try { payload = await response.json() } catch (error) {
          if (!response.ok) {
            const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500
            if (!retryable) clearOperation(storage, key)
            throw safeHttpError(response.status, { retryable })
          }
          throw new DocumentTransformClientError(
            "invalid-response",
            "Galaxy Brain returned an invalid document transform response. Resume to reconcile the same attempt.",
            { retryable: true, cause: error },
          )
        }
        let result
        try {
          result = validateDocumentTransformResponse(payload, revisionId)
        } catch (error) {
          if (!response.ok) {
            const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500
            if (!retryable) clearOperation(storage, key)
            throw safeHttpError(response.status, { retryable })
          }
          throw error
        }
        if (result.status !== "running") {
          if (response.status === 202) invalidResponse()
          clearOperation(storage, key)
          return result
        }
        if (response.status !== 202) invalidResponse()
        if (poll === maxPolls) {
          return {
            ...result,
            retryAfterMs: retryAfterMilliseconds(response.headers.get("Retry-After")),
            pollingExhausted: true,
          }
        }
        await delay(retryAfterMilliseconds(response.headers.get("Retry-After")), requestOptions.signal)
      }
      throw new DocumentTransformClientError("invalid-state", "Document analysis entered an invalid state.")
    },
  }
}
