import type {
  CreateDatasourceConnectionInput,
  DatasourceConnection,
  DatasourceImportResponse,
  DatasourceItemsResponse,
  DatasourcePluginManifest,
  DatasourceSyncResponse,
  UpdateDatasourceConnectionInput,
} from "./types/datasources"
import type { CreateShareBundleInput, LegacyShareSnapshot, ShareBundle } from "./types/sharing"
import type { ArxivSearchResult, ClaimEvidenceLink, GalaxyPaper, GalaxyPaperDetail, ImportedGalaxyPaper, PaperAnnotation, PaperAnnotationAnchor, PaperClaim, PaperDocument, PaperTaskLink } from "./types/papers"
import type { GalaxySurfaceContractManifest, GalaxySurfaceRecord, GalaxySurfaceRevision, ResolvedGalaxySurface, SurfaceStatus } from "./types/surfaces"
import type { TaskPlanRecord, TaskPlanRevision, TaskPlanSpec } from "./types/task-plans"
import { canvasChangeEventFromRevision } from "./canvas/canvas-snapshot.js"
import type { CanvasChangeEvent, CanvasEnvelope, CanvasMutationInput, CanvasProjectionMode, CanvasRecord, CanvasRevision } from "./types/canvas"
import {
  MAX_IMPORT_FILE_BYTES,
  IngestionContractError,
  prepareDurableDocumentImport,
  validateDurableDocumentImport,
  type DurableDocumentImport,
  type DurableDocumentImportMetadata,
} from "./durable-document-import.js"
import {
  resolveIngestionPlanDefinition,
  verifyIngestionPlanDefinition,
} from "./plugins/ingestion-plans.js"
import {
  MAX_DATASOURCE_CONTENT_REQUEST_BYTES,
  datasourceContentRequestBody,
} from "./datasource-durable-import.js"
import {
  createDocumentCorpusSearchRequest,
  readDocumentCorpusSearchResponse,
  type DocumentCorpusSearchResponse,
} from "./document-corpus-search.js"
import { parseGalaxyObjectReference, serializeGalaxyObjectReference } from "./galaxy-object-reference.js"

export type ConfirmedDocumentImport = {
  document: Readonly<DurableDocumentImport>
  placementOperationId: string
}

export type DatasourceExactContent = {
  bytes: ArrayBuffer
  contentSha256: string
  mediaType: string
}

// Galaxy Brain API service — connects to the ELN backend at port 8044.
// Browser requests go through the authenticated Next.js proxy so the backend
// receives a trusted per-user scope.

const GALAXY_API = "/api/eln"

export class GalaxyBrainAPIError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = "GalaxyBrainAPIError"
  }
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Experiment {
  id: string
  tenant_id: string
  created_by_principal_id?: string
  /** Legacy provenance retained during the tenant migration. */
  user_id?: string
  title: string
  status: "hypothesis" | "running" | "complete" | "abandoned"
  hypothesis: string
  protocol: string
  config_snapshot: Record<string, any>
  wandb_run_id?: string
  wandb_project?: string
  local_run_path?: string
  results: string
  interpretation: string
  conclusion: string
  domain: string
  tags: string[]
  linked_experiments: string[]
  /** Legacy output-only references retained without reinterpretation. */
  readonly linked_papers: string[]
  attachment_refs?: ExperimentAttachmentRef[]
  attachment_count?: number
  observation_refs?: ExperimentObservationRef[]
  observation_count?: number
  ham_node_id?: string
  created_at: string
  updated_at: string
  metrics?: ExperimentMetric[]
}

export interface ExperimentAttachmentRef {
  schemaId: "gb.eln-attachment-ref.v1"
  ref: string
  attachmentId: string
  documentRevisionId: string
  title: string
  displayFilename: string
  mediaType: string
  revisionSha256: string
  contentSha256: string
  createdAt: string
}

export interface ExperimentAttachmentReceipt {
  schemaId: "gb.eln-attachment-create-receipt.v1"
  experimentId: string
  requestSha256: string
  attachment: ExperimentAttachmentRef
  replayed: boolean
  deduplicated: boolean
}

export interface ExperimentObservationRef {
  schemaId: "gb.eln-observation-ref.v1"
  id: string
  experimentId: string
  ref: string
  version: number
  revisionSha256: string
  body: string
  observedAt: string
  createdAt: string
  createdByPrincipalId: string
}

