import assert from "node:assert/strict"
import test from "node:test"

import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import { conversationGraphHref } from "../lib/conversation-collection-client.js"
import { BUILTIN_GENEROUS_SURFACE_RENDERER } from "../lib/surface-renderer-registry.js"
import {
  GALAXY_OBJECT_PROJECTION_RESOLUTION_REQUEST_SCHEMA_ID,
  GALAXY_OBJECT_PROJECTION_RESOLUTION_RESPONSE_SCHEMA_ID,
  GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID,
  GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID_V2,
  GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID_V1,
  GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID,
  GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID_V2,
  GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID_V1,
  MAX_OBJECT_PROJECTION_REFERENCES,
  MAX_OBJECT_PROJECTION_RESPONSE_BYTES,
  assembleObjectProjectionResolutionResponse,
  createObjectProjectionOpenHandles,
  createObjectProjectionSourceRequest,
  parseObjectProjectionResolutionRequest,
  parseObjectProjectionResolutionResponse,
  parseObjectProjectionSourceRequest,
  parseObjectProjectionSourceResponse,
  serializeObjectProjectionResolutionResponse,
} from "../lib/object-projection-resolution.js"

const HASH = "a".repeat(64)
const OTHER_HASH = "b".repeat(64)
const DOCUMENT_REVISION_ID = "50000000-0000-4000-8000-000000000001"
const OTHER_REVISION_ID = "50000000-0000-4000-8000-000000000002"
const DOCUMENT_ID = "40000000-0000-4000-8000-000000000001"
const CHAT_ID = "80000000-0000-4000-8000-000000000001"
const DOCUMENT_REF = createGalaxyObjectReference("document", DOCUMENT_ID, {
  mode: "pinned", revision: `sha256:${OTHER_HASH}`,
})
const CHAT_REF = createGalaxyObjectReference("chat", CHAT_ID, {
  mode: "pinned", revision: `sha256:${HASH}`,
})

function publicRequest(references) {
  return { schemaId: GALAXY_OBJECT_PROJECTION_RESOLUTION_REQUEST_SCHEMA_ID, references }
}

function sourceResponse(results) {
  return { schemaId: GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID, results }
}

function resolved(requestedRef, resolvedRef, provider, sourceKind, source) {
  return { requestedRef, status: "resolved", resolvedRef, provider, sourceKind, source }
}

function chatSource(overrides = {}) {
  return {
    conversationId: CHAT_ID,
    workspaceId: "research-field",
    title: "Pinned research chat",
    goalSummary: "Compare exact proof obligations.",
    version: 5,
    contentSha256: HASH,
    turnCount: 4,
    branchCount: 2,
    ...overrides,
  }
}

test("public and private requests require exact schema, canonical unique refs, and preserve order", () => {
  const refs = [
    createGalaxyObjectReference("paper", "paper-1"),
    createGalaxyObjectReference("ham.task", "task-1"),
  ]
  const request = parseObjectProjectionResolutionRequest(publicRequest(refs))
  assert.deepEqual(request.references, refs)
  assert.ok(Object.isFrozen(request) && Object.isFrozen(request.references))
  assert.deepEqual(createObjectProjectionSourceRequest(request), {
    schemaId: GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID,
    references: refs,
  })
  assert.deepEqual(parseObjectProjectionSourceRequest({
    schemaId: GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID,
    references: refs,
  }).references, refs)

  assert.throws(() => parseObjectProjectionResolutionRequest({ ...publicRequest(refs), tenantId: "leak" }), /tenantId/)
  assert.throws(() => parseObjectProjectionResolutionRequest(publicRequest([refs[0], refs[0]])), /duplicate/)
  assert.throws(() => parseObjectProjectionResolutionRequest(publicRequest([])), /between 1 and 64/)
  assert.throws(() => parseObjectProjectionResolutionRequest(publicRequest(
    Array.from({ length: MAX_OBJECT_PROJECTION_REFERENCES + 1 }, (_, index) => (
      createGalaxyObjectReference("paper", `paper-${index}`)
    )),
  )), /between 1 and 64/)
  assert.throws(() => parseObjectProjectionResolutionRequest(publicRequest([
    "gb:object:v1:paper:paper%2d1:latest",
  ])), /canonical serialization/)
  assert.throws(() => parseObjectProjectionResolutionRequest(publicRequest(["gb:entity:legacy"])), /canonical/)
})

