import {
  captureToDocumentSource,
  parseCaptureIdempotencyKey,
  parseCaptureRequest,
} from "./capture-contract.js"
import { validateDurableDocumentImport } from "./durable-document-import.js"
import { builtinPluginRegistry } from "./plugins/builtins.js"
import { resolveIngestionPlanDefinition } from "./plugins/ingestion-plans.js"

const INTENT_SCHEMA_ID = "gb.atlas-web-capture-intent.v1"
const RECOVERY_SCHEMA_ID = "gb.atlas-web-capture-placement-recovery.v1"
const STORAGE_PREFIX = "galaxy.atlas-web-capture-placement-recovery.v1"
const WEB_CAPTURE_PLAN_ID = "web.capture-default"
const WEB_CAPTURE_PLAN_VERSION = "1.0.0"
const WEB_CAPTURE_PLAN_SHA256 = "0e541cf2165e72e38baaeadd2617198bfcf064b0990f3fd8fcf927048f1ca6a8"
const MAX_REQUEST_BYTES = 4_194_304
const MAX_RESPONSE_BYTES = 1_048_576
const MAX_RECOVERY_BYTES = 65_536
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const FRESH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const CONTROL = /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u
const RESPONSE_KEYS = Object.freeze([
  "capturedAt", "document", "hamMirror", "id", "ingestion", "schemaId", "title", "transform", "url",
])
const INTENT_KEYS = Object.freeze(["capture", "idempotencyKey", "schemaId"])
const CAPTURE_INPUT_KEYS = Object.freeze(["content", "format", "title", "url"])
const RECOVERY_KEYS = Object.freeze([
  "canvasId", "captureUrl", "durableDocument", "format", "operationId", "schemaId", "subjectRef", "title", "workspaceId",
])
const RECOVERY_WRITE_KEYS = Object.freeze(RECOVERY_KEYS.filter((key) => key !== "schemaId"))

export class AtlasWebCaptureError extends Error {
  constructor(code, message, { ambiguous = false } = {}) {
    super(message)
    this.name = "AtlasWebCaptureError"
    this.code = code
    this.ambiguous = ambiguous
  }
}

function fail(code, message, options) {
  throw new AtlasWebCaptureError(code, message, options)
}

function exactObject(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_contract", `${label} must be an object.`)
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("invalid_contract", `${label} has unexpected fields.`)
  }
  return value
}

function boundedString(value, label, maximum) {
  if (
    typeof value !== "string"
    || value.length < 1
    || Array.from(value).length > maximum
    || CONTROL.test(value)
  ) fail("invalid_contract", `${label} is invalid.`)
  return value
}

function uuid(value, label, pattern = UUID) {
  const normalized = typeof value === "string" ? value.toLowerCase() : ""
  if (!pattern.test(normalized)) fail("invalid_contract", `${label} must be a canonical UUID.`)
  return normalized
}

