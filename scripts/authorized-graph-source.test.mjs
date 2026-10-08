import assert from "node:assert/strict"
import test from "node:test"

import { buildAuthorizedGraphSource } from "../lib/authorized-graph-source.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import { createGalaxyObjectProjection } from "../lib/object-projection.js"
import { projectChatObject, projectHamMemoryObject, projectSurfaceObject } from "../lib/object-projection-adapters.js"
import { projectUnifiedGraph } from "../lib/unified-graph.js"

const scope = Object.freeze({
  tenantId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "winding-prototime-v1",
})
const hash = (character) => character.repeat(64)
const pinned = (kind, id, revision) => createGalaxyObjectReference(kind, id, { mode: "pinned", revision })
const paperRef = pinned("paper", "paper-1", `sha256:${hash("a")}`)
const anchorId = `sha256:${hash("e")}`
const anchorRef = pinned("document.anchor", anchorId, `sha256:${hash("f")}`)
const experimentRef = createGalaxyObjectReference("eln.experiment", "experiment-1")
const taskRef = createGalaxyObjectReference("ham.task", "task-1")
const surfaceRef = pinned("surface", "surface-1", `sha256:${hash("d")}`)
const documentRef = pinned("document", "document-1", `sha256:${hash("9")}`)
const memoryRef = createGalaxyObjectReference("ham.memory", "42")
const conversationId = "80000000-0000-4000-8000-000000000001"
const chatRef = pinned("chat", conversationId, `sha256:${hash("c")}`)

function documentProjection(title = "Vortex source") {
  return createGalaxyObjectProjection({
    schemaId: "gb.object-projection.v1",
    ref: documentRef,
    kind: "document",
    revision: { policy: "pinned", id: `sha256:${hash("9")}`, contentHash: hash("9") },
    title,
    mediaType: "text/markdown",
    representations: [{
      ref: "gb:representation:document:document-1:markdown",
      kind: "markdown",
      mediaType: "text/markdown",
      contentHash: hash("9"),
    }],
    provenance: { provider: "galaxy.document", sourceId: "document-1", sourceRevision: hash("9") },
    capabilities: ["open", "place", "cite", "relate"],
  })
}

function chatProjection() {
  return projectChatObject({
    conversationId,
    workspaceId: scope.workspaceId,
    title: "Pinned research conversation",
    goalSummary: "Compare the exact evidence and proof obligations.",
    version: 4,
    contentSha256: hash("c"),
    turnCount: 3,
    branchCount: 1,
  })
}

function surfaceProjection() {
  return projectSurfaceObject({
    id: "surface-1",
    title: "Exact promoted surface",
    status: "promoted",
    catalog_id: "generous.a2ui",
    current_version: 2,
    current_content_hash: hash("d"),
  })
}

function query() {
  return {
    rootRef: null,
    mode: "mixed",
    lens: "explore",
    scale: "project",
    viewport: null,
    filters: {},
    validAt: null,
    knownAt: null,
    cursor: null,
  }
}

