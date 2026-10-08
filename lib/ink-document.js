export const INK_DOCUMENT_SCHEMA_ID = "gb.ink-document.v1"
export const INK_CANVAS_WIDTH = 960
export const INK_CANVAS_HEIGHT = 540
export const MAX_INK_STROKES = 128
export const MAX_INK_POINTS = 4_096
export const MAX_INK_DOCUMENT_BYTES = 256 * 1024

const COLOR = /^#[0-9a-f]{6}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256 = /^[0-9a-f]{64}$/u

function coordinate(value, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new TypeError(`${label} is outside the ink canvas`)
  }
  return Math.round(value * 100) / 100
}

function normalizedStroke(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`strokes[${index}] must be an object`)
  }
  const allowed = new Set(["points", "color", "width", "opacity"])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`strokes[${index}].${key} is not supported`)
  }
  if (!Array.isArray(value.points) || value.points.length < 2) {
    throw new TypeError(`strokes[${index}].points must contain at least two points`)
  }
  const color = typeof value.color === "string" ? value.color.toLowerCase() : ""
  if (!COLOR.test(color)) throw new TypeError(`strokes[${index}].color is invalid`)
  if (typeof value.width !== "number" || !Number.isFinite(value.width) || value.width < 1 || value.width > 32) {
    throw new TypeError(`strokes[${index}].width is invalid`)
  }
  if (typeof value.opacity !== "number" || !Number.isFinite(value.opacity) || value.opacity < 0.1 || value.opacity > 1) {
    throw new TypeError(`strokes[${index}].opacity is invalid`)
  }
  return Object.freeze({
    color,
    width: Math.round(value.width * 100) / 100,
    opacity: Math.round(value.opacity * 100) / 100,
    points: Object.freeze(value.points.map((point, pointIndex) => {
      if (!point || typeof point !== "object" || Array.isArray(point)) {
        throw new TypeError(`strokes[${index}].points[${pointIndex}] must be an object`)
      }
      if (Object.keys(point).some((key) => key !== "x" && key !== "y")) {
        throw new TypeError(`strokes[${index}].points[${pointIndex}] has unsupported fields`)
      }
      return Object.freeze({
        x: coordinate(point.x, INK_CANVAS_WIDTH, `strokes[${index}].points[${pointIndex}].x`),
        y: coordinate(point.y, INK_CANVAS_HEIGHT, `strokes[${index}].points[${pointIndex}].y`),
      })
    })),
  })
}

export function normalizeInkStrokes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_INK_STROKES) {
    throw new TypeError("Ink must contain between 1 and 128 strokes")
  }
  const strokes = value.map(normalizedStroke)
  const pointCount = strokes.reduce((total, stroke) => total + stroke.points.length, 0)
  if (pointCount > MAX_INK_POINTS) throw new TypeError("Ink contains too many points")
  return Object.freeze(strokes)
}

function number(value) {
  return Number.isInteger(value) ? String(value) : String(value).replace(/0+$/u, "").replace(/\.$/u, "")
}

export function normalizeInkDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Ink document must be an object")
  }
  const allowed = new Set(["schemaId", "width", "height", "strokes"])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`Ink document.${key} is not supported`)
  }
  if (
    value.schemaId !== INK_DOCUMENT_SCHEMA_ID
    || value.width !== INK_CANVAS_WIDTH
    || value.height !== INK_CANVAS_HEIGHT
  ) throw new TypeError("Ink document schema or dimensions are invalid")
  return Object.freeze({
    schemaId: INK_DOCUMENT_SCHEMA_ID,
    width: INK_CANVAS_WIDTH,
    height: INK_CANVAS_HEIGHT,
    strokes: normalizeInkStrokes(value.strokes),
  })
}

export function serializeInkDocument(value) {
  const document = {
    schemaId: INK_DOCUMENT_SCHEMA_ID,
    width: INK_CANVAS_WIDTH,
    height: INK_CANVAS_HEIGHT,
    strokes: normalizeInkStrokes(value),
  }
  const json = JSON.stringify(document)
  if (new TextEncoder().encode(json).byteLength > MAX_INK_DOCUMENT_BYTES) {
    throw new TypeError("Ink document exceeds the durable document limit")
  }
  return json
}

export function renderInkDocumentSvg(value) {
  const document = normalizeInkDocument(value)
  const strokes = document.strokes
  const paths = strokes.map((stroke) => {
    const path = stroke.points.map((point, index) => `${index === 0 ? "M" : "L"}${number(point.x)} ${number(point.y)}`).join(" ")
    return `<path d="${path}" fill="none" stroke="${stroke.color}" stroke-width="${number(stroke.width)}" stroke-opacity="${number(stroke.opacity)}" stroke-linecap="round" stroke-linejoin="round"/>`
  }).join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${INK_CANVAS_WIDTH}" height="${INK_CANVAS_HEIGHT}" viewBox="0 0 ${INK_CANVAS_WIDTH} ${INK_CANVAS_HEIGHT}" role="img" aria-label="Atlas ink drawing"><rect width="100%" height="100%" fill="#fffdf7"/>${paths}</svg>`
}

export function selectInkOriginalRepresentation(value, imported) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaId !== "gb.document.representations.v1") {
    throw new TypeError("Document representations response is invalid")
  }
  if (!imported || typeof imported !== "object" || Array.isArray(imported)) {
    throw new TypeError("Imported document is invalid")
  }
  const documentId = typeof imported.document_id === "string" ? imported.document_id.toLowerCase() : ""
  const revisionId = typeof imported.revision_id === "string" ? imported.revision_id.toLowerCase() : ""
  const revisionSha256 = typeof imported.revision_sha256 === "string" ? imported.revision_sha256 : ""
  if (
    !UUID.test(documentId) || !UUID.test(revisionId) || !SHA256.test(revisionSha256)
    || value.document_revision_id !== revisionId || !Array.isArray(value.representations)
  ) {
    throw new TypeError("Document representations do not match the imported revision")
  }
  const representation = value.representations.find((item) => (
    item && typeof item === "object" && !Array.isArray(item)
    && item.kind === "original"
    && item.media_type === "application/json"
    && item.content_sha256 === imported.content_sha256
  ))
  if (
    !representation
    || typeof representation.id !== "string"
    || !UUID.test(representation.id)
    || typeof representation.content_sha256 !== "string"
    || !SHA256.test(representation.content_sha256)
  ) {
    throw new TypeError("The exact ink representation is unavailable")
  }
  return Object.freeze({
    schemaId: "gb.canvas.ink-placement.v1",
    documentId,
    revisionSha256,
    documentRevisionId: revisionId,
    representationId: representation.id.toLowerCase(),
    contentSha256: representation.content_sha256,
  })
}
