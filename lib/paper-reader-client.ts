import type { DocumentAnchorSelector } from "@/lib/document-anchor.js"
import {
  createDocumentMarkRecoverably,
  listDocumentMarks,
  prepareDocumentMarkCreateIntent,
  readDocumentMarkRecoveries,
  type DocumentMarkList,
  type DocumentMarkAnchor,
  type DocumentMarkCreateIntent,
  type DocumentMarkRecoveryScope,
  type DocumentMarkRecoveryStorage,
  type DurableDocumentMark as ValidatedDurableDocumentMark,
} from "@/lib/document-mark-client.js"
import {
  createDocumentTransformClient,
  type DocumentTransformResult,
} from "@/lib/document-transform-client.js"
import { createTask as postHamTask } from "@/lib/ham-task-client"
import { galaxyBrainAPI } from "@/lib/galaxy-brain-api"
import type { DurableTransformReceipt } from "@/lib/ingestion-contract.js"
import {
  parseDocumentLocalIndexStatus,
  type DocumentLocalIndexStatus,
} from "@/lib/document-local-index.js"
import type { ReaderRepresentation } from "@/lib/paper-reader.js"
import type { RasterImageManifest } from "@/lib/raster-image-contract.js"
import type { AudioOriginalManifest } from "@/lib/audio-original-contract.js"
import { hydrateAtlasObjectReferences } from "@/lib/atlas-object-hydration.js"
import {
  normalizePaperEnhanceReferences,
  paperTaskConstructorHref,
  paperTaskConstructorHrefFromLink,
} from "@/lib/paper-enhance-handoff.js"
import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "@/lib/galaxy-object-reference.js"
import {
  paperAgentLoopKeys,
  paperAgentLoopTask,
  normalizePaperTaskOperation,
  runPaperTaskSaga,
  type PaperTaskCheckpoint,
  type PaperTaskSagaOperation,
} from "@/lib/paper-reader-task-saga.js"
import { createStarterTaskPlan, createTaskPlanTitle } from "@/lib/task-plan"
import { startTaskPlanRun, type TaskPlanRunReceipt } from "@/lib/task-plan-run-client.js"
import type { TaskPlanRecord, TaskPlanSpec } from "@/lib/types/task-plans"
import type { CreateTaskInput } from "@/lib/types/tasks"

const GALAXY_API = "/api/eln"

export type DurableDocumentAnchor = {
  schemaId: "gb.anchor.v1"
  id: `sha256:${string}`
  ref: string
  document_ref: string
  document_id: string
  document_revision_id: string
  document_revision_sha256: string
  title: string
  display_filename: string
  representation_id: string
  representation_kind: ReaderRepresentation["kind"]
  representation_media_type: string
  representation_sha256: string
  selector: DocumentAnchorSelector
  selector_kind: DocumentAnchorSelector["kind"]
  selector_sha256: string
  anchor_sha256: string
  source: { id: string; kind: string; uri: string | null }
  created_at: string
  transform_receipt_ids?: string[]
  replayed?: boolean
}

export type DurableDocumentRevision = {
  schemaId: "gb.document-revision.v1"
  document_id: string
  ref: string
  revision_id: string
  version: number
  revision_sha256: string
  title: string
  display_filename: string
  created_at: string
  artifact: {
    id: string
    content_sha256: string
    byte_size: number
    media_type: string
  }
  source: {
    id: string
    kind: string
    uri: string
    original_filename: string
  }
  raster_image?: RasterImageManifest
  audio_original?: AudioOriginalManifest
  representations: Array<Omit<ReaderRepresentation, "content"> & { content_path: string }>
}

export type PaperReaderBacklink = {
  id: string
  kind: "mark" | "relation" | "task"
  label: string
  detail?: string
  href?: string
  status?: string
  taskId?: string
  createdTaskVersion?: number
  runId?: string
}

export type PaperAgentResultDecision = {
  action: "accept" | "reject"
  acceptedDocumentRef?: string
}

