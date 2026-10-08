import { parseGalaxyObjectReference, serializeGalaxyObjectReference } from "../galaxy-object-reference.js"
import { normalizeObjectLinkPage } from "../object-link-client.js"

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u
const SHA256_REVISION = /^sha256:[0-9a-f]{64}$/u
const CODE_REVISION = /^git:(?:[0-9a-f]{40}|[0-9a-f]{64});snapshot:sha256:[0-9a-f]{64}$/u
const PINNED_SHA256_KINDS = new Set([
  "document", "document.anchor", "document.mark", "chat", "proof.graph", "proof.node",
])

export const ATLAS_AUTHORED_RELATIONS = Object.freeze([
  Object.freeze({ id: "related", label: "Related to" }),
  Object.freeze({ id: "cites", label: "Cites" }),
  Object.freeze({ id: "part_of", label: "Part of" }),
  Object.freeze({ id: "derived_from", label: "Derived from" }),
  Object.freeze({ id: "context_for", label: "Context for" }),
  Object.freeze({ id: "formalized_by", label: "Formalized by" }),
  Object.freeze({ id: "defined_in", label: "Defined in" }),
  Object.freeze({ id: "implements", label: "Implements" }),
  Object.freeze({ id: "depends_on", label: "Depends on" }),
  Object.freeze({ id: "documents", label: "Documents" }),
  Object.freeze({ id: "corresponds_to", label: "Corresponds to" }),
])

const RELATION_IDS = new Set(ATLAS_AUTHORED_RELATIONS.map((relation) => relation.id))
const RECOVERY_SCHEMA = "gb.atlas-authored-relation-recovery.v1"

function boundedText(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim()
    ? value
    : null
}

function recoveryKey(scope) {
  const tenantId = boundedText(scope?.tenantId, 256)
  const principalId = boundedText(scope?.principalId, 256)
  const canvasId = boundedText(scope?.canvasId, 256)
  if (!tenantId || !principalId || !canvasId) throw new TypeError("Invalid authored relation recovery scope")
  return `gb:atlas-authored-relation:v1:${encodeURIComponent(tenantId)}:${encodeURIComponent(principalId)}:${encodeURIComponent(canvasId)}`
}

function normalizeRecoveryEndpoint(value) {
  const placementId = boundedText(value?.placementId, 256)
  const label = boundedText(value?.label, 512)
  const endpoint = inspectAtlasAuthoredRelationEndpoint(value?.relationRef)
  if (!placementId || !label || !endpoint.ok) throw new TypeError("Invalid authored relation recovery endpoint")
  return Object.freeze({ placementId, label, relationRef: endpoint.ref })
}

function exactCanonicalReference(value) {
  const parsed = parseGalaxyObjectReference(value)
  if (!parsed || parsed.format !== "canonical" || parsed.selector.mode !== "pinned") return null
  if (PINNED_SHA256_KINDS.has(parsed.kind) && !SHA256_REVISION.test(parsed.selector.revision)) return null
  if (parsed.kind.startsWith("code.") && !CODE_REVISION.test(parsed.selector.revision)) return null
  try {
    return serializeGalaxyObjectReference(parsed)
  } catch {
    return null
  }
}

export function inspectAtlasAuthoredRelationEndpoint(value) {
  const ref = exactCanonicalReference(value)
  return ref
    ? Object.freeze({ ok: true, ref })
    : Object.freeze({ ok: false, code: "exact_reference_required" })
}

export function resolveAtlasAuthoredRelationEndpoint(requestedRef, hydration) {
  if (
    !hydration
    || hydration.status !== "resolved"
    || hydration.requestedRef !== requestedRef
    || hydration.projection?.ref !== hydration.resolvedRef
  ) return Object.freeze({ ok: false, code: "exact_reference_required" })
  const requested = parseGalaxyObjectReference(requestedRef)
  const resolved = parseGalaxyObjectReference(hydration.resolvedRef)
  if (
    !requested
    || requested.format !== "canonical"
    || !resolved
    || resolved.format !== "canonical"
    || requested.kind !== resolved.kind
    || requested.id !== resolved.id
  ) return Object.freeze({ ok: false, code: "exact_reference_required" })
  return inspectAtlasAuthoredRelationEndpoint(hydration.resolvedRef)
}

export function projectAtlasExactRelationPlacements(placements, hydrationByReference) {
  return placements.map((placement) => {
    const endpoint = resolveAtlasAuthoredRelationEndpoint(
      placement.subjectRef,
      hydrationByReference[placement.subjectRef],
    )
    return endpoint.ok
      ? { ...placement, subjectRef: endpoint.ref, authorized: true, availability: "resolved" }
      : placement
  })
}

export function atlasAuthoredRelationEligibility(selection, referenceCounts) {
  if (!selection?.relationRef) {
    return Object.freeze({ ok: false, reason: "Exact pinned revision unavailable." })
  }
  if (referenceCounts.get(selection.relationRef) !== 1) {
    return Object.freeze({ ok: false, reason: "This exact object appears more than once on this Atlas." })
  }
  return Object.freeze({ ok: true, ref: selection.relationRef })
}

