const FAILURES = Object.freeze({
  unsupported: Object.freeze({ code: "unsupported", message: "This browser does not offer speech recognition. Type the note instead.", retryable: false }),
  busy: Object.freeze({ code: "busy", message: "Dictation is already active.", retryable: true }),
  disposed: Object.freeze({ code: "disposed", message: "This dictation session has closed.", retryable: false }),
  "permission-denied": Object.freeze({ code: "permission-denied", message: "Microphone dictation is unavailable. Check browser permission, or type the note instead.", retryable: true }),
  "microphone-unavailable": Object.freeze({ code: "microphone-unavailable", message: "No microphone is available. Connect one, or type the note instead.", retryable: true }),
  "service-unavailable": Object.freeze({ code: "service-unavailable", message: "The browser speech service is unavailable. Type the note or try again later.", retryable: true }),
  network: Object.freeze({ code: "network", message: "The browser speech service could not be reached. Your draft is safe; type or try again later.", retryable: true }),
  "no-speech": Object.freeze({ code: "no-speech", message: "No speech was recognized. Try again, or type the note instead.", retryable: true }),
  "language-not-supported": Object.freeze({ code: "language-not-supported", message: "This browser does not support dictation in the selected language. Type the note instead.", retryable: false }),
  aborted: Object.freeze({ code: "aborted", message: "Dictation stopped unexpectedly. Your draft is safe; type or try again.", retryable: true }),
  "could-not-start": Object.freeze({ code: "could-not-start", message: "Dictation could not start. Type the note or try again.", retryable: true }),
})

function failure(code) {
  return FAILURES[code]
}

export function resolveBrowserSpeechRecognition(root = globalThis) {
  if (!root || (typeof root !== "object" && typeof root !== "function")) return null
  const Constructor = root.SpeechRecognition || root.webkitSpeechRecognition
  return typeof Constructor === "function" ? Constructor : null
}

export function mapSpeechRecognitionError(raw, stopRequested = false) {
  const value = typeof raw === "string"
    ? raw
    : raw && typeof raw === "object" && typeof raw.error === "string"
      ? raw.error
      : ""
  if ((value === "aborted" || value === "AbortError") && stopRequested) return null
  if (value === "not-allowed" || value === "SecurityError") return failure("permission-denied")
  if (value === "audio-capture") return failure("microphone-unavailable")
  if (value === "service-not-allowed" || value === "bad-grammar") return failure("service-unavailable")
  if (value === "network") return failure("network")
  if (value === "no-speech") return failure("no-speech")
  if (value === "language-not-supported") return failure("language-not-supported")
  if (value === "aborted" || value === "AbortError") return failure("aborted")
  return failure("could-not-start")
}

function append(current, value) {
  const next = typeof value === "string" ? value.trim() : ""
  if (!next) return current
  return current ? `${current} ${next}` : next
}

export function createBrowserSpeechRecognitionSession({
  language = "en-US",
  callbacks = {},
  resolveConstructor = () => resolveBrowserSpeechRecognition(),
} = {}) {
  let state = "idle"
  let active = null
  let generation = 0
  let disposed = false
  let stopRequested = false

  const emitState = (next) => {
    state = next
    callbacks.onStateChange?.(next)
  }

  const detach = (recognition) => {
    if (!recognition) return
    recognition.onresult = null
    recognition.onerror = null
    recognition.onend = null
  }

  const settle = (recognition, token, reason, mappedError = null) => {
    if (disposed || active !== recognition || token !== generation) return
    detach(recognition)
    active = null
    generation += 1
    emitState("idle")
    if (mappedError) callbacks.onError?.(mappedError)
    callbacks.onEnd?.(reason)
  }

  const start = () => {
    if (disposed) return Object.freeze({ ok: false, error: failure("disposed") })
    if (state !== "idle" || active) return Object.freeze({ ok: false, error: failure("busy") })
    const Constructor = resolveConstructor()
    if (!Constructor) return Object.freeze({ ok: false, error: failure("unsupported") })

    let recognition
    try {
      recognition = new Constructor()
    } catch {
      return Object.freeze({ ok: false, error: failure("could-not-start") })
    }
    const token = generation + 1
    generation = token
    active = recognition
    stopRequested = false
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    recognition.lang = language
    recognition.onresult = (event) => {
      if (disposed || active !== recognition || token !== generation) return
      let finalText = ""
      let interimText = ""
      const startIndex = Number.isSafeInteger(event?.resultIndex) ? event.resultIndex : 0
      const length = Number.isSafeInteger(event?.results?.length) ? event.results.length : 0
      for (let index = startIndex; index < length; index += 1) {
        const result = event.results[index]
        const text = result?.[0]?.transcript
        if (result?.isFinal) finalText = append(finalText, text)
        else interimText = append(interimText, text)
      }
      callbacks.onTranscript?.(Object.freeze({ finalText, interimText }))
    }
    recognition.onerror = (event) => {
      if (disposed || active !== recognition || token !== generation) return
      const mapped = mapSpeechRecognitionError(event, stopRequested)
      const reason = stopRequested && !mapped ? "stopped" : "error"
      if (mapped) {
        detach(recognition)
        try { recognition.abort() } catch {}
      }
      settle(recognition, token, reason, mapped)
    }
    recognition.onend = () => {
      settle(recognition, token, stopRequested ? "stopped" : "ended")
    }
    emitState("starting")
    if (disposed || active !== recognition || token !== generation) {
      return Object.freeze({ ok: false, error: failure(disposed ? "disposed" : "could-not-start") })
    }
    try {
      recognition.start()
      if (active === recognition && token === generation) emitState("listening")
      return Object.freeze({ ok: true })
    } catch {
      detach(recognition)
      try { recognition.abort() } catch {}
      settle(recognition, token, "error", failure("could-not-start"))
      return Object.freeze({ ok: false, error: failure("could-not-start") })
    }
  }

  const stop = () => {
    if (disposed || !active || state === "stopping") return
    stopRequested = true
    emitState("stopping")
    try {
      active.stop()
    } catch {
      const recognition = active
      const token = generation
      detach(recognition)
      try { recognition.abort() } catch {}
      settle(recognition, token, "error", failure("could-not-start"))
    }
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    generation += 1
    const recognition = active
    active = null
    detach(recognition)
    try { recognition?.abort() } catch {}
    state = "idle"
  }

  return Object.freeze({
    isSupported: () => !disposed && Boolean(resolveConstructor()),
    getState: () => state,
    start,
    stop,
    dispose,
  })
}