export type PaperAgentResultCandidate = {
  schemaId: "gb.paper-agent-result.v1"
  taskId: string
  taskVersion: number
  eventId: string
  runId?: string
  resultHash: string
  summary: string
  actorRef?: string
  occurredAt?: string
  evidenceRefs: string[]
  decision?: PaperAgentResultDecision
}

export type PaperReaderMarkRequest = {
  anchor: DurableDocumentAnchor
  body: string
  intent: "note" | "clip"
  sourceHref: string
}

export type PaperReaderTaskRequest = {
  schemaId: "gb.paper-task-request.v1"
  idempotencyKey: string
  requestedAt: string
  anchor: DurableDocumentAnchor
  resourceRefs?: readonly string[]
  title: string
  goal: string
  sourceHref: string
  executionMode?: "review" | "run"
  taskIdempotencyKey?: string
  linkIdempotencyKey?: string
  task?: PaperTaskCheckpoint | null
  stage?: "requested" | "task-created"
}

export type PaperReaderActionPort = {
  createMark?: (request: PaperReaderMarkRequest) => Promise<ValidatedDurableDocumentMark>
  retryMark?: (intent: DocumentMarkCreateIntent) => Promise<ValidatedDurableDocumentMark>
  listMarkRecoveries?: () => readonly DocumentMarkCreateIntent[]
  createTask?: (request: PaperReaderTaskRequest) => Promise<PaperReaderBacklink>
  authorizeTaskRefs?: (anchorRef: string, resourceRefs: readonly string[]) => Promise<readonly string[]>
  listBacklinks?: (anchor: DurableDocumentAnchor) => Promise<PaperReaderBacklink[]>
  listAgentResults?: (
    anchor: DurableDocumentAnchor,
    backlinks: readonly PaperReaderBacklink[],
    signal?: AbortSignal,
  ) => Promise<PaperAgentResultCandidate[]>
  decideAgentResult?: (
    anchor: DurableDocumentAnchor,
    candidate: PaperAgentResultCandidate,
    action: PaperAgentResultDecision["action"],
    idempotencyKey: string,
    signal?: AbortSignal,
  ) => Promise<PaperAgentResultCandidate>
}

export type PaperReaderDataPort = {
  loadRepresentations: (documentRevisionId: string, signal?: AbortSignal) => Promise<ReaderRepresentation[]>
  loadRepresentationState?: (
    documentRevisionId: string,
    signal?: AbortSignal,
  ) => Promise<PaperReaderRepresentationState>
  transformDocument?: (
    documentRevisionId: string,
    scope: string,
    signal?: AbortSignal,
    options?: { reprocess?: boolean },
  ) => Promise<DocumentTransformResult>
  representationContentUrl: (documentRevisionId: string, representation: ReaderRepresentation) => string
  listAnchors: (documentRevisionId: string, signal?: AbortSignal) => Promise<DurableDocumentAnchor[]>
  getAnchor: (documentRevisionId: string, anchorId: string, signal?: AbortSignal) => Promise<DurableDocumentAnchor>
  listMarks: (anchor: DurableDocumentAnchor, signal?: AbortSignal) => Promise<DocumentMarkList>
  createAnchor: (
    documentRevisionId: string,
    representationId: string,
    selector: DocumentAnchorSelector,
  ) => Promise<DurableDocumentAnchor>
}

type RepresentationListResponse = {
  schemaId: "gb.document.representations.v1"
  document_revision_id: string
  representations: ReaderRepresentation[]
  receipts: DurableTransformReceipt[]
  local_index?: DocumentLocalIndexStatus
}

export type PaperReaderRepresentationState = {
  representations: ReaderRepresentation[]
  receipts: DurableTransformReceipt[]
  localIndex?: DocumentLocalIndexStatus
}

type AnchorListResponse = {
  schemaId: "gb.anchor.list.v1"
  document_revision_id: string
  anchors: DurableDocumentAnchor[]
  next_cursor: string | null
}

async function jsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Galaxy Brain request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

