export type RasterImageFormat = "png" | "jpeg" | "webp" | "gif"
export interface RasterImageManifest {
  readonly schemaId: "gb.raster-image.v1"
  readonly format: RasterImageFormat
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"
  readonly width: number
  readonly height: number
  readonly channels: number
  readonly frameCount: 1
  readonly byteSize: number
  readonly contentSha256: string
}
export const RASTER_IMAGE_SCHEMA_ID: "gb.raster-image.v1"
export const MAX_RASTER_IMAGE_BYTES: number
export const MAX_RASTER_IMAGE_DIMENSION: number
export const MAX_RASTER_IMAGE_PIXELS: number
export const MAX_RASTER_IMAGE_CHANNELS: number
export const RASTER_IMAGE_TYPES: Readonly<Record<RasterImageFormat, Readonly<{
  extension: string
  extensions: readonly string[]
  mediaType: RasterImageManifest["mediaType"]
}>>>
export class RasterImageContractError extends Error {
  readonly code: "invalid" | "busy"
  constructor(message: string, code?: "invalid" | "busy")
}
export function detectRasterImageFormat(value: ArrayBuffer | Uint8Array): RasterImageFormat | null
export function hasRasterImageSignature(value: ArrayBuffer | Uint8Array): boolean
export function rasterImageTypeForFilename(filename: unknown): RasterImageFormat | null
export function rasterImageTypeForMediaType(value: unknown): RasterImageFormat | null
export function isRasterImageCandidate(filename: unknown, declaredMediaType: unknown, value?: ArrayBuffer | Uint8Array): boolean
export function rasterImageMediaType(filename: unknown, declaredMediaType: unknown, value: ArrayBuffer | Uint8Array): RasterImageManifest["mediaType"]
export function normalizeRasterImageManifest(value: unknown, binding?: {
  mediaType?: string
  byteSize?: number
  contentSha256?: string
}): RasterImageManifest
export function encodeRasterImageManifestHeader(value: unknown): string
export function decodeDurableImportMetadataHeader(value: unknown): Readonly<{ filename: string; sourceKind: string }>
