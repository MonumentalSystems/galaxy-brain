import assert from "node:assert/strict"
import test from "node:test"

import { hydrateAtlasObjectReferences } from "../lib/atlas-object-hydration.js"
import { openActionForAtlasNode, openHrefForAtlasNode } from "../lib/canvas/atlas-open-href.js"
import { conversationGraphHref } from "../lib/conversation-collection-client.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import {
  GALAXY_OBJECT_PROJECTION_RESOLUTION_REQUEST_SCHEMA_ID,
  GALAXY_OBJECT_PROJECTION_RESOLUTION_RESPONSE_SCHEMA_ID,
  GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID,
  MAX_OBJECT_PROJECTION_REQUEST_BYTES,
  assembleObjectProjectionResolutionResponse,
  createObjectProjectionOpenHandles,
} from "../lib/object-projection-resolution.js"
import { projectPaperObject, projectTaskObject } from "../lib/object-projection-adapters.js"

const HASH = "a".repeat(64)
const DOCUMENT_REVISION_ID = "50000000-0000-4000-8000-000000000001"

function taskRef(index) {
  return createGalaxyObjectReference("ham.task", `task-${index}`)
}

function resolvedTask(reference, index) {
  const projection = projectTaskObject({
    id: `task-${index}`,
    title: `Task ${index}`,
    goal: "Hydrate the Atlas card.",
    version: index + 1,
  })
  return {
    requestedRef: reference,
    status: "resolved",
    resolvedRef: reference,
    provider: "ham",
    projection,
    handles: createObjectProjectionOpenHandles(reference),
  }
}

function response(results, status = 200) {
  return new Response(JSON.stringify({
    schemaId: GALAXY_OBJECT_PROJECTION_RESOLUTION_RESPONSE_SCHEMA_ID,
    results,
  }), { status, headers: { "Content-Type": "application/json" } })
}

test("deduplicates canonical refs stably and maps resolved and unavailable outcomes", async () => {
  const first = taskRef(1)
  const second = taskRef(2)
  const requests = []
  const hydrated = await hydrateAtlasObjectReferences([
    first,
    "not-a-reference",
    first,
    second,
    first.replace("task-1", "task%2d1"),
  ], {
    fetcher: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) })
      return response([
        resolvedTask(first, 1),
        { requestedRef: second, status: "unavailable" },
      ])
    },
  })

  assert.deepEqual(hydrated.references, [first, second])
  assert.deepEqual(hydrated.results.map((item) => item.status), ["resolved", "unavailable"])
  assert.equal(hydrated.byReference[first], hydrated.results[0])
  assert.equal(hydrated.byReference[second], hydrated.results[1])
  assert.ok(Object.isFrozen(hydrated) && Object.isFrozen(hydrated.results))
  assert.ok(Object.isFrozen(hydrated.byReference))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, "/api/eln/object-projections/resolve")
  assert.equal(requests[0].init.method, "POST")
  assert.equal(requests[0].init.cache, "no-store")
  assert.deepEqual(requests[0].body, {
    schemaId: GALAXY_OBJECT_PROJECTION_RESOLUTION_REQUEST_SCHEMA_ID,
    references: [first, second],
  })
})

test("keys a latest request by requested ref while exposing its exact resolved projection", async () => {
  const requestedRef = createGalaxyObjectReference("paper", "paper-1")
  const resolvedRef = createGalaxyObjectReference("paper", "paper-1", {
    mode: "pinned",
    revision: `sha256:${HASH}`,
  })
  const paper = {
    id: "paper-1",
    title: "Pinned paper",
    abstract: "A latest reference can resolve to an exact immutable head.",
    metadata_hash: HASH,
  }
  const revision = {
    id: "revision-1",
    paper_id: "paper-1",
    arxiv_version: 1,
    metadata_hash: HASH,
    metadata: {},
    imported_at: "2026-09-24T00:00:00Z",
  }
  const projection = projectPaperObject({ paper, revision })
  const hydrated = await hydrateAtlasObjectReferences([requestedRef], {
    fetcher: async () => response([{
      requestedRef,
      status: "resolved",
      resolvedRef,
      provider: "galaxy.paper",
      projection,
      handles: createObjectProjectionOpenHandles(resolvedRef),
    }]),
  })

  assert.equal(hydrated.byReference[requestedRef].resolvedRef, resolvedRef)
  assert.equal(hydrated.byReference[requestedRef].projection.ref, resolvedRef)
  assert.equal(hydrated.byReference[resolvedRef], undefined)
})

