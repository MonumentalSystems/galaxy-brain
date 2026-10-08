import assert from "node:assert/strict"
import test from "node:test"

import {
  listPaperImportPlacementRecoveries,
  paperImportPlacementRecoveryNamespace,
  readPaperImportPlacementRecovery,
  removePaperImportPlacementRecovery,
  writePaperImportPlacementRecovery,
} from "../lib/paper-import-placement-recovery.js"
import { resolveIngestionPlanDefinition } from "../lib/plugins/ingestion-plans.js"

class MemoryStorage {
  values = new Map()
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, value) }
  removeItem(key) { this.values.delete(key) }
}

const scopeA = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  principalId: "20000000-0000-4000-8000-000000000001",
}
const scopeB = { ...scopeA, principalId: "20000000-0000-4000-8000-000000000002" }
const operations = [
  "90000000-0000-4000-8000-000000000003",
  "90000000-0000-4000-8000-000000000001",
  "90000000-0000-4000-8000-000000000002",
]
const documentId = "30000000-0000-4000-8000-000000000001"
const revisionSha = "b".repeat(64)
const subjectRef = `gb:object:v1:document:${documentId}:pinned:sha256%3A${revisionSha}`

function durableDocument(sourceKind = "arxiv") {
  return {
    schemaId: "gb.document.import.v1",
    persisted: true,
    ref: subjectRef,
    document_id: documentId,
    revision_id: "40000000-0000-4000-8000-000000000001",
    artifact_id: "50000000-0000-4000-8000-000000000001",
    source_id: "60000000-0000-4000-8000-000000000001",
    title: "Exact paper",
    display_filename: "exact-paper-aaaaaaaaaaaa.pdf",
    version: 1,
    content_sha256: "a".repeat(64),
    revision_sha256: revisionSha,
    byte_size: 42,
    media_type: "application/pdf",
    source_kind: sourceKind,
    original_filename: "2401.01234v2.pdf",
    source_uri: "https://arxiv.org/pdf/2401.01234v2",
    ingestion_plan: sourceKind === "arxiv"
      ? resolveIngestionPlanDefinition("arxiv.fetch-default")
      : null,
    replayed: false,
    deduplicatedArtifact: false,
  }
}

function recovery(operationId = operations[0], overrides = {}) {
  return {
    operationId,
    workspaceId: "default-workspace",
    canvasId: "70000000-0000-4000-8000-000000000001",
    subjectRef,
    durableDocument: durableDocument(),
    arxiv_id: "2401.01234",
    arxiv_version: 2,
    title: "Exact paper",
    ...overrides,
  }
}

test("paper placement recovery round-trips one exact scoped durable document", () => {
  const storage = new MemoryStorage()
  const written = writePaperImportPlacementRecovery(storage, scopeA, recovery())
  assert.equal(written.schemaId, "gb.paper-import-placement-recovery.v1")
  assert.equal(written.operationId, operations[0])
  assert.equal(written.subjectRef, written.durableDocument.ref)
  assert.equal(Object.isFrozen(written), true)
  assert.equal(Object.isFrozen(written.durableDocument), true)
  assert.deepEqual(readPaperImportPlacementRecovery(storage, scopeA, operations[0]), written)
  assert.equal(readPaperImportPlacementRecovery(storage, scopeB, operations[0]), null)
  removePaperImportPlacementRecovery(storage, scopeA, operations[0])
  assert.equal(readPaperImportPlacementRecovery(storage, scopeA, operations[0]), null)
})

test("legacy-paper receipts remain exact without provenance relabelling", () => {
  const storage = new MemoryStorage()
  const written = writePaperImportPlacementRecovery(storage, scopeA, recovery(operations[0], {
    durableDocument: durableDocument("legacy-paper"),
  }))
  assert.equal(written.durableDocument.source_kind, "legacy-paper")
  assert.equal(written.durableDocument.ingestion_plan, null)
})

test("listing is identity-scoped, deterministic, and operation-keyed", () => {
  const storage = new MemoryStorage()
  for (const operationId of operations) writePaperImportPlacementRecovery(storage, scopeA, recovery(operationId))
  writePaperImportPlacementRecovery(storage, scopeB, recovery(operations[0]))
  assert.deepEqual(
    listPaperImportPlacementRecoveries(storage, scopeA).map((item) => item.operationId),
    [...operations].sort(),
  )
  assert.deepEqual(
    listPaperImportPlacementRecoveries(storage, scopeB).map((item) => item.operationId),
    [operations[0]],
  )
  assert.match(
    paperImportPlacementRecoveryNamespace(scopeA),
    new RegExp(`${scopeA.tenantId}:${scopeA.principalId}:$`),
  )
})

test("writes reject expanded, unbounded, mismatched, latest, and non-paper records", () => {
  const storage = new MemoryStorage()
  const invalid = [
    { ...recovery(), unexpected: true },
    recovery("90000000-0000-3000-8000-000000000001"),
    recovery(operations[0], { workspaceId: "x".repeat(513) }),
    recovery(operations[0], { canvasId: "canvas-not-uuid" }),
    recovery(operations[0], { subjectRef: `gb:object:v1:document:${documentId}:latest` }),
    recovery(operations[0], { arxiv_version: 0 }),
    recovery(operations[0], { arxiv_id: "bad id" }),
    recovery(operations[0], { title: "Different title" }),
    recovery(operations[0], {
      durableDocument: { ...durableDocument(), source_kind: "upload", ingestion_plan: null },
    }),
    recovery(operations[0], {
      durableDocument: { ...durableDocument(), source_uri: "https://arxiv.org/pdf/2401.01234v3" },
    }),
  ]
  for (const value of invalid) {
    assert.throws(() => writePaperImportPlacementRecovery(storage, scopeA, value), /Invalid paper placement recovery/u)
  }
  assert.throws(
    () => writePaperImportPlacementRecovery(storage, { ...scopeA, extra: true }, recovery()),
    /scope has unexpected fields/u,
  )
  assert.equal(storage.length, 0)
})

test("reads and lists remove corrupt JSON, invalid keys, key-record mismatches, and invalid documents", () => {
  const storage = new MemoryStorage()
  const prefix = paperImportPlacementRecoveryNamespace(scopeA)
  storage.setItem(`${prefix}${operations[0]}`, "{")
  assert.equal(readPaperImportPlacementRecovery(storage, scopeA, operations[0]), null)
  assert.equal(storage.length, 0)

  const valid = writePaperImportPlacementRecovery(storage, scopeA, recovery(operations[0]))
  storage.setItem(`${prefix}${operations[1]}`, JSON.stringify(valid))
  storage.setItem(`${prefix}not-a-uuid`, JSON.stringify(valid))
  storage.setItem(`${prefix}${operations[2]}`, JSON.stringify({
    ...valid,
    operationId: operations[2],
    durableDocument: { ...valid.durableDocument, ref: `gb:object:v1:document:${documentId}:latest` },
  }))

  assert.deepEqual(listPaperImportPlacementRecoveries(storage, scopeA).map((item) => item.operationId), [operations[0]])
  assert.equal(storage.length, 1)
})
