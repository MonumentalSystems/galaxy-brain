import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "./galaxy-object-reference.js"
import { createGalaxyObjectProjection } from "./object-projection.js"
import {
  projectDocumentAnchorObject,
  projectDocumentObject,
  projectChatObject,
  projectElnObject,
  projectElnObservation,
  projectHamMemoryObject,
  projectPaperObject,
  projectProofObject,
  projectSurfaceObject,
  projectTaskObject,
} from "./object-projection-adapters.js"
import { normalizeRasterImageManifest, rasterImageTypeForMediaType } from "./raster-image-contract.js"
import { normalizeAudioOriginalManifest } from "./audio-original-contract.js"
import { BUILTIN_GENEROUS_SURFACE_RENDERER, isCompatibleSurfaceCatalogDigest } from "./surface-renderer-registry.js"

export const GALAXY_OBJECT_PROJECTION_RESOLUTION_REQUEST_SCHEMA_ID =
  "gb.object-projection-resolution-request.v1"
export const GALAXY_OBJECT_PROJECTION_RESOLUTION_RESPONSE_SCHEMA_ID =
  "gb.object-projection-resolution-response.v1"
export const GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID =
  "gb.object-projection-source-request.v3"
export const GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID =
  "gb.object-projection-source-response.v3"
export const GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID_V2 =
  "gb.object-projection-source-request.v2"
export const GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID_V2 =
  "gb.object-projection-source-response.v2"
export const GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID_V1 =
  "gb.object-projection-source-request.v1"
export const GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID_V1 =
  "gb.object-projection-source-response.v1"
export const MAX_OBJECT_PROJECTION_REFERENCES = 64
export const MAX_OBJECT_PROJECTION_REQUEST_BYTES = 65_536
export const MAX_OBJECT_PROJECTION_RESPONSE_BYTES = 2 * 1024 * 1024

const SHA256 = /^[a-f0-9]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;[\x20-\x7e]+)?$/iu
const PROOF_COMPONENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u
const PROVIDERS = Object.freeze({
  paper: "galaxy.paper",
  document: "galaxy.document",
  "document.anchor": "galaxy.document",
  "eln.experiment": "galaxy-brain-eln",
  "eln.observation": "galaxy-brain-eln",
  "ham.task": "ham",
  "ham.memory": "ham",
  surface: "galaxy.surface",
  chat: "galaxy.conversation",
  "proof.graph": "galaxy.proof",
  "proof.node": "galaxy.proof",
})
const SOURCE_KINDS = new Set(Object.keys(PROVIDERS))
const REQUEST_KEYS = new Set(["schemaId", "references"])
const RESPONSE_KEYS = new Set(["schemaId", "results"])
const UNAVAILABLE_KEYS = new Set(["requestedRef", "status"])
const RESOLVED_SOURCE_KEYS = new Set([
  "requestedRef", "status", "resolvedRef", "provider", "sourceKind", "source",
])
const RESOLVED_PROJECTION_KEYS = new Set([
  "requestedRef", "status", "resolvedRef", "provider", "projection", "documentRevisionId", "handles",
])
const RESOLVED_PROJECTION_REQUIRED_KEYS = new Set([
  "requestedRef", "status", "resolvedRef", "provider", "projection", "handles",
])
const HANDLE_KEYS = new Set(["rel", "method", "href"])
const GRAPH_OPEN_KINDS = new Set([
  "paper",
  "document.anchor",
  "eln.experiment",
  "eln.observation",
  "ham.task",
  "ham.memory",
  "task-plan",
  "task-plan.job",
  "surface",
  "chat",
  "proof.graph",
  "proof.node",
])

function invalid(contract, message) {
  throw new TypeError(`Invalid ${contract}: ${message}`)
}