test("private source response is an exact ordered resolved or unavailable union", () => {
  const paperLatest = createGalaxyObjectReference("paper", "paper-1")
  const paperPinned = createGalaxyObjectReference("paper", "paper-1", {
    mode: "pinned", revision: `sha256:${HASH}`,
  })
  const task = createGalaxyObjectReference("ham.task", "task-1")
  const request = createObjectProjectionSourceRequest(publicRequest([paperLatest, task]))
  const response = parseObjectProjectionSourceResponse(sourceResponse([
    resolved(paperLatest, paperPinned, "galaxy.paper", "paper", {
      paper: { id: "paper-1", title: "Paper", abstract: "Evidence", metadataHash: HASH },
      revision: { id: "revision-1", metadataHash: HASH },
    }),
    { requestedRef: task, status: "unavailable" },
  ]), request)
  assert.equal(response.results[0].resolvedRef, paperPinned)
  assert.equal(response.results[0].source.revision.document, null)
  assert.deepEqual(response.results[1], { requestedRef: task, status: "unavailable" })
  assert.ok(Object.isFrozen(response.results[0].source.paper))

  assert.throws(() => parseObjectProjectionSourceResponse(sourceResponse([
    { requestedRef: task, status: "unavailable" },
    resolved(paperLatest, paperPinned, "galaxy.paper", "paper", {
      paper: { id: "paper-1", title: "Paper", metadataHash: HASH },
      revision: { id: "revision-1", metadataHash: HASH },
    }),
  ]), request), /out of order/)
  assert.throws(() => parseObjectProjectionSourceResponse(sourceResponse([
    { requestedRef: paperLatest, status: "unavailable", reason: "not found" },
    { requestedRef: task, status: "unavailable" },
  ]), request), /reason/)
})

test("source response fails closed on identity, revision, owner, source-kind, and raw fields", () => {
  const paperPinned = createGalaxyObjectReference("paper", "paper-1", {
    mode: "pinned", revision: `sha256:${HASH}`,
  })
  const otherRevision = createGalaxyObjectReference("paper", "paper-1", {
    mode: "pinned", revision: `sha256:${OTHER_HASH}`,
  })
  const otherPaper = createGalaxyObjectReference("paper", "paper-2", {
    mode: "pinned", revision: `sha256:${HASH}`,
  })
  const source = {
    paper: { id: "paper-1", title: "Paper", metadataHash: HASH },
    revision: { id: "revision-1", metadataHash: HASH },
  }
  const request = {
    schemaId: GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID,
    references: [paperPinned],
  }
  for (const invalid of [
    resolved(paperPinned, otherRevision, "galaxy.paper", "paper", source),
    resolved(paperPinned, otherPaper, "galaxy.paper", "paper", source),
    resolved(paperPinned, paperPinned, "untrusted", "paper", source),
    resolved(paperPinned, paperPinned, "galaxy.paper", "surface", source),
    resolved(paperPinned, paperPinned, "galaxy.paper", "paper", {
      ...source,
      rawBody: "canonical record must not cross the boundary",
    }),
    resolved(paperPinned, paperPinned, "galaxy.paper", "paper", {
      ...source,
      paper: { ...source.paper, secret: "do not disclose" },
    }),
  ]) {
    assert.throws(() => parseObjectProjectionSourceResponse(sourceResponse([invalid]), request))
  }
})

