import assert from "node:assert/strict"
import test from "node:test"

import {
  atlasReferenceHandoffPlacementRecoveryNamespace,
  listAtlasReferenceHandoffPlacementRecoveries,
  readAtlasReferenceHandoffPlacementRecovery,
  removeAtlasReferenceHandoffPlacementRecovery,
  writeAtlasReferenceHandoffPlacementRecovery,
} from "../lib/atlas-reference-handoff-placement-recovery.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"

class MemoryStorage {
  values = new Map()
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, String(value)) }
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
const documentRevisionId = "40000000-0000-4000-8000-000000000001"
const revisionSha256 = "a".repeat(64)
const subjectRef = createGalaxyObjectReference("document", documentId, {
  mode: "pinned",
  revision: `sha256:${revisionSha256}`,
})

function recovery(operationId = operations[0], overrides = {}) {
  return {
    operationId,
    workspaceId: "default-workspace",
    canvasId: "50000000-0000-4000-8000-000000000001",
    subjectRef,
    kind: "document",
    objectId: documentId,
    sourceRevisionId: documentRevisionId,
    revisionSha256,
    ...overrides,
  }
}

test("handoff placement recovery persists the exact confirmed source and target until explicit completion", () => {
  const storage = new MemoryStorage()
  const written = writeAtlasReferenceHandoffPlacementRecovery(storage, scopeA, recovery())

  assert.deepEqual(Object.keys(written).sort(), [
    "canvasId",
    "kind",
    "objectId",
    "operationId",
    "revisionSha256",
    "schemaId",
    "sourceRevisionId",
    "subjectRef",
    "workspaceId",
  ])
  assert.equal(written.schemaId, "gb.atlas-reference-handoff-placement-recovery.v2")
  assert.equal(Object.isFrozen(written), true)
  assert.deepEqual(readAtlasReferenceHandoffPlacementRecovery(storage, scopeA, operations[0]), written)
  assert.deepEqual(readAtlasReferenceHandoffPlacementRecovery(storage, scopeA, operations[0]), written)
  assert.equal(readAtlasReferenceHandoffPlacementRecovery(storage, scopeB, operations[0]), null)

  removeAtlasReferenceHandoffPlacementRecovery(storage, scopeA, operations[0])
  assert.equal(readAtlasReferenceHandoffPlacementRecovery(storage, scopeA, operations[0]), null)
})

test("listing is identity-scoped, operation-keyed, and deterministic across exact targets", () => {
  const storage = new MemoryStorage()
  for (const [index, operationId] of operations.entries()) {
    writeAtlasReferenceHandoffPlacementRecovery(storage, scopeA, recovery(operationId, {
      canvasId: `50000000-0000-4000-8000-00000000000${index + 1}`,
    }))
  }
  writeAtlasReferenceHandoffPlacementRecovery(storage, scopeB, recovery(operations[0]))

  assert.deepEqual(
    listAtlasReferenceHandoffPlacementRecoveries(storage, scopeA).map((item) => item.operationId),
    [...operations].sort(),
  )
  assert.deepEqual(
    listAtlasReferenceHandoffPlacementRecoveries(storage, scopeB).map((item) => item.operationId),
    [operations[0]],
  )
  assert.match(
    atlasReferenceHandoffPlacementRecoveryNamespace(scopeA),
    new RegExp(`${scopeA.tenantId}:${scopeA.principalId}:$`),
  )
})

test("writes reject expanded, noncanonical, unbounded, and cross-bound records", () => {
  const storage = new MemoryStorage()
  const otherDocumentId = "60000000-0000-4000-8000-000000000001"
  const otherRevisionSha256 = "b".repeat(64)
  const latestRef = createGalaxyObjectReference("document", documentId)
  const invalid = [
    { ...recovery(), unexpected: true },
    recovery("90000000-0000-3000-8000-000000000001"),
    recovery("9abcdef0-0000-4000-8000-000000000001".toUpperCase()),
    recovery(operations[0], { workspaceId: "x".repeat(513) }),
    recovery(operations[0], { canvasId: "5abcdef0-0000-4000-8000-000000000001".toUpperCase() }),
    recovery(operations[0], { subjectRef: latestRef }),
    recovery(operations[0], { objectId: otherDocumentId }),
    recovery(operations[0], { sourceRevisionId: "not-a-uuid" }),
    recovery(operations[0], { revisionSha256: otherRevisionSha256 }),
  ]

  for (const value of invalid) {
    assert.throws(
      () => writeAtlasReferenceHandoffPlacementRecovery(storage, scopeA, value),
      /Invalid Atlas reference handoff placement recovery/u,
    )
  }
  assert.throws(
    () => writeAtlasReferenceHandoffPlacementRecovery(storage, { ...scopeA, extra: true }, recovery()),
    /scope has unexpected fields/u,
  )
  assert.equal(storage.length, 0)
})

