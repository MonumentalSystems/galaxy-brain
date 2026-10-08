import assert from "node:assert/strict"
import test from "node:test"

import {
  executeIngestionPlan,
  ingestionPlanContentSha256,
  ingestionPlanExpectedSourceKind,
  listIngestionPlanDefinitions,
  resolveIngestionPlanDefinition,
  verifyIngestionPlanDefinition,
} from "../lib/plugins/ingestion-plans.js"
import { createPluginRegistry } from "../lib/plugins/registry.js"

const PLAN_HASH = "3fc4ea4cb03ee53467e9f4977be28145be100580cf09123e144e6153d070ae66"
const DATASOURCE_PLAN_HASH = "e3f23ff9cfc350e5a29d3efb897b96bee480bae0375dba83bea1d15cfc5b68d3"
const WEB_CAPTURE_PLAN_HASH = "0e541cf2165e72e38baaeadd2617198bfcf064b0990f3fd8fcf927048f1ca6a8"
const ARXIV_FETCH_PLAN_HASH = "46401cc8ea4e916304239fc6dc0fa5511790cf95d3f8cf52bf4de368c8d1f08a"
const ids = {
  document_id: "10000000-0000-4000-8000-000000000001",
  revision_id: "20000000-0000-4000-8000-000000000001",
  artifact_id: "30000000-0000-4000-8000-000000000001",
  source_id: "40000000-0000-4000-8000-000000000001",
}

function durableDocument({
  replayed = false,
  planId = "document.upload-default",
  sourceKind = "upload",
} = {}) {
  const plan = resolveIngestionPlanDefinition(planId)
  const revisionSha256 = "b".repeat(64)
  return {
    schemaId: "gb.document.import.v1",
    persisted: true,
    ref: `gb:object:v1:document:${ids.document_id}:pinned:sha256%3A${revisionSha256}`,
    ...ids,
    title: "Field note",
    display_filename: "field-note-aaaaaaaaaaaa.md",
    version: 1,
    content_sha256: "a".repeat(64),
    revision_sha256: revisionSha256,
    byte_size: 12,
    media_type: "text/markdown",
    source_kind: sourceKind,
    original_filename: "note.md",
    source_uri: sourceKind === "url" ? "https://example.invalid/article" : null,
    ingestion_plan: plan,
    replayed,
    deduplicatedArtifact: replayed,
  }
}

function runningTransform() {
  return {
    schemaId: "gb.document.transform.v1",
    persisted: true,
    document_revision_id: ids.revision_id,
    status: "running",
    replayed: true,
  }
}

function failedTransform() {
  return {
    schemaId: "gb.document.transform.v1",
    persisted: true,
    document_revision_id: ids.revision_id,
    representations: [{
      id: "60000000-0000-4000-8000-000000000001",
      kind: "original",
      media_type: "text/markdown",
      content_sha256: "a".repeat(64),
      artifact_id: ids.artifact_id,
      content: null,
      created_at: "2026-09-26T00:00:00Z",
    }],
    local_index: { schemaId: "gb.document-local-index-status.v1", status: "not-built" },
    receipt: {
      id: "70000000-0000-4000-8000-000000000001",
      plugin_id: "docling",
      plugin_version: "1.0.0",
      engine: "docling",
      engine_version: "1.0.0",
      config_sha256: "b".repeat(64),
      input_sha256: "a".repeat(64),
      output_representation_id: null,
      output_sha256: null,
      status: "failed",
      diagnostic_code: "docling.unavailable",
      output_manifest: { representations: [] },
      fallback_receipt_id: null,
      created_at: "2026-09-26T00:00:00Z",
    },
    fallbackReceipt: null,
    replayed: false,
  }
}

function fallbackTransform() {
  const value = failedTransform()
  const fallbackId = "80000000-0000-4000-8000-000000000001"
  const markdownId = "90000000-0000-4000-8000-000000000001"
  const markdownSha256 = "c".repeat(64)
  return {
    ...value,
    representations: [
      ...value.representations,
      {
        id: markdownId,
        kind: "markdown",
        media_type: "text/markdown; charset=utf-8",
        content_sha256: markdownSha256,
        artifact_id: null,
        content: "# Field note",
        created_at: "2026-09-26T00:00:00Z",
      },
    ],
    receipt: { ...value.receipt, fallback_receipt_id: fallbackId },
    fallbackReceipt: {
      ...value.receipt,
      id: fallbackId,
      plugin_id: "markitdown",
      engine: "markitdown",
      status: "fallback",
      diagnostic_code: null,
      output_representation_id: markdownId,
      output_sha256: markdownSha256,
      output_manifest: { representations: [{
        id: markdownId,
        kind: "markdown",
        mediaType: "text/markdown; charset=utf-8",
        contentSha256: markdownSha256,
      }] },
      fallback_receipt_id: null,
    },
  }
}

