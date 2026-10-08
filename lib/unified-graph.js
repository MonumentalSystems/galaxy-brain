import { parseGalaxyObjectReference, serializeGalaxyObjectReference } from "./galaxy-object-reference.js"
import { createGalaxyObjectProjection } from "./object-projection.js"
import { selectObjectRepresentation } from "./object-projector-registry.js"

export const GALAXY_GRAPH_PROJECTION_SCHEMA_ID = "gb.graph-projection.v1"
export const GALAXY_GRAPH_INPUT_SCHEMA_ID = "gb.graph-projection-input.v1"

export const GALAXY_GRAPH_TRUST_CLASSES = Object.freeze([
  "structure",
  "assertion",
  "verification",
  "candidate",
])

export const GALAXY_GRAPH_LINK_RELATIONS = Object.freeze([
  "related",
  "cites",
  "part_of",
  "derived_from",
  "context_for",
  "formalized_by",
  "defined_in",
  "implements",
  "depends_on",
  "documents",
  "corresponds_to",
])

export const GALAXY_GRAPH_RELATIONS = Object.freeze([
  ...GALAXY_GRAPH_LINK_RELATIONS,
  "contains",
  "defines",
  "imports",
  "calls",
  "extends",
  "verifies",
  "references",
  "supports",
  "near",
  "supersedes",
  "superseded_by",
  "contradicts",
  "verified_by",
  "cited_by",
  "required_by",
  "coordinated_by",
  "continues",
  "forks",
  "joins",
])

const TRUST_SET = new Set(GALAXY_GRAPH_TRUST_CLASSES)
const LINK_RELATION_SET = new Set(GALAXY_GRAPH_LINK_RELATIONS)
const RELATION_SET = new Set(GALAXY_GRAPH_RELATIONS)
const LINK_BASIS = Object.freeze({ authored: "assertion", imported: "structure", derived: "structure" })
const TRUST_PRIORITY = Object.freeze({ verification: 0, structure: 1, assertion: 2, candidate: 3 })
const GRAPH_KINDS = new Set(["repository-field", "campaign", "mission"])
const ACTIVE_GRAPH_KINDS = new Set(["campaign", "mission"])
const PROOF_NODE_STATES = new Set([
  "reference", "available", "claimed", "running", "attested", "completed", "overridden", "blocked", "waiting",
])
const PROOF_WORK_STATUSES = new Set(["idle", "claimed", "running", "submitted", "blocked", "closed"])
const PROOF_STATUSES = new Set(["open", "candidate", "attested", "verified", "rejected", "overridden", "superseded"])
const PROOF_VERIFICATION_METHODS = new Set(["hyades-run", "lean-replay", "signed-report"])
const SHA256 = /^[0-9a-f]{64}$/u
const MODES = new Set(["mixed", "proof", "task", "conversation", "citation", "federated"])
const LENSES = new Set(["explore", "verify", "compose"])
const SCALES = new Set(["corpus", "project", "task", "run", "object", "atomic"])
const MODE_KINDS = Object.freeze({
  proof: new Set(["proof.graph", "proof.node"]),
  task: new Set(["ham.task", "task-plan", "task-plan.job"]),
  conversation: new Set(["chat", "run", "turn"]),
  citation: new Set(["paper", "document", "document.anchor", "document.mark", "claim", "artifact"]),
})
const PROVIDER_STATUSES = new Set(["ready", "partial", "unavailable"])
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const DEFAULT_LIMITS = Object.freeze({ maxNodes: 250, maxEdges: 500, maxFanout: 32 })
const HARD_LIMITS = Object.freeze({ maxNodes: 2_000, maxEdges: 5_000, maxFanout: 512 })
const MAX_INPUTS = 10_000
const INPUT_KEYS = new Set(["schemaId", "scope", "query", "objects", "external", "links", "relations", "proofContexts", "providers"])
const QUERY_KEYS = new Set(["rootRef", "mode", "lens", "scale", "viewport", "filters", "validAt", "knownAt", "cursor"])
const FILTER_KEYS = new Set(["kinds", "relations"])
const VIEWPORT_KEYS = new Set(["x", "y", "width", "height"])
const SCOPE_KEYS = new Set(["tenantId", "workspaceId"])

function invalid(message) {
  throw new TypeError(`Invalid ${GALAXY_GRAPH_INPUT_SCHEMA_ID}: ${message}`)
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`)
  return value
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${label}.${key} is not part of the contract`)
  }
}

function boundedText(value, maximum, label, optional = false) {
  if ((value === undefined || value === null) && optional) return null
  if (typeof value !== "string") invalid(`${label} must be text`)
  const normalized = value.trim()
  if (!normalized || Array.from(normalized).length > maximum || CONTROL_CHARACTERS.test(normalized)) {
    invalid(`${label} is outside its bounded text contract`)
  }
  return normalized
}

function boundedArray(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_INPUTS) invalid(`${label} must be a bounded array`)
  return value
}

function canonicalReference(value, label) {
  const parsed = parseGalaxyObjectReference(value)
  if (!parsed || parsed.format !== "canonical") invalid(`${label} must be a canonical Galaxy object reference`)
  return { ref: serializeGalaxyObjectReference(parsed), parsed }
}

function normalizeScope(value, label = "scope") {
  const source = record(value, label)
  exactKeys(source, SCOPE_KEYS, label)
  const tenantId = boundedText(source.tenantId, 64, `${label}.tenantId`)
  if (!UUID.test(tenantId)) invalid(`${label}.tenantId must be a UUID`)
  return Object.freeze({
    tenantId: tenantId.toLowerCase(),
    workspaceId: boundedText(source.workspaceId, 512, `${label}.workspaceId`),
  })
}