test("pinned chat source accepts only the bounded revision summary and rejects drift or raw records", () => {
  const request = {
    schemaId: GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID,
    references: [CHAT_REF],
  }
  const valid = resolved(CHAT_REF, CHAT_REF, "galaxy.conversation", "chat", chatSource())
  const parsed = parseObjectProjectionSourceResponse(sourceResponse([valid]), request)
  assert.deepEqual(parsed.results[0].source, chatSource())
  assert.ok(Object.isFrozen(parsed.results[0].source))

  const otherId = "80000000-0000-4000-8000-000000000002"
  const otherRef = createGalaxyObjectReference("chat", otherId, {
    mode: "pinned", revision: `sha256:${HASH}`,
  })
  const otherRevision = createGalaxyObjectReference("chat", CHAT_ID, {
    mode: "pinned", revision: `sha256:${OTHER_HASH}`,
  })
  for (const invalid of [
    resolved(CHAT_REF, otherRef, "galaxy.conversation", "chat", chatSource()),
    resolved(CHAT_REF, otherRevision, "galaxy.conversation", "chat", chatSource()),
    resolved(CHAT_REF, CHAT_REF, "galaxy.paper", "chat", chatSource()),
    resolved(CHAT_REF, CHAT_REF, "galaxy.conversation", "paper", chatSource()),
    resolved(CHAT_REF, CHAT_REF, "galaxy.conversation", "chat", chatSource({ conversationId: otherId })),
    resolved(CHAT_REF, CHAT_REF, "galaxy.conversation", "chat", chatSource({ contentSha256: OTHER_HASH })),
    resolved(CHAT_REF, CHAT_REF, "galaxy.conversation", "chat", chatSource({ turnCount: 3 })),
    resolved(CHAT_REF, CHAT_REF, "galaxy.conversation", "chat", chatSource({ branchCount: 5 })),
    resolved(CHAT_REF, CHAT_REF, "galaxy.conversation", "chat", chatSource({ workspaceId: "../other" })),
    resolved(CHAT_REF, CHAT_REF, "galaxy.conversation", "chat", chatSource({ turns: [] })),
    resolved(CHAT_REF, CHAT_REF, "galaxy.conversation", "chat", chatSource({ messages: [] })),
    resolved(CHAT_REF, CHAT_REF, "galaxy.conversation", "chat", chatSource({ artifacts: [] })),
    resolved(CHAT_REF, CHAT_REF, "galaxy.conversation", "chat", chatSource({ rawBody: "secret" })),
    resolved(CHAT_REF, CHAT_REF, "galaxy.conversation", "chat", chatSource({ content: "secret" })),
  ]) {
    assert.throws(() => parseObjectProjectionSourceResponse(sourceResponse([invalid]), request))
  }
})

test("pinned chat assembly preserves Graph parity and derives one fixed conversation handle", () => {
  const response = assembleObjectProjectionResolutionResponse(
    publicRequest([CHAT_REF]),
    sourceResponse([resolved(
      CHAT_REF, CHAT_REF, "galaxy.conversation", "chat", chatSource(),
    )]),
  )
  const item = response.results[0]
  assert.equal(item.projection.ref, CHAT_REF)
  assert.equal(item.projection.kind, "chat")
  assert.deepEqual(item.projection.revision, {
    policy: "pinned", id: `sha256:${HASH}`, contentHash: HASH,
  })
  assert.equal(item.projection.mediaType, "application/vnd.galaxy.conversation+json")
  assert.deepEqual(item.projection.representations, [])
  assert.deepEqual(item.projection.provenance, {
    provider: "galaxy.conversation",
    sourceId: CHAT_ID,
    sourceRevision: `sha256:${HASH}`,
    statement: "Immutable tenant-scoped conversation state.",
  })
  assert.deepEqual(item.projection.capabilities, ["open", "place", "branch", "cite", "inspect", "relate"])
  assert.deepEqual(item.handles, [{
    rel: "open",
    method: "GET",
    href: conversationGraphHref(CHAT_REF),
  }])
  assert.equal(JSON.stringify(item).includes("turns"), false)
  assert.equal(JSON.stringify(item).includes("artifacts"), false)

  assert.deepEqual(parseObjectProjectionResolutionResponse(response, publicRequest([CHAT_REF])), response)
  for (const handles of [
    [],
    [{ rel: "open", method: "GET", href: `/graph?ref=${encodeURIComponent(CHAT_REF)}` }],
    [{ rel: "open", method: "GET", href: "https://evil.example/chat" }],
  ]) {
    assert.throws(() => parseObjectProjectionResolutionResponse({
      schemaId: GALAXY_OBJECT_PROJECTION_RESOLUTION_RESPONSE_SCHEMA_ID,
      results: [{ ...item, handles }],
    }, publicRequest([CHAT_REF])), /fixed|handle|same-origin/)
  }
})

test("private response version must exactly match the negotiated request version", () => {
  const paper = createGalaxyObjectReference("paper", "paper-1")
  const unavailable = [{ requestedRef: paper, status: "unavailable" }]
  const v2Request = {
    schemaId: GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID,
    references: [paper],
  }
  const v1Request = {
    schemaId: GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID_V1,
    references: [paper],
  }
  assert.throws(() => parseObjectProjectionSourceResponse({
    schemaId: GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID_V1,
    results: unavailable,
  }, v2Request), /does not match request schema/)
  assert.throws(() => parseObjectProjectionSourceResponse({
    schemaId: GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID,
    results: unavailable,
  }, v1Request), /does not match request schema/)
})

