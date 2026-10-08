import assert from "node:assert/strict"
import test from "node:test"

import {
  elnExperimentRecoveryNamespace,
  listPendingExperimentCreates,
  listPendingExperimentPlacements,
  listPendingExperimentObservations,
  readPendingExperimentCreate,
  readPendingExperimentPlacement,
  removePendingExperimentCreate,
  removePendingExperimentPlacement,
  removePendingExperimentObservation,
  writePendingExperimentCreate,
  writePendingExperimentPlacement,
  writePendingExperimentObservation,
} from "../lib/eln-experiment-recovery.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"

const scope = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  principalId: "22222222-2222-4222-8222-222222222222",
}
const otherScope = {
  tenantId: scope.tenantId,
  principalId: "33333333-3333-4333-8333-333333333333",
}
const operationId = "44444444-4444-4444-8444-444444444444"
const experimentId = "55555555-5555-4555-8555-555555555555"
const canvasId = "88888888-8888-4888-8888-888888888888"

function memoryStorage() {
  const values = new Map()
  return {
    get length() { return values.size },
    key(index) { return [...values.keys()][index] ?? null },
    getItem(key) { return values.has(key) ? values.get(key) : null },
    setItem(key, value) { values.set(key, String(value)) },
    removeItem(key) { values.delete(key) },
    entries() { return [...values.entries()] },
  }
}

test("pending create retains the exact bounded request and stable operation UUID", () => {
  const storage = memoryStorage()
  const input = {
    title: "Vortex threshold",
    hypothesis: "The threshold shifts with helicity.\nSecond line.",
    domain: "fluid-dynamics",
    wandb_run_id: "run-42",
  }
  const written = writePendingExperimentCreate(storage, scope, { operationId, input })

  assert.deepEqual(written, {
    schemaId: "gb.eln-experiment-create-recovery.v1",
    state: "pending-create",
    operationId,
    input,
  })
  assert.deepEqual(readPendingExperimentCreate(storage, scope, operationId), written)
  assert.deepEqual(listPendingExperimentCreates(storage, scope), [written])
  assert.deepEqual(listPendingExperimentCreates(storage, otherScope), [])
  assert.match(storage.entries()[0][0], new RegExp(`${scope.tenantId}:${scope.principalId}:create:${operationId}$`))
})

test("separate operations and principals cannot overwrite or read one another", () => {
  const storage = memoryStorage()
  const secondOperation = "66666666-6666-4666-8666-666666666666"
  writePendingExperimentCreate(storage, scope, { operationId, input: { title: "First" } })
  writePendingExperimentCreate(storage, scope, { operationId: secondOperation, input: { title: "Second" } })
  writePendingExperimentCreate(storage, otherScope, { operationId, input: { title: "Other principal" } })

  assert.deepEqual(
    listPendingExperimentCreates(storage, scope).map((record) => record.input.title),
    ["First", "Second"],
  )
  assert.equal(readPendingExperimentCreate(storage, otherScope, secondOperation), null)
  removePendingExperimentCreate(storage, scope, operationId)
  assert.equal(readPendingExperimentCreate(storage, scope, operationId), null)
  assert.equal(readPendingExperimentCreate(storage, otherScope, operationId)?.input.title, "Other principal")
})

test("confirmed creation becomes a durable pending-placement record until explicitly removed", () => {
  const storage = memoryStorage()
  const subjectRef = createGalaxyObjectReference("eln.experiment", experimentId)
  const written = writePendingExperimentPlacement(storage, scope, {
    operationId,
    experimentId,
    title: "A confirmed experiment",
    subjectRef,
    workspaceId: "workspace-main",
    canvasId,
  })

  assert.deepEqual(readPendingExperimentPlacement(storage, scope, operationId), written)
  assert.deepEqual(listPendingExperimentPlacements(storage, scope), [written])
  assert.equal(readPendingExperimentPlacement(storage, otherScope, operationId), null)
  assert.equal(storage.length, 1)

  // Reads never acknowledge Atlas placement implicitly.
  assert.deepEqual(readPendingExperimentPlacement(storage, scope, operationId), written)
  removePendingExperimentPlacement(storage, scope, operationId)
  assert.equal(readPendingExperimentPlacement(storage, scope, operationId), null)
})

test("placement reference must be the latest canonical reference for the same experiment", () => {
  const storage = memoryStorage()
  assert.throws(() => writePendingExperimentPlacement(storage, scope, {
    operationId,
    experimentId,
    title: "Wrong object",
    subjectRef: createGalaxyObjectReference("paper", experimentId),
    workspaceId: "workspace-main",
    canvasId,
  }), /latest created experiment/)
  assert.throws(() => writePendingExperimentPlacement(storage, scope, {
    operationId,
    experimentId,
    title: "Wrong revision",
    subjectRef: createGalaxyObjectReference("eln.experiment", experimentId, {
      mode: "pinned",
      revision: "revision-1",
    }),
    workspaceId: "workspace-main",
    canvasId,
  }), /latest created experiment/)
  assert.throws(() => writePendingExperimentPlacement(storage, scope, {
    operationId,
    experimentId,
    title: "Wrong identity",
    subjectRef: createGalaxyObjectReference("eln.experiment", "77777777-7777-4777-8777-777777777777"),
    workspaceId: "workspace-main",
    canvasId,
  }), /latest created experiment/)
  assert.equal(storage.length, 0)
})

