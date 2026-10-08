import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  createBrowserMediaRecorderSession,
  VOICE_RECORDING_MIME_TYPE,
} from "../lib/browser-media-recorder.js"
import { webmOpusFixture } from "./audio-original-fixture.mjs"

function deferred() {
  let resolve
  const promise = new Promise((accept) => { resolve = accept })
  return { promise, resolve }
}

function harness({ permission, recording = webmOpusFixture() } = {}) {
  const track = { stopped: 0, stop() { this.stopped += 1 } }
  const stream = { getTracks: () => [track] }
  const asked = []
  class Recorder {
    static isTypeSupported(type) { return type === VOICE_RECORDING_MIME_TYPE }
    constructor(received, options) {
      assert.equal(received, stream)
      assert.equal(options.mimeType, VOICE_RECORDING_MIME_TYPE)
      harness.recorder = this
    }
    start(timeslice) { assert.equal(timeslice, 1000) }
    stop() {
      this.ondataavailable?.({ data: new Blob([recording], { type: "audio/webm" }) })
      this.onstop?.()
    }
  }
  const capability = {
    MediaRecorder: Recorder,
    getUserMedia: async (constraints) => {
      asked.push(constraints)
      return permission ? permission.promise : stream
    },
  }
  return { track, stream, asked, capability }
}

test("microphone permission is requested only by explicit start and exact Opus output is validated", async () => {
  const environment = harness()
  const recordings = []
  const session = createBrowserMediaRecorderSession({
    resolveCapability: () => environment.capability,
    callbacks: { onRecording: (blob) => recordings.push(blob) },
  })
  assert.deepEqual(environment.asked, [])
  assert.deepEqual(await session.start(), { ok: true })
  assert.deepEqual(environment.asked, [{ audio: true }])
  session.stop()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(recordings.length, 1)
  assert.equal(recordings[0].type, "audio/webm")
  assert.equal(environment.track.stopped, 1)
})

test("the recorder callback accepts exact installed Chrome and Edge MediaRecorder bytes", async () => {
  const fixtures = JSON.parse(await readFile(
    new URL("./fixtures/browser-mediarecorder-webm.json", import.meta.url),
    "utf8",
  ))
  for (const fixture of fixtures) {
    const recording = Uint8Array.from(Buffer.from(fixture.base64, "base64"))
    const environment = harness({ recording })
    const recordings = []
    const session = createBrowserMediaRecorderSession({
      resolveCapability: () => environment.capability,
      callbacks: { onRecording: (blob) => recordings.push(blob) },
    })
    assert.deepEqual(await session.start(), { ok: true }, fixture.browser)
    session.stop()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(recordings.length, 1, fixture.browser)
    assert.equal(recordings[0].size, fixture.byteSize, fixture.browser)
  }
})

test("disposing while permission is pending stops the late stream and cannot start hidden recording", async () => {
  const permission = deferred()
  const environment = harness({ permission })
  const session = createBrowserMediaRecorderSession({ resolveCapability: () => environment.capability })
  const start = session.start()
  session.dispose()
  permission.resolve(environment.stream)
  const result = await start
  assert.equal(result.ok, false)
  assert.equal(result.error.code, "disposed")
  assert.equal(environment.track.stopped, 1)
})

test("permission errors expose fixed safe copy and never raw device details", async () => {
  const capability = {
    MediaRecorder: class {},
    getUserMedia: async () => { throw Object.assign(new Error("private device path"), { name: "NotAllowedError" }) },
  }
  const session = createBrowserMediaRecorderSession({ resolveCapability: () => capability })
  const result = await session.start()
  assert.equal(result.ok, false)
  assert.equal(result.error.code, "permission-denied")
  assert.doesNotMatch(result.error.message, /private|path/u)
})
