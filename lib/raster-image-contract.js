export const RASTER_IMAGE_SCHEMA_ID = "gb.raster-image.v1"
export const MAX_RASTER_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_RASTER_IMAGE_DIMENSION = 8192
export const MAX_RASTER_IMAGE_PIXELS = 16_777_216
export const MAX_RASTER_IMAGE_CHANNELS = 4

export const RASTER_IMAGE_TYPES = Object.freeze({
  png: Object.freeze({ extension: ".png", extensions: Object.freeze([".png"]), mediaType: "image/png" }),
  jpeg: Object.freeze({ extension: ".jpg", extensions: Object.freeze([".jpg", ".jpeg"]), mediaType: "image/jpeg" }),
  webp: Object.freeze({ extension: ".webp", extensions: Object.freeze([".webp"]), mediaType: "image/webp" }),
  gif: Object.freeze({ extension: ".gif", extensions: Object.freeze([".gif"]), mediaType: "image/gif" }),
})

const MANIFEST_KEYS = new Set([
  "schemaId", "format", "mediaType", "width", "height", "channels", "frameCount",
  "byteSize", "contentSha256",
])
const SHA256 = /^[0-9a-f]{64}$/u
const IMAGE_LIKE_EXTENSIONS = new Set([
  ".avif", ".bmp", ".heic", ".heif", ".ico", ".jfif", ".svg", ".tif", ".tiff",
  ...Object.values(RASTER_IMAGE_TYPES).flatMap((type) => type.extensions),
])

export class RasterImageContractError extends Error {
  constructor(message, code = "invalid") {
    super(message)
    this.code = code
  }
}

function extensionOf(filename) {
  if (typeof filename !== "string") return ""
  const index = filename.lastIndexOf(".")
  return index > 0 ? filename.slice(index).trim().toLowerCase() : ""
}

function baseMediaType(value) {
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : ""
}

function startsWith(bytes, signature, offset = 0) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < offset + signature.length) return false
  return signature.every((value, index) => bytes[offset + index] === value)
}

function ascii(bytes, value, offset = 0) {
  return startsWith(bytes, Array.from(value, (character) => character.charCodeAt(0)), offset)
}

function uint16LittleEndian(bytes, offset) {
  if (bytes.byteLength < offset + 2) return null
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function skipGifSubBlocks(bytes, offset) {
  let cursor = offset
  while (cursor < bytes.byteLength) {
    const length = bytes[cursor]
    cursor += 1
    if (length === 0) return cursor
    if (cursor + length > bytes.byteLength) return null
    cursor += length
  }
  return null
}

function hasGifStructure(bytes) {
  if (!(ascii(bytes, "GIF87a") || ascii(bytes, "GIF89a")) || bytes.byteLength < 14) return false
  if (!uint16LittleEndian(bytes, 6) || !uint16LittleEndian(bytes, 8)) return false
  let cursor = 13 + ((bytes[10] & 0x80) !== 0 ? 3 * (2 ** ((bytes[10] & 0x07) + 1)) : 0)
  let images = 0
  while (cursor < bytes.byteLength) {
    const marker = bytes[cursor]
    if (marker === 0x3b) return images > 0 && cursor === bytes.byteLength - 1
    if (marker === 0x21) {
      if (cursor + 2 >= bytes.byteLength) return false
      const next = skipGifSubBlocks(bytes, cursor + 2)
      if (next === null) return false
      cursor = next
      continue
    }
    if (marker !== 0x2c || cursor + 10 > bytes.byteLength
      || !uint16LittleEndian(bytes, cursor + 5) || !uint16LittleEndian(bytes, cursor + 7)) return false
    const packed = bytes[cursor + 9]
    cursor += 10 + ((packed & 0x80) !== 0 ? 3 * (2 ** ((packed & 0x07) + 1)) : 0)
    if (cursor >= bytes.byteLength || bytes[cursor] < 2 || bytes[cursor] > 12) return false
    const next = skipGifSubBlocks(bytes, cursor + 1)
    if (next === null) return false
    cursor = next
    images += 1
  }
  return false
}

export function detectRasterImageFormat(value) {
  const bytes = value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer ? new Uint8Array(value) : null
  if (!bytes) return null
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg"
  if (hasGifStructure(bytes)) return "gif"
  if (ascii(bytes, "RIFF") && ascii(bytes, "WEBP", 8)) return "webp"
  return null
}

/** Signature-only classifier for streaming ingress before a full decode is possible. */
export function hasRasterImageSignature(value) {
  const bytes = value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer ? new Uint8Array(value) : null
  if (!bytes) return false
  return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    || startsWith(bytes, [0xff, 0xd8, 0xff])
    || ascii(bytes, "GIF87a")
    || ascii(bytes, "GIF89a")
    || (ascii(bytes, "RIFF") && ascii(bytes, "WEBP", 8))
}

export function rasterImageTypeForFilename(filename) {
  const extension = extensionOf(filename)
  return Object.entries(RASTER_IMAGE_TYPES).find(([, type]) => type.extensions.includes(extension))?.[0] ?? null
}

export function rasterImageTypeForMediaType(value) {
  const mediaType = baseMediaType(value)
  return Object.entries(RASTER_IMAGE_TYPES).find(([, type]) => type.mediaType === mediaType)?.[0] ?? null
}

/** Treat every image media type, supported extension, or supported magic as image-lane input. */
export function isRasterImageCandidate(filename, declaredMediaType, value) {
  const mediaType = baseMediaType(declaredMediaType)
  return IMAGE_LIKE_EXTENSIONS.has(extensionOf(filename))
    || mediaType.startsWith("image/")
    || detectRasterImageFormat(value) !== null
}

/** Require all three caller-visible claims to agree before server decoding. */
export function rasterImageMediaType(filename, declaredMediaType, value) {
  const extensionFormat = rasterImageTypeForFilename(filename)
  const mediaFormat = rasterImageTypeForMediaType(declaredMediaType)
  const magicFormat = detectRasterImageFormat(value)
  if (!extensionFormat || !mediaFormat || !magicFormat
    || extensionFormat !== mediaFormat || extensionFormat !== magicFormat) {
    throw new RasterImageContractError(
      "Raster image extension, media type, and file signature must agree on PNG, JPEG, WebP, or GIF",
    )
  }
  return RASTER_IMAGE_TYPES[extensionFormat].mediaType
}

function positiveInteger(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RasterImageContractError(`${label} is outside the raster image limit`)
  }
  return value
}

