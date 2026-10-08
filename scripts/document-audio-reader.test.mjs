import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { createAudioOriginalManifest } from "../lib/audio-original-contract.js"
import {
  ExactAudioDocumentError,
  exactAudioDocumentDescriptor,
  exactAudioProjectionDescriptor,
  loadExactAudioObjectUrl,
} from "../lib/document-audio-reader.js"
import { webmOpusFixture } from "./audio-original-fixture.mjs"

const documentId = "10000000-0000-4000-8000-000000000001"
const revisionId = "20000000-0000-4000-8000-000000000001"
const artifactId = "30000000-0000-4000-8000-000000000001"
const representationId = "40000000-0000-4000-8000-000000000001"
const revisionHash = "b".repeat(64)

async function fixture() {
  const bytes = webmOpusFixture()
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")
  const audioOriginal = createAudioOriginalManifest(bytes, digest)
  const ref = `gb:object:v1:document:${documentId}:pinned:sha256%3A${revisionHash}`
  const revision = {
    schemaId: "gb.document-revision.v1",
    document_id: documentId,
    ref,
    revision_id: revisionId,
    version: 1,
    revision_sha256: revisionHash,
    title: "Field recording",
    display_filename: "Field recording [0123456789ab].webm",
    created_at: "2026-09-26T00:00:00Z",
    artifact: { id: artifactId, content_sha256: digest, byte_size: bytes.length, media_type: "audio/webm" },
    source: { id: "50000000-0000-4000-8000-000000000001", kind: "upload", uri: null, original_filename: "capture.webm" },
    audio_original: audioOriginal,
    representations: [{
      id: representationId,
      kind: "original",
      media_type: "audio/webm",
      content_sha256: digest,
      content_path: `/documents/${revisionId}/representations/${representationId}/content`,
      created_at: "2026-09-26T00:00:00Z",
    }],
  }
  return { bytes, digest, audioOriginal, ref, revision }
}

test("detail and projection descriptors bind exact revision, original, manifest, and reader URL", async () => {
  const { digest, audioOriginal, ref, revision } = await fixture()
  const detail = exactAudioDocumentDescriptor(revision, revisionId)
  assert.equal(detail.contentSha256, digest)
  assert.match(detail.contentUrl, new RegExp(`${revisionId}/representations/${representationId}/content`))
  const projection = exactAudioProjectionDescriptor({
    schemaId: "gb.object-projection.v1",
    ref,
    kind: "document",
    revision: { policy: "pinned", id: `sha256:${revisionHash}`, contentHash: revisionHash },
    title: "Field recording",
    mediaType: "audio/webm",
    audioOriginal,
    representations: [{
      ref: `gb:representation:document:${documentId}:${representationId}`,
      kind: "original", mediaType: "audio/webm", contentHash: digest,
    }],
    provenance: { provider: "galaxy.document" }, capabilities: ["open"],
  }, revisionId)
  assert.equal(projection.contentSha256, digest)
  assert.throws(() => exactAudioDocumentDescriptor({ ...revision, revision_id: documentId }, revisionId), /stale/)
  assert.throws(() => exactAudioDocumentDescriptor({ ...revision, audio_original: { ...audioOriginal, channels: 3 } }, revisionId), /manifest/)
})

test("reader hashes a bounded exact 200 response before creating one revocable Blob URL", async () => {
  const { bytes, revision } = await fixture()
  const descriptor = exactAudioDocumentDescriptor(revision, revisionId)
  let created = 0
  let revoked = 0
  const loaded = await loadExactAudioObjectUrl(descriptor, {
    origin: "https://galaxy.invalid",
    fetcher: async () => new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": "audio/webm",
        "Content-Length": String(bytes.length),
        "X-Content-SHA256": descriptor.contentSha256,
        ETag: `"sha256-${descriptor.contentSha256}"`,
      },
    }),
    createObjectURL(blob) {
      created += 1
      assert.equal(blob.type, "audio/webm")
      assert.equal(blob.size, bytes.length)
      return "blob:verified-audio"
    },
    revokeObjectURL(url) {
      assert.equal(url, "blob:verified-audio")
      revoked += 1
    },
  })
  assert.equal(created, 1)
  loaded.revoke()
  loaded.revoke()
  assert.equal(revoked, 1)
})