function requireScope(value, expected, label) {
  const actual = normalizeScope(value, `${label}.scope`)
  if (actual.tenantId !== expected.tenantId || actual.workspaceId !== expected.workspaceId) {
    invalid(`${label} crosses the tenant or workspace boundary`)
  }
}

function normalizeStringSet(value, allowed, label, maximum = 128, textMaximum = 120) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximum) invalid(`${label} must be a bounded array`)
  return [...new Set(value.map((item, index) => {
    const normalized = boundedText(item, textMaximum, `${label}[${index}]`)
    if (allowed && !allowed.has(normalized)) invalid(`${label}[${index}] is unsupported`)
    return normalized
  }))].sort()
}

function normalizeTimestamp(value, label) {
  if (value === undefined || value === null || value === "") return null
  const normalized = boundedText(value, 64, label)
  const timestamp = Date.parse(normalized)
  if (!Number.isFinite(timestamp)) invalid(`${label} must be an ISO timestamp`)
  return new Date(timestamp).toISOString()
}

function normalizeQuery(value) {
  const source = record(value, "query")
  exactKeys(source, QUERY_KEYS, "query")
  const rootRef = source.rootRef === undefined || source.rootRef === null
    ? null
    : canonicalReference(source.rootRef, "query.rootRef").ref
  const mode = source.mode === undefined ? "mixed" : boundedText(source.mode, 40, "query.mode")
  if (!MODES.has(mode)) invalid("query.mode is unsupported")
  const lens = source.lens === undefined ? "explore" : boundedText(source.lens, 40, "query.lens")
  if (!LENSES.has(lens)) invalid("query.lens is unsupported")
  if (lens !== "explore") invalid("query.lens is not implemented by this projection version")
  const scale = source.scale === undefined ? "project" : boundedText(source.scale, 40, "query.scale")
  if (!SCALES.has(scale)) invalid("query.scale is unsupported")
  const viewport = source.viewport === undefined || source.viewport === null
    ? null
    : normalizeViewport(source.viewport)
  if (viewport) invalid("query.viewport is not implemented by this projection version")
  const rawFilters = source.filters === undefined ? {} : record(source.filters, "query.filters")
  exactKeys(rawFilters, FILTER_KEYS, "query.filters")
  const filters = Object.freeze({
    kinds: Object.freeze(normalizeStringSet(rawFilters.kinds, null, "query.filters.kinds")),
    relations: Object.freeze(normalizeStringSet(rawFilters.relations, RELATION_SET, "query.filters.relations")),
  })
  const cursor = source.cursor === undefined || source.cursor === null
    ? null
    : boundedText(source.cursor, 200, "query.cursor")
  const validAt = normalizeTimestamp(source.validAt, "query.validAt")
  const knownAt = normalizeTimestamp(source.knownAt, "query.knownAt")
  if (validAt || knownAt) invalid("temporal graph projection is not implemented by this projection version")
  return Object.freeze({
    rootRef,
    mode,
    lens,
    scale,
    viewport,
    filters,
    validAt,
    knownAt,
    cursor,
  })
}

function normalizeViewport(value) {
  const source = record(value, "query.viewport")
  exactKeys(source, VIEWPORT_KEYS, "query.viewport")
  const result = {}
  for (const key of ["x", "y", "width", "height"]) {
    if (!Number.isFinite(source[key])) invalid(`query.viewport.${key} must be finite`)
    result[key] = source[key]
  }
  if (result.width <= 0 || result.height <= 0) invalid("query.viewport dimensions must be positive")
  return Object.freeze(result)
}

function normalizeLimit(value, fallback, maximum) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback
}

function normalizeOptions(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {}
  return Object.freeze({
    maxNodes: normalizeLimit(source.maxNodes, DEFAULT_LIMITS.maxNodes, HARD_LIMITS.maxNodes),
    maxEdges: normalizeLimit(source.maxEdges, DEFAULT_LIMITS.maxEdges, HARD_LIMITS.maxEdges),
    maxFanout: normalizeLimit(source.maxFanout, DEFAULT_LIMITS.maxFanout, HARD_LIMITS.maxFanout),
  })
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
}

function hashText(value) {
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
  const values = seeds.map((seed) => seed >>> 0)
  for (const character of value) {
    const code = character.codePointAt(0)
    for (let index = 0; index < values.length; index += 1) {
      values[index] ^= code + index * 0x1000193
      values[index] = Math.imul(values[index], 0x01000193) >>> 0
      values[index] = (values[index] ^ (values[index] >>> 13)) >>> 0
    }
  }
  return values.map((item) => item.toString(16).padStart(8, "0")).join("")
}

function allocateOpaqueIds(values, prefix) {
  const groups = new Map()
  for (const value of values) {
    const digest = hashText(value)
    const entries = groups.get(digest) ?? []
    entries.push(value)
    groups.set(digest, entries)
  }
  const result = new Map()
  for (const [digest, entries] of groups) {
    entries.sort((left, right) => left.localeCompare(right))
    entries.forEach((value, index) => {
      result.set(value, `${prefix}:${digest}${entries.length > 1 ? `:${index}` : ""}`)
    })
  }
  return result
}

function sourceKey(source) {
  return stableStringify(source)
}

