import assert from "node:assert/strict"
import test from "node:test"

import {
  createBrowserSpeechRecognitionSession,
  mapSpeechRecognitionError,
  resolveBrowserSpeechRecognition,
} from "../lib/browser-speech-recognition.js"

function fakeRecognitionHarness({ throwOnStart = false, throwOnStop = false, reentrantAbort = false } = {}) {
  const instances = []
  class FakeRecognition {
    constructor() {
      this.continuous = false
      this.interimResults = false
      this.maxAlternatives = 0
      this.lang = ""
      this.onresult = null
      this.onerror = null
      this.onend = null
      this.startCount = 0
      this.stopCount = 0
      this.abortCount = 0
      instances.push(this)
    }
    start() {
      this.startCount += 1
      if (throwOnStart) throw new Error("raw browser detail")
    }
    stop() {
      this.stopCount += 1
      if (throwOnStop) throw new Error("raw stop detail")
    }
    abort() {
      this.abortCount += 1
      if (reentrantAbort) {
        this.onerror?.({ error: "aborted", message: "late browser detail" })
        this.onend?.()
      }
    }
  }
  return { FakeRecognition, instances }
}

function result(text, isFinal) {
  return Object.assign([{ transcript: text }], { isFinal })
}

test("constructor resolution is lazy, SSR-safe, and supports the prefixed browser API", () => {
  class Standard {}
  class Prefixed {}
  assert.equal(resolveBrowserSpeechRecognition(null), null)
  assert.equal(resolveBrowserSpeechRecognition({}), null)
  assert.equal(resolveBrowserSpeechRecognition({ webkitSpeechRecognition: Prefixed }), Prefixed)
  assert.equal(resolveBrowserSpeechRecognition({ SpeechRecognition: Standard, webkitSpeechRecognition: Prefixed }), Standard)
})

test("explicit start configures one browser session and emits bounded state", () => {
  const { FakeRecognition, instances } = fakeRecognitionHarness()
  const states = []
  const session = createBrowserSpeechRecognitionSession({
    language: "en-GB",
    resolveConstructor: () => FakeRecognition,
    callbacks: { onStateChange: (state) => states.push(state) },
  })
  assert.deepEqual(session.start(), { ok: true })
  assert.equal(instances.length, 1)
  assert.equal(instances[0].startCount, 1)
  assert.equal(instances[0].continuous, true)
  assert.equal(instances[0].interimResults, true)
  assert.equal(instances[0].maxAlternatives, 1)
  assert.equal(instances[0].lang, "en-GB")
  assert.deepEqual(states, ["starting", "listening"])
  assert.deepEqual(session.start(), {
    ok: false,
    error: { code: "busy", message: "Dictation is already active.", retryable: true },
  })
})

test("a reentrant dispose during starting prevents browser activation", () => {
  const { FakeRecognition, instances } = fakeRecognitionHarness({ reentrantAbort: true })
  let session
  session = createBrowserSpeechRecognitionSession({
    resolveConstructor: () => FakeRecognition,
    callbacks: {
      onStateChange: (state) => {
        if (state === "starting") session.dispose()
      },
    },
  })
  assert.deepEqual(session.start(), {
    ok: false,
    error: { code: "disposed", message: "This dictation session has closed.", retryable: false },
  })
  assert.equal(instances[0].startCount, 0)
  assert.equal(instances[0].abortCount, 1)
  assert.equal(instances[0].onresult, null)
  assert.equal(instances[0].onerror, null)
  assert.equal(instances[0].onend, null)
})

test("mixed recognition results emit only final and interim transcript deltas", () => {
  const { FakeRecognition, instances } = fakeRecognitionHarness()
  const deltas = []
  const session = createBrowserSpeechRecognitionSession({
    resolveConstructor: () => FakeRecognition,
    callbacks: { onTranscript: (delta) => deltas.push(delta) },
  })
  session.start()
  instances[0].onresult({
    resultIndex: 0,
    results: [result("alpha", true), result("beta", false), result("gamma", true)],
  })
  assert.deepEqual(deltas, [{ finalText: "alpha gamma", interimText: "beta" }])
})

test("natural end never restarts, while a later explicit start creates a fresh instance", () => {
  const { FakeRecognition, instances } = fakeRecognitionHarness()
  const ends = []
  const session = createBrowserSpeechRecognitionSession({
    resolveConstructor: () => FakeRecognition,
    callbacks: { onEnd: (reason) => ends.push(reason) },
  })
  session.start()
  instances[0].onend()
  assert.equal(instances[0].startCount, 1)
  assert.deepEqual(ends, ["ended"])
  assert.deepEqual(session.start(), { ok: true })
  assert.equal(instances.length, 2)
})

