import { normalizeCanvasSnapshot } from "./canvas-snapshot.js"
import { parseGalaxyObjectReference, serializeGalaxyObjectReference } from "../galaxy-object-reference.js"

export const INK_PLACEMENT_STYLE = "gb.canvas.ink-placement.v1"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256 = /^[0-9a-f]{64}$/u
const MAX_ITEMS = 2_000
const MAX_Z_INDEX = 1_000_000

function uuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${label} must be a UUID`)
  return value.toLowerCase()
}

function digest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${label} must be a SHA-256 digest`)
  return value
}

export function normalizeInkPlacementDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Ink placement descriptor must be an object")
  }
  const allowed = new Set([
    "schemaId", "documentId", "revisionSha256", "documentRevisionId", "representationId", "contentSha256",
  ])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`Ink placement descriptor.${key} is not supported`)
  }
  if (value.schemaId !== INK_PLACEMENT_STYLE) throw new TypeError("Ink placement descriptor schema is invalid")
  return Object.freeze({
    schemaId: INK_PLACEMENT_STYLE,
    documentId: uuid(value.documentId, "Ink document"),
    revisionSha256: digest(value.revisionSha256, "Ink document revision"),
    documentRevisionId: uuid(value.documentRevisionId, "Ink document revision"),
    representationId: uuid(value.representationId, "Ink representation"),
    contentSha256: digest(value.contentSha256, "Ink content"),
  })
}

export function inkRepresentationContentPath(value) {
  const descriptor = normalizeInkPlacementDescriptor(value)
  const query = new URLSearchParams({
    document_id: descriptor.documentId,
    revision_sha256: descriptor.revisionSha256,
  })
  return `/api/eln/documents/${encodeURIComponent(descriptor.documentRevisionId)}/representations/${encodeURIComponent(descriptor.representationId)}/content?${query}`
}

function documentReference(subjectRef, descriptor) {
  const parsed = parseGalaxyObjectReference(subjectRef)
  if (!parsed || parsed.format !== "canonical" || parsed.kind !== "document" || parsed.selector.mode !== "pinned") {
    throw new TypeError("Ink placement requires an exact document revision reference")
  }
  const canonical = serializeGalaxyObjectReference(parsed)
  if (canonical !== subjectRef) throw new TypeError("Ink document reference must be canonical")
  if (
    parsed.id.toLowerCase() !== descriptor.documentId
    || parsed.selector.revision !== `sha256:${descriptor.revisionSha256}`
  ) throw new TypeError("Ink descriptor does not match its document reference")
  return canonical
}

export function authorizeInkPlacementDescriptor(value, subjectRef, projection) {
  const descriptor = normalizeInkPlacementDescriptor(value)
  const canonical = documentReference(subjectRef, descriptor)
  if (
    !projection || typeof projection !== "object" || Array.isArray(projection)
    || projection.ref !== canonical
    || projection.kind !== "document"
    || projection.revision?.policy !== "pinned"
    || projection.revision?.id !== `sha256:${descriptor.revisionSha256}`
    || projection.revision?.contentHash !== descriptor.revisionSha256
    || projection.provenance?.sourceId?.toLowerCase() !== descriptor.documentId
    || !Array.isArray(projection.representations)
  ) throw new TypeError("Ink descriptor is not authorized by the resolved document")
  const representationRef = `gb:representation:document:${encodeURIComponent(descriptor.documentId)}:${encodeURIComponent(descriptor.representationId)}`
  const representation = projection.representations.find((item) => (
    item?.ref === representationRef
    && item.kind === "original"
    && item.mediaType === "application/json"
    && item.contentHash === descriptor.contentSha256
  ))
  if (!representation) throw new TypeError("Ink representation is not authorized by the resolved document")
  return descriptor
}

function nextGeometry(snapshot) {
  const content = normalizeCanvasSnapshot(snapshot)
  if (content.items.length >= MAX_ITEMS) throw new RangeError("The Atlas canvas has reached its placement limit")
  const index = content.items.length
  const highestZ = content.items.reduce((value, item) => Math.max(value, item.zIndex), -1)
  if (highestZ >= MAX_Z_INDEX) throw new RangeError("The Atlas canvas has reached its stacking limit")
  return {
    x: 80 + (index % 4) * 450,
    y: 80 + Math.floor(index / 4) * 300,
    width: 420,
    height: 260,
    zIndex: highestZ + 1,
  }
}

export function createInkCanvasItem(subjectRef, operationId, descriptor, snapshot) {
  if (typeof operationId !== "string" || !UUID.test(operationId)) {
    throw new TypeError("Ink placement operationId must be a UUID")
  }
  const style = normalizeInkPlacementDescriptor(descriptor)
  return normalizeCanvasSnapshot({
    schemaId: "gb.canvas.snapshot.v1",
    items: [{
      id: `ink-${operationId.toLowerCase()}`,
      subjectRef: documentReference(subjectRef, style),
      nodeType: "galaxy.document",
      ...nextGeometry(snapshot),
      angle: 0,
      displayMode: "ink",
      collapsed: false,
      style,
    }],
    edges: [],
    removedItemIds: [],
    removedEdgeIds: [],
  }).items[0]
}

function placementState(snapshot, item) {
  const content = normalizeCanvasSnapshot(snapshot)
  const existing = content.items.find((candidate) => candidate.id === item.id)
  if (!existing) return "absent"
  let existingStyle
  try {
    existingStyle = normalizeInkPlacementDescriptor(existing.style)
  } catch {
    return "collision"
  }
  return existing.subjectRef === item.subjectRef
    && existing.nodeType === item.nodeType
    && existingStyle.documentId === item.style.documentId
    && existingStyle.revisionSha256 === item.style.revisionSha256
    && existingStyle.documentRevisionId === item.style.documentRevisionId
    && existingStyle.representationId === item.style.representationId
    && existingStyle.contentSha256 === item.style.contentSha256
    ? "replayed"
    : "collision"
}

function validateEnvelope(canvas, item) {
  const state = placementState(canvas?.content, item)
  if (state === "collision") throw new TypeError("Ink placement identity collision")
  if (state !== "replayed") throw new TypeError("Ink placement is absent from the authoritative canvas")
  return canvas
}

function mutationInput(base, item, operationId) {
  return {
    expectedVersion: base.version,
    expectedContentHash: base.contentHash,
    idempotencyKey: `ink-place:${operationId.toLowerCase()}`,
    commands: [{ type: "item.place", item }],
  }
}

/** Place one immutable ink document as an Atlas card without copying its bytes into the canvas. */
export async function reconcileInkPlacement({
  current,
  subjectRef,
  operationId,
  descriptor,
  mutateCanvas,
  reloadCanvas,
}) {
  if (typeof mutateCanvas !== "function" || typeof reloadCanvas !== "function") {
    throw new TypeError("Ink placement requires canvas transport functions")
  }
  const item = createInkCanvasItem(subjectRef, operationId, descriptor, current?.content)
  const initialState = placementState(current?.content, item)
  if (initialState === "collision") throw new TypeError("Ink placement identity collision")
  if (initialState === "replayed") {
    return Object.freeze({ canvas: validateEnvelope(current, item), item, replayed: true })
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
    const state = placementState(latest?.content, item)
    if (state === "collision") throw new TypeError("Ink placement identity collision")
    if (state === "replayed") {
      authoritative = latest
      replayed = true
    } else {
      const retried = await apply(latest)
      replayed = retried?.replayed === true
      authoritative = replayed ? await reloadCanvas(retried.canvasId) : retried
    }
  }
  return Object.freeze({ canvas: validateEnvelope(authoritative, item), item, replayed })
}
