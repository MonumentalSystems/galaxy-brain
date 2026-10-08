import { parseGalaxyObjectReference } from "../galaxy-object-reference.js"
import { createGalaxyObjectProjection } from "../object-projection.js"

const NODE_PROVIDERS = Object.freeze({
  "galaxy.paper": "galaxy.paper",
  "galaxy.note": "galaxy.workspace",
  "galaxy.document": "galaxy.workspace",
  "galaxy.media": "galaxy.workspace",
  "galaxy.eln-record": "galaxy.eln",
  "galaxy.task": "ham",
  "galaxy.chat": "galaxy.conversation",
  "galaxy.proof": "galaxy.proof",
  "galaxy.surface": "galaxy.surface",
})

function providerFor(nodeType, objectKind) {
  if (objectKind === "document.anchor") return "galaxy.document"
  return NODE_PROVIDERS[nodeType] || "galaxy.reference"
}

function mediaTypeFor(nodeType, display) {
  if (nodeType === "galaxy.surface") return "application/vnd.galaxy.surface+json"
  if (display.markdown) return "text/markdown"
  if (typeof display.mediaType === "string" && display.mediaType.includes("/")) return display.mediaType
  if (nodeType === "galaxy.media") return "application/octet-stream"
  return "application/vnd.galaxy.object+json"
}

function representationFor(nodeType, data, mediaType) {
  const suffix = encodeURIComponent(data.placementId)
  if (data.display.markdown) {
    return {
      ref: `gb:representation:canvas:${suffix}:markdown`,
      kind: "markdown",
      mediaType: "text/markdown",
      contentHash: null,
      label: "Authorized Markdown preview",
    }
  }
  if (nodeType === "galaxy.surface" && data.display.surfaceSpec) {
    return {
      ref: `gb:representation:canvas:${suffix}:surface`,
      kind: "surface",
      mediaType,
      contentHash: null,
      label: "Authorized bounded surface",
    }
  }
  if (nodeType === "galaxy.media") {
    const family = mediaType.split("/", 1)[0]
    return {
      ref: `gb:representation:canvas:${suffix}:media`,
      kind: ["image", "audio", "video"].includes(family) ? family : "original",
      mediaType,
      contentHash: null,
      label: "Authorized media preview",
    }
  }
  return null
}

function displayText(value, maximum, fallback) {
  const normalized = typeof value === "string"
    ? value.replace(/[\u0000-\u0020\u007f-\u009f]+/gu, " ").trim()
    : ""
  if (!normalized) return fallback
  const characters = Array.from(normalized)
  return characters.length <= maximum ? normalized : characters.slice(0, maximum - 1).join("") + "…"
}

/**
 * Adapt the already-authorized canvas display envelope to the common projector
 * seam. This is a transient view adapter: it neither resolves nor copies the
 * canonical object and it is never persisted in the placement ledger.
 */
export function projectCanvasNodeObject(nodeType, data) {
  const parsed = parseGalaxyObjectReference(data?.subjectRef)
  if (!parsed || parsed.format !== "canonical") {
    throw new TypeError("Canvas projection requires a canonical subject reference")
  }
  const mediaType = mediaTypeFor(nodeType, data.display)
  const representation = representationFor(nodeType, data, mediaType)
  return createGalaxyObjectProjection({
    schemaId: "gb.object-projection.v1",
    ref: data.subjectRef,
    kind: parsed.kind,
    revision: {
      policy: parsed.selector.mode,
      id: parsed.selector.mode === "pinned" ? parsed.selector.revision : null,
      contentHash: null,
    },
    title: displayText(data.display.title, 240, "Untitled canvas object"),
    summary: displayText(data.display.summary, 4000, undefined),
    mediaType,
    representations: representation ? [representation] : [],
    provenance: {
      provider: providerFor(nodeType, parsed.kind),
      sourceId: parsed.id,
      sourceRevision: parsed.selector.mode === "pinned" ? parsed.selector.revision : undefined,
      statement: displayText(data.display.provenance, 500, "Authorized Galaxy canvas projection."),
    },
    capabilities: data.display.href
      ? ["open", "place", "cite", "inspect", "relate"]
      : ["place", "cite", "inspect", "relate"],
  })
}

export function resolvedCanvasNodeRepresentation(nodeType, data) {
  const projection = projectCanvasNodeObject(nodeType, data)
  const representation = projection.representations[0]
  if (!representation || !data.display.markdown) return undefined
  return {
    ref: representation.ref,
    mediaType: representation.mediaType,
    contentHash: representation.contentHash,
    content: data.display.markdown,
  }
}
