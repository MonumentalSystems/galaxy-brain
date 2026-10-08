import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  checkpointVoiceRecordingDraft,
  createVoiceRecordingDraft,
  loadVoiceRecordingDraft,
  removeVoiceRecordingDraft,
  stageVoiceRecordingDraft,
  writeVoiceRecordingDraft,
} from "../lib/voice-recording-draft-store.js"
import { webmOpusFixture } from "./audio-original-fixture.mjs"

const scope = { tenantId: "tenant", principalId: "person", workspaceId: "workspace", canvasId: "canvas" }
const activeNow = new Date("2026-09-26T13:00:00.000Z")

function deferred() {
  let resolve
  const promise = new Promise((accept) => { resolve = accept })
  return { promise, resolve }
}

function memoryStore() {
  const values = new Map()
  return {
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => values.set(key, structuredClone(value)),
    delete: async (key) => values.delete(key),
    putIfSafe: async (key, value) => {
      const current = values.get(key)
      if (current && current.captureId !== value.captureId
        && Object.values(current.checkpoints ?? {}).some(Boolean)) {
        return { status: "conflict", value: structuredClone(current) }
      }
      if (current?.captureId === value.captureId && current.contentSha256 !== value.contentSha256) {
        return { status: "conflict", value: structuredClone(current) }
      }
      const next = current?.captureId === value.captureId
        ? { ...structuredClone(value), checkpoints: structuredClone(current.checkpoints) }
        : structuredClone(value)
      values.set(key, next)
      return { status: "stored", value: structuredClone(next) }
    },
    deleteIf: async (key, captureId) => {
      if (values.get(key)?.captureId !== captureId) return false
      values.delete(key)
      return true
    },
    migrateIfCurrent: async (sourceKey, targetKey, captureId, value) => {
      const source = values.get(sourceKey)
      const target = values.get(targetKey)
      if (source?.captureId !== captureId) {
        return { status: "source-changed", value: structuredClone(target ?? null) }
      }
      if (target && target.captureId !== captureId) {
        return { status: "target-exists", value: structuredClone(target) }
      }
      if (!target) values.set(targetKey, structuredClone(value))
      values.delete(sourceKey)
      return {
        status: target ? "already-migrated" : "migrated",
        value: structuredClone(target ?? value),
      }
    },
    update: async (key, captureId, update) => {
      const current = values.get(key)
      if (!current || current.captureId !== captureId) throw new Error("The staged recording changed in another tab.")
      const next = update(structuredClone(current))
      values.set(key, structuredClone(next))
      return structuredClone(next)
    },
  }
}

async function draft(overrides = {}) {
  return createVoiceRecordingDraft(scope, {
    blob: new Blob([webmOpusFixture()], { type: "audio/webm" }),
    captureId: "capture-1",
    capturedAt: "2026-09-26T12:00:00.000Z",
    audioFilename: "voice-original-20260926T120000000Z.webm",
    title: "Reviewed note",
    transcript: "A reviewed transcript.",
    ...overrides,
  }, new Date("2026-09-26T12:00:00.000Z"))
}

test("one exact recording is scoped, integrity checked, and expires", async () => {
  const store = memoryStore()
  const value = await draft()
  await writeVoiceRecordingDraft(store, scope, value)
  const restored = await loadVoiceRecordingDraft(store, scope, { now: new Date("2026-09-26T13:00:00.000Z") })
  assert.equal(restored.contentSha256, value.contentSha256)
  assert.equal(await loadVoiceRecordingDraft(store, { ...scope, canvasId: "other" }), null)
  assert.equal(await loadVoiceRecordingDraft(store, scope, { now: new Date("2026-09-28T13:00:00.000Z") }), null)
  await removeVoiceRecordingDraft(store, scope, { captureId: value.captureId })
})

test("checkpoint writes are capture-bound and stale captures cannot overwrite", async () => {
  const store = memoryStore()
  const first = await draft()
  await writeVoiceRecordingDraft(store, scope, first)
  const replacement = await draft({ captureId: "capture-2" })
  await writeVoiceRecordingDraft(store, scope, replacement)
  await assert.rejects(checkpointVoiceRecordingDraft(store, scope, first, {}), /changed in another tab/u)
})

test("capture-bound deletion cannot remove a newer recording in the same scope", async () => {
  const store = memoryStore()
  const first = await draft()
  const replacement = await draft({ captureId: "capture-2" })
  await writeVoiceRecordingDraft(store, scope, replacement)
  await removeVoiceRecordingDraft(store, scope, { captureId: first.captureId })
  assert.equal((await loadVoiceRecordingDraft(store, scope, { now: activeNow })).captureId, replacement.captureId)
})