function fixture() {
  return {
    schemaId: "gb.authorized-graph-source.v1",
    scope,
    query: query(),
    providers: [
      { scope, provider: "galaxy.paper", status: "ready", snapshot: "paper-page-1" },
      { scope, provider: "galaxy-brain-eln", status: "ready", revision: "eln-head-9" },
      { scope, provider: "ham", status: "partial", revision: "task-page-2" },
      { scope, provider: "galaxy.surface", status: "ready", snapshot: "surface-page-1" },
    ],
    papers: [{
      authorized: true,
      scope,
      paper: {
        id: "paper-1",
        arxiv_id: "2401.00001",
        arxiv_version: 1,
        title: "A Vortex Paper",
        abstract: "An exact authorized paper record.",
        authors: [{ name: "A. Author" }],
        categories: ["math.AP"],
        abs_url: "https://arxiv.org/abs/2401.00001",
        pdf_url: "https://arxiv.org/pdf/2401.00001",
        metadata_hash: hash("a"),
        imported_at: "2026-09-23T10:00:00Z",
        updated_at: "2026-09-23T10:00:00Z",
      },
      revision: {
        id: "paper-rev-1",
        paper_id: "paper-1",
        arxiv_version: 1,
        metadata_hash: hash("a"),
        metadata: {},
        imported_at: "2026-09-23T10:00:00Z",
      },
    }],
    anchors: [{
      authorized: true,
      scope,
      anchor: {
        schemaId: "gb.anchor.v1",
        id: anchorId,
        ref: anchorRef,
        document_ref: pinned("document", "document-1", `sha256:${hash("9")}`),
        document_id: "document-1",
        document_revision_id: "30000000-0000-4000-8000-000000000001",
        document_revision_sha256: hash("9"),
        title: "Vortex evidence",
        display_filename: "vortex.pdf",
        representation_id: "30000000-0000-4000-8000-000000000002",
        representation_kind: "document-structure",
        representation_media_type: "application/json",
        representation_sha256: hash("f"),
        selector: { kind: "text-quote", exact: "Exact vortex evidence", prefix: "", suffix: "" },
        selector_kind: "text-quote",
        selector_sha256: hash("7"),
        anchor_sha256: hash("e"),
        source: { id: "source-1", kind: "upload", uri: "private:vortex.pdf" },
        created_at: "2026-09-23T12:00:00Z",
      },
    }],
    experiments: [{
      authorized: true,
      scope,
      record: {
        schemaVersion: "gb.research-record.v1",
        id: "experiment-1",
        kind: "eln-research-record",
        title: "Prototime winding experiment",
        status: "completed",
        domain: "topology",
        tags: ["vortex"],
        sections: [
          { key: "results", title: "Results", content: "Observed a stable winding relation." },
          { key: "interpretation", title: "Interpretation", content: "Candidate relation only." },
        ],
        references: [],
        artifacts: [],
        metrics: [],
        linkedRecordIds: [],
        provenance: {
          source: "galaxy-brain-eln",
          tenantId: scope.tenantId,
          createdAt: "2026-09-23T11:00:00.000Z",
          updatedAt: "2026-09-23T12:00:00.000Z",
        },
      },
    }],
    tasks: [{
      authorized: true,
      scope,
      task: {
        id: "task-1",
        version: 3,
        title: "Check the winding proof",
        goal: "Verify the scoped theorem candidate.",
        why: "The campaign needs an exact dependency.",
        state: "running",
        lifecyclePhase: "running",
        stage: "verification",
        riskMode: "test",
        expectedEffects: [],
        resources: [
          { id: "resource-paper", resourceRef: paperRef, mode: "observe", status: "active" },
          {
            id: "resource-missing",
            resourceRef: createGalaxyObjectReference("paper", "not-authorized"),
            mode: "observe",
            status: "active",
          },
        ],
        conflicts: [],
        projectionSource: "ham",
      },
    }],
    surfaces: [{
      authorized: true,
      scope,
      surface: {
        id: "surface-1",
        tenant_id: scope.tenantId,
        created_by_principal_id: "principal-1",
        title: "Winding explorer",
        status: "promoted",
        schema_version: "gb.surface.v1",
        schema_digest: hash("b"),
        catalog_id: "generous.a2ui",
        catalog_version: "1",
        catalog_digest: hash("c"),
        renderer_version: "1",
        current_version: 2,
        current_content_hash: hash("d"),
        current_spec: {
          schema: "gb.surface.v1",
          catalog: { id: "generous.a2ui", version: "1" },
          surfaceUpdate: { components: [] },
          bindings: [],
        },
        provenance: {},
        created_at: "2026-09-23T10:00:00Z",
        updated_at: "2026-09-23T12:00:00Z",
      },
    }],
    links: [
      {
        authorized: true,
        active: true,
        scope,
        link: {
          id: "link-anchor-task",
          from_ref: anchorRef,
          to_ref: taskRef,
          relation: "context_for",
          basis: "imported",
          provenance: {
            source: "import",
            source_system: "paper-reader",
            source_ref: "operation:paper-task-1",
            source_snapshot: `sha256:${hash("8")}`,
            extractor_version: "1.0.0",
            confidence: 1,
          },
        },
      },
      {
        authorized: true,
        active: true,
        scope,
        link: {
          id: "link-paper-experiment",
          from_ref: paperRef,
          to_ref: experimentRef,
          relation: "context_for",
          basis: "authored",
          provenance: { source: "manual", source_system: "galaxy" },
          created_by_principal_id: "principal-1",
          created_at: "2026-09-23T12:00:00Z",
          version: 1,
        },
      },
      {
        authorized: true,
        active: true,
        scope,
        link: {
          id: "link-task-surface",
          from_ref: taskRef,
          to_ref: surfaceRef,
          relation: "documents",
          basis: "authored",
          provenance: { source: "manual", source_system: "galaxy" },
        },
      },
      {
        authorized: true,
        active: true,
        scope,
        link: {
          id: "link-missing-exact-revision",
          from_ref: paperRef,
          to_ref: pinned("ham.task", "task-1", "version:99"),
          relation: "context_for",
          basis: "authored",
          provenance: { source: "manual", source_system: "galaxy" },
        },
      },
      {
        authorized: true,
        active: false,
        scope,
        link: {
          id: "link-inactive",
          from_ref: paperRef,
          to_ref: taskRef,
          relation: "related",
          basis: "authored",
          provenance: { source: "manual", source_system: "galaxy" },
        },
      },
      {
        authorized: false,
        active: true,
        scope,
        link: {
          id: "link-not-authorized",
          from_ref: paperRef,
          to_ref: taskRef,
          relation: "related",
          basis: "authored",
          provenance: { source: "manual", source_system: "galaxy" },
        },
      },
    ],
  }
}