function normalizeProjectionSource(projection, authority, resolution = null) {
  return Object.freeze(Object.fromEntries(Object.entries({
    authority,
    provider: resolution?.provider ?? projection.provenance.provider,
    sourceId: projection.provenance.sourceId,
    sourceRevision: projection.provenance.sourceRevision ?? projection.revision.id ?? undefined,
    statement: projection.provenance.statement,
    requestedRef: resolution?.requestedRef,
    resolvedRef: resolution?.resolvedRef,
  }).filter(([, item]) => item !== undefined)))
}

function normalizeProviders(values, scope) {
  const byProvider = new Map()
  boundedArray(values, "providers").forEach((value, index) => {
    const envelope = record(value, `providers[${index}]`)
    exactKeys(envelope, new Set(["scope", "provider", "status", "snapshot", "revision"]), `providers[${index}]`)
    requireScope(envelope.scope, scope, `providers[${index}]`)
    const provider = boundedText(envelope.provider, 120, `providers[${index}].provider`)
    const status = boundedText(envelope.status, 40, `providers[${index}].status`)
    if (!PROVIDER_STATUSES.has(status)) invalid(`providers[${index}].status is unsupported`)
    if (byProvider.has(provider)) invalid(`providers contains duplicate ${provider}`)
    byProvider.set(provider, Object.freeze(Object.fromEntries(Object.entries({
      provider,
      status,
      snapshot: envelope.snapshot === undefined ? undefined : boundedText(envelope.snapshot, 512, `providers[${index}].snapshot`),
      revision: envelope.revision === undefined ? undefined : boundedText(envelope.revision, 256, `providers[${index}].revision`),
    }).filter(([, item]) => item !== undefined))))
  })
  return Object.freeze([...byProvider.values()].sort((left, right) => left.provider.localeCompare(right.provider)))
}

function normalizeResolution(value, projection, scope, label) {
  const source = record(value, `${label}.resolution`)
  exactKeys(source, new Set(["authorized", "tenantId", "workspaceId", "provider", "requestedRef", "resolvedRef"]), `${label}.resolution`)
  if (source.authorized !== true) return null
  const tenantId = boundedText(source.tenantId, 64, `${label}.resolution.tenantId`)
  const workspaceId = boundedText(source.workspaceId, 512, `${label}.resolution.workspaceId`)
  if (tenantId.toLowerCase() !== scope.tenantId || workspaceId !== scope.workspaceId) {
    invalid(`${label}.resolution crosses the tenant or workspace boundary`)
  }
  const requested = canonicalReference(source.requestedRef, `${label}.resolution.requestedRef`)
  const resolved = canonicalReference(source.resolvedRef, `${label}.resolution.resolvedRef`)
  if (resolved.ref !== projection.ref) invalid(`${label}.resolution.resolvedRef must match projection.ref`)
  if (requested.parsed.kind !== resolved.parsed.kind || requested.parsed.id !== resolved.parsed.id) {
    invalid(`${label}.resolution changed object identity`)
  }
  if (requested.parsed.selector.mode === "pinned" && requested.ref !== resolved.ref) {
    invalid(`${label}.resolution changed a pinned revision`)
  }
  return Object.freeze({
    provider: boundedText(source.provider, 120, `${label}.resolution.provider`),
    requestedRef: requested.ref,
    resolvedRef: resolved.ref,
  })
}

function addNode(byRef, projection, authority, source) {
  const existing = byRef.get(projection.ref)
  if (!existing) {
    byRef.set(projection.ref, { projection, authority, sources: new Map([[sourceKey(source), source]]) })
    return
  }
  existing.sources.set(sourceKey(source), source)
  if (authority === "galaxy" && existing.authority !== "galaxy") {
    existing.projection = projection
    existing.authority = authority
  }
}

function normalizeSource(value, label) {
  const source = record(value, label)
  exactKeys(source, new Set([
    "provider", "recordId", "revision", "sourceRef", "extractorVersion", "confidence",
    "resourceMode", "resourceStatus",
  ]), label)
  const confidence = source.confidence === undefined ? undefined : Number(source.confidence)
  if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    invalid(`${label}.confidence must be between zero and one`)
  }
  return Object.freeze(Object.fromEntries(Object.entries({
    provider: boundedText(source.provider, 120, `${label}.provider`),
    recordId: source.recordId === undefined ? undefined : boundedText(source.recordId, 512, `${label}.recordId`),
    revision: source.revision === undefined ? undefined : boundedText(source.revision, 256, `${label}.revision`),
    sourceRef: source.sourceRef === undefined ? undefined : boundedText(source.sourceRef, 512, `${label}.sourceRef`),
    extractorVersion: source.extractorVersion === undefined ? undefined : boundedText(source.extractorVersion, 128, `${label}.extractorVersion`),
    confidence,
    resourceMode: source.resourceMode === undefined ? undefined : boundedText(source.resourceMode, 40, `${label}.resourceMode`),
    resourceStatus: source.resourceStatus === undefined ? undefined : boundedText(source.resourceStatus, 80, `${label}.resourceStatus`),
  }).filter(([, item]) => item !== undefined)))
}

function normalizeVerification(value, label) {
  const source = record(value, label)
  exactKeys(source, new Set(["status", "method", "evidenceRef"]), label)
  if (source.status !== "verified") invalid(`${label}.status must be verified`)
  return Object.freeze({
    status: "verified",
    method: boundedText(source.method, 120, `${label}.method`),
    evidenceRef: boundedText(source.evidenceRef, 1_024, `${label}.evidenceRef`),
  })
}

