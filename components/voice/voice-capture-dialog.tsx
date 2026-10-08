"use client"

import { Headphones, Keyboard, Mic, Save, Square, Trash2 } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { focusFirstConnected } from "@/components/atlas/presenter-focus"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { createBrowserSpeechRecognitionSession } from "@/lib/browser-speech-recognition.js"
import {
  createBrowserMediaRecorderSession,
  MAX_AUDIO_ORIGINAL_BYTES,
  type VoiceRecordingState,
} from "@/lib/browser-media-recorder.js"
import {
  createVoiceRecordingDraft,
  createVoiceRecordingDraftStore,
  checkpointVoiceRecordingDraft,
  loadVoiceRecordingDraft,
  removeVoiceRecordingDraft,
  stageVoiceRecordingDraft,
  type VoiceRecordingDraft,
  type VoiceRecordingStore,
} from "@/lib/voice-recording-draft-store.js"
import { voiceAudioFilename } from "@/lib/voice-capture-saga.js"
import {
  loadVoiceInputDraftWithWorkspaceFallback,
  MAX_VOICE_TRANSCRIPT_BYTES,
  removeVoiceInputDraftWithWorkspaceFallback,
  voiceNoteFilename,
  writeVoiceInputDraft,
  type VoiceInputDraftScope,
} from "@/lib/voice-input-draft.js"
import type { DurableDocumentImport } from "@/lib/durable-document-import.js"

type VoiceRecordingUiState = VoiceRecordingState | "staging"
type ExitIntent = "discard" | "close"

export type VoiceSavePhase = "idle" | "importing" | "importing-audio" | "importing-transcript" | "linking" | "placing"

export type VoiceSaveRequest = Readonly<{
  transcriptFile: File
  title: string
  capturedAt: string
  recording: VoiceRecordingDraft | null
  recordingStoreAvailable: boolean
}>

export type VoiceCaptureDialogProps = {
  open: boolean
  phase: VoiceSavePhase
  error: string
  imported: DurableDocumentImport | null
  ambiguous: boolean
  recovery: VoiceRecordingDraft | null
  scope: VoiceInputDraftScope
  allowWorkspaceFallback: boolean
  onOpenChange: (open: boolean) => void
  onSave: (request: VoiceSaveRequest) => void
  onRetryPlacement: () => void
  onAbandon: () => void
  onEdit: () => void
  returnFocus: HTMLElement | null
  fallbackFocus?: HTMLElement | null
}

function appendTranscript(current: string, addition: string) {
  const next = addition.trim()
  if (!next) return current
  if (!current.trim()) return next
  return `${current.trimEnd()} ${next}`
}

function recoveryDescription(recovery: VoiceRecordingDraft | null, imported: DurableDocumentImport | null) {
  if (imported) {
    return "The exact audio, reviewed transcript, and authored link are durable. Atlas placement was requested but is not confirmed; keeping this retry preserves the placement identity."
  }
  if (recovery?.checkpoints.link) {
    return "The exact audio, reviewed transcript, and authored link are durable. No Atlas placement checkpoint is confirmed; keeping this retry preserves the placement identity."
  }
  if (recovery?.checkpoints.transcriptImport) {
    return "The exact audio and reviewed transcript are durable, but their authored link is not confirmed. Keeping this retry preserves the same link identity."
  }
  if (recovery?.checkpoints.audioImport) {
    return "The exact audio original is durable, but no transcript revision is confirmed. Keeping this retry preserves the frozen transcript review."
  }
  return "No durable audio, transcript, link, or placement checkpoint is confirmed. Keeping this draft preserves the same safe retry identity."
}

