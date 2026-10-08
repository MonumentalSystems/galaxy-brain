import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  loadVoiceInputDraft,
  loadVoiceInputDraftWithWorkspaceFallback,
  MAX_VOICE_TRANSCRIPT_BYTES,
  normalizeVoiceInputDraft,
  removeVoiceInputDraft,
  removeVoiceInputDraftWithWorkspaceFallback,
  voiceNoteFilename,
  writeVoiceInputDraft,
} from "../lib/voice-input-draft.js"

function storage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

const scope = {
  tenantId: "tenant-1",
  principalId: "principal-1",
  workspaceId: "workspace-1",
  canvasId: "canvas-1",
}

test("voice drafts are tab-scoped, bounded, and keep stable capture identity", () => {
  const state = storage()
  const capturedAt = "2026-09-24T12:34:56.789Z"
  const draft = writeVoiceInputDraft(state, scope, {
    title: "Vortex note",
    transcript: "Helicity constrains the observed transition.",
    capturedAt,
  })
  assert.equal(draft.schemaId, "gb.voice-input-draft.v1")
  assert.equal(draft.capturedAt, capturedAt)
  assert.deepEqual(loadVoiceInputDraft(state, scope), draft)
  assert.equal(loadVoiceInputDraft(state, { ...scope, canvasId: "canvas-2" }), null)
  assert.equal(voiceNoteFilename(capturedAt), "voice-note-20260924T123456789Z.md")
  assert.throws(() => normalizeVoiceInputDraft({
    title: "Large",
    transcript: "x".repeat(MAX_VOICE_TRANSCRIPT_BYTES + 1),
    capturedAt,
  }), /256 KB/)
  removeVoiceInputDraft(state, scope)
  assert.equal(loadVoiceInputDraft(state, scope), null)
})

test("blocked draft storage degrades to an in-memory workflow without throwing", () => {
  const blocked = {
    getItem() { throw new DOMException("blocked", "SecurityError") },
    setItem() { throw new DOMException("blocked", "SecurityError") },
    removeItem() { throw new DOMException("blocked", "SecurityError") },
  }
  assert.equal(loadVoiceInputDraft(blocked, scope), null)
  assert.doesNotThrow(() => removeVoiceInputDraft(blocked, scope))
  assert.throws(() => writeVoiceInputDraft(blocked, scope, {
    title: "In-memory note",
    transcript: "Still reviewable and saveable.",
    capturedAt: "2026-09-24T12:34:56.789Z",
  }), /blocked/)
})

test("first-canvas creation migrates the workspace-local transcript without changing capture identity", () => {
  const state = storage()
  const localScope = { ...scope, canvasId: `local:${scope.workspaceId}` }
  const durableScope = { ...scope, canvasId: "canvas-created-later" }
  const capturedAt = "2026-09-24T12:34:56.789Z"
  const draft = writeVoiceInputDraft(state, localScope, {
    title: "Before canvas",
    transcript: "The first durable canvas is created during placement.",
    capturedAt,
  })
  assert.equal(loadVoiceInputDraftWithWorkspaceFallback(state, durableScope), null)
  assert.deepEqual(loadVoiceInputDraft(state, localScope), draft)
  removeVoiceInputDraftWithWorkspaceFallback(state, durableScope)
  assert.deepEqual(loadVoiceInputDraft(state, localScope), draft)
  const restored = loadVoiceInputDraftWithWorkspaceFallback(state, durableScope, {
    allowWorkspaceFallback: true,
  })
  assert.equal(restored.title, draft.title)
  assert.equal(restored.transcript, draft.transcript)
  assert.equal(restored.capturedAt, capturedAt)
  assert.deepEqual(loadVoiceInputDraft(state, durableScope), restored)
  assert.equal(loadVoiceInputDraft(state, localScope), null)
  removeVoiceInputDraftWithWorkspaceFallback(state, durableScope, { allowWorkspaceFallback: true })
  assert.equal(loadVoiceInputDraft(state, durableScope), null)
  assert.equal(loadVoiceInputDraft(state, localScope), null)
})