test("Documents owns one immutable code-owned ingestion plan with a cross-runtime hash", async () => {
  const plan = resolveIngestionPlanDefinition("document.upload-default")
  assert.equal(plan.owner.pluginId, "documents")
  assert.equal(plan.implementationId, "builtin.ingestion-plan.document-upload-default")
  assert.equal(plan.contentSha256, PLAN_HASH)
  assert.equal(await ingestionPlanContentSha256(plan), PLAN_HASH)
  assert.equal((await verifyIngestionPlanDefinition(plan)).id, plan.id)
  assert.deepEqual(
    listIngestionPlanDefinitions().map((item) => item.id).sort(),
    ["arxiv.fetch-default", "datasource.file-default", plan.id, "web.capture-default"].sort(),
  )
  assert.equal(JSON.stringify(plan).includes("url"), false)
  assert.equal(JSON.stringify(plan).includes("header"), false)
})

test("Datasources owns an immutable file plan with the same bounded transform policy", async () => {
  const plan = resolveIngestionPlanDefinition("datasource.file-default")
  assert.equal(plan.owner.pluginId, "datasources")
  assert.equal(plan.source.contributionId, "datasource.connected")
  assert.equal(plan.persist.routeId, "document.import-route")
  assert.deepEqual(plan.transformPolicy.transforms.map((item) => item.contributionId), [
    "docling.convert", "markitdown.convert", "plain-text.convert",
  ])
  assert.equal(plan.contentSha256, DATASOURCE_PLAN_HASH)
  assert.equal(await ingestionPlanContentSha256(plan), DATASOURCE_PLAN_HASH)
  assert.equal((await verifyIngestionPlanDefinition(plan)).id, plan.id)
})

test("Web capture owns an immutable URL plan with the shared structure-first transform policy", async () => {
  const plan = resolveIngestionPlanDefinition("web.capture-default")
  assert.equal(plan.owner.pluginId, "web-capture")
  assert.equal(plan.source.contributionId, "web.capture")
  assert.equal(plan.source.implementationId, "builtin.web.capture-source")
  assert.equal(plan.persist.routeId, "document.import-route")
  assert.deepEqual(plan.transformPolicy.transforms.map((item) => item.contributionId), [
    "docling.convert", "markitdown.convert", "plain-text.convert",
  ])
  assert.equal(plan.contentSha256, WEB_CAPTURE_PLAN_HASH)
  assert.equal(await ingestionPlanContentSha256(plan), WEB_CAPTURE_PLAN_HASH)
  assert.equal((await verifyIngestionPlanDefinition(plan)).id, plan.id)
})

test("Papers owns an immutable arXiv PDF plan with a cross-runtime source binding", async () => {
  const plan = resolveIngestionPlanDefinition("arxiv.fetch-default")
  assert.equal(plan.owner.pluginId, "papers")
  assert.equal(plan.implementationId, "builtin.ingestion-plan.arxiv-fetch-default")
  assert.equal(plan.source.contributionId, "arxiv.pdf")
  assert.equal(plan.source.implementationId, "builtin.arxiv.pdf-source")
  assert.equal(plan.persist.routeId, "arxiv.private-fetch-route")
  assert.deepEqual(plan.transformPolicy.transforms.map((item) => item.contributionId), [
    "docling.convert", "markitdown.convert", "plain-text.convert",
  ])
  assert.equal(ingestionPlanExpectedSourceKind(plan), "arxiv")
  assert.equal(plan.contentSha256, ARXIV_FETCH_PLAN_HASH)
  assert.equal(await ingestionPlanContentSha256(plan), ARXIV_FETCH_PLAN_HASH)
  assert.equal((await verifyIngestionPlanDefinition(plan)).id, plan.id)
})

