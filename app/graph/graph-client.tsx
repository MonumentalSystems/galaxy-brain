"use client"

import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react"
import { useRouter, useSearchParams } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { ConversationBrowser } from "@/components/graph/conversation-browser"
import {
  ConversationForkDialog,
  type ConversationForkTarget,
} from "@/components/graph/conversation-fork-dialog"
import {
  ConversationJoinDialog,
  type ConversationJoinTarget,
} from "@/components/graph/conversation-join-dialog"
import { UnifiedGraph, type UnifiedGraphProjection } from "@/components/graph/unified-graph"
import { CorpusGraphWindow } from "@/components/graph/corpus-graph-window"
import { ProofGraphRegistryDialog } from "@/components/graph/proof-graph-registry-dialog"
import { SemanticField } from "@/components/knowledge/semantic-field"
import { Button } from "@/components/ui/button"
import {
  buildAuthorizedGraphSource,
  type ActiveObjectLinkRow,
  type AuthorizedGraphSourceInput,
} from "@/lib/authorized-graph-source.js"
import {
  buildAuthorizedProofGraphSource,
  type AuthorizedProofGraphSourceResult,
} from "@/lib/authorized-proof-graph-source.js"
import {
  buildAuthorizedTaskPlanGraphSource,
  type AuthorizedTaskPlanGraphSourceResult,
} from "@/lib/authorized-task-plan-graph-source.js"
import { setBrowserTenantScope } from "@/lib/browser-utils"
import { resolveObjectProjectionReferences } from "@/lib/atlas-object-hydration.js"
import { buildAuthorizedCodeGraphSource } from "@/lib/authorized-code-graph-source.js"
import {
  CodeGraphSnapshotSessionClient,
  CodeGraphSnapshotSourceError,
  validateCodeGraphLensReferences,
} from "@/lib/code-graph-snapshot-client.js"
import {
  assembleConversationGraphPages,
  canonicalGraphQueryParameter,
  CONVERSATION_PAGE_LIMIT,
  CONVERSATION_TURN_LIMIT,
  conversationGraphPagePath,
  resolveConversationGraphRoute,
  type ConversationGraphSelection,
} from "@/lib/conversation-graph-client.js"
import {
  conversationForkReceiptApplies,
  conversationForkRecoveryStorageKey,
  parseConversationForkRecovery,
  reconcileConversationFork,
  serializeConversationForkRecovery,
  type ConversationForkIntent,
  type ConversationForkRecovery,
  type ConversationForkReceipt,
} from "@/lib/conversation-fork-client.js"
import {
  conversationJoinReceiptApplies,
  conversationJoinRecoveryStorageKey,
  deriveConversationJoinCandidates,
  parseConversationJoinRecovery,
  reconcileConversationJoin,
  serializeConversationJoinRecovery,
  type ConversationJoinIntent,
  type ConversationJoinRecovery,
  type ConversationJoinReceipt,
} from "@/lib/conversation-join-client.js"
import {
  ConversationMarkdownDownloadError,
  fetchConversationMarkdownExport,
  saveConversationMarkdownExport,
} from "@/lib/conversation-markdown-export-client.js"
import { experimentToResearchRecord } from "@/lib/research-record"
import { fetchTaskDetail, fetchTaskSnapshot } from "@/lib/ham-task-client"
import {
  createGraphWindowRequest,
  parseGraphWindowResponse,
  type GraphWindowCluster,
  type GraphWindowRequest,
  type GraphWindowResponse,
} from "@/lib/graph-window-contract.js"
import {
  planProofCorpusScaleNavigation,
  proofGraphReturnHref,
} from "@/lib/graph-semantic-navigation.js"
import type { GraphScale } from "@/lib/graph-layout-client.js"
import type { Experiment } from "@/lib/galaxy-brain-api"
import {
  createGalaxyObjectReference,
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "@/lib/galaxy-object-reference.js"
import {
  projectElnObject,
  projectPaperObject,
  projectSurfaceObject,
  projectTaskObject,
} from "@/lib/object-projection-adapters.js"
import type { GalaxyObjectProjection } from "@/lib/object-projection"
import { normalizeObjectLinkPage } from "@/lib/object-link-client.js"
import {
  isGraphGatewayProjectionReference,
  linkedProjectionProviderStatus,
  LINKED_PROJECTION_LIMIT,
  selectMissingLinkedProjectionReferences,
} from "@/lib/linked-document-graph.js"
import {
  joinAuthorizedProofHamCoordination,
  PROOF_HAM_COORDINATION_SCHEMA_ID,
} from "@/lib/proof-ham-coordination.js"
import {
  normalizeProofGraphList,
  normalizeProofWorkspaceList,
  proofGraphDigestFromReference,
  PROOF_GRAPH_SELECTION_EVENT,
  proofRegistryPresenterUrl,
} from "@/lib/proof-graph-registry-client.js"
import {
  projectUnifiedGraph,
  type GalaxyGraphQuery,
  type GalaxyGraphScope,
  type UnifiedGraphInput,
} from "@/lib/unified-graph.js"
import type { GalaxyPaper, GalaxyPaperDetail, GalaxyPaperRevision } from "@/lib/types/papers"
import type { GalaxySurfaceContractManifest, GalaxySurfaceRecord } from "@/lib/types/surfaces"
import type { TaskPlanRecord } from "@/lib/types/task-plans"
import type { TaskDetail, TaskPage, TaskSummary } from "@/lib/types/tasks"
import type { GalaxyWorkspace } from "@/lib/galaxy-brain-service"
import { projectUnifiedGraphToSemanticField } from "@/lib/unified-field-projection.js"
import { BUILTIN_GENEROUS_SURFACE_RENDERER, isCompatibleSurfaceCatalogDigest } from "@/lib/surface-renderer-registry.js"

const SOURCE_LIMIT = 60
const LINK_REFERENCE_LIMIT = 64
const LINK_CONCURRENCY = 6
const PROOF_TASK_HYDRATION_LIMIT = 64
const TASK_PLAN_SOURCE_LIMIT = 256
const TASK_PLAN_TASK_HYDRATION_LIMIT = 16
const GRAPH_NODE_LIMIT = 1200
const PROOF_GRAPH_LIST_LIMIT = 200
const SHA256 = /^[a-f0-9]{64}$/u
const MODE_VALUES = new Set(["mixed", "proof", "task", "conversation", "citation", "federated"])
const LENS_VALUES = new Set(["explore", "verify", "compose"])
const SCALE_VALUES = new Set(["corpus", "project", "task", "run", "object", "atomic"])
const WINDOW_MODES = new Set(["mixed"])

const AUTHORIZED_FIELD_WORKSPACE: GalaxyWorkspace = {
  id: "tenant-catalog",
  name: "Field",
  description: "Authorized objects and relations across this private Galaxy",
  rootFolderId: "tenant-catalog",
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

function fieldHrefForReference(reference: string) {
  return `/field?ref=${encodeURIComponent(reference)}`
}

type ProviderStatus = "ready" | "partial" | "unavailable"
type ProviderDescriptor = NonNullable<AuthorizedGraphSourceInput["providers"]>[number]
type LoadedSource<T> = { status: ProviderStatus; values: T[]; truncated: boolean }
type LoadedGraph = {
  projection: UnifiedGraphProjection
  diagnostics: ReturnType<typeof buildAuthorizedGraphSource>["diagnostics"]
  taskPlanSourceContinuation: AuthorizedTaskPlanGraphSourceResult["sourceContinuation"] | null
  proofSourceContinuation: AuthorizedProofGraphSourceResult["sourceContinuation"] | null
  proofGraphReference: string | null
  coordinationTasks: TaskSummary[]
  conversationReference: string | null
  conversationVersion: number | null
  conversationContentHash: string | null
  conversationLoadedTurnCount: number
  conversationHasMore: boolean
  turnContentByReference: Readonly<Record<string, string>>
  codeSnapshotReference: string | null
  codeSourceDocumentHref: string | null
  codeSourceContinuation: Readonly<{ truncated: boolean; omittedNodes: number; omittedEdges: number }> | null
  codeSourceStatus: string | null
}
type ExactGraphSource =
  | { kind: "paper"; reference: string; paper: GalaxyPaperDetail; revision: GalaxyPaperRevision | null }
  | { kind: "eln.experiment"; reference: string; experiment: Experiment }
  | { kind: "ham.task"; reference: string; task: TaskDetail }
  | { kind: "task-plan"; reference: string; taskPlan: TaskPlanRecord }

type ProofGraphSummary = {
  graphId: string
  graphKind: "repository-field" | "campaign" | "mission"
  contentSha256: string
}

type ProofGraphSelection = {
  status: ProviderStatus
  summaryCount: number
  selected: ProofGraphSummary | null
  proofDag: unknown | null
  workState: unknown | null
  activateCoordination: boolean
}

const EXACT_SOURCE_KINDS = new Set(["paper", "eln.experiment", "ham.task", "task-plan", "task-plan.job"])

function safeCanonicalReference(value: string | null) {
  if (!value) return null
  const parsed = parseGalaxyObjectReference(value)
  return parsed?.format === "canonical" ? serializeGalaxyObjectReference(parsed) : null
}

function isPromotedGenerousSurfaceForTenant(
  value: GalaxySurfaceRecord,
  tenantId: string,
  contract: GalaxySurfaceContractManifest,
): value is GalaxySurfaceRecord {
  return value?.tenant_id === tenantId
    && value.status === "promoted"
    && value.schema_version === "gb.surface.v1"
    && value.catalog_id === "generous.a2ui"
    && value.catalog_version === "1"
    && value.schema_digest === contract.digests.schema
    && isCompatibleSurfaceCatalogDigest(value.catalog_digest)
    && value.renderer_version === contract.catalog.renderer.version
    && Number.isSafeInteger(value.current_version)
    && value.current_version >= 1
    && /^[a-f0-9]{64}$/u.test(value.current_content_hash)
    && value.current_spec?.schema === "gb.surface.v1"
    && value.current_spec.catalog?.id === "generous.a2ui"
    && value.current_spec.catalog?.version === "1"
}

function graphSurfaceContract(value: unknown): GalaxySurfaceContractManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const contract = value as GalaxySurfaceContractManifest
  return contract.format === "galaxy.surface-contract"
    && contract.manifestVersion === 1
    && contract.schema?.id === BUILTIN_GENEROUS_SURFACE_RENDERER.schema
    && contract.catalog?.id === BUILTIN_GENEROUS_SURFACE_RENDERER.catalogId
    && contract.catalog.version === BUILTIN_GENEROUS_SURFACE_RENDERER.catalogVersion
    && contract.catalog.renderer?.id === BUILTIN_GENEROUS_SURFACE_RENDERER.rendererId
    && contract.catalog.renderer.version === BUILTIN_GENEROUS_SURFACE_RENDERER.rendererVersion
    && contract.digests?.algorithm === "sha256"
    && contract.digests.schema === BUILTIN_GENEROUS_SURFACE_RENDERER.schemaDigest
    && contract.digests.catalog === BUILTIN_GENEROUS_SURFACE_RENDERER.catalogDigest
    ? contract
    : null
}

type PendingConversationFork = Readonly<{
  tenantId: string
  intent: ConversationForkIntent
  receipt: ConversationForkReceipt
  target: ConversationForkTarget
  status: "reconciling" | "failed"
}>

type PendingConversationJoin = Readonly<{
  tenantId: string
  intent: ConversationJoinIntent
  receipt: ConversationJoinReceipt
  target: ConversationJoinTarget
  status: "reconciling" | "failed"
}>

type ConversationExportState = Readonly<{
  reference: string | null
  status: "idle" | "downloading" | "downloaded" | "error"
  message: string | null
}>

function resolvedGatewayProjections(
  results: Awaited<ReturnType<typeof resolveObjectProjectionReferences>>["results"],
) {
  return results.flatMap((result): GalaxyObjectProjection[] => (
    result.status === "resolved" && result.requestedRef === result.resolvedRef
      ? [result.projection]
      : []
  ))
}

function oneOf<T extends string>(value: string | null, allowed: Set<string>, fallback: T): T {
  return value && allowed.has(value) ? value as T : fallback
}

function graphQueryFromParameters(parameters: URLSearchParams): GalaxyGraphQuery {
  return {
    rootRef: safeCanonicalReference(parameters.get("focus")),
    mode: oneOf(parameters.get("mode"), MODE_VALUES, "mixed"),
    lens: oneOf(parameters.get("lens"), LENS_VALUES, "explore"),
    scale: oneOf(parameters.get("scale"), SCALE_VALUES, "corpus"),
  }
}

function shouldUseCorpusWindow(parameters: URLSearchParams) {
  const query = graphQueryFromParameters(parameters)
  const requestedFocus = parameters.get("focus")
  return query.scale === "corpus"
    && WINDOW_MODES.has(query.mode ?? "mixed")
    && query.lens === "explore"
    && !parameters.get("ref")
    && (!requestedFocus || (parameters.get("corpusWindow") === "1" && query.rootRef === requestedFocus))
    && !parameters.get("conversation")
    && !parameters.get("proofGraph")
    && !parameters.get("proofWorkspace")
    && !parameters.get("codeSnapshot")
}

function exactCodeSnapshotParameter(parameters: URLSearchParams) {
  if (!parameters.has("codeSnapshot")) return null
  const values = parameters.getAll("codeSnapshot")
  if (values.length !== 1) throw new CodeGraphSnapshotSourceError("source-reference", "codeSnapshot must be supplied exactly once")
  const reference = safeCanonicalReference(values[0])
  const parsed = reference ? parseGalaxyObjectReference(reference) : null
  if (!parsed || reference !== values[0] || parsed.kind !== "document" || parsed.selector.mode !== "pinned") {
    throw new CodeGraphSnapshotSourceError("source-reference", "codeSnapshot must be an exact pinned document reference")
  }
  return reference
}

function safeGraphLoadError(cause: unknown, codeSnapshotActive: boolean) {
  if (!codeSnapshotActive) return "The authorized graph could not be assembled."
  if (cause instanceof CodeGraphSnapshotSourceError) {
    if (["size", "worker-over-cap"].includes(cause.code)) return "The exact code snapshot exceeds its bounded interactive limit."
    if (["headers", "integrity"].includes(cause.code)) return "The exact code snapshot failed its response integrity check."
    if (["source-reference", "authorization", "projection", "selection"].includes(cause.code)) {
      return "The code snapshot or selected object is not an authorized exact pin."
    }
    if (["fetch", "body"].includes(cause.code)) return "The authorized exact code snapshot is currently unavailable."
    if (cause.code === "worker-invalid") return "The exact snapshot is not a valid bounded Codebase Memory graph."
    if (cause.code === "worker-session") return "The exact snapshot session changed before this neighborhood finished loading."
  }
  return "The exact snapshot could not be validated as a bounded Codebase Memory graph."
}

function corpusWindowRequest(
  parameters: URLSearchParams,
  expandClusterId: string | null,
  cursor: string | null,
): GraphWindowRequest {
  const query = graphQueryFromParameters(parameters)
  const mode = query.mode ?? "mixed"
  return createGraphWindowRequest({
    mode: WINDOW_MODES.has(mode) ? mode as GraphWindowRequest["mode"] : "mixed",
    rootRef: query.rootRef ?? null,
    expandClusterId,
    cursor,
  })
}

async function loadCorpusWindow(request: GraphWindowRequest, signal: AbortSignal): Promise<GraphWindowResponse> {
  const response = await fetch("/api/graph/window", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    cache: "no-store",
    signal,
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error("The bounded corpus window is unavailable")
  return parseGraphWindowResponse(body, request)
}

function explicitProofSelection(parameters: URLSearchParams, query: GalaxyGraphQuery, requestedReference: string | null) {
  const configured = parameters.get("proofGraph")
  if (configured && !SHA256.test(configured)) throw new Error("Selected proof graph digest is invalid")
  const referenceDigests = [
    proofGraphDigestFromReference(requestedReference),
    proofGraphDigestFromReference(query.rootRef ?? null),
  ].filter((value): value is string => Boolean(value))
  const candidates = [...new Set([configured, ...referenceDigests].filter((value): value is string => Boolean(value)))]
  if (candidates.length > 1) throw new Error("Selected proof graph references disagree")
  const workspaceId = parameters.get("proofWorkspace")
  if (workspaceId && (workspaceId.length > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(workspaceId))) {
    throw new Error("Selected proof workspace is invalid")
  }
  return { contentSha256: candidates[0] ?? null, workspaceId: workspaceId || null }
}

async function sha256Hex(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")
}

async function loadProofGraphSelection(
  parameters: URLSearchParams,
  query: GalaxyGraphQuery,
  requestedReference: string | null,
  signal: AbortSignal,
): Promise<ProofGraphSelection> {
  const selection = explicitProofSelection(parameters, query, requestedReference)
  if (selection.workspaceId && !selection.contentSha256) {
    throw new Error("A proof workspace requires an explicit immutable graph selection")
  }
  let registryList: ReturnType<typeof normalizeProofGraphList> | null = null
  try {
    const response = await fetch(`/api/eln/proof-graphs?limit=${PROOF_GRAPH_LIST_LIMIT}&offset=0`, {
      cache: "no-store",
      signal,
    })
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) throw new Error("Proof graph registry is unavailable")
    registryList = normalizeProofGraphList(body)
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause
    if (!selection.contentSha256) {
      return { status: "unavailable", summaryCount: 0, selected: null, proofDag: null, workState: null, activateCoordination: false }
    }
  }
  const summaries = registryList?.graphs ?? []
  const listPartial = registryList === null || registryList.hasMore
  if (!selection.contentSha256) {
    return {
      status: listPartial ? "partial" : "ready",
      summaryCount: summaries.length,
      selected: null,
      proofDag: null,
      workState: null,
      activateCoordination: false,
    }
  }

  const exact = await fetch(`/api/eln/proof-graphs/${selection.contentSha256}`, { cache: "no-store", signal })
  if (!exact.ok) throw new Error("Selected proof graph is unavailable")
  const bytes = await exact.arrayBuffer()
  if (await sha256Hex(bytes) !== selection.contentSha256
    || exact.headers.get("x-content-sha256") !== selection.contentSha256) {
    throw new Error("Selected proof graph failed its content hash check")
  }
  const proofDag: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  if (!proofDag || typeof proofDag !== "object" || Array.isArray(proofDag)) {
    throw new Error("Selected proof graph is not a JSON object")
  }
  let exactGraphId = ""
  try {
    exactGraphId = decodeURIComponent(exact.headers.get("x-proof-graph-id") || "")
  } catch {
    throw new Error("Selected proof graph identity header is invalid")
  }
  const exactGraphKind = exact.headers.get("x-proof-graph-kind")
  const proofDocument = proofDag as Record<string, unknown>
  if (proofDocument.schema_id !== "galaxy.proof-dag.v1"
    || proofDocument.graph_id !== exactGraphId
    || proofDocument.graph_kind !== exactGraphKind
    || !["repository-field", "campaign", "mission"].includes(exactGraphKind || "")) {
    throw new Error("Selected proof graph body and registry identity disagree")
  }
  const listed = summaries.find((summary) => summary.contentSha256 === selection.contentSha256) ?? null
  if (listed && (listed.graphId !== exactGraphId || listed.graphKind !== exactGraphKind || listed.byteSize !== bytes.byteLength)) {
    throw new Error("Selected proof graph summary and exact artifact disagree")
  }
  const selected: ProofGraphSummary = {
    graphId: exactGraphId,
    graphKind: exactGraphKind as ProofGraphSummary["graphKind"],
    contentSha256: selection.contentSha256,
  }
  if (!selection.workspaceId) {
    return {
      status: listPartial ? "partial" : "ready",
      summaryCount: summaries.length,
      selected,
      proofDag,
      workState: null,
      activateCoordination: false,
    }
  }
  if (selected.graphKind === "repository-field") {
    throw new Error("Repository fields are passive and cannot activate a proof workspace")
  }

  const workspaceQuery = new URLSearchParams({
    graph_id: selected.graphId,
    content_sha256: selected.contentSha256,
    limit: "200",
    offset: "0",
  })
  let workspaceList: ReturnType<typeof normalizeProofWorkspaceList> | null = null
  try {
    const workspaceResponse = await fetch(`/api/eln/proof-workspaces?${workspaceQuery}`, {
      cache: "no-store",
      signal,
    })
    const workspaceBody: unknown = await workspaceResponse.json().catch(() => null)
    if (!workspaceResponse.ok) throw new Error("Proof workspace discovery is unavailable")
    workspaceList = normalizeProofWorkspaceList(workspaceBody, selected)
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause
  }
  const stateQuery = new URLSearchParams({
    graph_id: selected.graphId,
    content_sha256: selected.contentSha256,
  })
  const workState = await requestAuthorizedObject<unknown>(
    `/api/eln/proof-workspaces/${encodeURIComponent(selection.workspaceId)}?${stateQuery}`,
    signal,
  )
  if (!workState || typeof workState !== "object" || Array.isArray(workState)) {
    throw new Error("Selected proof workspace state is invalid")
  }
  const state = workState as Record<string, unknown>
  const stateRef = state.graph_ref
  if (state.schema_id !== "galaxy.proof-work-state.v1" || state.workspace_id !== selection.workspaceId
    || !stateRef || typeof stateRef !== "object" || Array.isArray(stateRef)
    || (stateRef as Record<string, unknown>).graph_id !== selected.graphId
    || (stateRef as Record<string, unknown>).content_sha256 !== selected.contentSha256) {
    throw new Error("Selected proof workspace is not bound to the exact proof graph")
  }
  return {
    status: listPartial || workspaceList === null || workspaceList.hasMore ? "partial" : "ready",
    summaryCount: summaries.length,
    selected,
    proofDag,
    workState,
    activateCoordination: true,
  }
}

function mergeGraphInputs(scope: GalaxyGraphScope, query: GalaxyGraphQuery, inputs: UnifiedGraphInput[]): UnifiedGraphInput {
  return {
    schemaId: "gb.graph-projection-input.v1",
    scope,
    query,
    objects: inputs.flatMap((input) => input.objects),
    external: inputs.flatMap((input) => input.external ?? []),
    links: inputs.flatMap((input) => input.links ?? []),
    relations: inputs.flatMap((input) => input.relations ?? []),
    proofContexts: inputs.flatMap((input) => input.proofContexts ?? []),
    providers: inputs.flatMap((input) => input.providers ?? []),
  }
}

async function requestAuthorizedArray<T>(path: string, signal: AbortSignal): Promise<T[]> {
  const response = await fetch(path, { cache: "no-store", signal })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok || !Array.isArray(body)) throw new Error("Authorized source is unavailable")
  return body as T[]
}