test("adapts only authorized records into a strict unified graph input", () => {
  const result = buildAuthorizedGraphSource(fixture())
  assert.equal(result.schemaId, "gb.authorized-graph-source-result.v1")
  assert.deepEqual(Object.keys(result.graphInput), [
    "schemaId", "scope", "query", "objects", "external", "links", "relations", "proofContexts", "providers",
  ])
  assert.equal(result.graphInput.schemaId, "gb.graph-projection-input.v1")
  assert.deepEqual(result.graphInput.objects.map((item) => item.projection.ref), [
    anchorRef, experimentRef, taskRef, paperRef, surfaceRef,
  ].sort())
  assert.deepEqual(result.graphInput.links.map((item) => item.link.id).sort(), ["link-anchor-task", "link-paper-experiment", "link-task-surface"])
  assert.deepEqual(result.diagnostics.omitted, {
    unauthorized: { projections: 0, papers: 0, anchors: 0, experiments: 0, tasks: 0, surfaces: 0, links: 1 },
    inactiveLinks: 1,
    missingEndpointLinks: 1,
    taskResourceRelations: 1,
  })
  assert.deepEqual(result.diagnostics.missingEndpointLinks, [{
    linkId: "link-missing-exact-revision",
    missingRefs: [pinned("ham.task", "task-1", "version:99")],
  }])
  assert.deepEqual(result.diagnostics.partialProviders, [{ provider: "ham", status: "partial" }])
  assert.equal(result.graphInput.relations.length, 1)
  assert.deepEqual(result.graphInput.relations[0].relation, {
    fromRef: taskRef,
    toRef: paperRef,
    relation: "references",
    trust: "structure",
    source: {
      provider: "ham",
      recordId: "resource-paper",
      revision: "version:3",
      sourceRef: taskRef,
      resourceMode: "observe",
      resourceStatus: "active",
    },
  })

  const graph = projectUnifiedGraph(result.graphInput)
  assert.equal(graph.nodes.length, 5)
  assert.equal(graph.edges.length, 4)
  const imported = graph.edges.find((edge) => edge.source.recordId === "link-anchor-task")
  assert.equal(imported.source.sourceRef, "operation:paper-task-1")
  assert.equal(imported.source.extractorVersion, "1.0.0")
  assert.equal(imported.source.confidence, 1)
  assert.equal(graph.provenance.diagnostics.danglingEdges, 0)
})

test("admits exact gateway projections without broadening endpoint authorization", () => {
  const input = fixture()
  input.anchors = []
  input.projections = [{ authorized: true, scope, projection: documentProjection() }]
  input.links = [{
    authorized: true,
    active: true,
    scope,
    link: {
      id: "paper-document",
      from_ref: paperRef,
      to_ref: documentRef,
      relation: "corresponds_to",
      basis: "imported",
      provenance: { source: "paper-document-bridge", source_system: "galaxy" },
    },
  }, {
    authorized: true,
    active: true,
    scope,
    link: {
      id: "document-missing-anchor",
      from_ref: documentRef,
      to_ref: anchorRef,
      relation: "context_for",
      basis: "authored",
      provenance: { source: "paper-reader", source_system: "galaxy" },
    },
  }]

  const result = buildAuthorizedGraphSource(input)
  assert.equal(result.graphInput.objects.some((item) => item.projection.ref === documentRef), true)
  assert.deepEqual(result.graphInput.links.map((item) => item.link.id), ["paper-document"])
  assert.deepEqual(result.diagnostics.missingEndpointLinks, [{
    linkId: "document-missing-anchor",
    missingRefs: [anchorRef],
  }])

  input.projections[0].authorized = false
  const unauthorized = buildAuthorizedGraphSource(input)
  assert.equal(unauthorized.graphInput.objects.some((item) => item.projection.ref === documentRef), false)
  assert.equal(unauthorized.diagnostics.omitted.unauthorized.projections, 1)
  assert.equal(unauthorized.graphInput.links.length, 0)
})

