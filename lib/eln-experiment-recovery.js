import { parseGalaxyObjectReference } from "./galaxy-object-reference.js"

const CREATE_SCHEMA_ID = "gb.eln-experiment-create-recovery.v1"
const PLACEMENT_SCHEMA_ID = "gb.eln-experiment-placement-recovery.v1"
const OBSERVATION_SCHEMA_ID = "gb.eln-observation-create-recovery.v1"
const STORAGE_PREFIX = "galaxy.eln-experiment-recovery.v1"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uD800-\uDFFF]/u
const SINGLE_LINE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u
const RFC3339_TIMESTAMP = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/u
const CREATE_INPUT_KEYS = Object.freeze([
  "domain",
  "hypothesis",
  "title",
  "wandb_project",
  "wandb_run_id",
])

function validRfc3339CalendarDate(value) {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})/u.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
}

function invalid(message) {
  throw new TypeError(`Invalid ELN experiment recovery: ${message}`)
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

function characterCount(value) {
  return Array.from(value).length
}

function boundedString(value, label, maximum, { empty = false, multiline = false } = {}) {
  if (
    typeof value !== "string"
    || (!empty && value.length === 0)
    || characterCount(value) > maximum
    || (multiline ? CONTROL_CHARACTERS : SINGLE_LINE_CONTROL_CHARACTERS).test(value)
  ) invalid(`${label} is invalid`)
  return value
}

function uuid(value, label) {
  const normalized = typeof value === "string" ? value.toLowerCase() : ""
  if (!UUID.test(normalized)) invalid(`${label} must be a UUID`)
  return normalized
}

function experimentIdentity(value) {
  return boundedString(value, "experiment id", 200)
}

function normalizeScope(value) {
  exactObject(value, ["principalId", "tenantId"], "scope")
  return Object.freeze({
    tenantId: uuid(value.tenantId, "tenant id"),
    principalId: uuid(value.principalId, "principal id"),
  })
}

function normalizeCreateInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("create input must be an object")
  const keys = Object.keys(value)
  if (!keys.includes("title") || keys.some((key) => !CREATE_INPUT_KEYS.includes(key))) {
    invalid("create input has unexpected fields")
  }
  const normalized = {
    title: boundedString(value.title, "create title", 512),
  }
  if (Object.hasOwn(value, "hypothesis")) {
    normalized.hypothesis = boundedString(value.hypothesis, "create hypothesis", 20_000, {
      empty: true,
      multiline: true,
    })
  }
  if (Object.hasOwn(value, "domain")) {
    normalized.domain = boundedString(value.domain, "create domain", 128)
  }
  for (const key of ["wandb_run_id", "wandb_project"]) {
    if (Object.hasOwn(value, key)) normalized[key] = boundedString(value[key], key, 512)
  }
  return Object.freeze(normalized)
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

function recordKey(scopeValue, state, operationIdValue) {
  return `${scopePrefix(scopeValue)}${state}:${uuid(operationIdValue, "operation id")}`
}

function removeCorrupt(storage, key) {
  try {
    storage.removeItem(key)
  } catch {
    // A failed localStorage cleanup must not revive or return untrusted data.
  }
}

function normalizeCreateRecord(value, expectedOperationId) {
  exactObject(value, ["input", "operationId", "schemaId", "state"], "pending create record")
  if (value.schemaId !== CREATE_SCHEMA_ID || value.state !== "pending-create") {
    invalid("pending create record has the wrong schema or state")
  }
  const operationId = uuid(value.operationId, "operation id")
  if (operationId !== expectedOperationId) invalid("pending create operation does not match its key")
  return Object.freeze({
    schemaId: CREATE_SCHEMA_ID,
    state: "pending-create",
    operationId,
    input: normalizeCreateInput(value.input),
  })
}

function normalizePlacementRecord(value, expectedOperationId) {
  exactObject(
    value,
    ["canvasId", "experimentId", "operationId", "schemaId", "state", "subjectRef", "title", "workspaceId"],
    "pending placement record",
  )
  if (value.schemaId !== PLACEMENT_SCHEMA_ID || value.state !== "pending-placement") {
    invalid("pending placement record has the wrong schema or state")
  }
  const operationId = uuid(value.operationId, "operation id")
  const experimentId = experimentIdentity(value.experimentId)
  if (operationId !== expectedOperationId) invalid("pending placement operation does not match its key")
  const subjectRef = boundedString(value.subjectRef, "placement subject reference", 16_384)
  const parsed = parseGalaxyObjectReference(subjectRef)
  if (
    !parsed
    || parsed.format !== "canonical"
    || parsed.kind !== "eln.experiment"
    || parsed.id !== experimentId
    || parsed.selector.mode !== "latest"
  ) invalid("placement subject reference must name the latest created experiment")
  return Object.freeze({
    schemaId: PLACEMENT_SCHEMA_ID,
    state: "pending-placement",
    operationId,
    experimentId,
    title: boundedString(value.title, "placement title", 512),
    subjectRef,
    workspaceId: boundedString(value.workspaceId, "placement workspace id", 512),
    canvasId: value.canvasId === null ? null : uuid(value.canvasId, "placement canvas id"),
  })
}

function normalizeObservationRequest(value) {
  exactObject(value, ["body", "observedAt", "schemaId"], "observation request")
  if (value.schemaId !== "gb.eln-observation-create.v1") invalid("observation request has the wrong schema")
  if (typeof value.body !== "string") invalid("observation body is invalid")
  const body = value.body.trim()
  boundedString(body, "observation body", 4000, { multiline: true })
  let observedAt = null
  if (value.observedAt !== null) {
    observedAt = boundedString(value.observedAt, "observation time", 64)
    const parsed = new Date(observedAt)
    const normalized = Number.isFinite(parsed.getTime()) ? parsed.toISOString() : ""
    if (!RFC3339_TIMESTAMP.test(observedAt)
      || !validRfc3339CalendarDate(observedAt)
      || !/^\d{4}-/u.test(normalized)
      || normalized.startsWith("0000-")) {
      invalid("observation time is invalid")
    }
    observedAt = normalized.replace(/\.([0-9]{3})Z$/u, ".$1000Z")
  }
  return Object.freeze({ schemaId: "gb.eln-observation-create.v1", body, observedAt })
}

function normalizeObservationRecord(value, expectedOperationId, expectedExperimentId) {
  exactObject(value, ["experimentId", "operationId", "request", "schemaId", "state"], "pending observation record")
  if (value.schemaId !== OBSERVATION_SCHEMA_ID || value.state !== "pending-observation") {
    invalid("pending observation record has the wrong schema or state")
  }
  const operationId = uuid(value.operationId, "operation id")
  const experimentId = experimentIdentity(value.experimentId)
  if (operationId !== expectedOperationId || experimentId !== expectedExperimentId) {
    invalid("pending observation identity does not match its key")
  }
  return Object.freeze({
    schemaId: OBSERVATION_SCHEMA_ID,
    state: "pending-observation",
    operationId,
    experimentId,
    request: normalizeObservationRequest(value.request),
  })
}

function observationRecordKey(scopeValue, experimentIdValue, operationIdValue) {
  return `${scopePrefix(scopeValue)}observation:${encodeURIComponent(experimentIdentity(experimentIdValue))}:${uuid(operationIdValue, "operation id")}`
}

function parseStoredRecord(storage, key, raw, operationId, normalize) {
  if (raw === null) return null
  try {
    return normalize(JSON.parse(raw), operationId)
  } catch {
    removeCorrupt(storage, key)
    return null
  }
}

function listRecords(storageValue, scopeValue, state, normalize) {
  const storage = storagePort(storageValue, { enumerable: true })
  const prefix = `${scopePrefix(scopeValue)}${state}:`
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
      operationId = uuid(rawOperationId, "operation id")
    } catch {
      removeCorrupt(storage, key)
      continue
    }
    const record = parseStoredRecord(storage, key, storage.getItem(key), operationId, normalize)
    if (record) records.push(record)
  }
  return Object.freeze(records.sort((left, right) => left.operationId.localeCompare(right.operationId)))
}

