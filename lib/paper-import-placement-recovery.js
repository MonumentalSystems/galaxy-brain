import { validateDurableDocumentImport } from "./durable-document-import.js"
import { resolveIngestionPlanDefinition } from "./plugins/ingestion-plans.js"

const SCHEMA_ID = "gb.paper-import-placement-recovery.v1"
const STORAGE_PREFIX = "galaxy.paper-import-placement-recovery.v1"
const ARXIV_PLAN_ID = "arxiv.fetch-default"
const MAX_RECORD_BYTES = 65_536
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const FRESH_OPERATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const ARXIV_ID = /^[A-Za-z0-9][A-Za-z0-9./-]{0,63}$/u
const SINGLE_LINE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u
const RECORD_KEYS = Object.freeze([
  "arxiv_id",
  "arxiv_version",
  "canvasId",
  "durableDocument",
  "operationId",
  "schemaId",
  "subjectRef",
  "title",
  "workspaceId",
])
const WRITE_KEYS = Object.freeze(RECORD_KEYS.filter((key) => key !== "schemaId"))

function invalid(message) {
  throw new TypeError(`Invalid paper placement recovery: ${message}`)
}

function exactObject(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(`${label} has unexpected fields`)
  }
  return value
}

function boundedString(value, label, maximum) {
  if (
    typeof value !== "string"
    || value.length === 0
    || Array.from(value).length > maximum
    || SINGLE_LINE_CONTROL_CHARACTERS.test(value)
  ) invalid(`${label} is invalid`)
  return value
}

function uuid(value, label, pattern = UUID) {
  const normalized = typeof value === "string" ? value.toLowerCase() : ""
  if (!pattern.test(normalized)) invalid(`${label} must be a canonical UUID`)
  return normalized
}

function normalizeScope(value) {
  exactObject(value, ["principalId", "tenantId"], "scope")
  return Object.freeze({
    tenantId: uuid(value.tenantId, "tenant id"),
    principalId: uuid(value.principalId, "principal id"),
  })
}

function storagePort(storage, { enumerable = false } = {}) {
  if (
    !storage
    || typeof storage.getItem !== "function"
    || typeof storage.setItem !== "function"
    || typeof storage.removeItem !== "function"
    || (enumerable && (typeof storage.key !== "function" || typeof storage.length !== "number"))
  ) invalid(`storage must support ${enumerable ? "enumeration, " : ""}getItem, setItem, and removeItem`)
  return storage
}

function scopePrefix(scopeValue) {
  const scope = normalizeScope(scopeValue)
  return `${STORAGE_PREFIX}:${scope.tenantId}:${scope.principalId}:`
}

function recordKey(scopeValue, operationIdValue) {
  return `${scopePrefix(scopeValue)}${uuid(operationIdValue, "operation id", FRESH_OPERATION_UUID)}`
}

function removeCorrupt(storage, key) {
  try {
    storage.removeItem(key)
  } catch {
    // Failed cleanup must not revive or return untrusted local recovery data.
  }
}

function normalizeDurableDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("durable document must be an object")
  }
  let document
  try {
    if (value.source_kind === "arxiv") {
      const plan = resolveIngestionPlanDefinition(ARXIV_PLAN_ID)
      if (!plan) invalid("registered arXiv ingestion plan is unavailable")
      document = validateDurableDocumentImport(value, { ingestionPlan: plan })
    } else if (value.source_kind === "legacy-paper") {
      document = validateDurableDocumentImport(value)
    } else {
      invalid("durable document must have paper provenance")
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("Invalid paper placement recovery:")) throw error
    invalid("durable document is invalid")
  }
  if (document.media_type !== "application/pdf") invalid("durable document must be a PDF")
  return document
}

