const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u

/** Browser-safe textual-original eligibility shared by anchor and routing code. */
export function isDocumentAnchorTextMediaType(value) {
  if (typeof value !== "string") return false
  const mediaType = value.toLowerCase().split(";", 1)[0].trim()
  if (!MEDIA_TYPE.test(mediaType)) return false
  return mediaType.startsWith("text/") || mediaType === "application/json" || mediaType === "application/xml"
}
