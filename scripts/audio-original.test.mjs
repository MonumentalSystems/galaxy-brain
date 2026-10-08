import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  AudioOriginalContractError,
  audioOriginalMediaType,
  createAudioOriginalManifest,
  inspectWebmOpusAudio,
  isAudioOriginalCandidate,
  normalizeAudioOriginalManifest,
} from "../lib/audio-original-contract.js"
import { durableUploadMediaType } from "../lib/durable-document-import.js"
import { webmOpusFixture } from "./audio-original-fixture.mjs"

async function browserRecorderFixtures() {
  const fixtures = JSON.parse(await readFile(
    new URL("./fixtures/browser-mediarecorder-webm.json", import.meta.url),
    "utf8",
  ))
  return fixtures.map((fixture) => ({
    ...fixture,
    bytes: Uint8Array.from(Buffer.from(fixture.base64, "base64")),
  }))
}

function padUnknownCluster(bytes, count) {
  const marker = Uint8Array.from([
    0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  ])
  const offset = Buffer.from(bytes).indexOf(marker)
  assert.notEqual(offset, -1)
  const insertion = offset + marker.byteLength
  const padding = new Uint8Array(count * 2)
  for (let index = 0; index < padding.byteLength; index += 2) {
    padding[index] = 0xec
    padding[index + 1] = 0x80
  }
  return Uint8Array.from([
    ...bytes.subarray(0, insertion),
    ...padding,
    ...bytes.subarray(insertion),
  ])
}

test("strict WebM/Opus admission returns digest-bindable exact metadata", async () => {
  const bytes = webmOpusFixture({ channels: 2 })
  const buffer = bytes.slice().buffer
  assert.deepEqual(inspectWebmOpusAudio(bytes), { trackCount: 1, channels: 2 })
  assert.equal(audioOriginalMediaType("field-note.webm", "audio/webm", buffer), "audio/webm")
  assert.equal(durableUploadMediaType({ name: "field-note.webm", type: "audio/webm" }, buffer), "audio/webm")
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", buffer)).toString("hex")
  const manifest = createAudioOriginalManifest(bytes, digest)
  assert.deepEqual(normalizeAudioOriginalManifest(manifest, {
    mediaType: "audio/webm", byteSize: bytes.byteLength, contentSha256: digest,
  }), manifest)
  assert.equal(isAudioOriginalCandidate("field-note.webm", ""), true)
  assert.equal(isAudioOriginalCandidate("field-note.txt", "audio/webm"), true)
})

test("container, MIME, extension, track, codec, and playable data must all agree", () => {
  const valid = webmOpusFixture()
  assert.throws(() => audioOriginalMediaType("field-note.weba", "audio/webm", valid), AudioOriginalContractError)
  assert.throws(() => audioOriginalMediaType("field-note.webm", "video/webm", valid), AudioOriginalContractError)
  for (const bytes of [
    webmOpusFixture({ trackType: 1 }),
    webmOpusFixture({ codecId: "A_VORBIS" }),
    webmOpusFixture({ duplicateTrack: true }),
    webmOpusFixture({ includeCluster: false }),
    webmOpusFixture({ lacing: true }),
    webmOpusFixture({ docType: "mkv1" }),
    webmOpusFixture({ opusMagic: "NotOpus!" }),
    new Uint8Array([...valid, 0]),
    valid.subarray(0, valid.length - 1),
  ]) {
    assert.throws(() => inspectWebmOpusAudio(bytes), AudioOriginalContractError)
  }
})

test("manifest binding rejects forged size, hash, and media metadata", async () => {
  const bytes = webmOpusFixture()
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")
  const manifest = createAudioOriginalManifest(bytes, digest)
  assert.throws(() => normalizeAudioOriginalManifest(
    { ...manifest, byteSize: manifest.byteSize + 1 }, { byteSize: manifest.byteSize },
  ), /byte size/)
  assert.throws(() => normalizeAudioOriginalManifest(manifest, { contentSha256: "f".repeat(64) }), /content hash/)
  assert.throws(() => normalizeAudioOriginalManifest(manifest, { mediaType: "video/webm" }), /media type/)
})

test("Opus packet framing matches shared RFC 6716 R1-R7 vectors", async () => {
  const vectors = JSON.parse(await readFile(
    new URL("./fixtures/opus-packet-vectors.json", import.meta.url),
    "utf8",
  ))
  for (const vector of vectors) {
    const packet = Uint8Array.from([
      ...vector.prefix,
      ...new Array(vector.fillCount ?? 0).fill(vector.fillByte ?? 0),
    ])
    const fixture = webmOpusFixture({ opusPacket: packet })
    if (vector.valid) {
      assert.deepEqual(inspectWebmOpusAudio(fixture), { trackCount: 1, channels: 1 }, vector.name)
    } else {
      assert.throws(() => inspectWebmOpusAudio(fixture), AudioOriginalContractError, vector.name)
    }
  }
})

test("installed Chrome and Edge MediaRecorder unknown-size clusters remain complete and admissible", async () => {
  for (const fixture of await browserRecorderFixtures()) {
    assert.equal(fixture.bytes.byteLength, fixture.byteSize, fixture.browser)
    assert.deepEqual(inspectWebmOpusAudio(fixture.bytes), { trackCount: 1, channels: 1 }, fixture.browser)
    assert.throws(() => inspectWebmOpusAudio(fixture.bytes.subarray(0, -1)), AudioOriginalContractError, `${fixture.browser} truncated`)
    assert.throws(() => inspectWebmOpusAudio(Uint8Array.from([...fixture.bytes, 0])), AudioOriginalContractError, `${fixture.browser} trailing byte`)
  }
})

test("unknown-size Cluster delimiter shares the bounded element budget", async () => {
  const [fixture] = await browserRecorderFixtures()
  const nearBoundary = padUnknownCluster(fixture.bytes, 50_000)
  assert.deepEqual(inspectWebmOpusAudio(nearBoundary), { trackCount: 1, channels: 1 })
  const padded = padUnknownCluster(fixture.bytes, 100_001)
  assert.throws(() => inspectWebmOpusAudio(padded), /too many elements/u)
})