test("cold Atlas hydration restores the authorized exact document reader handle", async () => {
  const reference = createGalaxyObjectReference("document", "document-1", {
    mode: "pinned",
    revision: `sha256:${HASH}`,
  })
  const assembled = assembleObjectProjectionResolutionResponse({
    schemaId: GALAXY_OBJECT_PROJECTION_RESOLUTION_REQUEST_SCHEMA_ID,
    references: [reference],
  }, {
    schemaId: GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID,
    results: [{
      requestedRef: reference,
      status: "resolved",
      resolvedRef: reference,
      provider: "galaxy.document",
      sourceKind: "document",
      source: {
        documentId: "document-1",
        revisionId: DOCUMENT_REVISION_ID,
        revisionSha256: HASH,
        title: "Placed Markdown",
        mediaType: "text/markdown",
        representations: [],
      },
    }],
  })
  const hydrated = await hydrateAtlasObjectReferences([reference], {
    fetcher: async () => response(assembled.results),
  })
  const resolution = hydrated.byReference[reference]
  assert.equal(resolution.status, "resolved")
  assert.equal(resolution.documentRevisionId, DOCUMENT_REVISION_ID)
  assert.equal(openHrefForAtlasNode({
    availability: "resolved",
    display: { href: "/documents/untrusted" },
    placementState: { style: {} },
  }, resolution), `/documents/${DOCUMENT_REVISION_ID}`)
  assert.deepEqual(openActionForAtlasNode({
    availability: "resolved",
    display: { href: "/documents/untrusted" },
    placementState: { style: {} },
  }, resolution), {
    href: `/documents/${DOCUMENT_REVISION_ID}`,
    label: "Open document",
  })

  assert.deepEqual(openActionForAtlasNode({
    availability: "resolved",
    display: { href: `/documents/${DOCUMENT_REVISION_ID}` },
    placementState: { style: {} },
  }), {
    href: `/documents/${DOCUMENT_REVISION_ID}`,
    label: "Open canonical view",
  })
  assert.deepEqual(openActionForAtlasNode({
    availability: "resolved",
    display: {},
    placementState: { style: {} },
  }, {
    ...resolution,
    handles: [{ href: "/documents/untrusted" }],
  }), {
    href: "/documents/untrusted",
    label: "Open canonical view",
  })

  for (const invalid of [
    { ...assembled.results[0], documentRevisionId: "not-a-uuid" },
    {
      ...assembled.results[0],
      documentRevisionId: "50000000-0000-4000-8000-000000000002",
    },
  ]) {
    const rejected = await hydrateAtlasObjectReferences([reference], {
      fetcher: async () => response([invalid]),
    })
    assert.deepEqual(rejected.results, [{ requestedRef: reference, status: "request-failed" }])
  }
})

test("Atlas opens an authorized ELN placement in its exact experiment record", () => {
  const experimentId = "experiment/spiral λ"
  const requestedRef = createGalaxyObjectReference("eln.experiment", experimentId)
  const resolvedRef = createGalaxyObjectReference("eln.experiment", experimentId, {
    mode: "pinned",
    revision: "version:7",
  })
  const node = {
    subjectRef: requestedRef,
    availability: "resolved",
    display: { href: "/eln/experiment/untrusted" },
    placementState: { style: {} },
  }
  const hydration = {
    status: "resolved",
    resolvedRef,
    handles: [{ href: `/graph?ref=${encodeURIComponent(resolvedRef)}` }],
  }

  assert.equal(
    openHrefForAtlasNode(node, hydration),
    `/eln/experiment/${encodeURIComponent(experimentId)}`,
  )
})

test("Atlas ELN routes fail closed for unavailable or mismatched resolutions", () => {
  const requestedRef = createGalaxyObjectReference("eln.experiment", "experiment-1")
  const node = {
    subjectRef: requestedRef,
    availability: "resolved",
    display: { href: "/eln/experiment/untrusted" },
    placementState: { style: {} },
  }

  assert.equal(openHrefForAtlasNode(node, { status: "unavailable" }), undefined)
  assert.equal(openHrefForAtlasNode(node, {
    status: "resolved",
    resolvedRef: createGalaxyObjectReference("eln.experiment", "experiment-2"),
    handles: [{ href: "/graph?ref=wrong" }],
  }), undefined)
  assert.equal(openHrefForAtlasNode(node, {
    status: "resolved",
    resolvedRef: createGalaxyObjectReference("paper", "experiment-1"),
    handles: [{ href: "/graph?ref=wrong-kind" }],
  }), undefined)
})