export async function loadDurableDocumentRevision(
  documentRevisionId: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(
    `${GALAXY_API}/documents/${encodeURIComponent(documentRevisionId)}`,
    { cache: "no-store", signal },
  )
  const revision = await jsonResponse<DurableDocumentRevision>(response)
  if (
    revision.schemaId !== "gb.document-revision.v1"
    || revision.revision_id !== documentRevisionId.toLowerCase()
  ) {
    throw new Error("Galaxy Brain returned a different document revision.")
  }
  return revision
}

export function createGalaxyPaperReaderDataPort(fetcher: typeof fetch = fetch): PaperReaderDataPort {
  let transformClient: ReturnType<typeof createDocumentTransformClient> | null = null

  async function loadRepresentationState(
    documentRevisionId: string,
    signal?: AbortSignal,
  ): Promise<PaperReaderRepresentationState> {
    const response = await fetcher(
      `${GALAXY_API}/documents/${encodeURIComponent(documentRevisionId)}/representations`,
      { cache: "no-store", signal },
    )
    const payload = await jsonResponse<RepresentationListResponse>(response)
    if (
      payload.schemaId !== "gb.document.representations.v1"
      || typeof payload.document_revision_id !== "string"
      || payload.document_revision_id.toLowerCase() !== documentRevisionId.toLowerCase()
    ) {
      throw new Error("Galaxy Brain returned a different document revision.")
    }
    return {
      representations: Array.isArray(payload.representations) ? payload.representations : [],
      receipts: Array.isArray(payload.receipts) ? payload.receipts : [],
      localIndex: parseDocumentLocalIndexStatus(payload.local_index),
    }
  }

  return {
    async loadRepresentations(documentRevisionId, signal) {
      return (await loadRepresentationState(documentRevisionId, signal)).representations
    },
    loadRepresentationState,
    async transformDocument(documentRevisionId, scope, signal, options) {
      if (!transformClient) {
        if (typeof window === "undefined") {
          throw new Error("Document analysis is only available in the authenticated reader.")
        }
        transformClient = createDocumentTransformClient({ fetcher, storage: window.localStorage })
      }
      return transformClient.transform(documentRevisionId, {
        scope,
        signal,
        reprocess: options?.reprocess === true,
      })
    },
    representationContentUrl(documentRevisionId, representation) {
      return `${GALAXY_API}/documents/${encodeURIComponent(documentRevisionId)}/representations/${encodeURIComponent(representation.id)}/content`
    },
    async listAnchors(documentRevisionId, signal) {
      const response = await fetcher(
        `${GALAXY_API}/documents/${encodeURIComponent(documentRevisionId)}/anchors?limit=100`,
        { cache: "no-store", signal },
      )
      const payload = await jsonResponse<AnchorListResponse>(response)
      return Array.isArray(payload.anchors) ? payload.anchors : []
    },
    async getAnchor(documentRevisionId, anchorId, signal) {
      const response = await fetcher(
        `${GALAXY_API}/documents/${encodeURIComponent(documentRevisionId)}/anchors/${encodeURIComponent(anchorId)}`,
        { cache: "no-store", signal },
      )
      return jsonResponse<DurableDocumentAnchor>(response)
    },
    listMarks(anchor, signal) {
      return listDocumentMarks(anchor, { fetcher, signal })
    },
    async createAnchor(documentRevisionId, representationId, selector) {
      const response = await fetcher(
        `${GALAXY_API}/documents/${encodeURIComponent(documentRevisionId)}/anchors`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ representation_id: representationId, selector }),
        },
      )
      return jsonResponse<DurableDocumentAnchor>(response)
    },
  }
}

type AnchorBacklinksResponse = {
  schemaId: "gb.anchor-backlinks.v1"
  task_links: Array<{
    id: string
    relation?: string
    from_ref?: string
    to_ref?: string
    provenance?: { source_ref?: string }
  }>
}

type GalaxyObjectLink = {
  id: string
  from_ref: string
  to_ref: string
  relation: string
}

const PAPER_AGENT_RESULT_SCHEMA = "gb.paper-agent-result.v1"
const PAPER_AGENT_RESULT_HASH = /^sha256:[0-9a-f]{64}$/u
const PAPER_AGENT_RESULT_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,198}[A-Za-z0-9])?$/u
const PAPER_AGENT_RESULT_MAX_SUMMARY_CHARACTERS = 20_000
const PAPER_AGENT_RESULT_MAX_EVIDENCE_REFS = 50