test("reader rejects partial, redirected, mismatched, missing, and corrupted responses before Blob creation", async () => {
  const { bytes, revision } = await fixture()
  const descriptor = exactAudioDocumentDescriptor(revision, revisionId)
  let created = 0
  const common = {
    origin: "https://galaxy.invalid",
    createObjectURL() { created += 1; return "blob:no" },
    revokeObjectURL() {},
  }
  const response = (body, headers = {}, status = 200) => new Response(body, {
    status,
    headers: {
      "Content-Type": "audio/webm",
      "X-Content-SHA256": descriptor.contentSha256,
      ETag: `"sha256-${descriptor.contentSha256}"`,
      ...headers,
    },
  })
  for (const fetcher of [
    async () => response(bytes, {}, 206),
    async () => response(bytes, { "Content-Type": "video/webm" }),
    async () => response(bytes, { "X-Content-SHA256": "f".repeat(64) }),
    async () => response(bytes.subarray(0, bytes.length - 1)),
    async () => response(new Uint8Array(bytes.length)),
    async () => response(null),
  ]) {
    await assert.rejects(loadExactAudioObjectUrl(descriptor, { ...common, fetcher }), ExactAudioDocumentError)
  }
  assert.equal(created, 0)
})

test("reader aborts during verification without creating a Blob URL", async () => {
  const { bytes, revision } = await fixture()
  const descriptor = exactAudioDocumentDescriptor(revision, revisionId)
  const controller = new AbortController()
  let created = 0
  await assert.rejects(loadExactAudioObjectUrl(descriptor, {
    origin: "https://galaxy.invalid",
    signal: controller.signal,
    fetcher: async () => new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": "audio/webm",
        "Content-Length": String(bytes.length),
        "X-Content-SHA256": descriptor.contentSha256,
        ETag: `"sha256-${descriptor.contentSha256}"`,
      },
    }),
    async digest() {
      controller.abort()
      return descriptor.contentSha256
    },
    createObjectURL() { created += 1; return "blob:no" },
    revokeObjectURL() {},
  }), /cancelled/)
  assert.equal(created, 0)
})

test("audio UI exposes controls without autoplay and revokes after detaching the player", async () => {
  const [reader, projection, host, route] = await Promise.all([
    readFile(new URL("../components/documents/exact-audio-document-reader.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/projections/exact-audio-projection.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/projections/object-projection-host.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/papers/document-reader-route.tsx", import.meta.url), "utf8"),
  ])
  for (const source of [reader, projection]) {
    assert.match(source, /<audio/)
    assert.match(source, / controls /)
    assert.doesNotMatch(source, /autoPlay/)
    assert.match(source, /element\.pause\(\)/)
    assert.match(source, /removeAttribute\("src"\)/)
    assert.match(source, /element\.load\(\)/)
    assert.match(source, /\.revoke\(\)/)
  }
  assert.match(host, /selected\.projector\.id === "audio" && !showDetail/u)
  assert.match(host, /showDetail && selected\.projector\.id === "audio"/u)
  assert.match(host, /data-slot="object-projection-audio-metadata"/u)
  const requestGuard = projection.indexOf("request?.identity !== descriptorIdentity")
  const fetchStart = projection.indexOf("loadExactAudioObjectUrl(descriptor")
  assert.ok(requestGuard >= 0 && requestGuard < fetchStart, "detail audio must not fetch before explicit request")
  assert.match(projection, /<button[\s\S]*type="button"[\s\S]*onClick=\{requestLoad\}[\s\S]*Load audio/u)
  assert.match(projection, /Retry audio/u)
  assert.match(projection, /controller\.abort\(\)[\s\S]*exact\?\.revoke\(\)/u)
  assert.match(projection, /element\.pause\(\)[\s\S]*removeAttribute\("src"\)[\s\S]*element\.load\(\)[\s\S]*activeAudio\.revoke\(\)/u)
  assert.match(route, /isExactAudioOriginalMediaType/)
  assert.match(route, /<ExactAudioDocumentReader revision=\{revision\}/)
})