function normalizeLedgerLink(value, scope, index) {
  const envelope = record(value, `links[${index}]`)
  exactKeys(envelope, new Set(["scope", "link"]), `links[${index}]`)
  requireScope(envelope.scope, scope, `links[${index}]`)
  const link = record(envelope.link, `links[${index}].link`)
  exactKeys(link, new Set(["id", "from_ref", "to_ref", "relation", "basis", "provenance"]), `links[${index}].link`)
  const fromRef = canonicalReference(link.from_ref, `links[${index}].link.from_ref`).ref
  const toRef = canonicalReference(link.to_ref, `links[${index}].link.to_ref`).ref
  const relation = boundedText(link.relation, 80, `links[${index}].link.relation`)
  if (!LINK_RELATION_SET.has(relation)) invalid(`links[${index}].link.relation is unsupported`)
  const trust = LINK_BASIS[link.basis]
  if (!trust) invalid(`links[${index}].link.basis is unsupported`)
  const provenance = record(link.provenance, `links[${index}].link.provenance`)
  exactKeys(provenance, new Set([
    "source", "source_system", "source_ref", "source_snapshot", "extractor_version", "confidence",
  ]), `links[${index}].link.provenance`)
  const source = normalizeSource({
    provider: `ledger:${boundedText(provenance.source_system ?? provenance.source, 120, `links[${index}].link.provenance.source`)}`,
    recordId: link.id === undefined ? undefined : String(link.id),
    revision: provenance.source_snapshot,
    sourceRef: provenance.source_ref,
    extractorVersion: provenance.extractor_version,
    confidence: provenance.confidence,
  }, `links[${index}].source`)
  return { fromRef, toRef, relation, trust, source, ledgerId: link.id === undefined ? null : String(link.id) }
}

function normalizeRelation(value, scope, index) {
  const envelope = record(value, `relations[${index}]`)
  exactKeys(envelope, new Set(["scope", "relation"]), `relations[${index}]`)
  requireScope(envelope.scope, scope, `relations[${index}]`)
  const relationValue = record(envelope.relation, `relations[${index}].relation`)
  exactKeys(relationValue, new Set(["fromRef", "toRef", "relation", "trust", "source", "verification"]), `relations[${index}].relation`)
  const fromRef = canonicalReference(relationValue.fromRef, `relations[${index}].relation.fromRef`).ref
  const toRef = canonicalReference(relationValue.toRef, `relations[${index}].relation.toRef`).ref
  const relation = boundedText(relationValue.relation, 80, `relations[${index}].relation.relation`)
  if (!RELATION_SET.has(relation)) invalid(`relations[${index}].relation.relation is unsupported`)
  const trust = boundedText(relationValue.trust, 40, `relations[${index}].relation.trust`)
  if (!TRUST_SET.has(trust)) invalid(`relations[${index}].relation.trust is unsupported`)
  const source = normalizeSource(relationValue.source, `relations[${index}].relation.source`)
  const verification = relationValue.verification === undefined
    ? null
    : normalizeVerification(relationValue.verification, `relations[${index}].relation.verification`)
  if (trust === "verification" && !verification) invalid(`relations[${index}] verification trust requires evidence`)
  return {
    fromRef,
    toRef,
    relation: trust === "candidate" ? "near" : relation,
    sourceRelation: trust === "candidate" && relation !== "near" ? relation : null,
    trust,
    source,
    verification,
    ledgerId: null,
  }
}

function edgeKey(edge) {
  return stableStringify({
    fromRef: edge.fromRef,
    toRef: edge.toRef,
    relation: edge.relation,
    trust: edge.trust,
    source: edge.source,
    sourceRelation: edge.sourceRelation,
    verification: edge.verification,
    ledgerId: edge.ledgerId,
  })
}

function compareEdges(left, right) {
  return TRUST_PRIORITY[left.trust] - TRUST_PRIORITY[right.trust]
    || left.fromRef.localeCompare(right.fromRef)
    || left.toRef.localeCompare(right.toRef)
    || left.relation.localeCompare(right.relation)
    || edgeKey(left).localeCompare(edgeKey(right))
}

function proofDigest(value, label, prefix = "") {
  const text = boundedText(value, prefix.length + 64, label)
  if (!text.startsWith(prefix) || !SHA256.test(text.slice(prefix.length))) {
    invalid(`${label} must be ${prefix ? `${prefix}<lowercase SHA-256>` : "a lowercase SHA-256 digest"}`)
  }
  return text
}

function proofTimestamp(value, label) {
  const text = boundedText(value, 64, label)
  if (!Number.isFinite(Date.parse(text))) invalid(`${label} must be an ISO timestamp`)
  return text
}