function canonicalPinnedReference(value: unknown) {
  if (typeof value !== "string" || value.length < 1 || value.length > 500) return null
  const parsed = parseGalaxyObjectReference(value)
  if (parsed?.format !== "canonical" || parsed.selector.mode !== "pinned") return null
  try {
    return serializeGalaxyObjectReference(parsed) === value ? value : null
  } catch {
    return null
  }
}

function taskIdentityFromLink(link: AnchorBacklinksResponse["task_links"][number]) {
  const sourceRef = link.provenance?.source_ref
  if (typeof sourceRef !== "string") return null
  const source = parseGalaxyObjectReference(sourceRef)
  if (source?.format !== "canonical" || source.kind !== "ham.task" || source.selector.mode !== "pinned") {
    return null
  }
  try {
    if (serializeGalaxyObjectReference(source) !== sourceRef) return null
  } catch {
    return null
  }
  const revision = /^version:([1-9][0-9]{0,14})$/u.exec(source.selector.revision)
  const version = revision ? Number(revision[1]) : Number.NaN
  if (!Number.isSafeInteger(version)) return null
  const taskEndpoints = [link.from_ref, link.to_ref].flatMap((value) => {
    const parsed = parseGalaxyObjectReference(value)
    return parsed?.format === "canonical" && parsed.kind === "ham.task" ? [parsed] : []
  })
  if (taskEndpoints.length !== 1 || taskEndpoints[0].id !== source.id) return null
  return { taskId: source.id, createdTaskVersion: version }
}

