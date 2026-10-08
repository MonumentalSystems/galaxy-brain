export const PAPER_READER_LOCATION_SCHEMA = "gb.paper-reader-location.v1"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ANCHOR_PATTERN = /^sha256:[0-9a-f]{64}$/

function boundedPage(value, fallback = 1) {
  const page = Number(value)
  return Number.isSafeInteger(page) && page >= 1 && page <= 1_000_000 ? page : fallback
}

export function rectangleToPageRegion(page, region) {
  const normalizedPage = boundedPage(page, 0)
  if (!normalizedPage) throw new Error("A page region requires a positive one-based page")
  const values = [region?.x, region?.y, region?.width, region?.height]
  if (!values.every((value) => Number.isFinite(value))) throw new Error("Page region coordinates must be finite")
  const [x, y, width, height] = values
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
    throw new Error("Page region coordinates must describe a non-empty normalized rectangle")
  }
  return {
    kind: "page-region",
    page: normalizedPage,
    coordinateSpace: "normalized-page",
    polygon: [x, y, x + width, y, x + width, y + height, x, y + height],
  }
}

export function pageCountForStructure(representation) {
  if (representation?.kind !== "document-structure") return 0
  const pages = representation.content?.pages
  return Array.isArray(pages) ? pages.length : 0
}

export function chooseReaderRepresentations(representations) {
  const source = Array.isArray(representations)
    ? representations.map((item, index) => ({ item, index })).sort((left, right) => {
        const leftTime = typeof left.item?.created_at === "string" ? Date.parse(left.item.created_at) : Number.NaN
        const rightTime = typeof right.item?.created_at === "string" ? Date.parse(right.item.created_at) : Number.NaN
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime
        if (Number.isFinite(rightTime) && !Number.isFinite(leftTime)) return 1
        if (Number.isFinite(leftTime) && !Number.isFinite(rightTime)) return -1
        return left.index - right.index
      }).map(({ item }) => item)
    : []
  const original = source.find((item) => item?.kind === "original" && item.media_type === "application/pdf") ?? null
  const structure = source.find((item) => item?.kind === "document-structure" && pageCountForStructure(item) > 0) ?? null
  const markdown = source.find((item) => item?.kind === "markdown" && typeof item.content === "string") ?? null
  const text = source.find((item) => item?.kind === "text" && typeof item.content === "string") ?? null
  return { original, structure, markdown, text }
}

function newestByCreatedAt(values) {
  return values.map((item, index) => ({ item, index })).sort((left, right) => {
    const leftTime = typeof left.item?.created_at === "string" ? Date.parse(left.item.created_at) : Number.NaN
    const rightTime = typeof right.item?.created_at === "string" ? Date.parse(right.item.created_at) : Number.NaN
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime
    return right.index - left.index
  })[0]?.item ?? null
}

export function chooseReaderRepresentationState(representations, receipts) {
  const sourceReceipts = Array.isArray(receipts) ? receipts.filter((receipt) => receipt && typeof receipt === "object") : []
  if (!sourceReceipts.length) {
    return { ...chooseReaderRepresentations(representations), receipt: null, primaryReceipt: null }
  }
  const fallbackIds = new Set(sourceReceipts.map((receipt) => receipt.fallback_receipt_id).filter(Boolean))
  const primaryReceipt = newestByCreatedAt(sourceReceipts.filter((receipt) => !fallbackIds.has(receipt.id)))
  const fallbackReceipt = primaryReceipt?.fallback_receipt_id
    ? sourceReceipts.find((receipt) => receipt.id === primaryReceipt.fallback_receipt_id) ?? null
    : null
  const receipt = primaryReceipt?.status === "success" || primaryReceipt?.status === "partial"
    ? primaryReceipt
    : fallbackReceipt ?? primaryReceipt
  const manifested = Array.isArray(receipt?.output_manifest?.representations)
    ? receipt.output_manifest.representations
    : []
  const manifestedHashes = new Map(manifested.flatMap((item) => (
    typeof item?.id === "string" && typeof item?.contentSha256 === "string"
      ? [[item.id, item.contentSha256]]
      : []
  )))
  const scoped = (Array.isArray(representations) ? representations : []).filter((representation) => (
    representation?.kind === "original"
    || manifestedHashes.get(representation?.id) === representation?.content_sha256
  ))
  return { ...chooseReaderRepresentations(scoped), receipt, primaryReceipt }
}