test("chat recovery keeps the exact pinned identity with no provider revision id", () => {
  const storage = new MemoryStorage()
  const conversationId = "70000000-0000-4000-8000-000000000001"
  const chatRef = createGalaxyObjectReference("chat", conversationId, {
    mode: "pinned",
    revision: `sha256:${revisionSha256}`,
  })
  const written = writeAtlasReferenceHandoffPlacementRecovery(storage, scopeA, recovery(operations[0], {
    subjectRef: chatRef,
    kind: "chat",
    objectId: conversationId,
    sourceRevisionId: null,
  }))
  assert.equal(written.kind, "chat")
  assert.equal(written.objectId, conversationId)
  assert.equal(written.sourceRevisionId, null)
  assert.deepEqual(readAtlasReferenceHandoffPlacementRecovery(storage, scopeA, operations[0]), written)
  assert.throws(() => writeAtlasReferenceHandoffPlacementRecovery(storage, scopeA, recovery(operations[1], {
    subjectRef: chatRef,
    kind: "chat",
    objectId: conversationId,
    sourceRevisionId: documentRevisionId,
  })), /must not contain a source revision id/u)
  const nonUuidRef = createGalaxyObjectReference("chat", "conversation-slug", {
    mode: "pinned",
    revision: `sha256:${revisionSha256}`,
  })
  assert.throws(() => writeAtlasReferenceHandoffPlacementRecovery(storage, scopeA, recovery(operations[1], {
    subjectRef: nonUuidRef,
    kind: "chat",
    objectId: "conversation-slug",
    sourceRevisionId: null,
  })), /object id must be a canonical UUID/u)
})

test("surface recovery keeps one exact promoted projection identity", () => {
  const storage = new MemoryStorage()
  const surfaceId = "80000000-0000-4000-8000-000000000001"
  const surfaceRef = createGalaxyObjectReference("surface", surfaceId, {
    mode: "pinned",
    revision: `sha256:${revisionSha256}`,
  })
  const written = writeAtlasReferenceHandoffPlacementRecovery(storage, scopeA, recovery(operations[0], {
    subjectRef: surfaceRef,
    kind: "surface",
    objectId: surfaceId,
    sourceRevisionId: null,
  }))
  assert.equal(written.kind, "surface")
  assert.equal(written.objectId, surfaceId)
  assert.equal(written.sourceRevisionId, null)
  assert.deepEqual(readAtlasReferenceHandoffPlacementRecovery(storage, scopeA, operations[0]), written)
  assert.throws(() => writeAtlasReferenceHandoffPlacementRecovery(storage, scopeA, recovery(operations[1], {
    subjectRef: surfaceRef,
    kind: "surface",
    objectId: surfaceId,
    sourceRevisionId: documentRevisionId,
  })), /surface recovery must not contain a source revision id/u)
})

test("legacy document checkpoints are normalized to the generic v2 record", () => {
  const storage = new MemoryStorage()
  const prefix = atlasReferenceHandoffPlacementRecoveryNamespace(scopeA)
  storage.setItem(`${prefix}${operations[0]}`, JSON.stringify({
    schemaId: "gb.atlas-reference-handoff-placement-recovery.v1",
    operationId: operations[0],
    workspaceId: "default-workspace",
    canvasId: "50000000-0000-4000-8000-000000000001",
    subjectRef,
    documentId,
    documentRevisionId,
    revisionSha256,
  }))
  const recovered = readAtlasReferenceHandoffPlacementRecovery(storage, scopeA, operations[0])
  assert.equal(recovered.schemaId, "gb.atlas-reference-handoff-placement-recovery.v2")
  assert.equal(recovered.kind, "document")
  assert.equal(recovered.objectId, documentId)
  assert.equal(recovered.sourceRevisionId, documentRevisionId)
})

test("reads and lists remove corrupt, oversized, wrong-key, and mismatched checkpoints", () => {
  const storage = new MemoryStorage()
  const prefix = atlasReferenceHandoffPlacementRecoveryNamespace(scopeA)
  storage.setItem(`${prefix}${operations[0]}`, "{")
  assert.equal(readAtlasReferenceHandoffPlacementRecovery(storage, scopeA, operations[0]), null)
  assert.equal(storage.length, 0)

  const valid = writeAtlasReferenceHandoffPlacementRecovery(storage, scopeA, recovery(operations[0]))
  storage.setItem(`${prefix}${operations[1]}`, JSON.stringify(valid))
  storage.setItem(`${prefix}not-a-v4-uuid`, JSON.stringify(valid))
  storage.setItem(`${prefix}${operations[2]}`, JSON.stringify({
    ...valid,
    operationId: operations[2],
    revisionSha256: "b".repeat(64),
  }))
  const oversizedOperation = "90000000-0000-4000-8000-000000000004"
  storage.setItem(`${prefix}${oversizedOperation}`, "x".repeat(8_193))

  assert.deepEqual(
    listAtlasReferenceHandoffPlacementRecoveries(storage, scopeA).map((item) => item.operationId),
    [operations[0]],
  )
  assert.equal(storage.length, 1)
})
