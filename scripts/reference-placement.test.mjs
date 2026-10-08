import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  createReferenceCanvasItem,
  inspectPlaceableReference,
  MAX_REFERENCE_PLACEMENT_COORDINATE,
  MAX_PLACEABLE_REFERENCE_CHARACTERS,
  normalizeReferencePlacementPoint,
  reconcileReferencePlacement,
  referencePlacementState,
  REFERENCE_PLACEMENT_STYLE,
  validateReferencePlacementEnvelope,
} from "../lib/canvas/reference-placement.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"

const OPERATION_A = "123e4567-e89b-42d3-a456-426614174000"
const OPERATION_B = "123e4567-e89b-42d3-a456-426614174001"

function snapshot(items = []) {
  return {
    schemaId: "gb.canvas.snapshot.v1",
    items,
    edges: [],
    removedItemIds: [],
    removedEdgeIds: [],
  }
}

function canvas(content, overrides = {}) {
  return {
    canvasId: "123e4567-e89b-42d3-a456-426614174010",
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

test("placeable reference inspection has one closed projection mapping", () => {
  const expected = new Map([
    ["paper", "galaxy.paper"],
    ["document", "galaxy.document"],
    ["document.anchor", "galaxy.document"],
    ["eln.experiment", "galaxy.eln-record"],
    ["ham.task", "galaxy.task"],
    ["ham.memory", "galaxy.note"],
    ["surface", "galaxy.surface"],
    ["proof.graph", "galaxy.proof"],
    ["proof.node", "galaxy.proof"],
  ])
  for (const [kind, nodeType] of expected) {
    const subjectRef = createGalaxyObjectReference(kind, `${kind}-1`)
    assert.deepEqual(inspectPlaceableReference(subjectRef), {
      ok: true,
      subjectRef,
      kind,
      nodeType,
    })
  }
  for (const kind of ["artifact", "code.repo", "document.mark", "eln.hypothesis", "run", "task-plan"]) {
    assert.deepEqual(inspectPlaceableReference(createGalaxyObjectReference(kind, "x")), {
      ok: false,
      code: "unsupported_kind",
    })
  }
})

test("conversation placement requires an exact snapshot and uses bounded card geometry", () => {
  const latest = createGalaxyObjectReference("chat", "research-thread")
  const versionPinned = createGalaxyObjectReference("chat", "research-thread", {
    mode: "pinned",
    revision: "version:3",
  })
  for (const subjectRef of [latest, versionPinned]) {
    assert.deepEqual(inspectPlaceableReference(subjectRef), {
      ok: false,
      code: "unsupported_kind",
    })
  }

  const pinned = createGalaxyObjectReference("chat", "research-thread", {
    mode: "pinned",
    revision: `sha256:${"c".repeat(64)}`,
  })
  assert.deepEqual(inspectPlaceableReference(pinned), {
    ok: true,
    subjectRef: pinned,
    kind: "chat",
    nodeType: "galaxy.chat",
  })

  const item = createReferenceCanvasItem(pinned, OPERATION_A, snapshot())
  assert.deepEqual(item, {
    id: `reference-${OPERATION_A}`,
    subjectRef: pinned,
    nodeType: "galaxy.chat",
    x: 80,
    y: 80,
    width: 420,
    height: 260,
    angle: 0,
    zIndex: 0,
    displayMode: "card",
    collapsed: false,
    style: { schemaId: REFERENCE_PLACEMENT_STYLE },
  })
  for (const forbidden of ["title", "summary", "content", "provider", "projection"]) {
    assert.equal(Object.hasOwn(item, forbidden), false)
  }
})

test("ELN observation placement requires an exact immutable revision", () => {
  const latest = createGalaxyObjectReference("eln.observation", "123e4567-e89b-42d3-a456-426614174020")
  const versionPinned = createGalaxyObjectReference("eln.observation", "123e4567-e89b-42d3-a456-426614174020", {
    mode: "pinned",
    revision: "version:1",
  })
  for (const subjectRef of [latest, versionPinned]) {
    assert.deepEqual(inspectPlaceableReference(subjectRef), {
      ok: false,
      code: "unsupported_kind",
    })
  }

  const pinned = createGalaxyObjectReference("eln.observation", "123e4567-e89b-42d3-a456-426614174020", {
    mode: "pinned",
    revision: `sha256:${"b".repeat(64)}`,
  })
  assert.deepEqual(inspectPlaceableReference(pinned), {
    ok: true,
    subjectRef: pinned,
    kind: "eln.observation",
    nodeType: "galaxy.eln-record",
  })
})

test("inspection rejects legacy, aliases, whitespace, and renderer-unsafe lengths", () => {
  assert.deepEqual(inspectPlaceableReference("gb:node:legacy"), { ok: false, code: "invalid_reference" })
  assert.deepEqual(inspectPlaceableReference(" gb:object:v1:paper:x:latest"), {
    ok: false,
    code: "invalid_reference",
  })
  assert.deepEqual(inspectPlaceableReference("gb:object:v1:paper:%41:latest"), {
    ok: false,
    code: "noncanonical_reference",
  })
  assert.deepEqual(inspectPlaceableReference("x".repeat(MAX_PLACEABLE_REFERENCE_CHARACTERS + 1)), {
    ok: false,
    code: "invalid_reference",
  })
})

test("generic placement can exclude surfaces while the promoted picker keeps the shared saga", () => {
  const surface = createGalaxyObjectReference("surface", "surface-1", {
    mode: "pinned",
    revision: `sha256:${"a".repeat(64)}`,
  })
  assert.equal(inspectPlaceableReference(surface).ok, true)
  assert.deepEqual(inspectPlaceableReference(surface, { allowSurface: false }), {
    ok: false,
    code: "unsupported_kind",
  })
})

test("placement items contain identity and presentation only", () => {
  const subjectRef = createGalaxyObjectReference("paper", "paper-1")
  const item = createReferenceCanvasItem(subjectRef, OPERATION_A, snapshot())
  assert.deepEqual(item, {
    id: `reference-${OPERATION_A}`,
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
    style: { schemaId: REFERENCE_PLACEMENT_STYLE },
  })
  assert.equal(JSON.stringify(item).includes("title"), false)
  assert.equal(JSON.stringify(item).includes("provider"), false)
  assert.equal(JSON.stringify(item).includes("projection"), false)
})

test("placement geometry advances over the bounded four-column grid and top z", () => {
  const existingRef = createGalaxyObjectReference("document", "existing")
  const existing = Array.from({ length: 5 }, (_, index) => ({
    id: `existing-${index}`,
    subjectRef: existingRef,
    nodeType: "galaxy.document",
    x: index,
    y: index,
    width: 100,
    height: 100,
    angle: 0,
    zIndex: index === 4 ? 20 : index,
    displayMode: "card",
    collapsed: false,
    style: {},
  }))
  const item = createReferenceCanvasItem(
    createGalaxyObjectReference("surface", "surface-1"),
    OPERATION_A,
    snapshot(existing),
  )
  assert.deepEqual(
    { x: item.x, y: item.y, width: item.width, height: item.height, zIndex: item.zIndex },
    { x: 530, y: 380, width: 500, height: 340, zIndex: 21 },
  )
})

test("an optional bounded world point overrides position while preserving size, stacking, and grid fallback", () => {
  const subjectRef = createGalaxyObjectReference("document", "drop-target")
  const existing = createReferenceCanvasItem(subjectRef, OPERATION_B, snapshot())
  const pointed = createReferenceCanvasItem(subjectRef, OPERATION_A, snapshot([existing]), { x: -125.5, y: 840.25 })
  assert.deepEqual(
    { x: pointed.x, y: pointed.y, width: pointed.width, height: pointed.height, zIndex: pointed.zIndex },
    { x: -125.5, y: 840.25, width: 420, height: 260, zIndex: 1 },
  )
  const fallback = createReferenceCanvasItem(subjectRef, OPERATION_A, snapshot([existing]))
  assert.deepEqual({ x: fallback.x, y: fallback.y }, { x: 530, y: 80 })
  assert.deepEqual(normalizeReferencePlacementPoint({ x: -0, y: 1 }), { x: 0, y: 1 })
  for (const point of [
    { x: Number.NaN, y: 0 },
    { x: 0, y: Number.POSITIVE_INFINITY },
    { x: MAX_REFERENCE_PLACEMENT_COORDINATE + 1, y: 0 },
    { x: 0, y: 0, z: 0 },
  ]) assert.throws(() => normalizeReferencePlacementPoint(point), /placement point/u)
})

test("operation identity permits separate presentations and detects replay or collision", () => {
  const subjectRef = createGalaxyObjectReference("ham.memory", "3729")
  const first = createReferenceCanvasItem(subjectRef, OPERATION_A, snapshot())
  const second = createReferenceCanvasItem(subjectRef, OPERATION_B, snapshot([first]))
  assert.notEqual(first.id, second.id)
  assert.equal(referencePlacementState(snapshot(), first), "absent")
  assert.equal(referencePlacementState(snapshot([first]), first), "replayed")
  assert.equal(referencePlacementState(snapshot([{ ...first, subjectRef: createGalaxyObjectReference("ham.memory", "other") }]), first), "collision")
})

test("authoritative envelopes must contain the exact placement identity", () => {
  const item = createReferenceCanvasItem(
    createGalaxyObjectReference("proof.node", "theorem-1"),
    OPERATION_A,
    snapshot(),
  )
  const authoritative = canvas(snapshot([item]))
  assert.equal(validateReferencePlacementEnvelope(authoritative, item), authoritative)
  assert.throws(
    () => validateReferencePlacementEnvelope(canvas(snapshot()), item),
    /absent from the authoritative canvas/,
  )
  assert.throws(
    () => validateReferencePlacementEnvelope(canvas(snapshot([{
      ...item,
      nodeType: "galaxy.task",
    }])), item),
    /identity collision/,
  )
})

test("reconciliation retries one conflict with the same operation identity", async () => {
  const subjectRef = createGalaxyObjectReference("paper", "paper-retry")
  const current = canvas(snapshot(), { version: 1, contentHash: `sha256:${"1".repeat(64)}` })
  const latest = canvas(snapshot(), { version: 2, contentHash: `sha256:${"2".repeat(64)}` })
  const calls = []
  const result = await reconcileReferencePlacement({
    current,
    subjectRef,
    operationId: OPERATION_A,
    reloadCanvas: async () => latest,
    mutateCanvas: async (canvasId, input) => {
      calls.push({ canvasId, input })
      if (calls.length === 1) throw new Error("conflict")
      return canvas(snapshot([input.commands[0].item]), {
        version: 3,
        contentHash: `sha256:${"3".repeat(64)}`,
      })
    },
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].input.idempotencyKey, `reference-place:${OPERATION_A}`)
  assert.equal(calls[1].input.idempotencyKey, calls[0].input.idempotencyKey)
  assert.equal(calls[0].input.expectedVersion, 1)
  assert.equal(calls[1].input.expectedVersion, 2)
  assert.equal(result.canvas.version, 3)
  assert.equal(result.item.id, `reference-${OPERATION_A}`)
})

test("ambiguous success reconciles without duplicating the placement", async () => {
  const subjectRef = createGalaxyObjectReference("ham.task", "task-ambiguous")
  const current = canvas(snapshot())
  let committed = current
  let mutationCalls = 0
  const result = await reconcileReferencePlacement({
    current,
    subjectRef,
    operationId: OPERATION_A,
    mutateCanvas: async (_canvasId, input) => {
      mutationCalls += 1
      committed = canvas(snapshot([input.commands[0].item]), {
        version: 2,
        contentHash: `sha256:${"2".repeat(64)}`,
      })
      throw new Error("response lost")
    },
    reloadCanvas: async () => committed,
  })
  assert.equal(mutationCalls, 1)
  assert.equal(result.replayed, true)
  assert.equal(result.canvas.content.items.length, 1)
})

test("pointed placement replay focuses the original identity without a duplicate canvas mutation", async () => {
  const subjectRef = createGalaxyObjectReference("document", "same-drop")
  const point = { x: 444.5, y: -72 }
  let mutations = 0
  let authoritative = canvas(snapshot())
  const transport = {
    subjectRef,
    operationId: OPERATION_A,
    point,
    mutateCanvas: async (_canvasId, input) => {
      mutations += 1
      authoritative = canvas(snapshot([input.commands[0].item]), { version: 2 })
      return authoritative
    },
    reloadCanvas: async () => authoritative,
  }
  const first = await reconcileReferencePlacement({ ...transport, current: authoritative })
  const replay = await reconcileReferencePlacement({ ...transport, current: first.canvas })
  assert.equal(mutations, 1)
  assert.equal(replay.replayed, true)
  assert.deepEqual({ x: replay.item.x, y: replay.item.y }, point)
  assert.equal(replay.canvas.content.items.length, 1)
})

test("historical idempotent replay is replaced by current canvas head", async () => {
  const subjectRef = createGalaxyObjectReference("proof.graph", "graph-replay")
  const current = canvas(snapshot())
  let head
  let reloads = 0
  const result = await reconcileReferencePlacement({
    current,
    subjectRef,
    operationId: OPERATION_A,
    mutateCanvas: async (_canvasId, input) => {
      const item = input.commands[0].item
      head = canvas(snapshot([item]), {
        version: 5,
        contentHash: `sha256:${"5".repeat(64)}`,
      })
      return canvas(snapshot([item]), {
        version: 2,
        contentHash: `sha256:${"2".repeat(64)}`,
        replayed: true,
      })
    },
    reloadCanvas: async () => {
      reloads += 1
      return head
    },
  })
  assert.equal(reloads, 1)
  assert.equal(result.canvas.version, 5)
  assert.equal(result.replayed, true)
})

test("reconciliation stops after one retry and leaves the operation reusable", async () => {
  const current = canvas(snapshot())
  let mutations = 0
  await assert.rejects(
    reconcileReferencePlacement({
      current,
      subjectRef: createGalaxyObjectReference("surface", "surface-fail"),
      operationId: OPERATION_A,
      mutateCanvas: async () => {
        mutations += 1
        throw new Error("still unavailable")
      },
      reloadCanvas: async () => current,
    }),
    /still unavailable/,
  )
  assert.equal(mutations, 2)
})

test("Atlas integration owns mutation, lifts the envelope, and never serializes hydrated content", async () => {
  const client = await readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8")
  const dialog = await readFile(new URL("../components/atlas/reference-place-dialog.tsx", import.meta.url), "utf8")
  assert.match(client, /reconcileReferencePlacement/)
  assert.match(client, /durableCanvas: completion\.canvas/)
  assert.match(client, /referencePlacementRetry\?\.subjectRef === subjectRef/)
  assert.match(client, /attempt: referencePlacementRetry\.attempt \+ 1/)
  assert.match(client, /setFocusPlacementId\(completion\.placementId\)/)
  assert.match(client, /onFocusPlacementConsumed\(focusPlacementId\)/)
  assert.match(client, /const atlasRuntimeReady = Boolean\(!preview && mounted && atlas && runtimeProjection && !loading && !loadError\)/)
  assert.match(client, /const atlasMutationReady = atlasRuntimeReady && !frameMutationBusy && frameMutationOperation === null/)
  assert.match(client, /canPlaceReference: atlasMutationReady/)
  assert.match(dialog, /authorized content resolves after placement/)
  assert.match(dialog, /aria-invalid=/)
  assert.match(dialog, /role="alert"/)
  assert.match(dialog, /if \(!nextOpen && busy\) return/)
  assert.doesNotMatch(dialog, /value\.trim\(\)/)
})
