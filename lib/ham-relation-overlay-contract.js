import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "./galaxy-object-reference.js"

export const HAM_RELATION_OVERLAY_REQUEST_SCHEMA_ID = "gb.ham-relation-overlay-request.v1"
export const HAM_RELATION_OVERLAY_RESPONSE_SCHEMA_ID = "gb.ham-relation-overlay-response.v1"
export const HAM_RELATION_OVERLAY_MAX_REFERENCES = 24
export const HAM_RELATION_OVERLAY_MAX_RELATIONS = 240
export const HAM_RELATION_OVERLAY_MAX_LINKS_PER_MEMORY = 64
export const HAM_RELATION_OVERLAY_REQUEST_MAX_BYTES = 65_536
export const HAM_RELATION_OVERLAY_RESPONSE_MAX_BYTES = 524_288

const MEMORY_ID = /^[1-9][0-9]{0,18}$/u
const MAX_INT64 = 9_223_372_036_854_775_807n
const TYPED_RELATIONS = new Set(["cites", "verifies", "contradicts", "depends-on"])
const LIFECYCLE_RELATIONS = new Set(["supersedes", "superseded_by"])
const REQUEST_KEYS = new Set(["schemaId", "references"])
const RESPONSE_KEYS = new Set(["schemaId", "provider", "results", "relations"])
const PROVIDER_KEYS = new Set(["name", "status", "consistency", "truncated"])
const RESULT_KEYS = new Set(["requestedRef", "status", "version"])
const RELATION_KEYS = new Set(["kind", "id", "sourceRef", "targetRef", "relation", "state", "version"])

function invalid(contract, message) {
  throw new TypeError(`Invalid ${contract}: ${message}`)
}