export function elnExperimentRecoveryNamespace(scopeValue) {
  return scopePrefix(scopeValue)
}

export function writePendingExperimentCreate(storageValue, scopeValue, value) {
  const storage = storagePort(storageValue)
  const operationId = uuid(value?.operationId, "operation id")
  const record = normalizeCreateRecord({
    schemaId: CREATE_SCHEMA_ID,
    state: "pending-create",
    operationId,
    input: value?.input,
  }, operationId)
  storage.setItem(recordKey(scopeValue, "create", operationId), JSON.stringify(record))
  return record
}

export function readPendingExperimentCreate(storageValue, scopeValue, operationIdValue) {
  const storage = storagePort(storageValue)
  const operationId = uuid(operationIdValue, "operation id")
  const key = recordKey(scopeValue, "create", operationId)
  return parseStoredRecord(storage, key, storage.getItem(key), operationId, normalizeCreateRecord)
}

export function listPendingExperimentCreates(storageValue, scopeValue) {
  return listRecords(storageValue, scopeValue, "create", normalizeCreateRecord)
}

export function removePendingExperimentCreate(storageValue, scopeValue, operationIdValue) {
  const storage = storagePort(storageValue)
  storage.removeItem(recordKey(scopeValue, "create", operationIdValue))
}

export function writePendingExperimentPlacement(storageValue, scopeValue, value) {
  const storage = storagePort(storageValue)
  const operationId = uuid(value?.operationId, "operation id")
  const record = normalizePlacementRecord({
    schemaId: PLACEMENT_SCHEMA_ID,
    state: "pending-placement",
    operationId,
    experimentId: value?.experimentId,
    title: value?.title,
    subjectRef: value?.subjectRef,
    workspaceId: value?.workspaceId,
    canvasId: value?.canvasId,
  }, operationId)
  storage.setItem(recordKey(scopeValue, "placement", operationId), JSON.stringify(record))
  return record
}

