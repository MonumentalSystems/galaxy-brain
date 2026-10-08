const SCHEMA_ID = "gb.voice-input-draft.v1"
const MAX_TRANSCRIPT_BYTES = 262_144
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u

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

function scopeKey(scope) {
  const values = [
    bounded(scope?.tenantId, 512, "Tenant identifier"),
    bounded(scope?.principalId, 512, "Principal identifier"),
    bounded(scope?.workspaceId, 512, "Workspace identifier"),
    bounded(scope?.canvasId, 512, "Canvas identifier"),
  ]
  return `gb:voice-input-draft:v1:${values.map(encodeURIComponent).join(":")}`
}

function isoTimestamp(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TypeError("Voice capture timestamp is invalid")
  }
  return new Date(value).toISOString()
}

export function normalizeVoiceInputDraft(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Voice input draft must be an object")
  }
  if (
    typeof value.transcript !== "string"
    || new TextEncoder().encode(value.transcript).byteLength > MAX_TRANSCRIPT_BYTES
  ) throw new TypeError("Voice transcript exceeds the 256 KB draft limit")
  return Object.freeze({
    schemaId: SCHEMA_ID,
    title: draftText(value.title, 240, "Voice note title"),
    transcript: value.transcript,
    capturedAt: isoTimestamp(value.capturedAt),
    updatedAt: value.updatedAt == null ? new Date().toISOString() : isoTimestamp(value.updatedAt),
  })
}

export function loadVoiceInputDraft(storage, scope) {
  const key = scopeKey(scope)
  try {
    const encoded = storage.getItem(key)
    if (!encoded) return null
    const value = JSON.parse(encoded)
    if (value?.schemaId !== SCHEMA_ID) throw new TypeError("Unsupported voice draft schema")
    return normalizeVoiceInputDraft(value)
  } catch {
    try { storage.removeItem(key) } catch {}
    return null
  }
}

function workspaceFallbackScope(scope) {
  return { ...scope, canvasId: `local:${scope.workspaceId}` }
}

export function loadVoiceInputDraftWithWorkspaceFallback(storage, scope, { allowWorkspaceFallback = false } = {}) {
  const exact = loadVoiceInputDraft(storage, scope)
  if (exact || !allowWorkspaceFallback || scope.canvasId === `local:${scope.workspaceId}`) return exact
  const fallbackScope = workspaceFallbackScope(scope)
  const fallback = loadVoiceInputDraft(storage, fallbackScope)
  if (!fallback) return null
  try {
    const migrated = writeVoiceInputDraft(storage, scope, fallback)
    try { storage.removeItem(scopeKey(fallbackScope)) } catch {}
    return migrated
  } catch {
    return fallback
  }
}

export function writeVoiceInputDraft(storage, scope, draft) {
  const normalized = normalizeVoiceInputDraft({ ...draft, updatedAt: new Date().toISOString() })
  storage.setItem(scopeKey(scope), JSON.stringify(normalized))
  return normalized
}

export function removeVoiceInputDraft(storage, scope) {
  try { storage.removeItem(scopeKey(scope)) } catch {}
}

export function removeVoiceInputDraftWithWorkspaceFallback(storage, scope, { allowWorkspaceFallback = false } = {}) {
  removeVoiceInputDraft(storage, scope)
  if (allowWorkspaceFallback && scope.canvasId !== `local:${scope.workspaceId}`) {
    removeVoiceInputDraft(storage, workspaceFallbackScope(scope))
  }
}

export function voiceNoteFilename(capturedAt) {
  return `voice-note-${isoTimestamp(capturedAt).replace(/[-:.]/gu, "")}.md`
}

export { MAX_TRANSCRIPT_BYTES as MAX_VOICE_TRANSCRIPT_BYTES }
