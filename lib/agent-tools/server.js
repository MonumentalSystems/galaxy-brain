import { createHash } from "node:crypto"

import { AgentToolContractError, MAX_AGENT_TOOL_RESPONSE_BYTES } from "./contracts.js"
import { buildAuthorizedProofGraphSource } from "../authorized-proof-graph-source.js"
import { hashCanvasSnapshot, normalizeCanvasSnapshot } from "../canvas/canvas-snapshot.js"
import { canonicalAnchorJson } from "../document-anchor.js"
import {
  DOCUMENT_CORPUS_SEARCH_MAX_RESPONSE_BYTES,
  parseDocumentCorpusSearchResponse,
} from "../document-corpus-search.js"
import { createGalaxyObjectReference } from "../galaxy-object-reference.js"
import { createGraphWindowRequest, parseGraphWindowResponse } from "../graph-window-contract.js"
import { searchHamMemoriesForAgent } from "./ham-memory-search.js"
import {
  assembleObjectProjectionResolutionResponse,
  createObjectProjectionSourceRequest,
  parseObjectProjectionSourceResponse,
} from "../object-projection-resolution.js"
import { resolveObjectProjectionSources } from "../object-projection-gateway.js"
import { parseProofDag, parseProofWorkState, projectProofTaskGraph } from "../proof-task-graph.js"
import { projectSurface } from "../surface-projection.js"
import {
  normalizeTaskPlanProposalProvider,
  normalizeTaskPlanProviderRecord,
} from "../task-plan-agent-contract.js"

const INTERNAL_RESPONSE_MAXIMUM = 16 * 1024 * 1024
const ACTIVE_GRAPH_KINDS = new Set(["campaign", "mission"])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/u
const SHA256 = /^[0-9a-f]{64}$/u

function providerError(code = "provider_unavailable", message = "Agent tool provider is unavailable", status = 503) {
  throw new AgentToolContractError(code, message, status)
}

function configuredOrigin(value) {
  if (typeof value !== "string" || !value) return null
  try {
    const url = new URL(value)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
    url.pathname = url.pathname.replace(/\/+$/, "")
    return url
  } catch {
    return null
  }
}

function childUrl(base, path) {
  const url = new URL(base)
  const separator = path.indexOf("?")
  const pathname = separator === -1 ? path : path.slice(0, separator)
  const search = separator === -1 ? "" : path.slice(separator + 1)
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`
  url.search = search
  return url
}

function privateHeaders(identity, environment) {
  const proxyToken = environment.GALAXY_API_PROXY_TOKEN
  if (typeof proxyToken !== "string" || !proxyToken) providerError()
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${proxyToken}`,
    "X-GB-Proxy-Token": proxyToken,
    "X-GB-Tenant-ID": identity.tenantId,
    "X-GB-Principal-ID": identity.principalId,
    "X-GB-Principal-Kind": identity.kind,
    "X-GB-Agent-Tool-Gateway": "v1",
  })
  if (identity.nostrPubkey) headers.set("X-GB-Nostr-Pubkey", identity.nostrPubkey)
  return headers
}

async function boundedBytes(response, maximum = INTERNAL_RESPONSE_MAXIMUM) {
  const declared = Number(response.headers.get("content-length") || 0)
  if (Number.isFinite(declared) && declared > maximum) {
    await response.body?.cancel().catch(() => undefined)
    providerError("provider_response_too_large", "Agent tool provider response is too large", 502)
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximum) {
        await reader.cancel().catch(() => undefined)
        providerError("provider_response_too_large", "Agent tool provider response is too large", 502)
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof AgentToolContractError) throw error
    providerError()
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function parseJsonBytes(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return JSON.parse(text)
  } catch {
    providerError("invalid_provider_response", "Agent tool provider returned an invalid response", 502)
  }
}

async function galaxyFetch(path, context, maximum = INTERNAL_RESPONSE_MAXIMUM) {
  const environment = context.environment || process.env
  const base = configuredOrigin(environment.GALAXY_API_INTERNAL || "http://localhost:8044")
  if (!base) providerError()
  let response
  try {
    response = await (context.fetchImpl || fetch)(childUrl(base, path), {
      method: "GET",
      headers: privateHeaders(context.identity, environment),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    })
  } catch {
    providerError()
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined)
    providerError("not_found", "Requested object is not available", 404)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    providerError()
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  if (mediaType !== "application/json") {
    await response.body?.cancel().catch(() => undefined)
    providerError("invalid_provider_response", "Agent tool provider returned an invalid response", 502)
  }
  return boundedBytes(response, maximum)
}

