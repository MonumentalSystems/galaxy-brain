import type { DurableDocumentImport, DurableDocumentImportMetadata } from "./durable-document-import.js"
import type { VoiceRecordingDraft } from "./voice-recording-draft-store.js"

export type VoiceSavePhase = "importing-audio" | "importing-transcript" | "linking"
export type VoicePairPayload = Readonly<{
  from_ref: string
  to_ref: string
  relation: "derived_from"
  basis: "authored"
  provenance: Readonly<{ source: "manual"; source_system: "galaxy.voice-capture"; source_ref: string }>
  idempotency_key: string
}>
export function voiceAudioFilename(capturedAt: string): string
export function createVoicePairIdempotencyKey(transcriptRef: string, audioRef: string): Promise<string>
export function createVoicePairPayload(transcriptRef: string, audioRef: string): Promise<VoicePairPayload>
export function validateVoicePairReceipt(value: unknown, payload: VoicePairPayload): Readonly<{
  id: string
  version: 1
  idempotencyKey: string
  fromRef: string
  toRef: string
}>
export function runVoiceCaptureSaga(input: {
  draft: VoiceRecordingDraft
  importDocument(file: File, metadata: DurableDocumentImportMetadata): Promise<{ document: DurableDocumentImport; placementOperationId: string }>
  createRelation(payload: VoicePairPayload): Promise<unknown>
  checkpoint(current: VoiceRecordingDraft, value: Partial<VoiceRecordingDraft["checkpoints"]>): Promise<VoiceRecordingDraft>
  onPhase?(phase: VoiceSavePhase): void
}): Promise<Readonly<{
  draft: VoiceRecordingDraft
  transcript: DurableDocumentImport
  audio: DurableDocumentImport
  placementOperationId: string
}>>
