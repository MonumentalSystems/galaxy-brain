import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  AUTHORIZED_CODE_GRAPH_SOURCE_SCHEMA_ID,
  buildAuthorizedCodeGraphSource,
} from "../lib/authorized-code-graph-source.js"
import {
  CodeGraphSnapshotSessionClient,
  codeGraphSnapshotDescriptorFromResolution,
  fetchExactCodeGraphSnapshot,
  validateCodeGraphLensReferences,
} from "../lib/code-graph-snapshot-client.js"
import { openCodeGraphSnapshotProvider } from "../lib/code-graph-snapshot-import.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import { projectDocumentObject } from "../lib/object-projection-adapters.js"
import { projectUnifiedGraph } from "../lib/unified-graph.js"

const fixtureBytes = await readFile(new URL("../docs/samples/codebase-memory.snapshot.json", import.meta.url))
const DOCUMENT_ID = "40000000-0000-4000-8000-000000000001"
const REVISION_ID = "50000000-0000-4000-8000-000000000001"
const REPRESENTATION_ID = "60000000-0000-4000-8000-000000000001"
const REVISION_SHA = "b".repeat(64)
const TENANT_ID = "30000000-0000-4000-8000-000000000001"
const TEST_ORIGIN = "https://galaxy.test"

function exactResponse(bytes, headers, url) {
  const response = new Response(bytes, { headers })
  Object.defineProperty(response, "url", { value: url })
  return response
}

async function fixtureSource() {
  const opened = await openCodeGraphSnapshotProvider(fixtureBytes, { maxNodes: 20_000, maxEdges: 80_000 })
  const sourceRef = createGalaxyObjectReference("document", DOCUMENT_ID, {
    mode: "pinned",
    revision: `sha256:${REVISION_SHA}`,
  })
  const sourceProjection = projectDocumentObject({
    document_id: DOCUMENT_ID,
    revision_sha256: REVISION_SHA,
    title: "Exact code graph",
    media_type: "application/json",
    representations: [{
      id: REPRESENTATION_ID,
      kind: "original",
      media_type: "application/json",
      content_sha256: opened.review.contentSha256,
      label: "Original JSON",
    }],
  })
  const scope = {
    tenantId: TENANT_ID,
    authorityScope: sourceRef,
    repository: {
      repositoryId: opened.review.repository.repositoryId,
      commit: opened.review.repository.commit,
      snapshotDigest: opened.review.declaredSnapshotDigest,
    },
  }
  const neighborhood = await opened.provider.neighbors(
    { kind: "repository", repositoryId: opened.review.repository.repositoryId },
    scope,
    4,
    250,
  )
  return { opened, sourceRef, sourceProjection, neighborhood }
}

test("derives one bounded transient code graph with fixed Galaxy authority", async () => {
  const { opened, sourceRef, sourceProjection, neighborhood } = await fixtureSource()
  const result = await buildAuthorizedCodeGraphSource({
    schemaId: AUTHORIZED_CODE_GRAPH_SOURCE_SCHEMA_ID,
    authorized: true,
    tenantId: TENANT_ID,
    sourceRef,
    sourceProjection,
    sourceRepresentationRef: sourceProjection.representations[0].ref,
    rawSha256: opened.review.contentSha256,
    review: opened.review,
    neighborhood,
    query: { scale: "object" },
  })
  const projection = projectUnifiedGraph(result.graphInput, { maxNodes: 260, maxEdges: 2_010, maxFanout: 2_010 })
  assert.equal(projection.continuation.hasMore, false)
  assert.ok(projection.nodes.some((node) => node.kind === "document" && node.ref === sourceRef))
  assert.ok(projection.nodes.some((node) => node.kind === "code.graph"))
  assert.ok(projection.nodes.some((node) => node.kind === "code.repo"))
  assert.ok(projection.nodes.some((node) => node.kind === "code.file"))
  assert.ok(projection.nodes.some((node) => node.kind === "code.symbol"))
  assert.deepEqual(
    [...new Set(projection.edges.map((edge) => edge.source.provider))],
    ["galaxy.code.snapshot"],
  )
  assert.ok(projection.edges.some((edge) => edge.relation === "derived_from"))
  assert.ok(projection.edges.some((edge) => edge.relation === "defines"))
  assert.ok(projection.edges.some((edge) => edge.relation === "calls"))
  const native = result.graphInput.relations.find((item) => item.relation.relation === "defines")
  assert.match(native.relation.source.recordId, /^defines:/u)
  assert.equal(result.graphInput.links, undefined)
})

