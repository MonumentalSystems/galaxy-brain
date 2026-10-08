import {
  createCodeGraphObjectId,
  createCodeGraphProvider,
  createCodeGraphRevision,
} from "./code-graph-provider.js"
import { normalizeCodeGraphSnapshotReview } from "./code-graph-snapshot-import.js"
import { createGalaxyObjectReference } from "./galaxy-object-reference.js"
import { projectCodeObject } from "./object-projection-adapters.js"

export const AUTHORIZED_CODE_GRAPH_SOURCE_SCHEMA_ID = "gb.authorized-code-graph-source.v1"
export const CODE_GRAPH_AUTHORITY_PROVIDER = "galaxy.code.snapshot"
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu

function invalid(message) {
  throw new TypeError(`Invalid ${AUTHORIZED_CODE_GRAPH_SOURCE_SCHEMA_ID}: ${message}`)
}

function exactProvenance(value, review) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.repositoryId !== review.repository.repositoryId
    || value.commit !== review.repository.commit
    || value.snapshotDigest !== review.declaredSnapshotDigest
    || value.provider !== review.provider.name
    || value.providerVersion !== review.provider.version
    || Object.keys(value).sort().join("\n") !== [
      "commit", "provider", "providerVersion", "repositoryId", "snapshotDigest",
    ].sort().join("\n")) invalid("worker provenance does not match the exact snapshot")
  return value
}

function safeDisplay(value) {
  return typeof value === "string" ? value.replace(BIDI_CONTROLS, "").trim() : value
}

async function edgeRecordId(value) {
  if (Array.from(value).length <= 512) return value
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  const hex = Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join("")
  return `code-edge:sha256:${hex}`
}

function codeKind(node) {
  if (node.kind === "repository") return "code.repo"
  if (node.kind === "file") return "code.file"
  if (node.kind === "symbol") return "code.symbol"
  invalid("worker returned an unsupported code object kind")
}

function projectionForNode(node, revisionId, rawSha256, representationRef) {
  const id = createCodeGraphObjectId(node.ref)
  const details = [node.path, node.symbol, node.language].filter(Boolean).map(safeDisplay).join(" · ")
  return projectCodeObject({
    objectKind: codeKind(node),
    id,
    revisionId,
    contentHash: rawSha256,
    title: safeDisplay(node.label),
    summary: details || `${node.kind} in ${safeDisplay(node.repositoryId)}`,
    representationRef,
  })
}

function scoped(scope, valueKey, value) {
  return Object.freeze({ scope, [valueKey]: Object.freeze(value) })
}