test("paper document projection requires one exact pinned durable document identity", () => {
  const paperPinned = createGalaxyObjectReference("paper", "paper-1", {
    mode: "pinned", revision: `sha256:${HASH}`,
  })
  const baseDocument = {
    ref: DOCUMENT_REF,
    documentId: DOCUMENT_ID,
    revisionId: DOCUMENT_REVISION_ID,
    revisionSha256: OTHER_HASH,
    contentSha256: HASH,
    mediaType: "application/pdf",
    displayFilename: "paper.pdf",
  }
  const response = (document) => sourceResponse([resolved(
    paperPinned,
    paperPinned,
    "galaxy.paper",
    "paper",
    {
      paper: { id: "paper-1", title: "Paper", metadataHash: HASH },
      revision: { id: "revision-1", metadataHash: HASH, document },
    },
  )])
  const request = publicRequest([paperPinned])
  assert.doesNotThrow(() => parseObjectProjectionSourceResponse(response(baseDocument), request))
  for (const document of [
    { ...baseDocument, ref: createGalaxyObjectReference("paper", DOCUMENT_ID, { mode: "pinned", revision: `sha256:${OTHER_HASH}` }) },
    { ...baseDocument, ref: createGalaxyObjectReference("document", "another-document", { mode: "pinned", revision: `sha256:${OTHER_HASH}` }) },
    { ...baseDocument, ref: createGalaxyObjectReference("document", DOCUMENT_ID) },
    { ...baseDocument, ref: createGalaxyObjectReference("document", DOCUMENT_ID, { mode: "pinned", revision: `sha256:${HASH}` }) },
  ]) {
    assert.throws(
      () => parseObjectProjectionSourceResponse(response(document), request),
      /does not pin the supplied document revision/,
    )
  }
})

test("v1 paper sources remain readable during rollout without inventing a durable document", () => {
  const paperPinned = createGalaxyObjectReference("paper", "paper-1", {
    mode: "pinned", revision: `sha256:${HASH}`,
  })
  const response = parseObjectProjectionSourceResponse({
    schemaId: "gb.object-projection-source-response.v1",
    results: [resolved(paperPinned, paperPinned, "galaxy.paper", "paper", {
      paper: { id: "paper-1", title: "Paper", metadataHash: HASH },
      revision: {
        id: "revision-1",
        metadataHash: HASH,
        document: {
          contentSha256: OTHER_HASH,
          mediaType: "application/pdf",
          filename: "legacy-paper.pdf",
        },
      },
    })],
  }, {
    schemaId: "gb.object-projection-source-request.v1",
    references: [paperPinned],
  })
  assert.equal(response.schemaId, "gb.object-projection-source-response.v1")
  assert.equal(response.results[0].source.revision.document, null)
})

test("v1 surface sources remain readable during rollout but cannot authorize placement", () => {
  const surface = createGalaxyObjectReference("surface", "surface-1", {
    mode: "pinned", revision: `sha256:${HASH}`,
  })
  const source = parseObjectProjectionSourceResponse({
    schemaId: GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID_V1,
    results: [resolved(surface, surface, "galaxy.surface", "surface", {
      id: "surface-1",
      title: "Legacy promoted surface",
      status: "promoted",
      catalogId: "generous.a2ui",
      currentVersion: 3,
      currentContentHash: HASH,
    })],
  }, {
    schemaId: GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID_V1,
    references: [surface],
  })
  assert.equal(source.results[0].source.placementEligible, false)
})

test("v2 surface sources remain byte-compatible during rollout and cannot authorize placement", () => {
  const surface = createGalaxyObjectReference("surface", "surface-1", {
    mode: "pinned", revision: `sha256:${HASH}`,
  })
  const source = parseObjectProjectionSourceResponse({
    schemaId: GALAXY_OBJECT_PROJECTION_SOURCE_RESPONSE_SCHEMA_ID_V2,
    results: [resolved(surface, surface, "galaxy.surface", "surface", {
      id: "surface-1",
      title: "Existing v2 promoted surface",
      status: "promoted",
      catalogId: "generous.a2ui",
      currentVersion: 3,
      currentContentHash: HASH,
    })],
  }, {
    schemaId: GALAXY_OBJECT_PROJECTION_SOURCE_REQUEST_SCHEMA_ID_V2,
    references: [surface],
  })
  assert.equal(source.results[0].source.placementEligible, false)
  assert.equal(source.results[0].source.schemaDigest, undefined)
})

