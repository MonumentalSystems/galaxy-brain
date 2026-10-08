import { normalizeCanvasSnapshot } from "./canvas-snapshot.js"

export const ATLAS_FRAME_MUTATION_RECOVERY_SCHEMA = "gb.atlas-frame-mutation-recovery.v1"

const MIN_FRAME_DIMENSION = 160
const MAX_FRAME_DIMENSION = 10_000
const MAX_COORDINATE = 10_000_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/u
const STORAGE_PREFIX = "galaxy.atlas-frame-mutation.v1"

export class AtlasFrameMutationConflictError extends Error {
  constructor(canvas, message = "Atlas frame identity changed before recovery completed") {
    super(message)
    this.name = "AtlasFrameMutationConflictError"
    this.code = "frame_identity_conflict"
    this.canvas = canvas
  }
}

export class AtlasFrameMutationTerminalError extends Error {
  constructor(canvas, cause) {
    super(cause instanceof Error ? cause.message : "Atlas frame mutation was rejected")
    this.name = "AtlasFrameMutationTerminalError"
    this.code = "frame_mutation_rejected"
    this.canvas = canvas
    this.status = Number.isInteger(cause?.status) ? cause.status : null
    this.cause = cause
  }
}

export class AtlasFrameMutationRecoveryError extends TypeError {
  constructor(message) {
    super(`Invalid Atlas frame recovery: ${message}`)
    this.name = "AtlasFrameMutationRecoveryError"
  }
}