async function requestAuthorizedObject<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { cache: "no-store", signal })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok || !body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Authorized source is unavailable")
  }
  return body as T
}

function requireExactReference(requested: string, projected: string) {
  if (requested !== projected) throw new Error("Authorized source returned a different object reference")
}

function taskPlanIdFromReference(reference: string) {
  const parsed = parseGalaxyObjectReference(reference)
  if (!parsed || parsed.format !== "canonical" || !["task-plan", "task-plan.job"].includes(parsed.kind)) return null
  if (parsed.selector.mode !== "pinned" || !parsed.selector.revision.startsWith("sha256:")) {
    throw new Error("Saved Task Plan graph references must pin an immutable content hash")
  }
  const planId = parsed.kind === "task-plan" ? parsed.id : parsed.id.slice(0, parsed.id.indexOf("/"))
  if (!planId || (parsed.kind === "task-plan.job" && !parsed.id.startsWith(`${planId}/`))) {
    throw new Error("Saved Task Plan job reference is invalid")
  }
  return { parsed, planId, contentHash: parsed.selector.revision.slice("sha256:".length) }
}

async function loadExactGraphSource(reference: string, signal: AbortSignal): Promise<ExactGraphSource | null> {
  const parsed = parseGalaxyObjectReference(reference)
  if (!parsed || parsed.format !== "canonical" || !EXACT_SOURCE_KINDS.has(parsed.kind)) return null
  if (parsed.kind === "paper") {
    const paper = await requestAuthorizedObject<GalaxyPaperDetail>(
      `/api/eln/papers/${encodeURIComponent(parsed.id)}`,
      signal,
    )
    if (paper.id !== parsed.id) throw new Error("Authorized paper returned a different identifier")
    const requestedRevision = parsed.selector.mode === "pinned" ? parsed.selector.revision : null
    const revision = requestedRevision
      ? paper.revisions.find((candidate) => `sha256:${candidate.metadata_hash.toLowerCase()}` === requestedRevision.toLowerCase()) ?? null
      : null
    if (parsed.selector.mode === "pinned" && !revision) {
      throw new Error("Authorized paper did not contain the requested revision")
    }
    requireExactReference(reference, projectPaperObject({ paper, revision }).ref)
    return { kind: "paper", reference, paper, revision }
  }
  if (parsed.kind === "eln.experiment") {
    const experiment = await requestAuthorizedObject<Experiment>(
      `/api/eln/experiments/${encodeURIComponent(parsed.id)}`,
      signal,
    )
    requireExactReference(reference, projectElnObject(experimentToResearchRecord(experiment)).ref)
    return { kind: "eln.experiment", reference, experiment }
  }
  if (parsed.kind === "ham.task") {
    if (parsed.selector.mode !== "latest") throw new Error("Pinned HAM task references are not resolvable")
    const task = await fetchTaskDetail(parsed.id, signal)
    requireExactReference(reference, projectTaskObject(task).ref)
    return { kind: "ham.task", reference, task }
  }
  if (parsed.kind === "task-plan" || parsed.kind === "task-plan.job") {
    const selected = taskPlanIdFromReference(reference)
    if (!selected || !SHA256.test(selected.contentHash)) throw new Error("Saved Task Plan revision is invalid")
    const taskPlan = await requestAuthorizedObject<TaskPlanRecord>(
      `/api/eln/task-plans/${encodeURIComponent(selected.planId)}`,
      signal,
    )
    if (taskPlan.id !== selected.planId
      || taskPlan.current_content_hash.toLowerCase() !== selected.contentHash.toLowerCase()) {
      throw new Error("Authorized Task Plan does not contain the requested immutable revision")
    }
    if (parsed.kind === "task-plan.job") {
      const jobId = parsed.id.slice(selected.planId.length + 1)
      if (!jobId || !taskPlan.current_spec.nodes.some((node) => node.id === jobId)) {
        throw new Error("Authorized Task Plan does not contain the requested job")
      }
    }
    return { kind: "task-plan", reference, taskPlan }
  }
  return null
}

function settledSource<T>(result: PromiseSettledResult<T[]>, maximum = SOURCE_LIMIT): LoadedSource<T> {
  if (result.status === "rejected") return { status: "unavailable", values: [], truncated: false }
  return {
    status: result.value.length >= maximum ? "partial" : "ready",
    values: result.value,
    truncated: result.value.length >= maximum,
  }
}

function settledTaskSource(result: PromiseSettledResult<TaskPage>): LoadedSource<TaskSummary> {
  if (result.status === "rejected") return { status: "unavailable", values: [], truncated: false }
  return {
    status: result.value.truncated ? "partial" : "ready",
    values: result.value.tasks,
    truncated: Boolean(result.value.truncated),
  }
}

function provider(scope: GalaxyGraphScope, name: string, status: ProviderStatus, revision?: string): ProviderDescriptor {
  return {
    scope,
    provider: name,
    status,
    ...(revision ? { revision } : {}),
  }
}

const EMPTY_GRAPH_DIAGNOSTICS: LoadedGraph["diagnostics"] = {
  omitted: {
      unauthorized: { projections: 0, papers: 0, anchors: 0, experiments: 0, tasks: 0, surfaces: 0, links: 0 },
    inactiveLinks: 0,
    missingEndpointLinks: 0,
    taskResourceRelations: 0,
  },
  missingEndpointLinks: [],
  partialProviders: [],
}

async function requestConversationPage(path: string, signal: AbortSignal) {
  const response = await fetch(path, { cache: "no-store", signal })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok || !body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Authorized conversation source is unavailable")
  }
  return body
}

