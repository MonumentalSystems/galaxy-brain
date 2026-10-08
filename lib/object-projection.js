import {
  parseGalaxyObjectReference,
  planGalaxyObjectResolution,
  serializeGalaxyObjectReference,
} from "./galaxy-object-reference.js"
import { normalizeRasterImageManifest, rasterImageTypeForMediaType } from "./raster-image-contract.js"
import { normalizeAudioOriginalManifest } from "./audio-original-contract.js"

export const GALAXY_OBJECT_PROJECTION_SCHEMA_ID = "gb.object-projection.v1"

export const GALAXY_REPRESENTATION_KINDS = Object.freeze([
  "original",
  "pdf",
  "html",
  "markdown",
  "text",
  "thumbnail",
  "structure",
  "image",
  "audio",
  "video",
  "json",
  "surface",
])

export const GALAXY_PROJECTION_CAPABILITIES = Object.freeze([
  "open",
  "annotate",
  "place",
  "branch",
  "cite",
  "export",
  "inspect",
  "relate",
])

const CAPABILITY_SET = new Set(GALAXY_PROJECTION_CAPABILITIES)
const REPRESENTATION_KIND_SET = new Set(GALAXY_REPRESENTATION_KINDS)
const HASH = /^[a-f0-9]{64}$/u
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;[\x20-\x7e]+)?$/iu
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const PROJECTION_KEYS = new Set([
  "schemaId", "ref", "kind", "revision", "title", "summary", "mediaType",
  "representations", "rasterImage", "audioOriginal", "provenance", "capabilities",
])
const REVISION_KEYS = new Set(["policy", "id", "contentHash"])
const REPRESENTATION_KEYS = new Set(["ref", "kind", "mediaType", "contentHash", "label"])
const PROVENANCE_KEYS = new Set(["provider", "sourceId", "sourceRevision", "statement"])

function invalid(message) {
  throw new TypeError(`Invalid ${GALAXY_OBJECT_PROJECTION_SCHEMA_ID}: ${message}`)
}

function plainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`)
  return value
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${label}.${key} is not part of the projection contract`)
  }
}

function text(value, maximum, label, optional = false) {
  if (value === undefined && optional) return undefined
  if (typeof value !== "string") invalid(`${label} must be text`)
  const normalized = value.trim()
  if (!normalized || Array.from(normalized).length > maximum || CONTROL_CHARACTERS.test(normalized)) {
    invalid(`${label} is outside its bounded text contract`)
  }
  return normalized
}

function optionalHash(value, label) {
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string" || !HASH.test(value.toLowerCase())) invalid(`${label} must be a SHA-256 digest`)
  return value.toLowerCase()
}

function stringList(value, allowed, label, maximum = 16) {
  if (!Array.isArray(value) || value.length > maximum) invalid(`${label} must be a bounded array`)
  const seen = new Set()
  return Object.freeze(value.map((item, index) => {
    const normalized = text(item, 80, `${label}[${index}]`)
    if (allowed && !allowed.has(normalized)) invalid(`${label}[${index}] is unsupported`)
    if (seen.has(normalized)) invalid(`${label} contains duplicate ${normalized}`)
    seen.add(normalized)
    return normalized
  }))
}

function normalizeRepresentation(value, index) {
  const source = plainRecord(value, `representations[${index}]`)
  exactKeys(source, REPRESENTATION_KEYS, `representations[${index}]`)
  const kind = text(source.kind, 40, `representations[${index}].kind`)
  if (!REPRESENTATION_KIND_SET.has(kind)) invalid(`representations[${index}].kind is unsupported`)
  const representation = {
    ref: text(source.ref, 1024, `representations[${index}].ref`),
    kind,
    mediaType: undefined,
    contentHash: optionalHash(source.contentHash, `representations[${index}].contentHash`),
    label: text(source.label, 120, `representations[${index}].label`, true),
  }
  if (source.mediaType !== undefined) {
    representation.mediaType = text(source.mediaType, 160, `representations[${index}].mediaType`)
    if (!MEDIA_TYPE.test(representation.mediaType)) invalid(`representations[${index}].mediaType is invalid`)
  }
  return Object.freeze(Object.fromEntries(Object.entries(representation).filter(([, item]) => item !== undefined)))
}

