const MAGIC = Uint8Array.from([0x47, 0x42, 0x46, 0x50, 0x50, 0x31, 0x00, 0x00])
const HEADER_BYTES = 24

export const FORMAL_PROJECT_PACKAGE_MEDIA_TYPE = "application/vnd.galaxy.formal-project-package"

export const FORMAL_PROJECT_PACKAGE_ENVELOPE_LIMITS = Object.freeze({
  manifestBytes: 65_536,
  artifactBytes: 16_777_216,
  correspondenceBytes: 16_777_216,
  totalBytes: 50_397_208,
})

function exactBytes(value, label, maximum) {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > maximum) {
    throw new TypeError(`${label} must be bounded exact bytes`)
  }
  return value
}

export function encodeFormalProjectPackageEnvelope({
  manifestBytes,
  authoredConceptualDagBytes,
  repositoryFieldDagBytes,
  correspondenceBytes,
}) {
  const parts = [
    exactBytes(manifestBytes, "manifestBytes", FORMAL_PROJECT_PACKAGE_ENVELOPE_LIMITS.manifestBytes),
    exactBytes(authoredConceptualDagBytes, "authoredConceptualDagBytes", FORMAL_PROJECT_PACKAGE_ENVELOPE_LIMITS.artifactBytes),
    exactBytes(repositoryFieldDagBytes, "repositoryFieldDagBytes", FORMAL_PROJECT_PACKAGE_ENVELOPE_LIMITS.artifactBytes),
    exactBytes(correspondenceBytes, "correspondenceBytes", FORMAL_PROJECT_PACKAGE_ENVELOPE_LIMITS.correspondenceBytes),
  ]
  const total = HEADER_BYTES + parts.reduce((sum, part) => sum + part.byteLength, 0)
  if (total > FORMAL_PROJECT_PACKAGE_ENVELOPE_LIMITS.totalBytes) {
    throw new TypeError("Formal project package envelope exceeds its byte bound")
  }
  const result = new Uint8Array(total)
  result.set(MAGIC, 0)
  const view = new DataView(result.buffer)
  parts.forEach((part, index) => view.setUint32(8 + (index * 4), part.byteLength, false))
  let offset = HEADER_BYTES
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}
