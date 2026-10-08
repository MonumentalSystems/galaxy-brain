import { normalizeCanvasSnapshot } from "./canvas-snapshot.js"
import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "../galaxy-object-reference.js"

const PLACEMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const CANVAS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/u

export class PlacementRemovalConflictError extends Error {
  constructor(message = "Placement removal identity collision") {
    super(message)
    this.name = "PlacementRemovalConflictError"
    this.code = "placement_identity_conflict"
  }
}

function placementId(value) {
  if (typeof value !== "string" || !PLACEMENT_ID.test(value)) {
    throw new TypeError("Placement removal requires a stable placement id")
  }
  return value
}

function operationId(value) {
  if (typeof value !== "string" || !OPERATION_ID.test(value)) {
    throw new TypeError("Placement removal operationId must be a canonical UUID")
  }
  return value
}

function subjectReference(value) {
  if (typeof value !== "string" || !value || value.length > 4096) {
    throw new TypeError("Placement removal requires an exact canonical subject reference")
  }
  const parsed = parseGalaxyObjectReference(value)
  if (!parsed || parsed.format !== "canonical") {
    throw new TypeError("Placement removal requires an exact canonical subject reference")
  }
  let canonical
  try {
    canonical = serializeGalaxyObjectReference(parsed)
  } catch {
    throw new TypeError("Placement removal requires an exact canonical subject reference")
  }
  if (canonical !== value) {
    throw new TypeError("Placement removal requires an exact canonical subject reference")
  }
  return canonical
}

function envelope(value, expectedCanvasId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Placement removal requires a canvas envelope")
  }
  if (typeof value.canvasId !== "string" || !CANVAS_ID.test(value.canvasId)) {
    throw new TypeError("Placement removal canvasId must be a canonical UUID")
  }
  if (expectedCanvasId !== undefined && value.canvasId !== expectedCanvasId) {
    throw new PlacementRemovalConflictError("Placement removal canvas identity collision")
  }
  if (!Number.isSafeInteger(value.version) || value.version < 1) {
    throw new TypeError("Placement removal canvas version must be positive")
  }
  if (typeof value.contentHash !== "string" || !CONTENT_HASH.test(value.contentHash)) {
    throw new TypeError("Placement removal canvas contentHash is invalid")
  }
  normalizeCanvasSnapshot(value.content)
  return value
}

export function placementRemovalState(snapshot, value, expectedSubjectRef = undefined) {
  const id = placementId(value)
  const expected = expectedSubjectRef === undefined
    ? undefined
    : subjectReference(expectedSubjectRef)
  const content = normalizeCanvasSnapshot(snapshot)
  const existing = content.items.find((item) => item.id === id)
  if (existing) {
    if (expected !== undefined && existing.subjectRef !== expected) {
      return "collision"
    }
    return "present"
  }
  if (content.removedItemIds.includes(id)) return "removed"
  return "untracked"
}

export function validatePlacementRemovalEnvelope(
  canvas,
  value,
  expectedCanvasId = undefined,
  expectedSubjectRef = undefined,
) {
  const authoritative = envelope(canvas, expectedCanvasId)
  const state = placementRemovalState(authoritative.content, value, expectedSubjectRef)
  if (state === "present" || state === "collision") throw new PlacementRemovalConflictError()
  if (state !== "removed") {
    throw new TypeError("Placement removal is absent without an authoritative tombstone")
  }
  return authoritative
}

function mutationInput(base, id, operation) {
  return {
    expectedVersion: base.version,
    expectedContentHash: base.contentHash,
    idempotencyKey: `placement-remove:${operation}`,
    commands: [{ type: "item.remove", itemId: id }],
  }
}

/**
 * Remove one Atlas placement with one bounded reconciliation retry. This only
 * mutates presentation state: it never accepts or changes canonical content,
 * provider state, or the referenced object's identity.
 */
export async function reconcilePlacementRemoval({
  current,
  placementId: placementValue,
  subjectRef: subjectValue,
  operationId: operationValue,
  mutateCanvas,
  reloadCanvas,
}) {
  if (typeof mutateCanvas !== "function" || typeof reloadCanvas !== "function") {
    throw new TypeError("Placement removal requires canvas transport functions")
  }
  const id = placementId(placementValue)
  const subjectRef = subjectReference(subjectValue)
  const operation = operationId(operationValue)
  const initial = envelope(current)
  const canvasId = initial.canvasId
  const initialState = placementRemovalState(initial.content, id, subjectRef)
  if (initialState === "collision") throw new PlacementRemovalConflictError()
  if (initialState === "removed") {
    return Object.freeze({
      canvas: validatePlacementRemovalEnvelope(initial, id, canvasId, subjectRef),
      placementId: id,
      replayed: true,
    })
  }

  const apply = (base) => mutateCanvas(canvasId, mutationInput(base, id, operation))
  let authoritative
  let replayed = false
  let updated
  try {
    updated = await apply(initial)
  } catch {
    const latest = envelope(await reloadCanvas(canvasId), canvasId)
    const latestState = placementRemovalState(latest.content, id, subjectRef)
    if (latestState === "collision") throw new PlacementRemovalConflictError()
    if (latestState === "removed") {
      authoritative = latest
      replayed = true
    } else {
      const retried = envelope(await apply(latest), canvasId)
      replayed = retried.replayed === true
      authoritative = replayed
        ? envelope(await reloadCanvas(canvasId), canvasId)
        : retried
    }
  }
  if (updated !== undefined) {
    const normalized = envelope(updated, canvasId)
    replayed = normalized.replayed === true
    authoritative = replayed
      ? envelope(await reloadCanvas(canvasId), canvasId)
      : normalized
  }

  return Object.freeze({
    canvas: validatePlacementRemovalEnvelope(authoritative, id, canvasId, subjectRef),
    placementId: id,
    replayed,
  })
}
