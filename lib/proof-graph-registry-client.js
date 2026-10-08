import { parseGalaxyObjectReference } from "./galaxy-object-reference.js"

const SHA256 = /^[0-9a-f]{64}$/u
const GRAPH_KINDS = new Set(["repository-field", "campaign", "mission"])
const ACTIVE_GRAPH_KINDS = new Set(["campaign", "mission"])
export const PROOF_GRAPH_SELECTION_EVENT = "galaxy:proof-graph-selection-change"
const SUMMARY_KEYS = new Set([
  "schemaId", "registrationId", "graphId", "graphKind", "title", "contentSha256",
  "byteSize", "targetCount", "relationCount", "registeredByPrincipalId",
  "registeredByNostrPubkey", "registeredAt", "replayed",
])

function invalid(message) {
  throw new TypeError(`Invalid proof graph registry response: ${message}`)
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

function text(value, maximum, label) {
  if (typeof value !== "string") invalid(`${label} must be text`)
  const normalized = value.trim()
  if (!normalized || Array.from(normalized).length > maximum) invalid(`${label} is outside its bounded contract`)
  return normalized
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${label} must be a non-negative safe integer`)
  return value
}

function timestamp(value, label) {
  const normalized = text(value, 80, label)
  if (!Number.isFinite(Date.parse(normalized))) invalid(`${label} must be an ISO timestamp`)
  return normalized
}

function normalizeSummary(value, label) {
  const source = record(value, label)
  exactKeys(source, SUMMARY_KEYS, label)
  if (source.schemaId !== "gb.proof-graph.summary.v1") invalid(`${label}.schemaId is unsupported`)
  if (!GRAPH_KINDS.has(source.graphKind)) invalid(`${label}.graphKind is unsupported`)
  const contentSha256 = text(source.contentSha256, 64, `${label}.contentSha256`).toLowerCase()
  if (!SHA256.test(contentSha256)) invalid(`${label}.contentSha256 is invalid`)
  if (source.replayed !== undefined && source.replayed !== true) invalid(`${label}.replayed must be true when present`)
  return Object.freeze({
    schemaId: source.schemaId,
    registrationId: text(source.registrationId, 128, `${label}.registrationId`),
    graphId: text(source.graphId, 512, `${label}.graphId`),
    graphKind: source.graphKind,
    title: text(source.title, 1_000, `${label}.title`),
    contentSha256,
    byteSize: count(source.byteSize, `${label}.byteSize`),
    targetCount: count(source.targetCount, `${label}.targetCount`),
    relationCount: count(source.relationCount, `${label}.relationCount`),
    registeredByPrincipalId: text(source.registeredByPrincipalId, 128, `${label}.registeredByPrincipalId`),
    registeredByNostrPubkey: text(source.registeredByNostrPubkey, 128, `${label}.registeredByNostrPubkey`),
    registeredAt: timestamp(source.registeredAt, `${label}.registeredAt`),
    ...(source.replayed === true ? { replayed: true } : {}),
  })
}

export function normalizeProofGraphSummary(value) {
  return normalizeSummary(value, "summary")
}

export function normalizeProofGraphList(value) {
  const source = record(value, "list")
  exactKeys(source, new Set(["schemaId", "graphs", "hasMore", "nextOffset"]), "list")
  if (source.schemaId !== "gb.proof-graph.list.v1") invalid("list.schemaId is unsupported")
  if (!Array.isArray(source.graphs) || source.graphs.length > 200) invalid("list.graphs is not a bounded array")
  if (typeof source.hasMore !== "boolean") invalid("list.hasMore must be boolean")
  const nextOffset = source.nextOffset === null ? null : count(source.nextOffset, "list.nextOffset")
  if (source.hasMore !== (nextOffset !== null)) invalid("list pagination state is inconsistent")
  const graphs = source.graphs.map((item, index) => normalizeSummary(item, `list.graphs[${index}]`))
  if (new Set(graphs.map((graph) => graph.contentSha256)).size !== graphs.length) {
    invalid("list.graphs contains duplicate immutable revisions")
  }
  return Object.freeze({
    schemaId: source.schemaId,
    graphs: Object.freeze(graphs),
    hasMore: source.hasMore,
    nextOffset,
  })
}

function normalizeGraphRef(value, label) {
  const source = record(value, label)
  exactKeys(source, new Set(["graph_id", "content_sha256"]), label)
  const contentSha256 = text(source.content_sha256, 64, `${label}.content_sha256`).toLowerCase()
  if (!SHA256.test(contentSha256)) invalid(`${label}.content_sha256 is invalid`)
  return Object.freeze({
    graphId: text(source.graph_id, 512, `${label}.graph_id`),
    contentSha256,
  })
}

export function normalizeProofWorkspaceList(value, expectedGraph) {
  const source = record(value, "workspaceList")
  exactKeys(source, new Set([
    "schemaId", "graph_ref", "workspaces", "has_more", "next_offset",
  ]), "workspaceList")
  if (source.schemaId !== "galaxy.proof-workspace-summary-list.v1") {
    invalid("workspaceList.schemaId is unsupported")
  }
  const graphRef = normalizeGraphRef(source.graph_ref, "workspaceList.graph_ref")
  if (graphRef.graphId !== expectedGraph.graphId || graphRef.contentSha256 !== expectedGraph.contentSha256) {
    invalid("workspaceList.graph_ref does not match the selected immutable graph")
  }
  if (!Array.isArray(source.workspaces) || source.workspaces.length > 200) {
    invalid("workspaceList.workspaces is not a bounded array")
  }
  if (typeof source.has_more !== "boolean") invalid("workspaceList.has_more must be boolean")
  const nextOffset = source.next_offset === null ? null : count(source.next_offset, "workspaceList.next_offset")
  if (source.has_more !== (nextOffset !== null)) invalid("workspaceList pagination state is inconsistent")
  const workspaces = source.workspaces.map((item, index) => {
    const label = `workspaceList.workspaces[${index}]`
    const workspace = record(item, label)
    exactKeys(workspace, new Set(["workspace_id", "version", "updated_at", "item_count"]), label)
    return Object.freeze({
      workspaceId: text(workspace.workspace_id, 512, `${label}.workspace_id`),
      version: count(workspace.version, `${label}.version`),
      updatedAt: timestamp(workspace.updated_at, `${label}.updated_at`),
      itemCount: count(workspace.item_count, `${label}.item_count`),
    })
  })
  if (new Set(workspaces.map((workspace) => workspace.workspaceId)).size !== workspaces.length) {
    invalid("workspaceList.workspaces contains duplicate identifiers")
  }
  return Object.freeze({
    schemaId: source.schemaId,
    graphRef,
    workspaces: Object.freeze(workspaces),
    hasMore: source.has_more,
    nextOffset,
  })
}

function normalizeVerificationSetSummary(value, label, expectedGraph) {
  const source = record(value, label)
  exactKeys(source, new Set([
    "schemaId", "registrationId", "graphRef", "contentSha256", "byteSize",
    "itemCount", "registeredByPrincipalId", "registeredByNostrPubkey",
    "registeredAt", "replayed",
  ]), label)
  if (source.schemaId !== "gb.proof-verification-set.summary.v1") {
    invalid(`${label}.schemaId is unsupported`)
  }
  if (source.replayed !== undefined && source.replayed !== true) {
    invalid(`${label}.replayed must be true when present`)
  }
  const graphRef = normalizeGraphRef(source.graphRef, `${label}.graphRef`)
  if (graphRef.graphId !== expectedGraph.graphId
    || graphRef.contentSha256 !== expectedGraph.contentSha256) {
    invalid(`${label}.graphRef does not match the selected immutable graph`)
  }
  const contentSha256 = text(source.contentSha256, 64, `${label}.contentSha256`).toLowerCase()
  if (!SHA256.test(contentSha256)) invalid(`${label}.contentSha256 is invalid`)
  return Object.freeze({
    schemaId: source.schemaId,
    registrationId: text(source.registrationId, 128, `${label}.registrationId`),
    graphRef,
    contentSha256,
    byteSize: count(source.byteSize, `${label}.byteSize`),
    itemCount: count(source.itemCount, `${label}.itemCount`),
    registeredByPrincipalId: text(
      source.registeredByPrincipalId,
      128,
      `${label}.registeredByPrincipalId`,
    ),
    registeredByNostrPubkey: text(
      source.registeredByNostrPubkey,
      128,
      `${label}.registeredByNostrPubkey`,
    ),
    registeredAt: timestamp(source.registeredAt, `${label}.registeredAt`),
    ...(source.replayed === true ? { replayed: true } : {}),
  })
}

export function normalizeProofVerificationSetList(value, expectedGraph) {
  const source = record(value, "verificationSetList")
  exactKeys(source, new Set([
    "schemaId", "verificationSets", "hasMore", "nextOffset",
  ]), "verificationSetList")
  if (source.schemaId !== "gb.proof-verification-set.list.v1") {
    invalid("verificationSetList.schemaId is unsupported")
  }
  if (!Array.isArray(source.verificationSets) || source.verificationSets.length > 200) {
    invalid("verificationSetList.verificationSets is not a bounded array")
  }
  if (typeof source.hasMore !== "boolean") {
    invalid("verificationSetList.hasMore must be boolean")
  }
  const nextOffset = source.nextOffset === null
    ? null
    : count(source.nextOffset, "verificationSetList.nextOffset")
  if (source.hasMore !== (nextOffset !== null)) {
    invalid("verificationSetList pagination state is inconsistent")
  }
  const verificationSets = source.verificationSets.map((item, index) => (
    normalizeVerificationSetSummary(
      item,
      `verificationSetList.verificationSets[${index}]`,
      expectedGraph,
    )
  ))
  if (new Set(verificationSets.map((item) => item.contentSha256)).size
    !== verificationSets.length) {
    invalid("verificationSetList contains duplicate immutable revisions")
  }
  return Object.freeze({
    schemaId: source.schemaId,
    verificationSets: Object.freeze(verificationSets),
    hasMore: source.hasMore,
    nextOffset,
  })
}

export function encodeEmptyProofVerificationSet(graph) {
  const graphId = text(graph.graphId, 512, "emptyBaseline.graphId")
  const contentSha256 = text(
    graph.contentSha256,
    64,
    "emptyBaseline.contentSha256",
  ).toLowerCase()
  if (!SHA256.test(contentSha256)) invalid("emptyBaseline.contentSha256 is invalid")
  const artifact = Object.freeze({
    schema_id: "galaxy.proof-verification-set.v1",
    graph_ref: Object.freeze({ graph_id: graphId, content_sha256: contentSha256 }),
    items: Object.freeze([]),
  })
  return Object.freeze({ artifact, bytes: new TextEncoder().encode(JSON.stringify(artifact)) })
}

export function createProofGraphSelection({ summary, proofDag, exactBytes, workspace = null, workState = null }) {
  const graph = normalizeProofGraphSummary(summary)
  if (!(exactBytes instanceof Uint8Array) || exactBytes.byteLength !== graph.byteSize) {
    invalid("exactBytes do not match the registered byte size")
  }
  const document = record(proofDag, "proofDag")
  if (document.schema_id !== "galaxy.proof-dag.v1") invalid("proofDag.schema_id is unsupported")
  if (document.graph_id !== graph.graphId || document.graph_kind !== graph.graphKind) {
    invalid("proofDag identity does not match the selected registration")
  }
  if (graph.graphKind === "repository-field" && (workspace !== null || workState !== null)) {
    invalid("repository-field graphs are passive and cannot select a work overlay")
  }
  if ((workspace === null) !== (workState === null)) {
    invalid("workspace and workState must be selected together")
  }
  let selectedWorkspace = null
  if (workspace !== null) {
    if (!ACTIVE_GRAPH_KINDS.has(graph.graphKind)) invalid("only campaign or mission graphs can activate coordination")
    const normalizedWorkspace = record(workspace, "workspace")
    selectedWorkspace = Object.freeze({
      workspaceId: text(normalizedWorkspace.workspaceId, 512, "workspace.workspaceId"),
      version: count(normalizedWorkspace.version, "workspace.version"),
      updatedAt: timestamp(normalizedWorkspace.updatedAt, "workspace.updatedAt"),
      itemCount: count(normalizedWorkspace.itemCount, "workspace.itemCount"),
    })
    const overlay = record(workState, "workState")
    if (overlay.schema_id !== "galaxy.proof-work-state.v1" || overlay.workspace_id !== selectedWorkspace.workspaceId) {
      invalid("workState does not match the selected workspace")
    }
    const overlayRef = normalizeGraphRef(overlay.graph_ref, "workState.graph_ref")
    if (overlayRef.graphId !== graph.graphId || overlayRef.contentSha256 !== graph.contentSha256) {
      invalid("workState is not bound to the selected immutable graph")
    }
  }
  return Object.freeze({
    summary: graph,
    proofDag: document,
    exactBytes,
    workspace: selectedWorkspace,
    workState: workState === null ? null : workState,
    coordinationActive: selectedWorkspace !== null,
  })
}

export function proofRegistryErrorMessage(status, body, fallback) {
  if (Number.isSafeInteger(status) && status >= 400 && status < 500) {
    const source = body && typeof body === "object" && !Array.isArray(body) ? body : null
    const detail = source && typeof (source.detail ?? source.error) === "string"
      ? String(source.detail ?? source.error).trim()
      : ""
    if (detail && Array.from(detail).length <= 500) return detail
  }
  return fallback
}

export function proofGraphDigestFromReference(reference) {
  const parsed = parseGalaxyObjectReference(reference)
  if (!parsed || parsed.format !== "canonical" || !["proof.graph", "proof.node"].includes(parsed.kind)
    || parsed.selector.mode !== "pinned") return null
  const match = /^sha256:([a-f0-9]{64})$/u.exec(parsed.selector.revision)
  return match?.[1] ?? null
}

export function proofGraphSelectionFromUrl(currentUrl) {
  const url = new URL(currentUrl)
  const configured = url.searchParams.get("proofGraph")
  if (configured && !SHA256.test(configured)) invalid("selection.proofGraph is invalid")
  const candidates = [...new Set([
    configured,
    proofGraphDigestFromReference(url.searchParams.get("ref")),
    proofGraphDigestFromReference(url.searchParams.get("focus")),
  ].filter(Boolean))]
  if (candidates.length > 1) invalid("selection proof graph references disagree")
  return Object.freeze({
    graphHash: candidates[0] ?? "",
    workspaceId: url.searchParams.get("proofWorkspace") ?? "",
  })
}

export function proofGraphSelectionUrl(currentUrl, selection) {
  const url = new URL(currentUrl)
  if (!selection || selection.contentSha256 === null) {
    url.searchParams.delete("proofGraph")
    url.searchParams.delete("proofWorkspace")
    for (const key of ["ref", "focus"]) {
      if (proofGraphDigestFromReference(url.searchParams.get(key))) url.searchParams.delete(key)
    }
    return url.toString()
  }
  const digest = text(selection.contentSha256, 64, "selection.contentSha256").toLowerCase()
  if (!SHA256.test(digest)) invalid("selection.contentSha256 is invalid")
  url.searchParams.set("proofGraph", digest)
  for (const key of ["ref", "focus"]) {
    const pinnedDigest = proofGraphDigestFromReference(url.searchParams.get(key))
    if (pinnedDigest && pinnedDigest !== digest) url.searchParams.delete(key)
  }
  if (selection.workspaceId === null || selection.workspaceId === undefined || selection.workspaceId === "") {
    url.searchParams.delete("proofWorkspace")
  } else {
    url.searchParams.set("proofWorkspace", text(selection.workspaceId, 512, "selection.workspaceId"))
  }
  return url.toString()
}

export function proofRegistryPresenterUrl(currentUrl, open) {
  const url = new URL(currentUrl)
  if (open === true) url.searchParams.set("proofRegistry", "open")
  else url.searchParams.delete("proofRegistry")
  return url.toString()
}
