import { parseGalaxyObjectReference } from "../galaxy-object-reference.js"

export const CANVAS_SNAPSHOT_SCHEMA = "gb.canvas.snapshot.v1"
export const CANVAS_CHANGED_SCHEMA = "gb.canvas.changed.v1"
export const CANVAS_CHANGE_POLL_INTERVAL_MS = 5_000
export const CANVAS_CHANGE_POLL_MAX_INTERVAL_MS = 30_000
export const CANVAS_NODE_TYPES = Object.freeze([
  "galaxy.paper",
  "galaxy.note",
  "galaxy.document",
  "galaxy.media",
  "galaxy.eln-record",
  "galaxy.task",
  "galaxy.chat",
  "galaxy.proof",
  "galaxy.surface",
])
export const CANVAS_FRAME_TONES = Object.freeze(["neutral", "sage", "amber", "plum"])

const NODE_TYPE_SET = new Set(CANVAS_NODE_TYPES)
const FRAME_TONE_SET = new Set(CANVAS_FRAME_TONES)
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/u
const LONE_SURROGATE = /[\ud800-\udfff]/u
const MAX_COORDINATE = 10_000_000
const MAX_DIMENSION = 2_400
const MIN_FRAME_DIMENSION = 160
const MAX_FRAME_DIMENSION = 10_000

function invalid(message) {
  throw new TypeError(`Invalid Galaxy canvas snapshot: ${message}`)
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`)
  return value
}

function exactKeys(value, keys, label) {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${label}.${key} is not supported`)
  }
}

function identifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) invalid(`${label} must be a stable identifier`)
  return value
}

function identifierList(value, label, maximum) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximum) invalid(`${label} must be a bounded array`)
  const normalized = value.map((entry, index) => identifier(entry, `${label}[${index}]`)).sort()
  if (new Set(normalized).size !== normalized.length) invalid(`${label} must not contain duplicates`)
  return normalized
}

function text(value, label, maximum, optional = false) {
  if (optional && (value === undefined || value === null || value === "")) return undefined
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum || LONE_SURROGATE.test(value)) {
    invalid(`${label} must be bounded text without lone surrogates`)
  }
  return value
}

function number(value, label, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(`${label} must be a finite number between ${minimum} and ${maximum}`)
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) invalid(`${label} must be exactly representable`)
  return Object.is(value, -0) ? 0 : value
}

function integer(value, label, minimum, maximum) {
  const normalized = number(value, label, minimum, maximum)
  if (!Number.isInteger(normalized)) invalid(`${label} must be an integer`)
  return normalized
}

function reference(value, label) {
  const parsed = typeof value === "string" ? parseGalaxyObjectReference(value) : null
  if (!parsed || parsed.format !== "canonical") invalid(`${label} must be a canonical Galaxy object reference`)
  return value
}

function jsonValue(value, label, depth = 0) {
  if (depth > 8) invalid(`${label} is too deeply nested`)
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "string") {
    if (value.length > 2_000 || LONE_SURROGATE.test(value)) invalid(`${label} contains invalid text`)
    return value
  }
  if (typeof value === "number") return number(value, label, -MAX_COORDINATE, MAX_COORDINATE)
  if (Array.isArray(value)) {
    if (value.length > 32) invalid(`${label} contains too many values`)
    return value.map((entry, index) => jsonValue(entry, `${label}[${index}]`, depth + 1))
  }
  if (!value || typeof value !== "object") invalid(`${label} must contain JSON values`)
  const entries = Object.keys(value)
  if (entries.length > 32) invalid(`${label} contains too many properties`)
  return Object.fromEntries(entries.sort().map((key) => {
    text(key, `${label} key`, 80)
    return [key, jsonValue(value[key], `${label}.${key}`, depth + 1)]
  }))
}

