import { createGalaxyObjectProjection } from "./object-projection.js"
import { builtinPluginRegistry } from "./plugins/builtins.js"

export const SEMANTIC_ZOOM_LEVELS = Object.freeze([
  Object.freeze({ id: "far", minimumZoom: 0, representation: "glyph" }),
  Object.freeze({ id: "medium", minimumZoom: 0.7, representation: "label" }),
  Object.freeze({ id: "near", minimumZoom: 1.3, representation: "card" }),
  Object.freeze({ id: "detail", minimumZoom: 2.45, representation: "detail" }),
])

/**
 * A zoom that comfortably sits inside a level, for callers choosing where to
 * point a camera. Opening zoom used to be its own constant, and it drifted
 * below the card threshold: the atlas opened at 0.82 while a card body needs
 * 1.3, so every placement opened as a bare label with an empty body.
 */
export function zoomForLevel(levelId) {
  const index = SEMANTIC_ZOOM_LEVELS.findIndex((level) => level.id === levelId)
  if (index < 0) throw new TypeError("Unknown semantic zoom level")
  const level = SEMANTIC_ZOOM_LEVELS[index]
  const next = SEMANTIC_ZOOM_LEVELS[index + 1]
  // Far enough past the threshold that rounding cannot drop back a level.
  if (!next) return Number((level.minimumZoom * 1.1).toFixed(2))
  return Number(((level.minimumZoom + next.minimumZoom) / 2).toFixed(2))
}

export const PROJECTOR_MOTION_POLICY = Object.freeze({
  placeholderAboveLevel: "medium",
  settleDelayMs: 120,
  placeholderRepresentation: "placeholder",
})

function definition(id, label, kinds, mediaFamilies = [], registration = null, manifest = null) {
  const plugin = registration && manifest
    ? Object.freeze({
        id: manifest.id,
        displayName: manifest.displayName,
        version: manifest.version,
      })
    : null
  return Object.freeze({
    id,
    label,
    kinds: Object.freeze(kinds),
    mediaFamilies: Object.freeze(mediaFamilies),
    levels: SEMANTIC_ZOOM_LEVELS,
    motion: PROJECTOR_MOTION_POLICY,
    tokenScope: "living-field",
    pluginId: registration?.pluginId ?? null,
    plugin,
    implementationId: registration?.handler.implementationId ?? null,
    diagnostic: plugin ? null : "projector_unavailable",
  })
}

const OBJECT_PROJECTOR_IMPLEMENTATIONS = Object.freeze({
  "builtin.object-projector.paper": Object.freeze({ id: "paper", label: "Paper", kinds: ["paper"], mediaFamilies: [] }),
  "builtin.object-projector.image": Object.freeze({
    id: "image",
    label: "Image",
    kinds: ["document"],
    mediaFamilies: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  }),
  "builtin.object-projector.audio": Object.freeze({
    id: "audio",
    label: "Audio",
    kinds: ["document"],
    mediaFamilies: ["audio/webm"],
  }),
  "builtin.object-projector.document": Object.freeze({ id: "document", label: "Document", kinds: ["document"], mediaFamilies: [] }),
  "builtin.object-projector.document-anchor": Object.freeze({ id: "document-anchor", label: "Document anchor", kinds: ["document.anchor"], mediaFamilies: [] }),
  "builtin.object-projector.markdown": Object.freeze({ id: "markdown", label: "Markdown", kinds: ["artifact", "code.file"], mediaFamilies: ["text/markdown", "text/plain"] }),
  "builtin.object-projector.code": Object.freeze({ id: "code", label: "Code graph", kinds: ["code.graph", "code.repo", "code.commit", "code.file", "code.symbol"], mediaFamilies: [] }),
  "builtin.object-projector.media": Object.freeze({ id: "media", label: "Media", kinds: ["artifact"], mediaFamilies: ["image/", "audio/", "video/"] }),
  "builtin.object-projector.eln": Object.freeze({ id: "eln", label: "ELN record", kinds: ["eln.experiment", "eln.observation", "eln.hypothesis"], mediaFamilies: [] }),
  "builtin.object-projector.conversation": Object.freeze({ id: "conversation", label: "Conversation", kinds: ["chat"], mediaFamilies: [] }),
  "builtin.object-projector.task": Object.freeze({ id: "task", label: "Task", kinds: ["ham.task", "task-plan", "task-plan.job", "run", "turn"], mediaFamilies: [] }),
  "builtin.object-projector.proof": Object.freeze({ id: "proof", label: "Proof", kinds: ["proof.graph", "proof.node"], mediaFamilies: [] }),
  "builtin.object-projector.ham-memory": Object.freeze({ id: "ham-memory", label: "HAM memory", kinds: ["ham.memory"], mediaFamilies: [] }),
  "builtin.object-projector.surface": Object.freeze({ id: "surface", label: "Surface", kinds: ["surface"], mediaFamilies: [] }),
})

