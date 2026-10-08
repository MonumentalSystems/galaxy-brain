import { NextRequest, NextResponse } from "next/server"

import { isSafeElnPath, requiredElnScopes } from "@/lib/eln-scope"
import {
  getRequestIdentity,
  getVerifiedNostrRequestIdentity,
  identityCanAny,
} from "@/lib/request-identity"
import { getCurrentUser } from "@/lib/auth"
import {
  decodeDurableImportMetadataHeader,
  encodeRasterImageManifestHeader,
  hasRasterImageSignature,
  isRasterImageCandidate,
  MAX_RASTER_IMAGE_BYTES,
  RasterImageContractError,
} from "@/lib/raster-image-contract.js"
import { validateRasterImageImport } from "@/lib/server/raster-image-validation.js"
import { durableUploadMediaType, IngestionContractError } from "@/lib/durable-document-import.js"
import {
  hasWebmSignature,
  isAudioOriginalCandidate,
  MAX_AUDIO_ORIGINAL_BYTES,
} from "@/lib/audio-original-contract.js"
import { createDocumentCorpusSearchRequest } from "@/lib/document-corpus-search.js"
import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "@/lib/galaxy-object-reference.js"

const INTERNAL_GALAXY_API =
  process.env.GALAXY_API_INTERNAL || "http://localhost:8044"
const MAX_PROOF_WORK_BODY_BYTES = 2_097_152
const MAX_PROOF_VERIFICATION_BODY_BYTES = 2_097_152
const MAX_PROOF_GRAPH_BODY_BYTES = 16_777_216
const MAX_FORMAL_PROJECT_PACKAGE_BODY_BYTES = 50_397_208
const MAX_PROOF_VERIFICATION_SET_BODY_BYTES = 16_777_216
const MAX_PROOF_MISSION_INTENT_BODY_BYTES = 65_536
const MAX_PROOF_MISSION_ACTIVATION_BODY_BYTES = 131_072
const MAX_PAPER_DOCUMENT_BODY_BYTES = 100_000_000
const MAX_OBJECT_LINK_BODY_BYTES = 32_768
const MAX_CANVAS_MUTATION_BODY_BYTES = 262_144
const MAX_SHARE_BUNDLE_CREATE_BODY_BYTES = 16_384
const MAX_CONVERSATION_MUTATION_BODY_BYTES = 131_072
const MAX_CONVERSATION_COLLECTION_RESPONSE_BYTES = 1_048_576
const MAX_CONVERSATION_MARKDOWN_EXPORT_RESPONSE_BYTES = 16_777_216
const MAX_DOCUMENT_IMPORT_BODY_BYTES = 100_000_000
const MAX_DOCUMENT_IMPORT_METADATA_HEADER_CHARS = 8_000
const MAX_DOCUMENT_ANCHOR_BODY_BYTES = 131_072
const MAX_DOCUMENT_MARK_BODY_BYTES = 131_072
const MAX_EXPERIMENT_CREATE_BODY_BYTES = 262_144
const MAX_EXPERIMENT_ATTACHMENT_BODY_BYTES = 8_192
const MAX_EXPERIMENT_OBSERVATION_BODY_BYTES = 32_768
const MAX_DATASOURCE_CONTENT_REQUEST_BYTES = 4_096
const SURFACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

class RequestBodyTooLarge extends Error {
  constructor(readonly limit: "generic" | "raster" | "audio" = "generic") {
    super("Request body exceeded its bound")
  }
}

class ResponseBodyTooLarge extends Error {}

async function readBoundedBody(request: NextRequest, maximumBytes: number) {
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new RequestBodyTooLarge()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

async function readBoundedResponseBody(response: Response, maximumBytes: number) {
  const declaredLength = response.headers.get("Content-Length")
  if (declaredLength !== null
    && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)) {
    throw new ResponseBodyTooLarge()
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new ResponseBodyTooLarge()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (declaredLength !== null && Number(declaredLength) !== body.byteLength) {
    throw new ResponseBodyTooLarge()
  }
  return body
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", exactArrayBuffer(bytes))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function readDocumentImportBody(
  request: NextRequest,
  initialRasterCandidate: boolean,
  initialAudioCandidate: boolean,
) {
  if (!request.body) return {
    bytes: new Uint8Array(),
    rasterCandidate: initialRasterCandidate,
    audioCandidate: initialAudioCandidate,
  }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  const signature = new Uint8Array(12)
  let signatureLength = 0
  let rasterCandidate = initialRasterCandidate
  let audioCandidate = initialAudioCandidate
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (signatureLength < signature.byteLength) {
        const copyLength = Math.min(signature.byteLength - signatureLength, value.byteLength)
        signature.set(value.subarray(0, copyLength), signatureLength)
        signatureLength += copyLength
        rasterCandidate ||= hasRasterImageSignature(signature.subarray(0, signatureLength))
        audioCandidate ||= hasWebmSignature(signature.subarray(0, signatureLength))
      }
      total += value.byteLength
      const maximumBytes = rasterCandidate
        ? MAX_RASTER_IMAGE_BYTES
        : audioCandidate ? MAX_AUDIO_ORIGINAL_BYTES : MAX_DOCUMENT_IMPORT_BODY_BYTES
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new RequestBodyTooLarge(rasterCandidate ? "raster" : audioCandidate ? "audio" : "generic")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, rasterCandidate, audioCandidate }
}