/** Validate and deeply freeze the common read envelope. */
export function createGalaxyObjectProjection(input) {
  const source = plainRecord(input, "projection")
  exactKeys(source, PROJECTION_KEYS, "projection")
  if (source.schemaId !== GALAXY_OBJECT_PROJECTION_SCHEMA_ID) invalid("unsupported schemaId")
  const parsed = parseGalaxyObjectReference(source.ref)
  if (!parsed || parsed.format !== "canonical") invalid("ref must be a canonical gb.object-ref.v1")
  const ref = serializeGalaxyObjectReference(parsed)
  const kind = text(source.kind, 120, "kind")
  if (kind !== parsed.kind) invalid("kind must match ref kind")

  const rawRevision = plainRecord(source.revision, "revision")
  exactKeys(rawRevision, REVISION_KEYS, "revision")
  if (rawRevision.policy !== parsed.selector.mode) invalid("revision policy must match ref selector")
  const revisionId = rawRevision.id === null
    ? null
    : text(rawRevision.id, 256, "revision.id")
  if (parsed.selector.mode === "pinned" && revisionId !== parsed.selector.revision) {
    invalid("pinned revision id must match ref selector")
  }
  const revision = Object.freeze({
    policy: rawRevision.policy,
    id: revisionId,
    contentHash: optionalHash(rawRevision.contentHash, "revision.contentHash"),
  })

  if (!Array.isArray(source.representations) || source.representations.length > 32) {
    invalid("representations must be a bounded array")
  }
  const representationRefs = new Set()
  const representations = Object.freeze(source.representations.map((value, index) => {
    const representation = normalizeRepresentation(value, index)
    if (representationRefs.has(representation.ref)) invalid(`duplicate representation ref ${representation.ref}`)
    representationRefs.add(representation.ref)
    return representation
  }))

  const rawProvenance = plainRecord(source.provenance, "provenance")
  exactKeys(rawProvenance, PROVENANCE_KEYS, "provenance")
  const provenance = Object.freeze(Object.fromEntries(Object.entries({
    provider: text(rawProvenance.provider, 120, "provenance.provider"),
    sourceId: text(rawProvenance.sourceId, 512, "provenance.sourceId", true),
    sourceRevision: text(rawProvenance.sourceRevision, 256, "provenance.sourceRevision", true),
    statement: text(rawProvenance.statement, 500, "provenance.statement", true),
  }).filter(([, value]) => value !== undefined)))

  const mediaType = source.mediaType === undefined ? undefined : text(source.mediaType, 160, "mediaType")
  if (mediaType !== undefined && !MEDIA_TYPE.test(mediaType)) invalid("mediaType is invalid")
  let rasterImage
  if (source.rasterImage !== undefined) {
    try {
      rasterImage = normalizeRasterImageManifest(source.rasterImage, { mediaType })
    } catch (error) {
      invalid(error instanceof Error ? error.message : "rasterImage is invalid")
    }
    if (kind !== "document") invalid("rasterImage is reserved for durable documents")
    const originals = representations.filter((item) => item.kind === "original")
    if (originals.length !== 1
      || originals[0].mediaType !== rasterImage.mediaType
      || originals[0].contentHash !== rasterImage.contentSha256) {
      invalid("rasterImage must match the exact original representation")
    }
  }
  if (kind === "document" && rasterImageTypeForMediaType(mediaType) !== null && rasterImage === undefined) {
    invalid("durable raster image documents require a trusted rasterImage manifest")
  }
  let audioOriginal
  if (source.audioOriginal !== undefined) {
    try {
      audioOriginal = normalizeAudioOriginalManifest(source.audioOriginal, { mediaType })
    } catch (error) {
      invalid(error instanceof Error ? error.message : "audioOriginal is invalid")
    }
    if (kind !== "document") invalid("audioOriginal is reserved for durable documents")
    const originals = representations.filter((item) => item.kind === "original")
    if (originals.length !== 1
      || originals[0].mediaType !== audioOriginal.mediaType
      || originals[0].contentHash !== audioOriginal.contentSha256) {
      invalid("audioOriginal must match the exact original representation")
    }
  }
  if (kind === "document" && mediaType === "audio/webm" && audioOriginal === undefined) {
    invalid("durable WebM/Opus audio documents require a trusted audioOriginal manifest")
  }

  return Object.freeze(Object.fromEntries(Object.entries({
    schemaId: GALAXY_OBJECT_PROJECTION_SCHEMA_ID,
    ref,
    kind,
    revision,
    title: text(source.title, 240, "title"),
    summary: text(source.summary, 4000, "summary", true),
    mediaType,
    representations,
    rasterImage,
    audioOriginal,
    provenance,
    capabilities: stringList(source.capabilities, CAPABILITY_SET, "capabilities"),
  }).filter(([, value]) => value !== undefined)))
}

/**
 * Resolve through a provider-owned, authorization-aware adapter and validate
 * its result. The registry only dispatches; it never grants access or selects
 * a revision on a provider's behalf.
 */
export async function resolveGalaxyObjectProjection(reference, scope, adapters, context) {
  const request = planGalaxyObjectResolution(reference, scope)
  if (!request || !adapters || typeof adapters !== "object" || Array.isArray(adapters)) return null
  const adapter = Object.hasOwn(adapters, request.kind) ? adapters[request.kind] : null
  if (!adapter || typeof adapter.resolve !== "function" || typeof adapter.project !== "function") return null
  const resolved = await adapter.resolve(request, context)
  if (!resolved || resolved.authorized !== true) return null
  return createGalaxyObjectProjection(await adapter.project(request, resolved.value, context))
}

export function projectionToMarkdownCitation(projection) {
  const value = createGalaxyObjectProjection(projection)
  const provenance = value.provenance.provider
  const revision = value.revision.id ? `; revision ${value.revision.id}` : ""
  return `[${value.title}](${value.ref}) — ${provenance}${revision}`
}