function normalizeProofNodeState(value, index, nodeRefs, coordinationActive) {
  const label = `proofContexts nodeStates[${index}]`
  const source = record(value, label)
  exactKeys(source, new Set([
    "nodeRef", "state", "coordinationLabel", "itemVersion", "workStatus", "proofStatus",
    "claim", "run", "taskId", "linkedTaskCount", "candidateSha256", "verification", "external",
  ]), label)
  const node = canonicalReference(source.nodeRef, `${label}.nodeRef`)
  if (node.parsed.kind !== "proof.node" || !nodeRefs.has(node.ref)) {
    invalid(`${label}.nodeRef must name a node in this proof context`)
  }
  const state = boundedText(source.state, 40, `${label}.state`)
  if (!PROOF_NODE_STATES.has(state)) invalid(`${label}.state is unsupported`)
  const coordinationLabel = boundedText(source.coordinationLabel, 2_000, `${label}.coordinationLabel`)
  const itemVersion = source.itemVersion === undefined ? undefined : source.itemVersion
  if (itemVersion !== undefined && (!Number.isSafeInteger(itemVersion) || itemVersion < 1)) {
    invalid(`${label}.itemVersion must be a positive safe integer`)
  }
  const workStatus = source.workStatus === undefined
    ? undefined
    : boundedText(source.workStatus, 40, `${label}.workStatus`)
  if (workStatus !== undefined && !PROOF_WORK_STATUSES.has(workStatus)) {
    invalid(`${label}.workStatus is unsupported`)
  }
  const proofStatus = source.proofStatus === undefined
    ? undefined
    : boundedText(source.proofStatus, 40, `${label}.proofStatus`)
  if (proofStatus !== undefined && !PROOF_STATUSES.has(proofStatus)) {
    invalid(`${label}.proofStatus is unsupported`)
  }

  let claim
  if (source.claim !== undefined) {
    const raw = record(source.claim, `${label}.claim`)
    exactKeys(raw, new Set(["claimId", "expiresAt"]), `${label}.claim`)
    claim = Object.freeze({
      claimId: boundedText(raw.claimId, 512, `${label}.claim.claimId`),
      expiresAt: proofTimestamp(raw.expiresAt, `${label}.claim.expiresAt`),
    })
  }

  let run
  if (source.run !== undefined) {
    const raw = record(source.run, `${label}.run`)
    exactKeys(raw, new Set(["runId", "status"]), `${label}.run`)
    run = Object.freeze({
      runId: boundedText(raw.runId, 512, `${label}.run.runId`),
      status: boundedText(raw.status, 80, `${label}.run.status`),
    })
  }

  const taskId = source.taskId === undefined
    ? undefined
    : boundedText(source.taskId, 200, `${label}.taskId`)
  const linkedTaskCount = source.linkedTaskCount === undefined ? undefined : source.linkedTaskCount
  if (linkedTaskCount !== undefined && (!Number.isSafeInteger(linkedTaskCount) || linkedTaskCount < 0)) {
    invalid(`${label}.linkedTaskCount must be a non-negative safe integer`)
  }
  if ((taskId === undefined) !== (linkedTaskCount === undefined)) {
    invalid(`${label}.taskId and linkedTaskCount must be supplied together`)
  }

  const candidateSha256 = source.candidateSha256 === undefined
    ? undefined
    : proofDigest(source.candidateSha256, `${label}.candidateSha256`)
  let verification
  if (source.verification !== undefined) {
    const raw = record(source.verification, `${label}.verification`)
    exactKeys(raw, new Set([
      "status", "method", "evidenceRef", "solutionSha256", "sorryFree", "verifiedAt",
    ]), `${label}.verification`)
    const status = boundedText(raw.status, 40, `${label}.verification.status`)
    const method = boundedText(raw.method, 80, `${label}.verification.method`)
    if (status !== "verified") invalid(`${label}.verification.status must be verified`)
    if (!PROOF_VERIFICATION_METHODS.has(method)) invalid(`${label}.verification.method is unsupported`)
    if (raw.sorryFree !== true) invalid(`${label}.verification.sorryFree must be true`)
    verification = Object.freeze({
      status,
      method,
      evidenceRef: proofDigest(raw.evidenceRef, `${label}.verification.evidenceRef`, "sha256:"),
      solutionSha256: proofDigest(raw.solutionSha256, `${label}.verification.solutionSha256`),
      sorryFree: true,
      verifiedAt: proofTimestamp(raw.verifiedAt, `${label}.verification.verifiedAt`),
    })
    if (proofStatus !== "verified") invalid(`${label}.verification requires proofStatus verified`)
    if (candidateSha256 !== undefined && candidateSha256 !== verification.solutionSha256) {
      invalid(`${label}.verification must match candidateSha256`)
    }
  }

  let external
  if (source.external !== undefined) {
    const raw = record(source.external, `${label}.external`)
    exactKeys(raw, new Set(["rosettaStatus", "prove2meStatus"]), `${label}.external`)
    external = Object.freeze(Object.fromEntries(Object.entries({
      rosettaStatus: raw.rosettaStatus === undefined
        ? undefined
        : boundedText(raw.rosettaStatus, 80, `${label}.external.rosettaStatus`),
      prove2meStatus: raw.prove2meStatus === undefined
        ? undefined
        : boundedText(raw.prove2meStatus, 80, `${label}.external.prove2meStatus`),
    }).filter(([, item]) => item !== undefined)))
    if (Object.keys(external).length === 0) invalid(`${label}.external must contain a status`)
  }

  if (!coordinationActive && (
    state !== "reference" || workStatus !== undefined || claim !== undefined
    || run !== undefined || taskId !== undefined || linkedTaskCount !== undefined || candidateSha256 !== undefined
  )) {
    invalid(`${label} exposes mutable coordination while coordination is inactive`)
  }

  return Object.freeze(Object.fromEntries(Object.entries({
    nodeRef: node.ref,
    state,
    coordinationLabel,
    itemVersion,
    workStatus,
    proofStatus,
    claim,
    run,
    taskId,
    linkedTaskCount,
    candidateSha256,
    verification,
    external,
  }).filter(([, item]) => item !== undefined)))
}

