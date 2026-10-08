import assert from "node:assert/strict"
import test from "node:test"

import { serializeInkDocument } from "../lib/ink-document.js"
import { handoffInkPreviewObjectUrl, loadInkPreviewObjectUrl } from "../lib/ink-preview.js"

const HASH = "a".repeat(64)
const DESCRIPTOR = {
  schemaId: "gb.canvas.ink-placement.v1",
  documentId: "123e4567-e89b-42d3-a456-426614174003",
  revisionSha256: "b".repeat(64),
  documentRevisionId: "123e4567-e89b-42d3-a456-426614174001",
  representationId: "123e4567-e89b-42d3-a456-426614174002",
  contentSha256: HASH,
}
const DOCUMENT = serializeInkDocument([{
  color: "#315f49", width: 4, opacity: 1, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
}])

function response() {
  return new Response(DOCUMENT, { status: 200, headers: { "Content-Type": "application/json" } })
}

test("a superseded ink preview cannot publish an old object URL after digest", async () => {
  let current = true
  let releaseDigest
  let digestStarted
  const started = new Promise((resolve) => { digestStarted = resolve })
  const gate = new Promise((resolve) => { releaseDigest = resolve })
  let created = 0
  const pending = loadInkPreviewObjectUrl(DESCRIPTOR, {
    fetcher: async () => response(),
    isCurrent: () => current,
    digestBytes: async () => { digestStarted(); await gate; return HASH },
    createObjectUrl: () => { created += 1; return "blob:old" },
  })
  await started
  current = false
  releaseDigest()
  assert.equal(await pending, null)
  assert.equal(created, 0)
})

test("a superseded ink preview stops while consuming bounded response bytes", async () => {
  let current = true
  let releaseStream
  let streamStarted
  const started = new Promise((resolve) => { streamStarted = resolve })
  const gate = new Promise((resolve) => { releaseStream = resolve })
  const encoded = new TextEncoder().encode(DOCUMENT)
  let cancelled = false
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoded.slice(0, 8))
      streamStarted()
      void gate.then(() => {
        if (!cancelled) controller.enqueue(encoded.slice(8))
      })
    },
    cancel() { cancelled = true },
  })
  let digested = 0
  const pending = loadInkPreviewObjectUrl(DESCRIPTOR, {
    fetcher: async () => new Response(body, {
      status: 200, headers: { "Content-Type": "application/json" },
    }),
    isCurrent: () => current,
    digestBytes: async () => { digested += 1; return HASH },
  })
  await started
  current = false
  releaseStream()
  assert.equal(await pending, null)
  assert.equal(digested, 0)
})

test("a preview superseded during object URL creation revokes the late URL", async () => {
  let current = true
  const revoked = []
  const result = await loadInkPreviewObjectUrl(DESCRIPTOR, {
    fetcher: async () => response(),
    isCurrent: () => current,
    digestBytes: async () => HASH,
    createObjectUrl: () => { current = false; return "blob:late" },
    revokeObjectUrl: (url) => revoked.push(url),
  })
  assert.equal(result, null)
  assert.deepEqual(revoked, ["blob:late"])
})

test("component handoff revokes a URL resolved just before generation cleanup", async () => {
  let current = true
  const published = []
  const revoked = []
  let resolveUrl
  const loaded = new Promise((resolve) => { resolveUrl = resolve })
  const handoff = loaded.then((url) => handoffInkPreviewObjectUrl(url, {
    isCurrent: () => current,
    publish: (value) => published.push(value),
    revokeObjectUrl: (value) => revoked.push(value),
  }))
  resolveUrl("blob:resolved-before-cleanup")
  current = false
  assert.equal(await handoff, false)
  assert.deepEqual(published, [])
  assert.deepEqual(revoked, ["blob:resolved-before-cleanup"])
})

test("current ink preview uses one fully bound authenticated representation request", async () => {
  let requested
  const result = await loadInkPreviewObjectUrl(DESCRIPTOR, {
    fetcher: async (url, init) => { requested = { url, init }; return response() },
    digestBytes: async () => HASH,
    createObjectUrl: (blob) => {
      assert.equal(blob.type, "image/svg+xml")
      return "blob:current"
    },
  })
  assert.equal(result, "blob:current")
  assert.match(requested.url, /document_id=123e4567-e89b-42d3-a456-426614174003/u)
  assert.match(requested.url, new RegExp(`revision_sha256=${"b".repeat(64)}`, "u"))
  assert.equal(requested.init.headers.Accept, "application/json")
})
