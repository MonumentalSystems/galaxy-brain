export interface AudioOriginalManifest {
  readonly schemaId: "gb.audio-original.v1"
  readonly container: "webm"
  readonly codec: "opus"
  readonly mediaType: "audio/webm"
  readonly trackCount: 1
  readonly channels: number
  readonly byteSize: number
  readonly contentSha256: string
}
export const AUDIO_ORIGINAL_SCHEMA_ID: "gb.audio-original.v1"
export const AUDIO_ORIGINAL_MEDIA_TYPE: "audio/webm"
export const MAX_AUDIO_ORIGINAL_BYTES: number
export class AudioOriginalContractError extends Error {}
export function hasWebmSignature(value: ArrayBuffer | Uint8Array): boolean
export function isAudioOriginalCandidate(filename: unknown, declaredMediaType: unknown, value?: ArrayBuffer | Uint8Array): boolean
export function inspectWebmOpusAudio(value: ArrayBuffer | Uint8Array): Readonly<{ trackCount: 1; channels: number }>
export function audioOriginalMediaType(filename: unknown, declaredMediaType: unknown, value: ArrayBuffer | Uint8Array): "audio/webm"
export function createAudioOriginalManifest(value: ArrayBuffer | Uint8Array, contentSha256: string): AudioOriginalManifest
export function normalizeAudioOriginalManifest(value: unknown, binding?: {
  mediaType?: string
  byteSize?: number
  contentSha256?: string
}): AudioOriginalManifest
