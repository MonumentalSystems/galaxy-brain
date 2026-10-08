const RECOVERY_SCHEMA_ID = "gb.document-anchor-placement-recovery.v1"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const ANCHOR_ID = /^sha256:[0-9a-f]{64}$/u
const PLACEMENT_ID = /^anchor-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_IDENTITY_PART = 512
const MAX_GENERATION = 1_000_000

function invalid(message) {
  throw new TypeError(`Invalid document anchor placement recovery: ${message}`)
}

function identityPart(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_IDENTITY_PART
    || /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value)
  ) invalid(`${label} is invalid`)
  return value
}

function normalizeUuid(value, label) {
  const normalized = typeof value === "string" ? value.toLowerCase() : ""
  if (!UUID.test(normalized)) invalid(`${label} must be a UUID`)
  return normalized
}

function normalizeGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_GENERATION) {
    invalid(`generation must be an integer from 1 to ${MAX_GENERATION}`)
  }
  return value
}

function normalizeScope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("scope is required")
  const anchorId = identityPart(value.anchorId, "anchor id")
  if (!ANCHOR_ID.test(anchorId)) invalid("anchor id must be a canonical SHA-256 id")
  return {
    tenantId: identityPart(value.tenantId, "tenant id"),
    principalId: identityPart(value.principalId, "principal id"),
    documentRevisionId: normalizeUuid(value.documentRevisionId, "document revision id"),
    anchorId,
  }
}

function storagePort(storage) {
  if (
    !storage
    || typeof storage.getItem !== "function"
    || typeof storage.setItem !== "function"
    || typeof storage.removeItem !== "function"
  ) invalid("storage must support getItem, setItem, and removeItem")
  return storage
}

function keyPart(value) {
  return encodeURIComponent(value)
}

export function documentAnchorPlacementRecoveryKey(scopeValue) {
  const scope = normalizeScope(scopeValue)
  return [
    RECOVERY_SCHEMA_ID,
    keyPart(scope.tenantId),
    keyPart(scope.principalId),
    scope.documentRevisionId,
    keyPart(scope.anchorId),
  ].join(":")
}

function recordKey(scope, state) {
  return `${documentAnchorPlacementRecoveryKey(scope)}:${state}`
}

function uuidBytes(bytes) {
  const value = [...bytes.slice(0, 16)]
  // RFC 9562 UUIDv8 is the envelope for a custom SHA-256-derived name.
  value[6] = (value[6] & 0x0f) | 0x80
  value[8] = (value[8] & 0x3f) | 0x80
  const hex = value.map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export async function deriveDocumentAnchorPlacementOperationId(scopeValue, canvasIdValue, generationValue) {
  const scope = normalizeScope(scopeValue)
  const canvasId = normalizeUuid(canvasIdValue, "canvas id")
  const generation = normalizeGeneration(generationValue)
  const subtle = globalThis.crypto?.subtle
  if (!subtle) invalid("WebCrypto SHA-256 is unavailable")
  const identity = JSON.stringify([
    RECOVERY_SCHEMA_ID,
    scope.tenantId,
    scope.principalId,
    scope.documentRevisionId,
    scope.anchorId,
    canvasId,
    generation,
  ])
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(identity))
  return uuidBytes(new Uint8Array(digest))
}

function parseRecord(raw, expectedState) {
  const value = JSON.parse(raw)
  const exactKeys = expectedState === "pending"
    ? ["canvasId", "generation", "operationId", "schemaId", "state"]
    : ["canvasId", "generation", "operationId", "placementId", "schemaId", "state"]
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== exactKeys.sort().join("\0")
    || value.schemaId !== RECOVERY_SCHEMA_ID
    || value.state !== expectedState
  ) invalid("stored operation is invalid")
  const canvasId = normalizeUuid(value.canvasId, "stored canvas id")
  const operationId = normalizeUuid(value.operationId, "stored operation id")
  const generation = normalizeGeneration(value.generation)
  if (expectedState === "confirmed") {
    if (!PLACEMENT_ID.test(value.placementId) || value.placementId !== `anchor-${operationId}`) {
      invalid("stored placement id is invalid")
    }
  }
  return { ...value, canvasId, operationId, generation }
}

async function readRecord(storage, scope, state) {
  const key = recordKey(scope, state)
  const raw = storage.getItem(key)
  if (raw === null) return null
  try {
    const record = parseRecord(raw, state)
    const expectedOperationId = await deriveDocumentAnchorPlacementOperationId(
      scope,
      record.canvasId,
      record.generation,
    )
    if (record.operationId !== expectedOperationId) invalid("stored operation does not match its identity")
    return Object.freeze(record)
  } catch {
    storage.removeItem(key)
    return null
  }
}

/** Read this before resolving a current default: the record owns its canvas. */
export async function readDocumentAnchorPlacementRecovery(storageValue, scopeValue) {
  const storage = storagePort(storageValue)
  const scope = normalizeScope(scopeValue)
  return await readRecord(storage, scope, "confirmed")
    ?? await readRecord(storage, scope, "pending")
}