const UNKNOWN_OBJECT_PROJECTOR = definition("unknown", "Reference", [])
const PROJECTORS_BY_REGISTRY = new WeakMap()

function registeredObjectProjectors(registry) {
  const cached = PROJECTORS_BY_REGISTRY.get(registry)
  if (cached) return cached
  const projectors = Object.freeze(registry.listContributions("projectors").flatMap((registration) => {
    const implementation = OBJECT_PROJECTOR_IMPLEMENTATIONS[registration.handler.implementationId]
    if (!implementation || implementation.id !== registration.id) return []
    const registeredPlugin = registry.getPlugin(registration.pluginId)
    if (
      !registeredPlugin
      || registeredPlugin.manifest.id !== registration.pluginId
      || !registeredPlugin.manifest.contributes.projectors.includes(registration.id)
    ) return []
    return [definition(
      implementation.id,
      implementation.label,
      implementation.kinds,
      implementation.mediaFamilies,
      registration,
      registeredPlugin.manifest,
    )]
  }))
  PROJECTORS_BY_REGISTRY.set(registry, projectors)
  return projectors
}

/** Compatibility snapshot derived from the static built-in plugin registry. */
export const BUILTIN_OBJECT_PROJECTORS = Object.freeze([
  ...registeredObjectProjectors(builtinPluginRegistry),
  UNKNOWN_OBJECT_PROJECTOR,
])

function mediaMatches(mediaType, family) {
  if (!mediaType) return false
  return family.endsWith("/") ? mediaType.startsWith(family) : mediaType === family
}

export function semanticZoomLevelFor(zoom) {
  const normalized = Number.isFinite(zoom) && zoom >= 0 ? zoom : 0
  for (let index = SEMANTIC_ZOOM_LEVELS.length - 1; index >= 0; index -= 1) {
    if (normalized >= SEMANTIC_ZOOM_LEVELS[index].minimumZoom) return SEMANTIC_ZOOM_LEVELS[index]
  }
  return SEMANTIC_ZOOM_LEVELS[0]
}

export function getObjectProjector(projection, registry = builtinPluginRegistry) {
  const value = createGalaxyObjectProjection(projection)
  let genericKindProjector = null
  for (const projector of registeredObjectProjectors(registry)) {
    if (!projector.kinds.includes(value.kind)) continue
    if (projector.mediaFamilies.length === 0) {
      genericKindProjector ??= projector
      continue
    }
    if (projector.mediaFamilies.some((family) => mediaMatches(value.mediaType, family))) return projector
  }
  return genericKindProjector ?? UNKNOWN_OBJECT_PROJECTOR
}

export function selectObjectRepresentation(projection, zoom, moving = false, registry = builtinPluginRegistry) {
  const value = createGalaxyObjectProjection(projection)
  const projector = getObjectProjector(value, registry)
  const level = semanticZoomLevelFor(zoom)
  /*
    Motion no longer replaces a rendered card with a placeholder: dragging made
    the content disappear and return, which reads as the card flickering rather
    than as a deliberate simplification. What motion was really protecting is
    the exact-representation fetch, and hosts gate that on `moving` directly, so
    the saving survives while the card stays legible under the cursor.
  */
  const placeholder = false
  return Object.freeze({
    projection: value,
    projector,
    level,
    representation: placeholder ? PROJECTOR_MOTION_POLICY.placeholderRepresentation : level.representation,
    placeholder,
  })
}

/** All host contexts select from the same projection rather than copying it. */
export function projectionForContext(projection, context, zoom, moving = false, registry = builtinPluginRegistry) {
  if (!["list", "graph", "canvas", "detail"].includes(context)) {
    throw new TypeError("Unsupported object projection context")
  }
  return Object.freeze({ context, ...selectObjectRepresentation(projection, zoom, moving, registry) })
}