async function loadConversationGraph(
  tenantId: string,
  selection: ConversationGraphSelection,
  query: GalaxyGraphQuery,
  signal: AbortSignal,
): Promise<LoadedGraph> {
  const pages: unknown[] = []
  let continuation: { afterOrdinal: number; version: number } | null = null
  let loadedTurns = 0
  do {
    const page = await requestConversationPage(
      conversationGraphPagePath(selection, continuation),
      signal,
    ) as { turns?: unknown[]; continuation?: { hasMore?: unknown; nextAfterOrdinal?: unknown; version?: unknown } }
    pages.push(page)
    loadedTurns += Array.isArray(page.turns) ? page.turns.length : 0
    const next = page.continuation
    continuation = next?.hasMore === true
      && Number.isSafeInteger(next.nextAfterOrdinal)
      && Number.isSafeInteger(next.version)
      && loadedTurns < CONVERSATION_TURN_LIMIT
      && pages.length < Math.ceil(CONVERSATION_TURN_LIMIT / CONVERSATION_PAGE_LIMIT)
      ? { afterOrdinal: next.nextAfterOrdinal as number, version: next.version as number }
      : null
  } while (continuation)
  if (signal.aborted) throw new DOMException("Graph request aborted", "AbortError")
  const assembled = assembleConversationGraphPages(pages, {
    reference: selection.selectedReference,
    conversationReference: selection.conversationReference,
  }, query)
  if (assembled.graphInput.scope.tenantId !== tenantId) {
    throw new Error("Conversation source crossed the active tenant boundary")
  }
  const projection = projectUnifiedGraph(assembled.graphInput, {
    maxNodes: GRAPH_NODE_LIMIT,
    maxEdges: 10_000,
    maxFanout: 10_000,
  })
  if (projection.continuation.hasMore || projection.continuation.reasons.length > 0) {
    throw new Error("Conversation graph exceeded the bounded unified projection")
  }
  return {
    projection,
    diagnostics: EMPTY_GRAPH_DIAGNOSTICS,
    taskPlanSourceContinuation: null,
    proofSourceContinuation: null,
    proofGraphReference: null,
    coordinationTasks: [],
    conversationReference: assembled.conversationReference,
    conversationVersion: assembled.version,
    conversationContentHash: assembled.contentHash,
    conversationLoadedTurnCount: assembled.loadedTurnCount,
    conversationHasMore: assembled.hasMore,
    turnContentByReference: assembled.turnContentByReference,
    codeSnapshotReference: null,
    codeSourceDocumentHref: null,
    codeSourceContinuation: null,
    codeSourceStatus: null,
  }
}

async function requestObjectLinks(reference: string, signal: AbortSignal) {
  const query = new URLSearchParams({ ref: reference, limit: "100" })
  const response = await fetch(`/api/eln/object-links?${query}`, { cache: "no-store", signal })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok || !Array.isArray(body)) throw new Error("Object links are unavailable")
  return normalizeObjectLinkPage(body)
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = Array<PromiseSettledResult<R>>(values.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      try {
        results[index] = { status: "fulfilled", value: await worker(values[index]) }
      } catch (reason) {
        results[index] = { status: "rejected", reason }
      }
    }
  }))
  return results
}

function uniqueLinks(results: Array<PromiseSettledResult<ReturnType<typeof normalizeObjectLinkPage>>>) {
  const links = new Map<string, ActiveObjectLinkRow>()
  let saturated = false
  let failed = false
  for (const result of results) {
    if (result.status === "rejected") {
      failed = true
      continue
    }
    if (result.value.total >= 100) saturated = true
    if (result.value.invalid > 0) failed = true
    for (const link of result.value.links) {
      const key = link.id || `${link.from_ref}\u0000${link.to_ref}\u0000${link.relation}\u0000${link.basis}`
      links.set(key, link)
    }
  }
  return { links: [...links.values()], saturated, failed }
}