async function galaxyPostJson(
  path,
  value,
  context,
  maximum = INTERNAL_RESPONSE_MAXIMUM,
  messages = {},
) {
  const environment = context.environment || process.env
  const base = configuredOrigin(environment.GALAXY_API_INTERNAL || "http://localhost:8044")
  if (!base) providerError()
  const body = JSON.stringify(value)
  const headers = privateHeaders(context.identity, environment)
  headers.set("Content-Type", "application/json")
  let response
  try {
    response = await (context.fetchImpl || fetch)(childUrl(base, path), {
      method: "POST",
      headers,
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    })
  } catch {
    providerError()
  }
  if (!response.ok) {
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined)
      providerError("not_found", messages.notFound || "Requested canvas is not available", 404)
    }
    if (response.status === 409) {
      let code = null
      try {
        const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
        if (mediaType === "application/json") {
          const payload = parseJsonBytes(await boundedBytes(response, 4_096))
          code = payload?.detail?.code
        } else {
          await response.body?.cancel().catch(() => undefined)
        }
      } catch (error) {
        if (error instanceof AgentToolContractError && error.code === "provider_response_too_large") throw error
      }
      if (code === "stale_canvas") {
        throw new AgentToolContractError("stale_canvas", "Canvas changed; reload before retrying", 409)
      }
      if (code === "idempotency_key_reused") {
        throw new AgentToolContractError(
          "idempotency_key_reused",
          messages.idempotencyKeyReused
            || "Idempotency key was already used for a different canvas operation; use a new key",
          409,
        )
      }
      if (code === "stale_task_plan" && messages.staleTaskPlan) {
        throw new AgentToolContractError("stale_task_plan", messages.staleTaskPlan, 409)
      }
      if (code === "anchor_hash_collision") {
        throw new AgentToolContractError(
          "conflict", messages.hashCollision || "Anchor identity conflicted with stored content", 409,
        )
      }
      throw new AgentToolContractError(
        "conflict", messages.conflict || "Canvas mutation conflicted with current state", 409,
      )
    }
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 422) {
      throw new AgentToolContractError(
        messages.invalidCode || "invalid_mutation",
        messages.invalid || "Canvas arrangement could not be applied",
        422,
      )
    }
    if (response.status === 401 || response.status === 403) {
      throw new AgentToolContractError(
        "forbidden", messages.forbidden || "Canvas arrangement is not authorized", 403,
      )
    }
    providerError()
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  if (mediaType !== "application/json") {
    await response.body?.cancel().catch(() => undefined)
    providerError("invalid_provider_response", "Agent tool provider returned an invalid response", 502)
  }
  return parseJsonBytes(await boundedBytes(response, maximum))
}

function sha256Canonical(value) {
  return createHash("sha256").update(canonicalAnchorJson(value)).digest("hex")
}

function anchorCreateRequest(input) {
  return Object.freeze({
    schemaId: "gb.agent-anchor-create.v1",
    documentRef: input.documentRef,
    representation: input.representation,
    selector: input.selector,
  })
}

function normalizeAnchorCreationReceipt(value, input) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    providerError("invalid_provider_response", "Anchor provider returned an invalid receipt", 502)
  }
  const allowed = new Set([
    "schemaId", "documentRef", "anchorId", "anchorRef", "representationId",
    "representationSha256", "selectorSha256", "anchorSha256", "requestHash", "replayed",
  ])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    providerError("invalid_provider_response", "Anchor provider returned an invalid receipt", 502)
  }
  const expectedRequestHash = sha256Canonical(anchorCreateRequest(input))
  const expectedSelectorSha256 = sha256Canonical(input.selector)
  const expectedAnchorSha256 = sha256Canonical({
    representationId: input.representation.id,
    representationSha256: input.representation.contentSha256,
    selector: input.selector,
  })
  const expectedAnchorId = `sha256:${expectedAnchorSha256}`
  const expectedAnchorRef = createGalaxyObjectReference("document.anchor", expectedAnchorId, {
    mode: "pinned", revision: `sha256:${input.representation.contentSha256}`,
  })
  if (value.schemaId !== "gb.anchor.create-receipt.v1"
    || value.documentRef !== input.documentRef
    || value.anchorId !== expectedAnchorId
    || value.anchorRef !== expectedAnchorRef
    || value.representationId !== input.representation.id
    || value.representationSha256 !== input.representation.contentSha256
    || value.selectorSha256 !== expectedSelectorSha256
    || value.anchorSha256 !== expectedAnchorSha256
    || value.requestHash !== expectedRequestHash
    || typeof value.replayed !== "boolean") {
    providerError("invalid_provider_response", "Anchor provider receipt does not match the request", 502)
  }
  return Object.freeze({
    schemaId: value.schemaId,
    documentRef: value.documentRef,
    anchorId: value.anchorId,
    anchorRef: value.anchorRef,
    representationId: value.representationId,
    representationSha256: value.representationSha256,
    selectorSha256: value.selectorSha256,
    anchorSha256: value.anchorSha256,
    requestHash: value.requestHash,
    replayed: value.replayed,
  })
}

async function anchorsCreate(input, context) {
  let receipt
  try {
    receipt = normalizeAnchorCreationReceipt(await galaxyPostJson(
      "/agent-anchor-creations",
      input,
      context,
      8_192,
      {
        notFound: "Requested document representation is not available",
        idempotencyKeyReused: "Idempotency key was already used for a different anchor operation; use a new key",
        hashCollision: "Anchor identity conflicted with stored content",
        conflict: "Anchor creation conflicted with stored state",
        invalidCode: "invalid_anchor",
        invalid: "Document anchor could not be created",
        forbidden: "Document anchor creation is not authorized",
      },
    ), input)
  } catch (error) {
    if (error instanceof AgentToolContractError) throw error
    providerError("invalid_provider_response", "Anchor provider returned an invalid response", 502)
  }
  return { result: receipt }
}

function normalizeRelationProposalReceipt(value, input) {
  if (!value || typeof value !== "object" || Array.isArray(value)) providerError("invalid_provider_response", "Relation proposal provider returned an invalid response", 502)
  const keys = new Set(["schemaId", "proposalId", "fromRef", "toRef", "relation", "status", "requestHash", "replayed", "createdAt"])
  if (Object.keys(value).some((key) => !keys.has(key)) || Object.keys(value).length !== keys.size
    || value.schemaId !== "gb.relation-proposal-receipt.v1" || !UUID.test(value.proposalId)
    || value.fromRef !== input.fromRef || value.toRef !== input.toRef || value.relation !== input.relation
    || value.status !== "pending" || typeof value.replayed !== "boolean"
    || typeof value.createdAt !== "string" || value.createdAt.length > 64 || !Number.isFinite(Date.parse(value.createdAt))) {
    providerError("invalid_provider_response", "Relation proposal provider returned an invalid response", 502)
  }
  const expected = createHash("sha256").update(JSON.stringify(recursivelySortedJson(input))).digest("hex")
  if (value.requestHash !== expected) providerError("invalid_provider_response", "Relation proposal receipt did not match its request", 502)
  return Object.freeze(value)
}