function normalizeRecord(value, expectedOperationId) {
  exactObject(value, RECORD_KEYS, "record")
  if (value.schemaId !== SCHEMA_ID) invalid("record has the wrong schema")
  const operationId = uuid(value.operationId, "operation id", FRESH_OPERATION_UUID)
  if (operationId !== expectedOperationId) invalid("operation does not match its storage key")
  const arxivId = boundedString(value.arxiv_id, "arXiv id", 64)
  if (!ARXIV_ID.test(arxivId)) invalid("arXiv id is invalid")
  if (!Number.isSafeInteger(value.arxiv_version) || value.arxiv_version < 1 || value.arxiv_version > 9_999) {
    invalid("arXiv version is invalid")
  }
  const title = boundedString(value.title, "title", 500)
  const durableDocument = normalizeDurableDocument(value.durableDocument)
  const subjectRef = boundedString(value.subjectRef, "subject reference", 4_096)
  if (subjectRef !== durableDocument.ref) invalid("subject reference must equal the pinned durable document reference")
  if (durableDocument.title !== title) invalid("display title must match the durable document")
  const expectedSourceUri = `https://arxiv.org/pdf/${arxivId}v${value.arxiv_version}`
  if (durableDocument.source_uri !== expectedSourceUri) {
    invalid("arXiv identity must match the durable document source")
  }
  const record = Object.freeze({
    schemaId: SCHEMA_ID,
    operationId,
    workspaceId: boundedString(value.workspaceId, "workspace id", 512),
    canvasId: uuid(value.canvasId, "canvas id"),
    subjectRef,
    durableDocument,
    arxiv_id: arxivId,
    arxiv_version: value.arxiv_version,
    title,
  })
  const serialized = JSON.stringify(record)
  if (new TextEncoder().encode(serialized).byteLength > MAX_RECORD_BYTES) invalid("record exceeds its storage bound")
  return record
}

function parseStoredRecord(storage, key, raw, operationId) {
  if (raw === null) return null
  try {
    return normalizeRecord(JSON.parse(raw), operationId)
  } catch {
    removeCorrupt(storage, key)
    return null
  }
}

export function paperImportPlacementRecoveryNamespace(scopeValue) {
  return scopePrefix(scopeValue)
}

export function writePaperImportPlacementRecovery(storageValue, scopeValue, value) {
  const storage = storagePort(storageValue)
  exactObject(value, WRITE_KEYS, "write input")
  const operationId = uuid(value.operationId, "operation id", FRESH_OPERATION_UUID)
  const record = normalizeRecord({ schemaId: SCHEMA_ID, ...value }, operationId)
  storage.setItem(recordKey(scopeValue, operationId), JSON.stringify(record))
  return record
}

export function readPaperImportPlacementRecovery(storageValue, scopeValue, operationIdValue) {
  const storage = storagePort(storageValue)
  const operationId = uuid(operationIdValue, "operation id", FRESH_OPERATION_UUID)
  const key = recordKey(scopeValue, operationId)
  return parseStoredRecord(storage, key, storage.getItem(key), operationId)
}

export function listPaperImportPlacementRecoveries(storageValue, scopeValue) {
  const storage = storagePort(storageValue, { enumerable: true })
  const prefix = scopePrefix(scopeValue)
  const keys = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key?.startsWith(prefix)) keys.push(key)
  }
  const records = []
  for (const key of keys) {
    const rawOperationId = key.slice(prefix.length)
    let operationId
    try {
      operationId = uuid(rawOperationId, "operation id", FRESH_OPERATION_UUID)
    } catch {
      removeCorrupt(storage, key)
      continue
    }
    const record = parseStoredRecord(storage, key, storage.getItem(key), operationId)
    if (record) records.push(record)
  }
  return Object.freeze(records.sort((left, right) => left.operationId.localeCompare(right.operationId)))
}

/** Remove only after the durable Atlas placement is confirmed. */
export function removePaperImportPlacementRecovery(storageValue, scopeValue, operationIdValue) {
  const storage = storagePort(storageValue)
  storage.removeItem(recordKey(scopeValue, operationIdValue))
}
