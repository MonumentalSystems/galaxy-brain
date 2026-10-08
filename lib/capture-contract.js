/**
 * Validates a capture from an external client — a browser clipper, a script —
 * and shapes it into either a durable Galaxy document or the optional HAM
 * mirror payload.
 *
 * A capture is deliberately the least committal durable document Galaxy Brain
 * can store. Deciding it is a paper, experiment, or claim remains a later human
 * act; ingestion preserves the submitted bytes and provenance without inferring
 * semantic relations.
 */

const MAX_TITLE = 400
const MAX_CONTENT = 2_000_000
const MAX_URL = 2_048
const MAX_TAGS = 32
const MAX_TAG = 64
const MAX_SELECTION = 100_000
const MAX_ANCHOR = 2_000
const CAPTURE_FORMATS = Object.freeze({
  html: Object.freeze({ mediaType: "text/html", extension: "html" }),
  markdown: Object.freeze({ mediaType: "text/markdown", extension: "md" }),
  text: Object.freeze({ mediaType: "text/plain", extension: "txt" }),
})
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,160}$/u
const DISALLOWED_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u

export class CaptureValidationError extends Error {}

function invalid(message) {
  throw new CaptureValidationError(message)
}

function boundedText(value, label, maximum, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) invalid(`${label} is required`)
    return ""
  }
  if (typeof value !== "string") invalid(`${label} must be text`)
  const text = value.trim()
  if (required && !text) invalid(`${label} is required`)
  if (text.length > maximum) invalid(`${label} must be ${maximum} characters or fewer`)
  return text
}

function boundedExactText(value, label, maximum) {
  if (value === undefined || value === null) return ""
  if (typeof value !== "string") invalid(`${label} must be text`)
  if (value.length > maximum) invalid(`${label} must be ${maximum} characters or fewer`)
  if (DISALLOWED_TEXT_CONTROL.test(value)) invalid(`${label} contains unsupported control characters`)
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) invalid(`${label} must contain valid Unicode scalar text`)
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      invalid(`${label} must contain valid Unicode scalar text`)
    }
  }
  return value
}

function captureFormat(value) {
  const format = value === undefined || value === null || value === "" ? "text" : value
  if (typeof format !== "string" || !Object.hasOwn(CAPTURE_FORMATS, format)) {
    invalid("format must be html, markdown, or text")
  }
  return format
}

function captureTimestamp(value) {
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string" || value.length > 64) invalid("capturedAt must be an ISO timestamp")
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) invalid("capturedAt must be an ISO timestamp")
  return timestamp.toISOString()
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

/**
 * Only http(s) is accepted. A clipper runs on whatever page the person is
 * looking at, so file:, javascript: and data: URLs can all reach this.
 */
function captureUrl(value) {
  const raw = boundedText(value, "url", MAX_URL, { required: true })
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    invalid("url must be a valid absolute URL")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    invalid("url must be http or https")
  }
  return parsed.toString()
}

function captureTags(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) invalid("tags must be an array")
  if (value.length > MAX_TAGS) invalid(`tags must contain ${MAX_TAGS} entries or fewer`)
  const tags = []
  for (const entry of value) {
    const tag = boundedText(entry, "tag", MAX_TAG)
    if (tag && !tags.includes(tag)) tags.push(tag)
  }
  return tags
}

/**
 * Where on the page a capture came from.
 *
 * A clipped region is only useful later if it can say what it was part of, so
 * an anchor records the element's own selector and XPath alongside the
 * surrounding document. Nothing here is trusted as markup: selectors are stored
 * as opaque strings for provenance and are never used to query anything server
 * side.
 */
function captureRegion(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== "object" || Array.isArray(value)) invalid("region must be an object")

  const cssSelector = boundedText(value.cssSelector, "region.cssSelector", MAX_ANCHOR)
  const xpath = boundedText(value.xpath, "region.xpath", MAX_ANCHOR)
  const tagName = boundedText(value.tagName, "region.tagName", 64).toLowerCase()
  if (!cssSelector && !xpath) invalid("region needs a cssSelector or an xpath")

  return {
    cssSelector,
    xpath,
    tagName,
    label: boundedText(value.label, "region.label", MAX_TITLE),
  }
}

