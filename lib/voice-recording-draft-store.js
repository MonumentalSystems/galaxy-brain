import {
  audioOriginalMediaType,
  MAX_AUDIO_ORIGINAL_BYTES,
} from "./audio-original-contract.js"
import { validateDurableDocumentImport } from "./durable-document-import.js"

const DB_NAME = "galaxy-brain-voice-capture"
const STORE_NAME = "recordings"
const DB_VERSION = 1
const SCHEMA_ID = "gb.voice-recording-draft.v1"
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function bounded(value, maximum, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`)
  const normalized = value.trim()
  if (!normalized || Array.from(normalized).length > maximum || CONTROL.test(normalized)) {
    throw new TypeError(`${label} is outside its bounded text contract`)
  }
  return normalized
}

function scopeKey(scope) {
  return [scope?.tenantId, scope?.principalId, scope?.workspaceId, scope?.canvasId]
    .map((value, index) => encodeURIComponent(bounded(value, 512, ["Tenant", "Principal", "Workspace", "Canvas"][index])))
    .join(":")
}

function fallbackScope(scope) {
  return { ...scope, canvasId: `local:${scope.workspaceId}` }
}

function timestamp(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new TypeError(`${label} is invalid`)
  return new Date(value).toISOString()
}

async function sha256(blob) {
  const bytes = await blob.arrayBuffer()
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function sha256Text(value) {
  return sha256(new Blob([value], { type: "text/plain" }))
}

function importCheckpoint(value, expectedHash, expectedMediaType, expectedByteSize) {
  if (!value || typeof value !== "object" || !UUID.test(value.placementOperationId)) {
    throw new TypeError("Voice import checkpoint is invalid")
  }
  const document = validateDurableDocumentImport(value.document)
  if (document.content_sha256 !== expectedHash || document.media_type !== expectedMediaType || document.byte_size !== expectedByteSize) {
    throw new TypeError("Voice import checkpoint does not match the staged content")
  }
  return Object.freeze({ document, placementOperationId: value.placementOperationId.toLowerCase() })
}

function relationCheckpoint(value, transcriptRef, audioRef, expectedIdempotencyKey) {
  if (!value || typeof value !== "object" || !UUID.test(value.id) || value.version !== 1
    || value.fromRef !== transcriptRef || value.toRef !== audioRef
    || value.idempotencyKey !== expectedIdempotencyKey) {
    throw new TypeError("Voice relation checkpoint is invalid")
  }
  return Object.freeze({ ...value, id: value.id.toLowerCase() })
}

function transactionResult(transaction, request) {
  return new Promise((resolve, reject) => {
    let result
    request.onsuccess = () => { result = request.result }
    transaction.oncomplete = () => resolve(result)
    transaction.onerror = () => reject(new Error("Voice recording recovery is unavailable."))
    transaction.onabort = () => reject(new Error("Voice recording recovery is unavailable."))
  })
}

export function createVoiceRecordingDraftStore(indexedDb = globalThis.indexedDB) {
  if (!indexedDb?.open) throw new Error("Voice recording recovery is unavailable.")
  let databasePromise
  const database = () => {
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDb.open(DB_NAME, DB_VERSION)
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(new Error("Voice recording recovery is unavailable."))
        request.onblocked = () => reject(new Error("Voice recording recovery is unavailable."))
      })
    }
    return databasePromise
  }
  const run = async (mode, action) => {
    const db = await database()
    const transaction = db.transaction(STORE_NAME, mode)
    const request = action(transaction.objectStore(STORE_NAME))
    return transactionResult(transaction, request)
  }
  return Object.freeze({
    get: (key) => run("readonly", (store) => store.get(key)),
    put: (key, value) => run("readwrite", (store) => store.put(value, key)),
    delete: (key) => run("readwrite", (store) => store.delete(key)),
    putIfSafe: async (key, value) => {
      const db = await database()
      const transaction = db.transaction(STORE_NAME, "readwrite")
      const objectStore = transaction.objectStore(STORE_NAME)
      const request = objectStore.get(key)
      let outcome
      request.onsuccess = () => {
        const current = request.result
        const durableCurrent = Object.values(current?.checkpoints ?? {}).some(Boolean)
        if (current && current.captureId !== value.captureId && durableCurrent) {
          outcome = { status: "conflict", value: current }
          return
        }
        if (current?.captureId === value.captureId && current.contentSha256 !== value.contentSha256) {
          outcome = { status: "conflict", value: current }
          return
        }
        const next = current?.captureId === value.captureId
          ? { ...value, checkpoints: current.checkpoints }
          : value
        objectStore.put(next, key)
        outcome = { status: "stored", value: next }
      }
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve
        transaction.onerror = () => reject(new Error("Voice recording recovery is unavailable."))
        transaction.onabort = () => reject(new Error("Voice recording recovery is unavailable."))
      })
      return outcome
    },
    deleteIf: async (key, captureId) => {
      const db = await database()
      const transaction = db.transaction(STORE_NAME, "readwrite")
      const objectStore = transaction.objectStore(STORE_NAME)
      const request = objectStore.get(key)
      let matched = false
      request.onsuccess = () => {
        if (request.result?.captureId !== captureId) return
        matched = true
        objectStore.delete(key)
      }
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve
        transaction.onerror = () => reject(new Error("Voice recording recovery is unavailable."))
        transaction.onabort = () => reject(new Error("Voice recording recovery is unavailable."))
      })
      return matched
    },
    migrateIfCurrent: async (sourceKey, targetKey, captureId, value) => {
      const db = await database()
      const transaction = db.transaction(STORE_NAME, "readwrite")
      const objectStore = transaction.objectStore(STORE_NAME)
      const sourceRequest = objectStore.get(sourceKey)
      const targetRequest = objectStore.get(targetKey)
      let sourceReady = false
      let targetReady = false
      let outcome
      const decide = () => {
        if (!sourceReady || !targetReady || outcome) return
        const source = sourceRequest.result
        const target = targetRequest.result
        if (source?.captureId !== captureId) {
          outcome = { status: "source-changed", value: target ?? null }
          return
        }
        if (target && target.captureId !== captureId) {
          outcome = { status: "target-exists", value: target }
          return
        }
        if (!target) objectStore.put(value, targetKey)
        objectStore.delete(sourceKey)
        outcome = { status: target ? "already-migrated" : "migrated", value: target ?? value }
      }
      sourceRequest.onsuccess = () => { sourceReady = true; decide() }
      targetRequest.onsuccess = () => { targetReady = true; decide() }
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve
        transaction.onerror = () => reject(new Error("Voice recording recovery is unavailable."))
        transaction.onabort = () => reject(new Error("Voice recording recovery is unavailable."))
      })
      return outcome
    },
    update: async (key, captureId, update) => {
      const db = await database()
      const transaction = db.transaction(STORE_NAME, "readwrite")
      const objectStore = transaction.objectStore(STORE_NAME)
      const request = objectStore.get(key)
      let next
      let updateError
      request.onsuccess = () => {
        const current = request.result
        if (!current || current.captureId !== captureId) {
          transaction.abort()
          return
        }
        try {
          next = update(current)
          objectStore.put(next, key)
        } catch (error) {
          updateError = error
          transaction.abort()
        }
      }
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve
        transaction.onerror = () => reject(new Error("Voice recording recovery is unavailable."))
        transaction.onabort = () => reject(updateError ?? new Error("The staged recording changed in another tab."))
      })
      return next
    },
  })
}

export async function createVoiceRecordingDraft(scope, input, now = new Date()) {
  const blob = input?.blob
  if (!(blob instanceof Blob) || blob.size < 1 || blob.size > MAX_AUDIO_ORIGINAL_BYTES) {
    throw new TypeError("Voice recording is outside the 20 MiB limit")
  }
  const bytes = await blob.arrayBuffer()
  audioOriginalMediaType("voice-original.webm", "audio/webm", bytes)
  const createdAt = timestamp(input.createdAt ?? now.toISOString(), "Recording timestamp")
  const expiresAt = new Date(Math.min(
    Date.parse(input.expiresAt ?? new Date(Date.parse(createdAt) + MAX_AGE_MS).toISOString()),
    Date.parse(createdAt) + MAX_AGE_MS,
  )).toISOString()
  const contentSha256 = await sha256(blob)
  const transcript = typeof input.transcript === "string" ? input.transcript : ""
  const transcriptSha256 = await sha256Text(transcript)
  const audioFilename = bounded(input.audioFilename, 240, "Audio filename")
  if (!audioFilename.toLowerCase().endsWith(".webm")) throw new TypeError("Audio filename must end in .webm")
  return Object.freeze({
    schemaId: SCHEMA_ID,
    scopeKey: scopeKey(scope),
    captureId: bounded(input.captureId, 128, "Capture identifier"),
    capturedAt: timestamp(input.capturedAt, "Capture timestamp"),
    createdAt,
    expiresAt,
    audioFilename,
    byteSize: blob.size,
    contentSha256,
    transcriptSha256,
    blob,
    title: typeof input.title === "string" ? input.title : "",
    transcript,
    checkpoints: Object.freeze({
      audioImport: input.checkpoints?.audioImport ?? null,
      transcriptImport: input.checkpoints?.transcriptImport ?? null,
      link: input.checkpoints?.link ?? null,
    }),
  })
}

async function normalizeLoaded(scope, value, now) {
  if (!value || value.schemaId !== SCHEMA_ID || value.scopeKey !== scopeKey(scope)) throw new TypeError("Voice recording recovery is invalid")
  if (!(value.blob instanceof Blob) || value.byteSize !== value.blob.size) {
    throw new TypeError("Voice recording recovery is invalid")
  }
  if (Date.parse(value.expiresAt) <= now.getTime()) {
    if (Object.values(value.checkpoints ?? {}).some(Boolean)) {
      throw new Error("A partially saved voice capture expired locally. Its durable documents were not deleted.")
    }
    throw new TypeError("Voice recording recovery expired")
  }
  const normalized = await createVoiceRecordingDraft(scope, value, new Date(value.createdAt))
  if (normalized.contentSha256 !== value.contentSha256 || normalized.transcriptSha256 !== value.transcriptSha256) {
    throw new TypeError("Voice recording recovery failed its integrity check")
  }
  const audioImport = value.checkpoints?.audioImport
    ? importCheckpoint(value.checkpoints.audioImport, normalized.contentSha256, "audio/webm", normalized.byteSize)
    : null
  const transcriptImport = value.checkpoints?.transcriptImport
    ? importCheckpoint(
        value.checkpoints.transcriptImport,
        normalized.transcriptSha256,
        "text/markdown",
        new TextEncoder().encode(normalized.transcript).byteLength,
      )
    : null
  const expectedLinkKey = transcriptImport && audioImport
    ? `voice-pair:v1:${await sha256Text(JSON.stringify([transcriptImport.document.ref, audioImport.document.ref]))}`
    : null
  const link = value.checkpoints?.link
    ? relationCheckpoint(value.checkpoints.link, transcriptImport?.document.ref, audioImport?.document.ref, expectedLinkKey)
    : null
  if (link && (!audioImport || !transcriptImport)) throw new TypeError("Voice relation checkpoint is missing its imports")
  return Object.freeze({ ...normalized, checkpoints: Object.freeze({ audioImport, transcriptImport, link }) })
}

export async function writeVoiceRecordingDraft(store, scope, draft) {
  const normalized = await createVoiceRecordingDraft(scope, draft)
  await store.put(scopeKey(scope), normalized)
  return normalized
}

export async function loadVoiceRecordingDraft(store, scope, options = {}) {
  const now = options.now ?? new Date()
  const exactKey = scopeKey(scope)
  const normalizeCandidate = async (candidateScope, key, value) => {
    if (!value) return null
    try { return await normalizeLoaded(candidateScope, value, now) } catch (error) {
      if (Object.values(value?.checkpoints ?? {}).some(Boolean)) throw error
      if (typeof value?.captureId === "string") await store.deleteIf(key, value.captureId)
      return null
    }
  }
  const tryLoad = async (candidateScope) => {
    const key = scopeKey(candidateScope)
    return normalizeCandidate(candidateScope, key, await store.get(key))
  }
  const exact = await tryLoad(scope)
  if (exact || !options.allowWorkspaceFallback || scope.canvasId === `local:${scope.workspaceId}`) return exact
  const priorScope = fallbackScope(scope)
  const prior = await tryLoad(priorScope)
  if (!prior) return null
  const migrated = await createVoiceRecordingDraft(scope, prior, new Date(prior.createdAt))
  const outcome = await store.migrateIfCurrent(
    scopeKey(priorScope), exactKey, prior.captureId, migrated,
  )
  return normalizeCandidate(scope, exactKey, outcome?.value)
}

export async function removeVoiceRecordingDraft(store, scope, options = {}) {
  const captureId = bounded(options.captureId, 128, "Capture identifier")
  await store.deleteIf(scopeKey(scope), captureId)
  if (options.allowWorkspaceFallback && scope.canvasId !== `local:${scope.workspaceId}`) {
    await store.deleteIf(scopeKey(fallbackScope(scope)), captureId)
  }
}

export async function stageVoiceRecordingDraft(store, scope, input, options = {}) {
  const isCurrent = typeof options.isCurrent === "function" ? options.isCurrent : () => true
  const draft = await createVoiceRecordingDraft(scope, input)
  if (!isCurrent()) return Object.freeze({ status: "stale", draft: null, stored: false, storageError: false })
  if (!store) return Object.freeze({ status: "ready", draft, stored: false, storageError: true, storageConflict: false })
  try {
    const outcome = await store.putIfSafe(scopeKey(scope), draft)
    if (outcome?.status !== "stored") {
      return Object.freeze({ status: "ready", draft, stored: false, storageError: false, storageConflict: true })
    }
  } catch {
    if (!isCurrent()) return Object.freeze({ status: "stale", draft: null, stored: false, storageError: false })
    return Object.freeze({ status: "ready", draft, stored: false, storageError: true, storageConflict: false })
  }
  if (!isCurrent()) {
    try { await removeVoiceRecordingDraft(store, scope, { captureId: draft.captureId }) } catch {}
    return Object.freeze({ status: "stale", draft: null, stored: false, storageError: false })
  }
  return Object.freeze({ status: "ready", draft, stored: true, storageError: false, storageConflict: false })
}

export async function checkpointVoiceRecordingDraft(store, scope, current, checkpoint) {
  if (!current || current.scopeKey !== scopeKey(scope)) throw new TypeError("Voice recording checkpoint is not scoped to this Atlas")
  const checkpoints = { ...current.checkpoints }
  for (const key of ["audioImport", "transcriptImport", "link"]) {
    if (checkpoint[key] !== undefined) {
      if (checkpoints[key] && JSON.stringify(checkpoints[key]) !== JSON.stringify(checkpoint[key])) {
        throw new TypeError("Voice recording checkpoint cannot be replaced")
      }
      checkpoints[key] = checkpoint[key]
    }
  }
  const normalized = await createVoiceRecordingDraft(scope, { ...current, checkpoints }, new Date(current.createdAt))
  const updated = await store.update(scopeKey(scope), current.captureId, (persisted) => {
    const merged = { ...persisted.checkpoints }
    for (const key of ["audioImport", "transcriptImport", "link"]) {
      if (normalized.checkpoints[key] == null) continue
      if (merged[key] && JSON.stringify(merged[key]) !== JSON.stringify(normalized.checkpoints[key])) {
        throw new TypeError("Voice recording checkpoint cannot be replaced")
      }
      merged[key] = normalized.checkpoints[key]
    }
    return {
      ...persisted,
      title: normalized.title,
      transcript: normalized.transcript,
      transcriptSha256: normalized.transcriptSha256,
      expiresAt: new Date(Date.now() + MAX_AGE_MS).toISOString(),
      checkpoints: merged,
    }
  })
  return normalizeLoaded(scope, updated, new Date())
}

export { MAX_AGE_MS as VOICE_RECORDING_MAX_AGE_MS }