export function VoiceCaptureDialog({
  open,
  phase,
  error,
  imported,
  ambiguous,
  recovery,
  scope,
  allowWorkspaceFallback,
  onOpenChange,
  onSave,
  onRetryPlacement,
  onAbandon,
  onEdit,
  returnFocus,
  fallbackFocus,
}: VoiceCaptureDialogProps) {
  const [title, setTitle] = useState("Voice field note")
  const [transcript, setTranscript] = useState("")
  const [capturedAt, setCapturedAt] = useState("")
  const [interim, setInterim] = useState("")
  const [listening, setListening] = useState(false)
  const [recognitionError, setRecognitionError] = useState("")
  const [recordingState, setRecordingState] = useState<VoiceRecordingUiState>("idle")
  const [recording, setRecording] = useState<VoiceRecordingDraft | null>(null)
  const [recordingStored, setRecordingStored] = useState(false)
  const [audioUrl, setAudioUrl] = useState("")
  const [recordingError, setRecordingError] = useState("")
  const [recordingStorageWarning, setRecordingStorageWarning] = useState("")
  const [localError, setLocalError] = useState("")
  const [draftStorageWarning, setDraftStorageWarning] = useState("")
  const [discardOpen, setDiscardOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [exitIntent, setExitIntent] = useState<ExitIntent>("discard")
  const hydratedRef = useRef(false)
  const skipDraftWriteRef = useRef(false)
  const recognitionRef = useRef<ReturnType<typeof createBrowserSpeechRecognitionSession> | null>(null)
  const recorderRef = useRef<ReturnType<typeof createBrowserMediaRecorderSession> | null>(null)
  const recordingStoreRef = useRef<VoiceRecordingStore | null>(null)
  const recordingGenerationRef = useRef(0)
  const stagingGenerationRef = useRef<number | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const busy = phase !== "idle"
  const durablePartial = Boolean(recovery && Object.values(recovery.checkpoints).some(Boolean))
  const frozen = busy || Boolean(imported) || ambiguous || durablePartial
  const captureBusy = recordingState !== "idle"
  const volatileAudio = Boolean(recording && !recordingStored && !durablePartial)
  const byteLength = useMemo(() => new TextEncoder().encode(transcript).byteLength, [transcript])
  const filename = useMemo(() => capturedAt ? voiceNoteFilename(capturedAt) : "voice-note.md", [capturedAt])
  useEffect(() => {
    if (!recording) {
      setAudioUrl("")
      return
    }
    const next = URL.createObjectURL(recording.blob)
    setAudioUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [recording])

  const stopListening = useCallback((abort = false) => {
    const session = recognitionRef.current
    if (!session) return
    if (abort) {
      recognitionRef.current = null
      session.dispose()
      setListening(false)
      setInterim("")
      return
    }
    session.stop()
  }, [])

  const invalidateRecording = useCallback((updateUi = true) => {
    recordingGenerationRef.current += 1
    stagingGenerationRef.current = null
    const session = recorderRef.current
    recorderRef.current = null
    session?.dispose()
    if (updateUi) setRecordingState("idle")
  }, [])

  const stopRecording = useCallback((discard = false) => {
    if (discard) {
      invalidateRecording()
      return
    }
    recorderRef.current?.stop()
  }, [invalidateRecording])

  useEffect(() => () => {
    stopListening(true)
    invalidateRecording(false)
  }, [invalidateRecording, stopListening])

  useEffect(() => {
    if (!open) return
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") return
      stopListening(true)
      invalidateRecording()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => document.removeEventListener("visibilitychange", onVisibilityChange)
  }, [invalidateRecording, open, stopListening])

  useEffect(() => {
    if (!open) {
      hydratedRef.current = false
      setDiscardOpen(false)
      stopListening(true)
      invalidateRecording()
      setRecording(null)
      setRecordingStored(false)
      return
    }
    if (hydratedRef.current) return
    hydratedRef.current = true
    skipDraftWriteRef.current = true
    let restored = null
    try {
      restored = loadVoiceInputDraftWithWorkspaceFallback(window.sessionStorage, scope, { allowWorkspaceFallback })
      setDraftStorageWarning("")
    } catch {
      setDraftStorageWarning("Draft recovery is unavailable in this browser context. Keep this dialog open until save and placement finish.")
    }
    setTitle(restored?.title ?? "Voice field note")
    setTranscript(restored?.transcript ?? "")
    setCapturedAt(restored?.capturedAt ?? new Date().toISOString())
    setInterim("")
    setRecognitionError("")
    setLocalError("")
    let cancelled = false
    const loadGeneration = recordingGenerationRef.current
    void (async () => {
      try {
        const store = createVoiceRecordingDraftStore()
        recordingStoreRef.current = store
        const recovered = await loadVoiceRecordingDraft(store, scope, { allowWorkspaceFallback })
        if (cancelled || recordingGenerationRef.current !== loadGeneration) return
        setRecording(recovered)
        setRecordingStored(Boolean(recovered))
        setRecordingStorageWarning("")
        if (recovered && Object.values(recovered.checkpoints).some(Boolean)) {
          setTitle(recovered.title)
          setTranscript(recovered.transcript)
          setCapturedAt(recovered.capturedAt)
        }
      } catch {
        recordingStoreRef.current = null
        if (!cancelled) setRecordingStorageWarning("Audio recovery is unavailable in this browser context. Keep this dialog open until save and placement finish.")
      }
    })()
    return () => { cancelled = true }
  }, [allowWorkspaceFallback, invalidateRecording, open, scope, stopListening])

  useEffect(() => {
    if (!recovery) return
    recordingGenerationRef.current += 1
    setRecording(recovery)
    if (Object.values(recovery.checkpoints).some(Boolean)) {
      setTitle(recovery.title)
      setTranscript(recovery.transcript)
      setCapturedAt(recovery.capturedAt)
    }
  }, [recovery])

  useEffect(() => {
    if (!open || !hydratedRef.current || imported || !capturedAt) return
    if (skipDraftWriteRef.current) {
      skipDraftWriteRef.current = false
      return
    }
    try {
      writeVoiceInputDraft(window.sessionStorage, scope, { title, transcript, capturedAt })
      setDraftStorageWarning("")
    } catch {
      setDraftStorageWarning("Draft recovery is unavailable in this browser context. Keep this dialog open until save and placement finish.")
    }
  }, [capturedAt, imported, open, scope, title, transcript])

  function edit(update: () => void) {
    if (frozen) return
    update()
    setLocalError("")
    onEdit()
  }

  function startListening() {
    if (frozen || listening) return
    setRecognitionError("")
    const session = createBrowserSpeechRecognitionSession({
      language: navigator.language || "en-US",
      callbacks: {
        onStateChange: (state) => setListening(state !== "idle"),
        onTranscript: ({ finalText, interimText }) => {
          if (finalText) edit(() => setTranscript((current) => appendTranscript(current, finalText)))
          setInterim(interimText)
        },
        onError: (failure) => setRecognitionError(failure.message),
        onEnd: () => {
          recognitionRef.current = null
          setInterim("")
        },
      },
    })
    recognitionRef.current = session
    const result = session.start()
    if (!result.ok) {
      session.dispose()
      recognitionRef.current = null
      setListening(false)
      setRecognitionError(result.error.message)
    }
  }

  async function startRecording() {
    if (frozen || recordingState !== "idle" || recording) return
    setRecordingError("")
    const captureGeneration = recordingGenerationRef.current + 1
    recordingGenerationRef.current = captureGeneration
    const session = createBrowserMediaRecorderSession({
      callbacks: {
        onStateChange: (next) => {
          if (recordingGenerationRef.current !== captureGeneration) return
          if (next === "idle" && stagingGenerationRef.current === captureGeneration) return
          setRecordingState(next)
        },
        onError: (failure) => {
          if (recordingGenerationRef.current !== captureGeneration) return
          recorderRef.current = null
          setRecordingError(failure.message)
        },
        onRecording: (blob) => {
          if (recordingGenerationRef.current !== captureGeneration) return
          recorderRef.current = null
          stagingGenerationRef.current = captureGeneration
          setRecordingState("staging")
          void (async () => {
            try {
              const result = await stageVoiceRecordingDraft(recordingStoreRef.current, scope, {
                blob,
                captureId: crypto.randomUUID(),
                capturedAt,
                audioFilename: voiceAudioFilename(capturedAt),
                title,
                transcript,
              }, {
                isCurrent: () => recordingGenerationRef.current === captureGeneration,
              })
              if (result.status === "stale" || recordingGenerationRef.current !== captureGeneration) return
              setRecording(result.draft)
              setRecordingStored(result.stored)
              if (result.stored) {
                setRecordingStorageWarning("")
              } else if (result.storageConflict) {
                setRecordingStorageWarning("A different partially saved voice capture already owns this Atlas recovery slot. This new exact audio exists only in this open dialog; save it now or explicitly discard it before closing.")
              } else {
                setRecordingStorageWarning("The exact audio is only in this open dialog because audio recovery is unavailable. Save it now, or explicitly discard it before closing.")
              }
            } catch {
              if (recordingGenerationRef.current === captureGeneration) {
                setRecordingError("The recording could not be staged safely. Discard it and try again.")
              }
            } finally {
              if (recordingGenerationRef.current === captureGeneration) {
                stagingGenerationRef.current = null
                setRecordingState("idle")
              }
            }
          })()
        },
      },
    })
    recorderRef.current = session
    const result = await session.start()
    if (recordingGenerationRef.current !== captureGeneration) return
    if (!result.ok) {
      recorderRef.current = null
      session.dispose()
      setRecordingState("idle")
      setRecordingError(result.error.message)
    }
  }

  async function removeRecording() {
    if (frozen) return
    const captureId = recording?.captureId
    invalidateRecording()
    setRecording(null)
    setRecordingStored(false)
    setRecordingError("")
    try {
      if (recordingStoreRef.current && captureId) {
        await removeVoiceRecordingDraft(recordingStoreRef.current, scope, { captureId, allowWorkspaceFallback })
      }
    } catch {
      setRecordingStorageWarning("The local audio recovery copy could not be removed. It expires automatically within 24 hours.")
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || listening || captureBusy) return
    if (imported) {
      onRetryPlacement()
      return
    }
    const normalizedTitle = title.trim()
    if (!normalizedTitle || Array.from(normalizedTitle).length > 240 || /[\u0000-\u001f\u007f-\u009f]/u.test(normalizedTitle)) {
      setLocalError("Enter a title between 1 and 240 characters.")
      titleRef.current?.focus()
      return
    }
    if (byteLength < 1 || byteLength > MAX_VOICE_TRANSCRIPT_BYTES) {
      setLocalError("Enter between 1 byte and 256 KB of reviewed transcript text.")
      return
    }
    try {
      writeVoiceInputDraft(window.sessionStorage, scope, {
        title: normalizedTitle,
        transcript,
        capturedAt,
      })
      setDraftStorageWarning("")
    } catch {
      setDraftStorageWarning("Draft recovery is unavailable in this browser context. Keep this dialog open until save and placement finish.")
    }
    let frozenRecording = recording
    if (recording && !durablePartial) {
      try {
        frozenRecording = await createVoiceRecordingDraft(scope, {
          ...recording,
          title: normalizedTitle,
          transcript,
        }, new Date(recording.createdAt))
        if (recordingStoreRef.current && recordingStored) {
          frozenRecording = await checkpointVoiceRecordingDraft(recordingStoreRef.current, scope, frozenRecording, {})
        }
        setRecording(frozenRecording)
      } catch {
        setLocalError("The audio and transcript could not be frozen for a safe retry. Keep this dialog open and try again.")
        return
      }
    }
    onSave({
      transcriptFile: new File([transcript], filename, { type: "text/markdown" }),
      title: normalizedTitle,
      capturedAt,
      recording: recovery ?? frozenRecording,
      recordingStoreAvailable: Boolean(recordingStoreRef.current && recordingStored),
    })
  }

  function abandon() {
    stopListening(true)
    const captureId = (recovery ?? recording)?.captureId
    invalidateRecording()
    try {
      removeVoiceInputDraftWithWorkspaceFallback(window.sessionStorage, scope, { allowWorkspaceFallback })
    } catch {}
    if (recordingStoreRef.current && captureId) {
      void removeVoiceRecordingDraft(recordingStoreRef.current, scope, { captureId, allowWorkspaceFallback }).catch(() => {})
    }
    setRecording(null)
    setRecordingStored(false)
    setDiscardOpen(false)
    onAbandon()
  }

  function discardVolatileAudioAndClose() {
    if (!volatileAudio) return
    invalidateRecording()
    setRecording(null)
    setRecordingStored(false)
    setRecordingStorageWarning("")
    setDiscardOpen(false)
    onOpenChange(false)
  }

  const status = listening
    ? "Listening. Stop before reviewing and saving."
    : recordingState === "requesting"
      ? "Waiting for microphone permission."
      : recordingState === "recording"
        ? "Recording the optional audio original."
        : recordingState === "stopping" || recordingState === "validating" || recordingState === "staging"
          ? recordingState === "staging"
            ? "Staging the validated audio original for recoverable review."
            : "Finishing and validating the audio original."
    : phase === "importing" || phase === "importing-transcript"
      ? "Preserving the reviewed transcript as an immutable document revision."
      : phase === "importing-audio"
        ? "Preserving the exact audio original as an immutable document revision."
        : phase === "linking"
          ? "Linking the reviewed transcript to its exact audio original."
      : phase === "placing"
        ? "The transcript revision is durable. Placing it on this Atlas."
        : ""

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && (busy || captureBusy)) return
        if (!nextOpen && (ambiguous || draftStorageWarning || volatileAudio)) {
          stopListening(true)
          setExitIntent("close")
          setDiscardOpen(true)
          return
        }
        if (!nextOpen) stopListening(true)
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent
        ref={contentRef}
        tabIndex={-1}
        className="atlas-command-presenter research-workbench flex h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-[900px] flex-col overflow-hidden p-0 sm:h-[min(90dvh,760px)]"
        closeDisabled={busy || captureBusy}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          titleRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          if (focusFirstConnected([returnFocus, fallbackFocus], contentRef.current)) event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          if (busy || captureBusy) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (busy || captureBusy) event.preventDefault()
        }}
      >
        <DialogHeader className="atlas-command-presenter__section shrink-0 border-b px-5 py-4 pr-14 text-left">
          <DialogTitle className="research-display flex items-center gap-2 text-2xl">
            <Mic className="h-5 w-5" aria-hidden="true" /> Voice field note
          </DialogTitle>
          <DialogDescription className="atlas-command-presenter__muted">
            Dictation is optional. Review the transcript before saving; speech never dispatches commands or actions.
          </DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-1 flex-col overflow-y-auto" onSubmit={submit}>
          <div className="atlas-command-presenter__surface grid shrink-0 gap-3 border-b p-4">
            <label htmlFor="voice-note-title" className="text-sm font-semibold">Title</label>
            <Input
              ref={titleRef}
              id="voice-note-title"
              value={title}
              maxLength={240}
              disabled={frozen}
              onChange={(event) => edit(() => setTitle(event.target.value))}
            />
            <div className="flex flex-wrap items-center gap-2">
              {listening ? (
                <Button type="button" variant="destructive" className="atlas-command-presenter__danger-action" onClick={() => stopListening(false)}>
                  <Square className="h-4 w-4" aria-hidden="true" /> Stop listening
                </Button>
              ) : (
                <Button type="button" variant="outline" disabled={frozen} onClick={startListening}>
                  <Mic className="h-4 w-4" aria-hidden="true" /> Start dictation
                </Button>
              )}
              <span className="atlas-command-presenter__muted text-xs">Browser dictation may use your browser vendor&apos;s speech service.</span>
            </div>
            <div className="atlas-command-presenter__card rounded-xl border p-3">
              <div className="flex flex-wrap items-center gap-2">
                {recordingState === "recording" ? (
                  <Button type="button" variant="destructive" className="atlas-command-presenter__danger-action" onClick={() => stopRecording(false)}>
                    <Square className="h-4 w-4" aria-hidden="true" /> Stop recording
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={frozen || recordingState !== "idle" || Boolean(recording)}
                    onClick={() => void startRecording()}
                  >
                    <Headphones className="h-4 w-4" aria-hidden="true" /> Record audio original
                  </Button>
                )}
                {recording ? (
                  <Button type="button" variant="ghost" disabled={frozen} onClick={() => void removeRecording()}>
                    <Trash2 className="h-4 w-4" aria-hidden="true" /> Remove audio
                  </Button>
                ) : null}
                <span className="atlas-command-presenter__muted text-xs">
                  Optional WebM/Opus · {(MAX_AUDIO_ORIGINAL_BYTES / 1024 / 1024).toFixed(0)} MiB maximum · permission requested only when Record is pressed
                </span>
              </div>
              {recording && audioUrl ? (
                <div className="mt-3 grid gap-1">
                  <audio controls preload="metadata" src={audioUrl} className="w-full" aria-label="Review recorded audio" />
                  <p className="atlas-command-presenter__muted font-mono text-xs">
                    {recording.audioFilename} · {recording.byteSize.toLocaleString()} bytes
                  </p>
                </div>
              ) : null}
            </div>
          </div>
          {imported ? (
            <div className="atlas-command-presenter__card m-5 rounded-xl border p-4">
              <p className="font-semibold">{imported.title}</p>
              <p className="atlas-command-presenter__muted mt-1 break-all font-mono text-xs">{imported.display_filename}</p>
              <p className="mt-2 text-sm">The immutable transcript is safe. Retry only its Atlas placement.</p>
            </div>
          ) : (
            <div className="flex min-h-[16rem] flex-1 shrink-0 flex-col gap-2 p-4">
              <label htmlFor="voice-note-transcript" className="flex items-center gap-2 text-sm font-semibold">
                <Keyboard className="h-4 w-4" aria-hidden="true" /> Reviewed transcript
              </label>
              <Textarea
                id="voice-note-transcript"
                className="min-h-[12rem] flex-1 resize-none font-serif text-base leading-7"
                value={transcript}
                readOnly={frozen}
                placeholder="Dictate or type the note here. Nothing is saved until you confirm."
                onChange={(event) => edit(() => setTranscript(event.target.value))}
              />
              {interim ? <p className="atlas-command-presenter__muted text-sm italic" aria-live="polite">Hearing: {interim}</p> : null}
              <p className="atlas-command-presenter__muted break-all font-mono text-xs">{filename}</p>
            </div>
          )}
          <div className="atlas-command-presenter__section shrink-0 border-t px-4 py-3 sm:px-5">
            {recognitionError ? <p role="alert" className="atlas-command-presenter__warning mb-2 text-sm">{recognitionError}</p> : null}
            {recordingError ? <p role="alert" className="atlas-command-presenter__warning mb-2 text-sm">{recordingError}</p> : null}
            {localError ? <p role="alert" className="atlas-command-presenter__warning mb-2 text-sm">{localError}</p> : null}
            {draftStorageWarning ? <p role="status" className="atlas-command-presenter__warning mb-2 text-sm">{draftStorageWarning}</p> : null}
            {recordingStorageWarning ? <p role="status" className="atlas-command-presenter__warning mb-2 text-sm">{recordingStorageWarning}</p> : null}
            {error ? <p role="alert" className="atlas-command-presenter__warning mb-2 text-sm">{error}</p> : null}
            <DialogFooter className="gap-3 sm:items-center sm:justify-between">
              <span className="atlas-command-presenter__muted text-xs">
                {byteLength.toLocaleString()} / {MAX_VOICE_TRANSCRIPT_BYTES.toLocaleString()} bytes · {draftStorageWarning ? "in-memory draft; keep this dialog open until placement" : "draft retained in this tab until placement"}
              </span>
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:justify-end">
                <Button className="min-h-11 w-full sm:w-auto" type="button" variant="ghost" disabled={busy || captureBusy} onClick={() => {
                  setExitIntent("discard")
                  setDiscardOpen(true)
                }}>Discard draft</Button>
                <Button
                  className="min-h-11 w-full sm:w-auto"
                  type="button"
                  variant="outline"
                  disabled={busy || captureBusy}
                  onClick={() => {
                    if (ambiguous || draftStorageWarning || volatileAudio) {
                      stopListening(true)
                      setExitIntent("close")
                      setDiscardOpen(true)
                      return
                    }
                    stopListening(true)
                    onOpenChange(false)
                  }}
                >
                  {ambiguous ? "Resolve retry" : draftStorageWarning || volatileAudio ? "Close…" : "Keep draft & close"}
                </Button>
                <Button className="min-h-11 w-full sm:w-auto" type="submit" disabled={busy || listening || captureBusy || (!imported && (byteLength < 1 || byteLength > MAX_VOICE_TRANSCRIPT_BYTES))}>
                  <Save className="h-4 w-4" aria-hidden="true" />
                  {phase === "importing-audio" ? "Saving audio…" : phase === "importing" || phase === "importing-transcript" ? "Saving transcript…" : phase === "linking" ? "Linking…" : phase === "placing" ? "Placing…" : imported ? "Retry placement" : ambiguous ? "Retry safe save" : "Save & place"}
                </Button>
              </div>
            </DialogFooter>
            <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{status}</p>
          </div>
        </form>
        <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
          <AlertDialogContent className="atlas-command-presenter research-workbench max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] overflow-y-auto">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {ambiguous
                  ? "Abandon the safe save retry?"
                  : exitIntent === "close" && volatileAudio
                    ? "Close and discard the in-memory audio?"
                    : draftStorageWarning
                      ? "Discard this in-memory voice draft?"
                      : "Discard this voice draft?"}
              </AlertDialogTitle>
              <AlertDialogDescription className="atlas-command-presenter__muted">
                {ambiguous
                  ? `${recoveryDescription(recovery, imported)}${volatileAudio ? " The exact audio also exists only in this open dialog." : ""}`
                  : exitIntent === "close" && volatileAudio
                    ? draftStorageWarning
                      ? "Neither the exact audio nor transcript draft can be recovered after closing. Keep this dialog open, or explicitly discard both and close. No durable document is deleted."
                      : "The exact audio exists only in this open dialog and will be lost. Keep this dialog open, or explicitly discard the audio and continue later with the retained transcript draft."
                    : draftStorageWarning
                      ? "This browser cannot recover the draft after closing. Keep editing, or explicitly discard the in-memory transcript. No durable document is deleted."
                      : "This removes the transcript draft from this tab. No durable document is deleted."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{exitIntent === "close" ? "Keep dialog open" : "Keep draft"}</AlertDialogCancel>
              <AlertDialogAction
                onClick={exitIntent === "close" && volatileAudio && !draftStorageWarning && !ambiguous ? discardVolatileAudioAndClose : abandon}
                className="atlas-command-presenter__danger-action"
              >
                {ambiguous
                  ? "Abandon retry"
                  : exitIntent === "close" && volatileAudio
                    ? draftStorageWarning ? "Discard both & close" : "Discard audio & close"
                    : "Discard draft"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}
