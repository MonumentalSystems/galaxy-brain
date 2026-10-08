const PROJECTION_MODES = new Set(["ambient", "curated"])

export function normalizeCanvasProjectionMode(value) {
  if (!PROJECTION_MODES.has(value)) {
    throw new TypeError("Invalid Atlas canvas projection mode")
  }
  return value
}

export function selectAtlasBaseProjection(canvas, projection) {
  if (
    !projection
    || typeof projection !== "object"
    || !Array.isArray(projection.placements)
    || !Array.isArray(projection.relations)
  ) {
    throw new TypeError("Invalid Atlas base projection")
  }
  if (canvas === null) return projection
  return normalizeCanvasProjectionMode(canvas?.projectionMode) === "ambient"
    ? projection
    : { placements: [], relations: [] }
}
