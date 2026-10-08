import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  PlacementRemovalConflictError,
  placementRemovalState,
  reconcilePlacementRemoval,
  validatePlacementRemovalEnvelope,
} from "../lib/canvas/placement-removal.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"

const CANVAS_ID = "123e4567-e89b-42d3-a456-426614174010"
const OTHER_CANVAS_ID = "123e4567-e89b-42d3-a456-426614174011"
const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000"
const PLACEMENT_ID = "reference-123e4567-e89b-42d3-a456-426614174099"
const SUBJECT_REF = createGalaxyObjectReference("paper", "paper-1")
const REPLACEMENT_REF = createGalaxyObjectReference("paper", "paper-2")

function item(id = PLACEMENT_ID, subjectRef = SUBJECT_REF) {
  return {
    id,
    subjectRef,
    nodeType: "galaxy.paper",
    x: 80,
    y: 80,
    width: 420,
    height: 260,
    angle: 0,
    zIndex: 0,
    displayMode: "card",
    collapsed: false,
    style: {},
  }
}

function snapshot({ items = [], removedItemIds = [] } = {}) {
  return {
    schemaId: "gb.canvas.snapshot.v1",
    items,
    edges: [],
    removedItemIds,
    removedEdgeIds: [],
  }
}

function canvas(content, overrides = {}) {
  return {
    canvasId: CANVAS_ID,
    workspaceId: "workspace-1",
    slug: "main",
    title: "Atlas",
    isDefault: true,
    version: 1,
    contentHash: `sha256:${"a".repeat(64)}`,
    content,
    ...overrides,
  }
}

test("removal state requires strict placement identifiers and distinguishes tombstones", () => {
  assert.equal(placementRemovalState(snapshot({ items: [item()] }), PLACEMENT_ID), "present")
  assert.equal(placementRemovalState(snapshot({ items: [item()] }), PLACEMENT_ID, SUBJECT_REF), "present")
  assert.equal(placementRemovalState(snapshot({ items: [item()] }), PLACEMENT_ID, REPLACEMENT_REF), "collision")
  assert.equal(placementRemovalState(snapshot(), PLACEMENT_ID), "untracked")
  assert.equal(placementRemovalState(snapshot({ removedItemIds: [PLACEMENT_ID] }), PLACEMENT_ID), "removed")
  for (const invalid of ["", " has-space", "has space", "x".repeat(129), null]) {
    assert.throws(() => placementRemovalState(snapshot(), invalid), /stable placement id/)
  }
})

test("removal refuses a same-id replacement before retrying", async () => {
  const current = canvas(snapshot({ items: [item()] }))
  const replacement = canvas(snapshot({ items: [item(PLACEMENT_ID, REPLACEMENT_REF)] }), {
    version: 2,
    contentHash: `sha256:${"b".repeat(64)}`,
  })
  let mutations = 0
  await assert.rejects(
    reconcilePlacementRemoval({
      current,
      placementId: PLACEMENT_ID,
      subjectRef: SUBJECT_REF,
      operationId: OPERATION_ID,
      mutateCanvas: async () => {
        mutations += 1
        throw new Error("conflict")
      },
      reloadCanvas: async () => replacement,
    }),
    (error) => error instanceof PlacementRemovalConflictError
      && error.code === "placement_identity_conflict",
  )
  assert.equal(mutations, 1)
})

test("removal refuses an initial identity mismatch and non-exact subject references", async () => {
  let mutations = 0
  await assert.rejects(
    reconcilePlacementRemoval({
      current: canvas(snapshot({ items: [item(PLACEMENT_ID, REPLACEMENT_REF)] })),
      placementId: PLACEMENT_ID,
      subjectRef: SUBJECT_REF,
      operationId: OPERATION_ID,
      mutateCanvas: async () => {
        mutations += 1
        return assert.fail("mutation was not expected")
      },
      reloadCanvas: async () => assert.fail("reload was not expected"),
    }),
    /identity collision/,
  )
  assert.equal(mutations, 0)

  await assert.rejects(
    reconcilePlacementRemoval({
      current: canvas(snapshot({ items: [item()] })),
      placementId: PLACEMENT_ID,
      subjectRef: `${SUBJECT_REF} `,
      operationId: OPERATION_ID,
      mutateCanvas: async () => assert.fail("mutation was not expected"),
      reloadCanvas: async () => assert.fail("reload was not expected"),
    }),
    /exact canonical subject reference/,
  )
})