test("stop is idempotent and an aborted stop is not surfaced as an error", () => {
  const { FakeRecognition, instances } = fakeRecognitionHarness()
  const errors = []
  const ends = []
  const session = createBrowserSpeechRecognitionSession({
    resolveConstructor: () => FakeRecognition,
    callbacks: { onError: (error) => errors.push(error), onEnd: (reason) => ends.push(reason) },
  })
  session.start()
  session.stop()
  session.stop()
  assert.equal(instances[0].stopCount, 1)
  instances[0].onerror({ error: "aborted", message: "secret browser detail" })
  assert.deepEqual(errors, [])
  assert.deepEqual(ends, ["stopped"])
  assert.equal(instances[0].abortCount, 0)
})

test("browser failures map to fixed copy and never expose raw detail", () => {
  const cases = [
    ["not-allowed", "permission-denied"],
    ["audio-capture", "microphone-unavailable"],
    ["service-not-allowed", "service-unavailable"],
    ["network", "network"],
    ["no-speech", "no-speech"],
    ["language-not-supported", "language-not-supported"],
    ["aborted", "aborted"],
    ["raw-secret-value", "could-not-start"],
  ]
  for (const [raw, code] of cases) {
    const mapped = mapSpeechRecognitionError({ error: raw, message: "database password" })
    assert.equal(mapped.code, code)
    assert.doesNotMatch(mapped.message, /database password|raw-secret-value/u)
    assert.ok(mapped.message.length < 180)
  }
  assert.equal(mapSpeechRecognitionError("aborted", true), null)
})

test("synchronous start failure resets idle with bounded diagnostics", () => {
  const { FakeRecognition, instances } = fakeRecognitionHarness({ throwOnStart: true })
  const errors = []
  const session = createBrowserSpeechRecognitionSession({
    resolveConstructor: () => FakeRecognition,
    callbacks: { onError: (error) => errors.push(error) },
  })
  const response = session.start()
  assert.equal(response.ok, false)
  assert.equal(response.error.code, "could-not-start")
  assert.equal(session.getState(), "idle")
  assert.equal(instances[0].abortCount, 1)
  assert.equal(errors[0].code, "could-not-start")
})

test("abort error paths detach before a browser can re-enter callbacks", () => {
  const { FakeRecognition, instances } = fakeRecognitionHarness({ reentrantAbort: true })
  const events = []
  const session = createBrowserSpeechRecognitionSession({
    resolveConstructor: () => FakeRecognition,
    callbacks: {
      onError: (error) => events.push(`error:${error.code}`),
      onEnd: (reason) => events.push(`end:${reason}`),
    },
  })
  session.start()
  instances[0].onerror({ error: "network", message: "secret" })
  assert.deepEqual(events, ["error:network", "end:error"])
  assert.equal(instances[0].abortCount, 1)
  assert.equal(session.getState(), "idle")
})

test("a synchronous stop failure cannot double-settle through abort callbacks", () => {
  const { FakeRecognition, instances } = fakeRecognitionHarness({ throwOnStop: true, reentrantAbort: true })
  const events = []
  const session = createBrowserSpeechRecognitionSession({
    resolveConstructor: () => FakeRecognition,
    callbacks: {
      onError: (error) => events.push(`error:${error.code}`),
      onEnd: (reason) => events.push(`end:${reason}`),
    },
  })
  session.start()
  session.stop()
  assert.deepEqual(events, ["error:could-not-start", "end:error"])
  assert.equal(instances[0].abortCount, 1)
  assert.equal(session.getState(), "idle")
})

test("dispose detaches and aborts once while suppressing stale callbacks", () => {
  const { FakeRecognition, instances } = fakeRecognitionHarness()
  const events = []
  const session = createBrowserSpeechRecognitionSession({
    resolveConstructor: () => FakeRecognition,
    callbacks: {
      onTranscript: () => events.push("transcript"),
      onError: () => events.push("error"),
      onEnd: () => events.push("end"),
    },
  })
  session.start()
  const staleResult = instances[0].onresult
  const staleError = instances[0].onerror
  const staleEnd = instances[0].onend
  session.dispose()
  session.dispose()
  assert.equal(instances[0].abortCount, 1)
  assert.equal(instances[0].onresult, null)
  assert.equal(instances[0].onerror, null)
  assert.equal(instances[0].onend, null)
  staleResult({ resultIndex: 0, results: [result("late", true)] })
  staleError({ error: "network" })
  staleEnd()
  assert.deepEqual(events, [])
  assert.equal(session.start().error.code, "disposed")
})
