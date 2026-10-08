import { createHash } from "node:crypto"

import sharp from "sharp"

import {
  MAX_RASTER_IMAGE_BYTES,
  MAX_RASTER_IMAGE_CHANNELS,
  MAX_RASTER_IMAGE_DIMENSION,
  MAX_RASTER_IMAGE_PIXELS,
  RasterImageContractError,
  RASTER_IMAGE_TYPES,
  isRasterImageCandidate,
  normalizeRasterImageManifest,
  rasterImageMediaType,
} from "../raster-image-contract.js"

const MAX_CONCURRENT_RASTER_DECODES = 2
let activeRasterDecodes = 0

async function withRasterDecodeSlot(task) {
  if (activeRasterDecodes >= MAX_CONCURRENT_RASTER_DECODES) {
    throw new RasterImageContractError("Raster image decoder is busy; retry shortly", "busy")
  }
  activeRasterDecodes += 1
  try {
    return await task()
  } finally {
    activeRasterDecodes -= 1
  }
}

function boundedDimension(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RASTER_IMAGE_DIMENSION) {
    throw new RasterImageContractError(`${label} is outside the raster image limit`)
  }
  return value
}

function sharpInput(bytes) {
  return sharp(bytes, {
    animated: false,
    failOn: "warning",
    limitInputChannels: MAX_RASTER_IMAGE_CHANNELS,
    limitInputPixels: MAX_RASTER_IMAGE_PIXELS,
    sequentialRead: true,
    unlimited: false,
  })
}

/**
 * Fully decode a supported image to bounded raw pixels. Successful metadata
 * parsing alone is never treated as validation.
 */
export async function validateRasterImageImport({ bytes: value, filename, declaredMediaType }) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  if (!isRasterImageCandidate(filename, declaredMediaType, bytes)) return null
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_RASTER_IMAGE_BYTES) {
    throw new RasterImageContractError("Raster image exceeds the 20 MiB import limit")
  }
  const mediaType = rasterImageMediaType(filename, declaredMediaType, bytes)
  const expectedFormat = Object.entries(RASTER_IMAGE_TYPES)
    .find(([, type]) => type.mediaType === mediaType)?.[0]
  return withRasterDecodeSlot(async () => {
    try {
      const metadata = await sharpInput(bytes).metadata()
      if (metadata.format !== expectedFormat
        || (metadata.pages ?? 1) !== 1
        || (metadata.pageHeight !== undefined && metadata.height !== undefined
          && metadata.pageHeight !== metadata.height)) {
        throw new RasterImageContractError("Raster image decoder disagrees with its type or contains animation")
      }
      const decoded = await sharpInput(bytes).autoOrient().raw().toBuffer({ resolveWithObject: true })
      const width = boundedDimension(decoded.info.width, "Raster image width")
      const height = boundedDimension(decoded.info.height, "Raster image height")
      const channels = decoded.info.channels
      if (!Number.isSafeInteger(channels) || channels < 1 || channels > MAX_RASTER_IMAGE_CHANNELS
        || width * height > MAX_RASTER_IMAGE_PIXELS
        || decoded.data.byteLength !== width * height * channels) {
        throw new RasterImageContractError("Raster image decoded pixels are outside the safety contract")
      }
      return normalizeRasterImageManifest({
        schemaId: "gb.raster-image.v1",
        format: expectedFormat,
        mediaType,
        width,
        height,
        channels,
        frameCount: 1,
        byteSize: bytes.byteLength,
        contentSha256: createHash("sha256").update(bytes).digest("hex"),
      })
    } catch (error) {
      if (error instanceof RasterImageContractError) throw error
      throw new RasterImageContractError("Raster image is corrupt or cannot be safely decoded")
    }
  })
}