test("voice capture remains review-first, pairs optional exact audio, and never becomes an action surface", async () => {
  const [dialog, atlas, plugins] = await Promise.all([
    readFile(new URL("../components/voice/voice-capture-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/plugins/builtins.js", import.meta.url), "utf8"),
  ])
  assert.match(dialog, /createBrowserSpeechRecognitionSession/)
  assert.match(dialog, /createBrowserMediaRecorderSession/)
  assert.match(dialog, /Record audio original/)
  assert.match(dialog, /Review recorded audio/)
  assert.match(dialog, /window\.sessionStorage/)
  assert.doesNotMatch(dialog, /window\.localStorage/)
  assert.match(dialog, /new File\(\[transcript\], filename, \{ type: "text\/markdown" \}\)/)
  assert.match(dialog, /Review the transcript before saving/)
  assert.match(dialog, /speech never dispatches commands or actions/)
  assert.match(dialog, /session\.dispose\(\)/)
  assert.match(dialog, /Draft recovery is unavailable in this browser context/)
  assert.match(dialog, /!nextOpen && \(ambiguous \|\| draftStorageWarning \|\| volatileAudio\)/)
  assert.match(dialog, /stagingGenerationRef\.current === captureGeneration/)
  assert.match(dialog, /isCurrent: \(\) => recordingGenerationRef\.current === captureGeneration/)
  assert.match(dialog, /recordingStoreRef\.current && recordingStored/)
  assert.match(dialog, /recordingStoreAvailable: Boolean\(recordingStoreRef\.current && recordingStored\)/)
  assert.match(dialog, /The exact audio exists only in this open dialog and will be lost/)
  assert.match(dialog, /Discard audio & close/)
  assert.match(dialog, /The exact audio original is durable, but no transcript revision is confirmed/)
  assert.match(dialog, /The exact audio and reviewed transcript are durable, but their authored link is not confirmed/)
  assert.match(dialog, /The exact audio, reviewed transcript, and authored link are durable\. No Atlas placement checkpoint is confirmed/)
  assert.match(dialog, /Atlas placement was requested but is not confirmed/)
  assert.match(dialog, /if \(skipDraftWriteRef\.current\)/)
  assert.doesNotMatch(dialog, /\bMediaRecorder\b|getUserMedia|SpeechRecorderPanel|galaxyBrainService|contentProcessingService/)
  assert.doesNotMatch(dialog, /\bfetch\s*\(|\beval\s*\(|new Function/)
  assert.match(atlas, /result\.effect\.kind !== "open-voice-capture"/)
  assert.match(atlas, /runVoiceCaptureSaga/)
  assert.match(atlas, /\/api\/eln\/object-links/)
  assert.match(atlas, /placeReference\(result\.transcript\.ref, result\.placementOperationId\)/)
  assert.match(atlas, /removeVoiceInputDraftWithWorkspaceFallback\(window\.sessionStorage/)
  assert.match(atlas, /allowWorkspaceFallback: codeDraftAllowsWorkspaceFallback/)
  assert.match(atlas, /No voice command was executed/)
  assert.match(atlas, /const voiceHudCommand = atlasCommands\.find\([\s\S]*command\.id === "voice\.capture\.open" && command\.enabled/)
  assert.match(atlas, /label=\{voiceHudCommand\.title\}[\s\S]*icon=\{<Mic \/>\}[\s\S]*aria-haspopup="dialog"[\s\S]*aria-expanded=\{voiceCaptureOpen\}/)
  assert.match(atlas, /executeSelectedAtlasCommand\(voiceHudCommand\.id, voiceHudTriggerRef\.current\)/)
  assert.doesNotMatch(atlas, /label="Voice note"[\s\S]{0,300}setVoiceCaptureOpen\(true\)/)
  const voicePlugin = plugins.slice(plugins.indexOf('id: "voice"'))
  assert.match(voicePlugin, /agentTools:\s*Object\.freeze\(\[\]\)/)
})

test("speech recognition can start only from the explicit dictation control", async () => {
  const dialog = await readFile(new URL("../components/voice/voice-capture-dialog.tsx", import.meta.url), "utf8")
  assert.match(dialog, /onClick=\{startListening\}/)
  assert.match(dialog, /onClick=\{\(\) => void startRecording\(\)\}/)
  assert.doesNotMatch(dialog, /useEffect\([\s\S]{0,300}\.start\(\)/u)
})