test("success requires absence plus an authoritative removal tombstone", () => {
  const removed = canvas(snapshot({ removedItemIds: [PLACEMENT_ID] }))
  assert.equal(validatePlacementRemovalEnvelope(removed, PLACEMENT_ID, CANVAS_ID), removed)
  assert.throws(
    () => validatePlacementRemovalEnvelope(canvas(snapshot({ items: [item()] })), PLACEMENT_ID, CANVAS_ID),
    /identity collision/,
  )
  assert.throws(
    () => validatePlacementRemovalEnvelope(canvas(snapshot()), PLACEMENT_ID, CANVAS_ID),
    /without an authoritative tombstone/,
  )
  assert.throws(
    () => validatePlacementRemovalEnvelope(canvas(snapshot({ removedItemIds: [PLACEMENT_ID] }), {
      canvasId: OTHER_CANVAS_ID,
    }), PLACEMENT_ID, CANVAS_ID),
    /canvas identity collision/,
  )
  assert.throws(
    () => validatePlacementRemovalEnvelope(canvas({ ...snapshot(), removedItemIds: null }), PLACEMENT_ID),
    /bounded array/,
  )
})

test("removal sends one exact presentation-only command", async () => {
  const current = canvas(snapshot({ items: [item()] }))
  let observed
  const result = await reconcilePlacementRemoval({
    current,
    placementId: PLACEMENT_ID,
    subjectRef: SUBJECT_REF,
    operationId: OPERATION_ID,
    reloadCanvas: async () => assert.fail("reload was not expected"),
    mutateCanvas: async (canvasId, input) => {
      observed = { canvasId, input }
      return canvas(snapshot({ removedItemIds: [PLACEMENT_ID] }), {
        version: 2,
        contentHash: `sha256:${"b".repeat(64)}`,
      })
    },
  })
  assert.deepEqual(observed, {
    canvasId: CANVAS_ID,
    input: {
      expectedVersion: 1,
      expectedContentHash: `sha256:${"a".repeat(64)}`,
      idempotencyKey: `placement-remove:${OPERATION_ID}`,
      commands: [{ type: "item.remove", itemId: PLACEMENT_ID }],
    },
  })
  assert.equal(result.canvas.version, 2)
  assert.equal(result.placementId, PLACEMENT_ID)
  assert.equal(result.replayed, false)
  assert.equal(JSON.stringify(observed).includes("subjectRef"), false)
  assert.equal(JSON.stringify(observed).includes("provider"), false)
})

test("operation identifiers are canonical UUIDs", async () => {
  const current = canvas(snapshot({ items: [item()] }))
  for (const invalid of ["", OPERATION_ID.toUpperCase(), "123e4567-e89b-02d3-a456-426614174000", null]) {
    await assert.rejects(
      reconcilePlacementRemoval({
        current,
        placementId: PLACEMENT_ID,
        subjectRef: SUBJECT_REF,
        operationId: invalid,
        mutateCanvas: async () => assert.fail("mutation was not expected"),
        reloadCanvas: async () => assert.fail("reload was not expected"),
      }),
      /canonical UUID/,
    )
  }
})

test("a first failure reloads and retries once with the same key", async () => {
  const current = canvas(snapshot({ items: [item()] }))
  const latest = canvas(snapshot({ items: [item()] }), {
    version: 2,
    contentHash: `sha256:${"b".repeat(64)}`,
  })
  const calls = []
  const result = await reconcilePlacementRemoval({
    current,
    placementId: PLACEMENT_ID,
    subjectRef: SUBJECT_REF,
    operationId: OPERATION_ID,
    reloadCanvas: async () => latest,
    mutateCanvas: async (canvasId, input) => {
      calls.push({ canvasId, input })
      if (calls.length === 1) throw new Error("conflict")
      return canvas(snapshot({ removedItemIds: [PLACEMENT_ID] }), {
        version: 3,
        contentHash: `sha256:${"c".repeat(64)}`,
      })
    },
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].input.idempotencyKey, `placement-remove:${OPERATION_ID}`)
  assert.equal(calls[1].input.idempotencyKey, calls[0].input.idempotencyKey)
  assert.equal(calls[0].input.expectedVersion, 1)
  assert.equal(calls[1].input.expectedVersion, 2)
  assert.equal(result.canvas.version, 3)
})

