import { parseGalaxyObjectReference, serializeGalaxyObjectReference } from "./galaxy-object-reference.js"
import { GALAXY_GRAPH_LINK_RELATIONS } from "./unified-graph.js"

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const RELATIONS = new Set(GALAXY_GRAPH_LINK_RELATIONS)
const BASES = new Set(["authored", "imported", "derived"])
const PROVENANCE_KEYS = new Set([
  "source", "source_system", "source_ref", "source_snapshot", "extractor_version", "confidence",
])

function text(value, maximum) {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return normalized && Array.from(normalized).length <= maximum && !CONTROL_CHARACTERS.test(normalized)
    ? normalized
    : null
}

function canonicalReference(value) {
  const parsed = parseGalaxyObjectReference(value)
  if (!parsed || parsed.format !== "canonical") return null
  try {
    return serializeGalaxyObjectReference(parsed)
  } catch {
    return null
  }
}

export function normalizeObjectLinkPage(value) {
  if (!Array.isArray(value)) return Object.freeze({ links: Object.freeze([]), invalid: 1, total: 0 })
  const links = []
  let invalid = 0
  for (const item of value) {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item : null
    const provenance = row?.provenance && typeof row.provenance === "object" && !Array.isArray(row.provenance)
      ? row.provenance
      : null
    const id = row ? text(String(row.id ?? ""), 256) : null
    const fromRef = row ? canonicalReference(row.from_ref) : null
    const toRef = row ? canonicalReference(row.to_ref) : null
    const relation = row ? text(row.relation, 80) : null
    const basis = row ? text(row.basis, 40) : null
    const provenanceKeysValid = provenance && Object.keys(provenance).every((key) => PROVENANCE_KEYS.has(key))
    const source = provenance
      ? text(provenance.source_system ?? provenance.source, 120)
      : null
    const optionalTextValid = provenance && [
      [provenance.source, 120],
      [provenance.source_system, 120],
      [provenance.source_ref, 512],
      [provenance.source_snapshot, 256],
      [provenance.extractor_version, 128],
    ].every(([entry, maximum]) => entry === undefined || text(entry, maximum) !== null)
    const confidenceValid = provenance?.confidence === undefined
      || (typeof provenance.confidence === "number" && Number.isFinite(provenance.confidence)
        && provenance.confidence >= 0 && provenance.confidence <= 1)
    if (
      !row || !id || !fromRef || !toRef || !relation || !RELATIONS.has(relation)
      || !basis || !BASES.has(basis) || !provenance || !provenanceKeysValid
      || !source || !optionalTextValid || !confidenceValid
    ) {
      invalid += 1
      continue
    }
    links.push(Object.freeze({
      id,
      from_ref: fromRef,
      to_ref: toRef,
      relation,
      basis,
      provenance: Object.freeze(Object.fromEntries(Object.entries(provenance))),
      ...(typeof row.created_by_principal_id === "string" ? { created_by_principal_id: row.created_by_principal_id } : {}),
      ...(typeof row.created_at === "string" ? { created_at: row.created_at } : {}),
      ...(Number.isSafeInteger(row.version) ? { version: row.version } : {}),
    }))
  }
  return Object.freeze({ links: Object.freeze(links), invalid, total: value.length })
}
