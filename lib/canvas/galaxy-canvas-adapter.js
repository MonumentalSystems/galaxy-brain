import { asEdgeId, asNodeId } from "@canvas-harness/core"

import { parseGalaxyObjectReference } from "../galaxy-object-reference.js"

export const GALAXY_CANVAS_NODE_TYPES = Object.freeze([
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

export const GALAXY_RELATION_TRUST_CLASSES = Object.freeze([
  "deterministic",
  "asserted",
  "verified",
  "near",
  "presentation",
])

const NODE_TYPE_SET = new Set(GALAXY_CANVAS_NODE_TYPES)
const TRUST_CLASS_SET = new Set(GALAXY_RELATION_TRUST_CLASSES)
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const MAX_COORDINATE = 10_000_000
const MIN_DIMENSION = 80
const MAX_DIMENSION = 2_400
const FRAME_TONE_STYLES = Object.freeze({
  neutral: Object.freeze({ backgroundColor: "#f7f5ef", strokeColor: "#a8a29e" }),
  sage: Object.freeze({ backgroundColor: "#eef4ec", strokeColor: "#6d7a68" }),
  amber: Object.freeze({ backgroundColor: "#fff7df", strokeColor: "#c79a4b" }),
  plum: Object.freeze({ backgroundColor: "#f6edf5", strokeColor: "#8b5d83" }),
})

export const UNAVAILABLE_CANVAS_DISPLAY = Object.freeze({
  title: "Unavailable reference",
  summary: "This durable placement remains movable while its object preview is unavailable.",
  status: "Unavailable",
  provenance: "Durable placement only; no object content is cached in the canvas.",
  badges: Object.freeze(["Locked"]),
})

function unavailableDisplay() {
  return { ...UNAVAILABLE_CANVAS_DISPLAY, badges: [...UNAVAILABLE_CANVAS_DISPLAY.badges] }
}

function invalid(message) {
  throw new TypeError(`Invalid Galaxy canvas projection: ${message}`)
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) invalid(`${label} must be a stable identifier`)
  return value
}

function requireFinite(value, label, minimum = -MAX_COORDINATE, maximum = MAX_COORDINATE) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(`${label} must be finite and between ${minimum} and ${maximum}`)
  }
  return value
}

function requireText(value, label, maximum) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    invalid(`${label} must be a non-empty string of at most ${maximum} characters`)
  }
  return value
}

function optionalText(value, label, maximum) {
  if (value === undefined || value === null || value === "") return undefined
  return requireText(value, label, maximum)
}

function requireSubjectReference(value) {
  const parsed = typeof value === "string" && value.length <= 1_024
    ? parseGalaxyObjectReference(value)
    : null
  if (!parsed || parsed.format !== "canonical") {
    invalid("subjectRef must be a bounded canonical Galaxy object reference")
  }
  return value
}

function sanitizeDisplay(display, label) {
  if (!display || typeof display !== "object" || Array.isArray(display)) invalid(`${label}.display must be an object`)
  const badges = display.badges === undefined
    ? []
    : Array.isArray(display.badges)
      ? display.badges.slice(0, 8).map((value, index) => requireText(value, `${label}.display.badges[${index}]`, 80))
      : invalid(`${label}.display.badges must be an array`)

  const result = {
    title: requireText(display.title, `${label}.display.title`, 240),
    subtitle: optionalText(display.subtitle, `${label}.display.subtitle`, 320),
    summary: optionalText(display.summary, `${label}.display.summary`, 2_000),
    revision: optionalText(display.revision, `${label}.display.revision`, 160),
    status: optionalText(display.status, `${label}.display.status`, 80),
    provenance: optionalText(display.provenance, `${label}.display.provenance`, 320),
    href: optionalText(display.href, `${label}.display.href`, 1_024),
    markdown: optionalText(display.markdown, `${label}.display.markdown`, 12_000),
    mediaType: optionalText(display.mediaType, `${label}.display.mediaType`, 160),
    badges,
  }

  if (result.href && !result.href.startsWith("/")) invalid(`${label}.display.href must be an internal route`)
  if (display.surfaceSpec !== undefined) result.surfaceSpec = display.surfaceSpec
  return result
}

export function canvasNodeId(placementId) {
  return asNodeId(`placement:${requireIdentifier(placementId, "placementId")}`)
}