async function relationsPropose(input, context) {
  let receipt
  try {
    receipt = normalizeRelationProposalReceipt(await galaxyPostJson(
      "/relation-proposals", input, context, 8_192,
    ), input)
  } catch (error) {
    if (error instanceof AgentToolContractError) throw error
    providerError("invalid_provider_response", "Relation proposal provider returned an invalid response", 502)
  }
  return { result: receipt }
}

function surfaceDraftDefinitionMatches(value, input, expectedProvenance) {
  if (value.title !== input.title || value.status !== "draft") return false
  const projected = projectSurface(value.spec)
  const expectedSpec = JSON.stringify(recursivelySortedJson(input.spec))
  let actualSpec
  try {
    actualSpec = JSON.stringify(recursivelySortedJson(value.spec))
  } catch {
    actualSpec = null
  }
  const provenance = value.provenance
  const provenanceMatches = provenance && typeof provenance === "object" && !Array.isArray(provenance)
    && provenance.source === expectedProvenance.source
    && JSON.stringify(provenance.evidence_refs) === JSON.stringify(expectedProvenance.evidence_refs)
    && (expectedProvenance.actor_ref === undefined
      ? provenance.actor_ref === undefined
      : provenance.actor_ref === expectedProvenance.actor_ref)
  return projected.ok && actualSpec === expectedSpec && provenanceMatches
}

function surfaceDraftReceipt(surfaceId, version, digest, replayed) {
  const contentHash = `sha256:${digest}`
  return Object.freeze({
    surfaceRef: createGalaxyObjectReference("surface", surfaceId, {
      mode: "pinned",
      revision: contentHash,
    }),
    surfaceId,
    status: "draft",
    version,
    contentHash,
    replayed,
    reviewUrl: `/surfaces?${new URLSearchParams({
      surface: surfaceId,
      version: String(version),
      hash: digest,
    }).toString()}`,
  })
}

function normalizeSurfaceCreationResponse(value, input, identity, expectedProvenance) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    providerError("invalid_provider_response", "Surface provider returned an invalid response", 502)
  }
  if (typeof value.id !== "string" || !UUID.test(value.id)
    || value.tenant_id !== identity.tenantId
    || value.title !== input.title
    || value.status !== "draft"
    || value.schema_version !== "gb.surface.v1"
    || value.catalog_id !== "generous.a2ui"
    || value.catalog_version !== "1"
    || value.current_version !== 1
    || typeof value.current_content_hash !== "string" || !SHA256.test(value.current_content_hash)
    || value.creation_idempotency_key !== input.idempotencyKey
    || value.replayed !== undefined) {
    providerError("invalid_provider_response", "Surface provider response did not match the draft request", 502)
  }
  if (!surfaceDraftDefinitionMatches({
    title: value.title,
    status: value.status,
    spec: value.current_spec,
    provenance: value.provenance,
  }, input, expectedProvenance)) {
    providerError("invalid_provider_response", "Surface provider returned an unsafe or mismatched definition", 502)
  }
  return surfaceDraftReceipt(value.id, 1, value.current_content_hash, false)
}

function normalizeSurfaceReplayHead(value, input, identity) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.id !== "string" || !UUID.test(value.id)
    || value.tenant_id !== identity.tenantId
    || !["draft", "promoted", "archived"].includes(value.status)
    || value.schema_version !== "gb.surface.v1"
    || value.catalog_id !== "generous.a2ui"
    || value.catalog_version !== "1"
    || !Number.isSafeInteger(value.current_version) || value.current_version < 1
    || typeof value.current_content_hash !== "string" || !SHA256.test(value.current_content_hash)
    || value.creation_idempotency_key !== input.idempotencyKey
    || value.replayed !== true
    || !value.replayed_revision || typeof value.replayed_revision !== "object"
    || Array.isArray(value.replayed_revision)) {
    providerError("invalid_provider_response", "Surface provider replay did not identify the requested draft", 502)
  }
  return Object.freeze({ surfaceId: value.id, revision: value.replayed_revision })
}

function normalizeSurfaceCreationRevision(value, surfaceId, input, identity, expectedProvenance) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.surface_id !== surfaceId
    || value.tenant_id !== identity.tenantId
    || value.version !== 1
    || typeof value.content_hash !== "string" || !SHA256.test(value.content_hash)
    || value.idempotency_key !== input.idempotencyKey
    || typeof value.request_hash !== "string" || !SHA256.test(value.request_hash)
    || !surfaceDraftDefinitionMatches(value, input, expectedProvenance)) {
    providerError("invalid_provider_response", "Surface provider did not return the exact creation revision", 502)
  }
  return surfaceDraftReceipt(surfaceId, value.version, value.content_hash, true)
}

