import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"

import sharp from "sharp"

import {
  ExactImageDocumentError,
  exactImageDocumentDescriptor,
  exactImageProjectionDescriptor,
  isExactRasterImageMediaType,
  loadExactImageObjectUrl,
} from "../lib/document-image-reader.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import { selectObjectRepresentation } from "../lib/object-projector-registry.js"

const documentId = "10000000-0000-4000-8000-000000000001"
const revisionId = "20000000-0000-4000-8000-000000000002"
const artifactId = "30000000-0000-4000-8000-000000000003"
const representationId = "40000000-0000-4000-8000-000000000004"
const revisionSha256 = "a".repeat(64)

async function imageFixture() {
  return new Uint8Array(await sharp({
    create: { width: 7, height: 5, channels: 4, background: "#204080ff" },
  }).png().toBuffer())
}

function revision(bytes) {
  const contentSha256 = createHash("sha256").update(bytes).digest("hex")
  return {
    schemaId: "gb.document-revision.v1",
    document_id: documentId,
    ref: createGalaxyObjectReference("document", documentId, {
      mode: "pinned", revision: `sha256:${revisionSha256}`,
    }),
    revision_id: revisionId,
    version: 1,
    revision_sha256: revisionSha256,
    title: "Exact image",
    display_filename: "Exact image [abc].png",
    created_at: "2026-09-25T12:00:00Z",
    artifact: {
      id: artifactId,
      content_sha256: contentSha256,
      byte_size: bytes.byteLength,
      media_type: "image/png",
    },
    source: { id: "source", kind: "upload", uri: null, original_filename: "source.png" },
    raster_image: {
      schemaId: "gb.raster-image.v1",
      format: "png",
      mediaType: "image/png",
      width: 7,
      height: 5,
      channels: 4,
      frameCount: 1,
      byteSize: bytes.byteLength,
      contentSha256,
    },
    representations: [{
      id: representationId,
      kind: "original",
      media_type: "image/png",
      content_sha256: contentSha256,
      content_path: `/documents/${revisionId}/representations/${representationId}/content`,
    }],
  }
}

function stream(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 3))
      controller.enqueue(bytes.subarray(3))
      controller.close()
    },
  })
}

function exactResponse(descriptor, bytes, overrides = {}) {
  return {
    ok: overrides.ok ?? true,
    redirected: overrides.redirected ?? false,
    url: overrides.url ?? "",
    headers: new Headers({
      "content-type": descriptor.mediaType,
      "content-length": String(bytes.byteLength),
      "x-content-sha256": descriptor.contentSha256,
      etag: `"sha256-${descriptor.contentSha256}"`,
      ...overrides.headers,
    }),
    body: overrides.body ?? stream(bytes),
  }
}

test("exact image descriptors bind revision, original representation, manifest, and same-origin route", async () => {
  const bytes = await imageFixture()
  const value = revision(bytes)
  const descriptor = exactImageDocumentDescriptor(value, revisionId)
  assert.equal(descriptor.documentId, documentId)
  assert.equal(descriptor.revisionId, revisionId)
  assert.equal(descriptor.contentSha256, value.raster_image.contentSha256)
  assert.equal(
    descriptor.contentUrl,
    `/api/eln/documents/${revisionId}/representations/${representationId}/content?document_id=${documentId}&revision_sha256=${revisionSha256}`,
  )
  assert.equal(isExactRasterImageMediaType("image/webp"), true)
  assert.equal(isExactRasterImageMediaType("image/svg+xml"), false)

  const projection = {
    schemaId: "gb.object-projection.v1",
    ref: value.ref,
    kind: "document",
    revision: { policy: "pinned", id: `sha256:${revisionSha256}`, contentHash: revisionSha256 },
    title: value.title,
    mediaType: "image/png",
    rasterImage: value.raster_image,
    representations: [{
      ref: `gb:representation:document:${documentId}:${representationId}`,
      kind: "original",
      mediaType: "image/png",
      contentHash: value.raster_image.contentSha256,
      label: "original",
    }],
    provenance: { provider: "galaxy.document", sourceId: documentId, sourceRevision: `sha256:${revisionSha256}` },
    capabilities: ["open", "place"],
  }
  assert.equal(exactImageProjectionDescriptor(projection, revisionId).contentUrl, descriptor.contentUrl)
  assert.throws(() => exactImageProjectionDescriptor(projection, ""), /Authorized document revision/u)
})

