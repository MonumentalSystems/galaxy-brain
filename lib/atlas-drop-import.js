import { screenToWorld } from "@canvas-harness/core"

import {
  durableUploadMediaType,
  IngestionContractError,
  MAX_IMPORT_FILE_BYTES,
} from "./durable-document-import.js"
import { MAX_RASTER_IMAGE_BYTES, rasterImageTypeForFilename } from "./raster-image-contract.js"
import { MAX_AUDIO_ORIGINAL_BYTES } from "./audio-original-contract.js"
import { DOCX_MEDIA_TYPE, MAX_DOCX_BYTES } from "./docx-document-contract.js"
import { normalizeReferencePlacementPoint } from "./canvas/reference-placement.js"
import { builtinPluginRegistry } from "./plugins/builtins.js"
import { resolveIngestionPlanDefinition } from "./plugins/ingestion-plans.js"

export const ATLAS_DROP_IMPORT_SOURCE_ID = "document.upload"
export const ATLAS_DROP_IMPORT_IMPLEMENTATION_ID = "builtin.document.upload-source"
export const ATLAS_DROP_INGESTION_PLAN_ID = "document.upload-default"

const FILENAME_CONTROL = /[\x00-\x1f\x7f]/u
const LONE_SURROGATE = /[\ud800-\udfff]/u

const TEXT = Object.freeze({
  canonical: "text/plain",
  accepted: Object.freeze(["text/plain"]),
})
const MARKDOWN = Object.freeze({
  canonical: "text/markdown",
  accepted: Object.freeze(["text/markdown", "text/plain"]),
})
const JAVASCRIPT = Object.freeze({
  canonical: "text/javascript",
  accepted: Object.freeze(["text/javascript", "application/javascript", "text/plain"]),
})
const JSON_MEDIA = Object.freeze({
  canonical: "application/json",
  accepted: Object.freeze(["application/json", "text/json", "text/plain"]),
})
const XML_MEDIA = Object.freeze({
  canonical: "application/xml",
  accepted: Object.freeze(["application/xml", "text/xml", "text/plain"]),
})
const CSV_MEDIA = Object.freeze({
  canonical: "text/csv",
  accepted: Object.freeze(["text/csv", "application/csv", "text/plain"]),
})
const YAML_MEDIA = Object.freeze({
  canonical: "text/yaml",
  accepted: Object.freeze(["text/yaml", "text/x-yaml", "application/yaml", "application/x-yaml", "text/plain"]),
})
const TOML_MEDIA = Object.freeze({
  canonical: "text/x-toml",
  accepted: Object.freeze(["text/x-toml", "application/toml", "text/plain"]),
})
const HTML_MEDIA = Object.freeze({
  canonical: "text/html",
  accepted: Object.freeze(["text/html", "application/xhtml+xml", "text/plain"]),
})
const CSS_MEDIA = Object.freeze({
  canonical: "text/css",
  accepted: Object.freeze(["text/css", "text/plain"]),
})
const PDF_MEDIA = Object.freeze({
  canonical: "application/pdf",
  accepted: Object.freeze(["application/pdf"]),
})
const DOCX_MEDIA = Object.freeze({ canonical: DOCX_MEDIA_TYPE, accepted: Object.freeze([DOCX_MEDIA_TYPE]) })
const PNG_MEDIA = Object.freeze({ canonical: "image/png", accepted: Object.freeze(["image/png"]) })
const JPEG_MEDIA = Object.freeze({ canonical: "image/jpeg", accepted: Object.freeze(["image/jpeg"]) })
const WEBP_MEDIA = Object.freeze({ canonical: "image/webp", accepted: Object.freeze(["image/webp"]) })
const GIF_MEDIA = Object.freeze({ canonical: "image/gif", accepted: Object.freeze(["image/gif"]) })
const WEBM_OPUS_MEDIA = Object.freeze({ canonical: "audio/webm", accepted: Object.freeze(["audio/webm"]) })

