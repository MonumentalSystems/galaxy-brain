/**
 * MarkItDown Service — client for the MarkItDown conversion microservice.
 *
 * Converts files (PDF, DOCX, PPTX, XLSX, HTML, images, audio, etc.)
 * to clean Markdown for LLM-friendly ingestion into HAM.
 */

const MARKITDOWN_API = "/api/markitdown"

/** File extensions that MarkItDown can convert */
const SUPPORTED_EXTENSIONS = new Set([
  ".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls",
  ".html", ".htm", ".csv", ".json", ".xml",
  ".epub", ".msg", ".eml",
  ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff", ".webp",
  ".mp3", ".wav", ".m4a", ".ogg", ".flac",
  ".zip",
])

/**
 * The extensions a file picker should offer for conversion, derived from the
 * set above so the two cannot drift: an accept list maintained by hand went
 * stale and silently filtered out every Office format the converter handles.
 */
export const CONVERTIBLE_ACCEPT = [...SUPPORTED_EXTENSIONS].join(",")

export function canConvert(filename: string): boolean {
  const ext = filename.lastIndexOf(".") >= 0
    ? filename.slice(filename.lastIndexOf(".")).toLowerCase()
    : ""
  return SUPPORTED_EXTENSIONS.has(ext)
}

export interface ConvertResult {
  filename: string
  markdown: string
  length: number
}

/**
 * Send a file to the MarkItDown service and get back Markdown.
 * Returns null if the service is unreachable (caller should fall back).
 */
export async function convertFile(file: File): Promise<ConvertResult | null> {
  const form = new FormData()
  form.append("file", file)

  try {
    const res = await fetch(`${MARKITDOWN_API}/convert`, {
      method: "POST",
      body: form,
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText)
      console.warn(`[markitdown] conversion failed (${res.status}):`, detail)
      return null
    }

    return (await res.json()) as ConvertResult
  } catch (err) {
    console.warn("[markitdown] service unreachable, falling back:", err)
    return null
  }
}

/** Quick health check — returns true if the service is up. */
export async function isAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${MARKITDOWN_API}/health`, {
      signal: AbortSignal.timeout(2000),
    })
    return res.ok
  } catch {
    return false
  }
}