test("binds reviewed provider provenance, sanitizes display metadata, and always contains a recentered root", async () => {
  const { opened, sourceRef, sourceProjection, neighborhood } = await fixtureSource()
  const root = neighborhood.nodes.find((node) => node.kind === "symbol")
  assert.ok(root)
  const recentered = await opened.provider.neighbors(root.ref, {
    tenantId: TENANT_ID,
    authorityScope: sourceRef,
    repository: {
      repositoryId: opened.review.repository.repositoryId,
      commit: opened.review.repository.commit,
      snapshotDigest: opened.review.declaredSnapshotDigest,
    },
  }, 0, 250)
  const unsafeLabel = `safe\u202etxt`
  const unsafeNeighborhood = {
    ...recentered,
    root: { ...recentered.root, label: unsafeLabel },
    nodes: recentered.nodes.map((node) => node.id === recentered.root.id ? { ...node, label: unsafeLabel } : node),
  }
  const result = await buildAuthorizedCodeGraphSource({
    schemaId: AUTHORIZED_CODE_GRAPH_SOURCE_SCHEMA_ID,
    authorized: true,
    tenantId: TENANT_ID,
    sourceRef,
    sourceProjection,
    sourceRepresentationRef: sourceProjection.representations[0].ref,
    rawSha256: opened.review.contentSha256,
    review: { ...opened.review, nodeCount: 1234 },
    neighborhood: unsafeNeighborhood,
  })
  const rootProjection = result.graphInput.objects.find((item) => item.projection.ref === result.rootReference).projection
  assert.equal(rootProjection.title, "safetxt")
  const graphProjection = result.graphInput.objects.find((item) => item.projection.kind === "code.graph").projection
  assert.match(graphProjection.summary, /^1234 objects/u)
  assert.ok(result.graphInput.relations.some((item) => (
    item.relation.fromRef === result.graphReference
    && item.relation.toRef === result.rootReference
    && item.relation.relation === "contains"
  )))
  await assert.rejects(
    buildAuthorizedCodeGraphSource({
      schemaId: AUTHORIZED_CODE_GRAPH_SOURCE_SCHEMA_ID,
      authorized: true,
      tenantId: TENANT_ID,
      sourceRef,
      sourceProjection,
      sourceRepresentationRef: sourceProjection.representations[0].ref,
      rawSha256: opened.review.contentSha256,
      review: opened.review,
      neighborhood: { ...recentered, provenance: { ...recentered.provenance, providerVersion: "forged" } },
    }),
    /worker provenance does not match/u,
  )
})

test("requires one authorized exact original and verifies response headers, length, and bytes", async () => {
  const { opened, sourceRef, sourceProjection } = await fixtureSource()
  const resolution = {
    requestedRef: sourceRef,
    status: "resolved",
    resolvedRef: sourceRef,
    provider: "galaxy.document",
    projection: sourceProjection,
    documentRevisionId: REVISION_ID,
  }
  const descriptor = codeGraphSnapshotDescriptorFromResolution(sourceRef, resolution)
  assert.match(descriptor.contentUrl, new RegExp(`${REVISION_ID}/representations/${REPRESENTATION_ID}/content`))
  const contentUrl = `${TEST_ORIGIN}${descriptor.contentUrl}`
  const response = (headers = {}) => exactResponse(fixtureBytes, {
      "content-type": "application/json",
      "x-content-sha256": opened.review.contentSha256,
      etag: `"sha256-${opened.review.contentSha256}"`,
      ...headers,
    }, contentUrl)
  const exact = await fetchExactCodeGraphSnapshot(descriptor, {
    baseUrl: TEST_ORIGIN,
    fetcher: async () => response(),
  })
  assert.equal(exact.rawSha256, opened.review.contentSha256)
  const exactWithLength = await fetchExactCodeGraphSnapshot(descriptor, {
    baseUrl: TEST_ORIGIN,
    fetcher: async () => response({ "content-length": String(fixtureBytes.byteLength) }),
  })
  assert.equal(exactWithLength.rawSha256, opened.review.contentSha256)
  await assert.rejects(
    fetchExactCodeGraphSnapshot(descriptor, { baseUrl: TEST_ORIGIN, fetcher: async () => {
      const invalid = response()
      invalid.headers.set("x-content-sha256", "f".repeat(64))
      return invalid
    } }),
    /failed its media, length, or digest contract/u,
  )
  await assert.rejects(
    fetchExactCodeGraphSnapshot(descriptor, {
      baseUrl: TEST_ORIGIN,
      fetcher: async () => exactResponse(fixtureBytes, {
        "content-type": "application/json",
        "x-content-sha256": opened.review.contentSha256,
        etag: `"sha256-${opened.review.contentSha256}"`,
      }, `${TEST_ORIGIN}/api/eln/documents/wrong/content`),
    }),
    /failed its media, length, or digest contract/u,
  )
  assert.throws(
    () => codeGraphSnapshotDescriptorFromResolution(sourceRef, { ...resolution, resolvedRef: createGalaxyObjectReference("document", DOCUMENT_ID) }),
    /unavailable or unauthorized/u,
  )
})

