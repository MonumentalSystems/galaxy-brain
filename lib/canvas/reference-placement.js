import { normalizeCanvasSnapshot } from "./canvas-snapshot.js"
import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "../galaxy-object-reference.js"

export const REFERENCE_PLACEMENT_STYLE = "gb.canvas.reference-placement.v1"
export const MAX_PLACEABLE_REFERENCE_CHARACTERS = 1_024
export const MAX_REFERENCE_PLACEMENT_COORDINATE = 10_000_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const MAX_ITEMS = 2_000
const MAX_Z_INDEX = 1_000_000
const SHA256_REVISION = /^sha256:[0-9a-f]{64}$/u

const NODE_TYPE_BY_KIND = Object.freeze({
  paper: "galaxy.paper",
  document: "galaxy.document",
  "document.anchor": "galaxy.document",
  "eln.experiment": "galaxy.eln-record",
  "eln.observation": "galaxy.eln-record",
  "ham.task": "galaxy.task",
  "ham.memory": "galaxy.note",
  chat: "galaxy.chat",
  surface: "galaxy.surface",
  "proof.graph": "galaxy.proof",
  "proof.node": "galaxy.proof",
})

const SIZE_BY_NODE_TYPE = Object.freeze({
  "galaxy.paper": Object.freeze({ width: 420, height: 260 }),
  "galaxy.document": Object.freeze({ width: 420, height: 260 }),
  "galaxy.eln-record": Object.freeze({ width: 400, height: 260 }),
  "galaxy.task": Object.freeze({ width: 400, height: 250 }),
  "galaxy.note": Object.freeze({ width: 400, height: 250 }),
  "galaxy.chat": Object.freeze({ width: 420, height: 260 }),
  "galaxy.surface": Object.freeze({ width: 500, height: 340 }),
  "galaxy.proof": Object.freeze({ width: 430, height: 260 }),
})

function failure(code) {
  return Object.freeze({ ok: false, code })
}

export function inspectPlaceableReference(value, { allowSurface = true } = {}) {
  if (typeof value !== "string" || !value || value.length > MAX_PLACEABLE_REFERENCE_CHARACTERS) {
    return failure("invalid_reference")
  }
  const reference = parseGalaxyObjectReference(value)
  if (!reference || reference.format !== "canonical") return failure("invalid_reference")
  let canonical
  try {
    canonical = serializeGalaxyObjectReference(reference)
  } catch {
    return failure("invalid_reference")
  }
  if (canonical !== value) return failure("noncanonical_reference")
  const nodeType = NODE_TYPE_BY_KIND[reference.kind]
  if (!nodeType) return failure("unsupported_kind")
  if (reference.kind === "chat" && (
    reference.selector.mode !== "pinned" || !SHA256_REVISION.test(reference.selector.revision)
  )) return failure("unsupported_kind")
  if (reference.kind === "eln.observation" && (
    reference.selector.mode !== "pinned" || !SHA256_REVISION.test(reference.selector.revision)
  )) return failure("unsupported_kind")
  if (reference.kind === "surface" && !allowSurface) return failure("unsupported_kind")
  return Object.freeze({
    ok: true,
    subjectRef: canonical,
    kind: reference.kind,
    nodeType,
  })
}

export function normalizeReferencePlacementPoint(value) {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\n") !== "x\ny") {
    throw new TypeError("Reference placement point must contain exactly x and y")
  }
  for (const coordinate of [value.x, value.y]) {
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate)
      || coordinate < -MAX_REFERENCE_PLACEMENT_COORDINATE
      || coordinate > MAX_REFERENCE_PLACEMENT_COORDINATE) {
      throw new TypeError("Reference placement point must be finite and within canvas bounds")
    }
  }
  return Object.freeze({
    x: Object.is(value.x, -0) ? 0 : value.x,
    y: Object.is(value.y, -0) ? 0 : value.y,
  })
}

