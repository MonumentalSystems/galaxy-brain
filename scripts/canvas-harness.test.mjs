import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { performance } from "node:perf_hooks"
import test from "node:test"

import { createCanvasStore } from "@canvas-harness/core"

import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import { applyAtlasHydrationAvailability } from "../lib/atlas-object-hydration.js"

import {
  GALAXY_CANVAS_NODE_TYPES,
  GALAXY_RELATION_TRUST_CLASSES,
  canvasEdgeId,
  canvasFrameNodeId,
  canvasNodeId,
  projectGalaxyCanvas,
} from "../lib/canvas/galaxy-canvas-adapter.js"
import {
  AtlasFrameMutationConflictError,
  AtlasFrameMutationTerminalError,
  atlasFrameMutationRecoveryKey,
  atlasFrameMutationState,
  canvasFrameFromInput,
  clampAtlasFrameGeometry,
  commandsForFrameGeometry,
  frameCreateCommand,
  frameRemoveCommand,
  prepareAtlasFrameMutationOperation,
  quarantineAtlasFrameMutationJournal,
  readPendingAtlasFrameMutation,
  reconcileAtlasFrameMutation,
  removePendingAtlasFrameMutation,
  writePendingAtlasFrameMutation,
} from "../lib/canvas/atlas-frame.js"
import { paintGalaxyCanvasNode } from "../lib/canvas/galaxy-canvas-painter.js"
import {
  buildPrimitiveCanvasFixture,
  buildResearchCanvasFixture,
} from "../lib/canvas/galaxy-canvas-fixtures.js"
import {
  AUTHORIZED_CANVAS_SOURCE_LIMIT,
  buildAuthorizedCanvasProjection,
  projectAuthorizedObjectLinkRelations,
} from "../lib/canvas/authorized-canvas-projection.js"
import {
  ATLAS_CAMERA_PAN_STEP,
  ATLAS_FAR_OVERVIEW_ZOOM,
  ATLAS_MEDIUM_ZOOM,
  cameraForAtlasNodes,
  panAtlasCamera,
} from "../lib/canvas/atlas-camera.js"
import { deriveAtlasConstellationScene } from "../lib/canvas/atlas-constellation-lod.js"
import {
  CANVAS_CHANGE_POLL_INTERVAL_MS,
  CANVAS_CHANGE_POLL_MAX_INTERVAL_MS,
  canvasChangeEventFromRevision,
  canvasChangeAction,
  canvasChangePollDelay,
  canvasReloadSatisfiesChange,
  hashCanvasSnapshot,
  normalizeCanvasSnapshot,
  serializeCanvasSnapshot,
} from "../lib/canvas/canvas-snapshot.js"
import {
  createCanvasChangePoller,
  isTerminalCanvasPollError,
} from "../lib/canvas/canvas-convergence.js"
import {
  applyCanvasPlacementOverrides,
  canvasNodeGeometry,
  commandsForPlacementGeometry,
  mergeCanvasSnapshot,
  mergeCanvasSnapshotWithPlacementOverrides,
  snapshotItemFromPlacement,
} from "../lib/canvas/canvas-persistence.js"
import {
  projectCanvasNodeObject,
  resolvedCanvasNodeRepresentation,
} from "../lib/canvas/canvas-object-projection.js"
import {
  BLOCKED_CANVAS_STORE_METHODS,
  asPlacementCanvasStore,
  asReadOnlyCanvasStore,
} from "../lib/canvas/read-only-canvas-store.js"

async function waitFor(condition, message, timeoutMs = 500) {
  const deadline = performance.now() + timeoutMs
  while (!condition() && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(condition(), message)
}

function placement(id, overrides = {}) {
  return {
    id,
    authorized: true,
    subjectRef: `gb:object:v1:paper:${id}:latest`,
    nodeType: "galaxy.paper",
    x: 0,
    y: 0,
    width: 320,
    height: 200,
    display: { title: id },
    ...overrides,
  }
}

function relation(id, sourcePlacementId, targetPlacementId, trustClass, overrides = {}) {
  return {
    id,
    sourcePlacementId,
    targetPlacementId,
    relationType: trustClass === "near" ? "near" : "supports",
    trustClass,
    owner: trustClass === "deterministic" ? "prove2me" : "galaxy",
    ...(trustClass === "verified" ? { evidenceRef: "gb:object:v1:artifact:receipt-1:latest" } : {}),
    ...overrides,
  }
}

function representativeProjection() {
  return {
    placements: [
      placement("proof", {
        subjectRef: "gb:object:v1:proof.node:proof-1:pinned:sha256%3Aproof",
        nodeType: "galaxy.proof",
        x: 760,
        y: 80,
        width: 360,
        height: 240,
        zIndex: 8,
        display: { title: "Verified lemma", status: "verified", badges: ["proof"] },
      }),
      placement("paper", {
        subjectRef: "gb:object:v1:paper:paper-1:latest",
        x: 40,
        y: 80,
        display: {
          title: "Bounded research atlas",
          summary: "An authorized display-safe summary.",
          href: "/papers/paper-1",
          internalPrincipalId: "must-not-cross-the-projection-boundary",
        },
      }),
      placement("note", {
        subjectRef: "gb:object:v1:artifact:note-1:latest",
        nodeType: "galaxy.note",
        x: 400,
        y: 80,
        display: { title: "Research note", markdown: "A bounded **note**." },
      }),
      placement("private", {
        authorized: false,
        subjectRef: "gb:object:v1:paper:private-paper:latest",
        x: 1_200,
        display: { title: "Private title must not be projected" },
      }),
    ],
    relations: [
      relation("verified", "paper", "proof", "verified", { provenance: "verifier:accepted" }),
      relation("near", "note", "proof", "near", { owner: "ham" }),
      relation("asserted", "paper", "note", "asserted"),
      relation("deterministic", "proof", "note", "deterministic"),
      relation("private-edge", "paper", "private", "asserted"),
    ],
  }
}

test("Galaxy placement and relation identifiers are stable and namespaced", () => {
  assert.equal(canvasNodeId("paper-1"), "placement:paper-1")
  assert.equal(canvasNodeId("paper-1"), canvasNodeId("paper-1"))
  assert.equal(canvasEdgeId("supports-1"), "relation:supports-1")
  assert.notEqual(canvasNodeId("shared-resource:first"), canvasNodeId("shared-resource:second"))

  for (const invalid of ["", " spaced ", "slash/id", "\u0000control", "x".repeat(129)]) {
    assert.throws(() => canvasNodeId(invalid), /stable identifier/)
  }
})

test("canvas snapshots have stable RFC 8785 bytes and hashes across equivalent input", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("../services/galaxy-brain-api/contracts/fixtures/canvas-snapshot-v1.json", import.meta.url),
    "utf8",
  ))

  assert.equal(serializeCanvasSnapshot(fixture.input), fixture.canonical)
  assert.equal(serializeCanvasSnapshot(fixture.reorderedInput), fixture.canonical)
  assert.equal(await hashCanvasSnapshot(fixture.input), fixture.contentHash)
  assert.equal(Object.is(normalizeCanvasSnapshot(fixture.input).items[0].x, -0), false)
  assert.equal(serializeCanvasSnapshot(fixture.frameInput), fixture.frameCanonical)
  assert.equal(await hashCanvasSnapshot(fixture.frameInput), fixture.frameContentHash)
})

test("canvas frames are optional, bounded, canonical, and omit empty arrays", () => {
  const empty = normalizeCanvasSnapshot({ schemaId: "gb.canvas.snapshot.v1", items: [], edges: [], frames: [] })
  assert.equal(Object.hasOwn(empty, "frames"), false)
  const content = normalizeCanvasSnapshot({
    schemaId: "gb.canvas.snapshot.v1",
    items: [],
    edges: [],
    frames: [
      { id: "z-frame", title: "Results", x: 20, y: 10, width: 800, height: 500, tone: "amber" },
      { id: "a-frame", title: "Sources", x: -20, y: 0, width: 600, height: 400, tone: "sage" },
    ],
  })
  assert.deepEqual(content.frames.map((frame) => frame.id), ["a-frame", "z-frame"])
  assert.throws(() => normalizeCanvasSnapshot({
    schemaId: "gb.canvas.snapshot.v1", items: [], edges: [],
    frames: [{ id: "bad", title: "Bad", x: 0, y: 0, width: 100, height: 200, tone: "sage" }],
  }), /finite number/)
  const astralBoundary = "😀".repeat(60)
  assert.equal(normalizeCanvasSnapshot({
    schemaId: "gb.canvas.snapshot.v1", items: [], edges: [],
    frames: [{ id: "astral", title: astralBoundary, x: 0, y: 0, width: 720, height: 480, tone: "plum" }],
  }).frames[0].title, astralBoundary)
  assert.throws(() => normalizeCanvasSnapshot({
    schemaId: "gb.canvas.snapshot.v1", items: [], edges: [],
    frames: [{ id: "astral", title: "😀".repeat(61), x: 0, y: 0, width: 720, height: 480, tone: "plum" }],
  }), /bounded text/)
})

test("frame helpers and projection keep presentation geometry outside object authority", () => {
  const frame = canvasFrameFromInput({
    id: "sources", title: "Sources", x: 10, y: 20, width: 720, height: 480, tone: "sage",
  })
  const snapshot = normalizeCanvasSnapshot({ schemaId: "gb.canvas.snapshot.v1", items: [], edges: [], frames: [frame] })
  assert.deepEqual(frameCreateCommand(frame), { type: "frame.create", frame })
  assert.deepEqual(commandsForFrameGeometry(snapshot, "sources", {
    x: 40, y: 20, width: 900, height: 480,
  }), [
    { type: "frame.move", frameId: "sources", position: { x: 40, y: 20 } },
    { type: "frame.resize", frameId: "sources", size: { width: 900, height: 480 } },
  ])
  assert.deepEqual(frameRemoveCommand(snapshot, "sources"), { type: "frame.remove", frameId: "sources" })
  const scene = projectGalaxyCanvas({ placements: [], relations: [], frames: [frame] })
  assert.equal(canvasFrameNodeId("sources"), "frame:sources")
  assert.equal(scene.nodes[0].type, "frame")
  assert.deepEqual(scene.nodes[0].data, { schemaId: "gb.canvas.frame.v1", frameId: "sources", tone: "sage" })
  assert.equal(Object.hasOwn(scene.nodes[0].data, "subjectRef"), false)
  assert.deepEqual(clampAtlasFrameGeometry({ x: 20_000_000, y: -20_000_000, width: 1, height: 20_000 }), {
    x: 10_000_000, y: -10_000_000, width: 160, height: 10_000,
  })
  assert.deepEqual(commandsForFrameGeometry(snapshot, "sources", {
    x: 10, y: 20, width: 1, height: 20_000,
  }), [{ type: "frame.resize", frameId: "sources", size: { width: 160, height: 10_000 } }])
  assert.deepEqual(deriveAtlasConstellationScene(scene.nodes, "far"), {
    level: "far", sourceCount: 0, nodes: [], edges: [],
  })
  assert.deepEqual(deriveAtlasConstellationScene(scene.nodes, "medium"), {
    level: "medium", sourceCount: 0, nodes: [], edges: [],
  })
})