function record(value, contract, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(contract, `${label} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid(contract, `${label} must be a plain object`)
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

function memoryId(value, contract, label) {
  if (typeof value !== "string" || !MEMORY_ID.test(value)) invalid(contract, `${label} is not a HAM memory ID`)
  try {
    if (BigInt(value) > MAX_INT64) invalid(contract, `${label} is outside int64 range`)
  } catch {
    invalid(contract, `${label} is not a HAM memory ID`)
  }
  return value
}

function positiveVersion(value, contract, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    invalid(contract, `${label} must be a positive version`)
  }
  return value
}

function latestMemoryReference(value, contract, label) {
  const parsed = parseGalaxyObjectReference(value)
  if (
    !parsed || parsed.format !== "canonical" || parsed.kind !== "ham.memory"
    || parsed.selector.mode !== "latest"
  ) invalid(contract, `${label} must be a latest HAM memory reference`)
  const id = memoryId(parsed.id, contract, `${label} memory ID`)
  let canonical
  try {
    canonical = serializeGalaxyObjectReference(parsed)
  } catch {
    invalid(contract, `${label} must be canonical`)
  }
  if (canonical !== value) invalid(contract, `${label} must use canonical serialization`)
  return Object.freeze({ wire: canonical, id })
}

function normalizeReferences(value, contract) {
  if (!Array.isArray(value) || value.length < 1 || value.length > HAM_RELATION_OVERLAY_MAX_REFERENCES) {
    invalid(contract, `references must contain between 1 and ${HAM_RELATION_OVERLAY_MAX_REFERENCES} items`)
  }
  const seen = new Set()
  return Object.freeze(value.map((reference, index) => {
    const normalized = latestMemoryReference(reference, contract, `references[${index}]`).wire
    if (seen.has(normalized)) invalid(contract, `references contains duplicate ${normalized}`)
    seen.add(normalized)
    return normalized
  }))
}

export function parseHamRelationOverlayRequest(input) {
  const contract = HAM_RELATION_OVERLAY_REQUEST_SCHEMA_ID
  const source = record(input, contract, "request")
  exactKeys(source, REQUEST_KEYS, contract, "request")
  requireKeys(source, REQUEST_KEYS, contract, "request")
  if (source.schemaId !== contract) invalid(contract, "unsupported schemaId")
  return Object.freeze({ schemaId: contract, references: normalizeReferences(source.references, contract) })
}

function expectedReferences(request) {
  if (request === undefined) return null
  if (Array.isArray(request)) return normalizeReferences(request, HAM_RELATION_OVERLAY_RESPONSE_SCHEMA_ID)
  return parseHamRelationOverlayRequest(request).references
}

function normalizeProvider(value, resolvedCount) {
  const contract = HAM_RELATION_OVERLAY_RESPONSE_SCHEMA_ID
  const provider = record(value, contract, "provider")
  exactKeys(provider, PROVIDER_KEYS, contract, "provider")
  requireKeys(provider, PROVIDER_KEYS, contract, "provider")
  if (provider.name !== "ham") invalid(contract, "provider.name must be ham")
  if (!new Set(["partial", "unavailable"]).has(provider.status)) invalid(contract, "provider.status is unsupported")
  if (provider.consistency !== "follow-latest") invalid(contract, "provider.consistency must be follow-latest")
  if (typeof provider.truncated !== "boolean") invalid(contract, "provider.truncated must be boolean")
  if ((resolvedCount > 0) !== (provider.status === "partial")) {
    invalid(contract, "provider.status does not match resolved coverage")
  }
  return Object.freeze({
    name: "ham",
    status: provider.status,
    consistency: "follow-latest",
    truncated: provider.truncated,
  })
}

function normalizeResults(value, expected) {
  const contract = HAM_RELATION_OVERLAY_RESPONSE_SCHEMA_ID
  if (!Array.isArray(value) || value.length < 1 || value.length > HAM_RELATION_OVERLAY_MAX_REFERENCES) {
    invalid(contract, "results must be a bounded nonempty array")
  }
  if (expected && value.length !== expected.length) invalid(contract, "results must cover every requested reference")
  const seen = new Set()
  return Object.freeze(value.map((item, index) => {
    const result = record(item, contract, `results[${index}]`)
    exactKeys(result, RESULT_KEYS, contract, `results[${index}]`)
    const required = result.status === "resolved"
      ? new Set(["requestedRef", "status", "version"])
      : new Set(["requestedRef", "status"])
    requireKeys(result, required, contract, `results[${index}]`)
    const requestedRef = latestMemoryReference(
      result.requestedRef,
      contract,
      `results[${index}].requestedRef`,
    ).wire
    if (expected && requestedRef !== expected[index]) invalid(contract, `results[${index}] is out of request order`)
    if (seen.has(requestedRef)) invalid(contract, "results contains a duplicate requestedRef")
    seen.add(requestedRef)
    if (result.status === "unavailable") {
      if (Object.hasOwn(result, "version")) invalid(contract, `results[${index}].version is unavailable`)
      return Object.freeze({ requestedRef, status: "unavailable" })
    }
    if (result.status !== "resolved") invalid(contract, `results[${index}].status is unsupported`)
    return Object.freeze({
      requestedRef,
      status: "resolved",
      version: positiveVersion(result.version, contract, `results[${index}].version`),
    })
  }))
}

function relationIdentity(relation) {
  return [
    relation.kind,
    relation.id,
    relation.sourceRef,
    relation.targetRef,
    relation.relation,
    relation.version,
  ].join("\u0000")
}

function normalizeRelations(value, resolvedRefs) {
  const contract = HAM_RELATION_OVERLAY_RESPONSE_SCHEMA_ID
  if (!Array.isArray(value) || value.length > HAM_RELATION_OVERLAY_MAX_RELATIONS) {
    invalid(contract, `relations must contain at most ${HAM_RELATION_OVERLAY_MAX_RELATIONS} items`)
  }
  const identities = new Set()
  const stableIds = new Set()
  return Object.freeze(value.map((item, index) => {
    const relation = record(item, contract, `relations[${index}]`)
    exactKeys(relation, RELATION_KEYS, contract, `relations[${index}]`)
    requireKeys(relation, RELATION_KEYS, contract, `relations[${index}]`)
    if (relation.kind !== "typed" && relation.kind !== "lifecycle") {
      invalid(contract, `relations[${index}].kind is unsupported`)
    }
    if (relation.state !== "active") invalid(contract, `relations[${index}].state must be active`)
    const source = latestMemoryReference(relation.sourceRef, contract, `relations[${index}].sourceRef`)
    const target = latestMemoryReference(relation.targetRef, contract, `relations[${index}].targetRef`)
    if (source.wire === target.wire) invalid(contract, `relations[${index}] cannot be a self-link`)
    if (!resolvedRefs.has(source.wire) || !resolvedRefs.has(target.wire)) {
      invalid(contract, `relations[${index}] has an unresolved endpoint`)
    }
    const vocabulary = relation.kind === "typed" ? TYPED_RELATIONS : LIFECYCLE_RELATIONS
    if (!vocabulary.has(relation.relation)) invalid(contract, `relations[${index}].relation is unsupported`)
    const id = relation.kind === "typed"
      ? memoryId(relation.id, contract, `relations[${index}].id`)
      : (() => {
          const expected = relation.relation === "supersedes"
            ? `supersedes:${source.id}:${target.id}`
            : `superseded-by:${source.id}:${target.id}`
          if (relation.id !== expected) invalid(contract, `relations[${index}].id is not canonical`)
          return expected
        })()
    const normalized = Object.freeze({
      kind: relation.kind,
      id,
      sourceRef: source.wire,
      targetRef: target.wire,
      relation: relation.relation,
      state: "active",
      version: positiveVersion(relation.version, contract, `relations[${index}].version`),
    })
    const identity = relationIdentity(normalized)
    if (identities.has(identity)) invalid(contract, `relations[${index}] is duplicated`)
    const stableId = `${normalized.kind}\u0000${normalized.id}`
    if (stableIds.has(stableId)) invalid(contract, `relations[${index}] reuses a stable ID`)
    identities.add(identity)
    stableIds.add(stableId)
    return normalized
  }))
}

export function parseHamRelationOverlayResponse(input, request) {
  const contract = HAM_RELATION_OVERLAY_RESPONSE_SCHEMA_ID
  const source = record(input, contract, "response")
  exactKeys(source, RESPONSE_KEYS, contract, "response")
  requireKeys(source, RESPONSE_KEYS, contract, "response")
  if (source.schemaId !== contract) invalid(contract, "unsupported schemaId")
  const expected = expectedReferences(request)
  const results = normalizeResults(source.results, expected)
  const resolvedRefs = new Set(results.filter((item) => item.status === "resolved").map((item) => item.requestedRef))
  const provider = normalizeProvider(source.provider, resolvedRefs.size)
  const relations = normalizeRelations(source.relations, resolvedRefs)
  if (provider.status === "unavailable" && relations.length > 0) invalid(contract, "unavailable provider cannot emit relations")
  return Object.freeze({ schemaId: contract, provider, results, relations })
}

export function serializeHamRelationOverlayResponse(response, request) {
  const normalized = parseHamRelationOverlayResponse(response, request)
  const serialized = JSON.stringify(normalized)
  if (new TextEncoder().encode(serialized).byteLength > HAM_RELATION_OVERLAY_RESPONSE_MAX_BYTES) {
    throw new RangeError("HAM relation overlay response is too large")
  }
  return serialized
}
