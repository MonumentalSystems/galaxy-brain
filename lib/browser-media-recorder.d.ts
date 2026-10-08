export const VOICE_RECORDING_MIME_TYPE: "audio/webm;codecs=opus"
export const MAX_AUDIO_ORIGINAL_BYTES: number
export type VoiceRecordingState = "idle" | "requesting" | "recording" | "stopping" | "validating"
export type VoiceRecordingFailure = Readonly<{
  code: "unsupported" | "permission-denied" | "microphone-unavailable" | "busy" | "disposed" | "too-large" | "invalid" | "failed"
  message: string
  retryable: boolean
}>
export function resolveBrowserMediaRecorder(root?: unknown): null | Readonly<{
  MediaRecorder: typeof MediaRecorder
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
}>
export function createBrowserMediaRecorderSession(options?: {
  callbacks?: {
    onStateChange?(state: VoiceRecordingState): void
    onRecording?(blob: Blob): void
    onError?(failure: VoiceRecordingFailure): void
  }
  resolveCapability?: () => null | Readonly<{
    MediaRecorder: typeof MediaRecorder
    getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
  }>
}): Readonly<{
  isSupported(): boolean
  getState(): VoiceRecordingState
  start(): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error: VoiceRecordingFailure }>>
  stop(): void
  dispose(): void
}>
