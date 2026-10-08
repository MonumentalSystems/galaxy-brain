import { inspectAtlasReferenceHandoff } from "./atlas-reference-handoff.js"

const SCHEMA_ID = "gb.atlas-reference-handoff-placement-recovery.v2"
const LEGACY_SCHEMA_ID = "gb.atlas-reference-handoff-placement-recovery.v1"
const STORAGE_PREFIX = "galaxy.atlas-reference-handoff-placement-recovery.v1"
const MAX_RECORD_BYTES = 8_192
const MAX_WORKSPACE_ID_CHARACTERS = 512
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const V4_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const SINGLE_LINE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u
const RECORD_KEYS = Object.freeze([
  "canvasId",
  "kind",
  "objectId",
  "operationId",
  "revisionSha256",
  "schemaId",
  "sourceRevisionId",
  "subjectRef",
  "workspaceId",
])
const WRITE_KEYS = Object.freeze(RECORD_KEYS.filter((key) => key !== "schemaId"))
const LEGACY_RECORD_KEYS = Object.freeze([
  "canvasId", "documentId", "documentRevisionId", "operationId",
  "revisionSha256", "schemaId", "subjectRef", "workspaceId",
])

function invalid(message) {
  throw new TypeError(`Invalid Atlas reference handoff placement recovery: ${message}`)
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

function canonicalUuid(value, label, pattern = UUID) {
  if (typeof value !== "string" || !pattern.test(value)) invalid(`${label} must be a canonical UUID`)
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

function normalizeScope(value) {
  exactObject(value, ["principalId", "tenantId"], "scope")
  return Object.freeze({
    tenantId: canonicalUuid(value.tenantId, "tenant id"),
    principalId: canonicalUuid(value.principalId, "principal id"),
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
  return `${scopePrefix(scopeValue)}${canonicalUuid(operationIdValue, "operation id", V4_UUID)}`
}

function serializedBytes(value) {
  return new TextEncoder().encode(value).byteLength
}

function normalizeRecord(value, expectedOperationId) {
  const legacy = value?.schemaId === LEGACY_SCHEMA_ID
  exactObject(value, legacy ? LEGACY_RECORD_KEYS : RECORD_KEYS, "record")
  if (!legacy && value.schemaId !== SCHEMA_ID) invalid("record has the wrong schema")

  const operationId = canonicalUuid(value.operationId, "operation id", V4_UUID)
  if (operationId !== expectedOperationId) invalid("operation does not match its storage key")
  const workspaceId = boundedString(value.workspaceId, "workspace id", MAX_WORKSPACE_ID_CHARACTERS)
  const canvasId = canonicalUuid(value.canvasId, "canvas id")
  if (typeof value.revisionSha256 !== "string" || !SHA256.test(value.revisionSha256)) {
    invalid("revision SHA-256 is invalid")
  }

  const inspected = inspectAtlasReferenceHandoff(value.subjectRef)
  if (!inspected.ok) invalid(`subject reference is invalid: ${inspected.code}`)
  if (inspected.revisionSha256 !== value.revisionSha256) {
    invalid("subject reference does not match the revision SHA-256")
  }
  const kind = legacy ? "document" : value.kind
  const objectId = legacy ? value.documentId : value.objectId
  const sourceRevisionId = legacy ? value.documentRevisionId : value.sourceRevisionId
  if (kind !== inspected.kind) invalid("subject reference does not match the object kind")
  if (objectId !== inspected.objectId) invalid("subject reference does not match the object id")
  canonicalUuid(objectId, "object id")
  if (kind === "document") canonicalUuid(sourceRevisionId, "source revision id")
  else if (sourceRevisionId !== null) invalid(`${kind} recovery must not contain a source revision id`)

  const record = Object.freeze({
    schemaId: SCHEMA_ID,
    operationId,
    workspaceId,
    canvasId,
    subjectRef: inspected.subjectRef,
    kind,
    objectId,
    sourceRevisionId,
    revisionSha256: inspected.revisionSha256,
  })
  if (serializedBytes(JSON.stringify(record)) > MAX_RECORD_BYTES) invalid("record exceeds its storage bound")
  return record
}

function removeCorrupt(storage, key) {
  try {
    storage.removeItem(key)
  } catch {
    // Cleanup failure must not make an untrusted local checkpoint readable.
  }
}

function parseStoredRecord(storage, key, raw, operationId) {
  if (raw === null) return null
  try {
    if (serializedBytes(raw) > MAX_RECORD_BYTES) invalid("record exceeds its storage bound")
    return normalizeRecord(JSON.parse(raw), operationId)
  } catch {
    removeCorrupt(storage, key)
    return null
  }
}

export function atlasReferenceHandoffPlacementRecoveryNamespace(scopeValue) {
  return scopePrefix(scopeValue)
}

/** Persist the confirmed exact source and destination before placement mutation. */
export function writeAtlasReferenceHandoffPlacementRecovery(storageValue, scopeValue, value) {
  const storage = storagePort(storageValue)
  exactObject(value, WRITE_KEYS, "write input")
  const operationId = canonicalUuid(value.operationId, "operation id", V4_UUID)
  const record = normalizeRecord({ schemaId: SCHEMA_ID, ...value }, operationId)
  storage.setItem(recordKey(scopeValue, operationId), JSON.stringify(record))
  return record
}

export function readAtlasReferenceHandoffPlacementRecovery(storageValue, scopeValue, operationIdValue) {
  const storage = storagePort(storageValue)
  const operationId = canonicalUuid(operationIdValue, "operation id", V4_UUID)
  const key = recordKey(scopeValue, operationId)
  return parseStoredRecord(storage, key, storage.getItem(key), operationId)
}

export function listAtlasReferenceHandoffPlacementRecoveries(storageValue, scopeValue) {
  const storage = storagePort(storageValue, { enumerable: true })
  const prefix = scopePrefix(scopeValue)
  const keys = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key?.startsWith(prefix)) keys.push(key)
  }

  const records = []
  for (const key of keys) {
    let operationId
    try {
      operationId = canonicalUuid(key.slice(prefix.length), "operation id", V4_UUID)
    } catch {
      removeCorrupt(storage, key)
      continue
    }
    const record = parseStoredRecord(storage, key, storage.getItem(key), operationId)
    if (record) records.push(record)
  }
  return Object.freeze(records.sort((left, right) => left.operationId.localeCompare(right.operationId)))
}

/** Remove only after authoritative placement completion for this exact operation. */
export function removeAtlasReferenceHandoffPlacementRecovery(storageValue, scopeValue, operationIdValue) {
  const storage = storagePort(storageValue)
  storage.removeItem(recordKey(scopeValue, operationIdValue))
}