test("frame create and remove recovery journals one exact scoped operation", () => {
  const storage = (() => {
    const values = new Map()
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    }
  })()
  const scope = {
    tenantId: "10000000-0000-4000-8000-000000000001",
    principalId: "20000000-0000-4000-8000-000000000001",
    workspaceId: "workspace-main",
    canvasId: "30000000-0000-4000-8000-000000000001",
  }
  const frame = canvasFrameFromInput({
    id: "sources", title: "Sources", x: 10, y: 20, width: 720, height: 480, tone: "sage",
  })
  const operation = prepareAtlasFrameMutationOperation({
    ...scope, kind: "create", frame, operationId: "40000000-0000-4000-8000-000000000001",
  })
  assert.equal(operation.idempotencyKey, "frame-create:40000000-0000-4000-8000-000000000001")
  assert.match(atlasFrameMutationRecoveryKey(scope), /galaxy\.atlas-frame-mutation\.v1/u)
  assert.equal(readPendingAtlasFrameMutation(storage, scope), null)
  assert.deepEqual(writePendingAtlasFrameMutation(storage, scope, operation), operation)
  assert.deepEqual(readPendingAtlasFrameMutation(storage, scope), operation)
  assert.throws(() => writePendingAtlasFrameMutation(storage, scope, prepareAtlasFrameMutationOperation({
    ...scope, kind: "remove", frame, operationId: "50000000-0000-4000-8000-000000000001",
  })), /another frame mutation/)
  assert.equal(removePendingAtlasFrameMutation(storage, scope, "50000000-0000-4000-8000-000000000001"), false)
  assert.equal(removePendingAtlasFrameMutation(storage, scope, operation.operationId), true)
  assert.equal(readPendingAtlasFrameMutation(storage, scope), null)

  const otherScope = { ...scope, canvasId: "30000000-0000-4000-8000-000000000002" }
  storage.setItem(atlasFrameMutationRecoveryKey(scope), "{malformed")
  storage.setItem(atlasFrameMutationRecoveryKey(otherScope), "foreign")
  assert.equal(quarantineAtlasFrameMutationJournal(storage, scope), true)
  assert.equal(storage.getItem(atlasFrameMutationRecoveryKey(scope)), null)
  assert.equal(storage.getItem(atlasFrameMutationRecoveryKey(otherScope)), "foreign")
})

test("frame mutation reconciliation preserves identity across ambiguous create and remove", async () => {
  const scope = {
    tenantId: "10000000-0000-4000-8000-000000000001",
    principalId: "20000000-0000-4000-8000-000000000001",
    workspaceId: "workspace-main",
    canvasId: "30000000-0000-4000-8000-000000000001",
  }
  const frame = canvasFrameFromInput({
    id: "sources", title: "Sources", x: 10, y: 20, width: 720, height: 480, tone: "sage",
  })
  const empty = normalizeCanvasSnapshot({ schemaId: "gb.canvas.snapshot.v1", items: [], edges: [] })
  const framed = normalizeCanvasSnapshot({ ...empty, frames: [frame] })
  const envelope = (content, version, suffix) => ({
    ...scope, slug: "main", title: "Atlas", isDefault: true,
    version, contentHash: `sha256:${suffix.repeat(64)}`, content,
  })
  const create = prepareAtlasFrameMutationOperation({
    ...scope, kind: "create", frame, operationId: "40000000-0000-4000-8000-000000000001",
  })
  let committed = envelope(empty, 1, "a")
  let createCalls = 0
  const created = await reconcileAtlasFrameMutation({
    current: committed,
    operation: create,
    mutateCanvas: async (_canvasId, input) => {
      createCalls += 1
      assert.equal(input.idempotencyKey, create.idempotencyKey)
      committed = envelope(framed, 2, "b")
      throw new Error("response lost")
    },
    reloadCanvas: async () => committed,
  })
  assert.equal(createCalls, 1)
  assert.equal(created.replayed, true)
  assert.equal(atlasFrameMutationState(created.canvas.content, frame), "exact")

  const remove = prepareAtlasFrameMutationOperation({
    ...scope, kind: "remove", frame, operationId: "50000000-0000-4000-8000-000000000001",
  })
  let removeCalls = 0
  const removed = await reconcileAtlasFrameMutation({
    current: committed,
    operation: remove,
    mutateCanvas: async (_canvasId, input) => {
      removeCalls += 1
      assert.equal(input.idempotencyKey, remove.idempotencyKey)
      committed = envelope(empty, 3, "c")
      throw new Error("response lost")
    },
    reloadCanvas: async () => committed,
  })
  assert.equal(removeCalls, 1)
  assert.equal(removed.replayed, true)
  assert.equal(atlasFrameMutationState(removed.canvas.content, frame), "absent")
})

test("frame mutation retries an uncommitted ambiguous request with the exact same key", async () => {
  const scope = {
    tenantId: "10000000-0000-4000-8000-000000000001",
    principalId: "20000000-0000-4000-8000-000000000001",
    workspaceId: "workspace-main",
    canvasId: "30000000-0000-4000-8000-000000000001",
  }
  const frame = canvasFrameFromInput({
    id: "sources", title: "Sources", x: 10, y: 20, width: 720, height: 480, tone: "sage",
  })
  const empty = normalizeCanvasSnapshot({ schemaId: "gb.canvas.snapshot.v1", items: [], edges: [] })
  const framed = normalizeCanvasSnapshot({ ...empty, frames: [frame] })
  const operation = prepareAtlasFrameMutationOperation({
    ...scope, kind: "create", frame, operationId: "40000000-0000-4000-8000-000000000001",
  })
  const calls = []
  const result = await reconcileAtlasFrameMutation({
    current: { ...scope, slug: "main", title: "Atlas", isDefault: true, version: 1, contentHash: `sha256:${"a".repeat(64)}`, content: empty },
    operation,
    mutateCanvas: async (_canvasId, input) => {
      calls.push(input)
      if (calls.length === 1) throw new Error("request outcome unavailable")
      return { ...scope, slug: "main", title: "Atlas", isDefault: true, version: 3, contentHash: `sha256:${"c".repeat(64)}`, content: framed }
    },
    reloadCanvas: async () => ({ ...scope, slug: "main", title: "Atlas", isDefault: true, version: 2, contentHash: `sha256:${"b".repeat(64)}`, content: empty }),
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].idempotencyKey, calls[1].idempotencyKey)
  assert.equal(calls[0].expectedVersion, 1)
  assert.equal(calls[1].expectedVersion, 2)
  assert.equal(result.canvas.version, 3)
})

test("terminal frame rejection adopts the authoritative absent head without retrying", async () => {
  const scope = {
    tenantId: "10000000-0000-4000-8000-000000000001",
    principalId: "20000000-0000-4000-8000-000000000001",
    workspaceId: "workspace-main",
    canvasId: "30000000-0000-4000-8000-000000000001",
  }
  const frame = canvasFrameFromInput({
    id: "overflow", title: "Frame 101", x: 10, y: 20, width: 720, height: 480, tone: "sage",
  })
  const empty = normalizeCanvasSnapshot({ schemaId: "gb.canvas.snapshot.v1", items: [], edges: [] })
  const envelope = (content, version, suffix) => ({
    ...scope, slug: "main", title: "Atlas", isDefault: true,
    version, contentHash: `sha256:${suffix.repeat(64)}`, content,
  })
  const operation = prepareAtlasFrameMutationOperation({
    ...scope, kind: "create", frame, operationId: "40000000-0000-4000-8000-000000000001",
  })
  const authoritative = envelope(empty, 2, "b")
  let mutationCalls = 0
  await assert.rejects(reconcileAtlasFrameMutation({
    current: envelope(empty, 1, "a"),
    operation,
    mutateCanvas: async () => {
      mutationCalls += 1
      throw Object.assign(new Error("frames must be a bounded array"), { status: 422 })
    },
    reloadCanvas: async () => authoritative,
  }), (error) => (
    error instanceof AtlasFrameMutationTerminalError
    && error.status === 422
    && error.canvas.version === authoritative.version
    && error.canvas.contentHash === authoritative.contentHash
  ))
  assert.equal(mutationCalls, 1)
})

test("frame collision errors carry the authoritative reloaded canvas", async () => {
  const scope = {
    tenantId: "10000000-0000-4000-8000-000000000001",
    principalId: "20000000-0000-4000-8000-000000000001",
    workspaceId: "workspace-main",
    canvasId: "30000000-0000-4000-8000-000000000001",
  }
  const frame = canvasFrameFromInput({
    id: "sources", title: "Sources", x: 10, y: 20, width: 720, height: 480, tone: "sage",
  })
  const collision = { ...frame, title: "Changed elsewhere" }
  const empty = normalizeCanvasSnapshot({ schemaId: "gb.canvas.snapshot.v1", items: [], edges: [] })
  const collisionContent = normalizeCanvasSnapshot({ ...empty, frames: [collision] })
  const authoritative = {
    ...scope, slug: "main", title: "Atlas", isDefault: true, version: 2,
    contentHash: `sha256:${"b".repeat(64)}`, content: collisionContent,
  }
  const operation = prepareAtlasFrameMutationOperation({
    ...scope, kind: "create", frame, operationId: "40000000-0000-4000-8000-000000000001",
  })
  await assert.rejects(reconcileAtlasFrameMutation({
    current: {
      ...authoritative, version: 1, contentHash: `sha256:${"a".repeat(64)}`, content: empty,
    },
    operation,
    mutateCanvas: async () => { throw new Error("response unavailable") },
    reloadCanvas: async () => authoritative,
  }), (error) => (
    error instanceof AtlasFrameMutationConflictError
    && error.canvas.version === authoritative.version
    && error.canvas.content.frames[0].title === "Changed elsewhere"
  ))
})

test("canvas snapshot and convergence contracts reject unsafe or transient state", () => {
  const base = {
    schemaId: "gb.canvas.snapshot.v1",
    items: [],
    edges: [],
  }
  assert.throws(() => normalizeCanvasSnapshot({ ...base, camera: { x: 0, y: 0 } }), /camera is not supported/)
  assert.throws(() => normalizeCanvasSnapshot({ ...base, removedItemIds: null }), /bounded array/)
  assert.throws(() => normalizeCanvasSnapshot({
    ...base,
    items: [{
      id: "unsafe",
      subjectRef: "https://example.com/object",
      nodeType: "galaxy.note",
      x: Number.NaN,
      y: 0,
      width: 400,
      height: 260,
      angle: 0,
      zIndex: 0,
      displayMode: "card",
      collapsed: false,
      style: {},
    }],
  }), /canonical Galaxy object reference|finite number/)
  const event = {
    schemaId: "gb.canvas.changed.v1",
    canvasId: "10000000-0000-4000-8000-000000000001",
    version: 13,
    contentHash: `sha256:${"a".repeat(64)}`,
    mutationId: "mutation-13",
  }
  assert.equal(canvasChangeAction({ version: 13, contentHash: event.contentHash }, false, event), "ignore")
  assert.equal(canvasChangeAction({ version: 13, contentHash: `sha256:${"b".repeat(64)}` }, false, event), "notify")
  assert.equal(canvasChangeAction({ version: 12, contentHash: `sha256:${"b".repeat(64)}` }, false, event), "notify")
  assert.equal(canvasChangeAction({ version: 12, contentHash: `sha256:${"b".repeat(64)}` }, true, event), "conflict")
  assert.equal(canvasReloadSatisfiesChange(null, event), false)
  assert.equal(canvasReloadSatisfiesChange({ ...event, canvasId: "20000000-0000-4000-8000-000000000002" }, event), false)
  assert.equal(canvasReloadSatisfiesChange({ ...event, version: 12 }, event), false)
  assert.equal(canvasReloadSatisfiesChange({ ...event, contentHash: `sha256:${"b".repeat(64)}` }, event), false)
  assert.equal(canvasReloadSatisfiesChange(event, event), true)
  assert.equal(canvasReloadSatisfiesChange({ ...event, version: 14, contentHash: `sha256:${"b".repeat(64)}` }, event), true)
})

test("canvas revision polling produces bounded change events and retry delays", () => {
  const canvasId = "10000000-0000-4000-8000-000000000001"
  const mutationId = "20000000-0000-4000-8000-000000000002"
  const event = canvasChangeEventFromRevision(canvasId, {
    id: mutationId,
    version: 14,
    content_hash: `sha256:${"b".repeat(64)}`,
  })

  assert.deepEqual(event, {
    schemaId: "gb.canvas.changed.v1",
    canvasId,
    version: 14,
    contentHash: `sha256:${"b".repeat(64)}`,
    mutationId,
  })
  assert.deepEqual([0, 1, 2, 3, 8].map(canvasChangePollDelay), [
    CANVAS_CHANGE_POLL_INTERVAL_MS,
    10_000,
    20_000,
    CANVAS_CHANGE_POLL_MAX_INTERVAL_MS,
    CANVAS_CHANGE_POLL_MAX_INTERVAL_MS,
  ])
  assert.throws(
    () => canvasChangeEventFromRevision(canvasId, { id: mutationId, version: 0, content_hash: "bad" }),
    /contentHash is invalid|version must be a finite number/,
  )
})

