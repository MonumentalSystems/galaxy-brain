export type SpeechRecognitionState = "idle" | "starting" | "listening" | "stopping"
export type SpeechRecognitionEndReason = "ended" | "stopped" | "error"
export type SpeechRecognitionFailureCode =
  | "unsupported" | "busy" | "disposed" | "permission-denied"
  | "microphone-unavailable" | "service-unavailable" | "network" | "no-speech"
  | "language-not-supported" | "aborted" | "could-not-start"
export type SpeechRecognitionFailure = Readonly<{
  code: SpeechRecognitionFailureCode
  message: string
  retryable: boolean
}>
export type SpeechRecognitionTranscriptDelta = Readonly<{ finalText: string; interimText: string }>
export type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  lang: string
  onresult: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike
export function resolveBrowserSpeechRecognition(root?: unknown): SpeechRecognitionConstructor | null
export function mapSpeechRecognitionError(raw: unknown, stopRequested?: boolean): SpeechRecognitionFailure | null
export function createBrowserSpeechRecognitionSession(options?: {
  language?: string
  callbacks?: {
    onStateChange?(state: SpeechRecognitionState): void
    onTranscript?(delta: SpeechRecognitionTranscriptDelta): void
    onError?(failure: SpeechRecognitionFailure): void
    onEnd?(reason: SpeechRecognitionEndReason): void
  }
  resolveConstructor?: () => SpeechRecognitionConstructor | null
}): Readonly<{
  isSupported(): boolean
  getState(): SpeechRecognitionState
  start(): Readonly<{ ok: true }> | Readonly<{ ok: false; error: SpeechRecognitionFailure }>
  stop(): void
  dispose(): void
}>