export interface ExperimentObservationReceipt {
  schemaId: "gb.eln-observation-create-receipt.v1"
  experimentId: string
  requestSha256: string
  replayed: boolean
  observation: ExperimentObservationRef
}

export interface CreateExperimentObservationInput {
  body: string
  observedAt?: string
}

export interface ExperimentMetric {
  id?: number
  experiment_id: string
  name: string
  value: number
  step?: number
  timestamp: string
  source: "wandb" | "local" | "manual"
}

export interface AddMetricInput {
  name: string
  value: number
  step?: number
  source?: "wandb" | "local" | "manual"
}

export interface NodeRevisionRecord {
  id: string
  node_id: string
  version: number
  timestamp: string
  source: string
  summary: string
  changed_fields: string[]
  snapshot_json: Record<string, any>
  created_at?: string
}

export interface Hypothesis {
  id: string
  tenant_id: string
  created_by_principal_id?: string
  /** Legacy provenance retained during the tenant migration. */
  user_id?: string
  claim: string
  status: "open" | "confirmed" | "refuted" | "superseded"
  confidence: number
  domain: string
  supporting_experiments: string[]
  refuting_experiments: string[]
  superseded_by?: string
  ham_node_id?: string
  created_at: string
  updated_at: string
}

export type CreateExperimentInput = Pick<Experiment, "title"> &
  Partial<Omit<Experiment, "id" | "tenant_id" | "created_by_principal_id" | "user_id" | "created_at" | "updated_at" | "linked_papers" | "attachment_refs" | "attachment_count" | "observation_refs" | "observation_count" | "metrics">>

export type UpdateExperimentInput = Partial<Omit<Experiment,
  "id" | "tenant_id" | "created_by_principal_id" | "user_id" | "created_at" | "updated_at"
  | "linked_papers" | "attachment_refs" | "attachment_count" | "observation_refs" | "observation_count" | "metrics">>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const OBSERVATION_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uD800-\uDFFF]/u
const RFC3339_TIMESTAMP = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/u
const UTC_MICROSECOND_TIMESTAMP = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{6}Z$/u

function validRfc3339CalendarDate(value: string): boolean {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})/u.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
}

function normalizedObservationBody(value: string): string {
  const body = value.trim()
  if (!body || Array.from(body).length > 4000 || OBSERVATION_CONTROL.test(body)) {
    throw new GalaxyBrainAPIError("Observation body must be 1 to 4000 Unicode characters", 422)
  }
  return body
}

function normalizedObservationTime(value?: string): string | null {
  if (value === undefined) return null
  const date = new Date(value)
  const normalized = Number.isFinite(date.getTime()) ? date.toISOString() : ""
  if (!RFC3339_TIMESTAMP.test(value)
    || !validRfc3339CalendarDate(value)
    || !/^\d{4}-/u.test(normalized)
    || normalized.startsWith("0000-")) {
    throw new GalaxyBrainAPIError("Observation time must be an RFC 3339 timestamp with an offset", 422)
  }
  return normalized.replace(/\.([0-9]{3})Z$/u, ".$1000Z")
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function validatedObservationRef(value: unknown, experimentId: string): ExperimentObservationRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GalaxyBrainAPIError("Invalid observation receipt", 502)
  }
  const item = value as Record<string, unknown>
  const keys = Object.keys(item).sort()
  const expected = ["body", "createdAt", "createdByPrincipalId", "experimentId", "id", "observedAt", "ref", "revisionSha256", "schemaId", "version"].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new GalaxyBrainAPIError("Invalid observation receipt", 502)
  }
  const parsed = parseGalaxyObjectReference(item.ref)
  if (
    item.schemaId !== "gb.eln-observation-ref.v1"
    || typeof item.id !== "string" || !UUID.test(item.id)
    || item.experimentId !== experimentId
    || typeof item.revisionSha256 !== "string" || !SHA256.test(item.revisionSha256)
    || item.version !== 1
    || typeof item.body !== "string" || normalizedObservationBody(item.body) !== item.body
    || typeof item.observedAt !== "string" || !UTC_MICROSECOND_TIMESTAMP.test(item.observedAt)
    || !validRfc3339CalendarDate(item.observedAt) || !Number.isFinite(new Date(item.observedAt).getTime())
    || typeof item.createdAt !== "string" || !Number.isFinite(new Date(item.createdAt).getTime())
    || typeof item.createdByPrincipalId !== "string" || !UUID.test(item.createdByPrincipalId)
    || !parsed || parsed.format !== "canonical" || parsed.kind !== "eln.observation"
    || parsed.id !== item.id || parsed.selector.mode !== "pinned"
    || parsed.selector.revision !== `sha256:${item.revisionSha256}`
    || serializeGalaxyObjectReference(parsed) !== item.ref
  ) throw new GalaxyBrainAPIError("Invalid observation receipt", 502)
  return item as unknown as ExperimentObservationRef
}