function item(value, index) {
  const label = `items[${index}]`
  const source = object(value, label)
  exactKeys(source, [
    "id", "subjectRef", "nodeType", "x", "y", "width", "height", "angle",
    "zIndex", "displayMode", "collapsed", "style",
  ], label)
  if (!NODE_TYPE_SET.has(source.nodeType)) invalid(`${label}.nodeType is not registered`)
  if (typeof source.collapsed !== "boolean") invalid(`${label}.collapsed must be boolean`)
  return {
    id: identifier(source.id, `${label}.id`),
    subjectRef: reference(source.subjectRef, `${label}.subjectRef`),
    nodeType: source.nodeType,
    x: number(source.x, `${label}.x`, -MAX_COORDINATE, MAX_COORDINATE),
    y: number(source.y, `${label}.y`, -MAX_COORDINATE, MAX_COORDINATE),
    width: number(source.width, `${label}.width`, 80, MAX_DIMENSION),
    height: number(source.height, `${label}.height`, 80, MAX_DIMENSION),
    angle: number(source.angle, `${label}.angle`, -360, 360),
    zIndex: integer(source.zIndex, `${label}.zIndex`, -1_000_000, 1_000_000),
    displayMode: text(source.displayMode, `${label}.displayMode`, 80),
    collapsed: source.collapsed,
    style: jsonValue(object(source.style, `${label}.style`), `${label}.style`),
  }
}

function edge(value, index, itemIds) {
  const label = `edges[${index}]`
  const source = object(value, label)
  exactKeys(source, [
    "id", "sourceItemId", "targetItemId", "edgeKind", "label", "semanticRef", "style",
  ], label)
  const sourceItemId = identifier(source.sourceItemId, `${label}.sourceItemId`)
  const targetItemId = identifier(source.targetItemId, `${label}.targetItemId`)
  if (!itemIds.has(sourceItemId) || !itemIds.has(targetItemId)) invalid(`${label} endpoints must exist`)
  if (sourceItemId === targetItemId) invalid(`${label} cannot connect an item to itself`)
  const normalized = {
    id: identifier(source.id, `${label}.id`),
    sourceItemId,
    targetItemId,
    edgeKind: text(source.edgeKind, `${label}.edgeKind`, 80),
    style: jsonValue(object(source.style, `${label}.style`), `${label}.style`),
  }
  const edgeLabel = text(source.label, `${label}.label`, 240, true)
  const semanticRef = source.semanticRef === undefined || source.semanticRef === null || source.semanticRef === ""
    ? undefined
    : reference(source.semanticRef, `${label}.semanticRef`)
  if (edgeLabel !== undefined) normalized.label = edgeLabel
  if (semanticRef !== undefined) normalized.semanticRef = semanticRef
  return normalized
}

function frame(value, index) {
  const label = `frames[${index}]`
  const source = object(value, label)
  exactKeys(source, ["id", "title", "x", "y", "width", "height", "tone"], label)
  if (!FRAME_TONE_SET.has(source.tone)) invalid(`${label}.tone is not registered`)
  return {
    id: identifier(source.id, `${label}.id`),
    title: text(source.title, `${label}.title`, 120),
    x: number(source.x, `${label}.x`, -MAX_COORDINATE, MAX_COORDINATE),
    y: number(source.y, `${label}.y`, -MAX_COORDINATE, MAX_COORDINATE),
    width: number(source.width, `${label}.width`, MIN_FRAME_DIMENSION, MAX_FRAME_DIMENSION),
    height: number(source.height, `${label}.height`, MIN_FRAME_DIMENSION, MAX_FRAME_DIMENSION),
    tone: source.tone,
  }
}