test("admits independently authorized HAM memories while keeping authored links endpoint-closed", () => {
  const input = fixture()
  const memoryProjection = projectHamMemoryObject({
    id: "42",
    title: "Vortex memory",
    content: "An authorized HAM memory head.",
    version: 3,
  })
  input.projections = [
    { authorized: true, scope, projection: memoryProjection },
    { authorized: true, scope, projection: documentProjection() },
  ]
  input.links = [{
    authorized: true,
    active: true,
    scope,
    link: {
      id: "memory-document",
      from_ref: memoryRef,
      to_ref: documentRef,
      relation: "context_for",
      basis: "authored",
      provenance: { source: "manual", source_system: "galaxy" },
    },
  }]

  const result = buildAuthorizedGraphSource(input)
  assert.equal(result.graphInput.objects.some((item) => item.projection.ref === documentRef), true)
  assert.equal(result.graphInput.objects.some((item) => item.projection.ref === memoryRef), true)
  assert.deepEqual(result.graphInput.links.map((item) => item.link.id), ["memory-document"])

  input.projections[0].authorized = false
  const denied = buildAuthorizedGraphSource(input)
  assert.equal(denied.graphInput.objects.some((item) => item.projection.ref === memoryRef), false)
  assert.equal(denied.graphInput.links.length, 0)
  assert.deepEqual(denied.diagnostics.missingEndpointLinks, [{
    linkId: "memory-document",
    missingRefs: [memoryRef],
  }])

  input.projections[0] = { authorized: true, scope: { ...scope, workspaceId: "other" }, projection: memoryProjection }
  assert.throws(() => buildAuthorizedGraphSource(input), /crosses the tenant or workspace boundary/u)

  input.projections = [
    { authorized: true, scope, projection: memoryProjection },
    { authorized: true, scope, projection: projectHamMemoryObject({
      id: "42",
      title: "Conflicting title",
      content: "An authorized HAM memory head.",
      version: 3,
    }) },
  ]
  assert.throws(() => buildAuthorizedGraphSource(input), /conflicts with another projection/u)

  const pinnedMemoryRef = pinned("ham.memory", "42", "version:3")
  input.projections = [{
    authorized: true,
    scope,
    projection: createGalaxyObjectProjection({
      ...memoryProjection,
      ref: pinnedMemoryRef,
      revision: { policy: "pinned", id: "version:3" },
    }),
  }]
  assert.throws(() => buildAuthorizedGraphSource(input), /must be a latest canonical HAM memory/u)
})

test("admits exact chat projections and preserves document and HAM link provenance", () => {
  const input = fixture()
  const memoryProjection = projectHamMemoryObject({
    id: "42",
    title: "Vortex memory",
    content: "An authorized HAM memory head.",
    version: 3,
  })
  input.projections = [
    { authorized: true, scope, projection: documentProjection() },
    { authorized: true, scope, projection: chatProjection() },
    { authorized: true, scope, projection: memoryProjection },
  ]
  input.links = [{
    authorized: true,
    active: true,
    scope,
    link: {
      id: "document-chat",
      from_ref: documentRef,
      to_ref: chatRef,
      relation: "context_for",
      basis: "authored",
      provenance: { source: "manual", source_system: "galaxy" },
    },
  }, {
    authorized: true,
    active: true,
    scope,
    link: {
      id: "memory-chat",
      from_ref: memoryRef,
      to_ref: chatRef,
      relation: "context_for",
      basis: "imported",
      provenance: {
        source: "import",
        source_system: "ham-galaxy-link",
        source_ref: "ham:memory:42",
        source_snapshot: `sha256:${hash("7")}`,
        extractor_version: "ham-link@1",
      },
    },
  }]

  const result = buildAuthorizedGraphSource(input)
  const chatObject = result.graphInput.objects.find((item) => item.projection.ref === chatRef)
  assert.equal(Boolean(chatObject), true)
  for (const field of ["turns", "messages", "artifacts", "content", "rawBody"]) {
    assert.equal(Object.hasOwn(chatObject.projection, field), false)
  }
  assert.deepEqual(result.graphInput.links.map((item) => item.link.id), ["document-chat", "memory-chat"])

  const graph = projectUnifiedGraph(result.graphInput)
  assert.equal(graph.nodes.filter((node) => [documentRef, memoryRef, chatRef].includes(node.ref)).length, 3)
  const memoryEdge = graph.edges.find((edge) => edge.source.recordId === "memory-chat")
  assert.equal(memoryEdge.trust, "structure")
  assert.deepEqual(memoryEdge.source, {
    provider: "ledger:ham-galaxy-link",
    recordId: "memory-chat",
    revision: `sha256:${hash("7")}`,
    sourceRef: "ham:memory:42",
    extractorVersion: "ham-link@1",
  })

  input.projections[1] = { authorized: true, scope, projection: {
    ...chatProjection(),
    ref: createGalaxyObjectReference("chat", conversationId),
    revision: { policy: "latest", id: null, contentHash: null },
  } }
  assert.throws(() => buildAuthorizedGraphSource(input), /exact pinned canonical chat/u)
})

