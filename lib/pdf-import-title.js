import { loadPdfJs } from "./pdfjs-browser.js"
import { MAX_IMPORT_FILE_BYTES } from "./durable-document-import.js"

const MAX_TITLE_CHARACTERS = 500
const GENERIC_TITLE = /^(?:untitled|document|pdf|paper|article|manuscript)(?:\s+\d+)?$/iu
const IDENTIFIER_ONLY = /^(?:arxiv[:_ -]*)?[a-z]?(?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7})(?:v\d+)?$/iu
const UUID_OR_DIGEST = /^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{24,}|[a-z0-9_-]{28,})$/iu
const NON_TITLE_LINE = /^(?:arxiv\b|doi\b|https?:\/\/|www\.|abstract\b|preprint\b|submitted\b|published\b|proceedings\b|journal\b|volume\b|copyright\b)/iu

function normalizedText(value) {
  if (typeof value !== "string") return ""
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
}

function filenameStem(filename) {
  return normalizedText(filename).replace(/\.[^.]+$/u, "")
}

export function usablePdfTitle(value, filename = "") {
  let title = normalizedText(value)
    .replace(/^(?:microsoft\s+word|libreoffice\s+writer)\s*[-:]\s*/iu, "")
    .replace(/\.pdf$/iu, "")
    .trim()
  if (
    title.length < 8
    || Array.from(title).length > MAX_TITLE_CHARACTERS
    || GENERIC_TITLE.test(title)
    || IDENTIFIER_ONLY.test(title)
    || UUID_OR_DIGEST.test(title)
  ) return null
  const stem = filenameStem(filename)
  if (stem && title.localeCompare(stem, undefined, { sensitivity: "base" }) === 0) return null
  return title
}

function metadataTitle(metadata) {
  const infoTitle = metadata?.info?.Title
  if (typeof infoTitle === "string") return infoTitle
  const xmpTitle = metadata?.metadata?.get?.("dc:title")
  if (typeof xmpTitle === "string") return xmpTitle
  return null
}

function itemFontSize(item) {
  const transform = Array.isArray(item?.transform) ? item.transform : []
  const vertical = Math.hypot(Number(transform[2]) || 0, Number(transform[3]) || 0)
  const horizontal = Math.hypot(Number(transform[0]) || 0, Number(transform[1]) || 0)
  return Math.max(vertical, horizontal)
}

function visualLines(items) {
  const lines = []
  for (const item of items || []) {
    const text = normalizedText(item?.str)
    const transform = Array.isArray(item?.transform) ? item.transform : []
    const x = Number(transform[4])
    const y = Number(transform[5])
    const size = itemFontSize(item)
    if (!text || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(size) || size <= 0) continue
    let line = lines.find((candidate) => Math.abs(candidate.y - y) <= Math.max(2, size * 0.22))
    if (!line) {
      line = { y, size, items: [] }
      lines.push(line)
    }
    line.size = Math.max(line.size, size)
    line.items.push({ x, text })
  }
  return lines.map((line) => ({
    y: line.y,
    size: line.size,
    text: line.items.sort((left, right) => left.x - right.x).map((item) => item.text).join(" "),
  }))
}

export function titleFromFirstPageText(items, pageHeight, filename = "") {
  const height = Number(pageHeight)
  if (!Number.isFinite(height) || height <= 0) return null
  const candidates = visualLines(items)
    .filter((line) => line.y >= height * 0.42)
    .map((line) => ({ ...line, title: usablePdfTitle(line.text, filename) }))
    .filter((line) => line.title && !NON_TITLE_LINE.test(line.title))
    .sort((left, right) => right.size - left.size || right.y - left.y)
  if (!candidates.length) return null

  const anchor = candidates[0]
  const matchingSize = candidates
    .filter((line) => line.size >= anchor.size * 0.9)
    .sort((left, right) => right.y - left.y)
  const anchorIndex = matchingSize.indexOf(anchor)
  let start = anchorIndex
  let end = anchorIndex
  const maximumGap = anchor.size * 2.4
  while (start > 0 && matchingSize[start - 1].y - matchingSize[start].y <= maximumGap) start -= 1
  while (end + 1 < matchingSize.length && matchingSize[end].y - matchingSize[end + 1].y <= maximumGap) end += 1
  return usablePdfTitle(
    matchingSize.slice(start, end + 1).map((line) => line.title).join(" "),
    filename,
  )
}

export async function inferPdfImportTitle(file, { pdfjsLoader = loadPdfJs } = {}) {
  if (
    !file
    || typeof file.arrayBuffer !== "function"
    || !/\.pdf$/iu.test(file.name || "")
    || !Number.isSafeInteger(file.size)
    || file.size < 1
    || file.size > MAX_IMPORT_FILE_BYTES
  ) return null
  const pdfjs = await pdfjsLoader()
  const bytes = await file.arrayBuffer()
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== file.size) return null
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise
  try {
    const metadata = await document.getMetadata().catch(() => null)
    const embedded = usablePdfTitle(metadataTitle(metadata), file.name)
    if (embedded) return { title: embedded, source: "metadata" }

    const page = await document.getPage(1)
    const [textContent, viewport] = await Promise.all([
      page.getTextContent(),
      Promise.resolve(page.getViewport({ scale: 1 })),
    ])
    const title = titleFromFirstPageText(textContent.items, viewport.height, file.name)
    return title ? { title, source: "first-page" } : null
  } finally {
    await document.destroy?.()
  }
}