async function surfaceDraftCreate(input, context) {
  const actorRef = typeof context.identity.nostrPubkey === "string"
    && /^[0-9a-f]{64}$/u.test(context.identity.nostrPubkey)
    ? `nostr:${context.identity.nostrPubkey}`
    : undefined
  const provenance = Object.freeze({
    source: "agent-tool:surface.draft.create",
    evidence_refs: input.evidenceRefs,
    ...(actorRef === undefined ? {} : { actor_ref: actorRef }),
  })
  // Provenance may name only exact objects this tenant can resolve now. The
  // reference remains non-authoritative metadata, but it cannot smuggle an
  // inaccessible cross-tenant identity into a durable draft.
  await resolveProjections(input.evidenceRefs, context)
  let value
  try {
    value = await galaxyPostJson(
      "/surfaces",
      {
        title: input.title,
        spec: input.spec,
        provenance,
        idempotency_key: input.idempotencyKey,
      },
      context,
      // A replay can carry both the bounded mutable head and the exact
      // immutable creation receipt. The tool returns only the small receipt.
      768 * 1024,
      {
        idempotencyKeyReused: "Idempotency key was already used for a different surface draft; use a new key",
        conflict: "Surface draft conflicted with stored state",
        invalidCode: "invalid_surface_draft",
        invalid: "Surface draft could not be created",
        forbidden: "Surface draft creation is not authorized",
      },
    )
  } catch (error) {
    if (error instanceof AgentToolContractError) throw error
    providerError("invalid_provider_response", "Surface provider returned an invalid response", 502)
  }
  let draft
  if (value?.replayed === true) {
    const replay = normalizeSurfaceReplayHead(value, input, context.identity)
    draft = normalizeSurfaceCreationRevision(
      replay.revision, replay.surfaceId, input, context.identity, provenance,
    )
  } else {
    draft = normalizeSurfaceCreationResponse(value, input, context.identity, provenance)
  }
  return { result: draft }
}

function pageOffset(cursor, pattern, expected, label) {
  if (cursor === null) return 0
  const match = pattern.exec(cursor)
  if (!match || match[1] !== expected) {
    throw new AgentToolContractError("invalid_cursor", `${label} does not belong to this result`, 409)
  }
  const offset = Number(match[2])
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new AgentToolContractError("invalid_cursor", `${label} is invalid`, 400)
  }
  return offset
}

function pagination(nextOffset, total, limit, cursorForOffset) {
  const hasMore = nextOffset < total
  return Object.freeze({
    cursor: hasMore ? cursorForOffset(nextOffset) : null,
    hasMore,
    limit,
  })
}

async function resolveProjections(references, context) {
  const request = Object.freeze({
    schemaId: "gb.object-projection-resolution-request.v1",
    references: Object.freeze([...references]),
  })
  const sourceRequest = createObjectProjectionSourceRequest(request)
  let sourceResponse
  try {
    sourceResponse = parseObjectProjectionSourceResponse(
      await resolveObjectProjectionSources(
        sourceRequest.references,
        context.identity,
        context.environment || process.env,
        context.fetchImpl || fetch,
      ),
      sourceRequest,
    )
  } catch (error) {
    if (error instanceof AgentToolContractError) throw error
    providerError()
  }
  let response
  try {
    response = assembleObjectProjectionResolutionResponse(request, sourceResponse)
  } catch {
    providerError("invalid_provider_response", "Object projection provider returned an invalid response", 502)
  }
  if (response.results.some((item) => item.status !== "resolved")) {
    providerError("not_found", "Requested object is not available", 404)
  }
  return Object.freeze(response.results.map((item) => item.projection))
}

async function resolveProjection(reference, context) {
  return (await resolveProjections([reference], context))[0]
}

async function objectsGet(input, context) {
  const projection = await resolveProjection(input.ref, context)
  const { representations, ...object } = projection
  return {
    result: Object.freeze({
      object: Object.freeze(object),
      representationCount: representations.length,
    }),
  }
}

async function objectRepresentations(input, context) {
  const projection = await resolveProjection(input.ref, context)
  const cursorKey = createHash("sha256").update(JSON.stringify({
    ref: projection.ref,
    revision: projection.revision,
    provenance: projection.provenance,
    representations: projection.representations,
  })).digest("hex")
  const offset = pageOffset(input.cursor, /^gbr2:([a-f0-9]{64}):(\d+)$/u, cursorKey, "Representation cursor")
  if (offset > projection.representations.length) {
    throw new AgentToolContractError("invalid_cursor", "Representation cursor is out of range", 409)
  }
  const representations = projection.representations.slice(offset, offset + input.limit)
  const nextOffset = offset + representations.length
  return {
    result: Object.freeze({
      objectRef: projection.ref,
      revision: projection.revision,
      representations,
    }),
    pagination: pagination(nextOffset, projection.representations.length, input.limit, (next) => `gbr2:${cursorKey}:${next}`),
  }
}

async function objectsSearch(input, context) {
  const parameters = new URLSearchParams({ q: input.query, limit: String(input.limit) })
  let search
  try {
    search = parseDocumentCorpusSearchResponse(
      parseJsonBytes(await galaxyFetch(
        `/documents/search?${parameters.toString()}`,
        context,
        DOCUMENT_CORPUS_SEARCH_MAX_RESPONSE_BYTES,
      )),
      input,
    )
  } catch (error) {
    if (error instanceof AgentToolContractError) throw error
    providerError("invalid_provider_response", "Document search provider returned an invalid response", 502)
  }
  return { result: search }
}