function plainRecord(value, contract, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(contract, `${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(contract, `${label} must be a plain object`)
  }
  return value
}

function exactKeys(value, allowed, contract, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(contract, `${label}.${key} is not part of the contract`)
  }
}

function requireKeys(value, required, contract, label) {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid(contract, `${label}.${key} is required`)
  }
}

function boundedText(value, maximum, contract, label, optional = false) {
  if (optional && (value === undefined || value === null || value === "")) return undefined
  if (typeof value !== "string") invalid(contract, `${label} must be text`)
  const normalized = value.replace(/[\u0000-\u0020\u007f-\u009f]+/gu, " ").trim()
  if (!normalized || Array.from(normalized).length > maximum) {
    invalid(contract, `${label} is outside its bounded text contract`)
  }
  return normalized
}

function positiveInteger(value, maximum, contract, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    invalid(contract, `${label} must be an integer between 1 and ${maximum}`)
  }
  return value
}

function exactBoolean(value, contract, label) {
  if (typeof value !== "boolean") invalid(contract, `${label} must be boolean`)
  return value
}

function sha256(value, contract, label) {
  if (typeof value !== "string" || !SHA256.test(value.toLowerCase())) {
    invalid(contract, `${label} must be an exact SHA-256 digest`)
  }
  return value.toLowerCase()
}

function uuid(value, contract, label) {
  if (typeof value !== "string" || !UUID.test(value)) {
    invalid(contract, `${label} must be a canonical UUID`)
  }
  return value
}

function mediaType(value, contract, label) {
  const normalized = boundedText(value, 160, contract, label)
  if (!MEDIA_TYPE.test(normalized)) invalid(contract, `${label} is not a media type`)
  return normalized
}

function canonicalReference(value, contract, label) {
  const parsed = parseGalaxyObjectReference(value)
  if (!parsed || parsed.format !== "canonical") {
    invalid(contract, `${label} must be a canonical gb.object-ref.v1`)
  }
  const canonical = serializeGalaxyObjectReference(parsed)
  if (canonical !== value) invalid(contract, `${label} must use canonical serialization`)
  return Object.freeze({ wire: canonical, parsed })
}

function normalizeReferences(value, contract) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_OBJECT_PROJECTION_REFERENCES) {
    invalid(contract, `references must contain between 1 and ${MAX_OBJECT_PROJECTION_REFERENCES} items`)
  }
  const seen = new Set()
  return Object.freeze(value.map((reference, index) => {
    const normalized = canonicalReference(reference, contract, `references[${index}]`).wire
    if (seen.has(normalized)) invalid(contract, `references contains duplicate ${normalized}`)
    seen.add(normalized)
    return normalized
  }))
}

function normalizeRequest(input, schemaId) {
  const source = plainRecord(input, schemaId, "request")
  exactKeys(source, REQUEST_KEYS, schemaId, "request")
  requireKeys(source, REQUEST_KEYS, schemaId, "request")
  if (source.schemaId !== schemaId) invalid(schemaId, "unsupported schemaId")
  return Object.freeze({ schemaId, references: normalizeReferences(source.references, schemaId) })
}

export function parseObjectProjectionResolutionRequest(input) {
  return normalizeRequest(input, GALAXY_OBJECT_PROJECTION_RESOLUTION_REQUEST_SCHEMA_ID)
}

export function parseObjectProjectionSourceRequest(input) {
  const schemaId = input?.schemaId
  if (![
    GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID,
    GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID_V2,
    GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID_V1,
  ].includes(schemaId)) {
    invalid(GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID, "unsupported schemaId")
  }
  return normalizeRequest(input, schemaId)
}

export function createObjectProjectionSourceRequest(input) {
  const request = parseObjectProjectionResolutionRequest(input)
  return Object.freeze({
    schemaId: GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID,
    references: request.references,
  })
}

function assertResolutionIdentity(requested, resolved, contract, label) {
  if (requested.parsed.kind !== resolved.parsed.kind || requested.parsed.id !== resolved.parsed.id) {
    invalid(contract, `${label}.resolvedRef changes the requested object identity`)
  }
  if (requested.parsed.selector.mode === "pinned" && requested.wire !== resolved.wire) {
    invalid(contract, `${label}.resolvedRef changes a pinned revision`)
  }
}

function expectedRequestReferences(request, schemaId) {
  if (request === undefined) return null
  if (Array.isArray(request)) return normalizeReferences(request, schemaId)
  if ([
    GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID,
    GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID_V2,
    GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID_V1,
  ].includes(request?.schemaId)) {
    return parseObjectProjectionSourceRequest(request).references
  }
  return parseObjectProjectionResolutionRequest(request).references
}

function expectedResponseSchema(request) {
  if (request?.schemaId === GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID_V1) {
    return GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID_V1
  }
  if (request?.schemaId === GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID_V2) {
    return GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID_V2
  }
  if (
    request?.schemaId === GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID
    || request?.schemaId === GALAXY_OBJECT_PROJECTION_RESOLUTION_REQUEST_SCHEMA_ID
  ) {
    return GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID
  }
  return null
}

function validateOrderedResults(results, expected, contract) {
  if (!Array.isArray(results) || results.length < 1 || results.length > MAX_OBJECT_PROJECTION_REFERENCES) {
    invalid(contract, `results must contain between 1 and ${MAX_OBJECT_PROJECTION_REFERENCES} items`)
  }
  if (expected && results.length !== expected.length) {
    invalid(contract, "results must contain exactly one item for every requested reference")
  }
  const seen = new Set()
  results.forEach((result, index) => {
    if (expected && result.requestedRef !== expected[index]) {
      invalid(contract, `results[${index}].requestedRef is out of order or was not requested`)
    }
    if (seen.has(result.requestedRef)) invalid(contract, "results contains a duplicate requestedRef")
    seen.add(result.requestedRef)
  })
}

function normalizeUnavailable(source, contract, label) {
  exactKeys(source, UNAVAILABLE_KEYS, contract, label)
  requireKeys(source, UNAVAILABLE_KEYS, contract, label)
  if (source.status !== "unavailable") invalid(contract, `${label}.status is unsupported`)
  return Object.freeze({
    requestedRef: canonicalReference(source.requestedRef, contract, `${label}.requestedRef`).wire,
    status: "unavailable",
  })
}

function normalizePaperSource(input, contract, label) {
  const source = plainRecord(input, contract, label)
  exactKeys(source, new Set(["paper", "revision"]), contract, label)
  requireKeys(source, new Set(["paper", "revision"]), contract, label)
  const paper = plainRecord(source.paper, contract, `${label}.paper`)
  exactKeys(paper, new Set(["id", "title", "abstract", "metadataHash"]), contract, `${label}.paper`)
  requireKeys(paper, new Set(["id", "title", "metadataHash"]), contract, `${label}.paper`)
  const normalizedPaper = Object.freeze(Object.fromEntries(Object.entries({
    id: boundedText(paper.id, 512, contract, `${label}.paper.id`),
    title: boundedText(paper.title, 240, contract, `${label}.paper.title`),
    abstract: boundedText(paper.abstract, 4000, contract, `${label}.paper.abstract`, true),
    metadataHash: sha256(paper.metadataHash, contract, `${label}.paper.metadataHash`),
  }).filter(([, value]) => value !== undefined)))
  if (source.revision === null) return Object.freeze({ paper: normalizedPaper, revision: null })
  const revision = plainRecord(source.revision, contract, `${label}.revision`)
  exactKeys(revision, new Set(["id", "metadataHash", "document"]), contract, `${label}.revision`)
  requireKeys(revision, new Set(["id", "metadataHash"]), contract, `${label}.revision`)
  let document = null
  if (revision.document !== undefined && revision.document !== null) {
    const rawDocument = plainRecord(revision.document, contract, `${label}.revision.document`)
    if (contract === GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID_V1) {
      const legacyKeys = new Set(["contentSha256", "mediaType", "filename"])
      exactKeys(rawDocument, legacyKeys, contract, `${label}.revision.document`)
      requireKeys(rawDocument, legacyKeys, contract, `${label}.revision.document`)
      sha256(rawDocument.contentSha256, contract, `${label}.revision.document.contentSha256`)
      mediaType(rawDocument.mediaType, contract, `${label}.revision.document.mediaType`)
      boundedText(rawDocument.filename, 512, contract, `${label}.revision.document.filename`)
    } else {
      const documentKeys = new Set([
        "ref", "documentId", "revisionId", "revisionSha256",
        "contentSha256", "mediaType", "displayFilename",
      ])
      exactKeys(rawDocument, documentKeys, contract, `${label}.revision.document`)
      requireKeys(rawDocument, documentKeys, contract, `${label}.revision.document`)
      const documentId = uuid(rawDocument.documentId, contract, `${label}.revision.document.documentId`)
      const revisionId = uuid(rawDocument.revisionId, contract, `${label}.revision.document.revisionId`)
      const revisionSha256 = sha256(rawDocument.revisionSha256, contract, `${label}.revision.document.revisionSha256`)
      const documentReference = canonicalReference(rawDocument.ref, contract, `${label}.revision.document.ref`)
      if (
        documentReference.parsed.kind !== "document"
        || documentReference.parsed.id !== documentId
        || documentReference.parsed.selector.mode !== "pinned"
        || documentReference.parsed.selector.revision !== `sha256:${revisionSha256}`
      ) invalid(contract, `${label}.revision.document.ref does not pin the supplied document revision`)
      document = Object.freeze({
        ref: documentReference.wire,
        documentId,
        revisionId,
        revisionSha256,
        contentSha256: sha256(rawDocument.contentSha256, contract, `${label}.revision.document.contentSha256`),
        mediaType: mediaType(rawDocument.mediaType, contract, `${label}.revision.document.mediaType`),
        displayFilename: boundedText(rawDocument.displayFilename, 512, contract, `${label}.revision.document.displayFilename`),
      })
    }
  }
  return Object.freeze({
    paper: normalizedPaper,
    revision: Object.freeze({
      id: boundedText(revision.id, 512, contract, `${label}.revision.id`),
      metadataHash: sha256(revision.metadataHash, contract, `${label}.revision.metadataHash`),
      document,
    }),
  })
}

function normalizeDocumentSource(input, contract, label) {
  const source = plainRecord(input, contract, label)
  const keys = new Set([
    "documentId", "revisionId", "revisionSha256", "title", "displayFilename", "summary", "mediaType", "representations",
    "rasterImage", "audioOriginal",
  ])
  exactKeys(source, keys, contract, label)
  requireKeys(source, new Set(["documentId", "revisionId", "revisionSha256", "title", "mediaType", "representations"]), contract, label)
  if (!Array.isArray(source.representations) || source.representations.length > 32) {
    invalid(contract, `${label}.representations must be an array of at most 32 items`)
  }
  const seen = new Set()
  const representations = Object.freeze(source.representations.map((item, index) => {
    const raw = plainRecord(item, contract, `${label}.representations[${index}]`)
    const representationKeys = new Set(["id", "kind", "mediaType", "contentSha256", "label"])
    exactKeys(raw, representationKeys, contract, `${label}.representations[${index}]`)
    requireKeys(raw, new Set(["id", "kind", "mediaType", "contentSha256"]), contract, `${label}.representations[${index}]`)
    const id = boundedText(raw.id, 512, contract, `${label}.representations[${index}].id`)
    if (seen.has(id)) invalid(contract, `${label}.representations contains duplicate id ${id}`)
    seen.add(id)
    if (!["original", "document-structure", "markdown", "text", "thumbnail"].includes(raw.kind)) {
      invalid(contract, `${label}.representations[${index}].kind is unsupported`)
    }
    return Object.freeze(Object.fromEntries(Object.entries({
      id,
      kind: raw.kind,
      mediaType: mediaType(raw.mediaType, contract, `${label}.representations[${index}].mediaType`),
      contentSha256: sha256(raw.contentSha256, contract, `${label}.representations[${index}].contentSha256`),
      label: boundedText(raw.label, 120, contract, `${label}.representations[${index}].label`, true),
    }).filter(([, value]) => value !== undefined)))
  }))
  let rasterImage
  if (source.rasterImage !== undefined) {
    try {
      rasterImage = normalizeRasterImageManifest(source.rasterImage, {
        mediaType: source.mediaType,
      })
    } catch (error) {
      invalid(contract, error instanceof Error ? `${label}.${error.message}` : `${label}.rasterImage is invalid`)
    }
    const originals = representations.filter((item) => item.kind === "original")
    if (originals.length !== 1 || originals[0].contentSha256 !== rasterImage.contentSha256) {
      invalid(contract, `${label}.rasterImage must match the exact original representation`)
    }
  }
  if (rasterImageTypeForMediaType(source.mediaType) !== null && rasterImage === undefined) {
    invalid(contract, `${label}.rasterImage is required for durable raster image documents`)
  }
  let audioOriginal
  if (source.audioOriginal !== undefined) {
    try {
      audioOriginal = normalizeAudioOriginalManifest(source.audioOriginal, { mediaType: source.mediaType })
    } catch (error) {
      invalid(contract, error instanceof Error ? `${label}.${error.message}` : `${label}.audioOriginal is invalid`)
    }
    const originals = representations.filter((item) => item.kind === "original")
    if (originals.length !== 1 || originals[0].contentSha256 !== audioOriginal.contentSha256
      || originals[0].mediaType !== audioOriginal.mediaType) {
      invalid(contract, `${label}.audioOriginal must match the exact original representation`)
    }
  }
  if (source.mediaType === "audio/webm" && audioOriginal === undefined) {
    invalid(contract, `${label}.audioOriginal is required for durable WebM/Opus audio documents`)
  }
  return Object.freeze(Object.fromEntries(Object.entries({
    documentId: boundedText(source.documentId, 512, contract, `${label}.documentId`),
    revisionId: uuid(source.revisionId, contract, `${label}.revisionId`),
    revisionSha256: sha256(source.revisionSha256, contract, `${label}.revisionSha256`),
    title: boundedText(source.title, 240, contract, `${label}.title`),
    displayFilename: boundedText(source.displayFilename, 240, contract, `${label}.displayFilename`, true),
    summary: boundedText(source.summary, 4000, contract, `${label}.summary`, true),
    mediaType: mediaType(source.mediaType, contract, `${label}.mediaType`),
    representations,
    rasterImage,
    audioOriginal,
  }).filter(([, value]) => value !== undefined)))
}

function normalizeDocumentAnchorSource(input, contract, label) {
  const source = plainRecord(input, contract, label)
  const keys = new Set(["id", "representationSha256", "anchorSha256", "title", "selector"])
  exactKeys(source, keys, contract, label)
  requireKeys(source, new Set(["id", "representationSha256", "anchorSha256", "selector"]), contract, label)
  const anchorSha256 = sha256(source.anchorSha256, contract, `${label}.anchorSha256`)
  const id = boundedText(source.id, 512, contract, `${label}.id`)
  if (id !== `sha256:${anchorSha256}`) invalid(contract, `${label}.id must match anchorSha256`)
  const selector = plainRecord(source.selector, contract, `${label}.selector`)
  let normalizedSelector
  if (selector.kind === "page-region") {
    exactKeys(selector, new Set(["kind", "page"]), contract, `${label}.selector`)
    requireKeys(selector, new Set(["kind", "page"]), contract, `${label}.selector`)
    normalizedSelector = Object.freeze({
      kind: "page-region",
      page: positiveInteger(selector.page, 1_000_000, contract, `${label}.selector.page`),
    })
  } else if (selector.kind === "text-quote") {
    exactKeys(selector, new Set(["kind", "exact"]), contract, `${label}.selector`)
    requireKeys(selector, new Set(["kind", "exact"]), contract, `${label}.selector`)
    normalizedSelector = Object.freeze({
      kind: "text-quote",
      exact: boundedText(selector.exact, 4000, contract, `${label}.selector.exact`),
    })
  } else if (selector.kind === "json-pointer") {
    exactKeys(selector, new Set(["kind", "pointer"]), contract, `${label}.selector`)
    requireKeys(selector, new Set(["kind", "pointer"]), contract, `${label}.selector`)
    const pointer = boundedText(selector.pointer, 2048, contract, `${label}.selector.pointer`)
    if (!pointer.startsWith("/")) invalid(contract, `${label}.selector.pointer must be a JSON pointer`)
    normalizedSelector = Object.freeze({ kind: "json-pointer", pointer })
  } else {
    invalid(contract, `${label}.selector.kind is unsupported`)
  }
  return Object.freeze(Object.fromEntries(Object.entries({
    id,
    representationSha256: sha256(source.representationSha256, contract, `${label}.representationSha256`),
    anchorSha256,
    title: boundedText(source.title, 160, contract, `${label}.title`, true),
    selector: normalizedSelector,
  }).filter(([, value]) => value !== undefined)))
}

function normalizeElnSource(input, contract, label) {
  const source = plainRecord(input, contract, label)
  const keys = new Set(["id", "title", "results", "interpretation", "updatedAt"])
  exactKeys(source, keys, contract, label)
  requireKeys(source, new Set(["id", "title", "updatedAt"]), contract, label)
  return Object.freeze({
    id: boundedText(source.id, 512, contract, `${label}.id`),
    title: boundedText(source.title, 240, contract, `${label}.title`),
    results: boundedText(source.results, 4000, contract, `${label}.results`, true),
    interpretation: boundedText(source.interpretation, 4000, contract, `${label}.interpretation`, true),
    updatedAt: boundedText(source.updatedAt, 256, contract, `${label}.updatedAt`),
  })
}

function normalizeElnObservationSource(input, contract, label) {
  const source = plainRecord(input, contract, label)
  const keys = new Set([
    "id", "experimentId", "version", "revisionSha256", "body",
    "observedAt", "createdAt", "createdByPrincipalId",
  ])
  exactKeys(source, keys, contract, label)
  requireKeys(source, keys, contract, label)
  return Object.freeze({
    id: uuid(source.id, contract, `${label}.id`),
    experimentId: boundedText(source.experimentId, 512, contract, `${label}.experimentId`),
    version: positiveInteger(source.version, Number.MAX_SAFE_INTEGER, contract, `${label}.version`),
    revisionSha256: sha256(source.revisionSha256, contract, `${label}.revisionSha256`),
    body: boundedText(source.body, 4000, contract, `${label}.body`),
    observedAt: boundedText(source.observedAt, 256, contract, `${label}.observedAt`),
    createdAt: boundedText(source.createdAt, 256, contract, `${label}.createdAt`),
    createdByPrincipalId: uuid(source.createdByPrincipalId, contract, `${label}.createdByPrincipalId`),
  })
}

function normalizeHamTaskSource(input, contract, label) {
  const source = plainRecord(input, contract, label)
  const keys = new Set(["id", "title", "goal", "why", "version"])
  exactKeys(source, keys, contract, label)
  requireKeys(source, new Set(["id", "title"]), contract, label)
  return Object.freeze(Object.fromEntries(Object.entries({
    id: boundedText(source.id, 512, contract, `${label}.id`),
    title: boundedText(source.title, 240, contract, `${label}.title`),
    goal: boundedText(source.goal, 4000, contract, `${label}.goal`, true),
    why: boundedText(source.why, 4000, contract, `${label}.why`, true),
    version: source.version === undefined
      ? undefined
      : positiveInteger(source.version, Number.MAX_SAFE_INTEGER, contract, `${label}.version`),
  }).filter(([, value]) => value !== undefined)))
}

function normalizeHamMemorySource(input, contract, label) {
  const source = plainRecord(input, contract, label)
  const keys = new Set(["id", "title", "content", "version"])
  exactKeys(source, keys, contract, label)
  requireKeys(source, new Set(["id", "title", "content"]), contract, label)
  return Object.freeze(Object.fromEntries(Object.entries({
    id: boundedText(source.id, 512, contract, `${label}.id`),
    title: boundedText(source.title, 240, contract, `${label}.title`),
    content: boundedText(source.content, 4000, contract, `${label}.content`),
    version: source.version === undefined
      ? undefined
      : positiveInteger(source.version, Number.MAX_SAFE_INTEGER, contract, `${label}.version`),
  }).filter(([, value]) => value !== undefined)))
}

function normalizeSurfaceSource(input, contract, label) {
  const source = plainRecord(input, contract, label)
  const baseKeys = new Set([
    "id", "title", "status", "catalogId", "currentVersion", "currentContentHash",
  ])
  const v2Keys = new Set([
    ...baseKeys, "schemaDigest", "catalogDigest", "rendererVersion", "placementEligible",
  ])
  const keys = contract === GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID ? v2Keys : baseKeys
  exactKeys(source, keys, contract, label)
  requireKeys(source, keys, contract, label)
  if (!["draft", "promoted", "archived"].includes(source.status)) {
    invalid(contract, `${label}.status is unsupported`)
  }
  if (source.catalogId !== "generous.a2ui") invalid(contract, `${label}.catalogId is unsupported`)
  return Object.freeze({
    id: boundedText(source.id, 512, contract, `${label}.id`),
    title: boundedText(source.title, 240, contract, `${label}.title`),
    status: source.status,
    catalogId: source.catalogId,
    currentVersion: positiveInteger(source.currentVersion, Number.MAX_SAFE_INTEGER, contract, `${label}.currentVersion`),
    currentContentHash: sha256(source.currentContentHash, contract, `${label}.currentContentHash`),
    schemaDigest: source.schemaDigest === undefined
      ? undefined
      : sha256(source.schemaDigest, contract, `${label}.schemaDigest`),
    catalogDigest: source.catalogDigest === undefined
      ? undefined
      : sha256(source.catalogDigest, contract, `${label}.catalogDigest`),
    rendererVersion: source.rendererVersion === undefined
      ? undefined
      : boundedText(source.rendererVersion, 200, contract, `${label}.rendererVersion`),
    placementEligible: source.placementEligible === undefined
      ? false
      : exactBoolean(source.placementEligible, contract, `${label}.placementEligible`),
  })
}

function normalizeChatSource(input, contract, label) {
  const source = plainRecord(input, contract, label)
  const keys = new Set([
    "conversationId", "workspaceId", "title", "goalSummary", "version",
    "contentSha256", "turnCount", "branchCount",
  ])
  exactKeys(source, keys, contract, label)
  requireKeys(source, keys, contract, label)
  const version = positiveInteger(source.version, 1_000_001, contract, `${label}.version`)
  const turnCount = Number.isSafeInteger(source.turnCount) && source.turnCount >= 0 && source.turnCount <= 1_000_000
    ? source.turnCount
    : invalid(contract, `${label}.turnCount is invalid`)
  if (turnCount !== version - 1) invalid(contract, `${label}.turnCount must match version`)
  const workspaceId = boundedText(source.workspaceId, 128, contract, `${label}.workspaceId`)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(workspaceId)) {
    invalid(contract, `${label}.workspaceId is invalid`)
  }
  const branchCount = Number.isSafeInteger(source.branchCount) && source.branchCount >= 0 && source.branchCount <= turnCount
    ? source.branchCount
    : invalid(contract, `${label}.branchCount is invalid`)
  return Object.freeze({
    conversationId: uuid(source.conversationId, contract, `${label}.conversationId`),
    workspaceId,
    title: boundedText(source.title, 240, contract, `${label}.title`),
    goalSummary: boundedText(source.goalSummary, 4000, contract, `${label}.goalSummary`),
    version,
    contentSha256: sha256(source.contentSha256, contract, `${label}.contentSha256`),
    turnCount,
    branchCount,
  })
}

function normalizeProofSource(input, sourceKind, contract, label) {
  const source = plainRecord(input, contract, label)
  const identityKey = sourceKind === "proof.graph" ? "graphId" : "nodeRefId"
  const keys = new Set([identityKey, "contentSha256", "title", "objective", "summary"])
  exactKeys(source, keys, contract, label)
  requireKeys(source, new Set([identityKey, "contentSha256", "title"]), contract, label)
  const identity = boundedText(source[identityKey], 512, contract, `${label}.${identityKey}`)
  if (sourceKind === "proof.graph" && !PROOF_COMPONENT_ID.test(identity)) {
    invalid(contract, `${label}.graphId is not canonical`)
  }
  return Object.freeze(Object.fromEntries(Object.entries({
    [identityKey]: identity,
    contentSha256: sha256(source.contentSha256, contract, `${label}.contentSha256`),
    title: boundedText(source.title, 240, contract, `${label}.title`),
    objective: boundedText(source.objective, 4000, contract, `${label}.objective`, true),
    summary: boundedText(source.summary, 4000, contract, `${label}.summary`, true),
  }).filter(([, value]) => value !== undefined)))
}

function normalizeProjectorSource(input, sourceKind, contract, label) {
  if (sourceKind === "paper") return normalizePaperSource(input, contract, label)
  if (sourceKind === "document") return normalizeDocumentSource(input, contract, label)
  if (sourceKind === "document.anchor") return normalizeDocumentAnchorSource(input, contract, label)
  if (sourceKind === "eln.experiment") return normalizeElnSource(input, contract, label)
  if (sourceKind === "eln.observation") return normalizeElnObservationSource(input, contract, label)
  if (sourceKind === "ham.task") return normalizeHamTaskSource(input, contract, label)
  if (sourceKind === "ham.memory") return normalizeHamMemorySource(input, contract, label)
  if (sourceKind === "surface") return normalizeSurfaceSource(input, contract, label)
  if (sourceKind === "chat") return normalizeChatSource(input, contract, label)
  if (sourceKind === "proof.graph" || sourceKind === "proof.node") {
    return normalizeProofSource(input, sourceKind, contract, label)
  }
  invalid(contract, `${label} has no registered canonical projector`)
}

function normalizeResolvedSource(source, contract, label) {
  exactKeys(source, RESOLVED_SOURCE_KEYS, contract, label)
  requireKeys(source, RESOLVED_SOURCE_KEYS, contract, label)
  if (source.status !== "resolved") invalid(contract, `${label}.status is unsupported`)
  if (!SOURCE_KINDS.has(source.sourceKind)) invalid(contract, `${label}.sourceKind is unsupported`)
  if (source.provider !== PROVIDERS[source.sourceKind]) {
    invalid(contract, `${label}.provider does not own ${source.sourceKind}`)
  }
  const requested = canonicalReference(source.requestedRef, contract, `${label}.requestedRef`)
  const resolved = canonicalReference(source.resolvedRef, contract, `${label}.resolvedRef`)
  assertResolutionIdentity(requested, resolved, contract, label)
  if (resolved.parsed.kind !== source.sourceKind) {
    invalid(contract, `${label}.sourceKind must match resolvedRef kind`)
  }
  const normalizedSource = normalizeProjectorSource(source.source, source.sourceKind, contract, `${label}.source`)
  if (source.sourceKind === "document") {
    if (
      resolved.parsed.selector.mode !== "pinned"
      || normalizedSource.documentId !== resolved.parsed.id
      || `sha256:${normalizedSource.revisionSha256}` !== resolved.parsed.selector.revision
    ) {
      invalid(contract, `${label}.source does not match the pinned document reference`)
    }
  }
  if (source.sourceKind === "chat") {
    if (
      resolved.parsed.selector.mode !== "pinned"
      || normalizedSource.conversationId !== resolved.parsed.id
      || `sha256:${normalizedSource.contentSha256}` !== resolved.parsed.selector.revision
    ) {
      invalid(contract, `${label}.source does not match the pinned conversation reference`)
    }
  }
  if (source.sourceKind === "eln.observation") {
    if (
      resolved.parsed.selector.mode !== "pinned"
      || normalizedSource.id !== resolved.parsed.id
      || `sha256:${normalizedSource.revisionSha256}` !== resolved.parsed.selector.revision
    ) invalid(contract, `${label}.source does not match the pinned observation reference`)
  }
  return Object.freeze({
    requestedRef: requested.wire,
    status: "resolved",
    resolvedRef: resolved.wire,
    provider: source.provider,
    sourceKind: source.sourceKind,
    source: normalizedSource,
  })
}

export function parseObjectProjectionSourceResponse(input, request) {
  const candidate = plainRecord(input, GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID, "response")
  const contract = candidate.schemaId
  if (![
    GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID,
    GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID_V2,
    GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID_V1,
  ].includes(contract)) {
    invalid(GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID, "unsupported schemaId")
  }
  const expectedContract = expectedResponseSchema(request)
  if (expectedContract !== null && contract !== expectedContract) {
    invalid(expectedContract, "response schema does not match request schema")
  }
  const source = candidate
  exactKeys(source, RESPONSE_KEYS, contract, "response")
  requireKeys(source, RESPONSE_KEYS, contract, "response")
  if (source.schemaId !== contract) invalid(contract, "unsupported schemaId")
  if (!Array.isArray(source.results)) invalid(contract, "results must be an array")
  const results = Object.freeze(source.results.map((item, index) => {
    const raw = plainRecord(item, contract, `results[${index}]`)
    return raw.status === "unavailable"
      ? normalizeUnavailable(raw, contract, `results[${index}]`)
      : normalizeResolvedSource(raw, contract, `results[${index}]`)
  }))
  validateOrderedResults(results, expectedRequestReferences(request, contract), contract)
  return Object.freeze({ schemaId: contract, results })
}

function projectSource(result) {
  const source = result.source
  if (result.sourceKind === "paper") {
    return projectPaperObject({
      paper: {
        id: source.paper.id,
        title: source.paper.title,
        abstract: source.paper.abstract,
        metadata_hash: source.paper.metadataHash,
      },
      revision: source.revision === null ? null : {
        id: source.revision.id,
        metadata_hash: source.revision.metadataHash,
        document: source.revision.document === null ? null : {
          ref: source.revision.document.ref,
          document_id: source.revision.document.documentId,
          revision_id: source.revision.document.revisionId,
          revision_sha256: source.revision.document.revisionSha256,
          content_sha256: source.revision.document.contentSha256,
          media_type: source.revision.document.mediaType,
          display_filename: source.revision.document.displayFilename,
        },
      },
    })
  }
  if (result.sourceKind === "document") {
    return projectDocumentObject({
      document_id: source.documentId,
      revision_sha256: source.revisionSha256,
      title: source.title,
      summary: source.summary,
      display_filename: source.displayFilename,
      media_type: source.mediaType,
      raster_image: source.rasterImage,
      audio_original: source.audioOriginal,
      representations: source.representations.map((item) => ({
        id: item.id,
        kind: item.kind,
        media_type: item.mediaType,
        content_sha256: item.contentSha256,
        label: item.label,
      })),
    })
  }
  if (result.sourceKind === "document.anchor") {
    return projectDocumentAnchorObject({
      id: source.id,
      representation_sha256: source.representationSha256,
      anchor_sha256: source.anchorSha256,
      title: source.title,
      selector: source.selector,
    })
  }
  if (result.sourceKind === "eln.experiment") {
    const sections = []
    if (source.results) sections.push({ key: "results", title: "Results", content: source.results })
    if (source.interpretation) {
      sections.push({ key: "interpretation", title: "Interpretation", content: source.interpretation })
    }
    return projectElnObject({
      id: source.id,
      title: source.title,
      sections,
      provenance: { source: result.provider, updatedAt: source.updatedAt },
    })
  }
  if (result.sourceKind === "eln.observation") return projectElnObservation(source)
  if (result.sourceKind === "ham.task") return projectTaskObject(source)
  if (result.sourceKind === "chat") return projectChatObject(source)
  if (result.sourceKind === "ham.memory") return projectHamMemoryObject(source)
  if (result.sourceKind === "surface") {
    const contractCompatible = (
      source.schemaDigest === BUILTIN_GENEROUS_SURFACE_RENDERER.schemaDigest
      && isCompatibleSurfaceCatalogDigest(source.catalogDigest)
      && source.rendererVersion === BUILTIN_GENEROUS_SURFACE_RENDERER.rendererVersion
    )
    return projectSurfaceObject({
      id: source.id,
      title: source.title,
      status: source.status,
      catalog_id: source.catalogId,
      current_version: source.currentVersion,
      current_content_hash: source.currentContentHash,
      placement_eligible: source.placementEligible && contractCompatible,
    })
  }
  if (result.sourceKind === "proof.graph" || result.sourceKind === "proof.node") {
    return projectProofObject({ ...source, provider: result.provider })
  }
  throw new TypeError("Unsupported canonical projector source")
}

export function createObjectProjectionOpenHandles(resolvedRef, documentRevisionId) {
  const contract = GALAXY_OBJECT_PROJECTION_RESOLUTION_RESPONSE_SCHEMA_ID
  const canonical = canonicalReference(resolvedRef, contract, "resolvedRef")
  if (canonical.parsed.kind === "document") {
    if (canonical.parsed.selector.mode !== "pinned") {
      invalid(contract, "document open handles require a pinned canonical reference")
    }
    const revisionId = uuid(documentRevisionId, contract, "documentRevisionId")
    return Object.freeze([Object.freeze({
      rel: "open",
      method: "GET",
      href: `/documents/${revisionId}`,
    })])
  }
  if (documentRevisionId !== undefined) {
    invalid(contract, "documentRevisionId is only valid for document projections")
  }
  if (canonical.parsed.kind === "chat") {
    const query = new URLSearchParams({
      mode: "conversation",
      conversation: canonical.wire,
      ref: canonical.wire,
      scale: "task",
    })
    return Object.freeze([Object.freeze({
      rel: "open",
      method: "GET",
      href: `/graph?${query}`,
    })])
  }
  if (!GRAPH_OPEN_KINDS.has(canonical.parsed.kind)) return Object.freeze([])
  return Object.freeze([Object.freeze({
    rel: "open",
    method: "GET",
    href: `/graph?ref=${encodeURIComponent(canonical.wire)}`,
  })])
}

function normalizeHandles(input, resolvedRef, documentRevisionId, contract, label) {
  const expected = createObjectProjectionOpenHandles(resolvedRef, documentRevisionId)
  if (!Array.isArray(input) || input.length !== expected.length) {
    invalid(contract, expected.length === 0
      ? `${label} must be empty because this object kind has no exact-reference loader`
      : `${label} must contain exactly the fixed open handle`)
  }
  if (expected.length === 0) return Object.freeze([])
  const source = plainRecord(input[0], contract, `${label}[0]`)
  exactKeys(source, HANDLE_KEYS, contract, `${label}[0]`)
  requireKeys(source, HANDLE_KEYS, contract, `${label}[0]`)
  const expectedHandle = expected[0]
  if (source.rel !== expectedHandle.rel || source.method !== expectedHandle.method || source.href !== expectedHandle.href) {
    invalid(contract, `${label}[0] must be the fixed same-origin open handle`)
  }
  return Object.freeze([expectedHandle])
}

function normalizeResolvedProjection(source, contract, label) {
  exactKeys(source, RESOLVED_PROJECTION_KEYS, contract, label)
  requireKeys(source, RESOLVED_PROJECTION_REQUIRED_KEYS, contract, label)
  if (source.status !== "resolved") invalid(contract, `${label}.status is unsupported`)
  const requested = canonicalReference(source.requestedRef, contract, `${label}.requestedRef`)
  const resolved = canonicalReference(source.resolvedRef, contract, `${label}.resolvedRef`)
  assertResolutionIdentity(requested, resolved, contract, label)
  const provider = boundedText(source.provider, 120, contract, `${label}.provider`)
  const projection = createGalaxyObjectProjection(source.projection)
  if (projection.ref !== resolved.wire) invalid(contract, `${label}.projection.ref must equal resolvedRef`)
  if (projection.kind !== resolved.parsed.kind) invalid(contract, `${label}.projection.kind must match resolvedRef`)
  if (projection.provenance.provider !== provider) {
    invalid(contract, `${label}.provider must match projection provenance`)
  }
  const documentRevisionId = resolved.parsed.kind === "document"
    ? uuid(source.documentRevisionId, contract, `${label}.documentRevisionId`)
    : undefined
  if (resolved.parsed.kind !== "document" && Object.hasOwn(source, "documentRevisionId")) {
    invalid(contract, `${label}.documentRevisionId is only valid for document projections`)
  }
  return Object.freeze({
    requestedRef: requested.wire,
    status: "resolved",
    resolvedRef: resolved.wire,
    provider,
    projection,
    ...(documentRevisionId ? { documentRevisionId } : {}),
    handles: normalizeHandles(source.handles, resolved.wire, documentRevisionId, contract, `${label}.handles`),
  })
}

export function parseObjectProjectionResolutionResponse(input, request) {
  const contract = GALAXY_OBJECT_PROJECTION_RESOLUTION_RESPONSE_SCHEMA_ID
  const source = plainRecord(input, contract, "response")
  exactKeys(source, RESPONSE_KEYS, contract, "response")
  requireKeys(source, RESPONSE_KEYS, contract, "response")
  if (source.schemaId !== contract) invalid(contract, "unsupported schemaId")
  if (!Array.isArray(source.results)) invalid(contract, "results must be an array")
  const results = Object.freeze(source.results.map((item, index) => {
    const raw = plainRecord(item, contract, `results[${index}]`)
    return raw.status === "unavailable"
      ? normalizeUnavailable(raw, contract, `results[${index}]`)
      : normalizeResolvedProjection(raw, contract, `results[${index}]`)
  }))
  validateOrderedResults(results, expectedRequestReferences(request, contract), contract)
  return Object.freeze({ schemaId: contract, results })
}

export function assembleObjectProjectionResolutionResponse(requestInput, sourceResponseInput) {
  const request = parseObjectProjectionResolutionRequest(requestInput)
  const sourceRequest = createObjectProjectionSourceRequest(request)
  const sourceResponse = parseObjectProjectionSourceResponse(sourceResponseInput, sourceRequest)
  const results = sourceResponse.results.map((result) => {
    if (result.status === "unavailable") return result
    const projection = createGalaxyObjectProjection(projectSource(result))
    if (projection.ref !== result.resolvedRef) {
      invalid(
        GALAXY_OBJECT_PROJECTION_RESOLUTION_RESPONSE_SCHEMA_ID,
        `projector for ${result.sourceKind} changed the resolver-owned identity`,
      )
    }
    if (projection.provenance.provider !== result.provider) {
      invalid(
        GALAXY_OBJECT_PROJECTION_RESOLUTION_RESPONSE_SCHEMA_ID,
        `projector for ${result.sourceKind} changed the resolver-owned provider`,
      )
    }
    const documentRevisionId = result.sourceKind === "document" ? result.source.revisionId : undefined
    return {
      requestedRef: result.requestedRef,
      status: "resolved",
      resolvedRef: result.resolvedRef,
      provider: result.provider,
      projection,
      ...(documentRevisionId ? { documentRevisionId } : {}),
      handles: createObjectProjectionOpenHandles(result.resolvedRef, documentRevisionId),
    }
  })
  return parseObjectProjectionResolutionResponse({
    schemaId: GALAXY_OBJECT_PROJECTION_RESOLUTION_RESPONSE_SCHEMA_ID,
    results,
  }, request)
}

export function serializeObjectProjectionResolutionResponse(input, request) {
  const response = parseObjectProjectionResolutionResponse(input, request)
  const serialized = JSON.stringify(response)
  const byteLength = new TextEncoder().encode(serialized).byteLength
  if (byteLength > MAX_OBJECT_PROJECTION_RESPONSE_BYTES) {
    throw new RangeError(
      `${GALAXY_OBJECT_PROJECTION_RESOLUTION_RESPONSE_SCHEMA_ID} exceeds ${MAX_OBJECT_PROJECTION_RESPONSE_BYTES} bytes`,
    )
  }
  return serialized
}