export function normalizeCanvasSnapshot(value) {
  const source = object(value, "content")
  exactKeys(source, ["schemaId", "items", "edges", "frames", "removedItemIds", "removedEdgeIds"], "content")
  if (source.schemaId !== CANVAS_SNAPSHOT_SCHEMA) invalid(`schemaId must equal ${CANVAS_SNAPSHOT_SCHEMA}`)
  if (!Array.isArray(source.items) || source.items.length > 2_000) invalid("items must be a bounded array")
  if (!Array.isArray(source.edges) || source.edges.length > 4_000) invalid("edges must be a bounded array")
  if (source.frames !== undefined && (!Array.isArray(source.frames) || source.frames.length > 100)) {
    invalid("frames must be a bounded array")
  }
  const items = source.items.map(item).sort((left, right) => left.id.localeCompare(right.id))
  const itemIds = new Set()
  for (const entry of items) {
    if (itemIds.has(entry.id)) invalid(`duplicate item ${entry.id}`)
    itemIds.add(entry.id)
  }
  const edges = source.edges.map((entry, index) => edge(entry, index, itemIds))
    .sort((left, right) => left.id.localeCompare(right.id))
  const edgeIds = new Set()
  for (const entry of edges) {
    if (edgeIds.has(entry.id)) invalid(`duplicate edge ${entry.id}`)
    edgeIds.add(entry.id)
  }
  const removedItemIds = identifierList(source.removedItemIds, "removedItemIds", 2_000)
  const removedEdgeIds = identifierList(source.removedEdgeIds, "removedEdgeIds", 4_000)
  const frames = (source.frames ?? []).map(frame).sort((left, right) => left.id.localeCompare(right.id))
  if (new Set(frames.map((entry) => entry.id)).size !== frames.length) invalid("duplicate frame id")
  if (removedItemIds.some((id) => itemIds.has(id))) invalid("an item cannot also be removed")
  if (removedEdgeIds.some((id) => edgeIds.has(id))) invalid("an edge cannot also be removed")
  return {
    schemaId: CANVAS_SNAPSHOT_SCHEMA,
    items,
    edges,
    ...(frames.length === 0 ? {} : { frames }),
    removedItemIds,
    removedEdgeIds,
  }
}

function recursivelySorted(value) {
  if (Array.isArray(value)) return value.map(recursivelySorted)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, recursivelySorted(value[key])]))
  }
  return value
}

export function serializeCanvasSnapshot(value) {
  return JSON.stringify(recursivelySorted(normalizeCanvasSnapshot(value)))
}

export async function hashCanvasSnapshot(value) {
  const bytes = new TextEncoder().encode(serializeCanvasSnapshot(value))
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  const hexadecimal = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `sha256:${hexadecimal}`
}

export function validateCanvasChangeEvent(value) {
  const event = object(value, "event")
  exactKeys(event, ["schemaId", "canvasId", "version", "contentHash", "mutationId"], "event")
  if (event.schemaId !== CANVAS_CHANGED_SCHEMA) invalid(`event.schemaId must equal ${CANVAS_CHANGED_SCHEMA}`)
  if (typeof event.canvasId !== "string" || !/^[0-9a-f-]{36}$/u.test(event.canvasId)) invalid("event.canvasId is invalid")
  if (!CONTENT_HASH.test(event.contentHash)) invalid("event.contentHash is invalid")
  return {
    schemaId: CANVAS_CHANGED_SCHEMA,
    canvasId: event.canvasId,
    version: integer(event.version, "event.version", 1, Number.MAX_SAFE_INTEGER),
    contentHash: event.contentHash,
    mutationId: identifier(event.mutationId, "event.mutationId"),
  }
}

export function canvasChangeAction(current, pendingChanges, event) {
  const normalized = validateCanvasChangeEvent(event)
  const observed = object(current, "current")
  exactKeys(observed, ["version", "contentHash"], "current")
  const currentVersion = integer(observed.version, "current.version", 1, Number.MAX_SAFE_INTEGER)
  if (!CONTENT_HASH.test(observed.contentHash)) invalid("current.contentHash is invalid")
  if (normalized.version < currentVersion) return "ignore"
  if (normalized.version === currentVersion && normalized.contentHash === observed.contentHash) return "ignore"
  if (pendingChanges) return "conflict"
  return "notify"
}

export function canvasReloadSatisfiesChange(canvas, event) {
  if (!canvas || canvas.canvasId !== event.canvasId) return false
  if (canvas.version > event.version) return true
  return canvas.version === event.version && canvas.contentHash === event.contentHash
}

export function canvasChangeEventFromRevision(canvasId, revision) {
  const source = object(revision, "revision")
  return validateCanvasChangeEvent({
    schemaId: CANVAS_CHANGED_SCHEMA,
    canvasId,
    version: source.version,
    contentHash: source.content_hash,
    mutationId: source.id,
  })
}

export function canvasChangePollDelay(consecutiveFailures) {
  const failures = integer(consecutiveFailures, "consecutiveFailures", 0, Number.MAX_SAFE_INTEGER)
  return Math.min(
    CANVAS_CHANGE_POLL_INTERVAL_MS * (2 ** Math.min(failures, 3)),
    CANVAS_CHANGE_POLL_MAX_INTERVAL_MS,
  )
}
