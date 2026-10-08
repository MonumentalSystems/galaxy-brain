import type { DurableDocumentImport } from "./durable-document-import.js"
import type { VoiceInputDraftScope } from "./voice-input-draft.js"

export type VoiceImportCheckpoint = Readonly<{ document: DurableDocumentImport; placementOperationId: string }>
export type VoiceRelationCheckpoint = Readonly<{ id: string; version: 1; idempotencyKey: string; fromRef: string; toRef: string }>
export type VoiceRecordingDraft = Readonly<{
  schemaId: "gb.voice-recording-draft.v1"
  scopeKey: string
  captureId: string
  capturedAt: string
  createdAt: string
  expiresAt: string
  audioFilename: string
  byteSize: number
  contentSha256: string
  transcriptSha256: string
  blob: Blob
  title: string
  transcript: string
  checkpoints: Readonly<{
    audioImport: VoiceImportCheckpoint | null
    transcriptImport: VoiceImportCheckpoint | null
    link: VoiceRelationCheckpoint | null
  }>
}>
export type VoiceRecordingStore = Readonly<{
  get(key: string): Promise<unknown>
  put(key: string, value: unknown): Promise<unknown>
  delete(key: string): Promise<unknown>
  putIfSafe(key: string, value: VoiceRecordingDraft): Promise<Readonly<{
    status: "stored" | "conflict"
    value: VoiceRecordingDraft
  }>>
  deleteIf(key: string, captureId: string): Promise<boolean>
  migrateIfCurrent(sourceKey: string, targetKey: string, captureId: string, value: VoiceRecordingDraft): Promise<Readonly<{
    status: "source-changed" | "target-exists" | "already-migrated" | "migrated"
    value: VoiceRecordingDraft | null
  }>>
  update(key: string, captureId: string, update: (current: VoiceRecordingDraft) => VoiceRecordingDraft): Promise<VoiceRecordingDraft>
}>
export const VOICE_RECORDING_MAX_AGE_MS: number
export function createVoiceRecordingDraftStore(indexedDb?: IDBFactory): VoiceRecordingStore
export function createVoiceRecordingDraft(scope: VoiceInputDraftScope, input: Partial<VoiceRecordingDraft> & {
  blob: Blob
  captureId: string
  capturedAt: string
  audioFilename: string
}, now?: Date): Promise<VoiceRecordingDraft>
export function writeVoiceRecordingDraft(store: VoiceRecordingStore, scope: VoiceInputDraftScope, draft: Parameters<typeof createVoiceRecordingDraft>[1]): Promise<VoiceRecordingDraft>
export function loadVoiceRecordingDraft(store: VoiceRecordingStore, scope: VoiceInputDraftScope, options?: { allowWorkspaceFallback?: boolean; now?: Date }): Promise<VoiceRecordingDraft | null>
export function removeVoiceRecordingDraft(store: VoiceRecordingStore, scope: VoiceInputDraftScope, options: { captureId: string; allowWorkspaceFallback?: boolean }): Promise<void>
export function stageVoiceRecordingDraft(store: VoiceRecordingStore | null, scope: VoiceInputDraftScope, input: Parameters<typeof createVoiceRecordingDraft>[1], options?: { isCurrent?: () => boolean }): Promise<Readonly<{ status: "stale"; draft: null; stored: false; storageError: false }> | Readonly<{ status: "ready"; draft: VoiceRecordingDraft; stored: boolean; storageError: boolean; storageConflict: boolean }>>
export function checkpointVoiceRecordingDraft(store: VoiceRecordingStore, scope: VoiceInputDraftScope, current: VoiceRecordingDraft, checkpoint: Partial<VoiceRecordingDraft["checkpoints"]>): Promise<VoiceRecordingDraft>