test("web capture plan preserves URL provenance before running shared transforms", async () => {
  const calls = []
  const result = await executeIngestionPlan("web.capture-default", {
    file: { name: "captured-page.html" },
    metadata: {
      title: "Captured page",
      filename: "captured-page.html",
      sourceKind: "url",
      sourceUri: "https://example.invalid/article",
      arxivId: null,
    },
  }, {
    async importDocument(_file, metadata) {
      calls.push(["import", metadata])
      return {
        document: durableDocument({ planId: "web.capture-default", sourceKind: "url" }),
        placementOperationId: "50000000-0000-4000-8000-000000000001",
      }
    },
    async transformDocument(revisionId) {
      calls.push(["transform", revisionId])
      return runningTransform()
    },
  })

  assert.equal(result.status, "transforming")
  assert.equal(result.confirmation.document.source_kind, "url")
  assert.deepEqual(calls[0][1].ingestionPlan, {
    id: "web.capture-default",
    version: "1.0.0",
    contentSha256: WEB_CAPTURE_PLAN_HASH,
  })
  assert.equal(calls[1][1], ids.revision_id)
})

test("datasource plan preserves datasource provenance before running the shared transforms", async () => {
  const calls = []
  const result = await executeIngestionPlan("datasource.file-default", {
    file: { name: "paper.pdf" },
    metadata: {
      title: "Paper",
      filename: "paper.pdf",
      sourceKind: "datasource",
      sourceUri: "datasource://connection/item",
      arxivId: null,
    },
    scopePrefix: "atlas:tenant-a:principal-a:workspace-a",
  }, {
    async importDocument(_file, metadata) {
      calls.push(["import", metadata])
      return {
        document: durableDocument({
          planId: "datasource.file-default",
          sourceKind: "datasource",
        }),
        placementOperationId: "50000000-0000-4000-8000-000000000001",
      }
    },
    async transformDocument(revisionId) {
      calls.push(["transform", revisionId])
      return runningTransform()
    },
  })

  assert.equal(result.status, "transforming")
  assert.equal(result.confirmation.document.source_kind, "datasource")
  assert.deepEqual(calls[0][1].ingestionPlan, {
    id: "datasource.file-default",
    version: "1.0.0",
    contentSha256: DATASOURCE_PLAN_HASH,
  })
  assert.equal(calls[1][1], ids.revision_id)
})

test("manifests remain ID-only and registry drift fails closed", () => {
  const packageWithObject = {
    manifest: {
      schemaId: "galaxy-plugin.v1", id: "bad", version: "1.0.0",
      contributes: { ingestionPlans: [{ id: "bad.plan", url: "https://evil.invalid" }] },
      connections: [],
    },
    handlers: {},
  }
  assert.throws(() => createPluginRegistry([packageWithObject]), /stable registered ID/)

  const drifted = createPluginRegistry([{
    manifest: {
      schemaId: "galaxy-plugin.v1", id: "documents", version: "1.0.1",
      contributes: { sources: ["document.upload"], ingestionPlans: ["document.upload-default"] },
      connections: [],
    },
    handlers: {
      sources: { "document.upload": { kind: "sources", implementationId: "builtin.document.upload-source" } },
      ingestionPlans: {
        "document.upload-default": {
          kind: "ingestionPlans", implementationId: "builtin.ingestion-plan.document-upload-default",
        },
      },
    },
  }])
  assert.throws(() => resolveIngestionPlanDefinition("document.upload-default", drifted), /no longer matches/)
})

test("execution persists through the existing import API before starting durable transform", async () => {
  const calls = []
  const result = await executeIngestionPlan("document.upload-default", {
    file: { name: "note.md" },
    metadata: { title: "Field note", filename: "note.md", sourceKind: "upload" },
    scopePrefix: "atlas:tenant-a:principal-a:workspace-a",
  }, {
    async importDocument(_file, metadata) {
      calls.push(["import", metadata])
      return { document: durableDocument(), placementOperationId: "50000000-0000-4000-8000-000000000001" }
    },
    async transformDocument(revisionId, options) {
      calls.push(["transform", revisionId, options])
      return runningTransform()
    },
  })

  assert.equal(result.status, "transforming")
  assert.equal(result.confirmation.document.revision_id, ids.revision_id)
  assert.equal(calls[0][0], "import")
  assert.deepEqual(calls[0][1].ingestionPlan, {
    id: "document.upload-default", version: "1.0.0", contentSha256: PLAN_HASH,
  })
  assert.equal(calls[1][0], "transform")
  assert.match(calls[1][2].scope, new RegExp(`^atlas:tenant-a:principal-a:workspace-a:.*${PLAN_HASH}:${ids.document_id}:${ids.revision_id}$`, "u"))
})