function parsePaperAgentResult(
  value: unknown,
  expected: {
    taskId: string
    documentRevisionId?: string
    anchorId?: string
    taskVersion?: number
    eventId?: string
    resultHash?: string
    decisionAction?: PaperAgentResultDecision["action"]
  },
): PaperAgentResultCandidate {
  const envelope = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const wrapped = envelope.schemaId === "gb.paper-agent-result-review.v1"
  const nestedCandidate = wrapped
    && envelope.candidate
    && typeof envelope.candidate === "object"
    && !Array.isArray(envelope.candidate)
    ? envelope.candidate
    : null
  const candidate = nestedCandidate ?? envelope
  const source = candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : {}
  const rawEnvelopeDecision = wrapped ? envelope.decision : source.decision
  const sourceSchema = source.schemaId
  if (
    (!wrapped && sourceSchema !== PAPER_AGENT_RESULT_SCHEMA && sourceSchema !== "gb.paper-agent-result-candidate.v1")
    || (wrapped && nestedCandidate === null && expected.documentRevisionId !== undefined
      && source.documentRevisionId !== expected.documentRevisionId)
    || (wrapped && nestedCandidate === null && expected.anchorId !== undefined
      && source.anchorId !== expected.anchorId)
    || source.taskId !== expected.taskId
    || !Number.isSafeInteger(source.taskVersion)
    || Number(source.taskVersion) < 1
    || (expected.taskVersion !== undefined && source.taskVersion !== expected.taskVersion)
    || typeof source.eventId !== "string"
    || !PAPER_AGENT_RESULT_ID.test(source.eventId)
    || (expected.eventId !== undefined && source.eventId !== expected.eventId)
    || typeof source.resultHash !== "string"
    || !PAPER_AGENT_RESULT_HASH.test(source.resultHash)
    || (expected.resultHash !== undefined && source.resultHash !== expected.resultHash)
    || typeof source.summary !== "string"
    || source.summary.length < 1
    || source.summary.length > PAPER_AGENT_RESULT_MAX_SUMMARY_CHARACTERS
    || !Array.isArray(source.evidenceRefs)
    || source.evidenceRefs.length < 1
    || source.evidenceRefs.length > PAPER_AGENT_RESULT_MAX_EVIDENCE_REFS
  ) {
    throw new Error("Galaxy Brain returned an invalid agent result.")
  }
  const evidenceRefs: string[] = []
  for (const value of source.evidenceRefs) {
    const reference = canonicalPinnedReference(value)
    if (!reference) throw new Error("Galaxy Brain returned an invalid agent result citation.")
    if (evidenceRefs.includes(reference)) {
      throw new Error("Galaxy Brain returned duplicate agent result citations.")
    }
    evidenceRefs.push(reference)
  }
  const actorRef = source.actorRef === undefined
    ? source.performedByRef === undefined || source.performedByRef === null
      ? undefined
      : typeof source.performedByRef === "string"
        && source.performedByRef.length >= 1
        && source.performedByRef.length <= 500
        ? source.performedByRef
        : null
    : typeof source.actorRef === "string" && source.actorRef.length >= 1 && source.actorRef.length <= 500
      ? source.actorRef
      : null
  const runId = source.runId === undefined || source.runId === null
    ? undefined
    : typeof source.runId === "string" && PAPER_AGENT_RESULT_ID.test(source.runId)
      ? source.runId
      : null
  const occurredAt = source.occurredAt === undefined
    ? undefined
    : typeof source.occurredAt === "string" && source.occurredAt.length >= 1 && source.occurredAt.length <= 64
      ? source.occurredAt
      : null
  if (actorRef === null || runId === null || occurredAt === null) {
    throw new Error("Galaxy Brain returned invalid agent result provenance.")
  }
  const taskVersion = Number(source.taskVersion)
  let decision: PaperAgentResultDecision | undefined
  if (rawEnvelopeDecision !== undefined && rawEnvelopeDecision !== null) {
    const rawDecision = rawEnvelopeDecision && typeof rawEnvelopeDecision === "object" && !Array.isArray(rawEnvelopeDecision)
      ? rawEnvelopeDecision as Record<string, unknown>
      : {}
    if (rawDecision.action !== "accept" && rawDecision.action !== "reject") {
      throw new Error("Galaxy Brain returned an invalid agent result decision.")
    }
    if (expected.decisionAction && rawDecision.action !== expected.decisionAction) {
      throw new Error("Galaxy Brain acknowledged a different agent result decision.")
    }
    const acceptedDocumentRef = rawDecision.acceptedDocumentRef === undefined
      ? undefined
      : canonicalPinnedReference(rawDecision.acceptedDocumentRef)
    const parsedAcceptedDocumentRef = acceptedDocumentRef
      ? parseGalaxyObjectReference(acceptedDocumentRef)
      : null
    if (
      rawDecision.acceptedDocumentRef !== undefined
      && (!acceptedDocumentRef || parsedAcceptedDocumentRef?.kind !== "document")
    ) {
      throw new Error("Galaxy Brain returned an invalid accepted document reference.")
    }
    decision = {
      action: rawDecision.action,
      ...(acceptedDocumentRef ? { acceptedDocumentRef } : {}),
    }
  } else if (expected.decisionAction) {
    throw new Error("Galaxy Brain did not acknowledge the agent result decision.")
  }
  return {
    schemaId: PAPER_AGENT_RESULT_SCHEMA,
    taskId: source.taskId,
    taskVersion,
    eventId: source.eventId,
    ...(runId ? { runId } : {}),
    resultHash: source.resultHash,
    summary: source.summary,
    ...(actorRef ? { actorRef } : {}),
    ...(occurredAt ? { occurredAt } : {}),
    evidenceRefs,
    ...(decision ? { decision } : {}),
  }
}

async function fetchPaperAgentResult(
  anchor: DurableDocumentAnchor,
  backlink: PaperReaderBacklink,
  fetcher: typeof fetch,
  signal?: AbortSignal,
) {
  if (!backlink.taskId || !backlink.createdTaskVersion) return null
  const query = new URLSearchParams({
    documentRevisionId: anchor.document_revision_id,
    anchorId: anchor.id,
  })
  const response = await fetcher(
    `/api/paper-agent-results/${encodeURIComponent(backlink.taskId)}?${query}`,
    { cache: "no-store", signal },
  )
  if (response.status === 403 || response.status === 404 || response.status === 409) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  const payload = await jsonResponse<unknown>(response)
  return parsePaperAgentResult(payload, {
    taskId: backlink.taskId,
    documentRevisionId: anchor.document_revision_id,
    anchorId: anchor.id,
  })
}