test("canvas polling fails closed for terminal authorization and deletion responses", async () => {
  for (const status of [401, 403, 404]) {
    const terminal = []
    let requests = 0
    const poller = createCanvasChangePoller({
      request: async () => {
        requests += 1
        throw { status }
      },
      onEvent: () => "continue",
      onTerminalError: (error) => terminal.push(error),
      initialDelayMs: 0,
      timeoutMs: 50,
    })
    poller.start()
    await waitFor(() => terminal.length === 1, "terminal poll failure was reported")
    assert.equal(requests, 1)
    assert.equal(terminal.length, 1)
    assert.equal(isTerminalCanvasPollError(terminal[0]), true)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(requests, 1)
    poller.stop()
  }
  assert.equal(isTerminalCanvasPollError({ status: 500 }), false)
})

test("canvas polling stops after a newer revision becomes an explicit reload prompt", async () => {
  let requests = 0
  const event = {
    schemaId: "gb.canvas.changed.v1",
    canvasId: "10000000-0000-4000-8000-000000000001",
    version: 13,
    contentHash: `sha256:${"a".repeat(64)}`,
    mutationId: "mutation-13",
  }
  let promptedVersion = null
  const poller = createCanvasChangePoller({
    request: async () => {
      requests += 1
      return event
    },
    onEvent: (value) => {
      const action = canvasChangeAction({
        version: 12,
        contentHash: `sha256:${"b".repeat(64)}`,
      }, false, value)
      if (action !== "notify") return "continue"
      promptedVersion = value.version
      return "stop"
    },
    onTerminalError: () => assert.fail("a successful invalidation is not a terminal error"),
    initialDelayMs: 0,
    timeoutMs: 50,
  })
  poller.start()
  await waitFor(() => requests === 1, "invalidation poll completed")
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(requests, 1)
  assert.equal(promptedVersion, 13)
  poller.stop()
})

test("canvas polling stays single-flight and aborts on visibility changes and cleanup", async (t) => {
  let requests = 0
  let active = 0
  let maximumActive = 0
  const signals = []
  const poller = createCanvasChangePoller({
    request: (signal) => {
      requests += 1
      active += 1
      maximumActive = Math.max(maximumActive, active)
      signals.push(signal)
      return new Promise((_, reject) => {
        let settled = false
        const finish = (callback, value) => {
          if (settled) return
          settled = true
          active -= 1
          callback(value)
        }
        signal.addEventListener("abort", () => {
          setTimeout(() => finish(reject, new DOMException("aborted", "AbortError")), 2)
        }, { once: true })
      })
    },
    onEvent: () => "continue",
    onTerminalError: () => assert.fail("aborts are transient lifecycle events"),
    initialDelayMs: 0,
    timeoutMs: 100,
  })
  t.after(() => poller.stop())

  poller.start()
  await waitFor(() => requests === 1, "first poll started")
  assert.equal(requests, 1)
  poller.setVisible(false)
  poller.setVisible(true)
  await waitFor(() => requests === 2, "visible resume started the replacement poll")
  assert.equal(requests, 2)
  assert.equal(maximumActive, 1)
  assert.equal(signals[0].aborted, true)
  poller.stop()
  assert.equal(signals[1].aborted, true)
})

test("canvas polling bounds a hung request and treats its timeout as transient", async (t) => {
  const signals = []
  let terminalErrors = 0
  const poller = createCanvasChangePoller({
    request: (signal) => {
      signals.push(signal)
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
      })
    },
    onEvent: () => "continue",
    onTerminalError: () => { terminalErrors += 1 },
    initialDelayMs: 0,
    timeoutMs: 5,
  })
  t.after(() => poller.stop())

  poller.start()
  await waitFor(() => signals[0]?.aborted === true, "hung poll was aborted at its timeout")
  assert.equal(signals.length, 1)
  assert.equal(signals[0].aborted, true)
  assert.equal(terminalErrors, 0)
  poller.stop()
})

test("projection ordering and default z-order are deterministic", () => {
  const input = representativeProjection()
  const first = projectGalaxyCanvas(input)
  const reordered = projectGalaxyCanvas({
    placements: [...input.placements].reverse(),
    relations: [...input.relations].reverse(),
  })

  assert.deepEqual(reordered, first)
  assert.deepEqual(first.nodes.map((node) => node.id), [
    "placement:note",
    "placement:paper",
    "placement:proof",
  ])
  assert.deepEqual(first.nodes.map((node) => node.z), [0, 1, 8])
  assert.deepEqual(first.edges.map((edge) => edge.id), [
    "relation:asserted",
    "relation:deterministic",
    "relation:near",
    "relation:verified",
  ])
})

test("only explicitly authorized placements and their readable relations cross the boundary", () => {
  const projected = projectGalaxyCanvas(representativeProjection())
  const serialized = JSON.stringify(projected)

  assert.equal(projected.nodes.some((node) => node.id === "placement:private"), false)
  assert.equal(projected.edges.some((edge) => edge.id === "relation:private-edge"), false)
  assert.doesNotMatch(serialized, /Private title must not be projected/)
  assert.doesNotMatch(serialized, /must-not-cross-the-projection-boundary/)
  const paperDisplay = projected.nodes.find((node) => node.id === "placement:paper")?.data.display
  assert.equal(paperDisplay.title, "Bounded research atlas")
  assert.equal(paperDisplay.href, "/papers/paper-1")
  assert.equal(Object.hasOwn(paperDisplay, "internalPrincipalId"), false)

  const truthyButUnauthorized = projectGalaxyCanvas({
    placements: [placement("truthy", { authorized: "true" })],
    relations: [],
  })
  assert.deepEqual(truthyButUnauthorized, { nodes: [], edges: [] })
})

test("all relation trust classes remain structurally and visually distinct", () => {
  assert.deepEqual(GALAXY_RELATION_TRUST_CLASSES, ["deterministic", "asserted", "verified", "near", "presentation"])
  const edges = projectGalaxyCanvas(representativeProjection()).edges
  const byTrust = Object.fromEntries(edges.map((edge) => [edge.data.trustClass, edge]))
  const presentation = projectGalaxyCanvas({
    placements: [placement("left"), placement("right")],
    relations: [relation("presentation", "left", "right", "presentation", {
      relationType: "presentation",
      style: { color: "#123456" },
    })],
  }).edges[0]

  assert.equal(byTrust.deterministic.data.owner, "prove2me")
  assert.equal(byTrust.asserted.style.strokeStyle, "dashed")
  assert.equal(byTrust.verified.style.targetArrowhead, "arrow-filled")
  assert.equal(byTrust.verified.data.evidenceRef, "gb:object:v1:artifact:receipt-1:latest")
  assert.equal(byTrust.near.content, "near")
  assert.equal(byTrust.near.pathStyle, "bezier")
  assert.equal(byTrust.near.style.strokeStyle, "dotted")
  assert.equal(byTrust.near.style.targetArrowhead, "none")
  assert.equal(presentation.style.strokeStyle, "dashed")
  assert.deepEqual(presentation.data.presentationStyle, { color: "#123456" })
})

test("projection rejects unregistered types, unsafe references, routes, and geometry", () => {
  assert.deepEqual(GALAXY_CANVAS_NODE_TYPES, [
    "galaxy.paper",
    "galaxy.note",
    "galaxy.document",
    "galaxy.media",
    "galaxy.eln-record",
    "galaxy.task",
    "galaxy.chat",
    "galaxy.proof",
    "galaxy.surface",
  ])

  const rejectedPlacements = [
    placement("type", { nodeType: "arbitrary.jsx" }),
    placement("reference", { subjectRef: "https://example.com/private" }),
    placement("unknown-kind", { subjectRef: "gb:object:v1:unknown:item:latest" }),
    placement("route", { display: { title: "External", href: "https://example.com" } }),
    placement("coordinate", { x: Number.NaN }),
    placement("width", { width: 79 }),
    placement("oversized", { height: 2_401 }),
  ]
  for (const candidate of rejectedPlacements) {
    assert.throws(
      () => projectGalaxyCanvas({ placements: [candidate], relations: [] }),
      /Invalid Galaxy canvas projection/,
    )
  }

  assert.throws(
    () => projectGalaxyCanvas({ placements: [placement("duplicate"), placement("duplicate")], relations: [] }),
    /duplicate placement id/,
  )
})

test("relation validation prevents trust upgrades and malformed evidence", () => {
  const placements = [placement("source"), placement("target")]
  const projectRelation = (candidate) => projectGalaxyCanvas({ placements, relations: [candidate] })

  assert.throws(
    () => projectRelation(relation("unknown", "source", "target", "trusted")),
    /trustClass is not registered/,
  )
  assert.throws(
    () => projectRelation(relation("similar", "source", "target", "near", { relationType: "supports" })),
    /HAM candidates must use the near relation type/,
  )
  assert.throws(
    () => projectRelation(relation("verified", "source", "target", "verified", { evidenceRef: "" })),
    /verified relations require an evidenceRef/,
  )
  assert.throws(
    () => projectRelation(relation("bad-evidence", "source", "target", "verified", { evidenceRef: "https://example.com/receipt" })),
    /canonical Galaxy object reference/,
  )
  assert.throws(
    () => projectGalaxyCanvas({
      placements,
      relations: [relation("duplicate", "source", "target", "asserted"), relation("duplicate", "target", "source", "asserted")],
    }),
    /duplicate relation id/,
  )
})

test("projected nodes and edges ingest as one harness batch and support spatial queries", () => {
  const projected = projectGalaxyCanvas(representativeProjection())
  const store = createCanvasStore()
  const batches = []
  const unsubscribe = store.subscribe("change", (batch) => batches.push(batch))

  store.batch(() => {
    for (const node of projected.nodes) store.addNode(node)
    for (const edge of projected.edges) store.addEdge(edge)
  })
  unsubscribe()

  assert.equal(store.getNodeCount(), 3)
  assert.equal(store.getEdgeCount(), 4)
  assert.equal(batches.length, 1)
  assert.equal(batches[0].ops.length, 7)
  assert.deepEqual(store.querySpatial({ rect: { x: 0, y: 0, w: 370, h: 400 } }).nodes, ["placement:paper"])
  assert.equal(store.getNode("placement:paper")?.locked, true)
  assert.equal(store.getEdge("relation:near")?.data.trustClass, "near")
  assert.deepEqual(store.getEdge("relation:verified")?.source.localOffset, { x: 160, y: 100 })
  assert.deepEqual(store.getEdge("relation:verified")?.target.localOffset, { x: 180, y: 120 })
})

