export type VoiceInputDraftScope = {
  tenantId: string
  principalId: string
  workspaceId: string
  canvasId: string
}
export type VoiceInputDraft = {
  readonly schemaId: "gb.voice-input-draft.v1"
  readonly title: string
  readonly transcript: string
  readonly capturedAt: string
  readonly updatedAt: string
}
export const MAX_VOICE_TRANSCRIPT_BYTES: number
export function normalizeVoiceInputDraft(value: unknown): VoiceInputDraft
export function loadVoiceInputDraft(storage: Pick<Storage, "getItem" | "removeItem">, scope: VoiceInputDraftScope): VoiceInputDraft | null
export function loadVoiceInputDraftWithWorkspaceFallback(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, scope: VoiceInputDraftScope, options?: { allowWorkspaceFallback?: boolean }): VoiceInputDraft | null
export function writeVoiceInputDraft(
  storage: Pick<Storage, "setItem">,
  scope: VoiceInputDraftScope,
  draft: Omit<VoiceInputDraft, "schemaId" | "updatedAt">,
): VoiceInputDraft
export function removeVoiceInputDraft(storage: Pick<Storage, "removeItem">, scope: VoiceInputDraftScope): void
export function removeVoiceInputDraftWithWorkspaceFallback(storage: Pick<Storage, "removeItem">, scope: VoiceInputDraftScope, options?: { allowWorkspaceFallback?: boolean }): void
export function voiceNoteFilename(capturedAt: string): string