test("transform failure returns exact durable confirmation and replay uses the same scope", async () => {
  const scopes = []
  let imports = 0
  const ports = {
    async importDocument() {
      imports += 1
      return {
        document: durableDocument({ replayed: imports > 1 }),
        placementOperationId: "50000000-0000-4000-8000-000000000001",
      }
    },
    async transformDocument(_revisionId, options) {
      scopes.push(options.scope)
      if (scopes.length === 1) throw Object.assign(new Error("upstream detail must not escape"), {
        code: "service-unavailable", retryable: true,
      })
      return runningTransform()
    },
  }
  const request = {
    file: { name: "note.md" },
    metadata: { title: "Field note", filename: "note.md", sourceKind: "upload" },
  }
  const first = await executeIngestionPlan("document.upload-default", request, ports)
  const replay = await executeIngestionPlan("document.upload-default", request, ports)

  assert.equal(first.status, "persisted")
  assert.equal(first.confirmation.document.ref, durableDocument().ref)
  assert.deepEqual(first.derivation, { status: "failed", code: "service-unavailable", retryable: true })
  assert.equal(JSON.stringify(first).includes("upstream detail"), false)
  assert.equal(replay.confirmation.document.replayed, true)
  assert.equal(scopes[0], scopes[1])
})

test("a terminal failed receipt never promotes an optional derivative to complete", async () => {
  const result = await executeIngestionPlan("document.upload-default", {
    file: { name: "note.md" },
    metadata: { title: "Field note", filename: "note.md", sourceKind: "upload" },
  }, {
    async importDocument() {
      return {
        document: durableDocument(),
        placementOperationId: "50000000-0000-4000-8000-000000000001",
      }
    },
    async transformDocument() { return failedTransform() },
  })

  assert.equal(result.status, "persisted")
  assert.equal(result.transform.receipt.status, "failed")
  assert.deepEqual(result.derivation, {
    status: "failed",
    code: "docling.unavailable",
    retryable: false,
    receiptStatus: "failed",
  })
})

test("a successful bounded fallback is the effective terminal derivation", async () => {
  const result = await executeIngestionPlan("document.upload-default", {
    file: { name: "note.md" },
    metadata: { title: "Field note", filename: "note.md", sourceKind: "upload" },
  }, {
    async importDocument() {
      return {
        document: durableDocument(),
        placementOperationId: "50000000-0000-4000-8000-000000000001",
      }
    },
    async transformDocument() { return fallbackTransform() },
  })

  assert.equal(result.status, "complete")
  assert.equal(result.transform.receipt.status, "failed")
  assert.equal(result.transform.fallbackReceipt.status, "fallback")
  assert.deepEqual(result.derivation, { status: "complete", receiptStatus: "fallback" })
})

test("executor rejects authoritative import evidence for another plan before transform", async () => {
  let transformed = false
  await assert.rejects(executeIngestionPlan("document.upload-default", {
    file: { name: "note.md" }, metadata: { title: "Field note", filename: "note.md", sourceKind: "upload" },
  }, {
    async importDocument() {
      return {
        document: { ...durableDocument(), ingestion_plan: null },
        placementOperationId: "50000000-0000-4000-8000-000000000001",
      }
    },
    async transformDocument() { transformed = true },
  }), /different ingestion plan evidence/)
  assert.equal(transformed, false)

  const drifted = durableDocument()
  drifted.ingestion_plan = {
    ...drifted.ingestion_plan,
    source: { ...drifted.ingestion_plan.source, contributionId: "evil.source" },
  }
  await assert.rejects(executeIngestionPlan("document.upload-default", {
    file: { name: "note.md" }, metadata: { title: "Field note", filename: "note.md", sourceKind: "upload" },
  }, {
    async importDocument() {
      return {
        document: drifted,
        placementOperationId: "50000000-0000-4000-8000-000000000001",
      }
    },
    async transformDocument() { transformed = true },
  }), /different ingestion plan evidence/)
  assert.equal(transformed, false)
})

test("plan execution rejects a mismatched source kind before persistence", async () => {
  let imported = false
  await assert.rejects(executeIngestionPlan("datasource.file-default", {
    file: { name: "note.md" },
    metadata: { title: "Field note", filename: "note.md", sourceKind: "upload" },
  }, {
    async importDocument() { imported = true },
    async transformDocument() {},
  }), /cannot authorize this import source kind/)
  assert.equal(imported, false)

  await assert.rejects(executeIngestionPlan("web.capture-default", {
    file: { name: "capture.html" },
    metadata: { title: "Captured page", filename: "capture.html", sourceKind: "upload" },
  }, {
    async importDocument() { imported = true },
    async transformDocument() {},
  }), /cannot authorize this import source kind/)
  assert.equal(imported, false)
})