function hexDigest(value) {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function exactRegisteredPlan() {
  const command = builtinPluginRegistry.resolve("commands", "web.capture.open")
  const source = builtinPluginRegistry.resolve("sources", "web.capture")
  const route = builtinPluginRegistry.resolve("routes", "web.capture-route")
  const registration = builtinPluginRegistry.resolve("ingestionPlans", WEB_CAPTURE_PLAN_ID)
  const plan = resolveIngestionPlanDefinition(WEB_CAPTURE_PLAN_ID)
  if (
    command?.pluginId !== "web-capture"
    || command.handler.implementationId !== "builtin.web.capture.open"
    || source?.pluginId !== "web-capture"
    || source.handler.implementationId !== "builtin.web.capture-source"
    || route?.pluginId !== "web-capture"
    || route.handler.implementationId !== "builtin.web.capture-route"
    || registration?.pluginId !== "web-capture"
    || registration.handler.implementationId !== "builtin.ingestion-plan.web-capture-default"
    || plan?.id !== WEB_CAPTURE_PLAN_ID
    || plan.version !== WEB_CAPTURE_PLAN_VERSION
    || plan.contentSha256 !== WEB_CAPTURE_PLAN_SHA256
    || plan.owner?.pluginId !== "web-capture"
    || plan.source?.contributionId !== "web.capture"
    || plan.persist?.routeId !== "document.import-route"
    || plan.persist?.originalRequired !== true
    || plan.output?.kind !== "document"
    || plan.output?.revisionPolicy !== "pinned"
  ) fail("capability_unavailable", "Web capture is unavailable because its registered capability changed.")
  return plan
}

export function atlasWebCaptureRegistered() {
  try {
    exactRegisteredPlan()
    return true
  } catch {
    return false
  }
}

export function claimAtlasWebCaptureFlight(ownerRef, generationRef) {
  if (ownerRef.current !== null) return null
  const generation = generationRef.current + 1
  generationRef.current = generation
  ownerRef.current = generation
  return generation
}

export function releaseAtlasWebCaptureFlight(ownerRef, generation) {
  if (ownerRef.current === generation) ownerRef.current = null
}

function normalizeCaptureInput(value, capturedAt) {
  exactObject(value, CAPTURE_INPUT_KEYS, "web capture input")
  try {
    return Object.freeze(parseCaptureRequest({
      url: value.url,
      title: value.title,
      format: value.format,
      content: value.content,
      selection: "",
      tags: [],
      note: "",
      region: null,
      source: "atlas",
      capturedAt,
    }))
  } catch {
    fail("invalid_capture", "Enter an http(s) provenance URL, a title, and non-empty HTML, Markdown, or text content within the stated limits.")
  }
}

export function prepareAtlasWebCaptureIntent(value, options = {}) {
  exactRegisteredPlan()
  const randomUUID = options.randomUUID ?? (() => globalThis.crypto.randomUUID())
  const now = options.now ?? (() => new Date())
  const operationId = uuid(randomUUID(), "capture operation id", FRESH_UUID)
  const capturedAt = now().toISOString()
  const capture = normalizeCaptureInput(value, capturedAt)
  return Object.freeze({
    schemaId: INTENT_SCHEMA_ID,
    capture,
    idempotencyKey: parseCaptureIdempotencyKey(`atlas-web-capture:${operationId}`),
  })
}

function validateIntent(value) {
  exactObject(value, INTENT_KEYS, "web capture intent")
  if (value.schemaId !== INTENT_SCHEMA_ID) fail("invalid_contract", "Web capture intent has the wrong schema.")
  const capture = normalizeCaptureInput({
    url: value.capture?.url,
    title: value.capture?.title,
    format: value.capture?.format,
    content: value.capture?.content,
  }, value.capture?.capturedAt)
  if (JSON.stringify(capture) !== JSON.stringify(value.capture)) {
    fail("invalid_contract", "Web capture intent changed after it was frozen.")
  }
  return Object.freeze({
    schemaId: INTENT_SCHEMA_ID,
    capture,
    idempotencyKey: parseCaptureIdempotencyKey(value.idempotencyKey),
  })
}

async function readBoundedJson(response) {
  const ambiguous = response.ok || response.status >= 500
  if (!response.body) fail("invalid_response", "Galaxy returned an empty web capture confirmation.", { ambiguous })
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel("Web capture confirmation exceeded its client bound")
        fail("response_too_large", "Galaxy returned an oversized web capture confirmation.", { ambiguous })
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof AtlasWebCaptureError) throw error
    fail("invalid_response", "Galaxy returned an invalid web capture confirmation.", { ambiguous })
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    fail("invalid_response", "Galaxy returned an invalid web capture confirmation.", { ambiguous })
  }
}

async function validateCaptureResponse(payload, intent) {
  try {
    exactObject(payload, RESPONSE_KEYS, "web capture confirmation")
  } catch {
    fail("invalid_response", "Galaxy returned an invalid web capture confirmation.", { ambiguous: true })
  }
  if (
    payload.schemaId !== "gb.web-capture.result.v1"
    || payload.url !== intent.capture.url
    || payload.title !== intent.capture.title
    || payload.capturedAt !== intent.capture.capturedAt
  ) fail("response_mismatch", "Galaxy confirmed a different web capture.", { ambiguous: true })

  const plan = exactRegisteredPlan()
  let document
  try {
    document = validateDurableDocumentImport(payload.document, { ingestionPlan: plan })
  } catch {
    fail("invalid_document", "Galaxy did not return an exact pinned durable document.", { ambiguous: true })
  }
  const source = captureToDocumentSource(intent.capture)
  const contentSha256 = hexDigest(await globalThis.crypto.subtle.digest("SHA-256", source.bytes))
  if (
    document.source_kind !== "url"
    || document.source_uri !== intent.capture.url
    || document.title !== intent.capture.title
    || document.media_type !== source.mediaType
    || document.byte_size !== source.bytes.byteLength
    || document.content_sha256 !== contentSha256
    || document.original_filename !== source.filename
  ) fail("document_mismatch", "Galaxy stored different bytes or provenance than this frozen web capture.", { ambiguous: true })
  return document
}

export async function captureAtlasWebContent(intentValue, options = {}) {
  const intent = validateIntent(intentValue)
  exactRegisteredPlan()
  const body = new TextEncoder().encode(JSON.stringify(intent.capture))
  if (body.byteLength > MAX_REQUEST_BYTES) {
    fail("request_too_large", "This capture exceeds the 4 MiB request limit.")
  }
  const fetcher = options.fetcher ?? globalThis.fetch
  let response
  try {
    response = await fetcher("/api/capture", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": intent.idempotencyKey,
      },
      body,
      cache: "no-store",
      redirect: "error",
      signal: options.signal,
    })
  } catch (error) {
    if (error?.name === "AbortError") throw error
    fail("request_failed", "Galaxy could not confirm whether this capture was stored. Retry the frozen capture; do not edit it.", { ambiguous: true })
  }
  const payload = await readBoundedJson(response)
  if (!response.ok) {
    const ambiguous = response.status >= 500
    fail(
      response.status === 409 ? "replay_conflict" : "capture_rejected",
      response.status === 409
        ? "This frozen capture key conflicts with a different durable request."
        : ambiguous
          ? "Galaxy could not confirm whether this capture was stored. Retry the frozen capture; do not edit it."
          : "Galaxy rejected this web capture. Check the fields and try again.",
      { ambiguous },
    )
  }
  return validateCaptureResponse(payload, intent)
}