test("assembly projects local and HAM sources and derives only the fixed same-origin handle", () => {
  const paperLatest = createGalaxyObjectReference("paper", "paper-1")
  const paperPinned = createGalaxyObjectReference("paper", "paper-1", {
    mode: "pinned", revision: `sha256:${HASH}`,
  })
  const experiment = createGalaxyObjectReference("eln.experiment", "experiment-1")
  const task = createGalaxyObjectReference("ham.task", "task-1")
  const memory = createGalaxyObjectReference("ham.memory", "42")
  const response = assembleObjectProjectionResolutionResponse(
    publicRequest([paperLatest, experiment, task, memory]),
    sourceResponse([
      resolved(paperLatest, paperPinned, "galaxy.paper", "paper", {
        paper: { id: "paper-1", title: "Paper", abstract: "Evidence", metadataHash: HASH },
        revision: {
          id: "revision-1",
          metadataHash: HASH,
          document: {
            ref: DOCUMENT_REF,
            documentId: DOCUMENT_ID,
            revisionId: DOCUMENT_REVISION_ID,
            revisionSha256: OTHER_HASH,
            contentSha256: OTHER_HASH,
            mediaType: "application/pdf",
            displayFilename: "paper.pdf",
          },
        },
      }),
      resolved(experiment, experiment, "galaxy-brain-eln", "eln.experiment", {
        id: "experiment-1",
        title: "Experiment",
        results: "",
        interpretation: "Supported",
        updatedAt: "2026-09-24T12:00:00Z",
      }),
      resolved(task, task, "ham", "ham.task", {
        id: "task-1", title: "Task", goal: "Do work", why: "Evidence", version: 2,
      }),
      resolved(memory, memory, "ham", "ham.memory", {
        id: "42", title: "Memory", content: "Bounded context", version: 3,
      }),
    ]),
  )
  assert.deepEqual(response.results.map((item) => item.projection.kind), [
    "paper", "eln.experiment", "ham.task", "ham.memory",
  ])
  assert.equal(response.results[0].projection.ref, paperPinned)
  assert.equal(response.results[1].projection.provenance.provider, "galaxy-brain-eln")
  assert.equal(response.results[1].projection.summary, "Supported")
  assert.equal(response.results[2].projection.revision.policy, "latest")
  assert.deepEqual(response.results[0].handles, [{
    rel: "open",
    method: "GET",
    href: `/graph?ref=${encodeURIComponent(paperPinned)}`,
  }])
  assert.deepEqual(response.results[3].handles, [{
    rel: "open",
    method: "GET",
    href: `/graph?ref=${encodeURIComponent(memory)}`,
  }])
  assert.ok(Object.isFrozen(response.results[0].projection))
})

