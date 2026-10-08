import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"

import sharp from "sharp"

import {
  detectRasterImageFormat,
  encodeRasterImageManifestHeader,
  hasRasterImageSignature,
  isRasterImageCandidate,
  MAX_RASTER_IMAGE_BYTES,
  normalizeRasterImageManifest,
  RasterImageContractError,
  rasterImageMediaType,
} from "../lib/raster-image-contract.js"
import { validateRasterImageImport } from "../lib/server/raster-image-validation.js"

async function fixture(format, width = 3, height = 2) {
  const pipeline = sharp({ create: { width, height, channels: 4, background: "#c04080ff" } })
  return new Uint8Array(await pipeline[format]().toBuffer())
}

const formats = [
  ["png", "sample.png", "image/png"],
  ["jpeg", "sample.jpg", "image/jpeg"],
  ["webp", "sample.webp", "image/webp"],
  ["gif", "sample.gif", "image/gif"],
]

test("static PNG, JPEG, WebP, and GIF require extension, MIME, magic, and decoder agreement", async () => {
  for (const [format, filename, mediaType] of formats) {
    const bytes = await fixture(format)
    assert.equal(detectRasterImageFormat(bytes), format)
    assert.equal(rasterImageMediaType(filename, mediaType, bytes), mediaType)
    const manifest = await validateRasterImageImport({ bytes, filename, declaredMediaType: mediaType })
    assert.equal(manifest.schemaId, "gb.raster-image.v1")
    assert.equal(manifest.format, format)
    assert.equal(manifest.mediaType, mediaType)
    assert.equal(manifest.width, 3)
    assert.equal(manifest.height, 2)
    assert.ok(manifest.channels >= 1 && manifest.channels <= 4)
    assert.equal(manifest.frameCount, 1)
    assert.equal(manifest.byteSize, bytes.byteLength)
    assert.equal(manifest.contentSha256, createHash("sha256").update(bytes).digest("hex"))
    assert.match(encodeRasterImageManifestHeader(manifest), /^[A-Za-z0-9_-]+$/u)
  }
})

test("complete-body candidate detection does not mistake prose prefixes for structured images", () => {
  const prose = new TextEncoder().encode("GIF87a begins ordinary valid prose without a GIF structure.")
  assert.equal(hasRasterImageSignature(prose), true)
  assert.equal(isRasterImageCandidate("notes.txt", "text/plain", prose), false)
})

test("mismatch, unsupported image families, corrupt bytes, animation, and limits fail closed", async () => {
  const png = await fixture("png")
  assert.equal(hasRasterImageSignature(png.subarray(0, 8)), true)
  assert.equal(hasRasterImageSignature(new TextEncoder().encode("ordinary text")), false)
  assert.throws(() => rasterImageMediaType("sample.jpg", "image/png", png), RasterImageContractError)
  assert.throws(() => rasterImageMediaType("sample.png", "image/jpeg", png), RasterImageContractError)
  assert.equal(isRasterImageCandidate("vector.svg", "text/plain", new TextEncoder().encode("<svg/>")), true)
  await assert.rejects(
    validateRasterImageImport({ bytes: new TextEncoder().encode("<svg/>"), filename: "vector.svg", declaredMediaType: "image/svg+xml" }),
    /PNG, JPEG, WebP, or GIF/,
  )
  const corrupt = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  await assert.rejects(
    validateRasterImageImport({ bytes: corrupt, filename: "broken.png", declaredMediaType: "image/png" }),
    /corrupt|decoded/u,
  )

  const frames = Buffer.alloc(2 * 4 * 4)
  for (let pixel = 0; pixel < 8; pixel += 1) {
    frames[(pixel * 4) + (pixel < 4 ? 0 : 2)] = 255
    frames[(pixel * 4) + 3] = 255
  }
  const animated = new Uint8Array(await sharp(frames, {
    raw: { width: 2, height: 4, channels: 4, pageHeight: 2 },
  }).gif({ delay: [100, 100], loop: 0 }).toBuffer())
  await assert.rejects(
    validateRasterImageImport({ bytes: animated, filename: "animated.gif", declaredMediaType: "image/gif" }),
    /animation/u,
  )

  const tooWide = await fixture("png", 8193, 1)
  await assert.rejects(
    validateRasterImageImport({ bytes: tooWide, filename: "wide.png", declaredMediaType: "image/png" }),
    /width/u,
  )
  const oversized = new Uint8Array(MAX_RASTER_IMAGE_BYTES + 1)
  oversized.set(png.subarray(0, 8))
  await assert.rejects(
    validateRasterImageImport({ bytes: oversized, filename: "large.png", declaredMediaType: "image/png" }),
    /20 MiB/u,
  )
})

test("manifest normalization binds size, media, digest, dimensions, channels, and one frame", () => {
  const manifest = {
    schemaId: "gb.raster-image.v1",
    format: "png",
    mediaType: "image/png",
    width: 128,
    height: 64,
    channels: 4,
    frameCount: 1,
    byteSize: 1024,
    contentSha256: "a".repeat(64),
  }
  assert.deepEqual(normalizeRasterImageManifest(manifest, {
    mediaType: "image/png", byteSize: 1024, contentSha256: "a".repeat(64),
  }), manifest)
  assert.throws(() => normalizeRasterImageManifest({ ...manifest, frameCount: 2 }), /Animated/u)
  assert.throws(() => normalizeRasterImageManifest({ ...manifest, channels: 5 }), /channel/u)
  assert.throws(() => normalizeRasterImageManifest({ ...manifest, width: 8193 }), /width/u)
  assert.throws(() => normalizeRasterImageManifest(manifest, { contentSha256: "b".repeat(64) }), /different content hash/u)
  assert.throws(() => normalizeRasterImageManifest({ ...manifest, pixels: 8192 }), /shape/u)
})

test("decoder admission is fail-fast and never retains an unbounded body queue", async () => {
  const bytes = await fixture("png", 2048, 2048)
  const first = validateRasterImageImport({ bytes, filename: "first.png", declaredMediaType: "image/png" })
  const second = validateRasterImageImport({ bytes, filename: "second.png", declaredMediaType: "image/png" })
  await assert.rejects(
    validateRasterImageImport({ bytes, filename: "third.png", declaredMediaType: "image/png" }),
    (error) => error instanceof RasterImageContractError
      && error.code === "busy"
      && /retry/u.test(error.message),
  )
  await Promise.all([first, second])
})

test("sharp is a pinned direct dependency and decoder code remains server-owned", async () => {
  const [pkg, decoder, client] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../lib/server/raster-image-validation.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/durable-document-import.js", import.meta.url), "utf8"),
  ])
  assert.equal(pkg.dependencies.sharp, "0.35.4")
  assert.match(decoder, /from "sharp"/u)
  assert.match(decoder, /MAX_CONCURRENT_RASTER_DECODES = 2/u)
  assert.doesNotMatch(decoder, /rasterDecodeWaiters/u)
  assert.match(decoder, /\.raw\(\)\.toBuffer/u)
  assert.doesNotMatch(client, /from "sharp"|import\("sharp"\)/u)
})