export function readPendingExperimentPlacement(storageValue, scopeValue, operationIdValue) {
  const storage = storagePort(storageValue)
  const operationId = uuid(operationIdValue, "operation id")
  const key = recordKey(scopeValue, "placement", operationId)
  return parseStoredRecord(storage, key, storage.getItem(key), operationId, normalizePlacementRecord)
}

export function listPendingExperimentPlacements(storageValue, scopeValue) {
  return listRecords(storageValue, scopeValue, "placement", normalizePlacementRecord)
}

/** Remove only after the durable Atlas placement is confirmed. */
export function removePendingExperimentPlacement(storageValue, scopeValue, operationIdValue) {
  const storage = storagePort(storageValue)
  storage.removeItem(recordKey(scopeValue, "placement", operationIdValue))
}

export function writePendingExperimentObservation(storageValue, scopeValue, value) {
  const storage = storagePort(storageValue)
  const operationId = uuid(value?.operationId, "operation id")
  const experimentId = experimentIdentity(value?.experimentId)
  const record = normalizeObservationRecord({
    schemaId: OBSERVATION_SCHEMA_ID,
    state: "pending-observation",
    operationId,
    experimentId,
    request: value?.request,
  }, operationId, experimentId)
  const key = observationRecordKey(scopeValue, experimentId, operationId)
  const existing = parseStoredRecord(
    storage,
    key,
    storage.getItem(key),
    operationId,
    (candidate, expected) => normalizeObservationRecord(candidate, expected, experimentId),
  )
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(record)) {
      invalid("pending observation operation is already bound to different input")
    }
    return existing
  }
  storage.setItem(key, JSON.stringify(record))
  return record
}

export function listPendingExperimentObservations(storageValue, scopeValue, experimentIdValue) {
  const storage = storagePort(storageValue, { enumerable: true })
  const experimentId = experimentIdentity(experimentIdValue)
  const prefix = `${scopePrefix(scopeValue)}observation:${encodeURIComponent(experimentId)}:`
  const records = []
  const keys = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key?.startsWith(prefix)) keys.push(key)
  }
  for (const key of keys) {
    const rawOperationId = key.slice(prefix.length)
    let operationId
    try {
      operationId = uuid(rawOperationId, "operation id")
    } catch {
      removeCorrupt(storage, key)
      continue
    }
    const record = parseStoredRecord(
      storage,
      key,
      storage.getItem(key),
      operationId,
      (value, expected) => normalizeObservationRecord(value, expected, experimentId),
    )
    if (record) records.push(record)
  }
  return Object.freeze(records.sort((left, right) => left.operationId.localeCompare(right.operationId)))
}

export function removePendingExperimentObservation(storageValue, scopeValue, experimentIdValue, operationIdValue) {
  const storage = storagePort(storageValue)
  storage.removeItem(observationRecordKey(scopeValue, experimentIdValue, operationIdValue))
}