export function prepareAtlasAuthoredRelation(input) {
  const source = inspectAtlasAuthoredRelationEndpoint(input?.fromRef)
  const target = inspectAtlasAuthoredRelationEndpoint(input?.toRef)
  if (!source.ok || !target.ok) throw new TypeError("Authored relations require two exact pinned references")
  if (source.ref === target.ref) throw new TypeError("An authored relation must connect two different objects")
  if (!RELATION_IDS.has(input?.relation)) throw new TypeError("Unsupported authored relation")
  if (typeof input?.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    throw new TypeError("Invalid authored relation operation identity")
  }
  return Object.freeze({
    from_ref: source.ref,
    to_ref: target.ref,
    relation: input.relation,
    basis: "authored",
    provenance: Object.freeze({
      source: "manual",
      source_system: "galaxy.atlas.relation-composer.v1",
    }),
    idempotency_key: input.idempotencyKey,
  })
}

export function validateAtlasAuthoredRelationReceipt(value, request) {
  const normalized = normalizeObjectLinkPage([value])
  if (normalized.invalid !== 0 || normalized.links.length !== 1) {
    throw new TypeError("Invalid authored relation receipt")
  }
  const [link] = normalized.links
  if (
    link.from_ref !== request.from_ref
    || link.to_ref !== request.to_ref
    || link.relation !== request.relation
    || link.basis !== "authored"
    || link.provenance.source !== "manual"
    || link.provenance.source_system !== "galaxy.atlas.relation-composer.v1"
    || link.version !== 1
  ) {
    throw new TypeError("Authored relation receipt does not match the confirmed request")
  }
  return link
}

function objectLinkSignature(link) {
  return JSON.stringify([
    link.from_ref,
    link.to_ref,
    link.relation,
    link.basis,
    link.created_by_principal_id ?? null,
    link.created_at ?? null,
    link.version ?? null,
    Object.fromEntries(Object.entries(link.provenance).sort()),
  ])
}

function addObjectLink(index, link) {
  const signature = objectLinkSignature(link)
  const existing = index.get(link.id)
  if (existing && existing.signature !== signature) {
    throw new TypeError("Authored relation receipt conflicts with the current link")
  }
  if (!existing) index.set(link.id, { link, signature })
}

export function mergeAtlasAuthoredRelation(current, confirmed) {
  const index = new Map()
  for (const link of current) addObjectLink(index, link)
  const before = index.size
  addObjectLink(index, confirmed)
  if (index.size === before) return current
  return Object.freeze([...current, confirmed])
}

export function reconcileAtlasObjectLinks(current, refreshes) {
  const incoming = []
  for (const refresh of Array.isArray(refreshes) ? refreshes : []) {
    if (Array.isArray(refresh?.links)) incoming.push(...refresh.links)
  }

  const allCurrent = new Map()
  for (const link of current) addObjectLink(allCurrent, link)
  for (const link of incoming) {
    const existing = allCurrent.get(link.id)
    if (existing && existing.signature !== objectLinkSignature(link)) {
      throw new TypeError("Refreshed object link conflicts with the current link")
    }
  }

  const reconciled = new Map()
  for (const link of current) addObjectLink(reconciled, link)
  for (const link of incoming) addObjectLink(reconciled, link)
  return Object.freeze([...reconciled.values()].map((entry) => entry.link))
}

export function writeAtlasAuthoredRelationRecovery(storage, scope, draft) {
  const source = normalizeRecoveryEndpoint(draft?.source)
  const target = normalizeRecoveryEndpoint(draft?.target)
  const request = prepareAtlasAuthoredRelation({
    fromRef: draft?.request?.from_ref,
    toRef: draft?.request?.to_ref,
    relation: draft?.request?.relation,
    idempotencyKey: draft?.request?.idempotency_key,
  })
  if (source.relationRef !== request.from_ref || target.relationRef !== request.to_ref) {
    throw new TypeError("Authored relation recovery direction does not match its request")
  }
  const record = Object.freeze({ schemaId: RECOVERY_SCHEMA, source, target, request })
  storage.setItem(recoveryKey(scope), JSON.stringify(record))
  return record
}

export function readAtlasAuthoredRelationRecovery(storage, scope) {
  const key = recoveryKey(scope)
  const raw = storage.getItem(key)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).sort().join("\n") !== "request\nschemaId\nsource\ntarget"
      || parsed.schemaId !== RECOVERY_SCHEMA) throw new TypeError("Invalid recovery record")
    const source = normalizeRecoveryEndpoint(parsed.source)
    const target = normalizeRecoveryEndpoint(parsed.target)
    const request = prepareAtlasAuthoredRelation({
      fromRef: parsed.request?.from_ref,
      toRef: parsed.request?.to_ref,
      relation: parsed.request?.relation,
      idempotencyKey: parsed.request?.idempotency_key,
    })
    if (source.relationRef !== request.from_ref || target.relationRef !== request.to_ref) {
      throw new TypeError("Invalid recovery direction")
    }
    return Object.freeze({ schemaId: RECOVERY_SCHEMA, source, target, request })
  } catch {
    storage.removeItem(key)
    return null
  }
}

export function removeAtlasAuthoredRelationRecovery(storage, scope) {
  storage.removeItem(recoveryKey(scope))
}