const EXTENSION_MEDIA = new Map([
  [".pdf", PDF_MEDIA],
  [".docx", DOCX_MEDIA],
  [".png", PNG_MEDIA], [".jpg", JPEG_MEDIA], [".jpeg", JPEG_MEDIA],
  [".webp", WEBP_MEDIA], [".gif", GIF_MEDIA],
  [".webm", WEBM_OPUS_MEDIA],
  [".md", MARKDOWN], [".markdown", MARKDOWN], [".mdx", MARKDOWN],
  [".txt", TEXT], [".text", TEXT],
  [".js", JAVASCRIPT], [".jsx", JAVASCRIPT], [".mjs", JAVASCRIPT], [".cjs", JAVASCRIPT],
  [".ts", TEXT], [".tsx", TEXT], [".py", TEXT], [".java", TEXT], [".c", TEXT], [".h", TEXT],
  [".cc", TEXT], [".cpp", TEXT], [".cxx", TEXT], [".hpp", TEXT], [".cs", TEXT], [".go", TEXT],
  [".rs", TEXT], [".rb", TEXT], [".php", TEXT], [".swift", TEXT], [".kt", TEXT], [".kts", TEXT],
  [".scala", TEXT], [".sh", TEXT], [".bash", TEXT], [".zsh", TEXT], [".fish", TEXT], [".ps1", TEXT],
  [".sql", TEXT],
  [".css", CSS_MEDIA], [".scss", TEXT], [".sass", TEXT], [".less", TEXT],
  [".html", HTML_MEDIA], [".htm", HTML_MEDIA],
  [".json", JSON_MEDIA], [".jsonl", JSON_MEDIA], [".ipynb", JSON_MEDIA],
  [".xml", XML_MEDIA], [".csv", CSV_MEDIA], [".yaml", YAML_MEDIA], [".yml", YAML_MEDIA],
  [".toml", TOML_MEDIA],
])

const MESSAGES = Object.freeze({
  no_file: "Drop exactly one supported local document file.",
  url_not_supported: "URL drops are not supported. Drop one local document file instead.",
  multiple_files: "Drop exactly one local file at a time.",
  mixed_payload: "Files cannot be dropped together with links or other data.",
  directory_not_supported: "Folder drops are not supported. Drop one local file instead.",
  invalid_filename: "The dropped file name is invalid or too long.",
  empty_file: "The dropped file is empty.",
  file_too_large: "The dropped file exceeds its import limit (20 MiB for raster images or WebM/Opus audio; 25 MiB for DOCX; 100 MB for other documents).",
  unsupported_file_type: "Drop a non-macro DOCX, WebM/Opus audio, a static PNG, JPEG, WebP, or GIF, a PDF, or an allowlisted UTF-8 text, Markdown, code, JSON, XML, CSV, YAML, or TOML file.",
  file_changed: "The dropped file changed while it was being inspected.",
  canvas_unavailable: "A durable authorized Atlas canvas is required before uploading a document.",
})

export class AtlasDropImportError extends TypeError {
  constructor(code) {
    super(MESSAGES[code] || "The dropped content is not supported.")
    this.name = "AtlasDropImportError"
    this.code = code
  }
}

/**
 * Publish callbacks only after React commits the render that supplied them.
 * The identity-checked cleanup cannot erase a newer committed callback pair.
 */
export function commitAtlasDropCallbacks(target, callbacks) {
  if (!target || typeof target !== "object"
    || !callbacks || typeof callbacks !== "object"
    || typeof callbacks.onImport !== "function" || typeof callbacks.onError !== "function") {
    throw new TypeError("Committed Atlas drop callbacks require a ref-like target and exact handlers")
  }
  const committed = Object.freeze({
    onImport: callbacks.onImport,
    onError: callbacks.onError,
  })
  target.current = committed
  return () => {
    if (target.current === committed) target.current = null
  }
}

export function createAtlasDropImportOwner() {
  let controller = null
  return Object.freeze({
    busy: () => controller !== null,
    claim: (candidate) => {
      if (controller !== null || !candidate || typeof candidate.abort !== "function") return false
      controller = candidate
      return true
    },
    release: (candidate) => {
      if (controller !== candidate) return false
      controller = null
      return true
    },
    abort: () => {
      controller?.abort()
    },
  })
}

function fail(code) {
  throw new AtlasDropImportError(code)
}

function entries(value) {
  if (!value) return []
  try {
    return Array.from(value)
  } catch {
    return []
  }
}

function itemEntry(item) {
  try {
    return typeof item?.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null
  } catch {
    return null
  }
}

function extensionOf(filename) {
  const index = filename.lastIndexOf(".")
  return index > 0 ? filename.slice(index).toLowerCase() : ""
}

export function atlasDropTitle(filename) {
  if (typeof filename !== "string") fail("invalid_filename")
  const extension = extensionOf(filename)
  const base = extension ? filename.slice(0, -extension.length) : filename
  const title = base.replaceAll("_", " ").replaceAll("-", " ").replace(/\s+/gu, " ").trim()
  return Array.from(title || "Untitled document").slice(0, 500).join("")
}

export function atlasDropImportRegistered(registry = builtinPluginRegistry) {
  const registration = registry?.resolve?.("sources", ATLAS_DROP_IMPORT_SOURCE_ID)
  if (
    registration?.handler?.kind !== "sources"
    || registration.handler.implementationId !== ATLAS_DROP_IMPORT_IMPLEMENTATION_ID
  ) return false
  try {
    return resolveIngestionPlanDefinition(ATLAS_DROP_INGESTION_PLAN_ID, registry) !== null
  } catch {
    return false
  }
}

