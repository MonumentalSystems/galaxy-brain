const SCHEMA_ID = "gb.code-editor-draft.v1"
const MAX_CONTENT_BYTES = 262_144
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u
const LANGUAGES = new Set([
  "javascript", "typescript", "jsx", "tsx", "python", "css", "json", "bash",
  "sql", "go", "rust", "yaml", "markdown", "latex", "plaintext",
])
const CHANNELS = new Set(["code", "markdown-note"])

function draftChannel(value = "code") {
  if (!CHANNELS.has(value)) throw new TypeError("Code editor draft channel is invalid")
  return value
}

function bounded(value, maximum, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`)
  const normalized = value.trim()
  if (!normalized || Array.from(normalized).length > maximum || CONTROL.test(normalized)) {
    throw new TypeError(`${label} is outside its bounded text contract`)
  }
  return normalized
}

function draftText(value, maximum, label) {
  if (typeof value !== "string" || Array.from(value).length > maximum) {
    throw new TypeError(`${label} exceeds its draft limit`)
  }
  return value
}

function scopeKey(scope, channel = "code") {
  const tenantId = bounded(scope?.tenantId, 512, "Tenant identifier")
  const principalId = bounded(scope?.principalId, 512, "Principal identifier")
  const workspaceId = bounded(scope?.workspaceId, 512, "Workspace identifier")
  const canvasId = bounded(scope?.canvasId, 512, "Canvas identifier")
  const base = `gb:code-editor-draft:v1:${[tenantId, principalId, workspaceId, canvasId]
    .map(encodeURIComponent)
    .join(":")}`
  return draftChannel(channel) === "code" ? base : `${base}:markdown-note`
}

export function normalizeCodeEditorDraft(value, { channel = "code" } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Code editor draft must be an object")
  }
  const normalizedChannel = draftChannel(channel)
  const language = normalizedChannel === "markdown-note"
    ? "markdown"
    : bounded(value.language, 40, "Code language").toLowerCase()
  if (!LANGUAGES.has(language)) throw new TypeError("Code language is invalid")
  if (typeof value.content !== "string" || new TextEncoder().encode(value.content).byteLength > MAX_CONTENT_BYTES) {
    throw new TypeError("Code content exceeds the 256 KB editor limit")
  }
  const updatedAt = typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt))
    ? new Date(value.updatedAt).toISOString()
    : new Date().toISOString()
  return Object.freeze({
    schemaId: SCHEMA_ID,
    title: draftText(value.title, 240, "Code title"),
    filename: draftText(value.filename, 240, "Code filename"),
    language,
    content: value.content,
    updatedAt,
  })
}

export function loadCodeEditorDraft(storage, scope, { channel = "code" } = {}) {
  const normalizedChannel = draftChannel(channel)
  const key = scopeKey(scope, normalizedChannel)
  try {
    const encoded = storage.getItem(key)
    if (!encoded) return null
    const value = JSON.parse(encoded)
    if (value?.schemaId !== SCHEMA_ID) throw new TypeError("Unsupported code draft schema")
    return normalizeCodeEditorDraft(value, { channel: normalizedChannel })
  } catch {
    try { storage.removeItem(key) } catch {}
    return null
  }
}

function workspaceFallbackScope(scope) {
  return { ...scope, canvasId: `local:${scope.workspaceId}` }
}

export function loadCodeEditorDraftWithWorkspaceFallback(storage, scope, {
  allowWorkspaceFallback = false,
  channel = "code",
} = {}) {
  const normalizedChannel = draftChannel(channel)
  const exact = loadCodeEditorDraft(storage, scope, { channel: normalizedChannel })
  if (exact || !allowWorkspaceFallback || scope.canvasId === `local:${scope.workspaceId}`) return exact
  const fallbackScope = workspaceFallbackScope(scope)
  const fallback = loadCodeEditorDraft(storage, fallbackScope, { channel: normalizedChannel })
  if (!fallback) return null
  try {
    const migrated = writeCodeEditorDraft(storage, scope, fallback, { channel: normalizedChannel })
    try { storage.removeItem(scopeKey(fallbackScope, normalizedChannel)) } catch {}
    return migrated
  } catch {
    return fallback
  }
}

export function writeCodeEditorDraft(storage, scope, draft, { channel = "code" } = {}) {
  const normalizedChannel = draftChannel(channel)
  const normalized = normalizeCodeEditorDraft(
    { ...draft, updatedAt: new Date().toISOString() },
    { channel: normalizedChannel },
  )
  storage.setItem(scopeKey(scope, normalizedChannel), JSON.stringify(normalized))
  return normalized
}

export function removeCodeEditorDraft(storage, scope, { channel = "code" } = {}) {
  try { storage.removeItem(scopeKey(scope, draftChannel(channel))) } catch {}
}

export function removeCodeEditorDraftWithWorkspaceFallback(storage, scope, {
  allowWorkspaceFallback = false,
  channel = "code",
} = {}) {
  const normalizedChannel = draftChannel(channel)
  removeCodeEditorDraft(storage, scope, { channel: normalizedChannel })
  if (allowWorkspaceFallback && scope.canvasId !== `local:${scope.workspaceId}`) {
    removeCodeEditorDraft(storage, workspaceFallbackScope(scope), { channel: normalizedChannel })
  }
}

export { MAX_CONTENT_BYTES as MAX_CODE_EDITOR_CONTENT_BYTES }