async function graphWindowGet(input, context) {
  const request = createGraphWindowRequest({
    rootRef: input.rootRef,
    viewport: input.viewport,
    kinds: input.filters?.kinds,
    relations: input.filters?.relations,
    expandClusterId: input.expandClusterId,
    cursor: input.cursor,
  })
  const environment = context.environment || process.env
  const base = configuredOrigin(environment.GALAXY_API_INTERNAL || "http://localhost:8044")
  if (!base) providerError()
  const headers = privateHeaders(context.identity, environment)
  headers.set("Content-Type", "application/json")
  headers.set("X-GB-Graph-Window-Gateway", "v1")
  let response
  try {
    response = await (context.fetchImpl || fetch)(childUrl(base, "/graph/window"), {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    })
  } catch {
    providerError()
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined)
    providerError("not_found", "Requested graph window is not available", 404)
  }
  if (response.status === 409 || (response.status === 422 && request.cursor !== null)) {
    await response.body?.cancel().catch(() => undefined)
    throw new AgentToolContractError(
      "invalid_cursor",
      "Graph window cursor is stale or does not belong to this request; restart the replace-page read",
      409,
    )
  }
  if (response.status === 422) {
    await response.body?.cancel().catch(() => undefined)
    throw new AgentToolContractError(
      "invalid_request",
      "Graph window request cannot be served; reload the graph window and try again",
      422,
    )
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401 || response.status === 403) {
      throw new AgentToolContractError("forbidden", "Graph window is not authorized", 403)
    }
    providerError()
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  if (mediaType !== "application/json") {
    await response.body?.cancel().catch(() => undefined)
    providerError("invalid_provider_response", "Graph window provider returned an invalid response", 502)
  }
  const value = parseJsonBytes(await boundedBytes(response, MAX_AGENT_TOOL_RESPONSE_BYTES))
  let window
  try {
    window = parseGraphWindowResponse(value, {
      rootRef: request.rootRef,
      viewport: request.viewport,
      kinds: request.filters.kinds,
      relations: request.filters.relations,
      expandClusterId: request.expandClusterId,
      cursor: request.cursor,
    })
  } catch {
    providerError("invalid_provider_response", "Graph window provider returned an invalid response", 502)
  }
  return { result: window }
}

function normalizeCanvasEnvelope(value, expectedCanvasId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) providerError("invalid_provider_response", "Canvas provider returned an invalid response", 502)
  const allowed = new Set([
    "canvasId", "workspaceId", "slug", "title", "isDefault", "version", "contentHash", "content",
    "mutationId", "replayed",
  ])
  if (Object.keys(value).some((key) => !allowed.has(key))) providerError("invalid_provider_response", "Canvas provider returned an invalid response", 502)
  if (value.canvasId !== expectedCanvasId || !UUID.test(value.canvasId)) providerError("invalid_provider_response", "Canvas identity did not match the request", 502)
  if (typeof value.workspaceId !== "string" || !value.workspaceId || value.workspaceId.length > 512) providerError("invalid_provider_response", "Canvas workspace identity is invalid", 502)
  if (typeof value.slug !== "string" || !value.slug || value.slug.length > 120) providerError("invalid_provider_response", "Canvas slug is invalid", 502)
  if (typeof value.title !== "string" || !value.title || value.title.length > 240) providerError("invalid_provider_response", "Canvas title is invalid", 502)
  if (typeof value.isDefault !== "boolean" || !Number.isSafeInteger(value.version) || value.version < 1) providerError("invalid_provider_response", "Canvas version is invalid", 502)
  if (typeof value.contentHash !== "string" || !CONTENT_HASH.test(value.contentHash)) providerError("invalid_provider_response", "Canvas content hash is invalid", 502)
  if (value.mutationId !== undefined && (typeof value.mutationId !== "string" || !UUID.test(value.mutationId))) {
    providerError("invalid_provider_response", "Canvas mutation identity is invalid", 502)
  }
  if (value.replayed !== undefined && value.replayed !== true) {
    providerError("invalid_provider_response", "Canvas replay marker is invalid", 502)
  }
  return Object.freeze({
    canvasId: value.canvasId,
    workspaceId: value.workspaceId,
    slug: value.slug,
    title: value.title,
    isDefault: value.isDefault,
    version: value.version,
    contentHash: value.contentHash,
    content: Object.freeze(normalizeCanvasSnapshot(value.content)),
    ...(value.mutationId === undefined ? {} : { mutationId: value.mutationId }),
    ...(value.replayed === undefined ? {} : { replayed: true }),
  })
}

function recursivelySortedJson(value) {
  if (Array.isArray(value)) return value.map(recursivelySortedJson)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, recursivelySortedJson(value[key])]))
  }
  return value
}

function canvasMutationRequestHash(value) {
  return createHash("sha256").update(JSON.stringify(recursivelySortedJson(value))).digest("hex")
}

function normalizeCanvasMutationReceipt(value, expectedCanvasId, expectedVersion, expectedRequestHash) {
  if (!value || typeof value !== "object" || Array.isArray(value)) providerError("invalid_provider_response", "Canvas provider returned an invalid mutation receipt", 502)
  const allowed = new Set(["schemaId", "canvasId", "version", "contentHash", "mutationId", "requestHash", "replayed"])
  if (Object.keys(value).some((key) => !allowed.has(key))) providerError("invalid_provider_response", "Canvas provider returned an invalid mutation receipt", 502)
  if (value.schemaId !== "gb.canvas.mutation-receipt.v1") providerError("invalid_provider_response", "Canvas mutation receipt schema is invalid", 502)
  if (value.canvasId !== expectedCanvasId || !UUID.test(value.canvasId)) providerError("invalid_provider_response", "Canvas identity did not match the request", 502)
  if (!Number.isSafeInteger(value.version) || value.version !== expectedVersion + 1) providerError("invalid_provider_response", "Canvas mutation receipt version is invalid", 502)
  if (typeof value.contentHash !== "string" || !CONTENT_HASH.test(value.contentHash)) providerError("invalid_provider_response", "Canvas content hash is invalid", 502)
  if (typeof value.mutationId !== "string" || !UUID.test(value.mutationId)) providerError("invalid_provider_response", "Canvas mutation identity is invalid", 502)
  if (typeof value.requestHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.requestHash) || value.requestHash !== expectedRequestHash) {
    providerError("invalid_provider_response", "Canvas mutation receipt does not match the submitted operation", 502)
  }
  if (typeof value.replayed !== "boolean") providerError("invalid_provider_response", "Canvas replay marker is invalid", 502)
  return Object.freeze({
    schemaId: value.schemaId,
    canvasId: value.canvasId,
    version: value.version,
    contentHash: value.contentHash,
    mutationId: value.mutationId,
    requestHash: value.requestHash,
    replayed: value.replayed,
  })
}

