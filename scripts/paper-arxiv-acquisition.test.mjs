import assert from "node:assert/strict"
import test from "node:test"

import {
  acquireExactArxivPaper,
  importExactArxivPaper,
  paperArxivImportRegistered,
  saveExactArxivPaperDocument,
} from "../lib/paper-arxiv-acquisition.js"
import { resolveIngestionPlanDefinition } from "../lib/plugins/ingestion-plans.js"

const paperId = "10000000-0000-4000-8000-000000000001"
const paperRevisionId = "20000000-0000-4000-8000-000000000001"
const paperDocumentId = "30000000-0000-4000-8000-000000000001"
const documentId = "40000000-0000-4000-8000-000000000001"
const documentRevisionId = "50000000-0000-4000-8000-000000000001"
const artifactId = "60000000-0000-4000-8000-000000000001"
const sourceId = "70000000-0000-4000-8000-000000000001"
const metadataHash = "a".repeat(64)
const contentHash = "b".repeat(64)
const revisionHash = "c".repeat(64)
const sourceUrl = "https://arxiv.org/pdf/2401.01234v2"
const selection = {
  arxiv_id: "2401.01234",
  arxiv_version: 2,
  title: "Exact paper",
  abstract: "Bounded evidence.",
  authors: [{ name: "Ada Researcher" }],
  categories: ["cs.AI"],
  abs_url: "https://arxiv.org/abs/2401.01234v2",
  pdf_url: "https://arxiv.org/pdf/2401.01234v2",
}
const revision = {
  id: paperRevisionId,
  paper_id: paperId,
  arxiv_version: 2,
  metadata_hash: metadataHash,
  metadata: selection,
  imported_at: "2026-09-27T00:00:00Z",
}
const paper = {
  ...selection,
  id: paperId,
  metadata_hash: metadataHash,
  imported_revision_id: paperRevisionId,
  imported_revision_metadata_hash: metadataHash,
  imported_revision_arxiv_version: selection.arxiv_version,
  imported_at: "2026-09-27T00:00:00Z",
  updated_at: "2026-09-27T00:00:00Z",
  revisions: [revision],
  annotations: [],
  claims: [],
  evidence_links: [],
  task_links: [],
}

function durable(sourceKind = "arxiv") {
  return {
    schemaId: "gb.document.import.v1",
    persisted: true,
    ref: `gb:object:v1:document:${documentId}:pinned:sha256%3A${revisionHash}`,
    document_id: documentId,
    revision_id: documentRevisionId,
    artifact_id: artifactId,
    source_id: sourceId,
    title: selection.title,
    display_filename: "exact-paper-bbbbbbbbbbbb.pdf",
    version: 1,
    content_sha256: contentHash,
    revision_sha256: revisionHash,
    byte_size: 42,
    media_type: "application/pdf",
    source_kind: sourceKind,
    original_filename: "2401.01234v2.pdf",
    source_uri: sourceUrl,
    ingestion_plan: sourceKind === "arxiv"
      ? resolveIngestionPlanDefinition("arxiv.fetch-default")
      : null,
    replayed: false,
    deduplicatedArtifact: false,
  }
}

function paperDocument(sourceKind = "arxiv") {
  return {
    id: paperDocumentId,
    paper_id: paperId,
    paper_revision_id: paperRevisionId,
    media_type: "application/pdf",
    filename: "2401.01234v2.pdf",
    byte_size: 42,
    content_sha256: contentHash,
    source_url: sourceUrl,
    stored_at: "2026-09-27T00:00:00Z",
    durable_document: durable(sourceKind),
  }
}

function client(document = paperDocument()) {
  const calls = []
  return {
    calls,
    async importArxivPaper(id) {
      calls.push(["import", id])
      return paper
    },
    async getPaper(id) {
      calls.push(["detail", id])
      return paper
    },
    async fetchPaperDocument(id, revisionId) {
      calls.push(["fetch", id, revisionId])
      return document
    },
  }
}

test("Papers capability preflight binds the exact static command, source, route, and plan", () => {
  assert.equal(paperArxivImportRegistered(), true)
})

test("exact acquisition imports one selected version and privately fetches only its immutable revision", async () => {
  const transport = client()
  const result = await acquireExactArxivPaper(transport, selection)
  assert.deepEqual(transport.calls, [
    ["import", "2401.01234v2"],
    ["detail", paperId],
    ["fetch", paperId, paperRevisionId],
  ])
  assert.equal(result.revision.id, paperRevisionId)
  assert.equal(result.document.ref, durable().ref)
  assert.equal(result.document.source_kind, "arxiv")
  assert.equal("operationId" in result, false)
  assert.equal(JSON.stringify(transport.calls).includes(selection.pdf_url), false)
})

