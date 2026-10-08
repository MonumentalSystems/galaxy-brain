import assert from "node:assert/strict"
import test from "node:test"

import {
  createVoicePairPayload,
  runVoiceCaptureSaga,
} from "../lib/voice-capture-saga.js"
import {
  createVoiceRecordingDraft,
  stageVoiceRecordingDraft,
} from "../lib/voice-recording-draft-store.js"
import { webmOpusFixture } from "./audio-original-fixture.mjs"

const scope = { tenantId: "tenant", principalId: "person", workspaceId: "workspace", canvasId: "canvas" }
const AUDIO_OPERATION = "10000000-0000-4000-8000-000000000001"
const TRANSCRIPT_OPERATION = "10000000-0000-4000-8000-000000000002"

function imported(kind, hash, operationId) {
  const id = kind === "audio" ? "audio-id" : "transcript-id"
  return {
    document: {
      schemaId: "gb.document.import.v1", persisted: true,
      ref: `gb:object:v1:document:${id}:pinned:sha256:${hash}`,
      document_id: id, revision_id: `${id}-revision`, artifact_id: `${id}-artifact`, source_id: `${id}-source`,
      title: kind, display_filename: `${kind}.${kind === "audio" ? "webm" : "md"}`, version: 1,
      content_sha256: hash, revision_sha256: "c".repeat(64), byte_size: 100,
      media_type: kind === "audio" ? "audio/webm" : "text/markdown", source_kind: "upload",
      original_filename: `${kind}.${kind === "audio" ? "webm" : "md"}`, source_uri: null,
      ingestion_plan: null,
      replayed: false, deduplicatedArtifact: false,
    },
    placementOperationId: operationId,
  }
}

async function staged() {
  return createVoiceRecordingDraft(scope, {
    blob: new Blob([webmOpusFixture()], { type: "audio/webm" }), captureId: "capture-1",
    capturedAt: "2026-09-26T12:00:00.000Z", audioFilename: "voice-original.webm",
    title: "Reviewed note", transcript: "Reviewed transcript.",
  })
}

test("audio, transcript, strict authored relation, then transcript placement receipt are ordered", async () => {
  let current = await staged()
  const calls = []
  const imports = [
    imported("audio", current.contentSha256, AUDIO_OPERATION),
    imported("transcript", current.transcriptSha256, TRANSCRIPT_OPERATION),
  ]
  const result = await runVoiceCaptureSaga({
    draft: current,
    importDocument: async (file) => { calls.push(`import:${file.type}`); return imports.shift() },
    createRelation: async (payload) => {
      calls.push("link")
      assert.deepEqual(payload, await createVoicePairPayload(
        current.checkpoints.transcriptImport.document.ref,
        current.checkpoints.audioImport.document.ref,
      ))
      return {
        id: "20000000-0000-4000-8000-000000000001", version: 1,
        from_ref: payload.from_ref, to_ref: payload.to_ref, relation: "derived_from", basis: "authored",
        provenance: payload.provenance,
      }
    },
    checkpoint: async (_prior, patch) => {
      current = { ...current, checkpoints: { ...current.checkpoints, ...patch } }
      return current
    },
  })
  assert.deepEqual(calls, ["import:audio/webm", "import:text/markdown", "link"])
  assert.equal(result.transcript.ref, current.checkpoints.transcriptImport.document.ref)
  assert.equal(result.placementOperationId, TRANSCRIPT_OPERATION)
})

test("retry skips acknowledged steps and rejects a malformed link acknowledgement", async () => {
  let current = await staged()
  current = {
    ...current,
    checkpoints: { ...current.checkpoints, audioImport: imported("audio", current.contentSha256, AUDIO_OPERATION) },
  }
  let importCount = 0
  await assert.rejects(runVoiceCaptureSaga({
    draft: current,
    importDocument: async () => { importCount += 1; return imported("transcript", current.transcriptSha256, TRANSCRIPT_OPERATION) },
    createRelation: async () => ({ version: 1 }),
    checkpoint: async (_prior, patch) => {
      current = { ...current, checkpoints: { ...current.checkpoints, ...patch } }
      return current
    },
  }), /confirmation was invalid/u)
  assert.equal(importCount, 1)
})

test("failed local staging continues through the in-memory save saga", async () => {
  const stagedResult = await stageVoiceRecordingDraft({
    putIfSafe: async () => { throw new Error("blocked") },
  }, scope, {
    blob: new Blob([webmOpusFixture()], { type: "audio/webm" }),
    captureId: "volatile-capture",
    capturedAt: "2026-09-26T12:00:00.000Z",
    audioFilename: "voice-original.webm",
    title: "Reviewed note",
    transcript: "Reviewed transcript.",
  })
  assert.equal(stagedResult.stored, false)
  assert.equal(stagedResult.storageError, true)
  assert.equal(stagedResult.storageConflict, false)
  let current = stagedResult.draft
  const imports = [
    imported("audio", current.contentSha256, AUDIO_OPERATION),
    imported("transcript", current.transcriptSha256, TRANSCRIPT_OPERATION),
  ]
  const result = await runVoiceCaptureSaga({
    draft: current,
    importDocument: async () => imports.shift(),
    createRelation: async (payload) => ({
      id: "20000000-0000-4000-8000-000000000002", version: 1,
      from_ref: payload.from_ref, to_ref: payload.to_ref,
      relation: payload.relation, basis: payload.basis, provenance: payload.provenance,
    }),
    checkpoint: async (_prior, patch) => {
      current = { ...current, checkpoints: { ...current.checkpoints, ...patch } }
      return current
    },
  })
  assert.equal(result.draft.checkpoints.link.version, 1)
  assert.equal(result.transcript.ref, current.checkpoints.transcriptImport.document.ref)
})