async function loadAuthorizedGraph(
  tenantId: string,
  locationSearch: string,
  signal: AbortSignal,
  codeGraphClient: CodeGraphSnapshotSessionClient,
): Promise<LoadedGraph> {
  setBrowserTenantScope(tenantId)
  const parameters = new URLSearchParams(locationSearch)
  const query = graphQueryFromParameters(parameters)
  const requestedSelection = canonicalGraphQueryParameter(parameters, "ref")
  const codeSnapshotReference = exactCodeSnapshotParameter(parameters)
  if (codeSnapshotReference && requestedSelection !== null && parameters.get("ref") !== requestedSelection) {
    throw new CodeGraphSnapshotSourceError("selection", "The selected code ref must use its exact canonical wire form.")
  }
  validateCodeGraphLensReferences(codeSnapshotReference, requestedSelection)
  if (codeSnapshotReference) {
    const loadedCode = await codeGraphClient.load({
      tenantId,
      sourceRef: codeSnapshotReference,
      selectedRef: requestedSelection,
      depth: 2,
      limit: 250,
      signal,
    })
    if (signal.aborted) throw new DOMException("Graph request aborted", "AbortError")
    const source = await buildAuthorizedCodeGraphSource({
      schemaId: "gb.authorized-code-graph-source.v1",
      authorized: true,
      tenantId,
      sourceRef: codeSnapshotReference,
      sourceProjection: loadedCode.descriptor.projection,
      sourceRepresentationRef: loadedCode.descriptor.projection.representations.find(
        (item) => item.kind === "original" && item.mediaType === "application/json",
      )?.ref as string,
      rawSha256: loadedCode.rawSha256,
      review: loadedCode.review,
      neighborhood: loadedCode.neighborhood,
      query,
    })
    const projection = projectUnifiedGraph(source.graphInput, {
      maxNodes: 260,
      maxEdges: 2_010,
      maxFanout: 2_010,
    })
    if (projection.continuation.hasMore || projection.continuation.reasons.length > 0) {
      throw new Error("The bounded code neighborhood could not be projected without dropping relations")
    }
    const codeObjectCount = source.graphInput.objects.length - 2
    const relationCount = (source.graphInput.relations?.length ?? 1) - 1
    const partial = source.continuation.truncated
      || source.continuation.omittedNodes > 0
      || source.continuation.omittedEdges > 0
    const rootTitle = source.graphInput.objects.find(
      (item) => item.projection.ref === source.rootReference,
    )?.projection.title ?? "the selected code object"
    return {
      projection,
      diagnostics: EMPTY_GRAPH_DIAGNOSTICS,
      taskPlanSourceContinuation: null,
      proofSourceContinuation: null,
      proofGraphReference: null,
      coordinationTasks: [],
      conversationReference: null,
      conversationVersion: null,
      conversationContentHash: null,
      conversationLoadedTurnCount: 0,
      conversationHasMore: false,
      turnContentByReference: Object.freeze({}),
      codeSnapshotReference,
      codeSourceDocumentHref: `/documents/${encodeURIComponent(loadedCode.descriptor.revisionId)}`,
      codeSourceContinuation: source.continuation,
      codeSourceStatus: `Loaded a ${partial ? "partial" : "full"} bounded neighborhood around “${rootTitle}”: ${codeObjectCount} code object${codeObjectCount === 1 ? "" : "s"} and ${relationCount} typed structural relation${relationCount === 1 ? "" : "s"} from the exact snapshot.`,
    }
  }
  const conversationReference = canonicalGraphQueryParameter(parameters, "conversation")
  const conversationSelection = resolveConversationGraphRoute({
    reference: requestedSelection,
    conversationReference,
    mode: query.mode,
  })
  if (conversationSelection) return loadConversationGraph(tenantId, conversationSelection, query, signal)
  if (query.mode === "conversation") {
    throw new Error("Conversation mode requires an exact pinned conversation reference")
  }
  const scope: GalaxyGraphScope = { tenantId, workspaceId: "tenant-catalog" }
  const explicitProof = explicitProofSelection(parameters, query, requestedSelection)
  const requestedReferences = [...new Set([requestedSelection, query.rootRef].filter((value): value is string => Boolean(value)))]
  const [paperResult, experimentResult, taskResult, taskPlanResult, surfaceResult, surfaceContractResult, proofResult] = await Promise.allSettled([
    requestAuthorizedArray<GalaxyPaper>(`/api/eln/papers?limit=${SOURCE_LIMIT}`, signal),
    requestAuthorizedArray<Experiment>(`/api/eln/experiments?limit=${SOURCE_LIMIT}`, signal),
    fetchTaskSnapshot(signal, 2),
    requestAuthorizedArray<TaskPlanRecord>(`/api/eln/task-plans?limit=${SOURCE_LIMIT}`, signal),
    requestAuthorizedArray<GalaxySurfaceRecord>(`/api/eln/surfaces?status=promoted&limit=${SOURCE_LIMIT}`, signal),
    requestAuthorizedObject<GalaxySurfaceContractManifest>("/api/eln/surfaces/contract", signal),
    loadProofGraphSelection(parameters, query, requestedSelection, signal),
  ])
  if (signal.aborted) throw new DOMException("Graph request aborted", "AbortError")

  const papers = settledSource(paperResult)
  const experiments = settledSource(experimentResult)
  const tasks = settledTaskSource(taskResult)
  const taskPlans = settledSource(taskPlanResult)
  const surfaces = settledSource(surfaceResult)
  const surfaceContract = surfaceContractResult.status === "fulfilled"
    ? graphSurfaceContract(surfaceContractResult.value)
    : null
  const promotedSurfaces = surfaceContract ? surfaces.values.filter((surface) => (
    isPromotedGenerousSurfaceForTenant(surface, tenantId, surfaceContract)
  )) : []
  const surfaceCatalogStatus: ProviderStatus = !surfaceContract
    ? "unavailable"
    : promotedSurfaces.length === surfaces.values.length
      ? surfaces.status
      : surfaces.status === "unavailable" ? "unavailable" : "partial"
  if (proofResult.status === "rejected" && (explicitProof.contentSha256 || explicitProof.workspaceId)) {
    throw proofResult.reason
  }
  const proofSelection: ProofGraphSelection = proofResult.status === "fulfilled"
    ? proofResult.value
    : { status: "unavailable", summaryCount: 0, selected: null, proofDag: null, workState: null, activateCoordination: false }
  const selectedProofGraphReference = proofSelection.selected
    ? createGalaxyObjectReference(
        "proof.graph",
        proofSelection.selected.graphId,
        { mode: "pinned", revision: `sha256:${proofSelection.selected.contentSha256}` },
      )
    : null
  const exactResults = await mapWithConcurrency(
    requestedReferences,
    LINK_CONCURRENCY,
    (reference) => loadExactGraphSource(reference, signal),
  )
  if (signal.aborted) throw new DOMException("Graph request aborted", "AbortError")
  const exactSources = exactResults.flatMap((result) => (
    result.status === "fulfilled" && result.value ? [result.value] : []
  ))
  exactResults.forEach((result, index) => {
    const kind = parseGalaxyObjectReference(requestedReferences[index])?.kind
    if (result.status === "rejected" && (kind === "task-plan" || kind === "task-plan.job")) throw result.reason
  })
  const focusedHamTaskIds = [...new Set(requestedReferences.flatMap((reference) => {
    const parsed = parseGalaxyObjectReference(reference)
    return parsed?.format === "canonical" && parsed.kind === "ham.task" ? [parsed.id] : []
  }))]
  const focusedTaskPlanResults = await mapWithConcurrency(
    focusedHamTaskIds,
    LINK_CONCURRENCY,
    async (taskId) => {
      const values = await requestAuthorizedArray<TaskPlanRecord>(
        `/api/eln/task-plans?ham_task_id=${encodeURIComponent(taskId)}&limit=1`,
        signal,
      )
      if (values.length > 1) throw new Error("Focused Task Plan lookup exceeded its fixed bound")
      return values[0] ?? null
    },
  )
  if (signal.aborted) throw new DOMException("Graph request aborted", "AbortError")
  const focusedTaskPlans = focusedTaskPlanResults.flatMap((result) => (
    result.status === "fulfilled" && result.value ? [result.value] : []
  ))
  const focusedTaskPlanLookupPartial = focusedTaskPlanResults.some((result) => result.status === "rejected")
  const requestedProjectionReferences = requestedReferences.filter((reference) => (
    isGraphGatewayProjectionReference(reference)
  ))
  const requestedProjectionBatch = await resolveObjectProjectionReferences(requestedProjectionReferences, { signal })
  if (signal.aborted) throw new DOMException("Graph request aborted", "AbortError")
  const projectionByReference = new Map(resolvedGatewayProjections(requestedProjectionBatch.results)
    .map((projection) => [projection.ref, projection]))
  const paperInputs: NonNullable<AuthorizedGraphSourceInput["papers"]> = [
    ...papers.values.map((paper) => ({ authorized: true, scope, paper, revision: null })),
    ...exactSources.flatMap((source) => source.kind === "paper"
      ? [{ authorized: true, scope, paper: source.paper, revision: source.revision }]
      : []),
  ]
  const experimentInputs: NonNullable<AuthorizedGraphSourceInput["experiments"]> = [
    ...experiments.values.map((experiment) => ({
      authorized: true,
      scope,
      record: experimentToResearchRecord(experiment),
    })),
    ...exactSources.flatMap((source) => source.kind === "eln.experiment"
      ? [{ authorized: true, scope, record: experimentToResearchRecord(source.experiment) }]
      : []),
  ]
  const rawTaskInputs: NonNullable<AuthorizedGraphSourceInput["tasks"]> = [
    ...tasks.values.map((task) => ({ authorized: true, scope, task })),
    ...exactSources.flatMap((source) => source.kind === "ham.task"
      ? [{ authorized: true, scope, task: source.task }]
      : []),
  ]
  const exactTaskPlanTaskIds = [...new Set(exactSources.flatMap((source) => (
    source.kind === "task-plan" ? [source.taskPlan.ham_task_id] : []
  )))]
  const loadedTaskIds = new Set(rawTaskInputs.map(({ task }) => task.id))
  const missingExactTaskPlanTaskIds = exactTaskPlanTaskIds.filter((taskId) => !loadedTaskIds.has(taskId))
  const exactTaskPlanHydrationIds = missingExactTaskPlanTaskIds
    .slice(0, TASK_PLAN_TASK_HYDRATION_LIMIT)
  const exactTaskPlanHydrationResults = await mapWithConcurrency(
    exactTaskPlanHydrationIds,
    LINK_CONCURRENCY,
    (taskId) => fetchTaskDetail(taskId, signal),
  )
  if (signal.aborted) throw new DOMException("Graph request aborted", "AbortError")
  exactTaskPlanHydrationResults.forEach((result) => {
    if (result.status === "fulfilled") rawTaskInputs.push({ authorized: true, scope, task: result.value })
  })
  const exactTaskPlanHydrationPartial = missingExactTaskPlanTaskIds.length > exactTaskPlanHydrationIds.length
    || exactTaskPlanHydrationResults.some((result) => result.status === "rejected")
  // Exact task hydration is fresher and more complete than a snapshot summary.
  // Prefer the last authorized record for an ID before any strict join compares it.
  const taskInputs: NonNullable<AuthorizedGraphSourceInput["tasks"]> = [
    ...new Map(rawTaskInputs.map((entry) => [entry.task.id, entry])).values(),
  ]
  const surfaceInputs: NonNullable<AuthorizedGraphSourceInput["surfaces"]> = [
    ...promotedSurfaces.map((surface) => ({ authorized: true, scope, surface })),
  ]
  const taskPlanInputs = [
    ...taskPlans.values.map((taskPlan) => ({ authorized: true, scope, record: taskPlan })),
    ...focusedTaskPlans.map((taskPlan) => ({ authorized: true, scope, record: taskPlan })),
    ...exactSources.flatMap((source) => source.kind === "task-plan"
      ? [{ authorized: true, scope, record: source.taskPlan }]
      : []),
  ]
  const deduplicatedTaskPlanInputs = [
    ...new Map(taskPlanInputs.map((entry) => [entry.record.id, entry])).values(),
  ]
  const proofSummaryProvider = provider(
    scope,
    "galaxy.proof-dag",
    proofSelection.status,
    `registered:${proofSelection.summaryCount}`,
  )
  const provisionalProviders = [
    provider(scope, "galaxy.paper", papers.status),
    provider(scope, "galaxy.eln", experiments.status),
    provider(scope, "ham", tasks.status),
    // Promoted surfaces render locally from the pinned generous.a2ui catalog,
    // so their coverage is galaxy.surface's; there is no separate A2UI runtime.
    provider(scope, "galaxy.surface", surfaceCatalogStatus),
    ...(!proofSelection.selected ? [proofSummaryProvider] : []),
  ]
  const provisionalInput: AuthorizedGraphSourceInput = {
    schemaId: "gb.authorized-graph-source.v1",
    scope,
    query,
    providers: provisionalProviders,
    projections: [...projectionByReference.values()].map((projection) => ({ authorized: true, scope, projection })),
    papers: paperInputs,
    experiments: experimentInputs,
    tasks: taskInputs,
    surfaces: surfaceInputs,
  }
  const base = buildAuthorizedGraphSource(provisionalInput)
  const loadedBaseReferences = new Set(base.graphInput.objects.map(({ projection }) => projection.ref))
  const unresolvedExactKinds = new Set<string>(requestedReferences.flatMap((reference, index) => {
    if (loadedBaseReferences.has(reference) || exactResults[index]?.status === "fulfilled") return []
    const parsed = parseGalaxyObjectReference(reference)
    return parsed?.format === "canonical" && EXACT_SOURCE_KINDS.has(parsed.kind) ? [parsed.kind] : []
  }))
  const degradeFor = (status: ProviderStatus, ...kinds: string[]): ProviderStatus => (
    kinds.some((kind) => unresolvedExactKinds.has(kind)) && status !== "unavailable" ? "partial" : status
  )
  const baseProviders = [
    provider(scope, "galaxy.paper", degradeFor(papers.status, "paper")),
    provider(scope, "galaxy.eln", degradeFor(experiments.status, "eln.experiment")),
    provider(
      scope,
      "ham",
      exactTaskPlanHydrationPartial ? "partial" : degradeFor(tasks.status, "ham.task"),
    ),
    provider(scope, "galaxy.surface", surfaceCatalogStatus),
    ...(!proofSelection.selected ? [proofSummaryProvider] : []),
  ]
  const orderedReferences = base.graphInput.objects.map(({ projection }) => projection.ref)
  if (requestedSelection) {
    const selectedIndex = orderedReferences.indexOf(requestedSelection)
    if (selectedIndex > 0) orderedReferences.unshift(...orderedReferences.splice(selectedIndex, 1))
  }
  const linkReferences = orderedReferences.slice(0, LINK_REFERENCE_LIMIT)
  const linkResults = await mapWithConcurrency(
    linkReferences,
    LINK_CONCURRENCY,
    (reference) => requestObjectLinks(reference, signal),
  )
  if (signal.aborted) throw new DOMException("Graph request aborted", "AbortError")
  const collected = uniqueLinks(linkResults)
  const linksPartial = orderedReferences.length > LINK_REFERENCE_LIMIT || collected.saturated || collected.failed
  const missingProjectionPlan = selectMissingLinkedProjectionReferences(
    collected.links,
    new Set([...loadedBaseReferences, ...projectionByReference.keys()]),
  )
  const endpointProjectionReferences = [...missingProjectionPlan.references]
  const endpointProjectionBatch = await resolveObjectProjectionReferences(endpointProjectionReferences, { signal })
  if (signal.aborted) throw new DOMException("Graph request aborted", "AbortError")
  resolvedGatewayProjections(endpointProjectionBatch.results).forEach((projection) => {
    projectionByReference.set(projection.ref, projection)
  })
  const attemptedProjectionReferences = [...new Set([
    ...requestedProjectionReferences,
    ...endpointProjectionReferences,
  ])]
  const projectionsCapped = missingProjectionPlan.capped
  const projectionStatus = linkedProjectionProviderStatus(
    attemptedProjectionReferences,
    projectionByReference.keys(),
    projectionsCapped,
  )
  const finalInput: AuthorizedGraphSourceInput = {
    ...provisionalInput,
    projections: [...projectionByReference.values()].map((projection) => ({ authorized: true, scope, projection })),
    providers: [
      ...baseProviders,
      ...(projectionStatus ? [provider(
        scope,
        "galaxy.object-projection",
        projectionStatus,
        `resolved:${projectionByReference.size};cap:${LINKED_PROJECTION_LIMIT}`,
      )] : []),
      // Federated expansion is reported only once a loader performs it; a
      // constant "unavailable" row kept the coverage notice from ever clearing.
      provider(scope, "galaxy.object-links", linksPartial ? "partial" : "ready", `refs:${linkReferences.length}`),
    ],
    links: collected.links.map((link) => ({ authorized: true, active: true, scope, link })),
  }
  let assembled = buildAuthorizedGraphSource({
    ...finalInput,
  })
  let coordinationTaskInputs = taskInputs
  const requestedTaskPlanPriorityReferences = requestedReferences.filter((reference) => {
    const kind = parseGalaxyObjectReference(reference)?.kind
    return kind === "ham.task" || kind === "task-plan" || kind === "task-plan.job"
  })
  const requestedTaskPlanReferences = requestedTaskPlanPriorityReferences.filter((reference) => (
    parseGalaxyObjectReference(reference)?.kind !== "ham.task"
  ))
  const taskPlanTaskIds = new Set(deduplicatedTaskPlanInputs.map(({ record }) => record.ham_task_id))
  const availableTaskIds = new Set(taskInputs.map(({ task }) => task.id))
  const taskPlanProviderStatus: ProviderStatus = taskPlans.status === "unavailable" && deduplicatedTaskPlanInputs.length > 0
    ? "partial"
    : taskPlans.status === "partial"
      || exactTaskPlanHydrationPartial
      || focusedTaskPlanLookupPartial
      || [...taskPlanTaskIds].some((taskId) => !availableTaskIds.has(taskId))
      ? "partial"
      : taskPlans.status
  const taskPlanBudget = GRAPH_NODE_LIMIT - assembled.graphInput.objects.length
  if (requestedTaskPlanReferences.length > 0 && taskPlanBudget < 2) {
    throw new Error("Selected Task Plan has no remaining bounded projection capacity")
  }
  const taskPlanSource = taskPlanBudget >= 2
    ? buildAuthorizedTaskPlanGraphSource({
        schemaId: "gb.authorized-task-plan-graph-source.v1",
        scope,
        query,
        providerStatus: taskPlanProviderStatus,
        plans: deduplicatedTaskPlanInputs,
        sourceLimit: Math.min(TASK_PLAN_SOURCE_LIMIT, taskPlanBudget),
        priorityRefs: requestedTaskPlanPriorityReferences,
      })
    : null
  if (requestedTaskPlanReferences.length > 0) {
    const projectedTaskPlanReferences = new Set(
      taskPlanSource?.graphInput.objects.map(({ projection }) => projection.ref) ?? [],
    )
    if (requestedTaskPlanReferences.some((reference) => !projectedTaskPlanReferences.has(reference))) {
      throw new Error("Selected Task Plan could not fit in the bounded graph without truncating its jobs")
    }
  }
  let proofSource: AuthorizedProofGraphSourceResult | null = null
  const remainingNodeBudget = GRAPH_NODE_LIMIT
    - assembled.graphInput.objects.length
    - (taskPlanSource?.graphInput.objects.length ?? 0)
  if (proofSelection.selected && remainingNodeBudget < 2) {
    throw new Error("Selected proof graph has no remaining bounded projection capacity")
  }
  if (proofSelection.selected && proofSelection.proofDag && remainingNodeBudget >= 2) {
    const proofGraphReferences = requestedReferences.filter((reference) => (
      parseGalaxyObjectReference(reference)?.kind === "proof.graph"
    ))
    if (!selectedProofGraphReference
      || proofGraphReferences.some((reference) => reference !== selectedProofGraphReference)) {
      throw new Error("Requested proof graph reference does not match the selected immutable graph")
    }
    const priorityRefs = requestedReferences.filter((reference) => (
      parseGalaxyObjectReference(reference)?.kind === "proof.node"
    ))
    const buildProofSource = (sourceLimit: number) => buildAuthorizedProofGraphSource({
      schemaId: "gb.authorized-proof-graph-source.v1",
      authorized: true,
      activateCoordination: proofSelection.activateCoordination,
      scope,
      query,
      proofDag: proofSelection.proofDag,
      proofDagSha256: proofSelection.selected?.contentSha256,
      workState: proofSelection.workState,
      // One source page includes the proof graph object plus its selected
      // nodes and relations. Keeping the page at 513 or below guarantees the
      // graph's synthetic containment hub remains within the unified graph's
      // authoritative fanout cap of 512 while fitting the 130-target corpus.
      sourceLimit: Math.min(513, sourceLimit),
      priorityRefs,
    })
    proofSource = buildProofSource(remainingNodeBudget)

    // The snapshot is intentionally bounded. Treat task_id as a lookup hint,
    // then accept an exact hydration only when the authorized task itself
    // carries this graph revision's active hash-bound proof-packet resource.
    const loadedTaskIds = new Set(taskInputs.map(({ task }) => task.id))
    const initialMissingTaskIds = [...new Set(proofSource.coordinationBindings
      .map((binding) => binding.taskId)
      .filter((taskId) => !loadedTaskIds.has(taskId)))]
    const reservation = Math.min(
      PROOF_TASK_HYDRATION_LIMIT,
      initialMissingTaskIds.length,
      Math.max(0, remainingNodeBudget - 2),
    )
    if (initialMissingTaskIds.length > 0) {
      proofSource = buildProofSource(Math.max(2, remainingNodeBudget - reservation))
      const missingTaskIds = [...new Set(proofSource.coordinationBindings
        .map((binding) => binding.taskId)
        .filter((taskId) => !loadedTaskIds.has(taskId)))]
      const hydratedTaskIds = missingTaskIds.slice(0, reservation)
      const hydrationResults = await mapWithConcurrency(
        hydratedTaskIds,
        LINK_CONCURRENCY,
        (taskId) => fetchTaskDetail(taskId, signal),
      )
      if (signal.aborted) throw new DOMException("Graph request aborted", "AbortError")
      const hydratedTaskInputs: NonNullable<AuthorizedGraphSourceInput["tasks"]> = []
      let hydrationPartial = missingTaskIds.length > hydratedTaskIds.length
      hydrationResults.forEach((result, index) => {
        if (result.status === "rejected") {
          hydrationPartial = true
          return
        }
        const candidate = { authorized: true, scope, task: result.value }
        const candidateBinding = proofSource?.coordinationBindings.filter((binding) => (
          binding.taskId === hydratedTaskIds[index]
        )) ?? []
        const validated = joinAuthorizedProofHamCoordination({
          schemaId: PROOF_HAM_COORDINATION_SCHEMA_ID,
          scope,
          bindings: candidateBinding,
          tasks: [candidate],
        })
        if (validated.relations.length === 0) {
          hydrationPartial = true
          return
        }
        hydratedTaskInputs.push(candidate)
      })
      coordinationTaskInputs = [
        ...new Map([...taskInputs, ...hydratedTaskInputs].map((entry) => [entry.task.id, entry])).values(),
      ]
      assembled = buildAuthorizedGraphSource({
        ...finalInput,
        tasks: coordinationTaskInputs,
        providers: finalInput.providers?.map((entry) => (
          entry.provider === "ham" && hydrationPartial ? { ...entry, status: "partial" as const } : entry
        )),
      })
    }
  }
  const coordination = proofSource
    ? joinAuthorizedProofHamCoordination({
        schemaId: PROOF_HAM_COORDINATION_SCHEMA_ID,
        scope,
        bindings: proofSource.coordinationBindings,
        tasks: coordinationTaskInputs,
      })
    : null
  const coordinationInput: UnifiedGraphInput | null = coordination && coordination.relations.length > 0
    ? {
        schemaId: "gb.graph-projection-input.v1",
        scope,
        query,
        objects: [],
        relations: [...coordination.relations],
      }
    : null
  const merged = mergeGraphInputs(
    scope,
    query,
    [
      assembled.graphInput,
      ...(taskPlanSource ? [taskPlanSource.graphInput] : []),
      ...(proofSource ? [proofSource.graphInput] : []),
      ...(coordinationInput ? [coordinationInput] : []),
    ],
  )
  const projection = projectUnifiedGraph(merged, {
    maxNodes: GRAPH_NODE_LIMIT,
    maxEdges: 10_000,
    maxFanout: 10_000,
  })
  if (projection.continuation.hasMore || projection.continuation.reasons.length > 0) {
    throw new Error("Authorized graph could not be projected without dropping authoritative relations")
  }
  return {
    projection,
    diagnostics: assembled.diagnostics,
    taskPlanSourceContinuation: taskPlanSource?.sourceContinuation ?? null,
    proofSourceContinuation: proofSource?.sourceContinuation ?? null,
    proofGraphReference: selectedProofGraphReference,
    coordinationTasks: coordinationTaskInputs.map(({ task }) => task),
    conversationReference: null,
    conversationVersion: null,
    conversationContentHash: null,
    conversationLoadedTurnCount: 0,
    conversationHasMore: false,
    turnContentByReference: Object.freeze({}),
    codeSnapshotReference: null,
    codeSourceDocumentHref: null,
    codeSourceContinuation: null,
    codeSourceStatus: null,
  }
}