export function planAtlasDropImport(transfer) {
  if (!transfer || typeof transfer !== "object") fail("no_file")
  const files = entries(transfer.files)
  const items = entries(transfer.items)
  const types = new Set(entries(transfer.types).map((value) => String(value).toLowerCase()))
  const fileItems = items.filter((item) => item?.kind === "file")
  const stringItems = items.filter((item) => item?.kind === "string")
  if (fileItems.some((item) => itemEntry(item)?.isDirectory === true)) fail("directory_not_supported")
  if (files.some((file) => typeof file?.webkitRelativePath === "string" && file.webkitRelativePath)) {
    fail("directory_not_supported")
  }
  const advertisedStringTypes = [...types].filter((value) => value !== "files")
  if (files.length > 0 && (stringItems.length > 0 || advertisedStringTypes.length > 0)) fail("mixed_payload")
  if (files.length > 1 || fileItems.length > 1) fail("multiple_files")
  if (files.length === 0) {
    if (types.has("text/uri-list") || stringItems.some((item) => item?.type === "text/uri-list")) {
      fail("url_not_supported")
    }
    fail("no_file")
  }

  return planAtlasFileImport(files[0])
}

export function planAtlasFileImport(file) {
  if (typeof file?.name !== "string" || !file.name || Array.from(file.name).length > 512
    || file.name.includes("/") || file.name.includes("\\")
    || FILENAME_CONTROL.test(file.name) || LONE_SURROGATE.test(file.name)) {
    fail("invalid_filename")
  }
  if (!Number.isSafeInteger(file.size) || file.size < 1) fail("empty_file")
  if (file.size > MAX_IMPORT_FILE_BYTES) fail("file_too_large")
  if (rasterImageTypeForFilename(file.name) && file.size > MAX_RASTER_IMAGE_BYTES) fail("file_too_large")
  if (extensionOf(file.name) === ".webm" && file.size > MAX_AUDIO_ORIGINAL_BYTES) fail("file_too_large")
  if (extensionOf(file.name) === ".docx" && file.size > MAX_DOCX_BYTES) fail("file_too_large")
  const media = EXTENSION_MEDIA.get(extensionOf(file.name))
  if (!media) fail("unsupported_file_type")
  const declared = typeof file.type === "string" ? file.type.split(";", 1)[0].trim().toLowerCase() : ""
  if (declared && !media.accepted.includes(declared)) fail("unsupported_file_type")
  const normalizedFile = declared === media.canonical
    ? file
    : new File([file], file.name, { type: media.canonical, lastModified: file.lastModified })
  return Object.freeze({
    file: normalizedFile,
    title: atlasDropTitle(file.name),
    filename: file.name,
    mediaType: media.canonical,
  })
}

/**
 * Read and validate the exact local bytes before any durable canvas or
 * document write. The transport performs the same validation again so the
 * file cannot change between authorization and upload unnoticed.
 */
export async function preflightAtlasDropImport(plan) {
  if (!plan || typeof plan !== "object" || !(plan.file instanceof File)) fail("unsupported_file_type")
  let bytes
  try {
    bytes = await plan.file.arrayBuffer()
  } catch {
    fail("file_changed")
  }
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== plan.file.size) fail("file_changed")
  try {
    const mediaType = durableUploadMediaType({
      name: plan.filename,
      type: plan.file.type,
    }, bytes)
    if (mediaType !== plan.mediaType) fail("unsupported_file_type")
  } catch (error) {
    if (error instanceof AtlasDropImportError) throw error
    if (error instanceof IngestionContractError) fail("unsupported_file_type")
    throw error
  }
  return plan
}

/** Validate bytes first, then require the caller's authorized canvas lane. */
export async function authorizeAtlasDropImportTarget(plan, ensureCanvas) {
  await preflightAtlasDropImport(plan)
  if (typeof ensureCanvas !== "function") fail("canvas_unavailable")
  let canvas
  try {
    canvas = await ensureCanvas()
  } catch {
    fail("canvas_unavailable")
  }
  if (
    !canvas || typeof canvas !== "object"
    || typeof canvas.canvasId !== "string" || !canvas.canvasId
    || typeof canvas.workspaceId !== "string" || !canvas.workspaceId
  ) fail("canvas_unavailable")
  return canvas
}

export function atlasDropWorldPoint(clientPoint, bounds, camera) {
  if (!clientPoint || !bounds || !camera
    || !Number.isFinite(clientPoint.x) || !Number.isFinite(clientPoint.y)
    || !Number.isFinite(bounds.left) || !Number.isFinite(bounds.top)) {
    throw new TypeError("Atlas drop coordinates must be finite")
  }
  return normalizeReferencePlacementPoint(screenToWorld({
    x: clientPoint.x - bounds.left,
    y: clientPoint.y - bounds.top,
  }, camera))
}