function nextGeometry(snapshot, nodeType, point) {
  const content = normalizeCanvasSnapshot(snapshot)
  if (content.items.length >= MAX_ITEMS) {
    throw new RangeError("The Atlas canvas has reached its placement limit")
  }
  const index = content.items.length
  const highestZ = content.items.reduce((value, item) => Math.max(value, item.zIndex), -1)
  if (highestZ >= MAX_Z_INDEX) throw new RangeError("The Atlas canvas has reached its stacking limit")
  const size = SIZE_BY_NODE_TYPE[nodeType]
  const normalizedPoint = normalizeReferencePlacementPoint(point)
  return {
    x: normalizedPoint?.x ?? 80 + (index % 4) * 450,
    y: normalizedPoint?.y ?? 80 + Math.floor(index / 4) * 300,
    width: size.width,
    height: size.height,
    zIndex: highestZ + 1,
  }
}

export function createReferenceCanvasItem(subjectRef, operationId, snapshot, point) {
  const inspected = inspectPlaceableReference(subjectRef)
  if (!inspected.ok) throw new TypeError(`Reference is not placeable: ${inspected.code}`)
  if (typeof operationId !== "string" || !UUID.test(operationId)) {
    throw new TypeError("Reference placement operationId must be a UUID")
  }
  const geometry = nextGeometry(snapshot, inspected.nodeType, point)
  return normalizeCanvasSnapshot({
    schemaId: "gb.canvas.snapshot.v1",
    items: [{
      id: `reference-${operationId.toLowerCase()}`,
      subjectRef: inspected.subjectRef,
      nodeType: inspected.nodeType,
      ...geometry,
      angle: 0,
      displayMode: "card",
      collapsed: false,
      style: { schemaId: REFERENCE_PLACEMENT_STYLE },
    }],
    edges: [],
    removedItemIds: [],
    removedEdgeIds: [],
  }).items[0]
}

export function referencePlacementState(snapshot, item) {
  const content = normalizeCanvasSnapshot(snapshot)
  const existing = content.items.find((candidate) => candidate.id === item.id)
  if (!existing) return "absent"
  return existing.subjectRef === item.subjectRef && existing.nodeType === item.nodeType
    ? "replayed"
    : "collision"
}

export function validateReferencePlacementEnvelope(canvas, item) {
  const state = referencePlacementState(canvas?.content, item)
  if (state === "collision") throw new TypeError("Reference placement identity collision")
  if (state !== "replayed") throw new TypeError("Reference placement is absent from the authoritative canvas")
  return canvas
}

function mutationInput(base, item, operationId) {
  return {
    expectedVersion: base.version,
    expectedContentHash: base.contentHash,
    idempotencyKey: `reference-place:${operationId.toLowerCase()}`,
    commands: [{ type: "item.place", item }],
  }
}

/**
 * Apply one reference placement with a single reconciliation retry. The caller
 * supplies authenticated transport functions; this domain function owns the
 * stable operation identity and never accepts resolved display content.
 */
export async function reconcileReferencePlacement({
  current,
  subjectRef,
  operationId,
  point,
  mutateCanvas,
  reloadCanvas,
}) {
  if (typeof mutateCanvas !== "function" || typeof reloadCanvas !== "function") {
    throw new TypeError("Reference placement requires canvas transport functions")
  }
  const item = createReferenceCanvasItem(subjectRef, operationId, current?.content, point)
  const initialState = referencePlacementState(current?.content, item)
  if (initialState === "collision") throw new TypeError("Reference placement identity collision")
  if (initialState === "replayed") {
    return Object.freeze({ canvas: validateReferencePlacementEnvelope(current, item), item, replayed: true })
  }

  const apply = (base) => mutateCanvas(base.canvasId, mutationInput(base, item, operationId))
  let authoritative
  let replayed = false
  try {
    const updated = await apply(current)
    replayed = updated?.replayed === true
    authoritative = replayed ? await reloadCanvas(updated.canvasId) : updated
  } catch {
    const latest = await reloadCanvas(current.canvasId)
    const state = referencePlacementState(latest?.content, item)
    if (state === "collision") throw new TypeError("Reference placement identity collision")
    if (state === "replayed") {
      authoritative = latest
      replayed = true
    } else {
      const retried = await apply(latest)
      replayed = retried?.replayed === true
      authoritative = replayed ? await reloadCanvas(retried.canvasId) : retried
    }
  }
  return Object.freeze({
    canvas: validateReferencePlacementEnvelope(authoritative, item),
    item,
    replayed,
  })
}
