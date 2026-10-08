const EMBEDDED_RASTER_IMAGE_PATTERN = /^data:image\/(?:png|jpeg|gif|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/iu

/** Allow converter-owned raster bytes without permitting remote tracking URLs or active SVG. */
export function isEmbeddedRasterImageSource(value) {
  return typeof value === "string" && EMBEDDED_RASTER_IMAGE_PATTERN.test(value)
}