function normalizeProofContexts(values, scope, byRef) {
  const overlayByRef = new Map()
  values.forEach((value, index) => {
    const context = record(value, `proofContexts[${index}]`)
    exactKeys(context, new Set([
      "scope", "graphRef", "graphKind", "coordinationActive", "nodeRefs", "nodeStates",
    ]), `proofContexts[${index}]`)
    requireScope(context.scope, scope, `proofContexts[${index}]`)
    const graphRef = canonicalReference(context.graphRef, `proofContexts[${index}].graphRef`)
    if (graphRef.parsed.kind !== "proof.graph") invalid(`proofContexts[${index}].graphRef must name a proof.graph`)
    const graphKind = boundedText(context.graphKind, 40, `proofContexts[${index}].graphKind`)
    if (!GRAPH_KINDS.has(graphKind)) invalid(`proofContexts[${index}].graphKind is unsupported`)
    if (context.coordinationActive !== undefined && typeof context.coordinationActive !== "boolean") {
      invalid(`proofContexts[${index}].coordinationActive must be boolean when present`)
    }
    const coordinationRequested = context.coordinationActive === true
    const coordinationActive = coordinationRequested && ACTIVE_GRAPH_KINDS.has(graphKind)
    if (coordinationRequested && !coordinationActive) {
      invalid(`proofContexts[${index}] cannot activate coordination for a passive graph kind`)
    }
    const nodeRefs = normalizeStringSet(context.nodeRefs, null, `proofContexts[${index}].nodeRefs`, MAX_INPUTS, 16_384)
      .map((ref, nodeIndex) => {
        const parsed = canonicalReference(ref, `proofContexts[${index}].nodeRefs[${nodeIndex}]`)
        if (parsed.parsed.kind !== "proof.node") invalid(`proofContexts[${index}].nodeRefs must name proof.node objects`)
        return parsed.ref
      })
    const nodeRefSet = new Set(nodeRefs)
    const nodeStates = boundedArray(context.nodeStates, `proofContexts[${index}].nodeStates`)
      .map((state, stateIndex) => normalizeProofNodeState(state, stateIndex, nodeRefSet, coordinationActive))
    const nodeStateByRef = new Map()
    for (const state of nodeStates) {
      if (nodeStateByRef.has(state.nodeRef)) invalid(`proofContexts[${index}].nodeStates contains a duplicate nodeRef`)
      nodeStateByRef.set(state.nodeRef, state)
    }
    const refs = [graphRef.ref, ...nodeRefs]
    for (const ref of refs) {
      if (!byRef.has(ref)) invalid(`proofContexts[${index}] refers to an absent graph node`)
      const overlay = Object.freeze({
        graphRef: graphRef.ref,
        graphKind,
        coordinationActive,
        workPolicy: coordinationActive ? "explicit-task-materialization" : "passive",
        ...(nodeStateByRef.has(ref) ? { nodeState: nodeStateByRef.get(ref) } : {}),
      })
      const prior = overlayByRef.get(ref)
      if (prior && stableStringify(prior) !== stableStringify(overlay)) {
        invalid(`proof context for ${ref} is ambiguous`)
      }
      overlayByRef.set(ref, overlay)
    }
  })
  return overlayByRef
}

function applyQuery(nodes, edges, query) {
  const kindFilter = new Set(query.filters.kinds)
  const modeKinds = MODE_KINDS[query.mode]
  let selected = query.mode === "federated"
    ? nodes.filter((node) => node.authority === "external-resolved")
    : modeKinds
      ? nodes.filter((node) => modeKinds.has(node.kind))
      : nodes
  selected = kindFilter.size ? selected.filter((node) => kindFilter.has(node.kind)) : selected
  const relationFilter = new Set(query.filters.relations)
  let selectedEdges = relationFilter.size ? edges.filter((edge) => relationFilter.has(edge.relation)) : edges
  if (query.rootRef) {
    const connected = new Set([query.rootRef])
    for (const edge of selectedEdges) {
      if (edge.fromRef === query.rootRef) connected.add(edge.toRef)
      if (edge.toRef === query.rootRef) connected.add(edge.fromRef)
    }
    selected = selected.filter((node) => connected.has(node.ref))
  }
  const selectedRefs = new Set(selected.map((node) => node.ref))
  selectedEdges = selectedEdges.filter((edge) => selectedRefs.has(edge.fromRef) && selectedRefs.has(edge.toRef))
  return { nodes: selected, edges: selectedEdges }
}

function parseCursor(cursor, projectionHash) {
  if (!cursor) return { nodeOffset: 0, edgeOffset: 0 }
  const match = /^ug1:([a-f0-9]{32}):(\d+):(\d+)$/u.exec(cursor)
  if (!match || match[1] !== projectionHash) invalid("query.cursor does not belong to this projection")
  const nodeOffset = Number(match[2])
  const edgeOffset = Number(match[3])
  if (!Number.isSafeInteger(nodeOffset) || nodeOffset < 0 || !Number.isSafeInteger(edgeOffset) || edgeOffset < 0) {
    invalid("query.cursor offset is invalid")
  }
  return { nodeOffset, edgeOffset }
}

function detailFor(node, level) {
  if (level === "far") return Object.freeze({ kind: node.kind })
  if (level === "medium") return Object.freeze({ title: node.title })
  if (level === "near") return Object.freeze({
    title: node.title,
    summary: node.summary ?? null,
    authority: node.authority,
  })
  return Object.freeze({
    title: node.title,
    summary: node.summary ?? null,
    mediaType: node.projection.mediaType ?? null,
    revision: node.projection.revision,
    representations: node.projection.representations,
    provenance: node.provenance,
  })
}

