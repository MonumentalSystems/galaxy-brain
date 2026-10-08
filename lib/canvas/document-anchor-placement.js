import { normalizeCanvasSnapshot } from "./canvas-snapshot.js"
import { parseGalaxyObjectReference } from "../galaxy-object-reference.js"
import { projectDocumentAnchorObject } from "../object-projection-adapters.js"
import { isDocumentAnchorTextMediaType } from "../document-anchor-media.js"

export const DOCUMENT_ANCHOR_PLACEMENT_STYLE = "gb.canvas.document-anchor-placement.v1"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA_ID = /^sha256:[0-9a-f]{64}$/u

function invalid(message) {
  throw new TypeError(`Invalid document anchor canvas placement: ${message}`)
}

function exactAnchorReference(value) {
  const parsed = parseGalaxyObjectReference(value)
  if (
    !parsed ||
    parsed.format !== "canonical" ||
    parsed.kind !== "document.anchor" ||
    parsed.selector.mode !== "pinned" ||
    !SHA_ID.test(parsed.id) ||
    !SHA_ID.test(parsed.selector.revision)
  ) return null
  return parsed
}

function routingMetadata(item) {
  const style = item?.style
  if (
    !style ||
    typeof style !== "object" ||
    Array.isArray(style) ||
    style.schemaId !== DOCUMENT_ANCHOR_PLACEMENT_STYLE ||
    typeof style.documentRevisionId !== "string" ||
    !UUID.test(style.documentRevisionId) ||
    typeof style.anchorId !== "string" ||
    !SHA_ID.test(style.anchorId)
  ) return null
  return {
    documentRevisionId: style.documentRevisionId.toLowerCase(),
    anchorId: style.anchorId,
    sourcePage: Number.isSafeInteger(style.sourcePage) && style.sourcePage >= 1
      ? style.sourcePage
      : undefined,
  }
}

function normalizedAnchor(anchor, subjectRef, route) {
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) invalid("anchor must be an object")
  const parsed = exactAnchorReference(subjectRef)
  if (!parsed) invalid("subjectRef must be a pinned document.anchor reference")
  if (anchor.ref !== subjectRef || anchor.id !== parsed.id || anchor.id !== route.anchorId) {
    invalid("the fetched anchor does not match the durable subject reference")
  }
  if (
    typeof anchor.document_revision_id !== "string" ||
    anchor.document_revision_id.toLowerCase() !== route.documentRevisionId
  ) invalid("the fetched anchor belongs to a different document revision")
  if (
    typeof anchor.representation_sha256 !== "string" ||
    parsed.selector.revision !== `sha256:${anchor.representation_sha256.toLowerCase()}`
  ) invalid("the fetched anchor representation does not match the pinned revision")
  return anchor
}

export function documentAnchorReaderHref(anchor, sourcePage) {
  const revisionId = typeof anchor?.document_revision_id === "string"
    ? anchor.document_revision_id.toLowerCase()
    : ""
  if (!UUID.test(revisionId) || !SHA_ID.test(anchor?.id)) invalid("anchor routing identity is invalid")
  if (
    anchor.selector?.kind === "text-quote"
    && anchor.representation_kind === "original"
    && isDocumentAnchorTextMediaType(anchor.representation_media_type)
  ) {
    return `/documents/${encodeURIComponent(revisionId)}?${new URLSearchParams({
      documentAnchor: anchor.id,
    }).toString()}`
  }
  const page = Number.isSafeInteger(anchor.selector?.page) && anchor.selector.page >= 1
    ? anchor.selector.page
    : Number.isSafeInteger(sourcePage) && sourcePage >= 1
      ? sourcePage
      : 1
  const search = new URLSearchParams({
    paperView: "pdf",
    paperPage: String(page),
    paperAnchor: anchor.id,
  })
  return `/documents/${encodeURIComponent(revisionId)}?${search.toString()}`
}