export function normalizeRasterImageManifest(value, binding = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RasterImageContractError("Raster image manifest must be an object")
  }
  if (Object.keys(value).some((key) => !MANIFEST_KEYS.has(key))
    || MANIFEST_KEYS.size !== Object.keys(value).length
    || value.schemaId !== RASTER_IMAGE_SCHEMA_ID
    || !Object.hasOwn(RASTER_IMAGE_TYPES, value.format)) {
    throw new RasterImageContractError("Raster image manifest shape is invalid")
  }
  const type = RASTER_IMAGE_TYPES[value.format]
  if (value.mediaType !== type.mediaType) {
    throw new RasterImageContractError("Raster image manifest media type does not match its format")
  }
  const width = positiveInteger(value.width, MAX_RASTER_IMAGE_DIMENSION, "Raster image width")
  const height = positiveInteger(value.height, MAX_RASTER_IMAGE_DIMENSION, "Raster image height")
  if (width * height > MAX_RASTER_IMAGE_PIXELS) {
    throw new RasterImageContractError("Raster image decoded pixel count exceeds the limit")
  }
  const channels = positiveInteger(value.channels, MAX_RASTER_IMAGE_CHANNELS, "Raster image channel count")
  if (value.frameCount !== 1) {
    throw new RasterImageContractError("Animated raster images are not supported")
  }
  const byteSize = positiveInteger(value.byteSize, MAX_RASTER_IMAGE_BYTES, "Raster image byte size")
  if (typeof value.contentSha256 !== "string" || !SHA256.test(value.contentSha256)) {
    throw new RasterImageContractError("Raster image content hash is invalid")
  }
  if (binding.mediaType !== undefined && baseMediaType(binding.mediaType) !== value.mediaType) {
    throw new RasterImageContractError("Raster image manifest is bound to a different media type")
  }
  if (binding.byteSize !== undefined && binding.byteSize !== byteSize) {
    throw new RasterImageContractError("Raster image manifest is bound to a different byte size")
  }
  if (binding.contentSha256 !== undefined && binding.contentSha256 !== value.contentSha256) {
    throw new RasterImageContractError("Raster image manifest is bound to a different content hash")
  }
  return Object.freeze({
    schemaId: RASTER_IMAGE_SCHEMA_ID,
    format: value.format,
    mediaType: value.mediaType,
    width,
    height,
    channels,
    frameCount: 1,
    byteSize,
    contentSha256: value.contentSha256,
  })
}

export function encodeRasterImageManifestHeader(value) {
  const manifest = normalizeRasterImageManifest(value)
  const bytes = new TextEncoder().encode(JSON.stringify(manifest))
  if (bytes.byteLength > 2_000) throw new RasterImageContractError("Raster image manifest is too large")
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
}

export function decodeDurableImportMetadataHeader(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 8_000 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new RasterImageContractError("Document import metadata is invalid")
  }
  try {
    const padding = "=".repeat((4 - (value.length % 4)) % 4)
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)
      || typeof decoded.filename !== "string" || decoded.filename.length < 1) {
      throw new Error("metadata shape")
    }
    return Object.freeze({ filename: decoded.filename, sourceKind: decoded.sourceKind ?? "upload" })
  } catch (error) {
    if (error instanceof RasterImageContractError) throw error
    throw new RasterImageContractError("Document import metadata is invalid")
  }
}