test("assembly projects document, anchor, proof, and surface without copying canonical bodies", () => {
  const documentLatest = createGalaxyObjectReference("document", "document-1")
  const documentPinned = createGalaxyObjectReference("document", "document-1", {
    mode: "pinned", revision: `sha256:${HASH}`,
  })
  const anchorId = `sha256:${OTHER_HASH}`
  const anchor = createGalaxyObjectReference("document.anchor", anchorId, {
    mode: "pinned", revision: `sha256:${HASH}`,
  })
  const proof = createGalaxyObjectReference("proof.graph", "proof-1", {
    mode: "pinned", revision: `sha256:${HASH}`,
  })
  const surfaceLatest = createGalaxyObjectReference("surface", "surface-1")
  const surfacePinned = createGalaxyObjectReference("surface", "surface-1", {
    mode: "pinned", revision: `sha256:${HASH}`,
  })
  const response = assembleObjectProjectionResolutionResponse(
    publicRequest([documentLatest, anchor, proof, surfaceLatest]),
    sourceResponse([
      resolved(documentLatest, documentPinned, "galaxy.document", "document", {
        documentId: "document-1",
        revisionId: DOCUMENT_REVISION_ID,
        revisionSha256: HASH,
        title: "Document",
        displayFilename: "source.pdf",
        mediaType: "application/pdf",
        representations: [{
          id: "rep-1", kind: "text", mediaType: "text/plain", contentSha256: OTHER_HASH,
        }],
      }),
      resolved(anchor, anchor, "galaxy.document", "document.anchor", {
        id: anchorId,
        representationSha256: HASH,
        anchorSha256: OTHER_HASH,
        title: "Document",
        selector: { kind: "text-quote", exact: "Exact evidence" },
      }),
      resolved(proof, proof, "galaxy.proof", "proof.graph", {
        graphId: "proof-1", contentSha256: HASH, title: "Proof",
      }),
      resolved(surfaceLatest, surfacePinned, "galaxy.surface", "surface", {
        id: "surface-1",
        title: "Surface",
        status: "promoted",
        catalogId: "generous.a2ui",
        currentVersion: 4,
        currentContentHash: HASH,
        schemaDigest: BUILTIN_GENEROUS_SURFACE_RENDERER.schemaDigest,
        catalogDigest: BUILTIN_GENEROUS_SURFACE_RENDERER.catalogDigest,
        rendererVersion: BUILTIN_GENEROUS_SURFACE_RENDERER.rendererVersion,
        placementEligible: true,
      }),
    ]),
  )
  assert.deepEqual(response.results.map((item) => item.projection.kind), [
    "document", "document.anchor", "proof.graph", "surface",
  ])
  assert.equal(response.results[0].projection.representations[0].contentHash, OTHER_HASH)
  assert.equal(response.results[0].documentRevisionId, DOCUMENT_REVISION_ID)
  assert.deepEqual(response.results[0].handles, [{
    rel: "open",
    method: "GET",
    href: `/documents/${DOCUMENT_REVISION_ID}`,
  }])
  assert.equal(response.results[1].handles[0].href, `/graph?ref=${encodeURIComponent(anchor)}`)
  assert.equal(response.results[2].handles[0].href, `/graph?ref=${encodeURIComponent(proof)}`)
  assert.equal(response.results[3].handles[0].href, `/graph?ref=${encodeURIComponent(surfacePinned)}`)
  assert.equal(response.results[1].projection.summary, "Exact evidence")
  assert.equal(response.results[2].projection.revision.contentHash, HASH)
  assert.equal(response.results[3].projection.provenance.sourceRevision, "version:4")
})

test("surface placement fails closed when the persisted renderer contract drifts", () => {
  const surface = createGalaxyObjectReference("surface", "surface-1", {
    mode: "pinned", revision: `sha256:${HASH}`,
  })
  const response = assembleObjectProjectionResolutionResponse(
    publicRequest([surface]),
    sourceResponse([resolved(surface, surface, "galaxy.surface", "surface", {
      id: "surface-1",
      title: "Stale surface contract",
      status: "promoted",
      catalogId: "generous.a2ui",
      currentVersion: 4,
      currentContentHash: HASH,
      schemaDigest: BUILTIN_GENEROUS_SURFACE_RENDERER.schemaDigest,
      catalogDigest: BUILTIN_GENEROUS_SURFACE_RENDERER.catalogDigest,
      rendererVersion: "stale-renderer-contract",
      placementEligible: true,
    })]),
  )
  assert.ok(!response.results[0].projection.capabilities.includes("place"))
})

test("surfaces saved under an earlier, compatible catalog stay placeable", () => {
  const surface = createGalaxyObjectReference("surface", "surface-1", {
    mode: "pinned", revision: `sha256:${HASH}`,
  })
  const capabilitiesFor = (catalogDigest) => assembleObjectProjectionResolutionResponse(
    publicRequest([surface]),
    sourceResponse([resolved(surface, surface, "galaxy.surface", "surface", {
      id: "surface-1",
      title: "Surface saved before SVGPreview",
      status: "promoted",
      catalogId: "generous.a2ui",
      currentVersion: 4,
      currentContentHash: HASH,
      schemaDigest: BUILTIN_GENEROUS_SURFACE_RENDERER.schemaDigest,
      catalogDigest,
      rendererVersion: BUILTIN_GENEROUS_SURFACE_RENDERER.rendererVersion,
      placementEligible: true,
    })]),
  ).results[0].projection.capabilities

  assert.ok(capabilitiesFor(BUILTIN_GENEROUS_SURFACE_RENDERER.catalogDigest).includes("place"))
  assert.ok(capabilitiesFor("c2ac06907552b576c9967a85779c539d83ea6b81dab7129058a056e791c5e375").includes("place"))
  assert.ok(!capabilitiesFor("d".repeat(64)).includes("place"))
})

