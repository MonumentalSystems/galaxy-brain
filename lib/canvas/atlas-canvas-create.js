import {
  hashCanvasSnapshot,
  normalizeCanvasSnapshot,
} from "./canvas-snapshot.js"

export const ATLAS_CANVAS_CREATE_RECOVERY_SCHEMA = "gb.atlas-canvas-create-recovery.v2"

export class AtlasCanvasCreateRecoveryError extends TypeError {
  constructor(message) {
    super(`Invalid Atlas canvas creation recovery: ${message}`)
    this.name = "AtlasCanvasCreateRecoveryError"
  }
}

// Keep the v1 storage key so an ambiguous pre-mode operation is discovered and
// blocked as an incompatible journal instead of being silently bypassed.
const STORAGE_PREFIX = "galaxy.atlas-canvas-create.v1"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/u
const SHA256 = /^sha256:[0-9a-f]{64}$/u
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u

function invalid(message) {
  throw new TypeError(`Invalid Atlas canvas creation: ${message}`)
}

function invalidRecovery(message) {
  throw new AtlasCanvasCreateRecoveryError(message)
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

function canonicalUuid(value, label) {
  const normalized = typeof value === "string" ? value.toLowerCase() : ""
  if (!UUID.test(normalized) || normalized !== value) invalid(`${label} must be a canonical UUID`)
  return normalized
}

function scopeIdentifier(value, label) {
  if (typeof value !== "string" || !WORKSPACE_ID.test(value)) invalid(`${label} is invalid`)
  return value
}

function title(value) {
  if (typeof value !== "string") invalid("title is invalid")
  const normalized = value.trim()
  if (
    normalized.length === 0
    || Array.from(normalized).length > 200
    || CONTROL_CHARACTERS.test(normalized)
  ) invalid("title must contain 1-200 printable characters")
  return normalized
}

function slug(value) {
  if (typeof value !== "string") invalid("slug is invalid")
  const normalized = value.trim()
  if (!SLUG.test(normalized)) invalid("slug is invalid")
  return normalized
}

function normalizeScope(value) {
  exactObject(value, ["principalId", "tenantId", "workspaceId"], "scope")
  return Object.freeze({
    tenantId: canonicalUuid(value.tenantId, "tenant id"),
    principalId: canonicalUuid(value.principalId, "principal id"),
    workspaceId: scopeIdentifier(value.workspaceId, "workspace id"),
  })
}

function operationIdempotencyKey(workspaceId, operationId) {
  const value = `canvas-create:${workspaceId}:${operationId}`
  if (value.length > 200) invalid("idempotency key exceeds the server limit")
  return value
}

function normalizeOperation(value) {
  exactObject(value, [
    "idempotencyKey",
    "makeDefault",
    "operationId",
    "principalId",
    "projectionMode",
    "schemaId",
    "slug",
    "state",
    "tenantId",
    "title",
    "workspaceId",
  ], "operation")
  if (value.schemaId !== ATLAS_CANVAS_CREATE_RECOVERY_SCHEMA || value.state !== "pending") {
    invalid("operation has the wrong schema or state")
  }
  const workspaceId = scopeIdentifier(value.workspaceId, "workspace id")
  const operationId = canonicalUuid(value.operationId, "operation id")
  const normalized = Object.freeze({
    schemaId: ATLAS_CANVAS_CREATE_RECOVERY_SCHEMA,
    state: "pending",
    operationId,
    tenantId: canonicalUuid(value.tenantId, "tenant id"),
    principalId: canonicalUuid(value.principalId, "principal id"),
    workspaceId,
    title: title(value.title),
    slug: slug(value.slug),
    makeDefault: false,
    projectionMode: "curated",
    idempotencyKey: operationIdempotencyKey(workspaceId, operationId),
  })
  if (
    value.makeDefault !== false
    || value.projectionMode !== "curated"
    || value.idempotencyKey !== normalized.idempotencyKey
  ) {
    invalid("operation identity is invalid")
  }
  return normalized
}

function sameOperation(left, right) {
  return left.schemaId === right.schemaId
    && left.state === right.state
    && left.operationId === right.operationId
    && left.tenantId === right.tenantId
    && left.principalId === right.principalId
    && left.workspaceId === right.workspaceId
    && left.title === right.title
    && left.slug === right.slug
    && left.makeDefault === right.makeDefault
    && left.projectionMode === right.projectionMode
    && left.idempotencyKey === right.idempotencyKey
}

function storagePort(value) {
  if (
    !value
    || typeof value.getItem !== "function"
    || typeof value.setItem !== "function"
    || typeof value.removeItem !== "function"
  ) invalid("storage must support getItem, setItem, and removeItem")
  return value
}

export function atlasCanvasCreateRecoveryKey(scopeValue) {
  const scope = normalizeScope(scopeValue)
  return `${STORAGE_PREFIX}:${scope.tenantId}:${scope.principalId}:${scope.workspaceId}`
}

export function prepareAtlasCanvasCreateOperation({
  tenantId,
  principalId,
  workspaceId,
  title: titleValue,
  slug: slugValue,
  operationId = globalThis.crypto?.randomUUID?.(),
}) {
  return normalizeOperation({
    schemaId: ATLAS_CANVAS_CREATE_RECOVERY_SCHEMA,
    state: "pending",
    operationId: typeof operationId === "string" ? operationId.toLowerCase() : operationId,
    tenantId,
    principalId,
    workspaceId,
    title: titleValue,
    slug: slugValue,
    makeDefault: false,
    projectionMode: "curated",
    idempotencyKey: operationIdempotencyKey(workspaceId, String(operationId).toLowerCase()),
  })
}

export function readPendingAtlasCanvasCreate(storageValue, scopeValue) {
  const storage = storagePort(storageValue)
  const scope = normalizeScope(scopeValue)
  const key = atlasCanvasCreateRecoveryKey(scope)
  const raw = storage.getItem(key)
  if (raw === null) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    invalidRecovery("stored journal is not valid JSON")
  }
  let operation
  try {
    operation = normalizeOperation(parsed)
  } catch {
    invalidRecovery("stored journal is malformed")
  }
  if (
    operation.tenantId !== scope.tenantId
    || operation.principalId !== scope.principalId
    || operation.workspaceId !== scope.workspaceId
  ) {
    invalidRecovery("stored journal does not match its tenant, principal, and workspace scope")
  }
  return operation
}