async function canvasGet(input, context) {
  let envelope
  try {
    envelope = normalizeCanvasEnvelope(
      parseJsonBytes(await galaxyFetch(`/canvases/${encodeURIComponent(input.canvasId)}`, context, 8 * 1024 * 1024)),
      input.canvasId,
    )
  } catch (error) {
    if (error instanceof AgentToolContractError) throw error
    providerError("invalid_provider_response", "Canvas provider returned an invalid response", 502)
  }
  if (await hashCanvasSnapshot(envelope.content) !== envelope.contentHash) {
    providerError("invalid_provider_response", "Canvas content hash verification failed", 502)
  }
  const entries = [
    ...(envelope.content.frames ?? []).map((frame) => Object.freeze({ entryType: "frame", frame })),
    ...envelope.content.items.map((item) => Object.freeze({ entryType: "item", item })),
    ...envelope.content.edges.map((edge) => Object.freeze({ entryType: "edge", edge })),
    ...envelope.content.removedItemIds.map((id) => Object.freeze({ entryType: "removed-item", id })),
    ...envelope.content.removedEdgeIds.map((id) => Object.freeze({ entryType: "removed-edge", id })),
  ]
  const cursorKey = envelope.contentHash.slice("sha256:".length)
  const offset = pageOffset(input.cursor, /^gbc1:([a-f0-9]{64}):(\d+)$/u, cursorKey, "Canvas cursor")
  if (offset > entries.length) throw new AgentToolContractError("invalid_cursor", "Canvas cursor is out of range", 409)
  const page = entries.slice(offset, offset + input.limit)
  const nextOffset = offset + page.length
  const { content, ...canvas } = envelope
  return {
    result: Object.freeze({
      canvas,
      snapshotPage: Object.freeze({ schemaId: "gb.canvas.snapshot-page.v1", entries: Object.freeze(page) }),
    }),
    pagination: pagination(nextOffset, entries.length, input.limit, (next) => `gbc1:${cursorKey}:${next}`),
  }
}

async function canvasArrange(input, context) {
  const placedReferences = [...new Set(input.commands.flatMap((command) => (
    command.type === "item.place" ? [command.item.subjectRef] : []
  )))]
  if (placedReferences.length > 0) await resolveProjections(placedReferences, context)
  const mutationRequest = {
    expectedVersion: input.expectedVersion,
    expectedContentHash: input.expectedContentHash,
    commands: input.commands,
  }
  const requestHash = canvasMutationRequestHash(mutationRequest)
  let receipt
  try {
    receipt = normalizeCanvasMutationReceipt(await galaxyPostJson(
      `/canvases/${encodeURIComponent(input.canvasId)}/mutations?response=receipt`,
      {
        ...mutationRequest,
        idempotencyKey: input.idempotencyKey,
      },
      context,
      4_096,
    ), input.canvasId, input.expectedVersion, requestHash)
  } catch (error) {
    if (error instanceof AgentToolContractError) throw error
    providerError("invalid_provider_response", "Canvas provider returned an invalid response", 502)
  }
  return {
    result: Object.freeze({
      canvasId: receipt.canvasId,
      version: receipt.version,
      contentHash: receipt.contentHash,
      mutationId: receipt.mutationId,
      replayed: receipt.replayed,
      appliedCommandCount: input.commands.length,
    }),
  }
}

async function taskPlanGet(input, context) {
  let taskPlan
  try {
    const path = input.taskPlanId !== null
      ? `/task-plans/${encodeURIComponent(input.taskPlanId)}`
      : `/task-plans?ham_task_id=${encodeURIComponent(input.hamTaskId)}&limit=1`
    let raw = parseJsonBytes(await galaxyFetch(path, context, 600_000))
    if (input.taskPlanId === null) {
      if (!Array.isArray(raw)) providerError("invalid_provider_response", "Task plan provider returned an invalid response", 502)
      if (raw.length === 0) providerError("not_found", "Requested task plan is not available", 404)
      if (raw.length !== 1) providerError("invalid_provider_response", "Task plan provider returned an invalid response", 502)
      raw = raw[0]
    }
    taskPlan = normalizeTaskPlanProviderRecord(
      raw,
      input.taskPlanId,
      context.identity.tenantId,
    )
    if (input.hamTaskId !== null && taskPlan.hamTaskId !== input.hamTaskId) {
      providerError("invalid_provider_response", "Task plan provider HAM task identity did not match the request", 502)
    }
  } catch (error) {
    if (error instanceof AgentToolContractError) throw error
    providerError("invalid_provider_response", "Task plan provider returned an invalid response", 502)
  }
  return { result: Object.freeze({ taskPlan }) }
}

async function taskPlanPropose(input, context) {
  const { taskPlanId, ...intent } = input
  let proposal
  try {
    proposal = normalizeTaskPlanProposalProvider(await galaxyPostJson(
      `/task-plans/${encodeURIComponent(taskPlanId)}/proposals`,
      intent,
      context,
      70_000,
      {
        notFound: "Requested task plan or input reference is not available",
        staleTaskPlan: "Task plan changed; reload before retrying",
        conflict: "Task plan proposal conflicted with current state",
        invalidCode: "invalid_task_plan_proposal",
        invalid: "Task plan proposal could not be produced",
        forbidden: "Task plan proposal is not authorized",
      },
    ), input)
  } catch (error) {
    if (error instanceof AgentToolContractError) throw error
    providerError("invalid_provider_response", "Task plan proposal provider returned an invalid response", 502)
  }
  return { result: Object.freeze({ proposal }) }
}