test("document handles require authorized revision provenance bound to the pinned reference", () => {
  const document = createGalaxyObjectReference("document", "document-1", {
    mode: "pinned", revision: `sha256:${HASH}`,
  })
  const source = {
    documentId: "document-1",
    revisionId: DOCUMENT_REVISION_ID,
    revisionSha256: HASH,
    title: "Exact document",
    mediaType: "application/pdf",
    representations: [],
  }
  const request = publicRequest([document])

  for (const mediaType of [
    "application/pdf",
    "text/plain",
    "text/x-typescript",
    "text/markdown",
  ]) {
    const response = assembleObjectProjectionResolutionResponse(
      request,
      sourceResponse([resolved(document, document, "galaxy.document", "document", {
        ...source,
        mediaType,
      })]),
    )
    assert.equal(response.results[0].documentRevisionId, DOCUMENT_REVISION_ID)
    assert.equal(response.results[0].handles[0].href, `/documents/${DOCUMENT_REVISION_ID}`)
  }

  const raster = {
    ...source,
    mediaType: "image/png",
    representations: [{
      id: "rep-image", kind: "original", mediaType: "image/png", contentSha256: OTHER_HASH,
    }],
    rasterImage: {
      schemaId: "gb.raster-image.v1",
      format: "png",
      mediaType: "image/png",
      width: 64,
      height: 32,
      channels: 4,
      frameCount: 1,
      byteSize: 4096,
      contentSha256: OTHER_HASH,
    },
  }
  const rasterResponse = assembleObjectProjectionResolutionResponse(
    request,
    sourceResponse([resolved(document, document, "galaxy.document", "document", raster)]),
  )
  assert.equal(rasterResponse.results[0].projection.rasterImage.width, 64)
  assert.equal(rasterResponse.results[0].documentRevisionId, DOCUMENT_REVISION_ID)
  assert.equal(rasterResponse.results[0].handles[0].href, `/documents/${DOCUMENT_REVISION_ID}`)

  for (const invalidSource of [
    { ...source, documentId: "document-2" },
    { ...source, revisionSha256: OTHER_HASH },
    { ...source, revisionId: "not-a-uuid" },
  ]) {
    assert.throws(() => assembleObjectProjectionResolutionResponse(
      request,
      sourceResponse([resolved(document, document, "galaxy.document", "document", invalidSource)]),
    ))
  }

  assert.throws(() => createObjectProjectionOpenHandles(document), /canonical UUID/)
  assert.throws(() => createObjectProjectionOpenHandles(document, "not-a-uuid"), /canonical UUID/)

  const assembled = assembleObjectProjectionResolutionResponse(
    request,
    sourceResponse([resolved(document, document, "galaxy.document", "document", source)]),
  )
  const item = assembled.results[0]
  assert.throws(() => parseObjectProjectionResolutionResponse({
    schemaId: GALAXY_OBJECT_PROJECTION_RESOLUTION_RESPONSE_SCHEMA_ID,
    results: [{ ...item, documentRevisionId: OTHER_REVISION_ID }],
  }, request), /fixed same-origin/)
  assert.throws(() => parseObjectProjectionResolutionResponse({
    schemaId: GALAXY_OBJECT_PROJECTION_RESOLUTION_RESPONSE_SCHEMA_ID,
    results: [{ ...item, documentRevisionId: "not-a-uuid" }],
  }, request), /canonical UUID/)
})

test("assembly rejects projector identity drift instead of trusting source assertions", () => {
  const requested = createGalaxyObjectReference("paper", "paper-1")
  const claimed = createGalaxyObjectReference("paper", "paper-1", {
    mode: "pinned", revision: `sha256:${HASH}`,
  })
  assert.throws(() => assembleObjectProjectionResolutionResponse(
    publicRequest([requested]),
    sourceResponse([resolved(requested, claimed, "galaxy.paper", "paper", {
      paper: { id: "paper-1", title: "Paper", metadataHash: OTHER_HASH },
      revision: { id: "revision-1", metadataHash: OTHER_HASH },
    })]),
  ), /changed the resolver-owned identity/)
})