function normalizeScope(value) {
  exactObject(value, ["principalId", "tenantId"], "web capture recovery scope")
  return Object.freeze({
    tenantId: uuid(value.tenantId, "tenant id"),
    principalId: uuid(value.principalId, "principal id"),
  })
}

function scopePrefix(scopeValue) {
  const scope = normalizeScope(scopeValue)
  return `${STORAGE_PREFIX}:${scope.tenantId}:${scope.principalId}:`
}

function storagePort(storage, enumerable = false) {
  if (
    !storage
    || typeof storage.getItem !== "function"
    || typeof storage.setItem !== "function"
    || typeof storage.removeItem !== "function"
    || (enumerable && (typeof storage.key !== "function" || typeof storage.length !== "number"))
  ) fail("invalid_recovery", "Web capture recovery storage is unavailable.")
  return storage
}

function recoveryKey(scope, operationId) {
  return `${scopePrefix(scope)}${uuid(operationId, "placement operation id", FRESH_UUID)}`
}

function normalizeRecovery(value) {
  exactObject(value, RECOVERY_KEYS, "web capture placement recovery")
  if (value.schemaId !== RECOVERY_SCHEMA_ID) fail("invalid_recovery", "Web capture recovery has the wrong schema.")
  const operationId = uuid(value.operationId, "placement operation id", FRESH_UUID)
  const captureUrl = normalizeCaptureInput({
    url: value.captureUrl,
    title: value.title,
    format: value.format,
    content: "placeholder",
  }, "2026-01-01T00:00:00.000Z").url
  const plan = exactRegisteredPlan()
  let document
  try {
    document = validateDurableDocumentImport(value.durableDocument, { ingestionPlan: plan })
  } catch {
    fail("invalid_recovery", "Web capture recovery document is invalid.")
  }
  const expectedMediaType = { html: "text/html", markdown: "text/markdown", text: "text/plain" }[value.format]
  if (
    document.source_kind !== "url"
    || document.source_uri !== captureUrl
    || document.title !== value.title
    || document.media_type !== expectedMediaType
    || value.subjectRef !== document.ref
  ) fail("invalid_recovery", "Web capture recovery does not match its durable document.")
  const record = Object.freeze({
    schemaId: RECOVERY_SCHEMA_ID,
    operationId,
    workspaceId: boundedString(value.workspaceId, "workspace id", 512),
    canvasId: uuid(value.canvasId, "canvas id"),
    subjectRef: boundedString(value.subjectRef, "subject reference", 4_096),
    durableDocument: document,
    captureUrl,
    title: boundedString(value.title, "title", 400),
    format: value.format,
  })
  if (new TextEncoder().encode(JSON.stringify(record)).byteLength > MAX_RECOVERY_BYTES) {
    fail("invalid_recovery", "Web capture recovery exceeds its storage bound.")
  }
  return record
}

export function createAtlasWebCapturePlacementRecovery(value) {
  exactObject(value, RECOVERY_WRITE_KEYS, "web capture placement recovery input")
  return normalizeRecovery({ schemaId: RECOVERY_SCHEMA_ID, ...value })
}

export function atlasWebCapturePlacementRecoveryNamespace(scope) {
  return scopePrefix(scope)
}

export function writeAtlasWebCapturePlacementRecovery(storageValue, scope, value) {
  const storage = storagePort(storageValue)
  const record = createAtlasWebCapturePlacementRecovery(value)
  storage.setItem(recoveryKey(scope, record.operationId), JSON.stringify(record))
  return record
}

function removeCorrupt(storage, key) {
  try { storage.removeItem(key) } catch {}
}

export function listAtlasWebCapturePlacementRecoveries(storageValue, scope) {
  const storage = storagePort(storageValue, true)
  const prefix = scopePrefix(scope)
  const keys = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key?.startsWith(prefix)) keys.push(key)
  }
  const records = []
  for (const key of keys) {
    try {
      const operationId = uuid(key.slice(prefix.length), "placement operation id", FRESH_UUID)
      const parsed = normalizeRecovery(JSON.parse(storage.getItem(key)))
      if (parsed.operationId !== operationId) throw new TypeError("recovery key mismatch")
      records.push(parsed)
    } catch {
      removeCorrupt(storage, key)
    }
  }
  return Object.freeze(records.sort((left, right) => left.operationId.localeCompare(right.operationId)))
}

export function removeAtlasWebCapturePlacementRecovery(storageValue, scope, operationId) {
  storagePort(storageValue).removeItem(recoveryKey(scope, operationId))
}