test("ambiguous success is reconciled without a duplicate mutation", async () => {
  const current = canvas(snapshot({ items: [item()] }))
  let committed = current
  let mutations = 0
  const result = await reconcilePlacementRemoval({
    current,
    placementId: PLACEMENT_ID,
    subjectRef: SUBJECT_REF,
    operationId: OPERATION_ID,
    mutateCanvas: async () => {
      mutations += 1
      committed = canvas(snapshot({ removedItemIds: [PLACEMENT_ID] }), {
        version: 2,
        contentHash: `sha256:${"b".repeat(64)}`,
      })
      throw new Error("response lost")
    },
    reloadCanvas: async () => committed,
  })
  assert.equal(mutations, 1)
  assert.equal(result.replayed, true)
  assert.deepEqual(result.canvas.content.removedItemIds, [PLACEMENT_ID])
})

test("a replayed response is replaced by the current canvas head", async () => {
  const current = canvas(snapshot({ items: [item()] }))
  const head = canvas(snapshot({ removedItemIds: [PLACEMENT_ID] }), {
    version: 5,
    contentHash: `sha256:${"e".repeat(64)}`,
  })
  let reloads = 0
  const result = await reconcilePlacementRemoval({
    current,
    placementId: PLACEMENT_ID,
    subjectRef: SUBJECT_REF,
    operationId: OPERATION_ID,
    mutateCanvas: async () => canvas(snapshot({ removedItemIds: [PLACEMENT_ID] }), {
      version: 2,
      contentHash: `sha256:${"b".repeat(64)}`,
      replayed: true,
    }),
    reloadCanvas: async (canvasId) => {
      reloads += 1
      assert.equal(canvasId, CANVAS_ID)
      return head
    },
  })
  assert.equal(reloads, 1)
  assert.equal(result.canvas.version, 5)
  assert.equal(result.replayed, true)
})

test("reconciliation fails closed and performs at most one retry", async () => {
  const current = canvas(snapshot({ items: [item()] }))
  let mutations = 0
  await assert.rejects(
    reconcilePlacementRemoval({
      current,
      placementId: PLACEMENT_ID,
      subjectRef: SUBJECT_REF,
      operationId: OPERATION_ID,
      mutateCanvas: async () => {
        mutations += 1
        throw new Error("still unavailable")
      },
      reloadCanvas: async () => current,
    }),
    /still unavailable/,
  )
  assert.equal(mutations, 2)

  await assert.rejects(
    reconcilePlacementRemoval({
      current,
      placementId: PLACEMENT_ID,
      subjectRef: SUBJECT_REF,
      operationId: OPERATION_ID,
      mutateCanvas: async () => canvas(snapshot({ items: [item()] }), {
        version: 2,
        contentHash: `sha256:${"b".repeat(64)}`,
      }),
      reloadCanvas: async () => current,
    }),
    /identity collision/,
  )

  let reloads = 0
  await assert.rejects(
    reconcilePlacementRemoval({
      current,
      placementId: PLACEMENT_ID,
      subjectRef: SUBJECT_REF,
      operationId: OPERATION_ID,
      mutateCanvas: async () => ({ canvasId: CANVAS_ID }),
      reloadCanvas: async () => {
        reloads += 1
        return current
      },
    }),
    /canvas version must be positive/,
  )
  assert.equal(reloads, 0)
})

test("Atlas routes palette, inspector, and Delete through one confirmed removal lane", async () => {
  const client = await readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8")
  const dialog = await readFile(new URL("../components/atlas/placement-remove-dialog.tsx", import.meta.url), "utf8")
  assert.match(client, /reconcilePlacementRemoval/)
  assert.match(client, /onExecutePlacementCommand\("placement\.remove"/)
  assert.match(client, /requestSelectedPlacementRemoval\(returnFocus\)/)
  assert.match(client, /durableCanvas: completion\.canvas/)
  assert.match(client, /The canonical object was not deleted/)
  assert.match(client, /canRemovePlacement: atlasMutationReady && selectedPlacementContext !== null/)
  assert.match(client, /if \(!atlasMutationReady\) return/)
  assert.match(client, /disabled={!canRemovePlacement}/)
  assert.match(dialog, /removes only the spatial placement/)
  assert.match(dialog, /if \(!nextOpen && busy\) return/)
  assert.match(dialog, /onEscapeKeyDown/)
  assert.match(dialog, /role="status"/)
  assert.match(dialog, /<AlertDialogFooter aria-busy={busy}>/)
  assert.match(client, /error instanceof PlacementRemovalConflictError/)
  assert.match(client, /activeElement instanceof HTMLElement/)
  assert.match(client, /onPlacementRemovalError\(activeRequest\.operationId, message, false\)/)
  assert.doesNotMatch(client, /deleteCanonicalObject|removeCanonicalObject/)
})