export type CreateHypothesisInput = Pick<Hypothesis, "claim"> &
  Partial<Omit<Hypothesis, "id" | "tenant_id" | "created_by_principal_id" | "user_id" | "created_at" | "updated_at">>

// ── Service class ──────────────────────────────────────────────────────────────

class GalaxyBrainAPIService {
  private async gbFetch(path: string, options?: RequestInit, throwOnError = false): Promise<any> {
    const res = await fetch(`${GALAXY_API}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...options?.headers },
    })
    if (!res.ok) {
      let detail = ""
      try {
        const payload = await res.json()
        detail = typeof payload?.detail === "string" ? payload.detail : typeof payload?.error === "string" ? payload.error : ""
      } catch {
        // The status line remains useful when an upstream returns a non-JSON error.
      }
      const message = detail || `Galaxy Brain API error: ${res.status} ${res.statusText}`
      if (throwOnError) throw new GalaxyBrainAPIError(message, res.status)
      console.error(message)
      return null
    }
    return res.json()
  }

  // ── Experiments ────────────────────────────────────────────────────────────

  async getExperiments(filters?: { status?: string; domain?: string }): Promise<Experiment[]> {
    const params = new URLSearchParams()
    if (filters?.status) params.set("status", filters.status)
    if (filters?.domain) params.set("domain", filters.domain)
    const query = params.toString() ? `?${params.toString()}` : ""
    const result = await this.gbFetch(`/experiments${query}`)
    return result ?? []
  }

  async createExperiment(data: CreateExperimentInput, idempotencyKey: string): Promise<Experiment | null> {
    if (!/^[!-~]{8,200}$/.test(idempotencyKey)) {
      throw new GalaxyBrainAPIError("Invalid experiment idempotency key", 422)
    }
    return this.gbFetch("/experiments", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(data),
    }, true)
  }

  async getExperiment(id: string): Promise<Experiment | null> {
    return this.gbFetch(`/experiments/${id}`, undefined, true)
  }

  async updateExperiment(id: string, data: UpdateExperimentInput): Promise<Experiment | null> {
    return this.gbFetch(`/experiments/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    })
  }

  async attachExperimentDocument(
    experimentId: string,
    documentRef: string,
    idempotencyKey: string,
  ): Promise<ExperimentAttachmentReceipt> {
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
      throw new GalaxyBrainAPIError("Invalid attachment idempotency key", 422)
    }
    return this.gbFetch(`/experiments/${encodeURIComponent(experimentId)}/attachments`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        schemaId: "gb.eln-attachment-create.v1",
        documentRef,
      }),
    }, true)
  }

  async getExperimentObservations(experimentId: string): Promise<ExperimentObservationRef[]> {
    const result = await this.gbFetch(`/experiments/${encodeURIComponent(experimentId)}/observations`, undefined, true)
    if (
      !result || result.schemaId !== "gb.eln-observation-list.v1"
      || result.experimentId !== experimentId || !Array.isArray(result.observations)
      || result.observations.length > 256
    ) throw new GalaxyBrainAPIError("Invalid observation list", 502)
    return result.observations.map((item: unknown) => validatedObservationRef(item, experimentId))
  }

  async createExperimentObservation(
    experimentId: string,
    input: CreateExperimentObservationInput,
    idempotencyKey: string,
  ): Promise<ExperimentObservationReceipt> {
    if (!/^eln-observation:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(idempotencyKey)) {
      throw new GalaxyBrainAPIError("Invalid observation idempotency key", 422)
    }
    const body = normalizedObservationBody(input.body)
    const observedAt = normalizedObservationTime(input.observedAt)
    const request = { body, experimentId, observedAt, schemaId: "gb.eln-observation-create.v1" as const }
    const requestSha256 = await sha256Hex(JSON.stringify(request))
    const payload = await this.gbFetch(`/experiments/${encodeURIComponent(experimentId)}/observations`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ schemaId: request.schemaId, body, observedAt }),
    }, true)
    if (
      !payload || typeof payload !== "object" || Array.isArray(payload)
      || Object.keys(payload).sort().join("\u0000") !== ["experimentId", "observation", "replayed", "requestSha256", "schemaId"].sort().join("\u0000")
      || payload.schemaId !== "gb.eln-observation-create-receipt.v1"
      || payload.experimentId !== experimentId
      || payload.requestSha256 !== requestSha256
      || typeof payload.replayed !== "boolean"
    ) throw new GalaxyBrainAPIError("Invalid observation receipt", 502)
    const observation = validatedObservationRef(payload.observation, experimentId)
    const revisionSha256 = await sha256Hex(JSON.stringify({ body, observedAt: observation.observedAt }))
    if (observation.body !== body
      || observation.revisionSha256 !== revisionSha256
      || (observedAt !== null && observation.observedAt !== observedAt)) {
      throw new GalaxyBrainAPIError("Observation receipt does not match the submitted content", 502)
    }
    return { ...payload, observation } as ExperimentObservationReceipt
  }

  async deleteExperiment(id: string): Promise<boolean> {
    const result = await this.gbFetch(`/experiments/${id}`, { method: "DELETE" })
    return result !== null
  }

  async addMetrics(experimentId: string, metrics: AddMetricInput[]): Promise<{ added: number }> {
    return this.gbFetch(`/experiments/${experimentId}/metrics`, {
      method: "POST",
      body: JSON.stringify(metrics),
    }, true)
  }

  // ── Hypotheses ─────────────────────────────────────────────────────────────

  async getHypotheses(filters?: { status?: string; domain?: string }): Promise<Hypothesis[]> {
    const params = new URLSearchParams()
    if (filters?.status) params.set("status", filters.status)
    if (filters?.domain) params.set("domain", filters.domain)
    const query = params.toString() ? `?${params.toString()}` : ""
    const result = await this.gbFetch(`/hypotheses${query}`)
    return result ?? []
  }

  async createHypothesis(data: CreateHypothesisInput): Promise<Hypothesis | null> {
    return this.gbFetch("/hypotheses", {
      method: "POST",
      body: JSON.stringify(data),
    })
  }

  async updateHypothesis(id: string, data: Partial<Hypothesis>): Promise<Hypothesis | null> {
    return this.gbFetch(`/hypotheses/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    })
  }

  async deleteHypothesis(id: string): Promise<boolean> {
    const result = await this.gbFetch(`/hypotheses/${id}`, { method: "DELETE" })
    return result !== null
  }

  // ── Research papers ──────────────────────────────────────────────────────

  async searchArxiv(query: string, limit = 10, signal?: AbortSignal): Promise<ArxivSearchResult> {
    const params = new URLSearchParams({ q: query, limit: String(limit) })
    const timeoutController = new AbortController()
    const timeout = window.setTimeout(() => timeoutController.abort(), 22_000)
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal
    try {
      return await this.gbFetch(`/papers/search?${params}`, { signal: requestSignal }, true)
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError" && timeoutController.signal.aborted && !signal?.aborted) {
        throw new GalaxyBrainAPIError("arXiv did not answer within 22 seconds. Try again in a moment.", 504)
      }
      throw error
    } finally {
      window.clearTimeout(timeout)
    }
  }

  async getPapers(limit = 100): Promise<GalaxyPaper[]> {
    const result = await this.gbFetch(`/papers?limit=${encodeURIComponent(String(limit))}`)
    return Array.isArray(result) ? result : []
  }

  async importArxivPaper(arxivId: string, signal?: AbortSignal): Promise<ImportedGalaxyPaper | null> {
    return this.gbFetch("/papers/import", { method: "POST", body: JSON.stringify({ arxiv_id: arxivId }), signal })
  }

  async getPaper(id: string, signal?: AbortSignal): Promise<GalaxyPaperDetail | null> {
    return this.gbFetch(`/papers/${encodeURIComponent(id)}`, { signal })
  }

  async storePaperDocument(id: string, revisionId: string, pdf: Blob): Promise<PaperDocument> {
    return this.gbFetch(
      `/papers/${encodeURIComponent(id)}/document?revision_id=${encodeURIComponent(revisionId)}`,
      { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: pdf },
      true,
    )
  }

  async fetchPaperDocument(id: string, revisionId: string, signal?: AbortSignal): Promise<PaperDocument> {
    return this.gbFetch(
      `/papers/${encodeURIComponent(id)}/document/fetch?revision_id=${encodeURIComponent(revisionId)}`,
      { method: "POST", signal },
      true,
    )
  }

  async bridgePaperDocument(id: string, revisionId: string): Promise<PaperDocument> {
    return this.gbFetch(
      `/papers/${encodeURIComponent(id)}/document/bridge?revision_id=${encodeURIComponent(revisionId)}`,
      { method: "POST" },
      true,
    )
  }

  async importDocument(
    file: File,
    metadata: DurableDocumentImportMetadata,
    signal?: AbortSignal,
  ): Promise<ConfirmedDocumentImport> {
    if (!(file instanceof File) || file.size < 1 || file.size > MAX_IMPORT_FILE_BYTES) {
      throw new GalaxyBrainAPIError("Choose a non-empty file no larger than 100 MB.", 422)
    }
    if (!file.name || file.name.length > 512) {
      throw new GalaxyBrainAPIError("The selected file name is too long.", 422)
    }
    let expectedIngestionPlan
    if (metadata.ingestionPlan !== undefined) {
      const registered = resolveIngestionPlanDefinition(metadata.ingestionPlan.id)
      if (
        !registered
        || registered.version !== metadata.ingestionPlan.version
        || registered.contentSha256 !== metadata.ingestionPlan.contentSha256
      ) {
        throw new GalaxyBrainAPIError("The selected ingestion plan is no longer available.", 422)
      }
      expectedIngestionPlan = await verifyIngestionPlanDefinition(registered).catch(() => {
        throw new GalaxyBrainAPIError("The selected ingestion plan is invalid.", 422)
      })
    }
    const prepared = await prepareDurableDocumentImport(file, metadata).catch((error) => {
      if (error instanceof IngestionContractError && /DOCX file no larger than 25 MiB/u.test(error.message)) {
        throw new GalaxyBrainAPIError("Choose a DOCX file no larger than 25 MiB.", 413)
      }
      if (error instanceof IngestionContractError && /PDF|DOCX|UTF-8|text, code|source file/u.test(error.message)) {
        throw new GalaxyBrainAPIError("Choose a valid PDF, non-macro DOCX, or UTF-8 text file.", 415)
      }
      throw new GalaxyBrainAPIError("Check the selected file and import metadata.", 422)
    })
    const result = await this.gbFetch("/documents/import", {
      method: "POST",
      headers: {
        "Content-Type": prepared.mediaType,
        "Idempotency-Key": prepared.idempotencyKey,
        "X-GB-Import-Metadata": prepared.metadataHeader,
      },
      body: prepared.bytes,
      signal,
    }, true)
    try {
      return {
        document: validateDurableDocumentImport(
          result,
          expectedIngestionPlan ? { ingestionPlan: expectedIngestionPlan } : undefined,
        ),
        placementOperationId: prepared.placementOperationId,
      }
    } catch {
      throw new GalaxyBrainAPIError("The document was stored, but its confirmation was invalid. Retry safely.", 502)
    }
  }

  async searchDocumentCorpus(input: {
    query: string
    limit?: number
    signal?: AbortSignal
  }): Promise<DocumentCorpusSearchResponse> {
    const request = createDocumentCorpusSearchRequest({ query: input.query, limit: input.limit })
    const parameters = new URLSearchParams({ q: request.query, limit: String(request.limit) })
    const response = await fetch(`${GALAXY_API}/documents/search?${parameters.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: input.signal,
    })
    if (!response.ok) {
      throw new GalaxyBrainAPIError("Document corpus search is unavailable.", response.status)
    }
    try {
      return await readDocumentCorpusSearchResponse(response, request)
    } catch (error) {
      if (error instanceof GalaxyBrainAPIError) throw error
      throw new GalaxyBrainAPIError("Document corpus search returned an invalid response.", 502)
    }
  }

  async createPaperAnnotation(id: string, input: {
    paper_revision_id: string
    kind: PaperAnnotation["kind"]
    page_number: number
    anchor: PaperAnnotationAnchor
    body?: string
    color?: string
    lens?: PaperAnnotation["lens"]
    semantic_role?: PaperAnnotation["semantic_role"]
    tags?: string[]
    idempotency_key: string
  }): Promise<PaperAnnotation | null> {
    return this.gbFetch(`/papers/${encodeURIComponent(id)}/annotations`, { method: "POST", body: JSON.stringify(input) })
  }

  async createPaperClaim(id: string, input: {
    source_annotation_id?: string
    statement: string
    status?: PaperClaim["status"]
    tags?: string[]
    idempotency_key: string
  }): Promise<PaperClaim | null> {
    return this.gbFetch(`/papers/${encodeURIComponent(id)}/claims`, { method: "POST", body: JSON.stringify(input) })
  }

  async linkClaimEvidence(id: string, claimId: string, annotationId: string, relation: ClaimEvidenceLink["relation"]): Promise<ClaimEvidenceLink | null> {
    return this.gbFetch(`/papers/${encodeURIComponent(id)}/claims/${encodeURIComponent(claimId)}/evidence`, {
      method: "POST", body: JSON.stringify({ annotation_id: annotationId, relation }),
    })
  }

  async createPaperTaskLink(id: string, input: {
    ham_task_id: string
    parent_ham_task_id?: string
    relation: PaperTaskLink["relation"]
    title_snapshot: string
    annotation_id?: string
    claim_id?: string
  }): Promise<PaperTaskLink | null> {
    return this.gbFetch(`/papers/${encodeURIComponent(id)}/task-links`, { method: "POST", body: JSON.stringify(input) })
  }

  // —— Datasources ————————————————————————————————————————————————————————————————

  async getDatasourcePlugins(): Promise<DatasourcePluginManifest[]> {
    const result = await this.gbFetch("/datasources/plugins", undefined, true)
    return result ?? []
  }

  async getDatasourceConnections(filters?: { plugin_id?: string; status?: string }): Promise<DatasourceConnection[]> {
    const params = new URLSearchParams()
    if (filters?.plugin_id) params.set("plugin_id", filters.plugin_id)
    if (filters?.status) params.set("status", filters.status)
    const query = params.toString() ? `?${params.toString()}` : ""
    const result = await this.gbFetch(`/datasources/connections${query}`, undefined, true)
    return result ?? []
  }

  async createDatasourceConnection(data: CreateDatasourceConnectionInput): Promise<DatasourceConnection | null> {
    return this.gbFetch("/datasources/connections", {
      method: "POST",
      body: JSON.stringify(data),
    }, true)
  }

  async updateDatasourceConnection(id: string, data: UpdateDatasourceConnectionInput): Promise<DatasourceConnection | null> {
    return this.gbFetch(`/datasources/connections/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }, true)
  }

  async syncDatasourceConnection(id: string): Promise<DatasourceSyncResponse | null> {
    return this.gbFetch(`/datasources/${id}/sync`, {
      method: "POST",
    }, true)
  }

  async getDatasourceItems(id: string, limit = 200): Promise<DatasourceItemsResponse | null> {
    return this.gbFetch(`/datasources/${id}/items?limit=${encodeURIComponent(String(limit))}`, undefined, true)
  }

  async importDatasourceItems(id: string, itemIds: string[]): Promise<DatasourceImportResponse | null> {
    return this.gbFetch(`/datasources/${id}/import`, {
      method: "POST",
      body: JSON.stringify({ item_ids: itemIds }),
    }, true)
  }

  async getDatasourceItemContent(id: string, itemId: string): Promise<DatasourceExactContent> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
      throw new GalaxyBrainAPIError("Choose a valid datasource connection.", 422)
    }
    if (typeof itemId !== "string" || itemId.length < 1 || Array.from(itemId).length > 2_048) {
      throw new GalaxyBrainAPIError("Choose a valid datasource item.", 422)
    }
    const body = datasourceContentRequestBody(itemId)
    if (new TextEncoder().encode(body).byteLength > MAX_DATASOURCE_CONTENT_REQUEST_BYTES) {
      throw new GalaxyBrainAPIError("Choose a datasource item with a bounded identity.", 422)
    }
    const response = await fetch(`${GALAXY_API}/datasources/${encodeURIComponent(id)}/content`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    })
    if (!response.ok) {
      throw new GalaxyBrainAPIError("The exact datasource file could not be read.", response.status)
    }
    const expectedHash = response.headers.get("X-Content-SHA256") || ""
    const declaredLength = Number(response.headers.get("Content-Length") || 0)
    if (!/^[0-9a-f]{64}$/u.test(expectedHash)) {
      throw new GalaxyBrainAPIError("The datasource file confirmation was invalid.", 502)
    }
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMPORT_FILE_BYTES) {
      throw new GalaxyBrainAPIError("The datasource file exceeds the 100 MB import limit.", 413)
    }
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_IMPORT_FILE_BYTES) {
      throw new GalaxyBrainAPIError("The datasource returned an invalid file size.", 502)
    }
    const actualHash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("")
    if (actualHash !== expectedHash) {
      throw new GalaxyBrainAPIError("The datasource file changed while it was being read.", 409)
    }
    return {
      bytes,
      contentSha256: actualHash,
      mediaType: (response.headers.get("Content-Type") || "application/octet-stream").split(";", 1)[0].trim(),
    }
  }

  // —— Sharing ————————————————————————————————————————————————————————————————

  async getNodeRevisions(nodeId: string, limit = 100): Promise<NodeRevisionRecord[]> {
    const result = await this.gbFetch(`/node-revisions/${nodeId}?limit=${encodeURIComponent(String(limit))}`)
    return result ?? []
  }

  async upsertNodeRevisions(revisions: Omit<NodeRevisionRecord, "created_at">[]): Promise<number> {
    const result = await this.gbFetch("/node-revisions/bulk", {
      method: "POST",
      body: JSON.stringify(revisions),
    })
    return typeof result?.upserted === "number" ? result.upserted : 0
  }

  async createShareBundle(data: CreateShareBundleInput): Promise<ShareBundle | null> {
    return this.gbFetch("/share-bundles", {
      method: "POST",
      body: JSON.stringify(data),
    })
  }

  async getShareBundle(id: string): Promise<ShareBundle | null> {
    return this.gbFetch(`/share-bundles/${id}`)
  }

  async getLegacyShareSnapshot(id: string): Promise<LegacyShareSnapshot | null> {
    return this.gbFetch(`/share-snapshots/${id}`)
  }

  // —— Durable canvas placements ——————————————————————————————————————————

  async getCanvases(workspaceId?: string): Promise<CanvasRecord[]> {
    const params = new URLSearchParams({ limit: "50" })
    if (workspaceId) params.set("workspace_id", workspaceId)
    const result = await this.gbFetch(`/canvases?${params.toString()}`, undefined, true)
    if (!Array.isArray(result)) throw new GalaxyBrainAPIError("Canvas catalog returned an invalid response", 502)
    return result
  }

  async createCanvas(input: {
    workspaceId: string
    slug?: string
    title: string
    makeDefault?: boolean
    projectionMode?: CanvasProjectionMode
    idempotencyKey: string
  }): Promise<CanvasEnvelope> {
    return this.gbFetch("/canvases", {
      method: "POST",
      body: JSON.stringify(input),
    }, true)
  }

  async getCanvas(id: string): Promise<CanvasEnvelope> {
    return this.gbFetch(`/canvases/${encodeURIComponent(id)}`, undefined, true)
  }

  async mutateCanvas(id: string, input: CanvasMutationInput): Promise<CanvasEnvelope> {
    return this.gbFetch(`/canvases/${encodeURIComponent(id)}/mutations`, {
      method: "POST",
      body: JSON.stringify(input),
    }, true)
  }

  async getCanvasRevisions(id: string, limit = 50, signal?: AbortSignal): Promise<CanvasRevision[]> {
    const result = await this.gbFetch(
      `/canvases/${encodeURIComponent(id)}/revisions?limit=${encodeURIComponent(String(limit))}`,
      { signal },
      true,
    )
    return Array.isArray(result) ? result : []
  }

  async getLatestCanvasChange(id: string, signal?: AbortSignal): Promise<CanvasChangeEvent | null> {
    const [revision] = await this.getCanvasRevisions(id, 1, signal)
    return revision ? canvasChangeEventFromRevision(id, revision) : null
  }

  // —— Bounded generative surfaces —————————————————————————————————————————

  async getSurfaceContract(): Promise<GalaxySurfaceContractManifest | null> {
    return this.gbFetch("/surfaces/contract")
  }

  async getSurfaces(filters?: { status?: SurfaceStatus; query?: string; limit?: number }): Promise<GalaxySurfaceRecord[] | null> {
    const params = new URLSearchParams()
    if (filters?.status) params.set("status", filters.status)
    if (filters?.query) params.set("q", filters.query)
    params.set("limit", String(filters?.limit ?? 100))
    const result = await this.gbFetch(`/surfaces?${params.toString()}`)
    return result === null ? null : Array.isArray(result) ? result : []
  }

  async getSurface(id: string): Promise<GalaxySurfaceRecord | null> {
    return this.gbFetch(`/surfaces/${encodeURIComponent(id)}`)
  }

  async getSurfaceRevisions(id: string, limit = 100): Promise<GalaxySurfaceRevision[] | null> {
    const result = await this.gbFetch(
      `/surfaces/${encodeURIComponent(id)}/revisions?limit=${encodeURIComponent(String(limit))}`,
    )
    return result === null ? null : Array.isArray(result) ? result : []
  }

  async getSurfaceRevision(id: string, version: number): Promise<GalaxySurfaceRevision | null> {
    const params = new URLSearchParams({ version: String(version), limit: "1" })
    const result = await this.gbFetch(
      `/surfaces/${encodeURIComponent(id)}/revisions?${params.toString()}`,
    )
    return Array.isArray(result) ? result[0] ?? null : null
  }

  async promoteSurface(id: string, input: {
    baseVersion: number
    baseContentHash: string
    provenance?: Record<string, unknown>
    idempotencyKey: string
  }): Promise<GalaxySurfaceRecord | null> {
    return this.gbFetch(`/surfaces/${encodeURIComponent(id)}/promote`, {
      method: "POST",
      body: JSON.stringify({
        base_version: input.baseVersion,
        base_content_hash: input.baseContentHash,
        provenance: input.provenance ?? {},
        idempotency_key: input.idempotencyKey,
      }),
    }, true)
  }

  async resolveSurface(id: string, version?: number, signal?: AbortSignal): Promise<ResolvedGalaxySurface | null> {
    const query = version === undefined ? "" : `?version=${encodeURIComponent(String(version))}`
    return this.gbFetch(`/surfaces/${encodeURIComponent(id)}/resolve${query}`, { signal })
  }

  // —— Versioned task construction plans ————————————————————————————————

  async getTaskPlanForHamTask(taskId: string): Promise<TaskPlanRecord | null> {
    const params = new URLSearchParams({ ham_task_id: taskId, limit: "1" })
    const result = await this.gbFetch(`/task-plans?${params.toString()}`, undefined, true)
    return Array.isArray(result) ? result[0] ?? null : null
  }

  async createTaskPlan(input: {
    ham_task_id: string
    title: string
    spec: TaskPlanSpec
    provenance?: Record<string, unknown>
    idempotency_key: string
  }): Promise<TaskPlanRecord | null> {
    return this.gbFetch("/task-plans", { method: "POST", body: JSON.stringify(input) }, true)
  }

  async updateTaskPlan(id: string, input: {
    base_version: number
    base_content_hash?: string
    title?: string
    spec: TaskPlanSpec
    provenance?: Record<string, unknown>
    idempotency_key: string
  }): Promise<TaskPlanRecord | null> {
    return this.gbFetch(`/task-plans/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }, true)
  }

  async getTaskPlanRevisions(id: string, limit = 100): Promise<TaskPlanRevision[]> {
    const result = await this.gbFetch(
      `/task-plans/${encodeURIComponent(id)}/revisions?limit=${encodeURIComponent(String(limit))}`,
      undefined,
      true,
    )
    return Array.isArray(result) ? result : []
  }
}

export const galaxyBrainAPI = new GalaxyBrainAPIService()

export async function searchDocumentCorpus(input: {
  query: string
  limit?: number
  signal?: AbortSignal
}): Promise<DocumentCorpusSearchResponse> {
  return galaxyBrainAPI.searchDocumentCorpus(input)
}
