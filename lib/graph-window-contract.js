import { parseGalaxyObjectReference, serializeGalaxyObjectReference } from "./galaxy-object-reference.js"

export const GRAPH_WINDOW_REQUEST_SCHEMA_ID = "gb.graph-window-request.v1"
export const GRAPH_WINDOW_SCHEMA_ID = "gb.graph-window.v1"
export const GRAPH_WINDOW_MEMBER_LIMIT = 200

const SHA256 = /^[0-9a-f]{64}$/u
const CLUSTER_ID = /^gwc:[0-9a-f]{64}$/u
const MODES = new Set(["mixed"])
const KINDS = new Set(["document", "paper", "eln.experiment", "surface"])
const RELATIONS = new Set(["related", "cites", "part_of", "derived_from", "context_for"])
const PROVIDER_STATUS = new Set(["ready", "partial", "unavailable"])
const PROVIDER_BY_KIND = Object.freeze({
  document: "galaxy.document",
  paper: "galaxy.paper",
  "eln.experiment": "galaxy.eln",
  surface: "galaxy.surface",
})
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u

function invalid(message) {
  throw new TypeError(`Invalid ${GRAPH_WINDOW_SCHEMA_ID}: ${message}`)
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`)
  return value
}

function exactKeys(value, expected, label) {
  const keys = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    invalid(`${label} fields are invalid`)
  }
}

function text(value, label, maximum = 512) {
  if (typeof value !== "string" || value !== value.trim() || !value || CONTROL.test(value)
      || new TextEncoder().encode(value).length > maximum) invalid(`${label} must be bounded text`)
  return value
}

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(`${label} must be finite`)
  return value
}

function stringSet(value, allowed, label) {
  if (!Array.isArray(value) || value.length > allowed.size) invalid(`${label} must be bounded`)
  const result = value.map((item) => text(item, `${label}[]`, 80))
  if (new Set(result).size !== result.length || result.some((item) => !allowed.has(item))) {
    invalid(`${label} contains unsupported values`)
  }
  return Object.freeze([...result].sort())
}

function viewport(value) {
  if (value === null) return null
  const source = record(value, "viewport")
  exactKeys(source, ["x", "y", "width", "height"], "viewport")
  const result = Object.freeze({
    x: finite(source.x, "viewport.x"),
    y: finite(source.y, "viewport.y"),
    width: finite(source.width, "viewport.width"),
    height: finite(source.height, "viewport.height"),
  })
  if (Object.values(result).some((coordinate) => Math.abs(coordinate) > 1_000_000)) {
    invalid("viewport is outside the supported field")
  }
  if (result.width <= 0 || result.height <= 0) invalid("viewport dimensions must be positive")
  return result
}

export function createGraphWindowRequest(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {}
  const mode = source.mode ?? "mixed"
  if (!MODES.has(mode)) invalid("mode is unsupported")
  const kinds = stringSet(source.kinds ?? [], KINDS, "filters.kinds")
  const relations = stringSet(source.relations ?? [], RELATIONS, "filters.relations")
  const rootRef = source.rootRef ?? null
  if (rootRef !== null) {
    const parsed = parseGalaxyObjectReference(rootRef)
    if (!parsed || parsed.format !== "canonical" || serializeGalaxyObjectReference(parsed) !== rootRef) {
      invalid("rootRef must be canonical")
    }
  }
  const expandClusterId = source.expandClusterId ?? null
  if (expandClusterId !== null && (typeof expandClusterId !== "string" || !CLUSTER_ID.test(expandClusterId))) {
    invalid("expandClusterId is invalid")
  }
  const cursor = source.cursor ?? null
  if (cursor !== null && (typeof cursor !== "string" || cursor.length > 8192 || !/^[A-Za-z0-9_.-]+$/u.test(cursor))) {
    invalid("cursor is invalid")
  }
  if (cursor && !expandClusterId) invalid("cursor requires expandClusterId")
  return Object.freeze({
    schemaId: GRAPH_WINDOW_REQUEST_SCHEMA_ID,
    workspaceId: "tenant-catalog",
    mode,
    lens: "explore",
    scale: "corpus",
    viewport: viewport(source.viewport ?? null),
    filters: Object.freeze({ kinds, relations }),
    rootRef,
    expandClusterId,
    cursor,
  })
}

function parseQuery(value, request) {
  const source = record(value, "query")
  exactKeys(source, [
    "workspaceId", "mode", "lens", "scale", "viewport", "filters", "rootRef", "expandClusterId", "cursor",
  ], "query")
  const filters = record(source.filters, "query.filters")
  exactKeys(filters, ["kinds", "relations"], "query.filters")
  const normalized = createGraphWindowRequest({
    mode: source.mode,
    viewport: source.viewport,
    kinds: filters.kinds,
    relations: filters.relations,
    rootRef: source.rootRef,
    expandClusterId: source.expandClusterId,
    cursor: source.cursor,
  })
  if (source.workspaceId !== "tenant-catalog" || source.lens !== "explore" || source.scale !== "corpus") {
    invalid("query boundary changed")
  }
  if (JSON.stringify(normalized) !== JSON.stringify(request)) invalid("query does not match the request")
  return normalized
}

function parseCluster(value, index) {
  const source = record(value, `clusters[${index}]`)
  exactKeys(source, ["id", "provider", "kind", "label", "count", "countStatus", "expandable", "bounds"], `clusters[${index}]`)
  if (!CLUSTER_ID.test(source.id)) invalid(`clusters[${index}].id is invalid`)
  if (!KINDS.has(source.kind)) invalid(`clusters[${index}].kind is unsupported`)
  if (source.provider !== PROVIDER_BY_KIND[source.kind]) invalid(`clusters[${index}].provider is invalid`)
  if (!["exact", "unavailable"].includes(source.countStatus)) invalid(`clusters[${index}].countStatus is invalid`)
  if (source.countStatus === "exact" && (!Number.isSafeInteger(source.count) || source.count < 0)) {
    invalid(`clusters[${index}].count is invalid`)
  }
  if (source.countStatus === "unavailable" && source.count !== null) invalid(`clusters[${index}].count must be null`)
  if (typeof source.expandable !== "boolean") invalid(`clusters[${index}].expandable is invalid`)
  const bounds = record(source.bounds, `clusters[${index}].bounds`)
  exactKeys(bounds, ["x", "y", "width", "height"], `clusters[${index}].bounds`)
  const normalizedBounds = Object.freeze({
    x: finite(bounds.x, `clusters[${index}].bounds.x`),
    y: finite(bounds.y, `clusters[${index}].bounds.y`),
    width: finite(bounds.width, `clusters[${index}].bounds.width`),
    height: finite(bounds.height, `clusters[${index}].bounds.height`),
  })
  if (normalizedBounds.width <= 0 || normalizedBounds.height <= 0) invalid(`clusters[${index}].bounds is invalid`)
  return Object.freeze({
    id: source.id,
    provider: text(source.provider, `clusters[${index}].provider`, 120),
    kind: source.kind,
    label: text(source.label, `clusters[${index}].label`, 120),
    count: source.count,
    countStatus: source.countStatus,
    expandable: source.expandable,
    bounds: normalizedBounds,
  })
}

function parseMember(value, index, clusters) {
  const source = record(value, `members[${index}]`)
  exactKeys(source, ["ref", "clusterId", "provider", "kind", "title", "updatedAt"], `members[${index}]`)
  const cluster = clusters.get(source.clusterId)
  if (!cluster || cluster.kind !== source.kind || cluster.provider !== source.provider) {
    invalid(`members[${index}] does not belong to its aggregate`)
  }
  const parsed = parseGalaxyObjectReference(source.ref)
  if (!parsed || parsed.format !== "canonical" || parsed.selector?.mode !== "pinned" || parsed.kind !== source.kind
      || serializeGalaxyObjectReference(parsed) !== source.ref) invalid(`members[${index}].ref must be exact and pinned`)
  const updatedAt = text(source.updatedAt, `members[${index}].updatedAt`, 80)
  if (!Number.isFinite(Date.parse(updatedAt))) invalid(`members[${index}].updatedAt is invalid`)
  return Object.freeze({
    ref: source.ref,
    clusterId: source.clusterId,
    provider: source.provider,
    kind: source.kind,
    title: text(source.title, `members[${index}].title`, 1000),
    updatedAt,
  })
}

export function parseGraphWindowResponse(value, requestValue) {
  const request = createGraphWindowRequest(requestValue)
  const source = record(value, "response")
  exactKeys(source, [
    "schemaId", "consistency", "query", "windowHash", "clusters", "members", "edges",
    "focus", "providers", "provenance", "continuation",
  ], "response")
  if (source.schemaId !== GRAPH_WINDOW_SCHEMA_ID || source.consistency !== "follow-latest") {
    invalid("response schema or consistency is unsupported")
  }
  const query = parseQuery(source.query, request)
  if (typeof source.windowHash !== "string" || !SHA256.test(source.windowHash)) invalid("windowHash is invalid")
  if (!Array.isArray(source.clusters) || source.clusters.length > 8) invalid("clusters are not bounded")
  const clusters = source.clusters.map(parseCluster)
  const clusterMap = new Map(clusters.map((cluster) => [cluster.id, cluster]))
  if (clusterMap.size !== clusters.length) invalid("clusters contain duplicate IDs")
  if (!Array.isArray(source.members) || source.members.length > GRAPH_WINDOW_MEMBER_LIMIT) invalid("members are not bounded")
  const members = source.members.map((member, index) => parseMember(member, index, clusterMap))
  if (new Set(members.map((member) => member.ref)).size !== members.length) invalid("members contain duplicate refs")
  if (!Array.isArray(source.edges) || source.edges.length !== 0) invalid("this response version does not emit aggregate edges")
  if ((source.focus === null) !== (request.rootRef === null)) {
    invalid("focus does not match the request")
  }
  if (source.focus !== null) {
    const focus = record(source.focus, "focus")
    exactKeys(focus, ["ref"], "focus")
    if (focus.ref !== request.rootRef) invalid("focus does not match the request")
  }
  if (!Array.isArray(source.providers) || source.providers.length > 16) invalid("providers are not bounded")
  const providers = source.providers.map((item, index) => {
    const provider = record(item, `providers[${index}]`)
    const allowed = new Set(["provider", "status", "count", "reason"])
    if (!Object.hasOwn(provider, "provider") || !Object.hasOwn(provider, "status")
        || Object.keys(provider).some((key) => !allowed.has(key))) invalid(`providers[${index}] is invalid`)
    if (!PROVIDER_STATUS.has(provider.status)) invalid(`providers[${index}].status is invalid`)
    if (provider.count !== undefined && (!Number.isSafeInteger(provider.count) || provider.count < 0)) {
      invalid(`providers[${index}].count is invalid`)
    }
    if (provider.reason !== undefined) text(provider.reason, `providers[${index}].reason`, 500)
    return Object.freeze({ ...provider, provider: text(provider.provider, `providers[${index}].provider`, 120) })
  })
  if (new Set(providers.map((provider) => provider.provider)).size !== providers.length) {
    invalid("providers contain duplicates")
  }
  const provenance = record(source.provenance, "provenance")
  exactKeys(provenance, ["workspaceId", "source", "memberReferences"], "provenance")
  if (provenance.workspaceId !== "tenant-catalog" || provenance.memberReferences !== "exact-pinned-only") {
    invalid("provenance boundary changed")
  }
  text(provenance.source, "provenance.source", 240)
  const continuation = record(source.continuation, "continuation")
  exactKeys(continuation, ["cursor", "hasMore", "model"], "continuation")
  if (typeof continuation.hasMore !== "boolean" || continuation.model !== "replace-page") invalid("continuation is invalid")
  if ((continuation.cursor === null) !== !continuation.hasMore) invalid("continuation cursor and state disagree")
  if (continuation.cursor !== null && (typeof continuation.cursor !== "string" || continuation.cursor.length > 8192
      || !/^[A-Za-z0-9_.-]+$/u.test(continuation.cursor))) {
    invalid("continuation cursor is invalid")
  }
  return Object.freeze({
    schemaId: GRAPH_WINDOW_SCHEMA_ID,
    consistency: "follow-latest",
    query,
    windowHash: source.windowHash,
    clusters: Object.freeze(clusters),
    members: Object.freeze(members),
    edges: Object.freeze([]),
    focus: source.focus === null ? null : Object.freeze({ ref: source.focus.ref }),
    providers: Object.freeze(providers),
    provenance: Object.freeze({ ...provenance }),
    continuation: Object.freeze({ ...continuation }),
  })
}
