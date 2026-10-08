import { inspectPlaceableReference } from "./canvas/reference-placement.js"

export const ATLAS_OBJECT_DRAG_MIME = "application/x-galaxy-atlas-object"
export const ATLAS_OBJECT_DRAG_SCHEMA_ID = "gb.atlas.object-drag.v1"

const MAX_PAYLOAD_CHARACTERS = 4_096
const MAX_LABEL_CHARACTERS = 240
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u

function invalid(message = "This dragged Galaxy object is invalid or unavailable.") {
  throw new TypeError(message)
}

function normalizeLabel(value) {
  if (typeof value !== "string") invalid()
  const label = value.trim()
  if (!label || Array.from(label).length > MAX_LABEL_CHARACTERS || CONTROL_CHARACTERS.test(label)) invalid()
  return label
}

function normalizeIntent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
  if (Object.keys(value).sort().join("\n") !== "label\nschemaId\nsubjectRef") invalid()
  if (value.schemaId !== ATLAS_OBJECT_DRAG_SCHEMA_ID) invalid()
  const inspected = inspectPlaceableReference(value.subjectRef)
  if (!inspected.ok) invalid("This Galaxy object cannot be placed on an Atlas canvas.")
  return Object.freeze({
    schemaId: ATLAS_OBJECT_DRAG_SCHEMA_ID,
    subjectRef: inspected.subjectRef,
    label: normalizeLabel(value.label),
  })
}

export function hasAtlasObjectDrag(transfer) {
  if (!transfer || typeof transfer !== "object") return false
  try {
    return Array.from(transfer.types ?? []).some((type) => String(type).toLowerCase() === ATLAS_OBJECT_DRAG_MIME)
  } catch {
    return false
  }
}

export function writeAtlasObjectDrag(transfer, input) {
  if (!transfer || typeof transfer.setData !== "function") invalid()
  const intent = normalizeIntent({
    schemaId: ATLAS_OBJECT_DRAG_SCHEMA_ID,
    subjectRef: input?.subjectRef,
    label: input?.label,
  })
  transfer.setData(ATLAS_OBJECT_DRAG_MIME, JSON.stringify(intent))
  transfer.effectAllowed = "copy"
  return intent
}

export function parseAtlasObjectDrop(transfer) {
  if (!hasAtlasObjectDrag(transfer)) invalid("This drop does not contain a Galaxy object.")
  let files = []
  try {
    files = Array.from(transfer.files ?? [])
  } catch {}
  if (files.length > 0) invalid("Galaxy objects cannot be dropped together with local files.")
  const raw = transfer.getData?.(ATLAS_OBJECT_DRAG_MIME)
  if (typeof raw !== "string" || !raw || raw.length > MAX_PAYLOAD_CHARACTERS) invalid()
  try {
    return normalizeIntent(JSON.parse(raw))
  } catch (error) {
    if (error instanceof TypeError) throw error
    invalid()
  }
}

export function authorizeAtlasObjectDrop(intent, hydration) {
  const normalized = normalizeIntent(intent)
  if (
    !hydration
    || hydration.status !== "resolved"
    || hydration.requestedRef !== normalized.subjectRef
    || hydration.projection?.schemaId !== "gb.object-projection.v1"
    || hydration.projection.ref !== hydration.resolvedRef
    || !Array.isArray(hydration.projection.capabilities)
    || !hydration.projection.capabilities.includes("place")
  ) invalid("This exact Galaxy object is unavailable or you no longer have permission to place it.")
  const resolved = inspectPlaceableReference(hydration.resolvedRef)
  if (!resolved.ok || hydration.projection.kind !== resolved.kind) {
    invalid("The authorized object no longer matches this placement request.")
  }
  return Object.freeze({
    subjectRef: resolved.subjectRef,
    label: normalizeLabel(hydration.projection.title || normalized.label),
  })
}

export function createAtlasDropOperationLock() {
  let active = false
  return Object.freeze({
    active: () => active,
    run: async (operation) => {
      if (active || typeof operation !== "function") return false
      active = true
      try {
        await operation()
        return true
      } finally {
        active = false
      }
    },
  })
}

export function selectAtlasPendingDropRecovery(pending, recoveries = {}) {
  if (!pending || (pending.kind !== "file" && pending.kind !== "object")
    || typeof pending.operationId !== "string" || !pending.operationId) return null
  const recovery = pending.kind === "file" ? recoveries.file : recoveries.object
  return recovery?.operationId === pending.operationId ? recovery : null
}
