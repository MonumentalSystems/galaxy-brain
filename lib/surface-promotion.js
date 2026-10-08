import { projectSurface } from "./surface-projection.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256 = /^[0-9a-f]{64}$/u

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function definitionMatches(value, reviewed, expectedVersion) {
  if (!isRecord(value)
    || value.surface_id !== reviewed.surface_id
    || value.version !== expectedVersion
    || value.title !== reviewed.title
    || value.status !== "promoted"
    || typeof value.content_hash !== "string" || !SHA256.test(value.content_hash)
    || typeof value.schema_digest !== "string" || !SHA256.test(value.schema_digest)
    || typeof value.catalog_digest !== "string" || !SHA256.test(value.catalog_digest)
    || typeof value.renderer_version !== "string" || value.renderer_version.length === 0
    || !projectSurface(value.spec).ok
    || stableJson(value.spec) !== stableJson(reviewed.spec)) return false
  return provenanceMatches(value.provenance, surfacePromotionProvenance(reviewed.provenance))
}

function validSurfaceRecord(value, surfaceId) {
  return isRecord(value)
    && value.id === surfaceId
    && typeof value.title === "string" && value.title.length > 0
    && ["draft", "promoted", "archived"].includes(value.status)
    && value.schema_version === "gb.surface.v1"
    && value.catalog_id === "generous.a2ui"
    && value.catalog_version === "1"
    && typeof value.schema_digest === "string" && SHA256.test(value.schema_digest)
    && typeof value.catalog_digest === "string" && SHA256.test(value.catalog_digest)
    && typeof value.renderer_version === "string" && value.renderer_version.length > 0
    && Number.isSafeInteger(value.current_version) && value.current_version >= 1
    && typeof value.current_content_hash === "string" && SHA256.test(value.current_content_hash)
    && projectSurface(value.current_spec).ok
    && isRecord(value.provenance)
}

function currentMatchesPromotedRevision(value, revision) {
  return value.current_version === revision.version
    && value.current_content_hash === revision.content_hash
    && value.title === revision.title
    && value.status === revision.status
    && value.schema_digest === revision.schema_digest
    && value.catalog_digest === revision.catalog_digest
    && value.renderer_version === revision.renderer_version
    && stableJson(value.current_spec) === stableJson(revision.spec)
    && stableJson(value.provenance) === stableJson(revision.provenance)
}

function provenanceMatches(value, expected) {
  if (!isRecord(value) || !isRecord(value.galaxy) || value.galaxy.event !== "promoted") return false
  return stableJson(surfacePromotionProvenance(value)) === stableJson(expected)
}

function validReviewedRevision(value) {
  return isRecord(value)
    && typeof value.surface_id === "string" && UUID.test(value.surface_id)
    && value.status === "draft"
    && Number.isSafeInteger(value.version) && value.version >= 1
    && typeof value.title === "string" && value.title.length > 0
    && typeof value.content_hash === "string" && SHA256.test(value.content_hash)
    && typeof value.schema_digest === "string" && SHA256.test(value.schema_digest)
    && typeof value.catalog_digest === "string" && SHA256.test(value.catalog_digest)
    && typeof value.renderer_version === "string" && value.renderer_version.length > 0
    && projectSurface(value.spec).ok
    && isRecord(value.provenance)
}

export function surfacePromotionProvenance(value) {
  if (!isRecord(value)) return {}
  const allowed = [
    "source",
    "model",
    "profile",
    "run_id",
    "message_id",
    "prompt_hash",
    "evidence_refs",
    "ham_refs",
    "actor_ref",
    "note",
  ]
  return Object.fromEntries(allowed.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]))
}

export function surfaceHeadMatchesReview(value, reviewed) {
  return validSurfaceRecord(value, reviewed?.surface_id)
    && validReviewedRevision(reviewed)
    && value.status === "draft"
    && value.current_version === reviewed.version
    && value.current_content_hash === reviewed.content_hash
    && value.title === reviewed.title
    && value.schema_digest === reviewed.schema_digest
    && value.catalog_digest === reviewed.catalog_digest
    && value.renderer_version === reviewed.renderer_version
    && stableJson(value.current_spec) === stableJson(reviewed.spec)
    && stableJson(value.provenance) === stableJson(reviewed.provenance)
}

export function normalizeSurfacePromotionResponse(value, reviewed) {
  if (!validReviewedRevision(reviewed)
    || !validSurfaceRecord(value, reviewed.surface_id)) {
    throw new TypeError("Surface promotion response does not match the reviewed draft")
  }

  const expectedVersion = reviewed.version + 1
  if (value.replayed === undefined) {
    const revision = {
      surface_id: value.id,
      version: value.current_version,
      title: value.title,
      status: value.status,
      content_hash: value.current_content_hash,
      schema_digest: value.schema_digest,
      catalog_digest: value.catalog_digest,
      renderer_version: value.renderer_version,
      spec: value.current_spec,
      provenance: value.provenance,
    }
    if (!definitionMatches(revision, reviewed, expectedVersion)) {
      throw new TypeError("Surface promotion response does not match the reviewed draft")
    }
    return Object.freeze({ surface: value, revision, replayed: false, currentIsPromotedRevision: true })
  }

  if (value.replayed !== true
    || !definitionMatches(value.replayed_revision, reviewed, expectedVersion)
    || value.current_version < expectedVersion) {
      throw new TypeError("Surface promotion replay does not match the reviewed draft")
  }

  const currentIsPromotedRevision = currentMatchesPromotedRevision(value, value.replayed_revision)
  if (value.current_version === expectedVersion && !currentIsPromotedRevision) {
    throw new TypeError("Surface promotion replay does not match the reviewed draft")
  }
  return Object.freeze({
    surface: value,
    revision: value.replayed_revision,
    replayed: true,
    currentIsPromotedRevision,
  })
}