test("admits only exact pinned surface projections through the gateway seam", () => {
  const input = fixture()
  input.surfaces = []
  const exact = surfaceProjection()
  input.projections = [{ authorized: true, scope, projection: exact }]

  const result = buildAuthorizedGraphSource(input)
  assert.equal(result.graphInput.objects.some((item) => item.projection.ref === exact.ref), true)

  input.projections = [{ authorized: true, scope, projection: {
    ...exact,
    ref: createGalaxyObjectReference("surface", "surface-1"),
    revision: { policy: "latest", id: null, contentHash: null },
  } }]
  assert.throws(() => buildAuthorizedGraphSource(input), /exact pinned canonical surface/u)

  input.projections = [{ authorized: true, scope, projection: {
    ...exact,
    ref: pinned("surface", "surface-1", "version:2"),
    revision: { policy: "pinned", id: "version:2", contentHash: null },
  } }]
  assert.throws(() => buildAuthorizedGraphSource(input), /exact pinned canonical surface/u)
})

test("rejects document chunks as graph objects", () => {
  assert.throws(
    () => pinned("document.chunk", "chunk-1", `sha256:${hash("6")}`),
    /Unsupported Galaxy object kind/u,
  )
  const input = fixture()
  const chunkRef = pinned("document.mark", "chunk-1", `sha256:${hash("6")}`)
  input.projections = [{
    authorized: true,
    scope,
    projection: createGalaxyObjectProjection({
      schemaId: "gb.object-projection.v1",
      ref: chunkRef,
      kind: "document.mark",
      revision: { policy: "pinned", id: `sha256:${hash("6")}`, contentHash: hash("6") },
      title: "Derived chunk",
      mediaType: "text/plain",
      representations: [],
      provenance: { provider: "galaxy.document", sourceId: "chunk-1" },
      capabilities: ["inspect"],
    }),
  }]
  assert.throws(
    () => buildAuthorizedGraphSource(input),
    /projection\.kind is not authorized for this graph seam/u,
  )
})

test("omits unauthorized objects without inventing link endpoints", () => {
  const input = fixture()
  input.tasks[0].authorized = false
  const result = buildAuthorizedGraphSource(input)
  assert.equal(result.graphInput.objects.some((item) => item.projection.ref === taskRef), false)
  assert.equal(result.graphInput.links.some((item) => item.link.id === "link-task-surface"), false)
  assert.equal(result.diagnostics.omitted.unauthorized.tasks, 1)
  assert.equal(result.diagnostics.omitted.missingEndpointLinks, 3)
})

test("fails closed on scope drift, unknown keys, and conflicting exact projections", () => {
  const scopeDrift = fixture()
  scopeDrift.tasks[0].scope = { ...scope, workspaceId: "other" }
  assert.throws(() => buildAuthorizedGraphSource(scopeDrift), /crosses the tenant or workspace boundary/u)

  const unknown = fixture()
  unknown.links[0].hidden = true
  assert.throws(() => buildAuthorizedGraphSource(unknown), /links\[0\].hidden is not part/u)

  const conflict = fixture()
  conflict.papers.push(structuredClone(conflict.papers[0]))
  conflict.papers[1].paper.title = "Conflicting title"
  assert.throws(() => buildAuthorizedGraphSource(conflict), /conflicts with another projection/u)
})

test("is deterministic across source and link ordering", () => {
  const leftInput = fixture()
  const rightInput = structuredClone(leftInput)
  rightInput.providers.reverse()
  rightInput.links.reverse()
  const left = buildAuthorizedGraphSource(leftInput)
  const right = buildAuthorizedGraphSource(rightInput)
  assert.deepEqual(left, right)
})