export function canvasEdgeId(relationId) {
  return asEdgeId(`relation:${requireIdentifier(relationId, "relationId")}`)
}

export function canvasFrameNodeId(frameId) {
  return asNodeId(`frame:${requireIdentifier(frameId, "frameId")}`)
}

function projectFrame(frame, index) {
  const label = `frames[${index}]`
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) invalid(`${label} must be an object`)
  const id = requireIdentifier(frame.id, `${label}.id`)
  const style = FRAME_TONE_STYLES[frame.tone]
  if (!style) invalid(`${label}.tone is not registered`)
  return {
    id: canvasFrameNodeId(id),
    type: "frame",
    x: requireFinite(frame.x, `${label}.x`),
    y: requireFinite(frame.y, `${label}.y`),
    w: requireFinite(frame.width, `${label}.width`, 160, 10_000),
    h: requireFinite(frame.height, `${label}.height`, 160, 10_000),
    angle: 0,
    z: -1000 + index,
    groups: [],
    locked: false,
    content: requireText(frame.title, `${label}.title`, 120),
    style: { ...style, strokeWidth: 2, autoFit: false },
    data: { schemaId: "gb.canvas.frame.v1", frameId: id, tone: frame.tone },
  }
}

function projectPlacement(placement, index) {
  const label = `placements[${index}]`
  if (!placement || typeof placement !== "object" || Array.isArray(placement)) invalid(`${label} must be an object`)
  const id = requireIdentifier(placement.id, `${label}.id`)
  if (!NODE_TYPE_SET.has(placement.nodeType)) invalid(`${label}.nodeType is not registered`)
  const availability = placement.availability === "unavailable" ? "unavailable" : "resolved"
  if (availability === "unavailable" && placement.authorized !== false) {
    invalid(`${label} unavailable placeholders must not be authorized projections`)
  }
  if (availability === "resolved" && placement.authorized !== true) {
    invalid(`${label} resolved placements require explicit authorization`)
  }
  const z = placement.zIndex === undefined
    ? index
    : requireFinite(placement.zIndex, `${label}.zIndex`, -1_000_000, 1_000_000)
  if (!Number.isInteger(z)) invalid(`${label}.zIndex must be an integer`)

  return {
    id: canvasNodeId(id),
    type: placement.nodeType,
    x: requireFinite(placement.x, `${label}.x`),
    y: requireFinite(placement.y, `${label}.y`),
    w: requireFinite(placement.width, `${label}.width`, MIN_DIMENSION, MAX_DIMENSION),
    h: requireFinite(placement.height, `${label}.height`, MIN_DIMENSION, MAX_DIMENSION),
    angle: requireFinite(placement.angle ?? 0, `${label}.angle`, -360, 360),
    z,
    groups: [],
    locked: true,
    data: {
      schemaId: "gb.canvas.node.v1",
      placementId: id,
      subjectRef: requireSubjectReference(placement.subjectRef),
      availability,
      display: availability === "unavailable"
        ? unavailableDisplay()
        : sanitizeDisplay(placement.display, label),
      placementState: {
        displayMode: optionalText(placement.displayMode, `${label}.displayMode`, 80) ?? "card",
        collapsed: placement.collapsed === true,
        style: placement.style && typeof placement.style === "object" && !Array.isArray(placement.style)
          ? placement.style
          : {},
      },
    },
  }
}

function relationStyle(trustClass) {
  switch (trustClass) {
    case "deterministic":
      return { strokeColor: "#315f49", strokeWidth: 2, targetArrowhead: "arrow" }
    case "asserted":
      return { strokeColor: "#7c3f83", strokeWidth: 2, strokeStyle: "dashed", targetArrowhead: "arrow" }
    case "verified":
      return { strokeColor: "#a16207", strokeWidth: 3, targetArrowhead: "arrow-filled" }
    case "near":
      return { strokeColor: "#64748b", strokeWidth: 1.5, strokeStyle: "dotted", targetArrowhead: "none" }
    case "presentation":
      return { strokeColor: "#64748b", strokeWidth: 1, strokeStyle: "dashed", targetArrowhead: "none" }
  }
}

