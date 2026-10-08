import { voiceNoteFilename } from "./voice-input-draft.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function transcriptFile(draft) {
  return new File([draft.transcript], voiceNoteFilename(draft.capturedAt), { type: "text/markdown" })
}

export function voiceAudioFilename(capturedAt) {
  const date = new Date(capturedAt)
  if (Number.isNaN(date.getTime())) throw new TypeError("Voice capture timestamp is invalid")
  return `voice-original-${date.toISOString().replace(/[-:.]/gu, "")}.webm`
}

async function sha256Text(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function createVoicePairIdempotencyKey(transcriptRef, audioRef) {
  if (typeof transcriptRef !== "string" || typeof audioRef !== "string" || transcriptRef === audioRef) {
    throw new TypeError("Voice pairing requires two distinct pinned references")
  }
  return `voice-pair:v1:${await sha256Text(JSON.stringify([transcriptRef, audioRef]))}`
}

export async function createVoicePairPayload(transcriptRef, audioRef) {
  return Object.freeze({
    from_ref: transcriptRef,
    to_ref: audioRef,
    relation: "derived_from",
    basis: "authored",
    provenance: Object.freeze({
      source: "manual",
      source_system: "galaxy.voice-capture",
      source_ref: audioRef,
    }),
    idempotency_key: await createVoicePairIdempotencyKey(transcriptRef, audioRef),
  })
}

function documentMetadata(title, file) {
  return Object.freeze({
    title,
    filename: file.name,
    sourceKind: "upload",
    sourceUri: null,
    arxivId: null,
  })
}

export function validateVoicePairReceipt(value, payload) {
  const provenance = value?.provenance
  if (
    !value || typeof value !== "object" || Array.isArray(value)
    || typeof value.id !== "string" || !UUID.test(value.id)
    || value.from_ref !== payload.from_ref
    || value.to_ref !== payload.to_ref
    || value.relation !== payload.relation
    || value.basis !== payload.basis
    || value.version !== 1
    || !provenance || typeof provenance !== "object" || Array.isArray(provenance)
    || Object.keys(provenance).length !== 3
    || provenance.source !== payload.provenance.source
    || provenance.source_system !== payload.provenance.source_system
    || provenance.source_ref !== payload.provenance.source_ref
  ) throw new TypeError("The transcript-audio link confirmation was invalid. Retry safely.")
  return Object.freeze({
    id: value.id,
    version: value.version,
    idempotencyKey: payload.idempotency_key,
    fromRef: value.from_ref,
    toRef: value.to_ref,
  })
}

export async function runVoiceCaptureSaga({ draft, importDocument, createRelation, checkpoint, onPhase }) {
  let current = draft
  if (!current?.blob || !current.title?.trim() || !current.transcript) {
    throw new TypeError("Voice recording, title, and reviewed transcript are required")
  }
  if (!current.checkpoints.audioImport) {
    onPhase?.("importing-audio")
    const audio = new File([current.blob], current.audioFilename, { type: "audio/webm" })
    const confirmation = await importDocument(audio, documentMetadata(`${current.title.trim()} — original audio`, audio))
    current = await checkpoint(current, { audioImport: confirmation })
  }
  if (!current.checkpoints.transcriptImport) {
    onPhase?.("importing-transcript")
    const transcript = transcriptFile(current)
    const confirmation = await importDocument(transcript, documentMetadata(current.title.trim(), transcript))
    current = await checkpoint(current, { transcriptImport: confirmation })
  }
  if (!current.checkpoints.link) {
    onPhase?.("linking")
    const payload = await createVoicePairPayload(
      current.checkpoints.transcriptImport.document.ref,
      current.checkpoints.audioImport.document.ref,
    )
    const receipt = validateVoicePairReceipt(await createRelation(payload), payload)
    current = await checkpoint(current, {
      link: receipt,
    })
  }
  return Object.freeze({
    draft: current,
    transcript: current.checkpoints.transcriptImport.document,
    audio: current.checkpoints.audioImport.document,
    placementOperationId: current.checkpoints.transcriptImport.placementOperationId,
  })
}