export async function authorizePaperTaskReferences(
  anchorRef: string,
  resourceRefs: readonly string[],
  fetcher: typeof fetch = fetch,
) {
  const references = normalizePaperEnhanceReferences(anchorRef, resourceRefs)
  const hydrated = await hydrateAtlasObjectReferences(references, { fetcher })
  if (
    hydrated.results.length !== references.length
    || hydrated.results.some((result, index) => (
      result.status !== "resolved" || result.requestedRef !== references[index]
    ))
  ) {
    throw new Error("One or more selected references are unavailable.")
  }
  return references
}

export function createGalaxyPaperReaderActionPort(
  fetcher: typeof fetch = fetch,
  createTask?: PaperReaderActionPort["createTask"],
  markOptions?: {
    scope: DocumentMarkRecoveryScope
    storage?: () => DocumentMarkRecoveryStorage & Required<Pick<Storage, "key" | "length">>
    operationIdentity?: () => { idempotencyKey: string; requestedAt: string }
  },
): PaperReaderActionPort {
  const markStorage = () => {
    try {
      const storage = markOptions?.storage?.() ?? globalThis.localStorage
      if (!storage) throw new Error("missing storage")
      return storage
    } catch {
      throw new Error("Local recovery storage is unavailable. No document mark was sent.")
    }
  }
  const markActions: Pick<PaperReaderActionPort, "createMark" | "retryMark" | "listMarkRecoveries"> = markOptions ? {
    listMarkRecoveries() {
      return readDocumentMarkRecoveries(markStorage(), markOptions.scope).map((recovery) => recovery.intent)
    },
    async createMark(request) {
      const operation = markOptions.operationIdentity?.() ?? {
        idempotencyKey: globalThis.crypto?.randomUUID?.() ?? "",
        requestedAt: new Date().toISOString(),
      }
      const intent = prepareDocumentMarkCreateIntent({
        anchor: request.anchor as unknown as DocumentMarkAnchor,
        requestedAt: operation.requestedAt,
        kind: request.intent === "clip" ? "highlight" : "note",
        bodyMarkdown: request.body,
        color: request.intent === "clip" ? "#d7a34b" : "#3f6b57",
        semanticRole: request.intent === "clip" ? "evidence" : "note",
        tags: [],
        state: "active",
      }, { idempotencyKey: operation.idempotencyKey })
      return createDocumentMarkRecoverably(intent, {
        scope: markOptions.scope,
        storage: markStorage(),
        fetcher,
      })
    },
    retryMark(intent) {
      return createDocumentMarkRecoverably(intent, {
        scope: markOptions.scope,
        storage: markStorage(),
        fetcher,
      })
    },
  } : {}
  return {
    ...markActions,
    createTask,
    authorizeTaskRefs(anchorRef, resourceRefs) {
      return authorizePaperTaskReferences(anchorRef, resourceRefs, fetcher)
    },
    async listBacklinks(anchor) {
      const response = await fetcher(
        `${GALAXY_API}/documents/${encodeURIComponent(anchor.document_revision_id)}/anchors/${encodeURIComponent(anchor.id)}/backlinks`,
        { cache: "no-store" },
      )
      const payload = await jsonResponse<AnchorBacklinksResponse>(response)
      const tasks: PaperReaderBacklink[] = (payload.task_links ?? []).map((link) => {
        const task = taskIdentityFromLink(link)
        return {
          id: link.id,
          kind: "task",
          label: link.relation ? `HAM task · ${link.relation.replaceAll("_", " ")}` : "Linked HAM task",
          detail: link.to_ref ?? link.from_ref,
          href: paperTaskConstructorHrefFromLink(link),
          ...(task ?? {}),
        }
      })
      return tasks
    },
    async listAgentResults(anchor, backlinks, signal) {
      const exactBacklinks = new Map<string, PaperReaderBacklink>()
      for (const backlink of backlinks) {
        if (backlink.taskId && backlink.createdTaskVersion && !exactBacklinks.has(backlink.taskId)) {
          exactBacklinks.set(backlink.taskId, backlink)
        }
      }
      const settled = await Promise.allSettled(
        [...exactBacklinks.values()].map((backlink) => fetchPaperAgentResult(anchor, backlink, fetcher, signal)),
      )
      const fulfilled = settled.filter(
        (result): result is PromiseFulfilledResult<PaperAgentResultCandidate | null> => result.status === "fulfilled",
      )
      if (fulfilled.length === 0) {
        const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected")
        if (failure) throw failure.reason
      }
      return fulfilled
        .map((result) => result.value)
        .filter((result): result is PaperAgentResultCandidate => result !== null)
    },
    async decideAgentResult(anchor, candidate, action, idempotencyKey, signal) {
      const response = await fetcher(`/api/paper-agent-results/${encodeURIComponent(candidate.taskId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentRevisionId: anchor.document_revision_id,
          anchorId: anchor.id,
          taskVersion: candidate.taskVersion,
          eventId: candidate.eventId,
          resultHash: candidate.resultHash,
          action,
          idempotencyKey,
        }),
        cache: "no-store",
        signal,
      })
      return parsePaperAgentResult(await jsonResponse<unknown>(response), {
        taskId: candidate.taskId,
        documentRevisionId: anchor.document_revision_id,
        anchorId: anchor.id,
        taskVersion: candidate.taskVersion,
        eventId: candidate.eventId,
        resultHash: candidate.resultHash,
        decisionAction: action,
      })
    },
  }
}

const RECOVERY_PREFIX = "gb.paper-task-recovery.v1"

function recoveryPart(value: string, label: string) {
  const normalized = typeof value === "string" ? value.trim() : ""
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new Error(`${label} is invalid`)
  }
  return encodeURIComponent(normalized)
}

export function paperTaskRecoveryKey(
  tenantId: string,
  principalId: string,
  documentRevisionId: string,
  idempotencyKey: string,
) {
  return [
    RECOVERY_PREFIX,
    recoveryPart(tenantId, "Tenant"),
    recoveryPart(principalId, "Principal"),
    recoveryPart(documentRevisionId, "Document revision"),
    recoveryPart(idempotencyKey, "Operation"),
  ].join(":")
}

export function readPaperTaskRecoveries(
  storage: Pick<Storage, "length" | "key" | "getItem" | "removeItem">,
  tenantId: string,
  principalId: string,
  documentRevisionId: string,
): PaperReaderTaskRequest[] {
  const prefix = [
    RECOVERY_PREFIX,
    recoveryPart(tenantId, "Tenant"),
    recoveryPart(principalId, "Principal"),
    recoveryPart(documentRevisionId, "Document revision"),
    "",
  ].join(":")
  const items: PaperReaderTaskRequest[] = []
  const invalid: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key?.startsWith(prefix)) continue
    try {
      const value = normalizePaperTaskOperation(JSON.parse(storage.getItem(key) || "null"))
      items.push(value as PaperReaderTaskRequest)
    } catch {
      invalid.push(key)
    }
  }
  invalid.forEach((key) => storage.removeItem(key))
  return items.sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
}

export function createDurablePaperTaskAction(options: {
  tenantId: string
  principalId: string
  documentRevisionId: string
  fetcher?: typeof fetch
  taskCreator?: (input: CreateTaskInput, idempotencyKey: string) => Promise<unknown>
  storage?: () => Pick<Storage, "setItem" | "removeItem">
  referenceAuthorizer?: (anchorRef: string, resourceRefs: readonly string[]) => Promise<readonly string[]>
  taskPlanCreator?: (input: {
    ham_task_id: string
    title: string
    spec: TaskPlanSpec
    provenance?: Record<string, unknown>
    idempotency_key: string
  }) => Promise<TaskPlanRecord | null>
  runStarter?: (
    task: ReturnType<typeof paperAgentLoopTask>,
    plan: TaskPlanRecord,
    options: { idempotencyKey: string; fetcher?: typeof fetch },
  ) => Promise<TaskPlanRunReceipt>
}): NonNullable<PaperReaderActionPort["createTask"]> {
  const fetcher = options.fetcher ?? fetch
  const taskCreator = options.taskCreator ?? postHamTask
  const storage = options.storage ?? (() => window.localStorage)
  const referenceAuthorizer = options.referenceAuthorizer
    ?? ((anchorRef: string, resourceRefs: readonly string[]) => authorizePaperTaskReferences(anchorRef, resourceRefs, fetcher))
  const taskPlanCreator = options.taskPlanCreator ?? ((input) => galaxyBrainAPI.createTaskPlan(input))
  const runStarter = options.runStarter ?? startTaskPlanRun
  return async (request) => {
    const normalizedRequest = normalizePaperTaskOperation(request) as PaperReaderTaskRequest
    const startsAgentLoop = normalizedRequest.executionMode === "run"
    await referenceAuthorizer(normalizedRequest.anchor.ref, normalizedRequest.resourceRefs ?? [])
    const recoveryKey = paperTaskRecoveryKey(
      options.tenantId,
      options.principalId,
      options.documentRevisionId,
      normalizedRequest.idempotencyKey,
    )
    const result = await runPaperTaskSaga(normalizedRequest, {
      async createTask(input, idempotencyKey) {
        const task = await taskCreator(input, idempotencyKey) as Partial<PaperTaskCheckpoint>
        if (
          typeof task?.id !== "string" || !task.id
          || typeof task.title !== "string" || !task.title
          || !Number.isSafeInteger(task.version) || Number(task.version) < 1
        ) {
          throw new Error("HAM created a task without an exact positive version; the link was not written.")
        }
        return { id: task.id, title: task.title, version: Number(task.version) }
      },
      async createLink(input) {
        const response = await fetcher(`${GALAXY_API}/object-links`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from_ref: input.anchorRef,
            to_ref: input.taskRef,
            relation: "context_for",
            basis: "authored",
            provenance: {
              source: "manual",
              source_system: "galaxy-document-reader",
              source_ref: input.createdTaskRef,
            },
            idempotency_key: input.idempotencyKey,
          }),
        })
        return jsonResponse<GalaxyObjectLink>(response)
      },
      writeRecovery(operation: PaperTaskSagaOperation) {
        storage().setItem(recoveryKey, JSON.stringify(operation))
      },
      clearRecovery() {
        if (!startsAgentLoop) storage().removeItem(recoveryKey)
      },
    })
    let runReceipt: TaskPlanRunReceipt | null = null
    if (startsAgentLoop) {
      const task = paperAgentLoopTask(result.operation)
      const keys = paperAgentLoopKeys(result.operation.idempotencyKey)
      const plan = await taskPlanCreator({
        ham_task_id: task.id,
        title: createTaskPlanTitle(task.title),
        spec: createStarterTaskPlan(task),
        provenance: {
          source: "galaxy-paper-enhance-agent-loop",
          ham_refs: [task.id],
          document_anchor_ref: result.operation.anchor.ref,
        },
        idempotency_key: keys.planIdempotencyKey,
      })
      if (!plan) throw new Error("The agent loop could not save its exact task plan. The request remains available to retry.")
      runReceipt = await runStarter(task, plan, {
        idempotencyKey: keys.runIdempotencyKey,
        fetcher,
      })
      storage().removeItem(recoveryKey)
    }
    const link = result.link as GalaxyObjectLink
    return {
      id: link.id,
      kind: "task",
      label: result.operation.task?.title ?? result.operation.title,
      detail: runReceipt ? `Hyades run ${runReceipt.runId}` : result.taskRef,
      href: paperTaskConstructorHref(result.operation.task!),
      status: runReceipt ? runReceipt.state : "linked",
      taskId: result.operation.task!.id,
      createdTaskVersion: result.operation.task!.version,
      ...(runReceipt ? { runId: runReceipt.runId } : {}),
    }
  }
}