test("public response parser rejects extra disclosures, external handles, and mismatched projection identity", () => {
  const reference = createGalaxyObjectReference("ham.task", "task-1")
  const assembled = assembleObjectProjectionResolutionResponse(
    publicRequest([reference]),
    sourceResponse([resolved(reference, reference, "ham", "ham.task", {
      id: "task-1", title: "Task", goal: "Do work",
    })]),
  )
  assert.deepEqual(parseObjectProjectionResolutionResponse(assembled, publicRequest([reference])), assembled)
  const item = assembled.results[0]
  assert.throws(() => parseObjectProjectionResolutionResponse({
    schemaId: GALAXY_OBJECT_PROJECTION_RESOLUTION_RESPONSE_SCHEMA_ID,
    results: [{ ...item, authorization: "secret" }],
  }, publicRequest([reference])), /authorization/)
  assert.throws(() => parseObjectProjectionResolutionResponse({
    schemaId: GALAXY_OBJECT_PROJECTION_RESOLUTION_RESPONSE_SCHEMA_ID,
    results: [{ ...item, handles: [{ rel: "open", method: "GET", href: "https://evil.example/task" }] }],
  }, publicRequest([reference])), /fixed same-origin/)
  assert.throws(() => parseObjectProjectionResolutionResponse({
    schemaId: GALAXY_OBJECT_PROJECTION_RESOLUTION_RESPONSE_SCHEMA_ID,
    results: [{ ...item, projection: { ...item.projection, ref: createGalaxyObjectReference("ham.task", "task-2") } }],
  }, publicRequest([reference])), /projection.ref/)
})

test("public response parser requires the fixed HAM memory graph handle", () => {
  const reference = createGalaxyObjectReference("ham.memory", "42")
  const assembled = assembleObjectProjectionResolutionResponse(
    publicRequest([reference]),
    sourceResponse([resolved(reference, reference, "ham", "ham.memory", {
      id: "42", title: "Memory", content: "Bounded context", version: 3,
    })]),
  )
  assert.deepEqual(assembled.results[0].handles, [{
    rel: "open",
    method: "GET",
    href: `/graph?ref=${encodeURIComponent(reference)}`,
  }])
  assert.throws(() => parseObjectProjectionResolutionResponse({
    schemaId: GALAXY_OBJECT_PROJECTION_RESOLUTION_RESPONSE_SCHEMA_ID,
    results: [{
      ...assembled.results[0],
      handles: [],
    }],
  }, publicRequest([reference])), /must contain exactly the fixed open handle/)
})

test("response serialization is UTF-8 measured and capped at two MiB", () => {
  const refs = Array.from({ length: 64 }, (_, index) => createGalaxyObjectReference("artifact", `artifact-${index}`))
  const results = refs.map((reference, index) => ({
    requestedRef: reference,
    status: "resolved",
    resolvedRef: reference,
    provider: "galaxy.test",
    projection: {
      schemaId: "gb.object-projection.v1",
      ref: reference,
      kind: "artifact",
      revision: { policy: "latest", id: null, contentHash: null },
      title: `Artifact ${index}`,
      representations: Array.from({ length: 32 }, (_, representationIndex) => ({
        ref: `${"r".repeat(990)}-${index}-${representationIndex}`,
        kind: "json",
        mediaType: "application/json",
        contentHash: null,
        label: `Representation ${representationIndex}`,
      })),
      provenance: { provider: "galaxy.test" },
      capabilities: ["open"],
    },
    handles: createObjectProjectionOpenHandles(reference),
  }))
  assert.equal(MAX_OBJECT_PROJECTION_RESPONSE_BYTES, 2_097_152)
  assert.throws(() => serializeObjectProjectionResolutionResponse({
    schemaId: GALAXY_OBJECT_PROJECTION_RESOLUTION_RESPONSE_SCHEMA_ID,
    results,
  }, publicRequest(refs)), RangeError)

  const small = assembleObjectProjectionResolutionResponse(
    publicRequest([refs[0]]),
    sourceResponse([{ requestedRef: refs[0], status: "unavailable" }]),
  )
  assert.deepEqual(JSON.parse(serializeObjectProjectionResolutionResponse(small)), small)
})
