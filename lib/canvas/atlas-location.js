const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const PLACEMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const ATLAS_DEEP_LINK_PARAMETERS = ["canvas", "placement", "ref", "placeRef"]

function invalid(message) {
  throw new TypeError(`Invalid Atlas location: ${message}`)
}

export function atlasPlacementHref(canvasId, placementId) {
  if (typeof canvasId !== "string" || !UUID.test(canvasId)) invalid("canvas id is invalid")
  if (typeof placementId !== "string" || !PLACEMENT_ID.test(placementId)) invalid("placement id is invalid")
  return `/workspace?${new URLSearchParams({
    canvas: canvasId.toLowerCase(),
    placement: placementId,
  }).toString()}`
}

export function atlasCanvasHref(canvasId) {
  if (typeof canvasId !== "string" || !UUID.test(canvasId)) invalid("canvas id is invalid")
  return `/workspace?${new URLSearchParams({ canvas: canvasId.toLowerCase() }).toString()}`
}

export function atlasWorkspaceHref(searchParams = {}) {
  const target = new URLSearchParams()
  for (const key of ATLAS_DEEP_LINK_PARAMETERS) {
    const value = searchParams[key]
    if (key === "placeRef" && Array.isArray(value)) {
      for (const candidate of value) {
        if (typeof candidate === "string" && candidate) target.append(key, candidate)
      }
      continue
    }
    const first = Array.isArray(value) ? value[0] : value
    if (typeof first === "string" && first) target.set(key, first)
  }
  const query = target.toString()
  return query ? `/workspace?${query}` : "/workspace"
}

export function parseAtlasLocation(search) {
  const parameters = new URLSearchParams(String(search || "").replace(/^\?/, ""))
  const canvas = parameters.get("canvas")
  const placement = parameters.get("placement")
  if (canvas !== null && !UUID.test(canvas)) invalid("canvas id is invalid")
  if (placement !== null && !PLACEMENT_ID.test(placement)) invalid("placement id is invalid")
  return {
    canvasId: canvas?.toLowerCase() ?? null,
    placementId: placement,
  }
}