test("Atlas keeps generic resolver handles for non-ELN objects", () => {
  for (const kind of ["paper", "ham.task", "proof.node"]) {
    const subjectRef = createGalaxyObjectReference(kind, `${kind}-1`)
    const href = `/graph?ref=${encodeURIComponent(subjectRef)}`
    assert.equal(openHrefForAtlasNode({
      subjectRef,
      availability: "resolved",
      display: { href: "/untrusted" },
      placementState: { style: {} },
    }, {
      status: "resolved",
      resolvedRef: subjectRef,
      handles: [{ href }],
    }), href)
    assert.deepEqual(openActionForAtlasNode({
      subjectRef,
      availability: "resolved",
      display: { href: "/untrusted" },
      placementState: { style: {} },
    }, {
      status: "resolved",
      resolvedRef: subjectRef,
      handles: [{ href }],
    }), { href, label: "Open canonical view" })
  }
})

test("Atlas names only resolver-approved exact chat handles as conversation trees", () => {
  const conversationId = "80000000-0000-4000-8000-000000000001"
  const chatRef = createGalaxyObjectReference("chat", conversationId, {
    mode: "pinned",
    revision: `sha256:${HASH}`,
  })
  const href = conversationGraphHref(chatRef)
  const data = {
    subjectRef: chatRef,
    availability: "resolved",
    display: { href: "/untrusted" },
    placementState: { style: {} },
  }

  assert.deepEqual(openActionForAtlasNode(data, {
    status: "resolved",
    requestedRef: chatRef,
    resolvedRef: chatRef,
    handles: [{ href }],
  }), { href, label: "Open conversation tree" })

  assert.deepEqual(openActionForAtlasNode(data, {
    status: "resolved",
    requestedRef: chatRef,
    resolvedRef: chatRef,
    handles: [{ href: "/graph?mode=conversation" }],
  }), { href: "/graph?mode=conversation", label: "Open canonical view" })

  const latestChatRef = createGalaxyObjectReference("chat", conversationId)
  assert.deepEqual(openActionForAtlasNode({ ...data, subjectRef: latestChatRef }, {
    status: "resolved",
    requestedRef: latestChatRef,
    resolvedRef: chatRef,
    handles: [{ href }],
  }), { href, label: "Open canonical view" })

  const otherChatRef = createGalaxyObjectReference("chat", "80000000-0000-4000-8000-000000000002", {
    mode: "pinned",
    revision: `sha256:${"b".repeat(64)}`,
  })
  for (const mismatchedSubjectRef of [
    otherChatRef,
    createGalaxyObjectReference("document", "document-1", { mode: "pinned", revision: `sha256:${HASH}` }),
  ]) {
    assert.deepEqual(openActionForAtlasNode({ ...data, subjectRef: mismatchedSubjectRef }, {
      status: "resolved",
      requestedRef: chatRef,
      resolvedRef: chatRef,
      handles: [{ href }],
    }), { href, label: "Open canonical view" })
  }
})

test("chunks at 64 references and bounds concurrent public requests", async () => {
  const references = Array.from({ length: 130 }, (_, index) => taskRef(index))
  const chunkSizes = []
  let active = 0
  let maximumActive = 0
  const hydrated = await hydrateAtlasObjectReferences(references, {
    concurrency: 2,
    fetcher: async (_url, init) => {
      const request = JSON.parse(init.body)
      chunkSizes.push(request.references.length)
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return response(request.references.map((reference) => ({
        requestedRef: reference,
        status: "unavailable",
      })))
    },
  })

  assert.deepEqual(chunkSizes.sort((left, right) => right - left), [64, 64, 2])
  assert.equal(maximumActive, 2)
  assert.deepEqual(hydrated.references, references)
  assert.deepEqual(hydrated.results.map((item) => item.requestedRef), references)
  assert.ok(hydrated.results.every((item) => item.status === "unavailable"))
})

