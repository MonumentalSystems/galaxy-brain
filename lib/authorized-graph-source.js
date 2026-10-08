import { parseGalaxyObjectReference, serializeGalaxyObjectReference } from "./galaxy-object-reference.js"
import { createGalaxyObjectProjection } from "./object-projection.js"
import {
  isLatestHamMemoryProjectionReference,
  isPinnedChatProjectionReference,
  isPinnedSurfaceProjectionReference,
} from "./linked-document-graph.js"
import {
  projectDocumentAnchorObject,
  projectElnObject,
  projectPaperObject,
  projectSurfaceObject,
  projectTaskObject,
} from "./object-projection-adapters.js"

export const AUTHORIZED_GRAPH_SOURCE_SCHEMA_ID = "gb.authorized-graph-source.v1"
export const AUTHORIZED_GRAPH_SOURCE_RESULT_SCHEMA_ID = "gb.authorized-graph-source-result.v1"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const PROVIDER_STATUSES = new Set(["ready", "partial", "unavailable"])
const AUTHORIZED_PROJECTION_KINDS = new Set(["paper", "document", "document.anchor", "ham.memory", "chat", "surface"])
const MAX_ITEMS = 10_000
const INPUT_KEYS = new Set([
  "schemaId", "scope", "query", "providers", "projections", "papers", "anchors", "experiments", "tasks", "surfaces", "links",
])
const SCOPE_KEYS = new Set(["tenantId", "workspaceId"])
const ITEM_KEYS = Object.freeze({
  papers: new Set(["authorized", "scope", "paper", "revision"]),
  anchors: new Set(["authorized", "scope", "anchor"]),
  experiments: new Set(["authorized", "scope", "record"]),
  tasks: new Set(["authorized", "scope", "task"]),
  surfaces: new Set(["authorized", "scope", "surface"]),
  projections: new Set(["authorized", "scope", "projection"]),
  links: new Set(["authorized", "active", "scope", "link"]),
})
const LINK_KEYS = new Set([
  "id", "from_ref", "to_ref", "relation", "basis", "provenance",
  "created_by_principal_id", "created_at", "version",
])

function invalid(message) {
  throw new TypeError(`Invalid ${AUTHORIZED_GRAPH_SOURCE_SCHEMA_ID}: ${message}`)
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

function boundedText(value, maximum, label) {
  if (typeof value !== "string") invalid(`${label} must be text`)
  const normalized = value.trim()
  if (!normalized || Array.from(normalized).length > maximum || CONTROL_CHARACTERS.test(normalized)) {
    invalid(`${label} is outside its bounded text contract`)
  }
  return normalized
}

function boundedArray(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ITEMS) invalid(`${label} must be a bounded array`)
  return value
}

