import assert from "node:assert/strict"
import test from "node:test"

import {
  advanceDocumentAnchorPlacementRecovery,
  confirmDocumentAnchorPlacementRecovery,
  deriveDocumentAnchorPlacementOperationId,
  ensureDocumentAnchorPlacementRecovery,
  readDocumentAnchorPlacementRecovery,
  runRecoverableDocumentAnchorPlacement,
} from "../lib/canvas/document-anchor-placement-recovery.js"

const scope = {
  tenantId: "tenant-a",
  principalId: "principal-a",
  documentRevisionId: "123e4567-e89b-42d3-a456-426614174000",
  anchorId: `sha256:${"a".repeat(64)}`,
}
const canvasId = "33333333-3333-4333-8333-333333333333"

function memoryStorage() {
  const values = new Map()
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null },
    setItem(key, value) { values.set(key, String(value)) },
    removeItem(key) { values.delete(key) },
    entries() { return [...values.entries()] },
  }
}

test("generation participates in deterministic RFC variant UUIDv8 identity", async () => {
  const first = await deriveDocumentAnchorPlacementOperationId(scope, canvasId, 1)
  const firstAgain = await deriveDocumentAnchorPlacementOperationId({ ...scope }, canvasId, 1)
  const second = await deriveDocumentAnchorPlacementOperationId(scope, canvasId, 2)

  assert.equal(first, firstAgain)
  assert.notEqual(first, second)
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test("pending retry keeps its canvas and a confirmed second tab reconciles with the same operation", async () => {
  const storage = memoryStorage()
  const operationId = await deriveDocumentAnchorPlacementOperationId(scope, canvasId, 1)
  const placementId = `anchor-${operationId}`
  let defaultCalls = 0
  let placeCalls = 0

  await assert.rejects(() => runRecoverableDocumentAnchorPlacement({
    storage,
    scope,
    async resolveCanvasId() {
      defaultCalls += 1
      return canvasId
    },
    async place(observedOperationId, observedCanvasId) {
      placeCalls += 1
      assert.equal(observedOperationId, operationId)
      assert.equal(observedCanvasId, canvasId)
      throw new Error("response lost")
    },
  }), /response lost/)

  const firstCompletion = await runRecoverableDocumentAnchorPlacement({
    storage,
    scope,
    async resolveCanvasId() {
      defaultCalls += 1
      return "44444444-4444-4444-8444-444444444444"
    },
    async place(observedOperationId, observedCanvasId) {
      placeCalls += 1
      assert.equal(observedOperationId, operationId)
      assert.equal(observedCanvasId, canvasId)
      return { placementId, replayed: true }
    },
  })
  assert.equal(firstCompletion.recovered, false)

  const secondTab = await runRecoverableDocumentAnchorPlacement({
    storage,
    scope,
    async resolveCanvasId() {
      defaultCalls += 1
      throw new Error("confirmed recovery must not resolve a new default")
    },
    async place(observedOperationId, observedCanvasId) {
      placeCalls += 1
      assert.equal(observedOperationId, operationId)
      assert.equal(observedCanvasId, canvasId)
      return { placementId, replayed: true }
    },
  })
  assert.equal(defaultCalls, 1)
  assert.equal(placeCalls, 3)
  assert.equal(secondTab.recovered, true)
  assert.equal(secondTab.result.placementId, placementId)
  assert.equal(secondTab.recovery.generation, 1)
})

test("advance replaces the matching record with a different generation on the same canvas", async () => {
  const storage = memoryStorage()
  const pending = await ensureDocumentAnchorPlacementRecovery(storage, scope, canvasId)
  const confirmed = await confirmDocumentAnchorPlacementRecovery(
    storage,
    scope,
    canvasId,
    pending.operationId,
    `anchor-${pending.operationId}`,
  )
  const advanced = await advanceDocumentAnchorPlacementRecovery(
    storage,
    scope,
    confirmed.canvasId,
    confirmed.operationId,
  )

  assert.equal(advanced.state, "pending")
  assert.equal(advanced.canvasId, canvasId)
  assert.equal(advanced.generation, 2)
  assert.notEqual(advanced.operationId, confirmed.operationId)
  assert.deepEqual(await readDocumentAnchorPlacementRecovery(storage, scope), advanced)
  assert.equal(storage.entries().some(([key]) => key.endsWith(":confirmed")), false)
})

test("a stale caller cannot advance an unrelated or already advanced record", async () => {
  const storage = memoryStorage()
  const pending = await ensureDocumentAnchorPlacementRecovery(storage, scope, canvasId)
  const advanced = await advanceDocumentAnchorPlacementRecovery(
    storage,
    scope,
    canvasId,
    pending.operationId,
  )

  await assert.rejects(
    () => advanceDocumentAnchorPlacementRecovery(storage, scope, canvasId, pending.operationId),
    /stale or unrelated/,
  )
  await assert.rejects(
    () => advanceDocumentAnchorPlacementRecovery(
      storage,
      scope,
      "44444444-4444-4444-8444-444444444444",
      advanced.operationId,
    ),
    /stale or unrelated/,
  )
})

test("generation and stored records are bounded and reject canonical content", async () => {
  const storage = memoryStorage()
  const pending = await ensureDocumentAnchorPlacementRecovery(storage, scope, canvasId)
  const [entry] = storage.entries()
  assert.deepEqual(JSON.parse(entry[1]), pending)
  assert.equal(entry[1].includes(scope.anchorId), false)

  storage.setItem(entry[0], JSON.stringify({ ...pending, selector: { exact: "private paper text" } }))
  assert.equal(await readDocumentAnchorPlacementRecovery(storage, scope), null)
  assert.deepEqual(storage.entries(), [])

  await assert.rejects(
    () => deriveDocumentAnchorPlacementOperationId(scope, canvasId, 0),
    /generation/,
  )
  await assert.rejects(
    () => deriveDocumentAnchorPlacementOperationId(scope, canvasId, 1_000_001),
    /generation/,
  )
})