test("chunks long canonical references below the public request byte cap", async () => {
  const references = Array.from({ length: 64 }, (_, index) =>
    createGalaxyObjectReference("paper", `${index}-${"é".repeat(500)}`))
  const bodies = []
  const hydrated = await hydrateAtlasObjectReferences(references, {
    fetcher: async (_url, init) => {
      bodies.push(init.body)
      const request = JSON.parse(init.body)
      return response(request.references.map((reference) => ({
        requestedRef: reference,
        status: "unavailable",
      })))
    },
  })

  assert.ok(bodies.length > 1)
  assert.ok(bodies.every((body) =>
    new TextEncoder().encode(body).byteLength <= MAX_OBJECT_PROJECTION_REQUEST_BYTES))
  assert.deepEqual(hydrated.results.map((item) => item.requestedRef), references)
})

test("clamps excessive requested concurrency", async () => {
  const references = Array.from({ length: 64 * 9 }, (_, index) => taskRef(index))
  let active = 0
  let maximumActive = 0
  await hydrateAtlasObjectReferences(references, {
    concurrency: 10_000,
    fetcher: async (_url, init) => {
      const request = JSON.parse(init.body)
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return response(request.references.map((reference) => ({
        requestedRef: reference,
        status: "unavailable",
      })))
    },
  })
  assert.equal(maximumActive, 8)
})

test("marks only a failed request chunk and preserves stable result order", async () => {
  const references = Array.from({ length: 65 }, (_, index) => taskRef(index))
  let call = 0
  const hydrated = await hydrateAtlasObjectReferences(references, {
    concurrency: 1,
    fetcher: async (_url, init) => {
      call += 1
      const request = JSON.parse(init.body)
      if (call === 1) throw new Error("network offline")
      return response(request.references.map((reference) => ({
        requestedRef: reference,
        status: "unavailable",
      })))
    },
  })

  assert.ok(hydrated.results.slice(0, 64).every((item) => item.status === "request-failed"))
  assert.equal(hydrated.results[64].status, "unavailable")
  assert.deepEqual(hydrated.results.map((item) => item.requestedRef), references)
})

test("malformed, reordered, oversized, and non-success responses fail closed by chunk", async () => {
  const reference = taskRef(1)
  const malformedResponses = [
    () => response([{ requestedRef: taskRef(2), status: "unavailable" }]),
    () => new Response("not json", { status: 200 }),
    () => new Response(JSON.stringify({ schemaId: "wrong", results: [] }), { status: 200 }),
    () => new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200 }),
    () => new Response(null, { status: 503 }),
  ]

  for (const createResponse of malformedResponses) {
    const hydrated = await hydrateAtlasObjectReferences([reference], {
      fetcher: async () => createResponse(),
    })
    assert.deepEqual(hydrated.results, [{ requestedRef: reference, status: "request-failed" }])
  }
})

test("cancels unread response streams on every pre-reader rejection", async () => {
  const reference = taskRef(1)
  const cases = [
    { status: 200, headers: { "Content-Type": "text/plain" } },
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(2 * 1024 * 1024 + 1),
      },
    },
    { status: 503, headers: { "Content-Type": "application/json" } },
  ]

  for (const responseInit of cases) {
    let cancelled = false
    const body = new ReadableStream({ cancel() { cancelled = true } })
    const hydrated = await hydrateAtlasObjectReferences([reference], {
      fetcher: async () => new Response(body, responseInit),
    })
    assert.equal(cancelled, true)
    assert.deepEqual(hydrated.results, [{ requestedRef: reference, status: "request-failed" }])
  }
})

test("passes AbortSignal to fetch and stops unstarted chunks after abort", async () => {
  const references = Array.from({ length: 65 }, (_, index) => taskRef(index))
  const controller = new AbortController()
  let calls = 0
  const hydrated = await hydrateAtlasObjectReferences(references, {
    concurrency: 1,
    signal: controller.signal,
    fetcher: async (_url, init) => {
      calls += 1
      assert.equal(init.signal, controller.signal)
      controller.abort()
      throw controller.signal.reason
    },
  })

  assert.equal(calls, 1)
  assert.ok(hydrated.results.every((item) => item.status === "request-failed"))
  assert.deepEqual(hydrated.results.map((item) => item.requestedRef), references)
})