test("the rich fixture covers every node type and every relation trust class", () => {
  const fixture = buildResearchCanvasFixture()
  const conversationRef = createGalaxyObjectReference("chat", "research-thread", {
    mode: "pinned",
    revision: `sha256:${"c".repeat(64)}`,
  })
  const projected = projectGalaxyCanvas({
    ...fixture,
    placements: [...fixture.placements, placement("conversation", {
      subjectRef: conversationRef,
      nodeType: "galaxy.chat",
      x: 1_600,
      y: 540,
      width: 420,
      height: 260,
      display: { title: "Research conversation", status: "snapshot" },
    })],
  })
  assert.equal(projected.nodes.length, 9)
  assert.equal(projected.edges.length, 4)
  assert.deepEqual(
    [...new Set(projected.nodes.map((node) => node.type))].sort(),
    [...GALAXY_CANVAS_NODE_TYPES].sort(),
  )
  assert.deepEqual(
    [...new Set(projected.edges.map((edge) => edge.data.trustClass))].sort(),
    GALAXY_RELATION_TRUST_CLASSES.filter((trustClass) => trustClass !== "presentation").sort(),
  )
  assert.match(JSON.stringify(projected), /Galaxy DAG node · Prove2Me interop/)
  assert.doesNotMatch(JSON.stringify(projected), /owned by Prove2Me|Prove2Me owns/u)
  assert.doesNotMatch(JSON.stringify(projected), /https?:\/\//)
})

test("an exact conversation snapshot projects through the registered chat renderer boundary", () => {
  const subjectRef = createGalaxyObjectReference("chat", "research-thread", {
    mode: "pinned",
    revision: `sha256:${"d".repeat(64)}`,
  })
  const projected = projectGalaxyCanvas({
    placements: [placement("conversation", {
      subjectRef,
      nodeType: "galaxy.chat",
      width: 420,
      height: 260,
      display: { title: "Research conversation", summary: "Exact snapshot metadata." },
    })],
    relations: [],
  })

  assert.equal(projected.nodes.length, 1)
  assert.equal(projected.nodes[0].type, "galaxy.chat")
  assert.equal(projected.nodes[0].w, 420)
  assert.equal(projected.nodes[0].h, 260)
  assert.equal(projected.nodes[0].data.subjectRef, subjectRef)
  assert.equal(projected.nodes[0].data.display.title, "Research conversation")
  assert.equal(projected.nodes[0].data.display.summary, "Exact snapshot metadata.")
  assert.deepEqual(projected.nodes[0].data.display.badges, [])
})

test("the density fixture projects and ingests within a coarse regression ceiling", () => {
  const startedAt = performance.now()
  const projected = projectGalaxyCanvas(buildPrimitiveCanvasFixture())
  const store = createCanvasStore()
  store.batch(() => {
    for (const node of projected.nodes) store.addNode(node)
    for (const edge of projected.edges) store.addEdge(edge)
  })
  const elapsed = performance.now() - startedAt

  assert.equal(store.getNodeCount(), 2_000)
  assert.equal(store.getEdgeCount(), 1_999)
  assert.ok(store.querySpatial({ rect: { x: 0, y: 0, w: 1_000, h: 1_000 } }).nodes.length > 0)
  assert.ok(elapsed < 5_000, `projection and ingestion took ${elapsed.toFixed(1)} ms`)
})

test("the development route fails closed and the runtime blocks scene mutations", async () => {
  const page = await readFile(new URL("../app/dev/canvas-harness/page.tsx", import.meta.url), "utf8")
  const loader = await readFile(new URL("../app/dev/canvas-harness/canvas-harness-preview-loader.tsx", import.meta.url), "utf8")
  const runtime = await readFile(new URL("../app/dev/canvas-harness/canvas-harness-preview-client.tsx", import.meta.url), "utf8")

  assert.match(page, /devPreviewsEnabled\(\)/)
  assert.match(page, /notFound\(\)/)
  assert.match(loader, /ssr: false/)
  assert.match(runtime, /asReadOnlyCanvasStore/)
  for (const method of ["updateNode", "removeNode", "addEdge", "applyOp", "commitEdit"]) {
    assert.equal(BLOCKED_CANVAS_STORE_METHODS.includes(method), true)
  }
  assert.doesNotMatch(runtime, /onCreateDrag=/)
})

test("the read-only store boundary preserves local context and refuses scene mutations", () => {
  const mutable = createCanvasStore()
  mutable.addNode({
    id: canvasNodeId("read-only"),
    type: "rect",
    x: 10,
    y: 20,
    w: 120,
    h: 80,
    angle: 0,
    groups: [],
  })
  const store = asReadOnlyCanvasStore(mutable)

  store.updateNode(canvasNodeId("read-only"), { x: 999 })
  store.removeNode(canvasNodeId("read-only"))
  const blockedId = store.addNode({
    id: canvasNodeId("blocked-add"),
    type: "rect",
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    angle: 0,
    groups: [],
  })
  assert.equal(blockedId, canvasNodeId("blocked-add"))
  assert.equal(store.getNodeCount(), 1)
  assert.equal(store.getNode(canvasNodeId("read-only"))?.x, 10)
  assert.equal(store.canUndo(), true)
  assert.equal(store.undo(), false)

  store.setCamera({ x: 42, y: -8, z: 1.4 })
  store.setSelection([canvasNodeId("read-only")])
  assert.deepEqual(store.getCamera(), { x: 42, y: -8, z: 1.4 })
  assert.deepEqual(store.getSelection(), [canvasNodeId("read-only")])
})

test("the placement store permits geometry only and emits no raw topology operations", () => {
  const mutable = createCanvasStore()
  mutable.addNode({
    id: canvasNodeId("durable"),
    type: "rect",
    x: 10,
    y: 20,
    w: 120,
    h: 80,
    angle: 0,
    z: 1,
    groups: [],
    data: { retained: true },
  })
  const store = asPlacementCanvasStore(mutable)
  store.updateNode(canvasNodeId("durable"), {
    x: 30,
    y: 40,
    w: 160,
    h: 100,
    z: 4,
    angle: 1.2,
    data: { retained: false },
  })
  store.removeNode(canvasNodeId("durable"))

  assert.deepEqual(canvasNodeGeometry(store.getNode(canvasNodeId("durable"))), {
    x: 30,
    y: 40,
    width: 160,
    height: 100,
    zIndex: 4,
  })
  assert.equal(store.getNode(canvasNodeId("durable"))?.angle, 0)
  assert.deepEqual(store.getNode(canvasNodeId("durable"))?.data, { retained: true })
  assert.equal(store.getNodeCount(), 1)
})

test("durable placement geometry overlays only the matching authorized projection", () => {
  const projection = {
    placements: [placement("paper", { x: 10, y: 20, width: 320, height: 200, zIndex: 0 })],
    relations: [],
  }
  const empty = {
    schemaId: "gb.canvas.snapshot.v1",
    items: [],
    edges: [],
    removedItemIds: [],
    removedEdgeIds: [],
  }
  const firstCommands = commandsForPlacementGeometry(empty, projection, "paper", {
    x: 42,
    y: -8,
    width: 420,
    height: 270,
    zIndex: 3,
  })
  assert.equal(firstCommands.length, 1)
  assert.equal(firstCommands[0].type, "item.place")
  const snapshot = {
    schemaId: "gb.canvas.snapshot.v1",
    items: [firstCommands[0].item],
    edges: [],
    removedItemIds: [],
    removedEdgeIds: [],
  }
  assert.deepEqual(mergeCanvasSnapshot(projection, snapshot).placements[0], {
    ...projection.placements[0],
    x: 42,
    y: -8,
    width: 420,
    height: 270,
    angle: 0,
    zIndex: 3,
    displayMode: "card",
    collapsed: false,
    style: {},
  })
  assert.deepEqual(commandsForPlacementGeometry(snapshot, projection, "paper", {
    x: 50,
    y: -8,
    width: 500,
    height: 270,
    zIndex: 4,
  }).map((command) => command.type), ["item.move", "item.resize", "item.reorder"])
  const mismatched = structuredClone(snapshot)
  mismatched.items[0].subjectRef = "gb:object:v1:paper:other:latest"
  const mismatchedMerge = mergeCanvasSnapshot(projection, mismatched)
  assert.equal(mismatchedMerge.placements[0].x, 42)
  assert.equal(mismatchedMerge.placements[0].subjectRef, "gb:object:v1:paper:other:latest")
  assert.equal(mismatchedMerge.placements[0].availability, "unavailable")
  assert.throws(
    () => commandsForPlacementGeometry(mismatched, projection, "paper", {
      x: 50, y: 0, width: 420, height: 270, zIndex: 1,
    }),
    /identity does not match/,
  )
})

test("active durable placements replace automatic placements for the exact same subject", () => {
  const sharedRef = "gb:object:v1:eln.experiment:experiment-1:latest"
  const otherRef = "gb:object:v1:eln.experiment:experiment-2:latest"
  const pinnedRef = `gb:object:v1:eln.experiment:experiment-1:pinned:sha256%3A${"a".repeat(64)}`
  const projection = {
    placements: [
      placement("auto-shared", { subjectRef: sharedRef, nodeType: "galaxy.eln-record" }),
      placement("auto-other", { subjectRef: otherRef, nodeType: "galaxy.eln-record" }),
      placement("auto-pinned", { subjectRef: pinnedRef, nodeType: "galaxy.eln-record" }),
    ],
    relations: [
      relation("shared-to-other", "auto-shared", "auto-other", "asserted"),
      relation("other-to-pinned", "auto-other", "auto-pinned", "asserted"),
    ],
  }
  const durablePlacements = [
    placement("manual-shared-a", { subjectRef: sharedRef, nodeType: "galaxy.eln-record" }),
    placement("manual-shared-b", { subjectRef: sharedRef, nodeType: "galaxy.eln-record" }),
  ]
  const durable = {
    schemaId: "gb.canvas.snapshot.v1",
    items: durablePlacements.map((entry, index) => snapshotItemFromPlacement(entry, {
      x: 100 + index * 360,
      y: 200,
      width: 320,
      height: 200,
      zIndex: index + 1,
    })),
    edges: [],
    removedItemIds: [],
    removedEdgeIds: [],
  }

  const merged = mergeCanvasSnapshot(projection, durable)

  assert.deepEqual(
    merged.placements.map((entry) => entry.id),
    ["auto-other", "auto-pinned", "manual-shared-a", "manual-shared-b"],
  )
  assert.equal(merged.placements.filter((entry) => entry.subjectRef === sharedRef).length, 2)
  assert.deepEqual(merged.relations.map((entry) => entry.id), ["other-to-pinned"])
})

test("removed durable placement IDs do not suppress automatic placements", () => {
  const sharedRef = "gb:object:v1:eln.experiment:experiment-1:latest"
  const projection = {
    placements: [placement("auto-shared", {
      subjectRef: sharedRef,
      nodeType: "galaxy.eln-record",
    })],
    relations: [],
  }
  const durable = {
    schemaId: "gb.canvas.snapshot.v1",
    items: [],
    edges: [],
    removedItemIds: ["manual-shared"],
    removedEdgeIds: [],
  }

  const merged = mergeCanvasSnapshot(projection, durable)

  assert.deepEqual(merged.placements.map((entry) => entry.id), ["auto-shared"])
})

test("authoritative conflict reloads preserve queued local placement geometry", () => {
  const projection = {
    placements: [
      placement("paper", { x: 10, y: 20, width: 320, height: 200, zIndex: 0 }),
      placement("note", { x: 40, y: 50, width: 320, height: 200, zIndex: 1 }),
    ],
    relations: [],
  }
  const authoritative = {
    schemaId: "gb.canvas.snapshot.v1",
    items: [
      snapshotItemFromPlacement(projection.placements[0], { x: 100, y: 200, width: 420, height: 270, zIndex: 2 }),
      snapshotItemFromPlacement(projection.placements[1], { x: 300, y: 400, width: 420, height: 270, zIndex: 3 }),
    ],
    edges: [],
    removedItemIds: [],
    removedEdgeIds: [],
  }
  const merged = mergeCanvasSnapshotWithPlacementOverrides(
    projection,
    authoritative,
    [["note", { x: 700, y: 800, width: 500, height: 320, zIndex: 9 }]],
  )

  assert.deepEqual(
    merged.placements.map(({ id, x, y, width, height, zIndex }) => ({ id, x, y, width, height, zIndex })),
    [
      { id: "paper", x: 100, y: 200, width: 420, height: 270, zIndex: 2 },
      { id: "note", x: 700, y: 800, width: 500, height: 320, zIndex: 9 },
    ],
  )
})

test("durable canvas overlays reconstruct tombstones, presentation edges, and complete item state", () => {
  const projection = {
    placements: [
      placement("paper", { x: 10, y: 20 }),
      placement("note", { nodeType: "galaxy.note", subjectRef: "gb:object:v1:artifact:note:latest" }),
    ],
    relations: [relation("semantic-edge", "paper", "note", "asserted")],
  }
  const durable = {
    schemaId: "gb.canvas.snapshot.v1",
    items: [{
      id: "paper",
      subjectRef: projection.placements[0].subjectRef,
      nodeType: "galaxy.paper",
      x: 100,
      y: 200,
      width: 500,
      height: 300,
      angle: 12,
      zIndex: 9,
      displayMode: "compact",
      collapsed: true,
      style: { tone: "muted" },
    }],
    edges: [],
    removedItemIds: ["note"],
    removedEdgeIds: ["semantic-edge"],
  }
  const withoutNote = mergeCanvasSnapshot(projection, durable)

  assert.deepEqual(withoutNote.placements.map((item) => item.id), ["paper"])
  assert.equal(withoutNote.placements[0].angle, 12)
  assert.equal(withoutNote.placements[0].displayMode, "compact")
  assert.equal(withoutNote.placements[0].collapsed, true)
  assert.deepEqual(withoutNote.placements[0].style, { tone: "muted" })
  assert.deepEqual(withoutNote.relations, [])

  durable.items.push({
    id: "note",
    subjectRef: projection.placements[1].subjectRef,
    nodeType: "galaxy.note",
    x: 0,
    y: 0,
    width: 420,
    height: 270,
    angle: 0,
    zIndex: 1,
    displayMode: "card",
    collapsed: false,
    style: {},
  })
  durable.edges.push({
    id: "presentation-edge",
    sourceItemId: "paper",
    targetItemId: "note",
    edgeKind: "presentation",
    label: "arranged with",
    style: { color: "#64748b" },
  })
  durable.removedItemIds = []
  const restored = mergeCanvasSnapshot(projection, durable)
  assert.equal(restored.relations.length, 1)
  assert.equal(restored.relations[0].id, "presentation-edge")
  assert.equal(restored.relations[0].trustClass, "presentation")
  assert.doesNotThrow(() => projectGalaxyCanvas(restored))
})

test("durable placements survive missing projections as content-free locked placeholders", () => {
  const subjectRef = "gb:object:v1:ham.memory:memory-404:latest"
  const durable = {
    schemaId: "gb.canvas.snapshot.v1",
    items: [{
      id: "missing-memory",
      subjectRef,
      nodeType: "galaxy.note",
      x: 12,
      y: 34,
      width: 420,
      height: 270,
      angle: 2,
      zIndex: 7,
      displayMode: "compact",
      collapsed: false,
      style: { tone: "muted" },
    }],
    edges: [],
    removedItemIds: [],
    removedEdgeIds: [],
  }

  const merged = mergeCanvasSnapshot({ placements: [], relations: [] }, durable)
  assert.deepEqual(merged.placements, [{
    id: "missing-memory",
    authorized: false,
    availability: "unavailable",
    subjectRef,
    nodeType: "galaxy.note",
    x: 12,
    y: 34,
    width: 420,
    height: 270,
    angle: 2,
    zIndex: 7,
    displayMode: "compact",
    collapsed: false,
    style: { tone: "muted" },
  }])
  const scene = projectGalaxyCanvas(merged)
  assert.equal(scene.nodes.length, 1)
  assert.equal(scene.nodes[0].locked, true)
  assert.equal(scene.nodes[0].data.availability, "unavailable")
  assert.deepEqual(scene.nodes[0].data.display, {
    title: "Unavailable reference",
    summary: "This durable placement remains movable while its object preview is unavailable.",
    status: "Unavailable",
    provenance: "Durable placement only; no object content is cached in the canvas.",
    badges: ["Locked"],
  })
  assert.equal(JSON.stringify(durable).includes("Unavailable reference"), false)
})

test("unavailable placeholders ignore display payloads and reject authorization contradictions", () => {
  const candidate = placement("locked", {
    authorized: false,
    availability: "unavailable",
    display: {
      title: "Secret title",
      summary: "Secret summary",
      href: "/secret",
      markdown: "Secret body",
      surfaceSpec: { secret: true },
    },
  })
  const [node] = projectGalaxyCanvas({ placements: [candidate], relations: [] }).nodes
  assert.equal(JSON.stringify(node.data).includes("Secret"), false)
  assert.equal(JSON.stringify(node.data).includes("/secret"), false)
  assert.throws(
    () => projectGalaxyCanvas({
      placements: [{ ...candidate, authorized: true }],
      relations: [],
    }),
    /must not be authorized/,
  )
  assert.throws(
    () => projectGalaxyCanvas({
      placements: [{ ...placement("resolved"), availability: "resolved", authorized: false }],
      relations: [],
    }),
    /require explicit authorization/,
  )
})

test("gateway-unavailable durable content stays absent from drag and distant painters", async () => {
  const secret = "SENTINEL SECRET LEGACY TITLE"
  const subjectRef = "gb:object:v1:paper:paper-denied:latest"
  const base = {
    placements: [placement("paper-denied", {
      subjectRef,
      display: { title: secret, status: "Secret status" },
    })],
    relations: [relation("secret-relation", "paper-denied", "paper-denied", "asserted", {
      relationType: "secret semantic relation",
    })],
  }
  const snapshot = {
    schemaId: "gb.canvas.snapshot.v1",
    items: [{
      id: "paper-denied",
      subjectRef,
      nodeType: "galaxy.paper",
      x: 0,
      y: 0,
      width: 320,
      height: 200,
      angle: 0,
      zIndex: 0,
      displayMode: "card",
      collapsed: false,
      style: {},
    }],
    edges: [],
    removedItemIds: [],
    removedEdgeIds: [],
  }
  const transient = applyAtlasHydrationAvailability(base, snapshot, {
    [subjectRef]: { requestedRef: subjectRef, status: "unavailable" },
  })
  assert.equal(applyAtlasHydrationAvailability(base, snapshot, {}).placements[0].availability, "unavailable")
  assert.equal(transient.placements[0].availability, "unavailable")
  assert.equal(Object.hasOwn(transient.placements[0], "display"), false)
  assert.deepEqual(transient.relations, [])

  const [node] = projectGalaxyCanvas(transient).nodes
  const painted = []
  const context = {
    fillRect() {},
    strokeRect() {},
    measureText(value) { return { width: String(value).length * 5 } },
    fillText(value) { painted.push(String(value)) },
  }
  paintGalaxyCanvasNode(context, node)
  assert.equal(painted.join(" ").includes(secret), false)
  assert.deepEqual(painted, ["CONTENT", "Preview unavailable", "Content locked"])

  const nodeTypes = await readFile(
    new URL("../lib/canvas/galaxy-canvas-node-types.ts", import.meta.url),
    "utf8",
  )
  assert.match(nodeTypes, /from "@\/lib\/canvas\/galaxy-canvas-painter"/)
  assert.match(nodeTypes, /renderCanvas: paintGalaxyCanvasNode/)
  assert.match(nodeTypes, /drawPlaceholder: paintGalaxyCanvasNode/)
})

test("hydration transitions preserve queued placement geometry and its eventual command", async () => {
  const subjectRef = "gb:object:v1:paper:paper-moving:latest"
  const base = {
    placements: [placement("paper-moving", { subjectRef })],
    relations: [relation("moving-relation", "paper-moving", "paper-moving", "asserted")],
  }
  const snapshot = {
    schemaId: "gb.canvas.snapshot.v1",
    items: [{
      id: "paper-moving",
      subjectRef,
      nodeType: "galaxy.paper",
      x: 10,
      y: 20,
      width: 320,
      height: 200,
      angle: 0,
      zIndex: 0,
      displayMode: "card",
      collapsed: false,
      style: {},
    }],
    edges: [],
    removedItemIds: [],
    removedEdgeIds: [],
  }
  const queuedGeometry = {
    x: 77,
    y: 88,
    width: 360,
    height: 220,
    zIndex: 2,
  }
  const pending = new Map([["paper-moving", queuedGeometry]])
  const inFlight = new Map(pending)
  pending.clear()
  const loading = mergeCanvasSnapshot(
    applyAtlasHydrationAvailability(base, snapshot, {}),
    snapshot,
  )
  const resolved = mergeCanvasSnapshot(
    applyAtlasHydrationAvailability(base, snapshot, {
      [subjectRef]: { status: "resolved" },
    }),
    snapshot,
  )
  assert.equal(applyCanvasPlacementOverrides(loading, inFlight).placements[0].x, 77)
  const reconciled = applyCanvasPlacementOverrides(resolved, inFlight)
  assert.equal(reconciled.placements[0].x, 77)
  assert.deepEqual(
    commandsForPlacementGeometry(snapshot, reconciled, "paper-moving", queuedGeometry)
      .map((command) => command.type),
    ["item.move", "item.resize", "item.reorder"],
  )
  const acknowledged = structuredClone(snapshot)
  Object.assign(acknowledged.items[0], queuedGeometry)
  inFlight.clear()
  const afterAcknowledgement = applyCanvasPlacementOverrides(
    mergeCanvasSnapshot(resolved, acknowledged),
    inFlight,
  )
  assert.equal(afterAcknowledgement.placements[0].x, 77)
  assert.equal(afterAcknowledgement.placements[0].availability ?? "resolved", "resolved")
  assert.deepEqual(afterAcknowledgement.relations.map((item) => item.id), ["moving-relation"])

  const client = await readFile(
    new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url),
    "utf8",
  )
  assert.match(client, /runtimeProjectionRef/)
  assert.match(client, /baseProjectionRef\.current = baseProjection/)
  assert.match(client, /mergeCanvasSnapshotWithPlacementOverrides\(\s*baseProjectionRef\.current,/)
  assert.match(client, /inFlightRef\.current\.set\(placementId, geometry\)/)
  assert.match(client, /\.\.\.inFlightRef\.current, \.\.\.pendingRef\.current/)
  assert.match(client, /applyAuthoritativeSnapshot\(updated\)/)
  assert.match(client, /pendingRef\.current\.size > 0 && timerRef\.current === null/)
})

test("a later exact projection replaces the placeholder without changing durable geometry", () => {
  const subjectRef = "gb:object:v1:paper:paper-later:latest"
  const durable = {
    schemaId: "gb.canvas.snapshot.v1",
    items: [{
      id: "paper-later",
      subjectRef,
      nodeType: "galaxy.paper",
      x: 410,
      y: 520,
      width: 500,
      height: 300,
      angle: 0,
      zIndex: 4,
      displayMode: "card",
      collapsed: false,
      style: {},
    }],
    edges: [],
    removedItemIds: [],
    removedEdgeIds: [],
  }
  const missing = mergeCanvasSnapshot({ placements: [], relations: [] }, durable)
  assert.equal(missing.placements[0].availability, "unavailable")

  const live = placement("paper-later", {
    subjectRef,
    x: 0,
    y: 0,
    display: { title: "Later resolved paper" },
  })
  const hydrated = mergeCanvasSnapshot({ placements: [live], relations: [] }, durable)
  assert.equal(hydrated.placements[0].display.title, "Later resolved paper")
  assert.deepEqual(
    (({ x, y, width, height, zIndex }) => ({ x, y, width, height, zIndex }))(hydrated.placements[0]),
    { x: 410, y: 520, width: 500, height: 300, zIndex: 4 },
  )

  const mismatched = mergeCanvasSnapshot({
    placements: [placement("paper-later", {
      subjectRef: "gb:object:v1:paper:different:latest",
      x: 8,
      y: 9,
    })],
    relations: [relation("new-semantic-edge", "paper-later", "paper-later", "asserted")],
  }, durable)
  assert.equal(mismatched.placements.length, 1)
  assert.equal(mismatched.placements[0].subjectRef, subjectRef)
  assert.equal(mismatched.placements[0].availability, "unavailable")
  assert.equal(mismatched.placements[0].x, 410)
  assert.deepEqual(mismatched.relations, [])
})

test("durable presentation edges remain visible between unavailable placements", () => {
  const item = (id, x) => ({
    id,
    subjectRef: `gb:object:v1:artifact:${id}:latest`,
    nodeType: "galaxy.note",
    x,
    y: 0,
    width: 320,
    height: 200,
    angle: 0,
    zIndex: x,
    displayMode: "card",
    collapsed: false,
    style: {},
  })
  const durable = {
    schemaId: "gb.canvas.snapshot.v1",
    items: [item("left", 0), item("right", 400)],
    edges: [{
      id: "arranged",
      sourceItemId: "left",
      targetItemId: "right",
      edgeKind: "presentation",
      label: "arranged with",
      style: {},
    }],
    removedItemIds: [],
    removedEdgeIds: [],
  }

  const merged = mergeCanvasSnapshot({ placements: [], relations: [] }, durable)
  assert.equal(merged.placements.every((placement) => placement.availability === "unavailable"), true)
  assert.deepEqual(merged.relations.map((edge) => edge.id), ["arranged"])
  const scene = projectGalaxyCanvas(merged)
  assert.equal(scene.nodes.length, 2)
  assert.equal(scene.edges.length, 1)
})

function authorizedSources() {
  return {
    workspaceNodes: [
      {
        id: "note-2",
        authorized: true,
        type: "canvas-note",
        title: "Second note",
        content: "A note with $x^2$.",
        version: 2,
        tenantId: "must-not-cross",
      },
      {
        id: "note-1",
        authorized: true,
        type: "note",
        title: "First note",
        content: "Bounded Markdown",
        version: 3,
      },
      {
        id: "document-1",
        authorized: true,
        type: "document",
        title: "Authorized document",
        content: "Extracted document text.",
        version: 1,
      },
      {
        id: "media-1",
        authorized: true,
        type: "image",
        title: "Authorized image",
        mediaType: "image/png",
        version: 1,
      },
      {
        id: "private-note",
        authorized: false,
        type: "note",
        title: "Private note title",
      },
    ],
    papers: [{
      id: "paper-1",
      authorized: true,
      title: "Authorized paper",
      abstract: "A bounded abstract.",
      metadataHash: `sha256:${"a".repeat(64)}`,
      authors: [{ name: "Ada" }],
      categories: ["math.LO"],
    }],
    experiments: [{
      id: "experiment-1",
      authorized: true,
      title: "Authorized experiment",
      status: "running",
      domain: "proof engineering",
      interpretation: "The replay is stable.",
      updatedAt: "2026-09-22T00:00:00Z",
    }],
    tasks: [{
      id: "task-1",
      authorized: true,
      title: "Check a proof packet",
      goal: "Replay the packet.",
      state: "running",
      lifecyclePhase: "running",
      riskMode: "diagnostic",
      version: 4,
      resources: [{
        resourceRef: "proof-packet:program-1:packet-2",
        resourceClass: "proof-packet",
        redacted: false,
      }],
    }],
    surfaces: [{
      id: "surface-1",
      authorized: true,
      title: "Review surface",
      status: "promoted",
      contentHash: `sha256:${"b".repeat(64)}`,
      spec: {
        schema: "gb.surface.v1",
        catalog: { id: "generous.a2ui", version: "1" },
        surfaceUpdate: {
          surfaceId: "surface-1",
          components: [{ id: "title", component: { Title: { text: "Review" } } }],
        },
        bindings: [],
      },
    }],
  }
}

test("the authorized Phase 1 projection is deterministic and disclosure-bounded", () => {
  const sources = authorizedSources()
  const first = buildAuthorizedCanvasProjection(sources)
  const reordered = buildAuthorizedCanvasProjection({
    ...sources,
    workspaceNodes: [...sources.workspaceNodes].reverse(),
  })

  assert.deepEqual(reordered, first)
  assert.equal(first.placements.length, 9)
  assert.equal(first.relations.length, 1)
  assert.deepEqual(
    [...new Set(first.placements.map((item) => item.nodeType))].sort(),
    ["galaxy.document", "galaxy.eln-record", "galaxy.media", "galaxy.note", "galaxy.paper", "galaxy.proof", "galaxy.surface", "galaxy.task"],
  )
  assert.equal(first.relations[0].trustClass, "deterministic")
  assert.match(first.relations[0].provenance, /no proof verification claim/i)
  const proofPlacement = first.placements.find((item) => item.nodeType === "galaxy.proof")
  assert.match(proofPlacement.subjectRef, /^gb:object:v1:artifact:/)
  assert.match(proofPlacement.display.summary, /Galaxy retains its durable proof graph/)
  assert.doesNotMatch(proofPlacement.display.summary, /Prove2Me remains authoritative/)
  assert.equal(
    first.placements.find((item) => item.nodeType === "galaxy.paper").subjectRef,
    createGalaxyObjectReference("paper", "paper-1", {
      mode: "pinned", revision: `sha256:${"a".repeat(64)}`,
    }),
  )
  assert.equal(
    first.placements.find((item) => item.nodeType === "galaxy.eln-record").subjectRef,
    createGalaxyObjectReference("eln.experiment", "experiment-1"),
  )
  assert.equal(
    first.placements.find((item) => item.nodeType === "galaxy.task").subjectRef,
    createGalaxyObjectReference("ham.task", "task-1"),
  )
  assert.equal(
    first.placements.find((item) => item.nodeType === "galaxy.surface").subjectRef,
    createGalaxyObjectReference("surface", "surface-1", {
      mode: "pinned", revision: `sha256:${"b".repeat(64)}`,
    }),
  )
  const workspacePlacement = first.placements.find((item) => item.id === "workspace-note-1")
  assert.equal(
    workspacePlacement.display.href,
    `/workspace?ref=${encodeURIComponent(workspacePlacement.subjectRef)}`,
  )
  const serialized = JSON.stringify(first)
  assert.doesNotMatch(serialized, /Private note title|must-not-cross/)
  assert.doesNotMatch(serialized, /tenantId/)
  assert.doesNotMatch(serialized, /https?:\/\//)
  assert.doesNotThrow(() => projectGalaxyCanvas(first))
})

test("immutable canvas sources fail closed instead of degrading malformed pins to latest", () => {
  const sources = authorizedSources()
  const projection = buildAuthorizedCanvasProjection({
    papers: [{ ...sources.papers[0], metadataHash: "paper-revision-row-id" }],
    surfaces: [{ ...sources.surfaces[0], contentHash: "version:7" }],
  })
  assert.deepEqual(projection.placements, [])
})

function authorizedObjectLink(id, fromRef, toRef, overrides = {}) {
  const basis = overrides.basis ?? "authored"
  return {
    authorized: overrides.authorized ?? true,
    active: overrides.active ?? true,
    link: {
      id,
      from_ref: fromRef,
      to_ref: toRef,
      relation: overrides.relation ?? "related",
      basis,
      provenance: overrides.provenance ?? (basis === "authored"
        ? { source: "manual", source_system: "galaxy" }
        : {
            source: basis === "imported" ? "import" : "derivation",
            source_system: "galaxy-importer",
            source_ref: "fixture:source",
            source_snapshot: `sha256:${"a".repeat(64)}`,
            extractor_version: "fixture-v1",
            confidence: 0.9,
          }),
      created_by_principal_id: "principal-must-not-project",
    },
  }
}

test("authorized active object links project direction and bounded trust without verification", () => {
  const paperRef = createGalaxyObjectReference("paper", "paper-1")
  const taskRef = createGalaxyObjectReference("ham.task", "task-1")
  const placements = [
    placement("paper-placement", { subjectRef: paperRef }),
    placement("task-placement", { subjectRef: taskRef, nodeType: "galaxy.task" }),
  ]
  const authoredId = "50000000-0000-4000-8000-000000000001"
  const importedId = "50000000-0000-4000-8000-000000000002"
  const relations = projectAuthorizedObjectLinkRelations(placements, [
    authorizedObjectLink(importedId, taskRef, paperRef, { basis: "imported", relation: "documents" }),
    authorizedObjectLink(authoredId, paperRef, taskRef, { relation: "context_for" }),
  ])

  assert.deepEqual(relations.map((item) => item.id), [
    `object-link-${authoredId}`,
    `object-link-${importedId}`,
  ])
  assert.deepEqual(relations.map((item) => [item.sourcePlacementId, item.targetPlacementId]), [
    ["paper-placement", "task-placement"],
    ["task-placement", "paper-placement"],
  ])
  assert.deepEqual(relations.map((item) => item.trustClass), ["asserted", "deterministic"])
  assert.ok(relations.every((item) => item.owner === "Galaxy object-link ledger"))
  assert.ok(relations.every((item) => !Object.hasOwn(item, "evidenceRef")))
  assert.doesNotMatch(JSON.stringify(relations), /principal-must-not-project|verified/u)
  assert.doesNotThrow(() => projectGalaxyCanvas({ placements, relations }))
})

test("object-link projection deduplicates UUIDs and chooses duplicate placements deterministically", () => {
  const fromRef = createGalaxyObjectReference("paper", "paper-1")
  const toRef = createGalaxyObjectReference("ham.task", "task-1")
  const link = authorizedObjectLink("50000000-0000-4000-8000-000000000003", fromRef, toRef)
  const placements = [
    placement("z-paper", { subjectRef: fromRef }),
    placement("a-paper", { subjectRef: fromRef }),
    placement("task", { subjectRef: toRef, nodeType: "galaxy.task" }),
  ]
  const first = projectAuthorizedObjectLinkRelations(placements, [link, structuredClone(link)])
  const reordered = projectAuthorizedObjectLinkRelations([...placements].reverse(), [structuredClone(link), link])

  assert.deepEqual(reordered, first)
  assert.equal(first.length, 1)
  assert.equal(first[0].sourcePlacementId, "a-paper")

  const preferred = projectAuthorizedObjectLinkRelations(placements, [link], {
    preferredPlacementIds: ["z-paper"],
  })
  assert.equal(preferred[0].sourcePlacementId, "z-paper")
})

test("object-link projection requires exact endpoint identity and resolved authorization", () => {
  const latestRef = createGalaxyObjectReference("paper", "paper-1")
  const pinnedRef = createGalaxyObjectReference("paper", "paper-1", {
    mode: "pinned",
    revision: `sha256:${"b".repeat(64)}`,
  })
  const taskRef = createGalaxyObjectReference("ham.task", "task-1")
  const id = "50000000-0000-4000-8000-000000000004"

  assert.deepEqual(projectAuthorizedObjectLinkRelations([
    placement("paper", { subjectRef: pinnedRef }),
    placement("task", { subjectRef: taskRef, nodeType: "galaxy.task" }),
  ], [authorizedObjectLink(id, latestRef, taskRef)]), [])

  assert.deepEqual(projectAuthorizedObjectLinkRelations([
    placement("paper", { subjectRef: latestRef, availability: "unavailable" }),
    placement("task", { subjectRef: taskRef, nodeType: "galaxy.task" }),
  ], [authorizedObjectLink(id, latestRef, taskRef)]), [])

  assert.deepEqual(projectAuthorizedObjectLinkRelations([
    placement("paper", { subjectRef: latestRef, authorized: false }),
    placement("task", { subjectRef: taskRef, nodeType: "galaxy.task" }),
  ], [authorizedObjectLink(id, latestRef, taskRef)]), [])

  const unicodeRef = createGalaxyObjectReference("paper", "é")
  assert.deepEqual(projectAuthorizedObjectLinkRelations([
    placement("paper", { subjectRef: unicodeRef }),
    placement("task", { subjectRef: taskRef, nodeType: "galaxy.task" }),
  ], [authorizedObjectLink(id, unicodeRef.toLowerCase(), taskRef)]), [])

  const unpinnedDocumentRef = createGalaxyObjectReference("document", "document-1")
  assert.deepEqual(projectAuthorizedObjectLinkRelations([
    placement("document", { subjectRef: unpinnedDocumentRef, nodeType: "galaxy.document" }),
    placement("task", { subjectRef: taskRef, nodeType: "galaxy.task" }),
  ], [authorizedObjectLink(id, unpinnedDocumentRef, taskRef)]), [])
})

test("object-link projection fails closed for unauthorized, inactive, conflicting, or malformed links", () => {
  const fromRef = createGalaxyObjectReference("paper", "paper-1")
  const toRef = createGalaxyObjectReference("ham.task", "task-1")
  const placements = [
    placement("paper", { subjectRef: fromRef }),
    placement("task", { subjectRef: toRef, nodeType: "galaxy.task" }),
  ]
  const id = "50000000-0000-4000-8000-000000000005"
  const valid = authorizedObjectLink(id, fromRef, toRef)
  const malformed = [
    { ...valid, authorized: false },
    { ...valid, active: false },
    authorizedObjectLink("not-a-uuid", fromRef, toRef),
    authorizedObjectLink(id, "gb:object:v1:paper:bad%2fid:latest", toRef),
    authorizedObjectLink(id, fromRef, toRef, { relation: "verifies" }),
    authorizedObjectLink(id, fromRef, toRef, { basis: "verified" }),
    authorizedObjectLink(id, fromRef, toRef, { provenance: { source: "manual", source_system: "galaxy", confidence: 1 } }),
    authorizedObjectLink(id, fromRef, toRef, { provenance: { source: "import", source_system: "galaxy" } }),
    authorizedObjectLink(id, fromRef, toRef, { provenance: { source: "manual", source_system: "galaxy", principal_id: "leak" } }),
  ]
  assert.deepEqual(projectAuthorizedObjectLinkRelations(placements, malformed), [])

  const conflict = authorizedObjectLink(id, toRef, fromRef)
  assert.deepEqual(projectAuthorizedObjectLinkRelations(placements, [valid, conflict]), [])
  assert.deepEqual(projectAuthorizedObjectLinkRelations(placements, [conflict, valid]), [])
})

test("bound Generous surfaces remain definition-only until their owning view resolves them", () => {
  const spec = authorizedSources().surfaces[0].spec
  spec.bindings = [{
    id: "experiment-binding",
    target: { componentId: "title", prop: "text" },
    source: { kind: "galaxy.eln.experiment", resourceId: "experiment-1" },
  }]
  const projection = buildAuthorizedCanvasProjection({
    surfaces: [{ ...authorizedSources().surfaces[0], spec }],
  })
  const [surface] = projection.placements

  assert.equal(surface.nodeType, "galaxy.surface")
  assert.equal(surface.display.surfaceSpec, undefined)
  assert.match(surface.display.summary, /definition-only/)
  assert.deepEqual(surface.display.badges, ["gb.surface.v1", "1 bindings", "read-only"])
})

test("the authorized projection requires exact authorization and enforces per-source limits", () => {
  const papers = Array.from({ length: AUTHORIZED_CANVAS_SOURCE_LIMIT + 12 }, (_, index) => ({
    id: `paper-${String(index).padStart(3, "0")}`,
    authorized: index === 0 ? "true" : true,
    title: `Paper ${index}`,
    metadataHash: String(index).padStart(64, "0"),
  }))
  const projection = buildAuthorizedCanvasProjection({ papers })

  assert.equal(projection.placements.length, AUTHORIZED_CANVAS_SOURCE_LIMIT)
  assert.equal(projection.placements.some((item) => item.id === "paper-paper-000"), false)
})

test("each authorized source owns a compact non-overlapping layout block", () => {
  const workspaceNodes = Array.from({ length: AUTHORIZED_CANVAS_SOURCE_LIMIT }, (_, index) => ({
    id: `workspace-${String(index).padStart(3, "0")}`,
    authorized: true,
    type: "note",
    title: `Workspace item ${index}`,
  }))
  const projection = buildAuthorizedCanvasProjection({
    workspaceNodes,
    papers: [{
      id: "paper-1",
      authorized: true,
      title: "First paper",
      metadataHash: "a".repeat(64),
    }],
  })
  const workspacePlacements = projection.placements.filter((item) => item.id.startsWith("workspace-"))
  const paperPlacement = projection.placements.find((item) => item.id === "paper-paper-1")
  const workspaceBottom = Math.max(...workspacePlacements.map((item) => item.y + item.height))

  assert.equal(workspacePlacements.length, AUTHORIZED_CANVAS_SOURCE_LIMIT)
  assert.ok(paperPlacement)
  assert.ok(workspaceBottom < paperPlacement.y)
})

test("sparse authorized sources do not reserve maximum-capacity gaps", () => {
  const projection = buildAuthorizedCanvasProjection({
    workspaceNodes: [{ id: "note-1", authorized: true, type: "note", title: "Note" }],
    papers: [{
      id: "paper-1",
      authorized: true,
      title: "Paper",
      metadataHash: "a".repeat(64),
    }],
    experiments: [{ id: "experiment-1", authorized: true, title: "Experiment" }],
    tasks: [{ id: "task-1", authorized: true, title: "Task" }],
  })

  assert.deepEqual(projection.placements.map((item) => item.y), [0, 680, 1_360, 2_040])
})

test("Atlas camera reveals selected placements and keeps small atlases readable", () => {
  const near = { id: canvasNodeId("near"), x: 0, y: 0 }
  const far = { id: canvasNodeId("far"), x: 2_040, y: 8_160 }

  assert.deepEqual(cameraForAtlasNodes([near], undefined), { x: -60, y: -40, z: ATLAS_MEDIUM_ZOOM })
  assert.deepEqual(cameraForAtlasNodes([near, far], far.id), {
    x: 1_976,
    y: 8_096,
    z: ATLAS_MEDIUM_ZOOM,
  })
  assert.equal(cameraForAtlasNodes(Array.from({ length: 41 }, (_, index) => ({
    id: canvasNodeId(`dense-${index}`),
    x: index,
    y: index,
  }))).z, ATLAS_FAR_OVERVIEW_ZOOM)
})

test("Atlas camera pan controls move the view predictably without dragging", () => {
  for (const zoom of [0.25, 2, 4]) {
    const camera = { x: 10, y: 20, z: zoom }
    const worldStep = ATLAS_CAMERA_PAN_STEP / camera.z

    assert.deepEqual(panAtlasCamera(camera, "left"), { x: camera.x - worldStep, y: camera.y, z: camera.z })
    assert.deepEqual(panAtlasCamera(camera, "right"), { x: camera.x + worldStep, y: camera.y, z: camera.z })
    assert.deepEqual(panAtlasCamera(camera, "up"), { x: camera.x, y: camera.y - worldStep, z: camera.z })
    assert.deepEqual(panAtlasCamera(camera, "down"), { x: camera.x, y: camera.y + worldStep, z: camera.z })
  }
  assert.throws(() => panAtlasCamera({ x: 10, y: 20, z: 2 }, "diagonal"), /pan direction is invalid/)
})

test("authorized canvas cards adapt to the common object projection host without copying content", () => {
  const data = {
    schemaId: "gb.canvas.node.v1",
    placementId: "note-1",
    subjectRef: "gb:object:v1:artifact:note-1:pinned:revision%3A7",
    display: {
      title: "A mathematical note",
      summary: "A portable summary.",
      markdown: "The invariant is $x^2$.",
      provenance: "Authorized workspace note.",
      href: "/workspace?ref=gb%3Aobject%3Av1%3Aartifact%3Anote-1%3Apinned%3Arevision%253A7",
    },
    placementState: { displayMode: "card", collapsed: false, style: {} },
  }
  const projection = projectCanvasNodeObject("galaxy.note", data)
  const resolved = resolvedCanvasNodeRepresentation("galaxy.note", data)

  assert.equal(projection.schemaId, "gb.object-projection.v1")
  assert.equal(projection.kind, "artifact")
  assert.equal(projection.revision.id, "revision:7")
  assert.equal(projection.representations[0].kind, "markdown")
  assert.equal(resolved?.content, data.display.markdown)
  assert.equal(Object.hasOwn(projection, "content"), false)
})

test("canvas object projections normalize multiline display text before strict projection validation", () => {
  const projection = projectCanvasNodeObject("galaxy.note", {
    schemaId: "gb.canvas.node.v1",
    placementId: "multiline-note",
    subjectRef: "gb:object:v1:artifact:multiline-note:latest",
    display: {
      title: "Multiline note",
      summary: "First line\n\nSecond line with $x^2$.",
      provenance: "Authorized workspace\nprojection.",
    },
    placementState: { displayMode: "card", collapsed: false, style: {} },
  })

  assert.equal(projection.summary, "First line Second line with $x^2$.")
  assert.equal(projection.provenance.statement, "Authorized workspace projection.")
})

test("the authenticated workspace is Atlas-only and the compatibility route preserves canonical deep links", async () => {
  const alias = await readFile(new URL("../app/atlas-v2/page.tsx", import.meta.url), "utf8")
  const loader = await readFile(new URL("../app/atlas-v2/atlas-v2-loader.tsx", import.meta.url), "utf8")
  const client = await readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8")
  const commandDeck = await readFile(new URL("../components/atlas/atlas-command-deck.tsx", import.meta.url), "utf8")
  const presenterHost = await readFile(new URL("../components/atlas/atlas-command-presenter-host.tsx", import.meta.url), "utf8")
  const frameDialog = await readFile(new URL("../components/atlas/atlas-frame-dialog.tsx", import.meta.url), "utf8")
  const canvasNode = await readFile(new URL("../components/canvas/galaxy-canvas-node.tsx", import.meta.url), "utf8")
  const constructorDialog = await readFile(new URL("../components/tasks/task-constructor-dialog.tsx", import.meta.url), "utf8")
  const taskSelection = await readFile(new URL("../lib/canvas/atlas-task-selection.js", import.meta.url), "utf8")
  const surfaceMaterialization = await readFile(new URL("../lib/atlas-surface-materialization.js", import.meta.url), "utf8")
  const workspace = await readFile(new URL("../app/workspace/page.tsx", import.meta.url), "utf8")
  const globals = await readFile(new URL("../app/globals.css", import.meta.url), "utf8")

  assert.match(alias, /redirect\(atlasWorkspaceHref\(await searchParams\)\)/)
  assert.doesNotMatch(alias, /GalaxyBrain|AtlasV2Loader|GALAXY_ATLAS|shell|view/)
  assert.match(workspace, /requireUser\(\)/)
  assert.match(workspace, /AuthShell user=\{user\} ownsAccountMenu/)
  assert.match(workspace, /<AtlasV2Loader[\s\S]*tenantId=\{user\.tenantId\}[\s\S]*principalId=\{user\.principalId\}[\s\S]*headerSlot=\{<AccountMenu user=\{user\} \/>\}/)
  assert.doesNotMatch(workspace, /GalaxyBrain|searchParams|GALAXY_ATLAS|requestedShell|requestedView/)
  assert.match(client, /HudToolbar label="Atlas commands"/)
  assert.match(client, /atlas-header-account/)
  assert.match(client, /const tenantCanvases = durableCanvas \? \[\] : await galaxyBrainAPI\.getCanvases\(\)/)
  assert.match(client, /selectAtlasWorkspaceId\(durableCanvas, tenantCanvases, workspaces\)/)
  assert.match(client, /workspaces\.find\(\(candidate\) => candidate\.id === workspaceId\)/)
  assert.match(client, /Move placement/)
  assert.match(client, /store\.updateNode\(current\.id/)
  assert.match(client, /cameraForAtlasNodes/)
  assert.match(client, /panAtlasCamera\(runtime\.store\.getCamera\(\), direction\)/)
  assert.match(client, /role="group" aria-label="Atlas camera controls"/)
  assert.match(client, /role="group" aria-label="Pan Atlas without dragging"/)
  assert.match(client, /role="group" aria-label="Atlas zoom controls"/)
  for (const direction of ["up", "left", "down", "right"]) {
    assert.match(client, new RegExp(`className="atlas-camera-control[^"]*"[^>]+type="button"[^>]+aria-label="Pan Atlas ${direction}"[^>]+onClick=\\{\\(\\) => panCamera\\("${direction}"\\)\\}`))
  }
  for (const label of ["Zoom out", "Reset camera", "Zoom in"]) {
    assert.match(client, new RegExp(`className="atlas-camera-control"[^>]+type="button"[^>]+aria-label="${label}"`))
  }
  assert.match(globals, /\.atlas-camera-pan-controls,[\s\S]*?grid-template-columns: repeat\(3, 2\.75rem\)/)
  assert.match(globals, /\.atlas-camera-control \{[\s\S]*?min-width: 2\.75rem;[\s\S]*?min-height: 2\.75rem;/)
  assert.match(client, /<div className="atlas-minimap">[\s\S]*?<Minimap width=\{190\} height=\{130\} position="bottom-right"/)
  const narrowMinimapRule = globals.match(/@media \(max-width: (\d+)px\) \{\s*\.atlas-minimap \{ display: none; \}\s*\}/)
  assert.ok(narrowMinimapRule)
  const minimapBreakpoint = Number(narrowMinimapRule[1])
  for (const viewportWidth of [390, 375, 320]) assert.ok(viewportWidth <= minimapBreakpoint)
  assert.match(client, /ObjectProjectionHost/)
  assert.doesNotMatch(client, /import \{ TaskConstructorDialog \}/)
  assert.match(presenterHost, /TaskConstructorDialog/)
  assert.match(client, /AtlasCommandDeck/)
  assert.match(client, /AtlasCommandPresenterHost/)
  assert.match(client, /dispatchAtlasCommand/)
  assert.match(client, /resolveAtlasTaskSelection/)
  assert.match(client, /hydrateAtlasObjectReferences/)
  assert.match(client, /hydrationGenerationRef/)
  assert.match(client, /controller\.signal\.aborted \|\| generation !== hydrationGenerationRef\.current/)
  assert.match(client, /role="status" aria-live="polite" aria-atomic="true"/)
  assert.match(taskSelection, /reference\?\.format !== "canonical" \|\| reference\.kind !== "ham\.task"/)
  assert.match(taskSelection, /projection\.provenance\?\.sourceRevision === expectedRevision/)
  assert.match(taskSelection, /createGalaxyObjectReference\("ham\.task", task\.id/)
  assert.match(client, /function AccessibleAtlasList\(\{[\s\S]*tasks,[\s\S]*onExecuteTaskCommand,/)
  assert.match(client, /aria-label=\{`Open task constructor for \$\{resolvedProjection\.title\}`\}/)
  assert.match(client, /onExecuteTaskCommand\([\s\S]*"task\.plan\.open",[\s\S]*taskSelection,[\s\S]*event\.currentTarget/)
  assert.match(client, /<AccessibleAtlasList[\s\S]*tasks=\{atlas\.tasks\}[\s\S]*onExecuteTaskCommand=\{executeTaskCommand\}/)
  assert.match(canvasNode, /hydration\?\.status === "resolved"/)
  assert.match(canvasNode, /UnavailableCanvasObject/)
  assert.match(canvasNode, /const moving = harnessMoving \|\| !settledCamera[\s\S]*settledCamera\.x !== camera\.x/)
  assert.match(canvasNode, /window\.setTimeout\(\(\) => setSettledCamera\(next\), 120\)/)
  assert.doesNotMatch(canvasNode, /setMoving\(true\)/)
  assert.match(client, /aria-keyshortcuts="Control\+K Meta\+K"/)
  assert.equal(client.match(/<TaskConstructorDialog/g)?.length ?? 0, 0)
  assert.equal(presenterHost.match(/<TaskConstructorDialog/g)?.length, 1)
  assert.equal(client.match(/<AtlasCommandPresenterHost/g)?.length, 1)
  assert.equal(presenterHost.match(/<NewExperimentDialog/g)?.length, 1)
  assert.match(client, /onCreated: placeCreatedExperiment/)
  assert.match(presenterHost, /navigateOnCreated=\{false\}/)
  assert.match(client, /recoveryScope: experimentRecoveryScope/)
  assert.match(client, /returnFocus=\{commandTriggerRef\.current\}/)
  assert.match(client, /writePendingExperimentPlacement\(window\.localStorage, experimentRecoveryScope/)
  assert.match(client, /removePendingExperimentPlacement\(/)
  assert.match(client, /listPendingExperimentPlacements\(window\.localStorage, experimentRecoveryScope\)/)
  assert.match(client, /createGalaxyObjectReference\("eln\.experiment", experiment\.id\)/)
  assert.match(client, /!operationId \|\| referencePlacementRetry\.operationId === operationId/)
  assert.match(client, /Retry placement/)
  assert.match(
    client,
    /disabled=\{referencePlacementRequest !== null \|\| placementRemovalRequest !== null \|\| frameMutationBusy \|\| frameMutationOperation !== null\}/,
  )
  assert.match(client, /placement is unconfirmed\. Retry placement without recreating it\./)
  assert.match(client, /writePendingAtlasFrameMutation\(window\.localStorage, scope, operation\)/)
  assert.match(client, /reconcileAtlasFrameMutation\(/)
  assert.match(client, /removePendingAtlasFrameMutation\(window\.localStorage, scope, operation\.operationId\)/)
  assert.match(client, /acceptCanvasSnapshot\(error\.canvas\)[\s\S]*removePendingAtlasFrameMutation/)
  assert.match(client, /quarantineAtlasFrameMutationJournal\(window\.localStorage, frameMutationScope\)/)
  assert.match(client, /current\.content\.frames\?\.length \?\? 0\) >= 100/)
  assert.match(client, /frameMutation: frameMutationBusy \|\| frameMutationOperation !== null/)
  assert.match(client, /atlasMutationReady = atlasRuntimeReady && !frameMutationBusy && frameMutationOperation === null/)
  assert.match(client, /canvasMutationsBlocked=\{frameMutationBusy \|\| frameMutationOperation !== null\}/)
  assert.match(client, /\|\| frameCreateOpen/)
  assert.match(client, /onPointerDownCapture=\{blockFrameRotation\}/)
  assert.match(client, /retryFrameRef\.current = \{ entries, idempotencyKey \}/)
  assert.match(frameDialog, /role="group" aria-label="Frame tone"/)
  assert.match(frameDialog, /aria-pressed=\{tone === value\}/)
  assert.match(commandDeck, /DialogTitle>Atlas commands/)
  assert.match(commandDeck, /aria-label="Search Atlas commands"/)
  assert.match(commandDeck, /onEscapeKeyDown=\{\(event\) => event\.stopPropagation\(\)\}/)
  assert.match(constructorDialog, /getTaskConstructorCloseDecision\(interactionState\)/)
  assert.match(constructorDialog, /if \(discardOpen\) event\.preventDefault\(\)/)
  assert.match(constructorDialog, /focusFirstAvailable\(\[returnFocus, fallbackFocus\]/)
  assert.doesNotMatch(client, /ChatPanel|ToolPanel|Social|Flowise/)
  assert.match(loader, /ssr: false/)
  assert.match(client, /asPlacementCanvasStore/)
  assert.match(client, /commandsForPlacementGeometry/)
  assert.match(client, /mutateCanvas/)
  assert.doesNotMatch(client, /applyOp|applyBatch|mutation_json/)
  assert.match(client, /AccessibleAtlasList/)
  assert.match(client, /\/api\/eln\/papers/)
  assert.match(client, /\/api\/eln\/experiments\?limit=60/)
  assert.match(client, /fetchTaskSnapshot/)
  assert.match(client, /\/api\/eln\/surfaces/)
  assert.match(client, /setHydrationState\(\{ key: hydrationKey, byReference: hydrated\.byReference \}\)[\s\S]*hydrateAtlasSurfaceSpecs\(/)
  assert.match(client, /galaxyBrainAPI\.resolveSurface\(surfaceId, version, signal\)/)
  assert.match(surfaceMaterialization, /validateResolvedSurface\(resolved, expected\)/)
  assert.equal((client.match(/surfaceSpec=\{hydration\?\.status === "resolved"/g) ?? []).length, 2)
  assert.match(canvasNode, /surfaceSpec=\{hydration\.surfaceSpec\}/)
  assert.match(client, /\/api\/eln\/object-links\?\$\{query\}/)
  assert.match(client, /visibleCanonicalReferences\(placementProjection, durableCanvas\)/)
  assert.match(client, /authorizedObjectLinkPlacements\(merged, hydrationByReference\)/)
  assert.match(client, /relations: \[[\s\S]*\.\.\.merged\.relations,[\s\S]*\.\.\.semanticRelations\.filter/)
  assert.match(client, /queriedReferences\.length > 0[\s\S]*\? "partial"/)
  assert.equal(client.match(/setReload\(\(value\) => value \+ 1\)/g)?.length, 2)
  assert.match(client, /getLatestCanvasChange\(current\.canvasId, signal\)/)
  assert.match(client, /canvasChangeAction\(\{[\s\S]*version: observed\.version,[\s\S]*contentHash: observed\.contentHash,[\s\S]*\}, false, event\)/)
  assert.match(client, /\|\| dropOperationLock\.active\(\)/)
  assert.match(client, /\|\| referencePlacementRequestRef\.current !== null/)
  assert.match(client, /\|\| placementRemovalRequestRef\.current !== null/)
  assert.match(client, /poller\.setVisible\(document\.visibilityState !== "hidden"\)/)
  assert.match(client, /setPendingInvalidation\(\{[\s\S]*canvasId: event\.canvasId,[\s\S]*version: event\.version,[\s\S]*contentHash: event\.contentHash/)
  assert.match(client, /current\.version > pending\.version\) return null/)
  assert.match(client, /current\.version === pending\.version && current\.contentHash === pending\.contentHash\) return null/)
  assert.match(client, /Accepted Atlas layout v\$\{pendingInvalidation\.version\} is available\. Reload when the current placement is finished\./)
  assert.match(client, /Reload accepted layout/)
  assert.match(client, /const requestInvalidatedCanvasReload = useCallback\(\(\) => \{[\s\S]*canvasConvergenceReaderRef\.current\?\.\(\)\.pendingWork[\s\S]*focusAtlasAfterInvalidationRef\.current = true[\s\S]*setReload/)
  assert.match(client, /accepted\.workspaceId !== current\.workspaceId[\s\S]*if \(!observed\) \{[\s\S]*catalogIncludesAccepted[\s\S]*current\.canvases\.length > 0 && !catalogIncludesAccepted\) return current[\s\S]*durableCanvas: accepted/)
  assert.match(client, /const requestListView = useCallback\(\(\) => \{[\s\S]*canvasConvergenceReaderRef\.current\?\.\(\)\.pendingWork[\s\S]*Finish the current Atlas placement before switching to the list\.[\s\S]*setView\("list"\)/)
  assert.match(client, /label="List"[\s\S]*onClick=\{requestListView\}/)
  assert.match(client, /const requestAtlasReload = useCallback\([\s\S]*canvasConvergenceReaderRef\.current\?\.\(\)\.pendingWork[\s\S]*setReload/)
  assert.match(client, /const requestAtlasRefresh = useCallback\(\(\) => \{[\s\S]*requestAtlasReload\("Finish the current Atlas placement before refreshing\."\)/)
  assert.match(client, /label="Refresh"[\s\S]*onClick=\{requestAtlasRefresh\}/)
  assert.match(client, /canvasReloadSatisfiesChange\(reloaded, invalidation\)/)
  assert.match(client, /The updated Atlas revision could not be verified/)
  assert.match(client, /atlasLoadGenerationRef\.current \+= 1[\s\S]*atlasLoadAbortRef\.current\?\.abort\(\)/)
  assert.match(client, /atlasLoadGenerationRef\.current !== generation/)
  assert.match(client, /terminalAuthorizationFailure[\s\S]*setAtlas\(null\)[\s\S]*clearAtlasExactRepresentationCache/)
  assert.match(client, /galaxyBrainAPI\.getCanvas\(requestedCanvas\)[\s\S]*error instanceof GalaxyBrainAPIError[\s\S]*error\.status === 401[\s\S]*throw error/)
  assert.match(client, /canvasId !== null && canvasId !== invalidation\.canvasId[\s\S]*setPendingInvalidation\(null\)/)
  assert.match(client, /ref=\{loadErrorHeadingRef\} tabIndex=\{-1\}/)
  assert.match(client, /onClick=\{requestInvalidatedCanvasReload\}/)
  assert.match(client, /Finish the current Atlas placement before loading the accepted layout\./)
  assert.match(client, /\{canvasActionStatus \? \(/)
  assert.match(client, /onCanvasAccepted=\{acceptCanvasSnapshot\}/)
  assert.match(client, /onPendingWorkReaderChange=\{registerCanvasConvergenceReader\}/)
  assert.match(client, /role="status" aria-live="polite" aria-atomic="true"/)
  assert.match(client, /onTerminalError:[\s\S]*This Atlas is no longer available or your access has changed/)
  assert.match(client, /poller\.stop\(\)/)
  const completionStart = client.indexOf("const completeReferencePlacement = useCallback")
  const completionEnd = client.indexOf("const failReferencePlacement = useCallback", completionStart)
  assert.ok(completionStart >= 0 && completionEnd > completionStart)
  assert.doesNotMatch(client.slice(completionStart, completionEnd), /setReload\(/)
  assert.doesNotMatch(client, /GALAXY_API_INTERNAL|X-GB-Tenant-ID|DATABASE_URL/)
})

test("the Atlas shell preview is dev-only, injects the real client, and performs no fixture fetch", async () => {
  const preview = await readFile(new URL("../app/dev/atlas-shell-preview/page.tsx", import.meta.url), "utf8")
  const client = await readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8")
  const taskDialog = await readFile(new URL("../components/tasks/task-constructor-dialog.tsx", import.meta.url), "utf8")

  assert.match(preview, /devPreviewsEnabled\(\)/)
  assert.match(preview, /if \(!devPreviewsEnabled\(\)\) notFound\(\)/)
  assert.match(preview, /<AtlasV2Client/)
  assert.match(preview, /initialAtlas=\{previewAtlas\}/)
  assert.match(preview, /mode="preview"/)
  assert.match(preview, /defaultSelectionRef=\{taskPlacement\?\.subjectRef\}/)
  assert.match(preview, /headerSlot=\{<span className="atlas-preview-account">Preview identity<\/span>\}/)
  assert.match(preview, /nodeType === "galaxy\.task"/)
  assert.doesNotMatch(preview, /fetch\(|galaxyBrainAPI|galaxyBrainService/)
  assert.match(client, /if \(initialAtlas\)/)
  assert.match(client, /if \(preview \|\| suppressRef\.current/)
  assert.match(client, /mode: preview \? "preview" : "live"/)
  assert.match(taskDialog, /<TaskConstructor[\s\S]*?task=\{task\}[\s\S]*?mode=\{mode\}[\s\S]*?onInteractionStateChange=\{setInteractionState\}/)
})