test("Blob URL loader verifies response identity, hash, decoder dimensions, and cleanup", async () => {
  const bytes = await imageFixture()
  const descriptor = exactImageDocumentDescriptor(revision(bytes), revisionId)
  const revoked = []
  let request
  const loaded = await loadExactImageObjectUrl(descriptor, {
    fetcher: async (url, init) => {
      request = { url, init }
      return exactResponse(descriptor, bytes)
    },
    createObjectURL(blob) {
      assert.equal(blob.type, "image/png")
      assert.equal(blob.size, bytes.byteLength)
      return "blob:exact-image"
    },
    revokeObjectURL: (url) => revoked.push(url),
    decodeImage: async () => ({ width: 7, height: 5 }),
  })
  assert.equal(request.url, descriptor.contentUrl)
  assert.equal(request.init.cache, "no-store")
  assert.equal(request.init.redirect, "error")
  assert.equal(loaded.url, "blob:exact-image")
  loaded.revoke()
  loaded.revoke()
  assert.deepEqual(revoked, ["blob:exact-image"])

  await assert.rejects(loadExactImageObjectUrl(descriptor, {
    fetcher: async () => exactResponse(descriptor, bytes),
    createObjectURL: () => "blob:wrong-dimensions",
    revokeObjectURL: (url) => revoked.push(url),
    decodeImage: async () => ({ width: 8, height: 5 }),
  }), /dimensions/u)
  assert.deepEqual(revoked, ["blob:exact-image", "blob:wrong-dimensions"])
})

test("loader rejects redirects, headers, declared size, bytes, and stale metadata before display", async (t) => {
  const bytes = await imageFixture()
  const value = revision(bytes)
  const descriptor = exactImageDocumentDescriptor(value, revisionId)
  assert.throws(() => exactImageDocumentDescriptor({ ...value, revision_id: artifactId }, revisionId), /stale/u)
  assert.throws(() => exactImageDocumentDescriptor({
    ...value, raster_image: { ...value.raster_image, contentSha256: "b".repeat(64) },
  }, revisionId), /different content hash/u)
  assert.throws(() => exactImageDocumentDescriptor({
    ...value, representations: [{ ...value.representations[0], content_sha256: "b".repeat(64) }],
  }, revisionId), /does not match/u)

  const cases = [
    exactResponse(descriptor, bytes, { redirected: true }),
    exactResponse(descriptor, bytes, { url: "https://example.invalid/image" }),
    exactResponse(descriptor, bytes, { headers: { "content-type": "image/jpeg" } }),
    exactResponse(descriptor, bytes, { headers: { "x-content-sha256": "b".repeat(64) } }),
    exactResponse(descriptor, bytes, { headers: { etag: `"sha256-${"b".repeat(64)}"` } }),
    exactResponse(descriptor, bytes, { headers: { "content-length": "999" } }),
  ]
  for (const response of cases) {
    await t.test("mismatched response", async () => {
      await assert.rejects(loadExactImageObjectUrl(descriptor, {
        fetcher: async () => response,
        createObjectURL: () => "blob:never",
        revokeObjectURL: () => undefined,
        decodeImage: async () => ({ width: 7, height: 5 }),
        origin: "https://galaxy.test",
      }), ExactImageDocumentError)
    })
  }
})

test("registered image projector precedes generic document and fetches only settled near/detail views", async () => {
  const bytes = await imageFixture()
  const value = revision(bytes)
  const projection = {
    schemaId: "gb.object-projection.v1",
    ref: value.ref,
    kind: "document",
    revision: { policy: "pinned", id: `sha256:${revisionSha256}`, contentHash: revisionSha256 },
    title: value.title,
    mediaType: "image/png",
    rasterImage: value.raster_image,
    representations: [{
      ref: `gb:representation:document:${documentId}:${representationId}`,
      kind: "original", mediaType: "image/png", contentHash: value.raster_image.contentSha256, label: "original",
    }],
    provenance: { provider: "galaxy.document", sourceId: documentId, sourceRevision: `sha256:${revisionSha256}` },
    capabilities: ["open", "place"],
  }
  assert.equal(selectObjectRepresentation(projection, 0.2, false).projector.id, "image")
  assert.equal(selectObjectRepresentation(projection, 0.2, false).representation, "glyph")
  assert.equal(selectObjectRepresentation(projection, 1, false).representation, "label")
  assert.equal(selectObjectRepresentation(projection, 1.5, true).representation, "card")
  assert.equal(selectObjectRepresentation(projection, 1.5, false).representation, "card")
  assert.equal(selectObjectRepresentation(projection, 3, false).representation, "detail")

  const [host, preview] = await Promise.all([
    readFile(new URL("../components/projections/object-projection-host.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/projections/exact-image-projection.tsx", import.meta.url), "utf8"),
  ])
  assert.match(host, /selected\.placeholder[\s\S]*: showBody \?[\s\S]*<ExactImageProjection/u)
  const node = await readFile(new URL("../components/canvas/galaxy-canvas-node.tsx", import.meta.url), "utf8")
  assert.doesNotMatch(node, /streamExactRepresentation=\{[^}]*!moving/u)
  const image = await readFile(new URL("../components/projections/exact-image-projection.tsx", import.meta.url), "utf8")
  assert.doesNotMatch(image, /moving/u)
  assert.match(preview, /loadExactImageObjectUrl\(descriptor/u)
  assert.match(host, /const stableProjection = useMemo\(\(\) => createGalaxyObjectProjection\(projection\), \[projection\]\)/u)
  assert.match(host, /<ExactImageProjection[\s\S]*projection=\{stableProjection\}/u)
  assert.match(preview, /loadState\.key === descriptorKey/u)
  assert.match(preview, /loaded\?\.revoke\(\)/u)
  assert.doesNotMatch(preview, /https?:\/\//u)
})