export function textQuoteAnchorForSelection(representations, exact, page) {
  if (typeof exact !== "string" || exact.length === 0 || [...exact].length > 20_000) {
    throw new Error("Selected text must contain between 1 and 20,000 characters")
  }
  const normalizedPage = boundedPage(page, 0)
  if (!normalizedPage) throw new Error("Selected text requires a positive one-based page")
  const source = Array.isArray(representations) ? representations : []
  const candidates = [
    ...source.filter((item) => item?.kind === "text" && typeof item.content === "string"),
    ...source.filter((item) => item?.kind === "markdown" && typeof item.content === "string"),
  ]
  for (const representation of candidates) {
    const first = representation.content.indexOf(exact)
    if (first < 0 || representation.content.indexOf(exact, first + 1) >= 0) continue
    // Flat text/Markdown page_count is descriptive metadata, not proof that its
    // character offsets correspond to the rendered PDF page. Keep this quote
    // global unless a future representation carries an explicit page mapping.
    return { representation, selector: { kind: "text-quote", exact } }
  }
  throw new Error("No exact flat text representation contains this quote unambiguously")
}

export function projectExactTextQuote(pages, selector) {
  if (!Array.isArray(pages) || !selector || selector.kind !== "text-quote"
    || typeof selector.exact !== "string" || !selector.exact) return null
  // Prefix/suffix context changes the match contract. This bounded slice only
  // projects selectors whose exact field is the complete matching authority.
  if (selector.prefix !== undefined || selector.suffix !== undefined) return null
  if (selector.page !== undefined && boundedPage(selector.page, 0) !== selector.page) return null
  let match = null
  for (const page of pages) {
    if (!page || boundedPage(page.pageNumber, 0) !== page.pageNumber || typeof page.textContent !== "string") return null
    let offset = page.textContent.indexOf(selector.exact)
    while (offset >= 0) {
      if (match) return null
      match = {
        pageNumber: page.pageNumber,
        quote: selector.exact,
        startOffset: offset,
        endOffset: offset + selector.exact.length,
      }
      offset = page.textContent.indexOf(selector.exact, offset + 1)
    }
  }
  if (!match || (selector.page !== undefined && selector.page !== match.pageNumber)) return null
  return match
}

export function projectExactPageRegion(selector) {
  if (!selector || selector.kind !== "page-region" || selector.coordinateSpace !== "normalized-page"
    || boundedPage(selector.page, 0) !== selector.page || !Array.isArray(selector.polygon)
    || selector.polygon.length !== 8 || !selector.polygon.every((value) => (
      typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ))) return null
  const [left, top, right, topAgain, rightAgain, bottom, leftAgain, bottomAgain] = selector.polygon
  if (!(left < right && top < bottom)
    || topAgain !== top || rightAgain !== right || leftAgain !== left || bottomAgain !== bottom) return null
  return { pageNumber: selector.page, x: left, y: top, width: right - left, height: bottom - top }
}

export function shouldAcceptPaperMarkCompletion(completion, current, options = {}) {
  return Boolean(completion && current
    && completion.generation === current.generation
    && completion.documentRevisionId === current.documentRevisionId
    && (options.requireSelection === false
      || completion.selectionGeneration === current.selectionGeneration))
}

export function shouldCommitPaperAnchorCompletion(expectedSelectionGeneration, currentSelectionGeneration) {
  if (expectedSelectionGeneration === undefined) return true
  return Number.isSafeInteger(expectedSelectionGeneration)
    && expectedSelectionGeneration >= 0
    && expectedSelectionGeneration === currentSelectionGeneration
}

export function parsePaperReaderLocation(search) {
  const params = new URLSearchParams(String(search || "").replace(/^\?/, ""))
  const requestedView = params.get("paperView")
  const view = requestedView === "markdown" || requestedView === "structure" ? requestedView : "pdf"
  const anchor = params.get("paperAnchor")
  return {
    schemaId: PAPER_READER_LOCATION_SCHEMA,
    view,
    page: boundedPage(params.get("paperPage"), 1),
    anchorId: anchor && ANCHOR_PATTERN.test(anchor) ? anchor : null,
  }
}

export function paperReaderSearch(search, state) {
  const params = new URLSearchParams(String(search || "").replace(/^\?/, ""))
  params.delete("documentAnchor")
  params.set("paperView", state.view === "markdown" || state.view === "structure" ? state.view : "pdf")
  params.set("paperPage", String(boundedPage(state.page, 1)))
  if (state.anchorId && ANCHOR_PATTERN.test(state.anchorId)) params.set("paperAnchor", state.anchorId)
  else params.delete("paperAnchor")
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ""
}

export function validateReaderDocumentIdentity(value) {
  if (!value || typeof value !== "object") throw new Error("Reader document identity is required")
  if (!UUID_PATTERN.test(value.documentRevisionId)) throw new Error("Document revision id must be a canonical UUID")
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 500) {
    throw new Error("Reader title must be between 1 and 500 characters")
  }
  return { documentRevisionId: value.documentRevisionId.toLowerCase(), title: value.title.trim() }
}