async function proofDag(input, context) {
  const bytes = await galaxyFetch(`/proof-graphs/${input.graphRef.contentSha256}`, context)
  const actual = createHash("sha256").update(bytes).digest("hex")
  if (actual !== input.graphRef.contentSha256) providerError("invalid_provider_response", "Proof graph content hash verification failed", 502)
  let dag
  try {
    dag = parseProofDag(parseJsonBytes(bytes), actual)
  } catch (error) {
    if (error instanceof AgentToolContractError) throw error
    providerError("invalid_provider_response", "Proof graph provider returned an invalid response", 502)
  }
  if (dag.graphId !== input.graphRef.graphId) providerError("invalid_provider_response", "Proof graph identity did not match the request", 502)
  return dag
}

async function proofGraphGet(input, context) {
  const dag = await proofDag(input, context)
  let source
  try {
    source = buildAuthorizedProofGraphSource({
      schemaId: "gb.authorized-proof-graph-source.v1",
      authorized: true,
      activateCoordination: false,
      scope: { tenantId: context.identity.tenantId, workspaceId: dag.graphId },
      query: { mode: "proof", lens: "verify", scale: "project", cursor: null },
      proofDag: {
        schema_id: dag.schemaId,
        graph_id: dag.graphId,
        graph_kind: dag.graphKind,
        title: dag.title,
        targets: dag.nodes.map((node) => ({
          target_id: node.nodeId,
          title: node.title,
          natural_language_summary: node.objective,
          category: node.category,
          target_kind: node.targetKind,
          formal_binding: { status: node.formalBindingStatus },
        })),
        relations: dag.edges.map((edge) => ({
          relation_id: edge.id,
          prerequisite_target_id: edge.source,
          dependent_target_id: edge.target,
          relation_type: edge.relationType,
        })),
      },
      proofDagSha256: dag.contentSha256,
      workState: null,
      sourceCursor: input.cursor,
      sourceLimit: input.limit,
      priorityRefs: [],
    })
  } catch (error) {
    if (error instanceof AgentToolContractError) throw error
    if (input.cursor && error instanceof Error && /sourceCursor/u.test(error.message)) {
      throw new AgentToolContractError("invalid_cursor", "Proof graph cursor is invalid", 409)
    }
    providerError("invalid_provider_response", "Proof graph provider returned an invalid response", 502)
  }
  return {
    result: Object.freeze({
      graphRef: input.graphRef,
      graphKind: dag.graphKind,
      title: dag.title,
      graphInput: source.graphInput,
    }),
    pagination: Object.freeze({
      cursor: source.sourceContinuation.cursor,
      hasMore: source.sourceContinuation.hasMore,
      limit: input.limit,
    }),
  }
}

async function proofFrontierGet(input, context) {
  const dag = await proofDag(input, context)
  if (!ACTIVE_GRAPH_KINDS.has(dag.graphKind)) {
    return {
      result: Object.freeze({
        graphRef: input.graphRef,
        graphKind: dag.graphKind,
        workspaceId: null,
        workspaceVersion: null,
        coordinationActive: false,
        claimable: false,
        items: Object.freeze([]),
      }),
      pagination: Object.freeze({ cursor: null, hasMore: false, limit: input.limit }),
    }
  }
  const query = new URLSearchParams({
    graph_id: input.graphRef.graphId,
    content_sha256: input.graphRef.contentSha256,
  })
  const rawWorkState = parseJsonBytes(await galaxyFetch(
    `/proof-workspaces/${encodeURIComponent(input.workspaceId)}?${query.toString()}`,
    context,
  ))
  let workState
  let projection
  try {
    workState = parseProofWorkState(rawWorkState, dag)
    projection = projectProofTaskGraph(dag, workState)
  } catch {
    providerError("invalid_provider_response", "Proof work provider returned an invalid response", 502)
  }
  const items = projection.nodes
    .filter((node) => node.state === "available")
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
    .map((node) => Object.freeze({
      nodeId: node.nodeId,
      title: node.title,
      objective: node.objective,
      prerequisiteNodeIds: Object.freeze([...node.prerequisiteNodeIds].sort()),
      state: "available",
      itemVersion: node.workItem?.version ?? 0,
    }))
  const workspaceKey = createHash("sha256").update(input.workspaceId).digest("hex").slice(0, 16)
  let offset = 0
  if (input.cursor !== null) {
    const match = /^gbf1:([a-f0-9]{64}):([a-f0-9]{16}):(\d+):(\d+)$/u.exec(input.cursor)
    if (!match || match[1] !== dag.contentSha256 || match[2] !== workspaceKey || Number(match[3]) !== workState.version) {
      throw new AgentToolContractError("invalid_cursor", "Proof frontier cursor does not belong to this work-state version", 409)
    }
    offset = Number(match[4])
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length) {
    throw new AgentToolContractError("invalid_cursor", "Proof frontier cursor is out of range", 409)
  }
  const page = items.slice(offset, offset + input.limit)
  const nextOffset = offset + page.length
  return {
    result: Object.freeze({
      graphRef: input.graphRef,
      graphKind: dag.graphKind,
      workspaceId: workState.workspaceId,
      workspaceVersion: workState.version,
      coordinationActive: true,
      claimable: items.length > 0,
      items: Object.freeze(page),
    }),
    pagination: pagination(
      nextOffset,
      items.length,
      input.limit,
      (next) => `gbf1:${dag.contentSha256}:${workspaceKey}:${workState.version}:${next}`,
    ),
  }
}

