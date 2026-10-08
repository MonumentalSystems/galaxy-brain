import { createGalaxyObjectReference } from "./galaxy-object-reference.js"

const SHA256_PATTERN = /^[0-9a-f]{64}$/i

/** Build the immutable reference used when a reviewed surface is placed. */
export function promotedSurfaceReference(surface) {
  if (!surface || typeof surface !== "object" || Array.isArray(surface)) {
    throw new TypeError("Promoted surface record is required")
  }
  if (surface.status !== "promoted") {
    throw new TypeError("Only promoted surfaces may be placed")
  }
  if (typeof surface.id !== "string" || surface.id.length === 0) {
    throw new TypeError("Surface id is required")
  }
  if (typeof surface.current_content_hash !== "string" || !SHA256_PATTERN.test(surface.current_content_hash)) {
    throw new TypeError("Surface content hash must be a SHA-256 digest")
  }
  return createGalaxyObjectReference("surface", surface.id, {
    mode: "pinned",
    revision: `sha256:${surface.current_content_hash.toLowerCase()}`,
  })
}