export async function buildAuthorizedCodeGraphSource(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || input.schemaId !== AUTHORIZED_CODE_GRAPH_SOURCE_SCHEMA_ID || input.authorized !== true) {
    invalid("authorized exact-source input is required")
  }
  const supportedKeys = new Set([
    "schemaId", "authorized", "tenantId", "sourceRef", "sourceProjection",
    "sourceRepresentationRef", "rawSha256", "review", "neighborhood", "query",
  ])
  if (Object.keys(input).some((key) => !supportedKeys.has(key))) invalid("input contains unsupported fields")
  const review = normalizeCodeGraphSnapshotReview(input.review)
  if (review.nodeCount > 20_000 || review.edgeCount > 80_000) invalid("snapshot exceeds the interactive source cap")
  const exactRepresentation = input.sourceProjection?.representations?.find((representation) => (
    representation.ref === input.sourceRepresentationRef
    && representation.kind === "original"
    && representation.mediaType === "application/json"
    && representation.contentHash === input.rawSha256
  ))
  if (input.rawSha256 !== review.contentSha256 || input.sourceProjection?.ref !== input.sourceRef
    || input.sourceProjection?.kind !== "document" || input.sourceProjection?.provenance?.provider !== "galaxy.document"
    || !exactRepresentation) {
    invalid("source document identity does not match the exact snapshot bytes")
  }
  const provenance = exactProvenance(input.neighborhood?.provenance, review)
  const scope = Object.freeze({ tenantId: input.tenantId, workspaceId: "tenant-catalog" })
  const providerScope = Object.freeze({
    tenantId: input.tenantId,
    authorityScope: input.sourceRef,
    repository: Object.freeze({
      repositoryId: review.repository.repositoryId,
      commit: review.repository.commit,
      snapshotDigest: review.declaredSnapshotDigest,
    }),
  })
  const validatingProvider = createCodeGraphProvider({
    provider: provenance.provider,
    version: provenance.providerVersion,
    resolve: async () => ({ node: input.neighborhood.root }),
    neighbors: async () => ({
      root: input.neighborhood.root,
      nodes: input.neighborhood.nodes,
      edges: input.neighborhood.edges,
      truncated: input.neighborhood.truncated,
    }),
  })
  const neighborhood = await validatingProvider.neighbors(
    input.neighborhood.root.ref,
    providerScope,
    input.neighborhood.depth,
    input.neighborhood.limit,
  )
  const revisionId = createCodeGraphRevision(review.repository.commit, review.declaredSnapshotDigest)
  const repositoryRef = Object.freeze({ kind: "repository", repositoryId: review.repository.repositoryId })
  const graphId = createCodeGraphObjectId(repositoryRef)
  const graphProjection = projectCodeObject({
    objectKind: "code.graph",
    id: graphId,
    revisionId,
    contentHash: input.rawSha256,
    title: `${safeDisplay(review.repository.repositoryId)} code graph`,
    summary: `${review.nodeCount} objects · ${review.edgeCount} typed relations · ${review.repository.commit}`,
    representationRef: input.sourceRepresentationRef,
  })

  const projectionByNodeId = new Map()
  let omittedNodes = 0
  for (const node of neighborhood.nodes) {
    try {
      projectionByNodeId.set(
        node.id,
        projectionForNode(node, revisionId, input.rawSha256, input.sourceRepresentationRef),
      )
    } catch {
      omittedNodes += 1
    }
  }
  const rootProjection = projectionByNodeId.get(neighborhood.root.id)
  if (!rootProjection) invalid("the requested code object cannot be represented by a canonical Galaxy reference")

  const source = Object.freeze({
    provider: CODE_GRAPH_AUTHORITY_PROVIDER,
    revision: input.rawSha256,
    sourceRef: input.sourceRef,
    extractorVersion: safeDisplay(provenance.providerVersion) || "unlabeled",
    resourceMode: "exact-original",
    resourceStatus: neighborhood.truncated || omittedNodes > 0 ? "partial" : "ready",
  })
  const relations = [
    scoped(scope, "relation", {
      fromRef: graphProjection.ref,
      toRef: input.sourceProjection.ref,
      relation: "derived_from",
      trust: "structure",
      source,
    }),
  ]
  relations.push(scoped(scope, "relation", {
    fromRef: graphProjection.ref,
    toRef: rootProjection.ref,
    relation: "contains",
    trust: "structure",
    source: Object.freeze({ ...source, recordId: await edgeRecordId(`graph-root:${rootProjection.ref}`) }),
  }))
  let omittedEdges = 0
  for (const edge of neighborhood.edges) {
    const from = projectionByNodeId.get(edge.source)
    const to = projectionByNodeId.get(edge.target)
    if (!from || !to) {
      omittedEdges += 1
      continue
    }
    relations.push(scoped(scope, "relation", {
      fromRef: from.ref,
      toRef: to.ref,
      relation: edge.type,
      trust: "structure",
      source: Object.freeze({ ...source, recordId: await edgeRecordId(edge.id) }),
    }))
  }
  const objects = [
    scoped(scope, "projection", input.sourceProjection),
    scoped(scope, "projection", graphProjection),
    ...[...projectionByNodeId.values()].map((projection) => scoped(scope, "projection", projection)),
  ]
  return Object.freeze({
    schemaId: "gb.authorized-code-graph-source-result.v1",
    graphInput: Object.freeze({
      schemaId: "gb.graph-projection-input.v1",
      scope,
      query: Object.freeze({
        rootRef: null,
        mode: "mixed",
        lens: "explore",
        scale: input.query?.scale ?? "object",
      }),
      objects: Object.freeze(objects),
      relations: Object.freeze(relations),
      providers: Object.freeze([Object.freeze({
        scope,
        provider: CODE_GRAPH_AUTHORITY_PROVIDER,
        status: neighborhood.truncated || omittedNodes > 0 || omittedEdges > 0 ? "partial" : "ready",
        snapshot: input.rawSha256,
        revision: review.repository.commit,
      })]),
    }),
    rootReference: rootProjection.ref,
    graphReference: graphProjection.ref,
    continuation: Object.freeze({
      truncated: neighborhood.truncated,
      omittedNodes,
      omittedEdges,
    }),
  })
}

export function codeGraphReferenceForNode(node, review) {
  const normalized = normalizeCodeGraphSnapshotReview(review)
  return createGalaxyObjectReference(codeKind(node), createCodeGraphObjectId(node.ref), {
    mode: "pinned",
    revision: createCodeGraphRevision(normalized.repository.commit, normalized.declaredSnapshotDigest),
  })
}