const ZOOM_BY_SCALE = Object.freeze({
  corpus: 0,
  project: 0.7,
  task: 1.3,
  run: 1.8,
  object: 2.45,
  atomic: 3,
})

/**
 * Merge already-authorized canonical projections and typed relations into a
 * deterministic, bounded graph projection. This function never resolves a
 * reference and never broadens a tenant/workspace boundary.
 */
export function projectUnifiedGraph(input, options = {}) {
  const source = record(input, "input")
  exactKeys(source, INPUT_KEYS, "input")
  if (source.schemaId !== GALAXY_GRAPH_INPUT_SCHEMA_ID) invalid("unsupported schemaId")
  const scope = normalizeScope(source.scope)
  const query = normalizeQuery(source.query)
  const limits = normalizeOptions(options)
  const providers = normalizeProviders(source.providers, scope)
  const byRef = new Map()
  let unauthorizedExternal = 0

  boundedArray(source.objects, "objects").forEach((value, index) => {
    const envelope = record(value, `objects[${index}]`)
    exactKeys(envelope, new Set(["scope", "projection"]), `objects[${index}]`)
    requireScope(envelope.scope, scope, `objects[${index}]`)
    const projection = createGalaxyObjectProjection(envelope.projection)
    addNode(byRef, projection, "galaxy", normalizeProjectionSource(projection, "galaxy"))
  })

  boundedArray(source.external, "external").forEach((value, index) => {
    const envelope = record(value, `external[${index}]`)
    exactKeys(envelope, new Set(["scope", "resolution", "projection"]), `external[${index}]`)
    requireScope(envelope.scope, scope, `external[${index}]`)
    const rawResolution = record(envelope.resolution, `external[${index}].resolution`)
    exactKeys(rawResolution, new Set(["authorized", "tenantId", "workspaceId", "provider", "requestedRef", "resolvedRef"]), `external[${index}].resolution`)
    if (rawResolution.authorized !== true) {
      unauthorizedExternal += 1
      return
    }
    const projection = createGalaxyObjectProjection(envelope.projection)
    const resolution = normalizeResolution(envelope.resolution, projection, scope, `external[${index}]`)
    addNode(byRef, projection, "external-resolved", normalizeProjectionSource(projection, "external-resolved", resolution))
  })

  const overlayByRef = normalizeProofContexts(boundedArray(source.proofContexts, "proofContexts"), scope, byRef)
  const sortedNodeEntries = [...byRef.entries()].sort(([left], [right]) => left.localeCompare(right))
  const nodeIds = allocateOpaqueIds(sortedNodeEntries.map(([ref]) => ref), "gn")
  const allNodes = sortedNodeEntries
    .map(([ref, node]) => Object.freeze({
      id: nodeIds.get(ref),
      ref,
      kind: node.projection.kind,
      title: node.projection.title,
      ...(node.projection.summary ? { summary: node.projection.summary } : {}),
      authority: node.authority,
      projection: node.projection,
      provenance: Object.freeze([...node.sources.values()].sort((left, right) => (
        (left.authority === "galaxy" ? 0 : 1) - (right.authority === "galaxy" ? 0 : 1)
        || sourceKey(left).localeCompare(sourceKey(right))
      ))),
      overlays: Object.freeze(Object.fromEntries(overlayByRef.has(ref) ? [["proof", overlayByRef.get(ref)]] : [])),
    }))

  const relationCandidates = [
    ...boundedArray(source.links, "links").map((value, index) => normalizeLedgerLink(value, scope, index)),
    ...boundedArray(source.relations, "relations").map((value, index) => normalizeRelation(value, scope, index)),
  ].sort(compareEdges)
  const normalizedEdges = []
  const seenEdges = new Set()
  let danglingEdges = 0
  for (const edge of relationCandidates) {
    if (edge.fromRef === edge.toRef) continue
    if (!byRef.has(edge.fromRef) || !byRef.has(edge.toRef)) {
      danglingEdges += 1
      continue
    }
    const key = edgeKey(edge)
    if (seenEdges.has(key)) continue
    seenEdges.add(key)
    normalizedEdges.push(edge)
  }
  const edgeIds = allocateOpaqueIds(normalizedEdges.map(edgeKey), "ge")
  const edges = normalizedEdges.map((edge) => Object.freeze(Object.fromEntries(Object.entries({
      id: edgeIds.get(edgeKey(edge)),
      from: nodeIds.get(edge.fromRef),
      to: nodeIds.get(edge.toRef),
      fromRef: edge.fromRef,
      toRef: edge.toRef,
      relation: edge.relation,
      trust: edge.trust,
      source: edge.source,
      sourceRelation: edge.sourceRelation,
      verification: edge.verification,
    }).filter(([, item]) => item !== null && item !== undefined))))

  const queried = applyQuery(allNodes, edges, query)
  const hashMaterial = {
    scope,
    query: { ...query, cursor: null },
    nodes: queried.nodes.map((node) => ({
      ref: node.ref,
      authority: node.authority,
      projection: node.projection,
      provenance: node.provenance,
      overlays: node.overlays,
    })),
    edges: queried.edges.map((edge) => ({
      fromRef: edge.fromRef,
      toRef: edge.toRef,
      relation: edge.relation,
      trust: edge.trust,
      source: edge.source,
      sourceRelation: edge.sourceRelation,
      verification: edge.verification,
    })),
    providers,
  }
  const projectionHash = hashText(stableStringify(hashMaterial))
  const { nodeOffset, edgeOffset } = parseCursor(query.cursor, projectionHash)
  if (nodeOffset > queried.nodes.length) invalid("query.cursor node offset exceeds this projection")
  const nextNodeOffset = Math.min(nodeOffset + limits.maxNodes, queried.nodes.length)
  const pageNodes = queried.nodes.slice(nodeOffset, nextNodeOffset)
  const selectedNodes = edgeOffset > 0 ? [] : pageNodes
  const deliveredRefs = new Set(queried.nodes.slice(0, nextNodeOffset).map((node) => node.ref))
  const currentRefs = new Set(pageNodes.map((node) => node.ref))
  const fanout = new Map()
  const boundedEdges = []
  let fanoutOmissions = 0
  for (const edge of queried.edges) {
    const fromFanout = fanout.get(edge.fromRef) ?? 0
    const toFanout = fanout.get(edge.toRef) ?? 0
    if (fromFanout >= limits.maxFanout || toFanout >= limits.maxFanout) {
      fanoutOmissions += 1
      continue
    }
    fanout.set(edge.fromRef, fromFanout + 1)
    fanout.set(edge.toRef, toFanout + 1)
    boundedEdges.push(edge)
  }
  // Pages are accumulated by the consumer. An edge is emitted on the first
  // page where both endpoints have arrived, including cross-page edges.
  const newlyEligibleEdges = boundedEdges.filter((edge) => (
    deliveredRefs.has(edge.fromRef)
    && deliveredRefs.has(edge.toRef)
    && (currentRefs.has(edge.fromRef) || currentRefs.has(edge.toRef))
  ))
  if (edgeOffset > newlyEligibleEdges.length) invalid("query.cursor edge offset exceeds this projection page")
  const selectedEdges = newlyEligibleEdges.slice(edgeOffset, edgeOffset + limits.maxEdges)
  const nextEdgeOffset = edgeOffset + selectedEdges.length
  const moreEdgesOnPage = nextEdgeOffset < newlyEligibleEdges.length
  const moreNodes = nextNodeOffset < queried.nodes.length
  const hasMore = moreEdgesOnPage || moreNodes
  const nextCursor = moreEdgesOnPage
    ? `ug1:${projectionHash}:${nodeOffset}:${nextEdgeOffset}`
    : moreNodes
      ? `ug1:${projectionHash}:${nextNodeOffset}:0`
      : null
  const futureEdges = boundedEdges.filter((edge) => !deliveredRefs.has(edge.fromRef) || !deliveredRefs.has(edge.toRef)).length
  const omittedEdges = Math.max(0, newlyEligibleEdges.length - nextEdgeOffset) + futureEdges
  const reasons = []
  if (moreNodes) reasons.push("node-page-limit")
  if (moreEdgesOnPage) reasons.push("edge-page-limit")
  if (fanoutOmissions) reasons.push("fanout-limit")
  const continuation = Object.freeze({
    cursor: nextCursor,
    hasMore,
    omitted: Object.freeze({
      nodes: Math.max(0, queried.nodes.length - nextNodeOffset),
      edges: omittedEdges,
      fanout: fanoutOmissions,
    }),
    reasons: Object.freeze(reasons),
  })

  return Object.freeze({
    schemaId: GALAXY_GRAPH_PROJECTION_SCHEMA_ID,
    query,
    projectionHash,
    nodes: Object.freeze(selectedNodes),
    edges: Object.freeze(selectedEdges),
    aggregates: Object.freeze({
      nodeCount: selectedNodes.length,
      edgeCount: selectedEdges.length,
      totalNodeCount: queried.nodes.length,
      totalEdgeCount: queried.edges.length,
      kinds: Object.freeze(Object.fromEntries([...new Set(selectedNodes.map((node) => node.kind))].sort().map((kind) => [kind, selectedNodes.filter((node) => node.kind === kind).length]))),
      trust: Object.freeze(Object.fromEntries(GALAXY_GRAPH_TRUST_CLASSES.map((trust) => [trust, selectedEdges.filter((edge) => edge.trust === trust).length]))),
    }),
    provenance: Object.freeze({
      scope,
      diagnostics: Object.freeze({
        unauthorizedExternal,
        danglingEdges,
        nodeLimitReached: moreNodes,
        edgeLimitReached: moreEdgesOnPage,
        fanoutOmissions,
      }),
      limits,
      providers,
      paginationModel: "accumulated-prefix",
    }),
    continuation,
  })
}

/** Derive renderer detail without changing graph identity or relation truth. */
export function deriveUnifiedGraphView(graph, moving = false) {
  if (!graph || graph.schemaId !== GALAXY_GRAPH_PROJECTION_SCHEMA_ID || !Array.isArray(graph.nodes)) {
    throw new TypeError(`Invalid ${GALAXY_GRAPH_PROJECTION_SCHEMA_ID}`)
  }
  const nodes = graph.nodes.map((node) => {
    const selected = selectObjectRepresentation(node.projection, ZOOM_BY_SCALE[graph.query.scale], moving)
    const projector = Object.freeze({
      plugin: selected.projector.plugin,
      diagnostic: selected.projector.diagnostic,
    })
    return Object.freeze({
      ...node,
      projector,
      representation: selected.representation,
      placeholder: selected.placeholder,
      detail: detailFor(node, selected.level.id),
    })
  })
  return Object.freeze({ ...graph, nodes: Object.freeze(nodes) })
}