function exactArrayBuffer(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

type RouteContext = {
  params: Promise<{ path: string[] }>
}

async function proxyElnRequest(request: NextRequest, context: RouteContext) {
  const { path } = await context.params
  let documentCorpusSearchRequest: Readonly<{ query: string; limit: number }> | null = null
  let conversationCollectionQuery: string | null = null
  let conversationMarkdownExportQuery: string | null = null
  // Private aggregate records must only cross their dedicated bounded
  // gateways. Never expose those internal routes through this generic
  // authenticated ELN proxy.
  if (["object-projection-sources", "agent-anchor-creations", "relation-proposals"].includes(path[0])) {
    return NextResponse.json({ error: "Invalid ELN path" }, { status: 404 })
  }
  if (!isSafeElnPath(path)) {
    return NextResponse.json({ error: "Invalid ELN path" }, { status: 400 })
  }
  if (path[0] === "surfaces") {
    const parameters = request.nextUrl.searchParams
    const keys = [...new Set(parameters.keys())]
    const hasNoQuery = keys.length === 0
    const hasSurfaceId = path.length >= 2 && SURFACE_ID.test(path[1])
    const collectionRead = path.length === 1 && request.method === "GET"
    const collectionCreate = path.length === 1 && request.method === "POST" && hasNoQuery
    const contract = path.length === 2 && path[1] === "contract"
      && request.method === "GET" && hasNoQuery
    const itemRead = path.length === 2 && hasSurfaceId
      && request.method === "GET" && hasNoQuery
    const itemUpdate = path.length === 2 && hasSurfaceId
      && request.method === "PATCH" && hasNoQuery
    const revisions = path.length === 3 && hasSurfaceId
      && path[2] === "revisions" && request.method === "GET"
    const resolution = path.length === 3 && hasSurfaceId
      && path[2] === "resolve" && request.method === "GET"
    const promotion = path.length === 3 && hasSurfaceId && path[2] === "promote"
      && request.method === "POST" && hasNoQuery
    if (!collectionRead && !collectionCreate && !contract && !itemRead && !itemUpdate
      && !revisions && !resolution && !promotion) {
      return NextResponse.json({ error: "Invalid surface operation" }, { status: 404 })
    }
    if (collectionRead) {
      if (
        keys.some((key) => !["status", "q", "limit"].includes(key))
        || parameters.getAll("status").length !== 1
        || parameters.get("status") !== "promoted"
        || parameters.getAll("q").length > 1
        || parameters.getAll("limit").length > 1
      ) return NextResponse.json({ error: "Invalid promoted surface query" }, { status: 422 })
      const query = parameters.get("q")
      const limit = parameters.get("limit")
      if ((query !== null && query.length > 240)
        || (limit !== null && !/^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/u.test(limit))) {
        return NextResponse.json({ error: "Invalid promoted surface query" }, { status: 422 })
      }
    }
    if (revisions) {
      if (
        keys.some((key) => !["version", "limit"].includes(key))
        || parameters.getAll("version").length > 1
        || parameters.getAll("limit").length > 1
      ) return NextResponse.json({ error: "Invalid surface revision query" }, { status: 422 })
      const version = parameters.get("version")
      const limit = parameters.get("limit")
      if ((version !== null && !/^[1-9][0-9]{0,8}$/u.test(version))
        || (limit !== null && !/^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/u.test(limit))
        || (version !== null && limit !== null && limit !== "1")) {
        return NextResponse.json({ error: "Invalid surface revision query" }, { status: 422 })
      }
    }
    if (resolution) {
      if (
        keys.some((key) => key !== "version")
        || parameters.getAll("version").length > 1
      ) return NextResponse.json({ error: "Invalid surface resolution query" }, { status: 422 })
      const version = parameters.get("version")
      if (version !== null && !/^[1-9][0-9]{0,8}$/u.test(version)) {
        return NextResponse.json({ error: "Invalid surface resolution query" }, { status: 422 })
      }
    }
  }
  if (path[0] === "task-plans") {
    const collection = path.length === 1 && ["GET", "POST"].includes(request.method)
    const item = path.length === 2 && ["GET", "PATCH"].includes(request.method)
    const revisions = path.length === 3 && path[2] === "revisions" && request.method === "GET"
    if (!collection && !item && !revisions) {
      return NextResponse.json({ error: "Invalid task plan operation" }, { status: 404 })
    }
  }
  if (path[0] === "experiments" && path.length >= 3) {
    const attachments = path.length === 3 && path[2] === "attachments"
      && ["GET", "POST"].includes(request.method)
    const observations = path.length === 3 && path[2] === "observations"
      && ["GET", "POST"].includes(request.method)
    const metrics = path.length === 3 && path[2] === "metrics" && request.method === "POST"
    if (!attachments && !observations && !metrics) {
      return NextResponse.json({ error: "Invalid experiment operation" }, { status: 404 })
    }
    if (observations && request.nextUrl.search) {
      return NextResponse.json({ error: "Experiment observations do not accept query parameters" }, { status: 422 })
    }
  }
  if (path[0] === "object-links") {
    const collection = path.length === 1 && ["GET", "POST"].includes(request.method)
    const history = path.length === 3 && path[2] === "history" && request.method === "GET"
    const retraction = path.length === 3 && path[2] === "retract" && request.method === "POST"
    if (!collection && !history && !retraction) {
      return NextResponse.json({ error: "Invalid object link operation" }, { status: 404 })
    }
  }
  if (path[0] === "object-references") {
    const resolution = path.length === 2 && path[1] === "resolve" && request.method === "GET"
    if (!resolution) {
      return NextResponse.json({ error: "Invalid object reference operation" }, { status: 404 })
    }
  }
  if (path[0] === "canvases") {
    const collection = path.length === 1 && ["GET", "POST"].includes(request.method)
    const item = path.length === 2 && request.method === "GET"
    const revisions = path.length === 3 && path[2] === "revisions" && request.method === "GET"
    const mutations = path.length === 3 && path[2] === "mutations" && request.method === "POST"
    if (!collection && !item && !revisions && !mutations) {
      return NextResponse.json({ error: "Invalid canvas operation" }, { status: 404 })
    }
  }
  if (path[0] === "share-bundles") {
    const collection = path.length === 1 && request.method === "POST"
    const item = path.length === 2 && request.method === "GET"
    if (!collection && !item) {
      return NextResponse.json({ error: "Invalid share bundle operation" }, { status: 404 })
    }
  }
  if (path[0] === "share-snapshots") {
    const legacyItem = path.length === 2 && request.method === "GET"
    if (!legacyItem) {
      return NextResponse.json({ error: "Invalid legacy share snapshot operation" }, { status: 404 })
    }
  }
  if (path[0] === "conversations") {
    const collection = path.length === 1 && ["GET", "POST"].includes(request.method)
    const item = path.length === 2 && request.method === "GET"
    const exactTurn = path.length === 4 && path[2] === "turns" && request.method === "GET"
    const markdownExport = path.length === 4 && path[2] === "exports" && path[3] === "markdown"
      && request.method === "GET"
    const mutation = path.length === 3 && ["turns", "forks", "joins"].includes(path[2])
      && request.method === "POST"
    if (!collection && !item && !exactTurn && !markdownExport && !mutation) {
      return NextResponse.json({ error: "Invalid conversation operation" }, { status: 404 })
    }
    if (path.length === 1 && request.method === "GET") {
      const parameters = request.nextUrl.searchParams
      const keys = [...new Set(parameters.keys())]
      if (
        keys.some((key) => !["limit", "workspace_id", "cursor"].includes(key))
        || parameters.getAll("limit").length > 1
        || parameters.getAll("workspace_id").length > 1
        || parameters.getAll("cursor").length > 1
      ) return NextResponse.json({ error: "Invalid conversation collection query" }, { status: 422 })
      const limit = parameters.get("limit")
      const workspaceId = parameters.get("workspace_id")
      const cursor = parameters.get("cursor")
      if (limit !== null && !/^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/u.test(limit)) {
        return NextResponse.json({ error: "Invalid conversation collection limit" }, { status: 422 })
      }
      if (workspaceId !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(workspaceId)) {
        return NextResponse.json({ error: "Invalid conversation collection workspace" }, { status: 422 })
      }
      if (cursor !== null && (cursor.length > 8_192 || !/^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(cursor))) {
        return NextResponse.json({ error: "Invalid conversation collection cursor" }, { status: 422 })
      }
      const normalized = new URLSearchParams()
      if (limit !== null) normalized.set("limit", limit)
      if (workspaceId !== null) normalized.set("workspace_id", workspaceId)
      if (cursor !== null) normalized.set("cursor", cursor)
      conversationCollectionQuery = normalized.toString()
    }
    if (markdownExport) {
      const parameters = request.nextUrl.searchParams
      const keys = [...new Set(parameters.keys())]
      if (keys.length !== 1 || keys[0] !== "conversation_ref" || parameters.getAll("conversation_ref").length !== 1) {
        return NextResponse.json({ error: "Invalid conversation Markdown export query" }, { status: 422 })
      }
      const value = parameters.get("conversation_ref")
      const reference = parseGalaxyObjectReference(value)
      if (
        !reference
        || reference.format !== "canonical"
        || reference.kind !== "chat"
        || reference.id.toLowerCase() !== path[1].toLowerCase()
        || reference.selector.mode !== "pinned"
        || !/^sha256:[0-9a-f]{64}$/u.test(reference.selector.revision)
        || serializeGalaxyObjectReference(reference) !== value
      ) {
        return NextResponse.json({ error: "Conversation Markdown export requires one matching pinned chat reference" }, { status: 422 })
      }
      conversationMarkdownExportQuery = new URLSearchParams({ conversation_ref: value }).toString()
    }
  }
  if (path[0] === "document-anchors") {
    const anchor = path.length === 2 && request.method === "GET"
    if (!anchor) {
      return NextResponse.json({ error: "Invalid document anchor operation" }, { status: 404 })
    }
  }
  if (path[0] === "proof-graphs") {
    const collection = path.length === 1 && ["GET", "POST"].includes(request.method)
    const exactGraph = path.length === 2 && request.method === "GET"
    const missionCandidate = path.length === 3 && path[2] === "mission-candidates"
      && request.method === "POST"
    const missionActivation = path.length === 3 && path[2] === "mission-activations"
      && request.method === "POST"
    if (!collection && !exactGraph && !missionCandidate && !missionActivation) {
      return NextResponse.json({ error: "Invalid proof graph operation" }, { status: 404 })
    }
  }
  if (path[0] === "formal-project-packages") {
    const collection = path.length === 1 && request.method === "POST"
    const exactPackage = path.length === 2 && request.method === "GET"
    if (!collection && !exactPackage) {
      return NextResponse.json({ error: "Invalid formal project package operation" }, { status: 404 })
    }
  }
  if (path[0] === "proof-verification-sets") {
    const collection = path.length === 1 && ["GET", "POST"].includes(request.method)
    const exactSet = path.length === 2 && request.method === "GET"
    if (!collection && !exactSet) {
      return NextResponse.json({ error: "Invalid proof verification set operation" }, { status: 404 })
    }
  }
  if (path[0] === "proof-workspaces") {
    const collection = path.length === 1 && ["GET", "POST"].includes(request.method)
    const workspace = path.length === 2 && request.method === "GET"
    const transitions = path.length === 3 && path[2] === "transitions"
      && ["GET", "POST"].includes(request.method)
    const verification = path.length === 5 && path[2] === "nodes" && path[4] === "verify"
      && request.method === "POST"
    if (!collection && !workspace && !transitions && !verification) {
      return NextResponse.json({ error: "Invalid proof work operation" }, { status: 404 })
    }
  }
  if (path[0] === "documents") {
    const collection = path.length === 1 && request.method === "GET"
    const importer = path.length === 2 && path[1] === "import" && request.method === "POST"
    const corpusSearch = path.length === 2 && path[1] === "search" && request.method === "GET"
    const revision = path.length === 2 && path[1] !== "search" && request.method === "GET"
    const representations = path.length === 3 && path[2] === "representations" && request.method === "GET"
    const representationContent = path.length === 5 && path[2] === "representations"
      && path[4] === "content" && request.method === "GET"
    const transform = path.length === 3 && path[2] === "transform" && request.method === "POST"
    const anchors = path.length === 3 && path[2] === "anchors" && ["GET", "POST"].includes(request.method)
    const anchor = path.length === 4 && path[2] === "anchors" && request.method === "GET"
    const anchorMarks = path.length === 5 && path[2] === "anchors" && path[4] === "marks"
      && ["GET", "POST"].includes(request.method)
    const anchorBacklinks = path.length === 5 && path[2] === "anchors" && path[4] === "backlinks"
      && request.method === "GET"
    const mark = path.length === 4 && path[2] === "marks"
      && ["GET", "PATCH"].includes(request.method)
    if (!collection && !importer && !corpusSearch && !revision && !representations && !representationContent
      && !transform && !anchors && !anchor && !anchorMarks && !anchorBacklinks && !mark) {
      return NextResponse.json({ error: "Invalid document operation" }, { status: 404 })
    }
    if (corpusSearch) {
      const queryKeys = [...new Set(request.nextUrl.searchParams.keys())]
      if (
        queryKeys.some((key) => !["q", "limit"].includes(key))
        || request.nextUrl.searchParams.getAll("q").length !== 1
        || request.nextUrl.searchParams.getAll("limit").length > 1
      ) return NextResponse.json({ error: "Invalid document corpus search query" }, { status: 422 })
      const rawLimit = request.nextUrl.searchParams.get("limit")
      if (rawLimit !== null && !/^(?:[1-9]|1[0-9]|20)$/u.test(rawLimit)) {
        return NextResponse.json({ error: "Invalid document corpus search limit" }, { status: 422 })
      }
      try {
        documentCorpusSearchRequest = createDocumentCorpusSearchRequest({
          query: request.nextUrl.searchParams.get("q")!,
          ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
        })
      } catch {
        return NextResponse.json({ error: "Invalid document corpus search query" }, { status: 422 })
      }
    }
  }
  if (path[0] === "papers" && path.length >= 3 && path[2] === "document") {
    const documentRead = path.length === 3 && request.method === "GET"
    const documentUpload = path.length === 3 && request.method === "PUT"
    const documentBridge = path.length === 4 && path[3] === "bridge" && request.method === "POST"
    const documentFetch = path.length === 4 && path[3] === "fetch" && request.method === "POST"
    if (!documentRead && !documentUpload && !documentBridge && !documentFetch) {
      return NextResponse.json({ error: "Invalid paper document operation" }, { status: 404 })
    }
  }
  if (path[0] === "datasources") {
    const plugins = path.length === 2 && path[1] === "plugins" && request.method === "GET"
    const connections = path.length === 2 && path[1] === "connections"
      && ["GET", "POST"].includes(request.method)
    const connection = path.length === 3 && path[1] === "connections" && request.method === "PATCH"
    const action = path.length === 3 && ["sync", "import", "content"].includes(path[2])
      && request.method === "POST"
    const items = path.length === 3 && path[2] === "items" && request.method === "GET"
    if (!plugins && !connections && !connection && !action && !items) {
      return NextResponse.json({ error: "Invalid datasource operation" }, { status: 404 })
    }
  }
  const read = request.method === "GET" || request.method === "HEAD"
  const proofMissionDerivation = path[0] === "proof-graphs" && path.length === 3
    && path[2] === "mission-candidates" && request.method === "POST"
  const proofMissionActivation = path[0] === "proof-graphs" && path.length === 3
    && path[2] === "mission-activations" && request.method === "POST"
  const proofWorkMutation = path[0] === "proof-workspaces" && !read
  const proofWorkVerification = path[0] === "proof-workspaces" && path.length === 5
    && path[2] === "nodes" && path[4] === "verify" && request.method === "POST"
  const proofGraphMutation = path[0] === "proof-graphs" && !read
    && !proofMissionDerivation && !proofMissionActivation
  const formalProjectPackageMutation = path[0] === "formal-project-packages" && request.method === "POST"
  const proofVerificationSetMutation = path[0] === "proof-verification-sets" && !read
  const objectLinkMutation = path[0] === "object-links" && !read
  const canvasMutation = path[0] === "canvases" && !read
  const shareBundleCreate = path[0] === "share-bundles" && request.method === "POST"
  const conversationMutation = path[0] === "conversations" && !read
  const documentImport = request.method === "POST"
    && path.length === 2 && path[0] === "documents" && path[1] === "import"
  const documentTransform = request.method === "POST"
    && path.length === 3 && path[0] === "documents" && path[2] === "transform"
  const documentTransformMode = documentTransform
    ? request.headers.get("X-GB-Transform-Mode") || ""
    : ""
  const documentAnchorMutation = request.method === "POST"
    && path.length === 3 && path[0] === "documents" && path[2] === "anchors"
  const documentMarkMutation = path[0] === "documents" && (
    (request.method === "POST" && path.length === 5 && path[2] === "anchors" && path[4] === "marks")
    || (request.method === "PATCH" && path.length === 4 && path[2] === "marks")
  )
  const paperDocumentUpload = request.method === "PUT"
    && path.length === 3 && path[0] === "papers" && path[2] === "document"
  const paperDocumentBridge = request.method === "POST"
    && path.length === 4 && path[0] === "papers" && path[2] === "document" && path[3] === "bridge"
  const paperDocumentFetch = request.method === "POST"
    && path.length === 4 && path[0] === "papers" && path[2] === "document" && path[3] === "fetch"
  const paperDocumentBodylessMutation = paperDocumentBridge || paperDocumentFetch
  const paperDocumentMutation = paperDocumentUpload || paperDocumentBodylessMutation
  const experimentCreate = request.method === "POST"
    && path.length === 1 && path[0] === "experiments"
  const experimentAttachmentCreate = request.method === "POST"
    && path.length === 3 && path[0] === "experiments" && path[2] === "attachments"
  const experimentObservationCreate = request.method === "POST"
    && path.length === 3 && path[0] === "experiments" && path[2] === "observations"
  const datasourceContentRead = request.method === "POST"
    && path.length === 3 && path[0] === "datasources" && path[2] === "content"
  const declaredLength = Number(request.headers.get("Content-Length") || 0)
  if (proofWorkMutation && Number.isFinite(declaredLength) && declaredLength > MAX_PROOF_WORK_BODY_BYTES) {
    return NextResponse.json({ error: "Proof work mutation body exceeds 2 MiB" }, { status: 413 })
  }
  if (proofWorkVerification && Number.isFinite(declaredLength)
    && declaredLength > MAX_PROOF_VERIFICATION_BODY_BYTES) {
    return NextResponse.json({ error: "Proof verification body exceeds 2 MiB" }, { status: 413 })
  }
  if (proofGraphMutation && Number.isFinite(declaredLength) && declaredLength > MAX_PROOF_GRAPH_BODY_BYTES) {
    return NextResponse.json({ error: "Proof graph exceeds 16 MiB" }, { status: 413 })
  }
  if (formalProjectPackageMutation && Number.isFinite(declaredLength)
    && declaredLength > MAX_FORMAL_PROJECT_PACKAGE_BODY_BYTES) {
    return NextResponse.json({ error: "Formal project package exceeds its byte bound" }, { status: 413 })
  }
  if (proofVerificationSetMutation && Number.isFinite(declaredLength)
    && declaredLength > MAX_PROOF_VERIFICATION_SET_BODY_BYTES) {
    return NextResponse.json({ error: "Proof verification set exceeds 16 MiB" }, { status: 413 })
  }
  if (proofMissionDerivation && Number.isFinite(declaredLength)
    && declaredLength > MAX_PROOF_MISSION_INTENT_BODY_BYTES) {
    return NextResponse.json({ error: "Proof mission intent exceeds 64 KiB" }, { status: 413 })
  }
  if (proofMissionActivation && Number.isFinite(declaredLength)
    && declaredLength > MAX_PROOF_MISSION_ACTIVATION_BODY_BYTES) {
    return NextResponse.json({ error: "Proof mission activation exceeds 128 KiB" }, { status: 413 })
  }
  if (objectLinkMutation && Number.isFinite(declaredLength) && declaredLength > MAX_OBJECT_LINK_BODY_BYTES) {
    return NextResponse.json({ error: "Object link body exceeds 32 KiB" }, { status: 413 })
  }
  if (canvasMutation && Number.isFinite(declaredLength) && declaredLength > MAX_CANVAS_MUTATION_BODY_BYTES) {
    return NextResponse.json({ error: "Canvas mutation body exceeds 256 KiB" }, { status: 413 })
  }
  if (shareBundleCreate && Number.isFinite(declaredLength)
    && declaredLength > MAX_SHARE_BUNDLE_CREATE_BODY_BYTES) {
    return NextResponse.json({ error: "Share bundle selector exceeds 16 KiB" }, { status: 413 })
  }
  if (conversationMutation && Number.isFinite(declaredLength)
    && declaredLength > MAX_CONVERSATION_MUTATION_BODY_BYTES) {
    return NextResponse.json({ error: "Conversation mutation body exceeds 128 KiB" }, { status: 413 })
  }
  if (documentImport && Number.isFinite(declaredLength) && declaredLength > MAX_DOCUMENT_IMPORT_BODY_BYTES) {
    return NextResponse.json({ error: "Document exceeds 100 MB" }, { status: 413 })
  }
  if (documentAnchorMutation && Number.isFinite(declaredLength) && declaredLength > MAX_DOCUMENT_ANCHOR_BODY_BYTES) {
    return NextResponse.json({ error: "Document anchor body exceeds 128 KiB" }, { status: 413 })
  }
  if (documentMarkMutation && Number.isFinite(declaredLength) && declaredLength > MAX_DOCUMENT_MARK_BODY_BYTES) {
    return NextResponse.json({ error: "Document mark body exceeds 128 KiB" }, { status: 413 })
  }
  if (experimentCreate && Number.isFinite(declaredLength)
    && declaredLength > MAX_EXPERIMENT_CREATE_BODY_BYTES) {
    return NextResponse.json({ error: "Experiment body exceeds 256 KiB" }, { status: 413 })
  }
  if (experimentAttachmentCreate && Number.isFinite(declaredLength)
    && declaredLength > MAX_EXPERIMENT_ATTACHMENT_BODY_BYTES) {
    return NextResponse.json({ error: "Experiment attachment body exceeds 8 KiB" }, { status: 413 })
  }
  if (experimentObservationCreate && Number.isFinite(declaredLength)
    && declaredLength > MAX_EXPERIMENT_OBSERVATION_BODY_BYTES) {
    return NextResponse.json({ error: "Experiment observation body exceeds 32 KiB" }, { status: 413 })
  }
  if (datasourceContentRead && Number.isFinite(declaredLength)
    && declaredLength > MAX_DATASOURCE_CONTENT_REQUEST_BYTES) {
    return NextResponse.json({ error: "Datasource item request exceeds 4 KiB" }, { status: 413 })
  }
  const experimentIdempotencyKey = experimentCreate
    ? request.headers.get("Idempotency-Key") || ""
    : ""
  const experimentAttachmentIdempotencyKey = experimentAttachmentCreate
    ? request.headers.get("Idempotency-Key") || ""
    : ""
  const experimentObservationIdempotencyKey = experimentObservationCreate
    ? request.headers.get("Idempotency-Key") || ""
    : ""
  const documentImportMetadata = documentImport
    ? request.headers.get("X-GB-Import-Metadata") || ""
    : ""
  if (documentImport && documentImportMetadata.length > MAX_DOCUMENT_IMPORT_METADATA_HEADER_CHARS) {
    return NextResponse.json({ error: "Document import metadata exceeds 8000 characters" }, { status: 413 })
  }
  if (documentImport && !/^[A-Za-z0-9_-]+$/.test(documentImportMetadata)) {
    return NextResponse.json({ error: "Document import metadata must be base64url JSON" }, { status: 400 })
  }
  let documentImportMetadataValue: Readonly<{ filename: string; sourceKind: string }> | undefined
  let rasterDocumentImport = false
  let audioDocumentImport = false
  if (documentImport) {
    try {
      documentImportMetadataValue = decodeDurableImportMetadataHeader(documentImportMetadata)
    } catch {
      return NextResponse.json({ error: "Document import metadata must be base64url JSON" }, { status: 400 })
    }
    const declaredMediaType = request.headers.get("Content-Type") || ""
    rasterDocumentImport = isRasterImageCandidate(documentImportMetadataValue.filename, declaredMediaType)
    audioDocumentImport = isAudioOriginalCandidate(documentImportMetadataValue.filename, declaredMediaType)
    if (rasterDocumentImport
      && Number.isFinite(declaredLength) && declaredLength > MAX_RASTER_IMAGE_BYTES) {
      return NextResponse.json({ error: "Raster image exceeds 20 MiB" }, { status: 413 })
    }
    if (audioDocumentImport
      && Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_ORIGINAL_BYTES) {
      return NextResponse.json({ error: "WebM/Opus audio exceeds 20 MiB" }, { status: 413 })
    }
  }
  if (documentTransform && Number.isFinite(declaredLength) && declaredLength > 0) {
    return NextResponse.json({ error: "Document transform accepts no request body" }, { status: 400 })
  }
  let proofWorkBody: Uint8Array | undefined
  if (proofWorkMutation) {
    try {
      proofWorkBody = await readBoundedBody(
        request,
        proofWorkVerification ? MAX_PROOF_VERIFICATION_BODY_BYTES : MAX_PROOF_WORK_BODY_BYTES,
      )
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        return NextResponse.json(
          { error: proofWorkVerification
            ? "Proof verification body exceeds 2 MiB"
            : "Proof work mutation body exceeds 2 MiB" },
          { status: 413 },
        )
      }
      return NextResponse.json({ error: "Unable to read proof work mutation body" }, { status: 400 })
    }
  }
  let experimentAttachmentBody: Uint8Array | undefined
  if (experimentAttachmentCreate) {
    try {
      experimentAttachmentBody = await readBoundedBody(request, MAX_EXPERIMENT_ATTACHMENT_BODY_BYTES)
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        return NextResponse.json({ error: "Experiment attachment body exceeds 8 KiB" }, { status: 413 })
      }
      return NextResponse.json({ error: "Unable to read experiment attachment" }, { status: 400 })
    }
  }
  let experimentObservationBody: Uint8Array | undefined
  if (experimentObservationCreate) {
    try {
      experimentObservationBody = await readBoundedBody(request, MAX_EXPERIMENT_OBSERVATION_BODY_BYTES)
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        return NextResponse.json({ error: "Experiment observation body exceeds 32 KiB" }, { status: 413 })
      }
      return NextResponse.json({ error: "Unable to read experiment observation" }, { status: 400 })
    }
  }
  let proofGraphBody: Uint8Array | undefined
  if (proofGraphMutation) {
    try {
      proofGraphBody = await readBoundedBody(request, MAX_PROOF_GRAPH_BODY_BYTES)
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        return NextResponse.json({ error: "Proof graph exceeds 16 MiB" }, { status: 413 })
      }
      return NextResponse.json({ error: "Unable to read proof graph" }, { status: 400 })
    }
  }
  let formalProjectPackageBody: Uint8Array | undefined
  if (formalProjectPackageMutation) {
    try {
      formalProjectPackageBody = await readBoundedBody(request, MAX_FORMAL_PROJECT_PACKAGE_BODY_BYTES)
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        return NextResponse.json({ error: "Formal project package exceeds its byte bound" }, { status: 413 })
      }
      return NextResponse.json({ error: "Unable to read formal project package" }, { status: 400 })
    }
  }
  let proofVerificationSetBody: Uint8Array | undefined
  if (proofVerificationSetMutation) {
    try {
      proofVerificationSetBody = await readBoundedBody(request, MAX_PROOF_VERIFICATION_SET_BODY_BYTES)
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        return NextResponse.json({ error: "Proof verification set exceeds 16 MiB" }, { status: 413 })
      }
      return NextResponse.json({ error: "Unable to read proof verification set" }, { status: 400 })
    }
  }
  let proofMissionBody: Uint8Array | undefined
  if (proofMissionDerivation) {
    try {
      proofMissionBody = await readBoundedBody(request, MAX_PROOF_MISSION_INTENT_BODY_BYTES)
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        return NextResponse.json({ error: "Proof mission intent exceeds 64 KiB" }, { status: 413 })
      }
      return NextResponse.json({ error: "Unable to read proof mission intent" }, { status: 400 })
    }
  }
  let proofMissionActivationBody: Uint8Array | undefined
  if (proofMissionActivation) {
    try {
      proofMissionActivationBody = await readBoundedBody(
        request,
        MAX_PROOF_MISSION_ACTIVATION_BODY_BYTES,
      )
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        return NextResponse.json({ error: "Proof mission activation exceeds 128 KiB" }, { status: 413 })
      }
      return NextResponse.json({ error: "Unable to read proof mission activation" }, { status: 400 })
    }
  }
  let objectLinkBody: Uint8Array | undefined
  if (objectLinkMutation) {
    try {
      objectLinkBody = await readBoundedBody(request, MAX_OBJECT_LINK_BODY_BYTES)
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        return NextResponse.json({ error: "Object link body exceeds 32 KiB" }, { status: 413 })
      }
      return NextResponse.json({ error: "Unable to read object link body" }, { status: 400 })
    }
  }
  let canvasMutationBody: Uint8Array | undefined
  if (canvasMutation) {
    try {
      canvasMutationBody = await readBoundedBody(request, MAX_CANVAS_MUTATION_BODY_BYTES)
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        return NextResponse.json({ error: "Canvas mutation body exceeds 256 KiB" }, { status: 413 })
      }
      return NextResponse.json({ error: "Unable to read canvas mutation body" }, { status: 400 })
    }
  }
  let shareBundleBody: Uint8Array | undefined
  if (shareBundleCreate) {
    try {
      shareBundleBody = await readBoundedBody(request, MAX_SHARE_BUNDLE_CREATE_BODY_BYTES)
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        return NextResponse.json({ error: "Share bundle selector exceeds 16 KiB" }, { status: 413 })
      }
      return NextResponse.json({ error: "Unable to read share bundle selector" }, { status: 400 })
    }
  }
  let conversationMutationBody: Uint8Array | undefined
  if (conversationMutation) {
    try {
      conversationMutationBody = await readBoundedBody(request, MAX_CONVERSATION_MUTATION_BODY_BYTES)
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        return NextResponse.json({ error: "Conversation mutation body exceeds 128 KiB" }, { status: 413 })
      }
      return NextResponse.json({ error: "Unable to read conversation mutation body" }, { status: 400 })
    }
  }
  let documentImportBody: Uint8Array | undefined
  if (documentImport) {
    try {
      const imported = await readDocumentImportBody(request, rasterDocumentImport, audioDocumentImport)
      documentImportBody = imported.bytes
      rasterDocumentImport = imported.rasterCandidate
      audioDocumentImport = imported.audioCandidate
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        return NextResponse.json({
          error: rasterDocumentImport || error.limit === "raster"
            ? "Raster image exceeds 20 MiB"
            : audioDocumentImport || error.limit === "audio"
              ? "WebM/Opus audio exceeds 20 MiB"
              : "Document exceeds 100 MB",
        }, { status: 413 })
      }
      return NextResponse.json({ error: "Unable to read document" }, { status: 400 })
    }
  }
  let documentAnchorBody: Uint8Array | undefined
  if (documentAnchorMutation) {
    try {
      documentAnchorBody = await readBoundedBody(request, MAX_DOCUMENT_ANCHOR_BODY_BYTES)
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        return NextResponse.json({ error: "Document anchor body exceeds 128 KiB" }, { status: 413 })
      }
      return NextResponse.json({ error: "Unable to read document anchor" }, { status: 400 })
    }
  }
  let documentMarkBody: Uint8Array | undefined
  if (documentMarkMutation) {
    try {
      documentMarkBody = await readBoundedBody(request, MAX_DOCUMENT_MARK_BODY_BYTES)
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        return NextResponse.json({ error: "Document mark body exceeds 128 KiB" }, { status: 413 })
      }
      return NextResponse.json({ error: "Unable to read document mark" }, { status: 400 })
    }
  }
  let experimentCreateBody: Uint8Array | undefined
  if (experimentCreate) {
    try {
      experimentCreateBody = await readBoundedBody(request, MAX_EXPERIMENT_CREATE_BODY_BYTES)
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        return NextResponse.json({ error: "Experiment body exceeds 256 KiB" }, { status: 413 })
      }
      return NextResponse.json({ error: "Unable to read experiment body" }, { status: 400 })
    }
  }
  let datasourceContentBody: Uint8Array | undefined
  if (datasourceContentRead) {
    try {
      datasourceContentBody = await readBoundedBody(request, MAX_DATASOURCE_CONTENT_REQUEST_BYTES)
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        return NextResponse.json({ error: "Datasource item request exceeds 4 KiB" }, { status: 413 })
      }
      return NextResponse.json({ error: "Unable to read datasource item request" }, { status: 400 })
    }
  }
  const signedMutationBody = proofWorkMutation
    ? proofWorkBody
    : proofGraphMutation
      ? proofGraphBody
      : formalProjectPackageMutation
        ? formalProjectPackageBody
      : proofVerificationSetMutation
        ? proofVerificationSetBody
        : proofMissionActivation
          ? proofMissionActivationBody
        : undefined
  const identity = signedMutationBody
    ? await getVerifiedNostrRequestIdentity(request, signedMutationBody)
    : await getRequestIdentity(
        request,
        proofMissionBody || objectLinkBody || canvasMutationBody || conversationMutationBody || documentImportBody
          || documentAnchorBody || documentMarkBody || experimentCreateBody || experimentAttachmentBody
          || experimentObservationBody || shareBundleBody
          || datasourceContentBody,
      )
  if (!identity) {
    return NextResponse.json(
      { error: signedMutationBody ? "A fresh Nostr request signature is required" : "Unauthorized" },
      { status: 401 },
    )
  }
  if (objectLinkMutation) {
    const sessionUser = await getCurrentUser()
    if (!sessionUser
      || identity.kind !== "human"
      || sessionUser.tenantId !== identity.tenantId
      || sessionUser.principalId !== identity.principalId) {
      return NextResponse.json(
        { error: "Active object links require an authenticated human browser session" },
        { status: 403 },
      )
    }
  }
  if (experimentObservationCreate) {
    const sessionUser = await getCurrentUser()
    if (!sessionUser
      || identity.kind !== "human"
      || sessionUser.tenantId !== identity.tenantId
      || sessionUser.principalId !== identity.principalId) {
      return NextResponse.json(
        { error: "Experiment observations require an authenticated human browser session" },
        { status: 403 },
      )
    }
  }
  if (documentMarkMutation) {
    const sessionUser = await getCurrentUser()
    if (!sessionUser
      || identity.kind !== "human"
      || sessionUser.tenantId !== identity.tenantId
      || sessionUser.principalId !== identity.principalId) {
      return NextResponse.json(
        { error: "Document marks require an authenticated human browser session" },
        { status: 403 },
      )
    }
  }
  if (paperDocumentUpload) {
    const requiredScopes = requiredElnScopes(request.method, path)
    if (!identityCanAny(identity, requiredScopes.accepted)) {
      return NextResponse.json(
        { error: `Missing ${requiredScopes.primary} scope` },
        { status: 403 },
      )
    }
  }
  let paperDocumentBody: Uint8Array | undefined
  if (paperDocumentMutation) {
    const bodylessError = paperDocumentFetch
      ? "Paper document fetch accepts no request body"
      : "Paper document bridge accepts no request body"
    if (paperDocumentBodylessMutation && Number.isFinite(declaredLength) && declaredLength > 0) {
      return NextResponse.json({ error: bodylessError }, { status: 400 })
    }
    if (paperDocumentUpload && Number.isFinite(declaredLength) && declaredLength > MAX_PAPER_DOCUMENT_BODY_BYTES) {
      return NextResponse.json({ error: "Paper document exceeds 100 MB" }, { status: 413 })
    }
    try {
      paperDocumentBody = await readBoundedBody(
        request,
        paperDocumentBodylessMutation ? 1 : MAX_PAPER_DOCUMENT_BODY_BYTES,
      )
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        if (paperDocumentBodylessMutation) {
          return NextResponse.json({ error: bodylessError }, { status: 400 })
        }
        return NextResponse.json({ error: "Paper document exceeds 100 MB" }, { status: 413 })
      }
      return NextResponse.json({ error: "Unable to read paper document" }, { status: 400 })
    }
    if (paperDocumentBodylessMutation && (paperDocumentBody?.byteLength || 0) > 0) {
      return NextResponse.json({ error: bodylessError }, { status: 400 })
    }
  }
  let bodyText: string | undefined
  if (proofWorkMutation) {
    try {
      bodyText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(proofWorkBody)
    } catch {
      return NextResponse.json({ error: "Proof work mutation body must be UTF-8 JSON" }, { status: 400 })
    }
  }
  const body = read || documentTransform
    ? undefined
    : proofWorkMutation
      ? exactArrayBuffer(proofWorkBody || new Uint8Array())
      : proofGraphMutation
        ? exactArrayBuffer(proofGraphBody || new Uint8Array())
      : formalProjectPackageMutation
        ? exactArrayBuffer(formalProjectPackageBody || new Uint8Array())
      : proofVerificationSetMutation
        ? exactArrayBuffer(proofVerificationSetBody || new Uint8Array())
      : proofMissionDerivation
        ? exactArrayBuffer(proofMissionBody || new Uint8Array())
      : proofMissionActivation
        ? exactArrayBuffer(proofMissionActivationBody || new Uint8Array())
      : paperDocumentUpload
        ? exactArrayBuffer(paperDocumentBody || new Uint8Array())
        : paperDocumentBodylessMutation
          ? undefined
        : documentImport
          ? exactArrayBuffer(documentImportBody || new Uint8Array())
          : documentAnchorMutation
            ? exactArrayBuffer(documentAnchorBody || new Uint8Array())
            : documentMarkMutation
              ? exactArrayBuffer(documentMarkBody || new Uint8Array())
            : experimentCreate
              ? exactArrayBuffer(experimentCreateBody || new Uint8Array())
            : experimentAttachmentCreate
              ? exactArrayBuffer(experimentAttachmentBody || new Uint8Array())
            : experimentObservationCreate
              ? exactArrayBuffer(experimentObservationBody || new Uint8Array())
            : objectLinkMutation
              ? exactArrayBuffer(objectLinkBody || new Uint8Array())
              : canvasMutation
                ? exactArrayBuffer(canvasMutationBody || new Uint8Array())
                : shareBundleCreate
                  ? exactArrayBuffer(shareBundleBody || new Uint8Array())
                  : conversationMutation
                    ? exactArrayBuffer(conversationMutationBody || new Uint8Array())
                    : datasourceContentRead
                      ? exactArrayBuffer(datasourceContentBody || new Uint8Array())
                      : await request.text()
  let transitionType = ""
  if (proofWorkMutation && path.length === 3 && path[2] === "transitions") {
    try {
      const value = JSON.parse(bodyText || "null")
      transitionType = typeof value?.transition?.type === "string" ? value.transition.type : ""
    } catch {
      return NextResponse.json({ error: "Proof work mutation body must be JSON" }, { status: 400 })
    }
  }
  const requiredScopes = requiredElnScopes(request.method, path, transitionType)
  if (requiredScopes.primary === "proof-work:invalid-transition") {
    return NextResponse.json({ error: "Proof work transition type is invalid" }, { status: 400 })
  }
  if (!identityCanAny(identity, requiredScopes.accepted)) {
    return NextResponse.json(
      { error: `Missing ${requiredScopes.primary} scope` },
      { status: 403 },
    )
  }
  let rasterImageManifestHeader = ""
  if (documentImport && documentImportMetadataValue) {
    const declaredMediaType = request.headers.get("Content-Type") || ""
    const baseMediaType = declaredMediaType.split(";", 1)[0].trim().toLowerCase()
    try {
      const exactBytes = exactArrayBuffer(documentImportBody || new Uint8Array())
      const validatedMediaType = durableUploadMediaType({
        name: documentImportMetadataValue.filename,
        type: baseMediaType,
      }, exactBytes)
      if (validatedMediaType !== baseMediaType) throw new IngestionContractError("Document media type is inconsistent")
    } catch (error) {
      return NextResponse.json({
        error: error instanceof IngestionContractError ? error.message : "Document bytes are not supported",
      }, { status: 415 })
    }
    if (audioDocumentImport && documentImportMetadataValue.sourceKind !== "upload") {
      return NextResponse.json({ error: "WebM/Opus audio must be uploaded as a local file" }, { status: 415 })
    }
    try {
      const rasterImage = await validateRasterImageImport({
        bytes: documentImportBody || new Uint8Array(),
        filename: documentImportMetadataValue.filename,
        declaredMediaType,
      })
      if (rasterImage) {
        if (documentImportMetadataValue.sourceKind !== "upload") {
          return NextResponse.json({ error: "Raster images must be uploaded as local files" }, { status: 415 })
        }
        rasterImageManifestHeader = encodeRasterImageManifestHeader(rasterImage)
      }
    } catch (error) {
      const message = error instanceof RasterImageContractError
        ? error.message
        : "Raster image could not be safely decoded"
      const status = error instanceof RasterImageContractError && error.code === "busy"
        ? 503
        : message.includes("20 MiB") ? 413 : 415
      return NextResponse.json({ error: message }, { status })
    }
  }
  if (experimentCreate && !/^[!-~]{8,200}$/.test(experimentIdempotencyKey)) {
    return NextResponse.json({ error: "Invalid Idempotency-Key" }, { status: 422 })
  }
  if (experimentAttachmentCreate && !/^[A-Za-z0-9._:-]{8,200}$/.test(experimentAttachmentIdempotencyKey)) {
    return NextResponse.json({ error: "Invalid Idempotency-Key" }, { status: 422 })
  }
  if (experimentObservationCreate
    && !/^eln-observation:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(experimentObservationIdempotencyKey)) {
    return NextResponse.json({ error: "Invalid Idempotency-Key" }, { status: 422 })
  }
  if (documentTransform && !["", "reprocess"].includes(documentTransformMode)) {
    return NextResponse.json({ error: "Invalid document transform mode" }, { status: 422 })
  }

  const upstreamUrl = new URL(`/${path.map(encodeURIComponent).join("/")}`, INTERNAL_GALAXY_API)
  upstreamUrl.search = documentCorpusSearchRequest
    ? new URLSearchParams({
        q: documentCorpusSearchRequest.query,
        limit: String(documentCorpusSearchRequest.limit),
      }).toString()
    : conversationCollectionQuery !== null
      ? conversationCollectionQuery
      : conversationMarkdownExportQuery !== null
        ? conversationMarkdownExportQuery
        : request.nextUrl.search

  const headers = new Headers()
  headers.set("Content-Type", request.headers.get("Content-Type") || "application/json")
  headers.set("X-GB-Tenant-ID", identity.tenantId)
  headers.set("X-GB-Principal-ID", identity.principalId)
  if (documentTransform) {
    const idempotencyKey = request.headers.get("Idempotency-Key")
    if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey)
    if (documentTransformMode) headers.set("X-GB-Transform-Mode", documentTransformMode)
  }
  if (experimentCreate) {
    headers.set("Idempotency-Key", experimentIdempotencyKey)
  }
  if (experimentAttachmentCreate) {
    headers.set("Idempotency-Key", experimentAttachmentIdempotencyKey)
  }
  if (experimentObservationCreate) {
    headers.set("Idempotency-Key", experimentObservationIdempotencyKey)
  }
  headers.set("X-GB-Principal-Kind", identity.kind)
  if (objectLinkMutation || documentMarkMutation || experimentObservationCreate) {
    headers.set("X-GB-Human-Session", "v1")
  }
  if (documentImport) {
    for (const name of ["Idempotency-Key", "X-GB-Import-Metadata"]) {
      const value = request.headers.get(name)
      if (value) headers.set(name, value)
    }
    if (rasterImageManifestHeader) headers.set("X-GB-Raster-Image", rasterImageManifestHeader)
  }
  if (read && (
    (path.length === 3 && path[0] === "papers" && path[2] === "document")
    || (path.length === 5 && path[0] === "documents" && path[2] === "representations" && path[4] === "content")
  )) {
    const range = request.headers.get("Range")
    if (range) headers.set("Range", range)
  }
  if (identity.nostrPubkey) headers.set("X-GB-Nostr-Pubkey", identity.nostrPubkey)
  const proxyToken = process.env.GALAXY_API_PROXY_TOKEN
  if (!proxyToken) {
    return NextResponse.json({ error: "ELN proxy is not configured" }, { status: 503 })
  }
  headers.set("X-GB-Proxy-Token", proxyToken)

  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    body,
    cache: "no-store",
  })

  let boundedReadBody: Uint8Array | null = null
  let conversationMarkdownExportDigest: string | null = null
  if (conversationCollectionQuery !== null) {
    try {
      boundedReadBody = await readBoundedResponseBody(
        upstream,
        MAX_CONVERSATION_COLLECTION_RESPONSE_BYTES,
      )
    } catch (error) {
      if (error instanceof ResponseBodyTooLarge) {
        return NextResponse.json({ error: "Conversation collection response exceeds 1 MiB" }, { status: 502 })
      }
      return NextResponse.json({ error: "Conversation collection response is unavailable" }, { status: 502 })
    }
  }
  if (conversationMarkdownExportQuery !== null) {
    try {
      boundedReadBody = await readBoundedResponseBody(
        upstream,
        MAX_CONVERSATION_MARKDOWN_EXPORT_RESPONSE_BYTES,
      )
    } catch (error) {
      if (error instanceof ResponseBodyTooLarge) {
        return NextResponse.json({ error: "Conversation Markdown export exceeds 16 MiB" }, { status: 502 })
      }
      return NextResponse.json({ error: "Conversation Markdown export is unavailable" }, { status: 502 })
    }
    if (upstream.ok) {
      conversationMarkdownExportDigest = await sha256Hex(boundedReadBody)
      if (
        upstream.headers.get("Content-Type") !== "text/markdown; charset=utf-8"
        || upstream.headers.get("X-Content-SHA256") !== conversationMarkdownExportDigest
        || upstream.headers.get("ETag") !== `"sha256-${conversationMarkdownExportDigest}"`
      ) {
        return NextResponse.json({ error: "Conversation Markdown export failed integrity validation" }, { status: 502 })
      }
    }
  }

  const responseHeaders = new Headers()
  responseHeaders.set("Content-Type", upstream.headers.get("Content-Type") || "application/json")
  for (const name of [
    "Content-Disposition", "Content-Length", "Content-Range", "Cache-Control", "Accept-Ranges",
    "Content-Security-Policy", "ETag", "X-Content-SHA256", "X-Content-Type-Options",
    "X-Proof-Graph-ID", "X-Proof-Graph-Kind",
    "X-Proof-Verification-Graph-ID", "X-Proof-Verification-Graph-SHA256", "Link", "Retry-After",
  ]) {
    const value = upstream.headers.get(name)
    if (value) responseHeaders.set(name, value)
  }
  if (conversationMarkdownExportDigest !== null && boundedReadBody !== null) {
    responseHeaders.set("Content-Length", String(boundedReadBody.byteLength))
    responseHeaders.set("ETag", `"sha256-${conversationMarkdownExportDigest}"`)
    responseHeaders.set("X-Content-SHA256", conversationMarkdownExportDigest)
  }
  return new NextResponse(
    boundedReadBody === null ? upstream.body : exactArrayBuffer(boundedReadBody),
    {
      status: upstream.status,
      headers: responseHeaders,
    },
  )
}

export async function GET(request: NextRequest, context: RouteContext) {
  return proxyElnRequest(request, context)
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxyElnRequest(request, context)
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return proxyElnRequest(request, context)
}

export async function PUT(request: NextRequest, context: RouteContext) {
  return proxyElnRequest(request, context)
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxyElnRequest(request, context)
}