export function GraphClient({ tenantId, presentation = "graph" }: { tenantId: string; presentation?: "graph" | "field" }) {
  const router = useRouter()
  const routeSearchParams = useSearchParams()
  const routeSearch = routeSearchParams.toString()
  const [loaded, setLoaded] = useState<LoadedGraph | null>(null)
  const [loadedRouteSearch, setLoadedRouteSearch] = useState<string | null>(null)
  const [corpusWindow, setCorpusWindow] = useState<GraphWindowResponse | null>(null)
  const [corpusActive, setCorpusActive] = useState(false)
  const [windowLoading, setWindowLoading] = useState(false)
  const [expandedClusterId, setExpandedClusterId] = useState<string | null>(null)
  const [windowCursor, setWindowCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [requestVersion, setRequestVersion] = useState(0)
  const [selectionVersion, setSelectionVersion] = useState(0)
  const [selectedReference, setSelectedReference] = useState<string | null>(null)
  const codeSnapshotActive = routeSearchParams.has("codeSnapshot")
  const codeGraphClientRef = useRef<CodeGraphSnapshotSessionClient | null>(null)
  if (!codeGraphClientRef.current) {
    codeGraphClientRef.current = new CodeGraphSnapshotSessionClient(() => new Worker(
      new URL("../../workers/code-graph-snapshot.worker.ts", import.meta.url),
      { type: "module", name: "galaxy-code-graph-snapshot" },
    ))
  }
  const [proofRegistryOpen, setProofRegistryOpen] = useState(
    () => routeSearchParams.get("proofRegistry") === "open",
  )
  const [forkOpen, setForkOpen] = useState(false)
  const [forkTarget, setForkTarget] = useState<ConversationForkTarget | null>(null)
  const [forkDialogVersion, setForkDialogVersion] = useState(0)
  const forkReturnFocusRef = useRef<HTMLButtonElement | null>(null)
  const [uncertainFork, setUncertainFork] = useState<ConversationForkRecovery | null>(null)
  const [forkRecoveryHydrated, setForkRecoveryHydrated] = useState(false)
  const [pendingForks, setPendingForks] = useState<readonly PendingConversationFork[]>([])
  const [receiptResetCandidate, setReceiptResetCandidate] = useState<string | null>(null)
  const [focusSelectedReference, setFocusSelectedReference] = useState<string | null>(null)
  const [forkNotice, setForkNotice] = useState<string | null>(null)
  const [joinOpen, setJoinOpen] = useState(false)
  const [joinTarget, setJoinTarget] = useState<ConversationJoinTarget | null>(null)
  const [joinDialogVersion, setJoinDialogVersion] = useState(0)
  const joinReturnFocusRef = useRef<HTMLButtonElement | null>(null)
  const [uncertainJoin, setUncertainJoin] = useState<ConversationJoinRecovery | null>(null)
  const [joinRecoveryHydrated, setJoinRecoveryHydrated] = useState(false)
  const [pendingJoins, setPendingJoins] = useState<readonly PendingConversationJoin[]>([])
  const [joinReceiptResetCandidate, setJoinReceiptResetCandidate] = useState<string | null>(null)
  const [joinNotice, setJoinNotice] = useState<string | null>(null)
  const [conversationExportState, setConversationExportState] = useState<ConversationExportState>({
    reference: null,
    status: "idle",
    message: null,
  })
  const conversationExportGenerationRef = useRef(0)
  const conversationExportControllerRef = useRef<AbortController | null>(null)

  const changeProofRegistryOpen = useCallback((nextOpen: boolean) => {
    setProofRegistryOpen(nextOpen)
    const nextUrl = new URL(proofRegistryPresenterUrl(window.location.href, nextOpen))
    window.history.replaceState(null, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`)
  }, [])

  useEffect(() => {
    const client = codeGraphClientRef.current
    return () => client?.dispose()
  }, [])
  useEffect(() => {
    setForkRecoveryHydrated(false)
    setUncertainFork(null)
    setPendingForks((current) => current.filter((entry) => entry.tenantId === tenantId))
    setReceiptResetCandidate(null)
    setForkNotice(null)
    setForkOpen(false)
    setForkTarget(null)
    try {
      const storageKey = conversationForkRecoveryStorageKey(tenantId)
      const stored = window.sessionStorage.getItem(storageKey)
      const recovered = stored ? parseConversationForkRecovery(stored, tenantId) : null
      if (stored && !recovered) window.sessionStorage.removeItem(storageKey)
      setUncertainFork(recovered)
    } catch {
      // Browser storage is optional. The active dialog still retains the exact
      // frozen request and cannot be dismissed while delivery is uncertain.
    } finally {
      setForkRecoveryHydrated(true)
    }
  }, [tenantId])

  useEffect(() => {
    setJoinRecoveryHydrated(false)
    setUncertainJoin(null)
    setPendingJoins((current) => current.filter((entry) => entry.tenantId === tenantId))
    setJoinReceiptResetCandidate(null)
    setJoinNotice(null)
    setJoinOpen(false)
    setJoinTarget(null)
    try {
      const storageKey = conversationJoinRecoveryStorageKey(tenantId)
      const stored = window.sessionStorage.getItem(storageKey)
      const recovered = stored ? parseConversationJoinRecovery(stored, tenantId) : null
      if (stored && !recovered) window.sessionStorage.removeItem(storageKey)
      setUncertainJoin(recovered)
    } catch {
      // Browser storage is optional. The active dialog still retains the exact
      // frozen request and cannot be dismissed while delivery is uncertain.
    } finally {
      setJoinRecoveryHydrated(true)
    }
  }, [tenantId])

  useEffect(() => {
    conversationExportGenerationRef.current += 1
    conversationExportControllerRef.current?.abort()
    conversationExportControllerRef.current = null
    setConversationExportState({ reference: null, status: "idle", message: null })
  }, [loaded?.conversationReference, selectedReference, tenantId])

  useEffect(() => () => {
    conversationExportGenerationRef.current += 1
    conversationExportControllerRef.current?.abort()
    conversationExportControllerRef.current = null
  }, [])

  const retainUncertainFork = useCallback((intent: ConversationForkIntent, target: ConversationForkTarget) => {
    const recovery = Object.freeze({
      schemaId: "gb.conversation-fork-recovery.v1" as const,
      tenantId: target.tenantId,
      target: Object.freeze({ ...target }),
      intent: Object.freeze({ ...intent }),
    })
    setUncertainFork(recovery)
    try {
      window.sessionStorage.setItem(
        conversationForkRecoveryStorageKey(target.tenantId),
        serializeConversationForkRecovery(recovery),
      )
    } catch {
      // The modal remains non-dismissible, so the exact request is still
      // recoverable while this mounted Graph surface remains active.
    }
  }, [])

  const clearUncertainFork = useCallback(() => {
    setUncertainFork(null)
    try {
      window.sessionStorage.removeItem(conversationForkRecoveryStorageKey(tenantId))
    } catch {
      // No stored recovery exists when browser storage is unavailable.
    }
  }, [tenantId])

  const resumeUncertainFork = useCallback((trigger: HTMLButtonElement) => {
    if (!uncertainFork || uncertainFork.tenantId !== tenantId) return
    forkReturnFocusRef.current = trigger
    setForkTarget(uncertainFork.target)
    setForkDialogVersion((value) => value + 1)
    setForkOpen(true)
  }, [tenantId, uncertainFork])

  const retainUncertainJoin = useCallback((intent: ConversationJoinIntent, target: ConversationJoinTarget) => {
    const recovery = Object.freeze({
      schemaId: "gb.conversation-join-recovery.v1" as const,
      tenantId: target.tenantId,
      target: Object.freeze({
        ...target,
        parentTurnReferences: Object.freeze([...target.parentTurnReferences]),
        labels: Object.freeze([...target.labels]),
      }),
      intent: Object.freeze({ ...intent }),
    })
    setUncertainJoin(recovery)
    try {
      window.sessionStorage.setItem(
        conversationJoinRecoveryStorageKey(target.tenantId),
        serializeConversationJoinRecovery(recovery),
      )
    } catch {
      // The modal remains non-dismissible, so the exact request is still
      // recoverable while this mounted Graph surface remains active.
    }
  }, [])

  const clearUncertainJoin = useCallback(() => {
    setUncertainJoin(null)
    try {
      window.sessionStorage.removeItem(conversationJoinRecoveryStorageKey(tenantId))
    } catch {
      // No stored recovery exists when browser storage is unavailable.
    }
  }, [tenantId])

  const resumeUncertainJoin = useCallback((trigger: HTMLButtonElement) => {
    if (!uncertainJoin || uncertainJoin.tenantId !== tenantId) return
    joinReturnFocusRef.current = trigger
    setJoinTarget(uncertainJoin.target)
    setJoinDialogVersion((value) => value + 1)
    setJoinOpen(true)
  }, [tenantId, uncertainJoin])

  useEffect(() => {
    const selectedReferenceFromSearch = (search: string) => {
      try {
        return canonicalGraphQueryParameter(new URLSearchParams(search), "ref")
      } catch {
        return null
      }
    }
    const refreshSelection = () => {
      setSelectedReference(selectedReferenceFromSearch(window.location.search))
      setExpandedClusterId(null)
      setWindowCursor(null)
      setSelectionVersion((value) => value + 1)
    }
    setSelectedReference(selectedReferenceFromSearch(routeSearch))
    window.addEventListener(PROOF_GRAPH_SELECTION_EVENT, refreshSelection)
    window.addEventListener("popstate", refreshSelection)
    return () => {
      window.removeEventListener(PROOF_GRAPH_SELECTION_EVENT, refreshSelection)
      window.removeEventListener("popstate", refreshSelection)
    }
  }, [routeSearch])
  useEffect(() => {
    const controller = new AbortController()
    let current = true
    const parameters = new URLSearchParams(routeSearch)
    const useCorpusWindow = presentation === "graph" && shouldUseCorpusWindow(parameters)
    setCorpusActive(useCorpusWindow)
    setError(null)
    if (useCorpusWindow) {
      setLoaded(null)
      setLoadedRouteSearch(null)
      setCorpusWindow(null)
      setWindowLoading(true)
      const request = corpusWindowRequest(parameters, expandedClusterId, windowCursor)
      loadCorpusWindow(request, controller.signal)
        .then((value) => {
          if (current) setCorpusWindow(value)
        })
        .catch((cause) => {
          if (!current || (cause instanceof DOMException && cause.name === "AbortError")) return
          setError("The bounded corpus window is currently unavailable.")
        })
        .finally(() => {
          if (current) setWindowLoading(false)
        })
      return () => {
        current = false
        controller.abort()
      }
    }
    setCorpusWindow(null)
    setWindowLoading(false)
    setLoaded(null)
    setLoadedRouteSearch(null)
    loadAuthorizedGraph(tenantId, routeSearch, controller.signal, codeGraphClientRef.current as CodeGraphSnapshotSessionClient)
      .then((value) => {
        if (current) {
          setLoaded(value)
          setLoadedRouteSearch(routeSearch)
        }
      })
      .catch((cause) => {
        if (!current || (cause instanceof DOMException && cause.name === "AbortError")) return
        setError(safeGraphLoadError(cause, codeSnapshotActive))
      })
    return () => {
      current = false
      controller.abort()
    }
  }, [codeSnapshotActive, expandedClusterId, presentation, requestVersion, routeSearch, selectionVersion, tenantId, windowCursor])

  const expandCorpusCluster = useCallback((cluster: GraphWindowCluster) => {
    if (!cluster.expandable) return
    setWindowCursor(null)
    setExpandedClusterId(cluster.id)
  }, [])

  const closeCorpusCluster = useCallback(() => {
    setWindowCursor(null)
    setExpandedClusterId(null)
  }, [])

  const nextCorpusPage = useCallback(() => {
    if (corpusWindow?.continuation.cursor) setWindowCursor(corpusWindow.continuation.cursor)
  }, [corpusWindow?.continuation.cursor])

  const changeGraphScale = useCallback((scale: GraphScale) => {
    const currentHref = routeSearch ? `/graph?${routeSearch}` : "/graph"
    const plan = planProofCorpusScaleNavigation(currentHref, scale, loaded?.proofGraphReference)
    if (plan.kind === "route") router.push(plan.href)
  }, [loaded?.proofGraphReference, routeSearch, router])

  const corpusFocusReturnHref = useMemo(() => {
    const focusReference = corpusWindow?.focus?.ref
    if (!focusReference) return null
    const currentHref = routeSearch ? `/graph?${routeSearch}` : "/graph"
    return proofGraphReturnHref(currentHref, focusReference)
  }, [corpusWindow?.focus?.ref, routeSearch])

  const openCorpusMember = useCallback((member: GraphWindowResponse["members"][number]) => {
    const url = new URL(window.location.href)
    url.searchParams.set("ref", member.ref)
    url.searchParams.set("scale", "object")
    url.searchParams.delete("focus")
    url.searchParams.delete("corpusWindow")
    window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`)
    setSelectedReference(member.ref)
    setExpandedClusterId(null)
    setWindowCursor(null)
    setSelectionVersion((value) => value + 1)
  }, [])

  const onSelectedReferenceChange = useCallback((reference: string | null) => {
    setSelectedReference(reference)
    const url = new URL(window.location.href)
    if (reference) url.searchParams.set("ref", reference)
    else url.searchParams.delete("ref")
    if (loaded?.conversationReference) {
      url.searchParams.set("mode", "conversation")
      url.searchParams.set("conversation", loaded.conversationReference)
    }
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`)
  }, [loaded?.conversationReference])

  const onFieldReferenceChange = useCallback((reference: string | null) => {
    const parsed = reference ? parseGalaxyObjectReference(reference) : null
    if (parsed?.kind === "document" && loaded?.codeSnapshotReference) return
    onSelectedReferenceChange(reference ? safeCanonicalReference(reference) : null)
  }, [loaded?.codeSnapshotReference, onSelectedReferenceChange])

  const onFieldCorpusReferenceSelect = useCallback((reference: string) => {
    const canonicalReference = safeCanonicalReference(reference)
    if (!canonicalReference) return
    onSelectedReferenceChange(canonicalReference)
    setSelectionVersion((value) => value + 1)
  }, [onSelectedReferenceChange])

  const recenterCodeNeighborhood = useCallback((reference: string) => {
    if (!loaded?.codeSnapshotReference) return
    const parsed = parseGalaxyObjectReference(reference)
    if (!parsed || !["code.graph", "code.repo", "code.file", "code.symbol"].includes(parsed.kind)) {
      if (loaded.codeSourceDocumentHref && reference === loaded.projection.nodes.find(
        (node) => node.kind === "document",
      )?.ref) router.push(loaded.codeSourceDocumentHref)
      return
    }
    setSelectedReference(reference)
    setFocusSelectedReference(reference)
    const url = new URL(window.location.href)
    url.searchParams.set("ref", reference)
    router.replace(`${url.pathname}${url.search}${url.hash}`, { scroll: false })
  }, [loaded, router])

  const onFocusedSelectedReference = useCallback((reference: string) => {
    let routedReference: string | null = null
    try {
      routedReference = canonicalGraphQueryParameter(new URLSearchParams(routeSearch), "ref")
    } catch {
      return
    }
    if (loadedRouteSearch !== routeSearch || routedReference !== reference
      || !loaded?.projection.nodes.some((node) => node.ref === reference)) return
    setFocusSelectedReference((current) => current === reference ? null : current)
  }, [loaded, loadedRouteSearch, routeSearch])

  const pendingForkForLoaded = useMemo(() => {
    if (!loaded?.conversationReference) return null
    return pendingForks.find((entry) => conversationForkReceiptApplies(
      entry,
      tenantId,
      loaded.conversationReference as string,
    )) ?? null
  }, [loaded?.conversationReference, pendingForks, tenantId])

  const conversationJoinCandidates = useMemo(() => {
    if (!loaded?.conversationReference || !loaded.conversationContentHash
      || loadedRouteSearch !== routeSearch || loaded.projection.query.mode !== "conversation"
      || loaded.conversationHasMore || loaded.conversationLoadedTurnCount >= CONVERSATION_TURN_LIMIT) return []
    const references = deriveConversationJoinCandidates(
      loaded.projection,
      loaded.conversationReference,
      loaded.conversationContentHash,
      Object.keys(loaded.turnContentByReference),
    )
    const nodesByReference = new Map(loaded.projection.nodes.map((node) => [node.ref, node]))
    return references.flatMap((reference) => {
      const node = nodesByReference.get(reference)
      return node?.kind === "turn" && node.title.trim()
        ? [Object.freeze({ reference, title: node.title })]
        : []
    })
  }, [loaded, loadedRouteSearch, routeSearch])

  const pendingJoinForLoaded = useMemo(() => {
    if (!loaded?.conversationReference) return null
    return pendingJoins.find((entry) => conversationJoinReceiptApplies(
      entry,
      tenantId,
      loaded.conversationReference as string,
    )) ?? null
  }, [loaded?.conversationReference, pendingJoins, tenantId])

  const openConversationFork = useCallback((
    parentTurnReference: string,
    title: string,
    trigger: HTMLButtonElement,
  ) => {
    if (!loaded?.conversationReference || loaded.conversationVersion === null
      || !loaded.conversationContentHash || loaded.conversationHasMore
      || loaded.conversationLoadedTurnCount >= CONVERSATION_TURN_LIMIT
      || !forkRecoveryHydrated || !joinRecoveryHydrated || uncertainFork || uncertainJoin
      || pendingForkForLoaded || pendingJoinForLoaded
      || loaded.projection.query.mode !== "conversation" || selectedReference !== parentTurnReference
      || !Object.hasOwn(loaded.turnContentByReference, parentTurnReference)) return
    const conversation = parseGalaxyObjectReference(loaded.conversationReference)
    const parent = parseGalaxyObjectReference(parentTurnReference)
    const conversationNode = loaded.projection.nodes.find((node) => node.ref === loaded.conversationReference)
    const parentNode = loaded.projection.nodes.find((node) => node.ref === parentTurnReference)
    if (!conversation || conversation.format !== "canonical" || conversation.kind !== "chat"
      || conversation.selector.mode !== "pinned"
      || conversation.selector.revision !== loaded.conversationContentHash
      || !conversationNode || conversationNode.kind !== "chat"
      || conversationNode.projection.provenance.sourceId !== conversation.id
      || conversationNode.projection.revision.id !== loaded.conversationContentHash
      || !parent || parent.format !== "canonical" || parent.kind !== "turn"
      || parent.selector.mode !== "pinned"
      || !parentNode || parentNode.kind !== "turn"
      || parentNode.projection.provenance.sourceId !== parent.id) return
    forkReturnFocusRef.current = trigger
    setForkTarget(Object.freeze({
      tenantId,
      conversationReference: loaded.conversationReference,
      parentTurnReference,
      expectedVersion: loaded.conversationVersion,
      title,
    }))
    setForkNotice(null)
    setForkDialogVersion((value) => value + 1)
    setForkOpen(true)
  }, [forkRecoveryHydrated, joinRecoveryHydrated, loaded, pendingForkForLoaded, pendingJoinForLoaded, selectedReference, tenantId, uncertainFork, uncertainJoin])

  const conversationForkDisabledReason = useMemo(() => {
    if (!loaded?.conversationReference) return "Forking is unavailable outside an exact conversation snapshot."
    if (loaded.conversationHasMore || loaded.conversationLoadedTurnCount >= CONVERSATION_TURN_LIMIT) {
      return `Forking is unavailable while turns beyond this ${CONVERSATION_TURN_LIMIT}-turn bounded snapshot are not discoverable.`
    }
    if (!forkRecoveryHydrated) return "Checking this browser tab for an uncertain fork request."
    if (!joinRecoveryHydrated) return "Checking this browser tab for an uncertain synthesis request."
    if (uncertainFork) return "An uncertain fork request must be retried or explicitly abandoned before another branch can be created."
    if (uncertainJoin) return "An uncertain synthesis request must be retried or explicitly abandoned before another branch can be created."
    if (pendingForkForLoaded) return "This conversation has an accepted fork receipt awaiting exact reconciliation or acknowledgement."
    if (pendingJoinForLoaded) return "This conversation has an accepted synthesis receipt awaiting exact reconciliation or acknowledgement."
    if (loaded.conversationVersion === null || !loaded.conversationContentHash) {
      return "The exact conversation version is unavailable."
    }
    return null
  }, [forkRecoveryHydrated, joinRecoveryHydrated, loaded, pendingForkForLoaded, pendingJoinForLoaded, uncertainFork, uncertainJoin])

  const openConversationJoin = useCallback((
    parentTurnReferences: readonly string[],
    labels: readonly string[],
    trigger: HTMLButtonElement,
  ) => {
    if (!loaded?.conversationReference || loaded.conversationVersion === null
      || !loaded.conversationContentHash || loaded.conversationHasMore
      || loaded.conversationLoadedTurnCount >= CONVERSATION_TURN_LIMIT
      || !forkRecoveryHydrated || !joinRecoveryHydrated || uncertainFork || uncertainJoin
      || pendingForkForLoaded || pendingJoinForLoaded
      || loaded.projection.query.mode !== "conversation"
      || parentTurnReferences.length < 2 || parentTurnReferences.length > 8
      || parentTurnReferences.length !== labels.length
      || selectedReference !== parentTurnReferences[0]
      || new Set(parentTurnReferences).size !== parentTurnReferences.length) return
    const candidateByReference = new Map(conversationJoinCandidates.map((candidate) => [candidate.reference, candidate]))
    if (parentTurnReferences.some((reference, index) => (
      candidateByReference.get(reference)?.title !== labels[index]
    ))) return
    joinReturnFocusRef.current = trigger
    setJoinTarget(Object.freeze({
      tenantId,
      conversationReference: loaded.conversationReference,
      parentTurnReferences: Object.freeze([...parentTurnReferences]),
      expectedVersion: loaded.conversationVersion,
      labels: Object.freeze([...labels]),
    }))
    setJoinNotice(null)
    setJoinDialogVersion((value) => value + 1)
    setJoinOpen(true)
  }, [conversationJoinCandidates, forkRecoveryHydrated, joinRecoveryHydrated, loaded, pendingForkForLoaded, pendingJoinForLoaded, selectedReference, tenantId, uncertainFork, uncertainJoin])

  const conversationJoinDisabledReason = useMemo(() => {
    if (!loaded?.conversationReference) return "Synthesis is unavailable outside an exact conversation snapshot."
    if (loaded.conversationHasMore || loaded.conversationLoadedTurnCount >= CONVERSATION_TURN_LIMIT) {
      return `Synthesis is unavailable while turns beyond this ${CONVERSATION_TURN_LIMIT}-turn bounded snapshot are not discoverable.`
    }
    if (!joinRecoveryHydrated || !forkRecoveryHydrated) return "Checking this browser tab for an uncertain conversation mutation."
    if (uncertainJoin) return "An uncertain synthesis request must be retried or explicitly abandoned before another synthesis can be created."
    if (uncertainFork) return "An uncertain fork request must be retried or explicitly abandoned before a synthesis can be created."
    if (pendingJoinForLoaded) return "This conversation has an accepted synthesis receipt awaiting exact reconciliation or acknowledgement."
    if (pendingForkForLoaded) return "This conversation has an accepted fork receipt awaiting exact reconciliation or acknowledgement."
    if (loaded.conversationVersion === null || !loaded.conversationContentHash) return "The exact conversation version is unavailable."
    if (conversationJoinCandidates.length < 2) return "This exact conversation does not currently have two independently joinable branch tips."
    return null
  }, [conversationJoinCandidates.length, forkRecoveryHydrated, joinRecoveryHydrated, loaded, pendingForkForLoaded, pendingJoinForLoaded, uncertainFork, uncertainJoin])

  const conversationExport = useMemo(() => {
    if (!loaded?.conversationReference || loadedRouteSearch !== routeSearch
      || loaded.projection.query.mode !== "conversation" || !loaded.conversationContentHash) return null
    const reference = parseGalaxyObjectReference(loaded.conversationReference)
    const conversationNode = loaded.projection.nodes.find((node) => node.ref === loaded.conversationReference)
    if (!reference || reference.format !== "canonical" || reference.kind !== "chat"
      || reference.selector.mode !== "pinned"
      || reference.selector.revision !== loaded.conversationContentHash
      || !conversationNode || conversationNode.kind !== "chat"
      || conversationNode.projection.provenance.sourceId?.toLowerCase() !== reference.id.toLowerCase()
      || conversationNode.projection.revision.id !== loaded.conversationContentHash) return null
    return Object.freeze({
      conversationReference: loaded.conversationReference,
      disabledReason: loaded.conversationHasMore
        ? `Markdown export is unavailable because this snapshot exceeds the ${CONVERSATION_TURN_LIMIT}-turn portable bound.`
        : null,
    })
  }, [loaded, loadedRouteSearch, routeSearch])

  const exportConversationMarkdown = useCallback(() => {
    if (!conversationExport || conversationExport.disabledReason
      || selectedReference !== conversationExport.conversationReference) return
    conversationExportControllerRef.current?.abort()
    const controller = new AbortController()
    const generation = conversationExportGenerationRef.current + 1
    conversationExportGenerationRef.current = generation
    conversationExportControllerRef.current = controller
    const reference = conversationExport.conversationReference
    setConversationExportState({ reference, status: "downloading", message: null })
    fetchConversationMarkdownExport(reference, { signal: controller.signal })
      .then((exported) => {
        if (generation !== conversationExportGenerationRef.current || controller.signal.aborted) return
        saveConversationMarkdownExport(exported)
        if (generation !== conversationExportGenerationRef.current || controller.signal.aborted) return
        setConversationExportState({
          reference,
          status: "downloaded",
          message: `Downloaded ${exported.filename} (${exported.byteLength.toLocaleString()} bytes).`,
        })
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || generation !== conversationExportGenerationRef.current) return
        setConversationExportState({
          reference,
          status: "error",
          message: cause instanceof ConversationMarkdownDownloadError
            ? cause.message
            : "Conversation Markdown download is unavailable.",
        })
      })
      .finally(() => {
        if (generation === conversationExportGenerationRef.current) {
          conversationExportControllerRef.current = null
        }
      })
  }, [conversationExport, selectedReference])

  const acceptConversationFork = useCallback((
    receipt: ConversationForkReceipt,
    intent: ConversationForkIntent,
    target: ConversationForkTarget,
  ) => {
    if (target.tenantId !== tenantId
      || intent.conversationReference !== target.conversationReference
      || intent.parentTurnReference !== target.parentTurnReference
      || intent.expectedVersion !== target.expectedVersion
      || receipt.conversationId !== intent.conversationId
      || receipt.version !== intent.expectedVersion + 1) return
    setPendingForks((current) => Object.freeze([
      ...current.filter((entry) => entry.receipt.revisionId !== receipt.revisionId),
      Object.freeze({ tenantId, intent, receipt, target, status: "reconciling" as const }),
    ]))
    setReceiptResetCandidate(null)
    setForkOpen(false)
    setForkNotice(
      `Fork receipt ${receipt.revisionId} accepted for immutable conversation v${receipt.version} (${receipt.contentHash}). Reloading that exact revision before selecting the new turn; Galaxy will not repost this request.`,
    )
    const parameters = new URLSearchParams({
      mode: "conversation",
      conversation: receipt.conversationReference,
      ref: receipt.conversationReference,
      scale: "object",
    })
    router.push(`/graph?${parameters}`)
  }, [router, tenantId])

  const acceptConversationJoin = useCallback((
    receipt: ConversationJoinReceipt,
    intent: ConversationJoinIntent,
    target: ConversationJoinTarget,
  ) => {
    const sameParents = intent.parentTurnReferences.length === target.parentTurnReferences.length
      && intent.parentTurnReferences.every((reference, index) => reference === target.parentTurnReferences[index])
    if (target.tenantId !== tenantId
      || intent.conversationReference !== target.conversationReference
      || !sameParents
      || intent.expectedVersion !== target.expectedVersion
      || receipt.conversationId !== intent.conversationId
      || receipt.version !== intent.expectedVersion + 1) return
    setPendingJoins((current) => Object.freeze([
      ...current.filter((entry) => entry.receipt.revisionId !== receipt.revisionId),
      Object.freeze({ tenantId, intent, receipt, target, status: "reconciling" as const }),
    ]))
    setJoinReceiptResetCandidate(null)
    setJoinOpen(false)
    setJoinNotice(
      `Synthesis receipt ${receipt.revisionId} accepted for immutable conversation v${receipt.version} (${receipt.contentHash}). Reloading that exact revision before selecting the joined turn; Galaxy will not repost this request.`,
    )
    const parameters = new URLSearchParams({
      mode: "conversation",
      conversation: receipt.conversationReference,
      ref: receipt.conversationReference,
      scale: "object",
    })
    router.push(`/graph?${parameters}`)
  }, [router, tenantId])

  useEffect(() => {
    if (!forkOpen || !forkTarget) return
    const isRecoveringUncertainRequest = uncertainFork?.tenantId === forkTarget.tenantId
      && uncertainFork.target.conversationReference === forkTarget.conversationReference
      && uncertainFork.target.parentTurnReference === forkTarget.parentTurnReference
      && uncertainFork.target.expectedVersion === forkTarget.expectedVersion
    if (isRecoveringUncertainRequest) return
    const targetStillLoaded = forkTarget.tenantId === tenantId
      && loaded?.conversationReference === forkTarget.conversationReference
      && loaded.conversationVersion === forkTarget.expectedVersion
      && selectedReference === forkTarget.parentTurnReference
      && Object.hasOwn(loaded.turnContentByReference, forkTarget.parentTurnReference)
    if (targetStillLoaded) return
    setForkOpen(false)
    setForkTarget(null)
  }, [forkOpen, forkTarget, loaded, selectedReference, tenantId, uncertainFork])

  useEffect(() => {
    if (!joinOpen || !joinTarget) return
    const isRecoveringUncertainRequest = uncertainJoin?.tenantId === joinTarget.tenantId
      && uncertainJoin.target.conversationReference === joinTarget.conversationReference
      && uncertainJoin.target.expectedVersion === joinTarget.expectedVersion
      && uncertainJoin.target.parentTurnReferences.length === joinTarget.parentTurnReferences.length
      && uncertainJoin.target.parentTurnReferences.every(
        (reference, index) => reference === joinTarget.parentTurnReferences[index],
      )
    if (isRecoveringUncertainRequest) return
    const candidateReferences = new Set(conversationJoinCandidates.map((candidate) => candidate.reference))
    const targetStillLoaded = joinTarget.tenantId === tenantId
      && loaded?.conversationReference === joinTarget.conversationReference
      && loaded.conversationVersion === joinTarget.expectedVersion
      && selectedReference === joinTarget.parentTurnReferences[0]
      && joinTarget.parentTurnReferences.every((reference) => candidateReferences.has(reference))
    if (targetStillLoaded) return
    setJoinOpen(false)
    setJoinTarget(null)
  }, [conversationJoinCandidates, joinOpen, joinTarget, loaded, selectedReference, tenantId, uncertainJoin])

  useEffect(() => {
    if (!pendingForkForLoaded || !loaded) return
    const reconciledTurnReference = reconcileConversationFork(pendingForkForLoaded, {
      conversationReference: loaded.conversationReference,
      version: loaded.conversationVersion,
      contentHash: loaded.conversationContentHash,
      projection: loaded.projection,
    })
    if (reconciledTurnReference) {
      const parameters = new URLSearchParams({
        mode: "conversation",
        conversation: pendingForkForLoaded.receipt.conversationReference,
        ref: reconciledTurnReference,
        scale: "object",
      })
      setPendingForks((current) => current.filter(
        (entry) => entry.receipt.revisionId !== pendingForkForLoaded.receipt.revisionId,
      ))
      setReceiptResetCandidate(null)
      setSelectedReference(reconciledTurnReference)
      setFocusSelectedReference(reconciledTurnReference)
      setForkNotice("The exact new branch is loaded and selected.")
      window.history.replaceState(null, "", `/graph?${parameters}`)
      return
    }
    if (loaded.conversationReference === pendingForkForLoaded.receipt.conversationReference
      && loaded.conversationVersion === pendingForkForLoaded.receipt.version
      && loaded.conversationContentHash === pendingForkForLoaded.receipt.contentHash) {
      setPendingForks((current) => current.map((entry) => (
        entry.receipt.revisionId === pendingForkForLoaded.receipt.revisionId && entry.status !== "failed"
          ? Object.freeze({ ...entry, status: "failed" as const })
          : entry
      )))
      setForkNotice(
        `Fork receipt ${pendingForkForLoaded.receipt.revisionId} is durable, but its exact branch edge could not be verified in the loaded projection. Galaxy will not repost or invent a turn reference.`,
      )
    }
  }, [loaded, pendingForkForLoaded])

  useEffect(() => {
    if (!pendingJoinForLoaded || !loaded) return
    const reconciledTurnReference = reconcileConversationJoin(pendingJoinForLoaded, {
      conversationReference: loaded.conversationReference,
      version: loaded.conversationVersion,
      contentHash: loaded.conversationContentHash,
      projection: loaded.projection,
    })
    if (reconciledTurnReference) {
      const parameters = new URLSearchParams({
        mode: "conversation",
        conversation: pendingJoinForLoaded.receipt.conversationReference,
        ref: reconciledTurnReference,
        scale: "object",
      })
      setPendingJoins((current) => current.filter(
        (entry) => entry.receipt.revisionId !== pendingJoinForLoaded.receipt.revisionId,
      ))
      setJoinReceiptResetCandidate(null)
      setSelectedReference(reconciledTurnReference)
      setFocusSelectedReference(reconciledTurnReference)
      setJoinNotice("The exact joined turn is loaded and selected.")
      window.history.replaceState(null, "", `/graph?${parameters}`)
      return
    }
    if (loaded.conversationReference === pendingJoinForLoaded.receipt.conversationReference
      && loaded.conversationVersion === pendingJoinForLoaded.receipt.version
      && loaded.conversationContentHash === pendingJoinForLoaded.receipt.contentHash) {
      setPendingJoins((current) => current.map((entry) => (
        entry.receipt.revisionId === pendingJoinForLoaded.receipt.revisionId && entry.status !== "failed"
          ? Object.freeze({ ...entry, status: "failed" as const })
          : entry
      )))
      setJoinNotice(
        `Synthesis receipt ${pendingJoinForLoaded.receipt.revisionId} is durable, but all of its exact parent edges could not be verified in the loaded projection. Galaxy will not repost or invent a turn reference.`,
      )
    }
  }, [loaded, pendingJoinForLoaded])

  useEffect(() => {
    if (!error) return
    let requestedConversation: string | null = null
    try {
      requestedConversation = canonicalGraphQueryParameter(new URLSearchParams(routeSearch), "conversation")
    } catch {
      return
    }
    if (!requestedConversation) return
    setPendingForks((current) => current.map((entry) => (
      entry.tenantId === tenantId && entry.receipt.conversationReference === requestedConversation
        ? Object.freeze({ ...entry, status: "failed" as const })
        : entry
    )))
    setPendingJoins((current) => current.map((entry) => (
      entry.tenantId === tenantId && entry.receipt.conversationReference === requestedConversation
        ? Object.freeze({ ...entry, status: "failed" as const })
        : entry
    )))
  }, [error, routeSearch, tenantId])

  const openPendingForkSnapshot = useCallback((entry: PendingConversationFork) => {
    if (entry.tenantId !== tenantId) return
    setPendingForks((current) => current.map((candidate) => (
      candidate.receipt.revisionId === entry.receipt.revisionId
        ? Object.freeze({ ...candidate, status: "reconciling" as const })
        : candidate
    )))
    setReceiptResetCandidate(null)
    const parameters = new URLSearchParams({
      mode: "conversation",
      conversation: entry.receipt.conversationReference,
      ref: entry.receipt.conversationReference,
      scale: "object",
    })
    if (loaded?.conversationReference === entry.receipt.conversationReference) {
      setRequestVersion((value) => value + 1)
      return
    }
    router.push(`/graph?${parameters}`)
  }, [loaded?.conversationReference, router, tenantId])

  const stopTrackingPendingFork = useCallback((entry: PendingConversationFork) => {
    if (entry.tenantId !== tenantId || receiptResetCandidate !== entry.receipt.revisionId) return
    setPendingForks((current) => current.filter(
      (candidate) => candidate.receipt.revisionId !== entry.receipt.revisionId,
    ))
    setReceiptResetCandidate(null)
    setForkNotice(
      `Stopped tracking fork receipt ${entry.receipt.revisionId} in this browser session. The durable server mutation was not undone or repeated.`,
    )
  }, [receiptResetCandidate, tenantId])

  const openPendingJoinSnapshot = useCallback((entry: PendingConversationJoin) => {
    if (entry.tenantId !== tenantId) return
    setPendingJoins((current) => current.map((candidate) => (
      candidate.receipt.revisionId === entry.receipt.revisionId
        ? Object.freeze({ ...candidate, status: "reconciling" as const })
        : candidate
    )))
    setJoinReceiptResetCandidate(null)
    const parameters = new URLSearchParams({
      mode: "conversation",
      conversation: entry.receipt.conversationReference,
      ref: entry.receipt.conversationReference,
      scale: "object",
    })
    if (loaded?.conversationReference === entry.receipt.conversationReference) {
      setRequestVersion((value) => value + 1)
      return
    }
    router.push(`/graph?${parameters}`)
  }, [loaded?.conversationReference, router, tenantId])

  const stopTrackingPendingJoin = useCallback((entry: PendingConversationJoin) => {
    if (entry.tenantId !== tenantId || joinReceiptResetCandidate !== entry.receipt.revisionId) return
    setPendingJoins((current) => current.filter(
      (candidate) => candidate.receipt.revisionId !== entry.receipt.revisionId,
    ))
    setJoinReceiptResetCandidate(null)
    setJoinNotice(
      `Stopped tracking synthesis receipt ${entry.receipt.revisionId} in this browser session. The durable server mutation was not undone or repeated.`,
    )
  }, [joinReceiptResetCandidate, tenantId])

  const status = useMemo(() => {
    if (!loaded) return null
    if (loaded.codeSourceContinuation) {
      const { truncated, omittedNodes, omittedEdges } = loaded.codeSourceContinuation
      if (truncated || omittedNodes > 0 || omittedEdges > 0) {
        return `${loaded.codeSourceStatus} Bounded code neighborhood${truncated ? " reached its node limit" : ""}; ${omittedNodes} unaddressable object${omittedNodes === 1 ? "" : "s"} and ${omittedEdges} relation${omittedEdges === 1 ? "" : "s"} were omitted. Recenter on an exact code object to continue.`
      }
      return loaded.codeSourceStatus
    }
    if (loaded.taskPlanSourceContinuation?.hasMore) {
      const { omittedPlans, omittedObjects } = loaded.taskPlanSourceContinuation
      return `${omittedPlans} saved Task Plan${omittedPlans === 1 ? "" : "s"} (${omittedObjects} plan/job objects) remain outside this bounded graph page. Focus an exact plan or job reference to prioritize the complete plan.`
    }
    if (loaded.proofSourceContinuation?.hasMore) {
      const { nodes, relations } = loaded.proofSourceContinuation.omitted
      return `${nodes} proof node${nodes === 1 ? "" : "s"} and ${relations} relation${relations === 1 ? "" : "s"} remain outside this bounded graph page. Focus a proof reference to prioritize its neighborhood.`
    }
    if (loaded.conversationHasMore) {
      return `Showing the first ${CONVERSATION_TURN_LIMIT} immutable turns. The conversation is larger than this bounded graph page.`
    }
    const omitted = loaded.diagnostics.omitted
    const missing = omitted.missingEndpointLinks
    return missing > 0
      ? `${missing} relation${missing === 1 ? "" : "s"} omitted because both authorized endpoints were not loaded.`
      : null
  }, [loaded])

  const fieldProjection = useMemo(() => (
    presentation === "field" && loaded
      ? projectUnifiedGraphToSemanticField(loaded.projection, { focusReference: selectedReference })
      : null
  ), [loaded, presentation, selectedReference])
  const selectedReferenceMissing = Boolean(
    presentation === "field"
    && selectedReference
    && fieldProjection
    && !fieldProjection.entities.some((entity) => entity.sourceReference === selectedReference),
  )
  const fieldProjectionIncomplete = Boolean(fieldProjection && (
    fieldProjection.truncation.nodeLimitReached
    || fieldProjection.truncation.edgeLimitReached
    || fieldProjection.truncation.omittedDerivedNodes > 0
    || fieldProjection.truncation.omittedUnsupportedNodes > 0
  ))
  const fieldProjectionNotice = fieldProjectionIncomplete && fieldProjection
    ? `Bounded field: ${fieldProjection.entities.length} of ${fieldProjection.corpusStatementCount} supported authorized objects and ${fieldProjection.relations.length} relations are visible. ${fieldProjection.truncation.omittedUnsupportedNodes} unsupported and ${fieldProjection.truncation.omittedDerivedNodes} derived-only objects were omitted. Focus an exact reference to prioritize its neighborhood.`
    : null
  const fieldProviderNotice = fieldProjection?.incompleteProviders.length
    ? `Provider coverage is incomplete: ${fieldProjection.incompleteProviders.map((provider) => `${provider.provider} (${provider.status})`).join(", ")}.`
    : null
  const fieldNotice = [
    selectedReferenceMissing ? "The requested object is not available in this authorized field. No substitute was selected." : null,
    status,
    fieldProjectionNotice,
    fieldProviderNotice,
  ].filter((message): message is string => Boolean(message)).join(" ") || null

  if (presentation === "field") {
    if (!loaded && !error) {
      return (
        <div className="research-panel flex h-full min-h-[32rem] items-center justify-center rounded-[1.75rem] border text-[hsl(var(--field-muted-strong))]" role="status" aria-live="polite" aria-atomic="true">
          <LoaderCircle className="mr-2 h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {codeSnapshotActive ? "Loading the exact code snapshot…" : "Loading your authorized field…"}
        </div>
      )
    }
    if (error || !loaded || !fieldProjection) {
      return (
        <div className="graph-surface__warning flex h-full min-h-[24rem] flex-col items-center justify-center rounded-[1.75rem] border p-8 text-center" role="alert">
          <AlertTriangle className="h-7 w-7" aria-hidden="true" />
          <h2 className="research-display mt-3 text-2xl font-semibold">The authorized field could not be assembled</h2>
          <p className="mt-2 max-w-lg text-sm">{error ?? "No demo, derived chunk, or cross-workspace data has been substituted."}</p>
          <Button className="mt-5" variant="outline" onClick={() => setRequestVersion((value) => value + 1)}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" /> Retry
          </Button>
        </div>
      )
    }
    return (
      <div className="research-panel flex h-full min-h-[32rem] flex-col overflow-hidden rounded-[1.75rem] border">
        {fieldNotice && (
          <div className="shrink-0 border-b border-[hsl(var(--field-warm-strong)/.45)] bg-[hsl(var(--field-warm)/.14)] px-4 py-2 text-xs leading-relaxed text-[hsl(var(--field-ink))]" role="status">
            {fieldNotice}
          </div>
        )}
        <div className="min-h-0 flex-1">
          <SemanticField
            workspace={AUTHORIZED_FIELD_WORKSPACE}
            nodes={[]}
            federatedProjection={fieldProjection}
            focusReference={selectedReference ?? undefined}
            hrefForReference={loaded.codeSnapshotReference ? (reference) => {
              const parsed = parseGalaxyObjectReference(reference)
              if (parsed?.kind === "document" && loaded.codeSourceDocumentHref) return loaded.codeSourceDocumentHref
              const query = new URLSearchParams({ codeSnapshot: loaded.codeSnapshotReference as string, ref: reference })
              return `/field?${query}`
            } : fieldHrefForReference}
            onReferenceChange={onFieldReferenceChange}
            onCorpusReferenceSelect={onFieldCorpusReferenceSelect}
          />
        </div>
      </div>
    )
  }

  let graphContent
  if (corpusActive && corpusWindow && !error) {
    graphContent = (
      <CorpusGraphWindow
        window={corpusWindow}
        loading={windowLoading}
        onExpand={expandCorpusCluster}
        onBack={closeCorpusCluster}
        onNextPage={nextCorpusPage}
        onOpenMember={openCorpusMember}
        focusReturnHref={corpusFocusReturnHref}
      />
    )
  } else if (!loaded && !error) {
    graphContent = (
      <div className="graph-surface flex min-h-[39rem] items-center justify-center rounded-[1.75rem] border text-[hsl(var(--field-muted-strong))]" role="status" aria-live="polite" aria-atomic="true">
        <LoaderCircle className="mr-2 h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        {corpusActive ? "Loading a bounded corpus window…" : codeSnapshotActive ? "Loading the exact code snapshot…" : "Loading your authorized field…"}
      </div>
    )
  } else if (error || !loaded) {
    graphContent = (
      <div className="graph-surface__warning flex min-h-[24rem] flex-col items-center justify-center rounded-[1.75rem] border p-8 text-center" role="alert">
        <AlertTriangle className="h-7 w-7" aria-hidden="true" />
        <h2 className="research-display mt-3 text-2xl font-semibold">
          {corpusActive ? "The bounded corpus window is unavailable" : "The authorized graph could not be assembled"}
        </h2>
        <p className="mt-2 max-w-lg text-sm">{error ?? "No demo or cross-workspace data has been substituted."}</p>
        <Button className="mt-5" variant="outline" onClick={() => {
          if (corpusActive) setWindowCursor(null)
          setRequestVersion((value) => value + 1)
        }}>
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" /> Retry
        </Button>
      </div>
    )
  } else {
    graphContent = (
      <>
        {status ? (
          <p className="graph-surface__warning mb-3 rounded-2xl border px-4 py-3 text-sm" role="status" aria-live="polite" aria-atomic="true">
            {status}
          </p>
        ) : null}
        <UnifiedGraph
          projection={loaded.projection}
          coordinationTasks={loaded.coordinationTasks}
          onScaleChange={changeGraphScale}
          selectedTurnDetail={selectedReference && Object.hasOwn(loaded.turnContentByReference, selectedReference)
            ? Object.freeze({ reference: selectedReference, content: loaded.turnContentByReference[selectedReference] })
            : null}
          initialScale={loaded.projection.query.scale}
          selectedReference={selectedReference}
          onSelectedReferenceChange={onSelectedReferenceChange}
          focusSelectedReference={focusSelectedReference}
          onFocusedSelectedReference={onFocusedSelectedReference}
          conversationFork={loaded.conversationReference ? {
            disabledReason: conversationForkDisabledReason,
            onOpen: openConversationFork,
          } : null}
          conversationJoin={loaded.conversationReference && selectedReference
            && conversationJoinCandidates.some((candidate) => candidate.reference === selectedReference)
            ? {
              candidates: conversationJoinCandidates,
              selectedTipReference: selectedReference,
              disabledReason: conversationJoinDisabledReason,
              onOpen: openConversationJoin,
            }
            : null}
          conversationExport={conversationExport ? {
            ...conversationExport,
            state: conversationExportState.reference === conversationExport.conversationReference
              ? conversationExportState.status
              : "idle",
            message: conversationExportState.reference === conversationExport.conversationReference
              ? conversationExportState.message
              : null,
            onDownload: exportConversationMarkdown,
          } : null}
          hrefForReference={loaded.conversationReference ? (reference) => {
            const query = new URLSearchParams({
              mode: "conversation",
              conversation: loaded.conversationReference as string,
              ref: reference,
              scale: loaded.projection.query.scale,
            })
            return `/graph?${query}`
          } : loaded.codeSnapshotReference ? (reference) => {
            const parsed = parseGalaxyObjectReference(reference)
            if (parsed?.kind === "document" && loaded.codeSourceDocumentHref) return loaded.codeSourceDocumentHref
            const query = new URLSearchParams({
              codeSnapshot: loaded.codeSnapshotReference as string,
              ref: reference,
              scale: loaded.projection.query.scale,
            })
            return `/graph?${query}`
          } : undefined}
          onOpenReference={loaded.codeSnapshotReference ? recenterCodeNeighborhood : undefined}
          openReferenceLabel={loaded.codeSnapshotReference ? (node) => (
            node.kind === "document" ? "Open exact source document" : "Recenter code neighborhood"
          ) : undefined}
        />
      </>
    )
  }

  return (
    <div className="space-y-3">
      <ConversationBrowser
        selectedConversationReference={loaded?.conversationReference ?? null}
        tenantId={tenantId}
      />
      {forkNotice ? (
        <p className="graph-surface__warning rounded-2xl border px-4 py-3 text-sm" role="status" aria-live="polite">
          {forkNotice}
        </p>
      ) : null}
      {joinNotice ? (
        <p className="graph-surface__warning rounded-2xl border px-4 py-3 text-sm" role="status" aria-live="polite">
          {joinNotice}
        </p>
      ) : null}
      {uncertainFork?.tenantId === tenantId ? (
        <div className="graph-surface__warning rounded-2xl border px-4 py-3 text-sm">
          <p role="status" aria-live="polite">
            A fork request has uncertain delivery. Its exact body and idempotency key are preserved in this browser tab; Galaxy will not create another branch until you resolve it.
          </p>
          <Button className="mt-3" variant="outline" onClick={(event) => resumeUncertainFork(event.currentTarget)}>
            Retry or review exact request
          </Button>
        </div>
      ) : null}
      {uncertainJoin?.tenantId === tenantId ? (
        <div className="graph-surface__warning rounded-2xl border px-4 py-3 text-sm">
          <p role="status" aria-live="polite">
            A synthesis request has uncertain delivery. Its exact parent turns, body, and idempotency key are preserved in this browser tab; Galaxy will not create another conversation mutation until you resolve it.
          </p>
          <Button className="mt-3" variant="outline" onClick={(event) => resumeUncertainJoin(event.currentTarget)}>
            Retry or review exact request
          </Button>
        </div>
      ) : null}
      {pendingForks.filter((entry) => entry.tenantId === tenantId).map((entry) => (
        <div key={entry.receipt.revisionId} className="graph-surface__warning rounded-2xl border px-4 py-3 text-sm">
          <p role="status">
            Fork receipt <code>{entry.receipt.revisionId}</code> is accepted for conversation v{entry.receipt.version}.
            {entry.status === "failed"
              ? " Its exact branch edge is not currently verified in the loaded projection."
              : " Galaxy is waiting to verify its exact branch edge."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => openPendingForkSnapshot(entry)}>
              {entry.status === "failed" ? "Reload exact receipt snapshot" : "Open exact receipt snapshot"}
            </Button>
            {receiptResetCandidate === entry.receipt.revisionId ? (
              <>
                <Button variant="outline" onClick={() => setReceiptResetCandidate(null)}>Keep tracking</Button>
                <Button variant="destructive" onClick={() => stopTrackingPendingFork(entry)}>
                  I understand — stop tracking
                </Button>
              </>
            ) : (
              <Button variant="ghost" onClick={() => setReceiptResetCandidate(entry.receipt.revisionId)}>
                Stop tracking receipt…
              </Button>
            )}
          </div>
          {receiptResetCandidate === entry.receipt.revisionId ? (
            <p className="mt-2 text-xs leading-5">
              This only releases the browser-session lock. It does not undo, repeat, or verify the durable server mutation.
            </p>
          ) : null}
        </div>
      ))}
      {pendingJoins.filter((entry) => entry.tenantId === tenantId).map((entry) => (
        <div key={entry.receipt.revisionId} className="graph-surface__warning rounded-2xl border px-4 py-3 text-sm">
          <p role="status">
            Synthesis receipt <code>{entry.receipt.revisionId}</code> is accepted for conversation v{entry.receipt.version}.
            {entry.status === "failed"
              ? " Its exact parent edges are not currently verified in the loaded projection."
              : " Galaxy is waiting to verify all exact parent edges."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => openPendingJoinSnapshot(entry)}>
              {entry.status === "failed" ? "Reload exact receipt snapshot" : "Open exact receipt snapshot"}
            </Button>
            {joinReceiptResetCandidate === entry.receipt.revisionId ? (
              <>
                <Button variant="outline" onClick={() => setJoinReceiptResetCandidate(null)}>Keep tracking</Button>
                <Button variant="destructive" onClick={() => stopTrackingPendingJoin(entry)}>
                  I understand — stop tracking
                </Button>
              </>
            ) : (
              <Button variant="ghost" onClick={() => setJoinReceiptResetCandidate(entry.receipt.revisionId)}>
                Stop tracking receipt…
              </Button>
            )}
          </div>
          {joinReceiptResetCandidate === entry.receipt.revisionId ? (
            <p className="mt-2 text-xs leading-5">
              This only releases the browser-session lock. It does not undo, repeat, or verify the durable server mutation.
            </p>
          ) : null}
        </div>
      ))}
      <ProofGraphRegistryDialog open={proofRegistryOpen} onOpenChange={changeProofRegistryOpen} />
      <ConversationForkDialog
        key={forkDialogVersion}
        open={forkOpen}
        target={forkTarget}
        initialIntent={uncertainFork?.tenantId === tenantId
          && uncertainFork.target.conversationReference === forkTarget?.conversationReference
          && uncertainFork.target.parentTurnReference === forkTarget?.parentTurnReference
          && uncertainFork.target.expectedVersion === forkTarget?.expectedVersion
          ? uncertainFork.intent
          : null}
        returnFocus={forkReturnFocusRef.current}
        onOpenChange={setForkOpen}
        onUncertain={retainUncertainFork}
        onClearUncertain={clearUncertainFork}
        onForked={acceptConversationFork}
      />
      <ConversationJoinDialog
        key={joinDialogVersion}
        open={joinOpen}
        target={joinTarget}
        initialIntent={uncertainJoin?.tenantId === tenantId
          && uncertainJoin.target.conversationReference === joinTarget?.conversationReference
          && uncertainJoin.target.expectedVersion === joinTarget?.expectedVersion
          && uncertainJoin.target.parentTurnReferences.length === joinTarget?.parentTurnReferences.length
          && uncertainJoin.target.parentTurnReferences.every(
            (reference, index) => reference === joinTarget?.parentTurnReferences[index],
          )
          ? uncertainJoin.intent
          : null}
        returnFocus={joinReturnFocusRef.current}
        onOpenChange={setJoinOpen}
        onUncertain={retainUncertainJoin}
        onClearUncertain={clearUncertainJoin}
        onJoined={acceptConversationJoin}
      />
      {graphContent}
    </div>
  )
}
