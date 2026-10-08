const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const CANVAS_SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/u
const SHA256 = /^sha256:[0-9a-f]{64}$/u
const PROJECTION_MODES = new Set(["ambient", "curated"])

export const ATLAS_CANVAS_CATALOG_LIMIT = 50
export const DEFAULT_ATLAS_WORKSPACE_ID = "default-workspace"

function invalid(message) {
  throw new TypeError(`Invalid Atlas canvas catalog: ${message}`)
}

function normalizeRecord(value, workspaceId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("canvas record is malformed")
  if (typeof value.canvasId !== "string" || !CANONICAL_UUID.test(value.canvasId)) invalid("canvas id is not canonical")
  if (value.workspaceId !== workspaceId) invalid("canvas workspace does not match the active workspace")
  if (typeof value.slug !== "string" || !CANVAS_SLUG.test(value.slug)) invalid("canvas slug is invalid")
  const titleLength = typeof value.title === "string" ? Array.from(value.title).length : 0
  if (typeof value.title !== "string" || value.title !== value.title.trim() || titleLength < 1 || titleLength > 200) {
    invalid("canvas title is invalid")
  }
  if (typeof value.isDefault !== "boolean") invalid("canvas default marker is invalid")
  if (!PROJECTION_MODES.has(value.projectionMode)) invalid("canvas projection mode is invalid")
  if (!Number.isSafeInteger(value.version) || value.version < 1) invalid("canvas version is invalid")
  if (typeof value.contentHash !== "string" || !SHA256.test(value.contentHash)) invalid("canvas content hash is invalid")
  return {
    canvasId: value.canvasId,
    workspaceId: value.workspaceId,
    slug: value.slug,
    title: value.title,
    isDefault: value.isDefault,
    projectionMode: value.projectionMode,
    version: value.version,
    contentHash: value.contentHash,
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
  }
}

function sameRecord(left, right) {
  return left.canvasId === right.canvasId
    && left.workspaceId === right.workspaceId
    && left.slug === right.slug
    && left.title === right.title
    && left.isDefault === right.isDefault
    && left.projectionMode === right.projectionMode
}

export function selectAtlasWorkspaceId(activeCanvas, tenantCanvases, browserWorkspaces) {
  const activeWorkspaceId = activeCanvas?.workspaceId
  if (activeWorkspaceId !== undefined) {
    if (typeof activeWorkspaceId !== "string" || !WORKSPACE_ID.test(activeWorkspaceId)) {
      invalid("active canvas workspace id is invalid")
    }
    return activeWorkspaceId
  }

  if (!Array.isArray(tenantCanvases)) invalid("tenant canvas catalog is not an array")
  const recovered = tenantCanvases.find((candidate) => candidate?.isDefault === true) ?? tenantCanvases[0]
  if (recovered !== undefined) {
    if (typeof recovered?.workspaceId !== "string" || !WORKSPACE_ID.test(recovered.workspaceId)) {
      invalid("server canvas workspace id is invalid")
    }
    return recovered.workspaceId
  }

  if (!Array.isArray(browserWorkspaces)) invalid("browser workspace cache is not an array")
  const localWorkspaceId = browserWorkspaces[0]?.id
  if (localWorkspaceId !== undefined) {
    if (typeof localWorkspaceId !== "string" || !WORKSPACE_ID.test(localWorkspaceId)) {
      invalid("browser workspace id is invalid")
    }
    return localWorkspaceId
  }
  return DEFAULT_ATLAS_WORKSPACE_ID
}

export function normalizeAtlasCanvasCatalog(records, {
  workspaceId,
  activeCanvas = null,
  requestedCanvasId = null,
} = {}) {
  if (!Array.isArray(records)) invalid("response is not an array")
  if (records.length > ATLAS_CANVAS_CATALOG_LIMIT) invalid("response exceeds the 50 canvas limit")
  if (typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) invalid("workspace id is invalid")
  if (requestedCanvasId !== null && (typeof requestedCanvasId !== "string" || !CANONICAL_UUID.test(requestedCanvasId))) {
    invalid("requested canvas id is not canonical")
  }

  const canvases = []
  const byId = new Map()
  for (const value of records) {
    const canvas = normalizeRecord(value, workspaceId)
    if (byId.has(canvas.canvasId)) invalid("response contains a duplicate canvas id")
    byId.set(canvas.canvasId, canvas)
    canvases.push(canvas)
  }

  let active = null
  if (activeCanvas !== null) {
    active = normalizeRecord(activeCanvas, workspaceId)
    if (requestedCanvasId !== null && active.canvasId !== requestedCanvasId) {
      invalid("requested canvas response identity does not match")
    }
    const listed = byId.get(active.canvasId)
    if (listed && !sameRecord(listed, active)) invalid("active canvas conflicts with its catalog record")
    if (listed) {
      const index = canvases.findIndex((canvas) => canvas.canvasId === active.canvasId)
      canvases[index] = active
      byId.set(active.canvasId, active)
    } else {
      if (records.length === ATLAS_CANVAS_CATALOG_LIMIT) invalid("active canvas is omitted from the bounded catalog")
      byId.set(active.canvasId, active)
      canvases.push(active)
    }
  } else if (requestedCanvasId !== null) {
    invalid("requested canvas response is missing")
  }

  const defaults = canvases.filter((canvas) => canvas.isDefault)
  if (canvases.length > 0 && defaults.length !== 1) invalid("workspace must expose exactly one default canvas")

  const ordered = []
  if (defaults[0]) ordered.push(defaults[0])
  if (active && !active.isDefault) ordered.push(byId.get(active.canvasId))
  for (const canvas of canvases) {
    if (!ordered.some((candidate) => candidate.canvasId === canvas.canvasId)) ordered.push(canvas)
  }

  return Object.freeze({
    canvases: Object.freeze(ordered.map((canvas) => Object.freeze(canvas))),
    potentiallyPartial: records.length === ATLAS_CANVAS_CATALOG_LIMIT,
  })
}

export function findAtlasCanvasSwitchTarget(canvases, workspaceId, activeCanvasId, targetCanvasId) {
  if (!Array.isArray(canvases) || typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) return null
  if (typeof targetCanvasId !== "string" || !CANONICAL_UUID.test(targetCanvasId)) return null
  if (targetCanvasId === activeCanvasId) return null
  return canvases.find((canvas) => (
    canvas?.canvasId === targetCanvasId && canvas?.workspaceId === workspaceId
  )) ?? null
}

export function atlasCanvasSwitchHasPendingWork(state) {
  return Boolean(state && Object.values(state).some((value) => value === true))
}