function exactObject(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has unexpected fields`)
  }
  return value
}

function canonicalUuid(value, label) {
  const normalized = typeof value === "string" ? value.toLowerCase() : ""
  if (normalized !== value || !UUID.test(normalized)) throw new TypeError(`${label} must be a canonical UUID`)
  return normalized
}

function scopeId(value, label) {
  if (typeof value !== "string" || !SCOPE_ID.test(value)) throw new TypeError(`${label} is invalid`)
  return value
}

function normalizeScope(value) {
  exactObject(value, ["canvasId", "principalId", "tenantId", "workspaceId"], "frame recovery scope")
  return Object.freeze({
    tenantId: canonicalUuid(value.tenantId, "tenant id"),
    principalId: canonicalUuid(value.principalId, "principal id"),
    workspaceId: scopeId(value.workspaceId, "workspace id"),
    canvasId: canonicalUuid(value.canvasId, "canvas id"),
  })
}

function storagePort(value) {
  if (!value || typeof value.getItem !== "function" || typeof value.setItem !== "function" || typeof value.removeItem !== "function") {
    throw new TypeError("frame recovery storage must support getItem, setItem, and removeItem")
  }
  return value
}

function operationKey(kind, operationId) {
  return `frame-${kind}:${operationId}`
}

function normalizeOperation(value) {
  exactObject(value, [
    "canvasId", "frame", "idempotencyKey", "kind", "operationId", "principalId",
    "schemaId", "state", "tenantId", "workspaceId",
  ], "frame recovery operation")
  if (value.schemaId !== ATLAS_FRAME_MUTATION_RECOVERY_SCHEMA || value.state !== "pending") {
    throw new TypeError("frame recovery operation has the wrong schema or state")
  }
  if (!["create", "remove"].includes(value.kind)) throw new TypeError("frame recovery kind is invalid")
  const scope = normalizeScope({
    tenantId: value.tenantId,
    principalId: value.principalId,
    workspaceId: value.workspaceId,
    canvasId: value.canvasId,
  })
  const operationId = canonicalUuid(value.operationId, "operation id")
  const frame = canvasFrameFromInput(value.frame)
  const idempotencyKey = operationKey(value.kind, operationId)
  if (value.idempotencyKey !== idempotencyKey) throw new TypeError("frame recovery operation identity is invalid")
  return Object.freeze({
    schemaId: ATLAS_FRAME_MUTATION_RECOVERY_SCHEMA,
    state: "pending",
    kind: value.kind,
    operationId,
    idempotencyKey,
    ...scope,
    frame: Object.freeze(frame),
  })
}

function sameOperation(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sameFrame(left, right) {
  return left.id === right.id
    && left.title === right.title
    && left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
    && left.tone === right.tone
}

function envelope(value, expectedCanvasId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Frame mutation requires a canvas envelope")
  if (typeof value.canvasId !== "string" || !UUID.test(value.canvasId)) throw new TypeError("Frame mutation canvasId is invalid")
  if (expectedCanvasId !== undefined && value.canvasId !== expectedCanvasId) throw new TypeError("Atlas frame canvas identity changed")
  if (!Number.isSafeInteger(value.version) || value.version < 1) throw new TypeError("Frame mutation canvas version is invalid")
  if (typeof value.contentHash !== "string" || !CONTENT_HASH.test(value.contentHash)) throw new TypeError("Frame mutation canvas hash is invalid")
  return { ...value, content: normalizeCanvasSnapshot(value.content) }
}

function frameById(snapshot, frameId) {
  return (normalizeCanvasSnapshot(snapshot).frames ?? []).find((frame) => frame.id === frameId)
}

export function canvasFrameFromInput({ id, title, tone, x, y, width = 720, height = 480 }) {
  return normalizeCanvasSnapshot({
    schemaId: "gb.canvas.snapshot.v1",
    items: [],
    edges: [],
    frames: [{ id, title, tone, x, y, width, height }],
  }).frames[0]
}

export function commandsForFrameGeometry(snapshot, frameId, geometry) {
  const existing = frameById(snapshot, frameId)
  if (!existing) throw new TypeError("Frame is not part of the durable canvas")
  const bounded = clampAtlasFrameGeometry(geometry)
  const commands = []
  if (existing.x !== bounded.x || existing.y !== bounded.y) {
    commands.push({ type: "frame.move", frameId, position: { x: bounded.x, y: bounded.y } })
  }
  if (existing.width !== bounded.width || existing.height !== bounded.height) {
    commands.push({
      type: "frame.resize",
      frameId,
      size: { width: bounded.width, height: bounded.height },
    })
  }
  return commands
}

export function clampAtlasFrameGeometry(geometry) {
  if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) throw new TypeError("Frame geometry must be an object")
  for (const key of ["x", "y", "width", "height"]) {
    if (typeof geometry[key] !== "number" || !Number.isFinite(geometry[key])) throw new TypeError(`Frame geometry ${key} must be finite`)
  }
  return {
    x: Math.max(-MAX_COORDINATE, Math.min(MAX_COORDINATE, geometry.x)),
    y: Math.max(-MAX_COORDINATE, Math.min(MAX_COORDINATE, geometry.y)),
    width: Math.max(MIN_FRAME_DIMENSION, Math.min(MAX_FRAME_DIMENSION, geometry.width)),
    height: Math.max(MIN_FRAME_DIMENSION, Math.min(MAX_FRAME_DIMENSION, geometry.height)),
  }
}

export function frameGeometryFromNode(node) {
  return clampAtlasFrameGeometry({ x: node.x, y: node.y, width: node.w, height: node.h })
}

export function applyFrameGeometryOverrides(projection, overrides) {
  const geometryByFrame = new Map(overrides)
  return {
    ...projection,
    frames: (projection.frames ?? []).map((frame) => {
      const geometry = geometryByFrame.get(frame.id)
      return geometry ? { ...frame, ...geometry } : frame
    }),
  }
}

export function frameCreateCommand(frame) {
  const normalized = canvasFrameFromInput(frame)
  return { type: "frame.create", frame: normalized }
}

export function frameRemoveCommand(snapshot, frameId) {
  if (!frameById(snapshot, frameId)) throw new TypeError("Frame is not part of the durable canvas")
  return { type: "frame.remove", frameId }
}

export function atlasFrameMutationRecoveryKey(scopeValue) {
  const scope = normalizeScope(scopeValue)
  return `${STORAGE_PREFIX}:${scope.tenantId}:${scope.principalId}:${scope.workspaceId}:${scope.canvasId}`
}

export function prepareAtlasFrameMutationOperation({
  kind,
  tenantId,
  principalId,
  workspaceId,
  canvasId,
  frame,
  operationId = globalThis.crypto?.randomUUID?.(),
}) {
  const normalizedId = typeof operationId === "string" ? operationId.toLowerCase() : operationId
  return normalizeOperation({
    schemaId: ATLAS_FRAME_MUTATION_RECOVERY_SCHEMA,
    state: "pending",
    kind,
    operationId: normalizedId,
    idempotencyKey: operationKey(kind, normalizedId),
    tenantId,
    principalId,
    workspaceId,
    canvasId,
    frame,
  })
}

export function readPendingAtlasFrameMutation(storageValue, scopeValue) {
  const storage = storagePort(storageValue)
  const scope = normalizeScope(scopeValue)
  const raw = storage.getItem(atlasFrameMutationRecoveryKey(scope))
  if (raw === null) return null
  let operation
  try {
    operation = normalizeOperation(JSON.parse(raw))
  } catch {
    throw new AtlasFrameMutationRecoveryError("stored journal is malformed")
  }
  if (operation.tenantId !== scope.tenantId
      || operation.principalId !== scope.principalId
      || operation.workspaceId !== scope.workspaceId
      || operation.canvasId !== scope.canvasId) {
    throw new AtlasFrameMutationRecoveryError("stored journal does not match its scope")
  }
  return operation
}

export function writePendingAtlasFrameMutation(storageValue, scopeValue, operationValue) {
  const storage = storagePort(storageValue)
  const scope = normalizeScope(scopeValue)
  const operation = normalizeOperation(operationValue)
  if (operation.tenantId !== scope.tenantId
      || operation.principalId !== scope.principalId
      || operation.workspaceId !== scope.workspaceId
      || operation.canvasId !== scope.canvasId) throw new TypeError("frame recovery operation does not match its scope")
  const existing = readPendingAtlasFrameMutation(storage, scope)
  if (existing) {
    if (!sameOperation(existing, operation)) throw new TypeError("another frame mutation is waiting for exact recovery")
    return existing
  }
  storage.setItem(atlasFrameMutationRecoveryKey(scope), JSON.stringify(operation))
  const confirmed = readPendingAtlasFrameMutation(storage, scope)
  if (!confirmed || !sameOperation(confirmed, operation)) throw new TypeError("frame recovery journal did not retain the exact operation")
  return confirmed
}

export function removePendingAtlasFrameMutation(storageValue, scopeValue, operationIdValue) {
  const storage = storagePort(storageValue)
  const scope = normalizeScope(scopeValue)
  const operationId = canonicalUuid(String(operationIdValue).toLowerCase(), "operation id")
  const existing = readPendingAtlasFrameMutation(storage, scope)
  if (!existing || existing.operationId !== operationId) return false
  storage.removeItem(atlasFrameMutationRecoveryKey(scope))
  return true
}

export function quarantineAtlasFrameMutationJournal(storageValue, scopeValue) {
  const storage = storagePort(storageValue)
  const key = atlasFrameMutationRecoveryKey(scopeValue)
  const existed = storage.getItem(key) !== null
  storage.removeItem(key)
  if (storage.getItem(key) !== null) throw new TypeError("frame recovery journal could not be quarantined")
  return existed
}

export function isTerminalAtlasFrameMutationError(error) {
  const status = Number.isInteger(error?.status) ? error.status : null
  return status !== null
    && status >= 400
    && status < 500
    && ![408, 409, 425, 429].includes(status)
}

export function atlasFrameMutationState(snapshot, frameValue) {
  const frame = canvasFrameFromInput(frameValue)
  const existing = frameById(snapshot, frame.id)
  if (!existing) return "absent"
  return sameFrame(existing, frame) ? "exact" : "collision"
}

export async function reconcileAtlasFrameMutation({ current, operation: operationValue, mutateCanvas, reloadCanvas }) {
  if (typeof mutateCanvas !== "function" || typeof reloadCanvas !== "function") throw new TypeError("Frame mutation requires canvas transport functions")
  const operation = normalizeOperation(operationValue)
  let base = envelope(current, operation.canvasId)
  const expectedState = operation.kind === "create" ? "exact" : "absent"
  const observed = atlasFrameMutationState(base.content, operation.frame)
  if (observed === "collision") throw new AtlasFrameMutationConflictError(base)
  if (observed === expectedState) return Object.freeze({ canvas: base, operation, replayed: true })

  const input = (canvas) => ({
    expectedVersion: canvas.version,
    expectedContentHash: canvas.contentHash,
    idempotencyKey: operation.idempotencyKey,
    commands: operation.kind === "create"
      ? [frameCreateCommand(operation.frame)]
      : [frameRemoveCommand(canvas.content, operation.frame.id)],
  })
  const apply = (canvas) => mutateCanvas(operation.canvasId, input(canvas))
  let authoritative
  let replayed = false
  try {
    authoritative = envelope(await apply(base), operation.canvasId)
  } catch (firstError) {
    base = envelope(await reloadCanvas(operation.canvasId), operation.canvasId)
    const reloadedState = atlasFrameMutationState(base.content, operation.frame)
    if (reloadedState === "collision") throw new AtlasFrameMutationConflictError(base)
    if (reloadedState === expectedState) return Object.freeze({ canvas: base, operation, replayed: true })
    if (isTerminalAtlasFrameMutationError(firstError)) {
      throw new AtlasFrameMutationTerminalError(base, firstError)
    }
    try {
      authoritative = envelope(await apply(base), operation.canvasId)
    } catch (secondError) {
      if (!isTerminalAtlasFrameMutationError(secondError)) throw secondError
      const confirmed = envelope(await reloadCanvas(operation.canvasId), operation.canvasId)
      const confirmedState = atlasFrameMutationState(confirmed.content, operation.frame)
      if (confirmedState === "collision") throw new AtlasFrameMutationConflictError(confirmed)
      if (confirmedState === expectedState) return Object.freeze({ canvas: confirmed, operation, replayed: true })
      throw new AtlasFrameMutationTerminalError(confirmed, secondError)
    }
  }
  replayed = authoritative.replayed === true
  if (replayed) authoritative = envelope(await reloadCanvas(operation.canvasId), operation.canvasId)
  const finalState = atlasFrameMutationState(authoritative.content, operation.frame)
  if (finalState === "collision") throw new AtlasFrameMutationConflictError(authoritative)
  if (finalState !== expectedState) throw new TypeError("Frame mutation response did not confirm the exact operation")
  return Object.freeze({ canvas: authoritative, operation, replayed })
}