export function createDocumentAnchorCanvasItem(anchor, operationId, geometry = {}, sourcePage) {
  if (typeof operationId !== "string" || !UUID.test(operationId)) invalid("operationId must be a UUID")
  const subjectRef = anchor?.ref
  const parsed = exactAnchorReference(subjectRef)
  const documentRevisionId = typeof anchor?.document_revision_id === "string"
    ? anchor.document_revision_id.toLowerCase()
    : ""
  if (!parsed || parsed.id !== anchor?.id) invalid("anchor ref must identify the exact anchor")
  if (!UUID.test(documentRevisionId)) invalid("document revision id must be a UUID")
  if (
    typeof anchor?.representation_sha256 !== "string" ||
    parsed.selector.revision !== `sha256:${anchor.representation_sha256.toLowerCase()}`
  ) invalid("anchor ref must pin the exact representation")

  const item = {
    id: `anchor-${operationId.toLowerCase()}`,
    subjectRef,
    nodeType: "galaxy.document",
    x: geometry.x ?? 80,
    y: geometry.y ?? 80,
    width: geometry.width ?? 420,
    height: geometry.height ?? 260,
    angle: 0,
    zIndex: geometry.zIndex ?? 0,
    displayMode: "card",
    collapsed: false,
    style: {
      schemaId: DOCUMENT_ANCHOR_PLACEMENT_STYLE,
      documentRevisionId,
      anchorId: anchor.id,
      ...(Number.isSafeInteger(sourcePage) && sourcePage >= 1 ? { sourcePage } : {}),
    },
  }
  return normalizeCanvasSnapshot({
    schemaId: "gb.canvas.snapshot.v1",
    items: [item],
    edges: [],
    removedItemIds: [],
    removedEdgeIds: [],
  }).items[0]
}

export function collectDocumentAnchorPlacementRequests(snapshot) {
  const content = normalizeCanvasSnapshot(snapshot)
  const grouped = new Map()
  for (const item of content.items) {
    if (item.nodeType !== "galaxy.document") continue
    const reference = exactAnchorReference(item.subjectRef)
    const route = routingMetadata(item)
    if (!reference || !route || route.anchorId !== reference.id) continue
    const key = `${route.documentRevisionId}\u0000${route.anchorId}\u0000${item.subjectRef}`
    const existing = grouped.get(key)
    if (existing) existing.items.push(item)
    else grouped.set(key, { ...route, subjectRef: item.subjectRef, items: [item] })
  }
  return [...grouped.values()]
}

function pageRegionSummary(selector) {
  if (selector?.kind !== "page-region") return undefined
  return `Pinned normalized region on page ${selector.page}. Open the source to inspect the exact marked area.`
}

function placementFromAnchor(item, anchor) {
  const route = routingMetadata(item)
  if (!route) invalid("placement routing metadata is invalid")
  const source = normalizedAnchor(anchor, item.subjectRef, route)
  const projection = projectDocumentAnchorObject(source)
  return {
    id: item.id,
    authorized: true,
    subjectRef: item.subjectRef,
    nodeType: item.nodeType,
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    angle: item.angle,
    zIndex: item.zIndex,
    displayMode: item.displayMode,
    collapsed: item.collapsed,
    style: item.style,
    display: {
      title: projection.title,
      subtitle: "Exact document coordinate",
      summary: projection.summary || pageRegionSummary(source.selector),
      revision: projection.revision.id,
      status: "pinned",
      provenance: projection.provenance.statement,
      href: documentAnchorReaderHref(source, route.sourcePage),
      mediaType: projection.mediaType,
      badges: ["document anchor", source.selector_kind || source.selector?.kind || "coordinate", "pinned"],
    },
  }
}

/**
 * Hydrate only anchor references already present in the durable snapshot.
 * Fetch failures and mismatched responses are deliberately omitted.
 */
export async function hydrateDocumentAnchorCanvasPlacements(snapshot, fetchAnchor, options = {}) {
  if (typeof fetchAnchor !== "function") invalid("fetchAnchor must be a function")
  const requests = collectDocumentAnchorPlacementRequests(snapshot)
  const batchSize = Number.isSafeInteger(options.batchSize) && options.batchSize > 0
    ? Math.min(options.batchSize, 16)
    : 8
  const placements = []
  for (let start = 0; start < requests.length; start += batchSize) {
    const batch = requests.slice(start, start + batchSize)
    const results = await Promise.allSettled(batch.map((request) => fetchAnchor({
      documentRevisionId: request.documentRevisionId,
      anchorId: request.anchorId,
      subjectRef: request.subjectRef,
    })))
    results.forEach((result, index) => {
      if (result.status !== "fulfilled") return
      const request = batch[index]
      try {
        for (const item of request.items) placements.push(placementFromAnchor(item, result.value))
      } catch {
        // Authorization and identity failures are fail-closed per durable item.
      }
    })
  }
  return placements.sort((left, right) => left.id.localeCompare(right.id))
}
