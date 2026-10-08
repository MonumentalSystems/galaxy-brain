import { builtinPluginRegistry } from "./plugins/builtins.js"
import { resolveIngestionPlanDefinition } from "./plugins/ingestion-plans.js"

export const MAX_DATASOURCE_ITEM_ID_CHARACTERS = 2_048
export const MAX_DATASOURCE_CONTENT_REQUEST_BYTES = 4_096
export const MAX_DATASOURCE_SOURCE_URI_CHARACTERS = 4_096
export const DATASOURCE_FILE_SOURCE_ID = "datasource.connected"
export const DATASOURCE_FILE_SOURCE_IMPLEMENTATION_ID = "builtin.datasource.connected-source"
export const DATASOURCE_FILE_INGESTION_PLAN_ID = "datasource.file-default"

const DURABLE_TEXT_EXTENSIONS = new Set([
  ".c", ".cpp", ".css", ".csv", ".go", ".h", ".htm", ".html", ".java", ".js", ".json",
  ".jsx", ".log", ".markdown", ".md", ".mdx", ".php", ".py", ".rb", ".rs", ".sh",
  ".sql", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
])

function extension(value) {
  const index = value.lastIndexOf(".")
  return index < 0 ? "" : value.slice(index).toLowerCase()
}

export function datasourceFileIngestionRegistered(registry = builtinPluginRegistry) {
  const registration = registry?.resolve?.("sources", DATASOURCE_FILE_SOURCE_ID)
  if (
    registration?.handler?.kind !== "sources"
    || registration.handler.implementationId !== DATASOURCE_FILE_SOURCE_IMPLEMENTATION_ID
  ) return false
  try {
    return resolveIngestionPlanDefinition(DATASOURCE_FILE_INGESTION_PLAN_ID, registry) !== null
  } catch {
    return false
  }
}

export function datasourceImportFilename(item) {
  return (item.path || item.title || "datasource-item")
    .split(/[\\/]/u)
    .at(-1)
    ?.trim() || "datasource-item"
}

export function datasourceContentRequestBody(itemId) {
  return JSON.stringify({ item_id: itemId })
}

export function datasourceDurableImportUnavailableReason(item, connection) {
  if (typeof item.id !== "string" || item.id.length < 1 || Array.from(item.id).length > MAX_DATASOURCE_ITEM_ID_CHARACTERS) {
    return "This source item has an invalid or oversized identity."
  }
  if (!connection || typeof connection.id !== "string" || connection.id.length < 1) {
    return "This datasource connection has an invalid identity."
  }
  const requestBytes = new TextEncoder().encode(datasourceContentRequestBody(item.id)).byteLength
  const sourceUriCharacters = Array.from(datasourceSourceUri(connection, item)).length
  if (
    requestBytes > MAX_DATASOURCE_CONTENT_REQUEST_BYTES
    || sourceUriCharacters > MAX_DATASOURCE_SOURCE_URI_CHARACTERS
  ) {
    return "This source item identity exceeds the bounded durable import transport."
  }
  if (!Number.isSafeInteger(item.size) || (item.size || 0) < 1) {
    return "This source did not report a non-empty exact file size."
  }
  if ((item.size || 0) > 100_000_000) {
    return "This file exceeds the 100 MB durable import limit."
  }
  const filename = datasourceImportFilename(item)
  if (Array.from(filename).length > 512) {
    return "This source filename exceeds the 512-character durable import limit."
  }
  const title = item.title.trim() || filename
  if (Array.from(title.replace(/\.[^.]+$/u, "") || title).length > 500) {
    return "This source title exceeds the 500-character durable import limit."
  }
  const mimeType = (item.mime_type || "").split(";", 1)[0].trim().toLowerCase()
  if (extension(filename) === ".pdf" && (mimeType === "" || mimeType === "application/pdf")) return null
  if (
    DURABLE_TEXT_EXTENSIONS.has(extension(filename))
    && (mimeType.startsWith("text/") || ["", "application/json", "application/xml"].includes(mimeType))
  ) return null
  return "Exact durable import currently supports PDF and UTF-8 text, Markdown, code, JSON, or XML files."
}

export function datasourceSourceUri(connection, item) {
  return `datasource://${encodeURIComponent(connection.id)}/${encodeURIComponent(item.id)}`
}

export function datasourceImportTitle(item) {
  const normalized = item.title.trim() || datasourceImportFilename(item)
  const withoutExtension = normalized.replace(/\.[^.]+$/u, "")
  return withoutExtension || normalized
}