test("expired cleanup cannot delete a newer capture installed after the read", async () => {
  const base = memoryStore()
  const expired = await draft()
  const replacement = await draft({ captureId: "capture-2" })
  await base.put(expired.scopeKey, expired)
  let raced = false
  const store = {
    ...base,
    get: async (key) => {
      const value = await base.get(key)
      if (!raced && key === expired.scopeKey) {
        raced = true
        await base.put(key, replacement)
      }
      return value
    },
  }
  assert.equal(await loadVoiceRecordingDraft(store, scope, { now: new Date("2026-09-28T13:00:00.000Z") }), null)
  assert.equal((await loadVoiceRecordingDraft(base, scope, { now: activeNow })).captureId, replacement.captureId)
})

test("fallback migration preserves a newer exact capture and its source recovery", async () => {
  const base = memoryStore()
  const fallbackScope = { ...scope, canvasId: `local:${scope.workspaceId}` }
  const fallback = await createVoiceRecordingDraft(fallbackScope, {
    ...(await draft()), captureId: "fallback-capture",
  })
  const replacement = await draft({ captureId: "exact-capture" })
  await base.put(fallback.scopeKey, fallback)
  const store = {
    ...base,
    migrateIfCurrent: async (...args) => {
      await base.put(replacement.scopeKey, replacement)
      return base.migrateIfCurrent(...args)
    },
  }
  const loaded = await loadVoiceRecordingDraft(store, scope, { allowWorkspaceFallback: true, now: activeNow })
  assert.equal(loaded.captureId, replacement.captureId)
  assert.equal((await base.get(fallback.scopeKey)).captureId, fallback.captureId)
})

test("fallback migration cannot delete a newer fallback capture", async () => {
  const base = memoryStore()
  const fallbackScope = { ...scope, canvasId: `local:${scope.workspaceId}` }
  const fallback = await createVoiceRecordingDraft(fallbackScope, {
    ...(await draft()), captureId: "fallback-capture",
  })
  const replacement = await createVoiceRecordingDraft(fallbackScope, {
    ...fallback, captureId: "new-fallback-capture",
  })
  await base.put(fallback.scopeKey, fallback)
  const store = {
    ...base,
    migrateIfCurrent: async (...args) => {
      await base.put(fallback.scopeKey, replacement)
      return base.migrateIfCurrent(...args)
    },
  }
  assert.equal(await loadVoiceRecordingDraft(store, scope, { allowWorkspaceFallback: true, now: activeNow }), null)
  assert.equal((await base.get(fallback.scopeKey)).captureId, replacement.captureId)
})

test("late staging cannot overwrite another tab's partially durable capture", async () => {
  const store = memoryStore()
  const first = await draft()
  await store.put(first.scopeKey, {
    ...first,
    checkpoints: { ...first.checkpoints, audioImport: { durable: true }, transcriptImport: { durable: true } },
  })
  const result = await stageVoiceRecordingDraft(store, scope, {
    ...(await draft({ captureId: "capture-2" })),
  })
  assert.equal(result.stored, false)
  assert.equal(result.storageError, false)
  assert.equal(result.storageConflict, true)
  assert.equal((await store.get(first.scopeKey)).captureId, first.captureId)
})

test("stale async staging neither returns nor deletes a replacement capture", async () => {
  const gate = deferred()
  const entered = deferred()
  const base = memoryStore()
  let current = true
  const store = {
    ...base,
    putIfSafe: async (key, value) => {
      const outcome = await base.putIfSafe(key, value)
      entered.resolve()
      await gate.promise
      return outcome
    },
  }
  const staging = stageVoiceRecordingDraft(store, scope, {
    blob: new Blob([webmOpusFixture()], { type: "audio/webm" }),
    captureId: "capture-1",
    capturedAt: "2026-09-26T12:00:00.000Z",
    audioFilename: "voice-original-20260926T120000000Z.webm",
    title: "First capture",
    transcript: "First transcript.",
  }, { isCurrent: () => current })
  await entered.promise
  current = false
  const replacement = await draft({ captureId: "capture-2" })
  await base.put(replacement.scopeKey, replacement)
  gate.resolve()
  assert.deepEqual(await staging, { status: "stale", draft: null, stored: false, storageError: false })
  assert.equal((await loadVoiceRecordingDraft(base, scope, { now: activeNow })).captureId, replacement.captureId)
})

test("IndexedDB implementation acknowledges writes only after transaction completion", async () => {
  const source = await readFile(new URL("../lib/voice-recording-draft-store.js", import.meta.url), "utf8")
  assert.match(source, /transaction\.oncomplete = \(\) => resolve/u)
  assert.match(source, /current\.captureId !== captureId/u)
  assert.match(source, /request\.result\?\.captureId !== captureId/u)
  assert.match(source, /migrateIfCurrent/u)
  assert.match(source, /putIfSafe/u)
  assert.match(source, /request\.onsuccess = \(\) => \{ result = request\.result \}/u)
})