function normalizeScope(value, label) {
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

function canonicalRef(value, label) {
  const parsed = parseGalaxyObjectReference(value)
  if (!parsed || parsed.format !== "canonical") invalid(`${label} must be a canonical Galaxy object reference`)
  return serializeGalaxyObjectReference(parsed)
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
}

function normalizeProviders(values, scope) {
  const byProvider = new Map()
  boundedArray(values, "providers").forEach((value, index) => {
    const provider = record(value, `providers[${index}]`)
    exactKeys(provider, new Set(["scope", "provider", "status", "snapshot", "revision"]), `providers[${index}]`)
    requireScope(provider.scope, scope, `providers[${index}]`)
    const name = boundedText(provider.provider, 120, `providers[${index}].provider`)
    const status = boundedText(provider.status, 40, `providers[${index}].status`)
    if (!PROVIDER_STATUSES.has(status)) invalid(`providers[${index}].status is unsupported`)
    if (byProvider.has(name)) invalid(`providers contains duplicate ${name}`)
    byProvider.set(name, Object.freeze(Object.fromEntries(Object.entries({
      scope,
      provider: name,
      status,
      snapshot: provider.snapshot === undefined
        ? undefined
        : boundedText(provider.snapshot, 512, `providers[${index}].snapshot`),
      revision: provider.revision === undefined
        ? undefined
        : boundedText(provider.revision, 256, `providers[${index}].revision`),
    }).filter(([, item]) => item !== undefined))))
  })
  return [...byProvider.values()].sort((left, right) => left.provider.localeCompare(right.provider))
}

function collectAuthorized(values, kind, scope, projector, diagnostics, projections) {
  boundedArray(values, kind).forEach((value, index) => {
    const item = record(value, `${kind}[${index}]`)
    exactKeys(item, ITEM_KEYS[kind], `${kind}[${index}]`)
    requireScope(item.scope, scope, `${kind}[${index}]`)
    if (item.authorized !== true) {
      diagnostics.omitted.unauthorized[kind] += 1
      return
    }
    const projection = projector(item)
    const existing = projections.get(projection.ref)
    if (existing && stableStringify(existing) !== stableStringify(projection)) {
      invalid(`${kind}[${index}] conflicts with another projection for ${projection.ref}`)
    }
    projections.set(projection.ref, projection)
  })
}

function collectAuthorizedProjections(values, scope, diagnostics, projections) {
  boundedArray(values, "projections").forEach((value, index) => {
    const item = record(value, `projections[${index}]`)
    exactKeys(item, ITEM_KEYS.projections, `projections[${index}]`)
    requireScope(item.scope, scope, `projections[${index}]`)
    if (item.authorized !== true) {
      diagnostics.omitted.unauthorized.projections += 1
      return
    }
    const projection = createGalaxyObjectProjection(item.projection)
    if (!AUTHORIZED_PROJECTION_KINDS.has(projection.kind)) {
      invalid(`projections[${index}].projection.kind is not authorized for this graph seam`)
    }
    if (projection.kind === "ham.memory" && !isLatestHamMemoryProjectionReference(projection.ref)) {
      invalid(`projections[${index}].projection must be a latest canonical HAM memory`)
    }
    if (projection.kind === "chat" && !isPinnedChatProjectionReference(projection.ref)) {
      invalid(`projections[${index}].projection must be an exact pinned canonical chat`)
    }
    if (projection.kind === "surface" && !isPinnedSurfaceProjectionReference(projection.ref)) {
      invalid(`projections[${index}].projection must be an exact pinned canonical surface`)
    }
    const existing = projections.get(projection.ref)
    if (existing && stableStringify(existing) !== stableStringify(projection)) {
      invalid(`projections[${index}] conflicts with another projection for ${projection.ref}`)
    }
    projections.set(projection.ref, projection)
  })
}

function normalizeLink(link, label) {
  const source = record(link, label)
  exactKeys(source, LINK_KEYS, label)
  const provenance = record(source.provenance, `${label}.provenance`)
  exactKeys(provenance, new Set([
    "source", "source_system", "source_ref", "source_snapshot", "extractor_version", "confidence",
  ]), `${label}.provenance`)
  const normalizedProvenance = Object.fromEntries(Object.entries({
    source: provenance.source,
    source_system: provenance.source_system,
    source_ref: provenance.source_ref,
    source_snapshot: provenance.source_snapshot,
    extractor_version: provenance.extractor_version,
    confidence: provenance.confidence,
  }).filter(([, value]) => value !== undefined))
  return Object.freeze({
    id: boundedText(String(source.id), 256, `${label}.id`),
    from_ref: canonicalRef(source.from_ref, `${label}.from_ref`),
    to_ref: canonicalRef(source.to_ref, `${label}.to_ref`),
    relation: boundedText(source.relation, 80, `${label}.relation`),
    basis: boundedText(source.basis, 40, `${label}.basis`),
    provenance: normalizedProvenance,
  })
}

/**
 * Adapt already-authorized resource records into the strict unified graph
 * input. No lookup or reference resolution occurs here; exact scope and exact
 * projected endpoint identity are mandatory.
 */
export function buildAuthorizedGraphSource(input) {
  const source = record(input, "input")
  exactKeys(source, INPUT_KEYS, "input")
  if (source.schemaId !== AUTHORIZED_GRAPH_SOURCE_SCHEMA_ID) invalid("unsupported schemaId")
  const scope = normalizeScope(source.scope, "scope")
  const providers = normalizeProviders(source.providers, scope)
  const projections = new Map()
  const diagnostics = {
    omitted: {
      unauthorized: { projections: 0, papers: 0, anchors: 0, experiments: 0, tasks: 0, surfaces: 0, links: 0 },
      inactiveLinks: 0,
      missingEndpointLinks: 0,
      taskResourceRelations: 0,
    },
    missingEndpointLinks: [],
    partialProviders: providers
      .filter((provider) => provider.status !== "ready")
      .map((provider) => Object.freeze({ provider: provider.provider, status: provider.status })),
  }

  collectAuthorizedProjections(source.projections, scope, diagnostics, projections)
  collectAuthorized(source.papers, "papers", scope, (item) => projectPaperObject({
    paper: item.paper,
    revision: item.revision ?? null,
  }), diagnostics, projections)
  collectAuthorized(source.anchors, "anchors", scope, (item) => projectDocumentAnchorObject(item.anchor), diagnostics, projections)
  // ELN callers convert an authorized Experiment through research-record.ts
  // before crossing this boundary. The common projector then validates and
  // projects that durable research-record contract.
  collectAuthorized(source.experiments, "experiments", scope, (item) => projectElnObject(item.record), diagnostics, projections)
  collectAuthorized(source.tasks, "tasks", scope, (item) => projectTaskObject(item.task), diagnostics, projections)
  collectAuthorized(source.surfaces, "surfaces", scope, (item) => projectSurfaceObject(item.surface), diagnostics, projections)

  const authorizedRefs = new Set(projections.keys())
  const relationByKey = new Map()
  boundedArray(source.tasks, "tasks").forEach((value) => {
    if (value.authorized !== true) return
    const taskProjection = projectTaskObject(value.task)
    const resources = Array.isArray(value.task?.resources) ? value.task.resources.slice(0, MAX_ITEMS) : []
    resources.forEach((resource) => {
      const parsed = resource?.redacted === true || resource?.status === "released"
        ? null
        : parseGalaxyObjectReference(resource?.resourceRef)
      const resourceRef = parsed?.format === "canonical" ? serializeGalaxyObjectReference(parsed) : null
      if (!resourceRef || resourceRef === taskProjection.ref || !authorizedRefs.has(resourceRef)) {
        diagnostics.omitted.taskResourceRelations += 1
        return
      }
      const relation = Object.freeze({
        fromRef: taskProjection.ref,
        toRef: resourceRef,
        relation: "references",
        trust: "structure",
        source: Object.freeze(Object.fromEntries(Object.entries({
          provider: "ham",
          recordId: resource.id,
          revision: taskProjection.provenance.sourceRevision,
          sourceRef: taskProjection.ref,
          resourceMode: resource.mode,
          resourceStatus: resource.status,
        }).filter(([, item]) => item !== undefined))),
      })
      const key = stableStringify(relation)
      relationByKey.set(key, Object.freeze({ scope, relation }))
    })
  })

  const links = []
  boundedArray(source.links, "links").forEach((value, index) => {
    const item = record(value, `links[${index}]`)
    exactKeys(item, ITEM_KEYS.links, `links[${index}]`)
    requireScope(item.scope, scope, `links[${index}]`)
    if (item.authorized !== true) {
      diagnostics.omitted.unauthorized.links += 1
      return
    }
    if (item.active !== true) {
      diagnostics.omitted.inactiveLinks += 1
      return
    }
    const link = normalizeLink(item.link, `links[${index}].link`)
    const missingRefs = [link.from_ref, link.to_ref].filter((reference) => !authorizedRefs.has(reference))
    if (missingRefs.length) {
      diagnostics.omitted.missingEndpointLinks += 1
      diagnostics.missingEndpointLinks.push(Object.freeze({ linkId: link.id, missingRefs: Object.freeze(missingRefs.sort()) }))
      return
    }
    links.push(Object.freeze({ scope, link }))
  })

  const objects = [...projections.values()]
    .sort((left, right) => left.ref.localeCompare(right.ref))
    .map((projection) => Object.freeze({ scope, projection }))
  links.sort((left, right) => (
    left.link.from_ref.localeCompare(right.link.from_ref)
    || left.link.to_ref.localeCompare(right.link.to_ref)
    || left.link.relation.localeCompare(right.link.relation)
    || left.link.id.localeCompare(right.link.id)
  ))
  diagnostics.missingEndpointLinks.sort((left, right) => left.linkId.localeCompare(right.linkId))
  const relations = [...relationByKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, relation]) => relation)

  const graphInput = Object.freeze({
    schemaId: "gb.graph-projection-input.v1",
    scope,
    query: source.query,
    objects: Object.freeze(objects),
    external: Object.freeze([]),
    links: Object.freeze(links),
    relations: Object.freeze(relations),
    proofContexts: Object.freeze([]),
    providers: Object.freeze(providers),
  })
  return Object.freeze({
    schemaId: AUTHORIZED_GRAPH_SOURCE_RESULT_SCHEMA_ID,
    graphInput,
    diagnostics: Object.freeze({
      omitted: Object.freeze({
        unauthorized: Object.freeze(diagnostics.omitted.unauthorized),
        inactiveLinks: diagnostics.omitted.inactiveLinks,
        missingEndpointLinks: diagnostics.omitted.missingEndpointLinks,
        taskResourceRelations: diagnostics.omitted.taskResourceRelations,
      }),
      missingEndpointLinks: Object.freeze(diagnostics.missingEndpointLinks),
      partialProviders: Object.freeze(diagnostics.partialProviders),
    }),
  })
}