function proofClaimResult(input, context, dag, rawWorkState) {
  if (!rawWorkState || typeof rawWorkState !== "object" || Array.isArray(rawWorkState)
    || (rawWorkState.replayed !== undefined && typeof rawWorkState.replayed !== "boolean")) {
    providerError("invalid_provider_response", "Proof work provider returned an invalid response", 502)
  }
  let workState
  try {
    workState = parseProofWorkState(rawWorkState, dag)
  } catch {
    providerError("invalid_provider_response", "Proof work provider returned an invalid response", 502)
  }
  if (workState.workspaceId !== input.workspaceId) {
    providerError("invalid_provider_response", "Proof work provider returned the wrong workspace", 502)
  }
  const item = workState.items.find((candidate) => candidate.nodeId === input.nodeId)
  if (!item) providerError("invalid_provider_response", "Proof work provider omitted the claimed node", 502)
  const replayed = rawWorkState.replayed === true
  const appliedItemVersion = input.expectedItemVersion + 1
  if (item.version !== appliedItemVersion
    || (!replayed && workState.version !== input.expectedVersion + 1)
    || (replayed && workState.version < input.expectedVersion + 1)) {
    if (replayed) {
      throw new AgentToolContractError(
        "replay_superseded",
        "The original proof claim transition was replayed, but the node has changed since it was applied",
        409,
      )
    }
    providerError("invalid_provider_response", "Proof work provider returned inconsistent versions", 502)
  }
  const actorPubkey = context.identity.nostrPubkey
  const claim = item.work.claim
  if (input.action === "acquire") {
    const leaseDurationMilliseconds = claim
      ? Date.parse(claim.expiresAt) - Date.parse(claim.claimedAt)
      : Number.NaN
    const active = claim && claim.nostrPubkey === actorPubkey
      && Date.parse(claim.expiresAt) > Date.now()
      && leaseDurationMilliseconds === input.leaseSeconds * 1_000
      && ["claimed", "running"].includes(item.work.status)
    if (!active) {
      if (replayed) {
        throw new AgentToolContractError(
          "replay_superseded",
          "The original proof claim transition was replayed, but its lease is no longer current",
          409,
        )
      }
      providerError("invalid_provider_response", "Proof work provider did not return an active owned claim", 502)
    }
  } else if (claim !== null || !["idle", "submitted", "blocked"].includes(item.work.status)) {
    if (replayed) {
      throw new AgentToolContractError(
        "replay_superseded",
        "The original proof claim release was replayed, but the node has changed since it was applied",
        409,
      )
    }
    providerError("invalid_provider_response", "Proof work provider did not release the claim", 502)
  }
  return Object.freeze({
    schemaId: "gb.proof-claim-current-state.v1",
    graphRef: input.graphRef,
    workspaceId: workState.workspaceId,
    nodeId: item.nodeId,
    action: input.action,
    workspaceVersion: workState.version,
    itemVersion: item.version,
    workStatus: item.work.status,
    claim: claim === null ? null : Object.freeze({
      claimId: claim.claimId,
      claimedAt: claim.claimedAt,
      expiresAt: claim.expiresAt,
      ownedByCaller: true,
    }),
    replayed,
  })
}

async function proofClaim(input, context) {
  if (typeof context.identity.nostrPubkey !== "string"
    || !/^[0-9a-f]{64}$/u.test(context.identity.nostrPubkey)) {
    throw new AgentToolContractError(
      "forbidden", "Proof claim transition requires a verified Nostr identity", 403,
    )
  }
  const dag = await proofDag(input, context)
  if (!ACTIVE_GRAPH_KINDS.has(dag.graphKind)) {
    throw new AgentToolContractError(
      "inactive_proof_graph",
      "Only an activated mission or campaign graph can accept proof claims",
      409,
    )
  }
  const transition = input.action === "acquire"
    ? { type: "claim.acquire", payload: { lease_seconds: input.leaseSeconds } }
    : { type: "claim.release", payload: {} }
  let rawWorkState
  try {
    rawWorkState = await galaxyPostJson(
      `/proof-workspaces/${encodeURIComponent(input.workspaceId)}/transitions`,
      {
        graph_ref: {
          graph_id: input.graphRef.graphId,
          content_sha256: input.graphRef.contentSha256,
        },
        node_id: input.nodeId,
        expected_version: input.expectedVersion,
        expected_item_version: input.expectedItemVersion,
        transition,
        idempotency_key: input.idempotencyKey,
      },
      context,
      2 * 1024 * 1024,
      {
        notFound: "Proof workspace or node is not available",
        conflict: "Proof claim conflicted with current state; refresh the frontier before retrying",
        invalidCode: "invalid_claim_transition",
        invalid: "Proof claim transition is invalid",
        forbidden: "Proof claim transition is not authorized",
      },
    )
  } catch (error) {
    if (error instanceof AgentToolContractError) throw error
    providerError("invalid_provider_response", "Proof work provider returned an invalid response", 502)
  }
  return { result: proofClaimResult(input, context, dag, rawWorkState) }
}

export const AGENT_READ_TOOL_IMPLEMENTATIONS = Object.freeze({
  "builtin.canvas.get": canvasGet,
  "builtin.graph.window.get": graphWindowGet,
  "builtin.ham.memory-search": searchHamMemoriesForAgent,
  "builtin.objects.get": objectsGet,
  "builtin.objects.representations": objectRepresentations,
  "builtin.objects.search": objectsSearch,
  "builtin.proof.frontier.get": proofFrontierGet,
  "builtin.proof.graph.get": proofGraphGet,
  "builtin.task.plan.get": taskPlanGet,
  "builtin.task.plan.propose": taskPlanPropose,
})

export const AGENT_MUTATION_TOOL_IMPLEMENTATIONS = Object.freeze({
  "builtin.anchors.create": anchorsCreate,
  "builtin.canvas.arrange": canvasArrange,
  "builtin.proof.claim": proofClaim,
  "builtin.relations.propose": relationsPropose,
  "builtin.surface.draft.create": surfaceDraftCreate,
})
