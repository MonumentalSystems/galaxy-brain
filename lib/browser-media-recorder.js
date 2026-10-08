import {
  audioOriginalMediaType,
  MAX_AUDIO_ORIGINAL_BYTES,
} from "./audio-original-contract.js"

export const VOICE_RECORDING_MIME_TYPE = "audio/webm;codecs=opus"

const FAILURE_MESSAGES = Object.freeze({
  unsupported: "This browser cannot record Opus audio. You can still type or dictate a transcript.",
  "permission-denied": "Microphone permission was denied. You can still type or dictate a transcript.",
  "microphone-unavailable": "The microphone is unavailable. Check the device and try again.",
  busy: "A recording is already in progress.",
  disposed: "This recording session is no longer available.",
  "too-large": "The recording reached the 20 MiB limit. Discard it and record a shorter note.",
  invalid: "The browser did not produce a valid WebM Opus recording. Discard it and try again.",
  failed: "The recording could not be completed. Discard it and try again.",
})

function failure(code) {
  return Object.freeze({ code, message: FAILURE_MESSAGES[code], retryable: !["unsupported", "disposed"].includes(code) })
}

export function resolveBrowserMediaRecorder(root = globalThis) {
  const mediaRecorder = root?.MediaRecorder
  const getUserMedia = root?.navigator?.mediaDevices?.getUserMedia
  if (
    typeof mediaRecorder !== "function"
    || typeof mediaRecorder.isTypeSupported !== "function"
    || !mediaRecorder.isTypeSupported(VOICE_RECORDING_MIME_TYPE)
    || typeof getUserMedia !== "function"
  ) return null
  return Object.freeze({ MediaRecorder: mediaRecorder, getUserMedia: getUserMedia.bind(root.navigator.mediaDevices) })
}

function permissionFailure(error) {
  const name = typeof error?.name === "string" ? error.name : ""
  if (name === "NotAllowedError" || name === "SecurityError") return failure("permission-denied")
  if (["NotFoundError", "NotReadableError", "AbortError", "OverconstrainedError"].includes(name)) {
    return failure("microphone-unavailable")
  }
  return failure("failed")
}

function stopTracks(stream) {
  try {
    for (const track of stream?.getTracks?.() ?? []) {
      try { track.stop() } catch {}
    }
  } catch {}
}

export function createBrowserMediaRecorderSession(options = {}) {
  const callbacks = options.callbacks ?? {}
  const resolveCapability = options.resolveCapability ?? (() => resolveBrowserMediaRecorder())
  let state = "idle"
  let disposed = false
  let stream = null
  let recorder = null
  let chunks = []
  let totalBytes = 0
  let tooLarge = false
  let generation = 0

  const setState = (next) => {
    state = next
    if (!disposed) callbacks.onStateChange?.(next)
  }

  const finishFailure = (problem, notify = true) => {
    generation += 1
    stopTracks(stream)
    stream = null
    recorder = null
    chunks = []
    totalBytes = 0
    setState("idle")
    if (notify && !disposed) callbacks.onError?.(problem)
  }

  async function start() {
    if (disposed) return Object.freeze({ ok: false, error: failure("disposed") })
    if (state !== "idle") return Object.freeze({ ok: false, error: failure("busy") })
    const capability = resolveCapability()
    if (!capability) return Object.freeze({ ok: false, error: failure("unsupported") })
    setState("requesting")
    const activeGeneration = ++generation
    try {
      stream = await capability.getUserMedia({ audio: true })
      if (disposed || activeGeneration !== generation) {
        stopTracks(stream)
        stream = null
        return Object.freeze({ ok: false, error: failure("disposed") })
      }
      chunks = []
      totalBytes = 0
      tooLarge = false
      recorder = new capability.MediaRecorder(stream, { mimeType: VOICE_RECORDING_MIME_TYPE })
      recorder.ondataavailable = (event) => {
        if (disposed || activeGeneration !== generation || !event?.data || event.data.size < 1 || tooLarge) return
        totalBytes += event.data.size
        if (totalBytes > MAX_AUDIO_ORIGINAL_BYTES) {
          tooLarge = true
          chunks = []
          try { recorder?.stop() } catch { finishFailure(failure("too-large")) }
          return
        }
        chunks.push(event.data)
      }
      recorder.onerror = () => finishFailure(failure("failed"))
      recorder.onstop = async () => {
        const recordedChunks = chunks
        const exceeded = tooLarge
        stopTracks(stream)
        stream = null
        recorder = null
        chunks = []
        totalBytes = 0
        if (disposed || activeGeneration !== generation) return
        setState("validating")
        if (exceeded) {
          callbacks.onError?.(failure("too-large"))
          setState("idle")
          return
        }
        try {
          const blob = new Blob(recordedChunks, { type: "audio/webm" })
          const bytes = await blob.arrayBuffer()
          audioOriginalMediaType("voice-original.webm", "audio/webm", bytes)
          if (!disposed && activeGeneration === generation) callbacks.onRecording?.(blob)
        } catch {
          if (!disposed && activeGeneration === generation) callbacks.onError?.(failure("invalid"))
        } finally {
          if (!disposed && activeGeneration === generation) setState("idle")
        }
      }
      recorder.start(1000)
      setState("recording")
      return Object.freeze({ ok: true })
    } catch (error) {
      const problem = permissionFailure(error)
      finishFailure(problem, false)
      return Object.freeze({ ok: false, error: problem })
    }
  }

  function stop() {
    if (disposed || state !== "recording" || !recorder) return
    setState("stopping")
    try { recorder.stop() } catch { finishFailure(failure("failed")) }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    generation += 1
    try {
      recorder?.stop()
    } catch {}
    stopTracks(stream)
    stream = null
    recorder = null
    chunks = []
    totalBytes = 0
    state = "idle"
  }

  return Object.freeze({
    isSupported: () => Boolean(resolveCapability()),
    getState: () => state,
    start,
    stop,
    dispose,
  })
}

export { MAX_AUDIO_ORIGINAL_BYTES }