export function writePendingAtlasCanvasCreate(storageValue, scopeValue, operationValue) {
  const storage = storagePort(storageValue)
  const scope = normalizeScope(scopeValue)
  const operation = normalizeOperation(operationValue)
  if (
    operation.tenantId !== scope.tenantId
    || operation.principalId !== scope.principalId
    || operation.workspaceId !== scope.workspaceId
  ) invalid("operation does not match its tenant, principal, and workspace scope")
  const key = atlasCanvasCreateRecoveryKey(scope)
  const existing = readPendingAtlasCanvasCreate(storage, scope)
  if (existing) {
    if (!sameOperation(existing, operation)) {
      invalid("another or changed canvas creation is waiting for an exact retry")
    }
    return existing
  }
  storage.setItem(key, JSON.stringify(operation))
  const confirmed = readPendingAtlasCanvasCreate(storage, scope)
  if (!confirmed || confirmed.operationId !== operation.operationId) {
    invalid("recovery journal did not retain the exact operation")
  }
  return confirmed
}

export function requirePendingAtlasCanvasCreate(storageValue, scopeValue, operationValue) {
  const storage = storagePort(storageValue)
  const scope = normalizeScope(scopeValue)
  const operation = normalizeOperation(operationValue)
  const existing = readPendingAtlasCanvasCreate(storage, scope)
  if (!existing) invalidRecovery("the exact pending operation is missing")
  if (!sameOperation(existing, operation)) invalidRecovery("the exact pending operation changed")
  return existing
}

export function removePendingAtlasCanvasCreate(storageValue, scopeValue, operationIdValue) {
  const storage = storagePort(storageValue)
  const scope = normalizeScope(scopeValue)
  const operationId = canonicalUuid(String(operationIdValue).toLowerCase(), "operation id")
  const existing = readPendingAtlasCanvasCreate(storage, scope)
  if (existing && existing.operationId === operationId) {
    storage.removeItem(atlasCanvasCreateRecoveryKey(scope))
    return true
  }
  return false
}

export function discardAtlasCanvasCreateRecovery(storageValue, scopeValue) {
  const storage = storagePort(storageValue)
  const scope = normalizeScope(scopeValue)
  const key = atlasCanvasCreateRecoveryKey(scope)
  storage.removeItem(key)
  if (storage.getItem(key) !== null) invalidRecovery("stored journal could not be discarded")
  return true
}

function canonicalResponseUuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) invalid(`${label} must be a canonical UUID`)
  return value
}

export async function confirmAtlasCanvasCreateResponse(value, operationValue) {
  const operation = normalizeOperation(operationValue)
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("response must be an object")
  const replayed = Object.hasOwn(value, "replayed")
  exactObject(value, replayed
    ? ["canvasId", "content", "contentHash", "isDefault", "projectionMode", "replayed", "slug", "title", "version", "workspaceId"]
    : ["canvasId", "content", "contentHash", "isDefault", "mutationId", "projectionMode", "slug", "title", "version", "workspaceId"], "response")
  if (replayed && value.replayed !== true) invalid("replay marker is invalid")
  const canvasId = canonicalResponseUuid(value.canvasId, "canvas id")
  if (
    value.workspaceId !== operation.workspaceId
    || value.slug !== operation.slug
    || value.title !== operation.title
    || value.projectionMode !== operation.projectionMode
  ) invalid("response does not match the frozen request")
  if (typeof value.isDefault !== "boolean") invalid("default marker is invalid")
  if (!Number.isSafeInteger(value.version) || value.version < 1) invalid("version is invalid")
  if (typeof value.contentHash !== "string" || !SHA256.test(value.contentHash)) invalid("content hash is invalid")
  const content = normalizeCanvasSnapshot(value.content)
  const actualHash = await hashCanvasSnapshot(content)
  if (actualHash !== value.contentHash) invalid("content hash does not match the returned snapshot")
  if (!replayed) {
    canonicalResponseUuid(value.mutationId, "mutation id")
    if (
      value.version !== 1
      || content.items.length !== 0
      || content.edges.length !== 0
      || (content.frames?.length ?? 0) !== 0
      || content.removedItemIds.length !== 0
      || content.removedEdgeIds.length !== 0
    ) invalid("fresh response must contain the initial empty revision")
  }
  return Object.freeze({
    canvasId,
    workspaceId: value.workspaceId,
    slug: value.slug,
    title: value.title,
    isDefault: value.isDefault,
    projectionMode: value.projectionMode,
    version: value.version,
    contentHash: value.contentHash,
    content,
    ...(replayed ? { replayed: true } : { mutationId: value.mutationId }),
  })
}