test("code object route selections fail closed without one exact snapshot pin", async () => {
  const { opened, sourceRef, neighborhood } = await fixtureSource()
  const codeRef = createGalaxyObjectReference("code.repo", "code:v1:fixture-repository", {
    mode: "pinned",
    revision: `git:${opened.review.repository.commit};snapshot:${opened.review.declaredSnapshotDigest}`,
  })
  assert.throws(() => validateCodeGraphLensReferences(null, codeRef), /requires one exact codeSnapshot/u)
  assert.throws(() => validateCodeGraphLensReferences(sourceRef, neighborhood.root.id), /exact pinned code object/u)
  assert.throws(
    () => validateCodeGraphLensReferences(sourceRef.replace(DOCUMENT_ID, `%34${DOCUMENT_ID.slice(1)}`), codeRef),
    /exact pinned document reference/u,
  )
  assert.throws(
    () => validateCodeGraphLensReferences(sourceRef, codeRef.replace("fixture-repository", "fixture%2Drepository")),
    /exact pinned code object/u,
  )
  assert.deepEqual(validateCodeGraphLensReferences(sourceRef, codeRef), { sourceRef, selectedRef: codeRef })
})

test("the graph lens stays in a persistent worker and exposes an accessible List fallback", async () => {
  const [worker, graphClient, unified, source] = await Promise.all([
    readFile(new URL("../workers/code-graph-snapshot.worker.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/graph/graph-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/graph/unified-graph.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/authorized-code-graph-source.js", import.meta.url), "utf8"),
  ])
  assert.match(worker, /maxNodes: SOURCE_NODE_LIMIT,[\s\S]*maxEdges: SOURCE_EDGE_LIMIT/u)
  assert.match(worker, /let session: LoadedSession \| null = null/u)
  assert.doesNotMatch(worker, /fetch\(|localStorage|indexedDB|projectCodeGraphEdgeToDurableRelation/u)
  assert.match(graphClient, /codeSnapshot/u)
  assert.match(graphClient, /reference !== values\[0\]/u)
  assert.match(graphClient, /parameters\.get\("ref"\) !== requestedSelection/u)
  assert.match(graphClient, /CodeGraphSnapshotSessionClient/u)
  assert.match(graphClient, /Recenter code neighborhood/u)
  assert.ok(graphClient.includes('router.replace(`${url.pathname}${url.search}${url.hash}`'))
  assert.match(unified, /ListTree/u)
  assert.match(unified, /setShowList/u)
  assert.match(unified, /role="status"/u)
  assert.match(worker, /errorCode: workerFailureCode/u)
  assert.doesNotMatch(worker, /errorMessage\(|error instanceof Error \? error\.message/u)
  assert.doesNotMatch(source, /projectCodeGraphEdgeToDurableRelation|object-links|fetch\(/u)
})

test("worker failure categories are bounded and never expose arbitrary worker text", async () => {
  const { opened, sourceRef, sourceProjection } = await fixtureSource()
  const resolution = {
    requestedRef: sourceRef,
    status: "resolved",
    resolvedRef: sourceRef,
    provider: "galaxy.document",
    projection: sourceProjection,
    documentRevisionId: REVISION_ID,
  }
  const listeners = { message: [], error: [] }
  const worker = {
    addEventListener(kind, listener) { listeners[kind].push(listener) },
    postMessage(message) {
      queueMicrotask(() => listeners.message.forEach((listener) => listener({
        data: { id: message.id, ok: false, errorCode: "over-cap", error: "secret raw parser detail" },
      })))
    },
    terminate() {},
  }
  const client = new CodeGraphSnapshotSessionClient(() => worker, {
    baseUrl: TEST_ORIGIN,
    resolve: async () => ({ results: [resolution] }),
    fetcher: async () => exactResponse(fixtureBytes, {
      "content-type": "application/json",
      "x-content-sha256": opened.review.contentSha256,
      etag: `"sha256-${opened.review.contentSha256}"`,
    }, `${TEST_ORIGIN}${codeGraphSnapshotDescriptorFromResolution(sourceRef, resolution).contentUrl}`),
  })
  await assert.rejects(
    client.load({ tenantId: TENANT_ID, sourceRef }),
    (error) => error.code === "worker-over-cap" && !error.message.includes("secret"),
  )
  client.dispose()
})

test("session client reuses the validated worker snapshot when recentering", async () => {
  const { opened, sourceRef, sourceProjection, neighborhood } = await fixtureSource()
  const resolution = {
    requestedRef: sourceRef,
    status: "resolved",
    resolvedRef: sourceRef,
    provider: "galaxy.document",
    projection: sourceProjection,
    documentRevisionId: REVISION_ID,
  }
  const listeners = { message: [], error: [] }
  const messages = []
  const worker = {
    addEventListener(kind, listener) { listeners[kind].push(listener) },
    postMessage(message) {
      messages.push(message.kind)
      queueMicrotask(() => listeners.message.forEach((listener) => listener({
        data: message.kind === "load"
          ? { id: message.id, ok: true, kind: "loaded", review: opened.review }
          : { id: message.id, ok: true, kind: "neighbors", neighborhood },
      })))
    },
    terminate() {},
  }
  let resolveCount = 0
  let fetchCount = 0
  const client = new CodeGraphSnapshotSessionClient(() => worker, {
    baseUrl: TEST_ORIGIN,
    resolve: async () => { resolveCount += 1; return { results: [resolution] } },
    fetcher: async () => {
      fetchCount += 1
      return exactResponse(fixtureBytes, {
        "content-type": "application/json",
        "x-content-sha256": opened.review.contentSha256,
        etag: `"sha256-${opened.review.contentSha256}"`,
      }, `${TEST_ORIGIN}${codeGraphSnapshotDescriptorFromResolution(sourceRef, resolution).contentUrl}`)
    },
  })
  await client.load({ tenantId: TENANT_ID, sourceRef })
  await client.load({ tenantId: TENANT_ID, sourceRef, selectedRef: null })
  assert.equal(resolveCount, 1)
  assert.equal(fetchCount, 1)
  assert.deepEqual(messages, ["load", "neighbors", "neighbors"])
  client.dispose()
})

test("changing exact tenant or source terminates the old worker before authorization and cannot revive its fast path", async () => {
  const { opened, sourceRef, sourceProjection, neighborhood } = await fixtureSource()
  const resolution = {
    requestedRef: sourceRef,
    status: "resolved",
    resolvedRef: sourceRef,
    provider: "galaxy.document",
    projection: sourceProjection,
    documentRevisionId: REVISION_ID,
  }
  let workerCount = 0
  let terminateCount = 0
  const workerFactory = () => {
    workerCount += 1
    const listeners = { message: [], error: [] }
    return {
      addEventListener(kind, listener) { listeners[kind].push(listener) },
      postMessage(message) {
        queueMicrotask(() => listeners.message.forEach((listener) => listener({
          data: message.kind === "load"
            ? { id: message.id, ok: true, kind: "loaded", review: opened.review }
            : { id: message.id, ok: true, kind: "neighbors", neighborhood },
        })))
      },
      terminate() { terminateCount += 1 },
    }
  }
  const otherSource = createGalaxyObjectReference("document", "70000000-0000-4000-8000-000000000001", {
    mode: "pinned",
    revision: `sha256:${"c".repeat(64)}`,
  })
  let resolveCount = 0
  let fetchCount = 0
  const client = new CodeGraphSnapshotSessionClient(workerFactory, {
    baseUrl: TEST_ORIGIN,
    resolve: async ([reference]) => {
      resolveCount += 1
      return reference === sourceRef ? { results: [resolution] } : { results: [{ requestedRef: reference, status: "missing" }] }
    },
    fetcher: async () => {
      fetchCount += 1
      return exactResponse(fixtureBytes, {
        "content-type": "application/json",
        "x-content-sha256": opened.review.contentSha256,
        etag: `"sha256-${opened.review.contentSha256}"`,
      }, `${TEST_ORIGIN}${codeGraphSnapshotDescriptorFromResolution(sourceRef, resolution).contentUrl}`)
    },
  })
  await client.load({ tenantId: TENANT_ID, sourceRef })
  await assert.rejects(client.load({ tenantId: `${TENANT_ID}-other`, sourceRef: otherSource }), /unavailable or unauthorized/u)
  await client.load({ tenantId: TENANT_ID, sourceRef })
  assert.equal(resolveCount, 3)
  assert.equal(fetchCount, 2)
  assert.equal(workerCount, 2)
  assert.ok(terminateCount >= 1)
  client.dispose()
})