test("preserved legacy paper bridges remain valid without provenance relabelling", async () => {
  const transport = client(paperDocument("legacy-paper"))
  const result = await acquireExactArxivPaper(transport, selection)
  assert.equal(result.document.source_kind, "legacy-paper")
  assert.equal(result.document.ingestion_plan, null)
})

test("exact import fails closed when the returned paper or revision does not match the selection", async () => {
  const wrongPaper = { ...paper, arxiv_id: "2401.99999" }
  await assert.rejects(
    importExactArxivPaper({
      importArxivPaper: async () => wrongPaper,
      getPaper: async () => wrongPaper,
    }, selection),
    /different arXiv paper/u,
  )
  await assert.rejects(
    importExactArxivPaper({
      importArxivPaper: async () => paper,
      getPaper: async () => ({ ...paper, revisions: [{ ...revision, paper_id: crypto.randomUUID() }] }),
    }, selection),
    /one exact imported paper revision/u,
  )
  await assert.rejects(
    importExactArxivPaper({
      importArxivPaper: async () => ({ ...paper, imported_revision_id: crypto.randomUUID() }),
      getPaper: async () => paper,
    }, selection),
    /one exact imported paper revision/u,
  )
  await assert.rejects(
    importExactArxivPaper({
      importArxivPaper: async () => ({ ...paper, imported_revision_metadata_hash: "f".repeat(64) }),
      getPaper: async () => paper,
    }, selection),
    /one exact imported paper revision/u,
  )
})

test("importing an older exact revision succeeds without rewinding the current paper head", async () => {
  const historicalSelection = { ...selection, arxiv_version: 1 }
  const historicalRevision = {
    ...revision,
    id: crypto.randomUUID(),
    arxiv_version: 1,
    metadata_hash: "d".repeat(64),
    metadata: historicalSelection,
  }
  const currentHead = {
    ...paper,
    arxiv_version: 7,
    metadata_hash: "e".repeat(64),
    imported_revision_id: historicalRevision.id,
    imported_revision_metadata_hash: historicalRevision.metadata_hash,
    imported_revision_arxiv_version: historicalSelection.arxiv_version,
    revisions: [revision, historicalRevision],
  }
  const result = await importExactArxivPaper({
    importArxivPaper: async () => currentHead,
    getPaper: async () => currentHead,
  }, historicalSelection)
  assert.equal(result.paper.arxiv_version, 7)
  assert.equal(result.revision.id, historicalRevision.id)
  assert.equal(result.revision.arxiv_version, 1)
})

test("same-version metadata corrections select only the revision named by the import receipt", async () => {
  const correctedRevision = {
    ...revision,
    id: crypto.randomUUID(),
    metadata_hash: "d".repeat(64),
    metadata: { ...selection, title: "Corrected metadata" },
  }
  const receipt = {
    ...paper,
    imported_revision_id: correctedRevision.id,
    imported_revision_metadata_hash: correctedRevision.metadata_hash,
    revisions: [revision, correctedRevision],
  }
  const result = await importExactArxivPaper({
    importArxivPaper: async () => receipt,
    getPaper: async () => receipt,
  }, selection)
  assert.equal(result.revision.id, correctedRevision.id)
  assert.equal(result.revision.metadata_hash, correctedRevision.metadata_hash)
})

test("private storage rejects mismatched receipts, plans, source kinds, and absent durable refs", async () => {
  const cases = [
    [{ ...paperDocument(), paper_revision_id: crypto.randomUUID() }, /different paper revision/u],
    [{ ...paperDocument(), content_sha256: "d".repeat(64) }, /does not match/u],
    [{ ...paperDocument(), durable_document: { ...durable(), ingestion_plan: null } }, /different ingestion plan evidence/u],
    [{ ...paperDocument(), durable_document: { ...durable("legacy-paper"), ingestion_plan: resolveIngestionPlanDefinition("arxiv.fetch-default") } }, /unexpected ingestion plan evidence/u],
    [{ ...paperDocument(), durable_document: { ...durable("legacy-paper"), source_kind: "url" } }, /unexpected source provenance/u],
    [{ ...paperDocument(), durable_document: null }, /confirmation is missing/u],
  ]
  for (const [value, pattern] of cases) {
    await assert.rejects(
      saveExactArxivPaperDocument({ fetchPaperDocument: async () => value }, paper, revision),
      pattern,
    )
  }
})

test("an aborted acquisition stops before the first metadata write", async () => {
  const transport = client()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(acquireExactArxivPaper(transport, selection, controller.signal), /aborted/u)
  assert.deepEqual(transport.calls, [])
})
