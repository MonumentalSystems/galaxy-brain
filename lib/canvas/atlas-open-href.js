import { DOCUMENT_ANCHOR_PLACEMENT_STYLE } from "./document-anchor-placement.js"
import { parseGalaxyObjectReference } from "../galaxy-object-reference.js"
import { conversationGraphHref } from "../conversation-collection-client.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const GENERIC_OPEN_LABEL = "Open canonical view"
const DOCUMENT_OPEN_LABEL = "Open document"
const CONVERSATION_OPEN_LABEL = "Open conversation tree"

function exactConversationHref(data, hydration) {
  if (
    data?.availability !== "resolved"
    || hydration?.status !== "resolved"
    || typeof data.subjectRef !== "string"
    || hydration.requestedRef !== data.subjectRef
    || hydration.resolvedRef !== data.subjectRef
  ) return null
  const placed = parseGalaxyObjectReference(data.subjectRef)
  const resolved = parseGalaxyObjectReference(hydration.resolvedRef)
  if (
    placed?.format !== "canonical"
    || placed.kind !== "chat"
    || placed.selector.mode !== "pinned"
    || resolved?.format !== "canonical"
    || resolved.kind !== "chat"
    || resolved.selector.mode !== "pinned"
  ) {
    return null
  }
  try {
    const href = conversationGraphHref(hydration.resolvedRef)
    return hydration.handles?.some((handle) => handle?.href === href) === true ? href : null
  } catch {
    return null
  }
}

function exactElnExperimentHref(data, hydration) {
  const placed = parseGalaxyObjectReference(data?.subjectRef)
  if (placed?.format !== "canonical" || placed.kind !== "eln.experiment") return null
  if (data?.availability !== "resolved" || hydration?.status !== "resolved") return undefined

  const resolved = parseGalaxyObjectReference(hydration.resolvedRef)
  if (
    resolved?.format !== "canonical"
    || resolved.kind !== "eln.experiment"
    || resolved.id !== placed.id
  ) {
    return undefined
  }
  return `/eln/experiment/${encodeURIComponent(placed.id)}`
}

/** Preserve exact reader coordinates for anchor cards; use resolver handles elsewhere. */
export function openHrefForAtlasNode(data, hydration) {
  const exactAnchorRoute = data?.placementState?.style?.schemaId === DOCUMENT_ANCHOR_PLACEMENT_STYLE
    ? data?.display?.href
    : undefined
  if (exactAnchorRoute && data?.availability === "resolved") return exactAnchorRoute
  const exactElnRoute = exactElnExperimentHref(data, hydration)
  if (exactElnRoute !== null) return exactElnRoute
  if (hydration?.status === "resolved") return hydration.handles[0]?.href
  return data?.availability === "resolved" ? data?.display?.href : undefined
}

/**
 * Describe an Atlas open action without trusting presentation data to name a
 * document identity. The document label is available only when the resolver
 * supplied one exact document revision and its canonical reader handle.
 */
export function openActionForAtlasNode(data, hydration) {
  const href = openHrefForAtlasNode(data, hydration)
  if (!href) return undefined

  const exactConversationRoute = exactConversationHref(data, hydration)
  if (exactConversationRoute === href) {
    return Object.freeze({ href, label: CONVERSATION_OPEN_LABEL })
  }

  const resolved = hydration?.status === "resolved"
    ? parseGalaxyObjectReference(hydration.resolvedRef)
    : null
  const revisionId = hydration?.documentRevisionId
  const exactDocumentHref = typeof revisionId === "string" && UUID.test(revisionId)
    ? `/documents/${revisionId}`
    : null
  const validatedHandle = hydration?.handles?.some((handle) => handle?.href === href) === true
  const document = resolved?.format === "canonical"
    && resolved.kind === "document"
    && validatedHandle
    && exactDocumentHref === href

  return Object.freeze({
    href,
    label: document ? DOCUMENT_OPEN_LABEL : GENERIC_OPEN_LABEL,
  })
}