/**
 * @returns a normalised capture, or throws CaptureValidationError
 */
export function parseCaptureRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    invalid("Capture body must be a JSON object")
  }

  const url = captureUrl(input.url)
  const content = boundedExactText(input.content, "content", MAX_CONTENT)
  const selection = boundedExactText(input.selection, "selection", MAX_SELECTION)
  if (!content.trim() && !selection.trim()) {
    invalid("A capture needs content or a selection")
  }

  // Falling back to the host keeps an untitled capture identifiable in a list.
  const title = boundedText(input.title, "title", MAX_TITLE) || new URL(url).hostname

  return {
    url,
    title,
    format: captureFormat(input.format),
    content,
    selection,
    tags: captureTags(input.tags),
    note: boundedText(input.note, "note", MAX_SELECTION),
    region: captureRegion(input.region),
    source: boundedText(input.source, "source", 64) || "capture",
    capturedAt: captureTimestamp(input.capturedAt),
  }
}

export function parseCaptureIdempotencyKey(value) {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) {
    invalid("Idempotency-Key must contain 8-160 letters, numbers, dots, underscores, colons, or hyphens")
  }
  return value
}

function captureFilenameStem(value) {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/gu, "")
    .slice(0, 180)
    .replace(/[. ]+$/gu, "") || "web capture"
}

/**
 * The document body is the exact caller-supplied page content. Selection-only
 * captures remain useful without fabricating a surrounding page. Notes, tags,
 * and DOM selectors stay provenance for the optional mirror until canonical
 * anchor support is added in a later slice.
 */
export function captureToDocumentSource(capture) {
  const descriptor = CAPTURE_FORMATS[capture?.format]
  if (!descriptor) invalid("Capture format is invalid")
  const body = capture.content?.trim() ? capture.content : capture.selection
  if (typeof body !== "string" || !body.trim()) invalid("Capture document body is empty")
  return Object.freeze({
    bytes: new TextEncoder().encode(body),
    mediaType: descriptor.mediaType,
    filename: `${captureFilenameStem(capture.title)}.${descriptor.extension}`,
  })
}

export async function captureIntentSha256(capture) {
  if (!capture || typeof capture !== "object" || Array.isArray(capture)) invalid("Capture intent is invalid")
  const intent = {
    url: capture.url,
    title: capture.title,
    format: capture.format,
    content: capture.content,
    selection: capture.selection,
    tags: capture.tags,
    note: capture.note,
    region: capture.region,
    source: capture.source,
    capturedAt: capture.capturedAt,
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(intent)))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * Shapes a parsed capture into the HAM /ingest payload. A selection is kept
 * distinct from the page body so a later reader can tell what the person chose
 * from what merely surrounded it.
 */
export function captureToIngestPayload(capture) {
  const parts = []
  if (capture.note) parts.push(`## Note\n\n${capture.note}`)
  if (capture.selection) parts.push(`## Selected\n\n${capture.selection}`)
  if (capture.content) parts.push(`## Page\n\n${capture.content}`)

  // A peeled region records what it was part of, so the card can be traced back
  // to the exact element rather than only to the page it happened to be on.
  const provenance = [`Source: ${capture.url}`]
  if (capture.region) {
    const where = capture.region.label || capture.region.cssSelector || capture.region.xpath
    provenance.push(`Region: ${where}`)
  }

  return {
    content: `${parts.join("\n\n")}\n\n---\n\n${provenance.join("\n")}`,
    title: capture.title,
    type: "link",
    cues: capture.tags.length ? capture.tags : undefined,
    metadata: {
      title: capture.title,
      url: capture.url,
      source: capture.source,
      ...(capture.capturedAt ? { capturedAt: capture.capturedAt } : {}),
      hasSelection: Boolean(capture.selection),
      ...(capture.region ? { region: capture.region } : {}),
    },
  }
}