test("strict schemas and string bounds reject non-round-trippable recovery data", () => {
  const storage = memoryStorage()
  assert.throws(() => writePendingExperimentCreate(storage, scope, {
    operationId,
    input: { title: "Okay", status: "complete" },
  }), /unexpected fields/)
  assert.throws(() => writePendingExperimentCreate(storage, scope, {
    operationId,
    input: { title: "x".repeat(513) },
  }), /title is invalid/)
  assert.throws(() => writePendingExperimentCreate(storage, scope, {
    operationId: "not-a-uuid",
    input: { title: "Okay" },
  }), /operation id must be a UUID/)
  assert.throws(() => elnExperimentRecoveryNamespace({ ...scope, tenantId: "default" }), /tenant id must be a UUID/)
  assert.equal(storage.length, 0)
})

test("reads remove malformed, over-broad, and key-mismatched records without returning them", () => {
  const storage = memoryStorage()
  writePendingExperimentCreate(storage, scope, { operationId, input: { title: "Safe" } })
  const [key] = storage.entries()[0]

  storage.setItem(key, "not json")
  assert.equal(readPendingExperimentCreate(storage, scope, operationId), null)
  assert.equal(storage.length, 0)

  writePendingExperimentCreate(storage, scope, { operationId, input: { title: "Safe" } })
  storage.setItem(key, JSON.stringify({
    schemaId: "gb.eln-experiment-create-recovery.v1",
    state: "pending-create",
    operationId,
    input: { title: "Safe" },
    rawServerResponse: { access_token: "must-not-survive" },
  }))
  assert.deepEqual(listPendingExperimentCreates(storage, scope), [])
  assert.equal(storage.length, 0)

  storage.setItem(`${elnExperimentRecoveryNamespace(scope)}create:not-a-uuid`, "{}")
  assert.deepEqual(listPendingExperimentCreates(storage, scope), [])
  assert.equal(storage.length, 0)
})

test("observation recovery is scoped by tenant, principal, and experiment and preserves exact retry input", () => {
  const storage = memoryStorage()
  const request = {
    schemaId: "gb.eln-observation-create.v1",
    body: "Stable reading\nwith units: 4.2 mV",
    observedAt: null,
  }
  const written = writePendingExperimentObservation(storage, scope, { operationId, experimentId, request })
  assert.deepEqual(written.request, request)
  assert.deepEqual(listPendingExperimentObservations(storage, scope, experimentId), [written])
  assert.deepEqual(listPendingExperimentObservations(storage, otherScope, experimentId), [])
  assert.deepEqual(
    listPendingExperimentObservations(storage, scope, "77777777-7777-4777-8777-777777777777"),
    [],
  )
  assert.match(storage.entries()[0][0], new RegExp(`observation:${experimentId}:${operationId}$`))
  removePendingExperimentObservation(storage, scope, experimentId, operationId)
  assert.deepEqual(listPendingExperimentObservations(storage, scope, experimentId), [])
})

test("observation recovery rejects over-broad or non-round-trippable records", () => {
  const storage = memoryStorage()
  assert.throws(() => writePendingExperimentObservation(storage, scope, {
    operationId,
    experimentId,
    request: { schemaId: "gb.eln-observation-create.v1", body: " ", observedAt: null },
  }), /body is invalid/u)
  assert.throws(() => writePendingExperimentObservation(storage, scope, {
    operationId,
    experimentId,
    request: { schemaId: "gb.eln-observation-create.v1", body: "ok", observedAt: null, response: {} },
  }), /unexpected fields/u)
  assert.equal(storage.length, 0)
})

test("an observation operation is frozen to its first canonical request", () => {
  const storage = memoryStorage()
  const first = writePendingExperimentObservation(storage, scope, {
    operationId,
    experimentId,
    request: {
      schemaId: "gb.eln-observation-create.v1",
      body: "  Stable reading  ",
      observedAt: "2026-09-28T18:00:00.123456789+01:30",
    },
  })
  assert.deepEqual(first.request, {
    schemaId: "gb.eln-observation-create.v1",
    body: "Stable reading",
    observedAt: "2026-09-28T16:30:00.123000Z",
  })
  assert.deepEqual(writePendingExperimentObservation(storage, scope, {
    operationId,
    experimentId,
    request: first.request,
  }), first)
  assert.throws(() => writePendingExperimentObservation(storage, scope, {
    operationId,
    experimentId,
    request: { ...first.request, body: "Different reading" },
  }), /already bound to different input/u)
  assert.deepEqual(listPendingExperimentObservations(storage, scope, experimentId), [first])
  assert.equal(storage.length, 1)
})

test("observation recovery accepts only overflow-safe RFC 3339 timestamps", () => {
  for (const [index, observedAt] of [
    "20260928T163000Z",
    "2026-W40-1T16:30:00Z",
    "2026-09-28 16:30:00Z",
    "2026-09-28T16:30Z",
    "2026-09-28T16:30:00z",
    "2026-02-30T16:30:00Z",
    "0001-01-01T00:00:00+14:00",
    "9999-12-31T23:59:59-12:00",
  ].entries()) {
    assert.throws(() => writePendingExperimentObservation(memoryStorage(), scope, {
      operationId: `44444444-4444-4444-8444-${String(index + 1).padStart(12, "0")}`,
      experimentId,
      request: { schemaId: "gb.eln-observation-create.v1", body: "ok", observedAt },
    }), /observation time is invalid/u)
  }
})