function projectRelation(relation, index, placementNodes) {
  const label = `relations[${index}]`
  if (!relation || typeof relation !== "object" || Array.isArray(relation)) invalid(`${label} must be an object`)
  const id = requireIdentifier(relation.id, `${label}.id`)
  const sourcePlacementId = requireIdentifier(relation.sourcePlacementId, `${label}.sourcePlacementId`)
  const targetPlacementId = requireIdentifier(relation.targetPlacementId, `${label}.targetPlacementId`)
  const sourceNode = placementNodes.get(sourcePlacementId)
  const targetNode = placementNodes.get(targetPlacementId)
  if (!sourceNode || !targetNode) return null
  if (!TRUST_CLASS_SET.has(relation.trustClass)) invalid(`${label}.trustClass is not registered`)
  if (relation.trustClass === "near" && relation.relationType !== "near") {
    invalid(`${label} HAM candidates must use the near relation type`)
  }
  if (relation.trustClass === "verified" && !relation.evidenceRef) {
    invalid(`${label} verified relations require an evidenceRef`)
  }

  return {
    id: canvasEdgeId(id),
    source: { nodeId: sourceNode.id, localOffset: { x: sourceNode.w / 2, y: sourceNode.h / 2 } },
    target: { nodeId: targetNode.id, localOffset: { x: targetNode.w / 2, y: targetNode.h / 2 } },
    pathStyle: relation.trustClass === "near" ? "bezier" : "straight",
    z: -1,
    groups: [],
    locked: true,
    content: requireText(relation.relationType, `${label}.relationType`, 80),
    style: relationStyle(relation.trustClass),
    data: {
      schemaId: "gb.canvas.relation.v1",
      trustClass: relation.trustClass,
      owner: requireText(relation.owner, `${label}.owner`, 120),
      provenance: optionalText(relation.provenance, `${label}.provenance`, 320),
      evidenceRef: relation.evidenceRef === undefined
        ? undefined
        : requireSubjectReference(relation.evidenceRef),
      presentationStyle: relation.trustClass === "presentation" && relation.style && typeof relation.style === "object"
        ? relation.style
        : undefined,
    },
  }
}

/**
 * Project an already-authorized Galaxy envelope into a deterministic,
 * read-only canvas-harness scene slice. Authorization must happen upstream;
 * explicitly unreadable placements are omitted as a defense-in-depth guard.
 */
export function projectGalaxyCanvas(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("input must be an object")
  if (!Array.isArray(input.placements) || !Array.isArray(input.relations)) invalid("placements and relations must be arrays")
  if (input.frames !== undefined && (!Array.isArray(input.frames) || input.frames.length > 100)) {
    invalid("frames must be a bounded array")
  }

  for (const [index, placement] of input.placements.entries()) {
    if (placement?.availability !== undefined && !["resolved", "unavailable"].includes(placement.availability)) {
      invalid(`placements[${index}].availability is not registered`)
    }
    if (placement?.availability === "unavailable" && placement.authorized !== false) {
      invalid(`placements[${index}] unavailable placeholders must not be authorized projections`)
    }
    if (placement?.availability === "resolved" && placement.authorized !== true) {
      invalid(`placements[${index}] resolved placements require explicit authorization`)
    }
  }
  const readable = input.placements.filter((placement) => (
    placement?.authorized === true ||
    (placement?.authorized === false && placement?.availability === "unavailable")
  ))
  const sortedPlacements = [...readable].sort((left, right) => String(left.id).localeCompare(String(right.id)))
  const placementIds = new Set()
  const placementNodesList = sortedPlacements.map((placement, index) => {
    const id = requireIdentifier(placement.id, `placements[${index}].id`)
    if (placementIds.has(id)) invalid(`duplicate placement id ${id}`)
    placementIds.add(id)
    return projectPlacement(placement, index)
  })

  const placementNodes = new Map(placementNodesList.map((node) => [node.data.placementId, node]))
  const frameIds = new Set()
  const frameNodes = [...(input.frames ?? [])]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .map((frame, index) => {
      const id = requireIdentifier(frame.id, `frames[${index}].id`)
      if (frameIds.has(id)) invalid(`duplicate frame id ${id}`)
      frameIds.add(id)
      return projectFrame(frame, index)
    })
  const relationIds = new Set()
  const edges = [...input.relations]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .map((relation, index) => {
      const id = requireIdentifier(relation.id, `relations[${index}].id`)
      if (relationIds.has(id)) invalid(`duplicate relation id ${id}`)
      relationIds.add(id)
      return projectRelation(relation, index, placementNodes)
    })
    .filter(Boolean)

  return { nodes: [...frameNodes, ...placementNodesList], edges }
}