/** Create generation one only when this exact anchor has no prior target. */
export async function ensureDocumentAnchorPlacementRecovery(storageValue, scopeValue, canvasIdValue) {
  const storage = storagePort(storageValue)
  const scope = normalizeScope(scopeValue)
  const existing = await readDocumentAnchorPlacementRecovery(storage, scope)
  if (existing) return existing
  const canvasId = normalizeUuid(canvasIdValue, "canvas id")
  const generation = 1
  const operationId = await deriveDocumentAnchorPlacementOperationId(scope, canvasId, generation)
  const pending = Object.freeze({
    schemaId: RECOVERY_SCHEMA_ID,
    state: "pending",
    canvasId,
    generation,
    operationId,
  })
  storage.setItem(recordKey(scope, "pending"), JSON.stringify(pending))
  return await readRecord(storage, scope, "confirmed") ?? pending
}

export async function confirmDocumentAnchorPlacementRecovery(
  storageValue,
  scopeValue,
  canvasIdValue,
  operationIdValue,
  placementId,
) {
  const storage = storagePort(storageValue)
  const scope = normalizeScope(scopeValue)
  const canvasId = normalizeUuid(canvasIdValue, "canvas id")
  const operationId = normalizeUuid(operationIdValue, "operation id")
  const current = await readDocumentAnchorPlacementRecovery(storage, scope)
  if (!current || current.canvasId !== canvasId || current.operationId !== operationId) {
    invalid("operation does not match the current recovery record")
  }
  const expectedOperationId = await deriveDocumentAnchorPlacementOperationId(scope, canvasId, current.generation)
  if (operationId !== expectedOperationId) invalid("operation id does not match the exact generation")
  if (typeof placementId !== "string" || placementId !== `anchor-${operationId}`) {
    invalid("placement id does not match the operation")
  }
  const confirmed = Object.freeze({
    schemaId: RECOVERY_SCHEMA_ID,
    state: "confirmed",
    canvasId,
    generation: current.generation,
    operationId,
    placementId,
  })
  storage.setItem(recordKey(scope, "confirmed"), JSON.stringify(confirmed))
  storage.removeItem(recordKey(scope, "pending"))
  return confirmed
}

/**
 * Replace only the caller's still-current record with the next generation.
 * Synchronous localStorage writes make the replacement indivisible within this
 * document; callers still must not claim full cross-tab CAS semantics.
 */
export async function advanceDocumentAnchorPlacementRecovery(
  storageValue,
  scopeValue,
  canvasIdValue,
  operationIdValue,
) {
  const storage = storagePort(storageValue)
  const scope = normalizeScope(scopeValue)
  const canvasId = normalizeUuid(canvasIdValue, "canvas id")
  const operationId = normalizeUuid(operationIdValue, "operation id")
  let current = await readDocumentAnchorPlacementRecovery(storage, scope)
  if (!current || current.canvasId !== canvasId || current.operationId !== operationId) {
    invalid("cannot advance a stale or unrelated recovery record")
  }
  if (current.generation >= MAX_GENERATION) invalid("recovery generation limit reached")
  const generation = current.generation + 1
  const nextOperationId = await deriveDocumentAnchorPlacementOperationId(scope, canvasId, generation)
  // Recheck after asynchronous hashing so a stale caller cannot replace a
  // record that another tab advanced or retargeted in the meantime.
  current = await readDocumentAnchorPlacementRecovery(storage, scope)
  if (!current || current.canvasId !== canvasId || current.operationId !== operationId) {
    invalid("cannot advance a stale or unrelated recovery record")
  }
  const pending = Object.freeze({
    schemaId: RECOVERY_SCHEMA_ID,
    state: "pending",
    canvasId,
    generation,
    operationId: nextOperationId,
  })
  storage.setItem(recordKey(scope, "pending"), JSON.stringify(pending))
  storage.removeItem(recordKey(scope, "confirmed"))
  return pending
}

/** Pending and confirmed attempts both reconcile against the exact old canvas. */
export async function runRecoverableDocumentAnchorPlacement({
  storage,
  scope: scopeValue,
  resolveCanvasId,
  place,
}) {
  if (typeof resolveCanvasId !== "function") invalid("resolveCanvasId must be a function")
  if (typeof place !== "function") invalid("place must be a function")
  const scope = normalizeScope(scopeValue)
  let recovery = await readDocumentAnchorPlacementRecovery(storage, scope)
  let wasConfirmed = recovery?.state === "confirmed"
  if (!recovery) {
    recovery = await ensureDocumentAnchorPlacementRecovery(storage, scope, await resolveCanvasId())
  }
  const stored = await readDocumentAnchorPlacementRecovery(storage, scope)
  if (stored) {
    recovery = stored
    wasConfirmed ||= stored.state === "confirmed"
  }
  const result = await place(recovery.operationId, recovery.canvasId)
  if (!result || typeof result !== "object" || Array.isArray(result)) invalid("placement result is invalid")
  const confirmed = await confirmDocumentAnchorPlacementRecovery(
    storage,
    scope,
    recovery.canvasId,
    recovery.operationId,
    result.placementId,
  )
  return Object.freeze({ recovery: confirmed, result, recovered: wasConfirmed })
}
