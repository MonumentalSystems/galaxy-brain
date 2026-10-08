import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  ATLAS_OBJECT_DRAG_MIME,
  authorizeAtlasObjectDrop,
  createAtlasDropOperationLock,
  hasAtlasObjectDrag,
  parseAtlasObjectDrop,
  selectAtlasPendingDropRecovery,
  writeAtlasObjectDrag,
} from "../lib/atlas-object-drop.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import { projectTaskObject } from "../lib/object-projection-adapters.js"

function transfer() {
  const values = new Map()
  return {
    files: [],
    items: [],
    types: [],
    effectAllowed: "none",
    setData(type, value) {
      values.set(type, value)
      if (!this.types.includes(type)) this.types.push(type)
    },
    getData(type) {
      return values.get(type) ?? ""
    },
  }
}

test("writes and parses a bounded canonical first-party Atlas object intent", () => {
  const data = transfer()
  const subjectRef = createGalaxyObjectReference("ham.task", "task-42")
  const written = writeAtlasObjectDrag(data, { subjectRef, label: "Adversarial review" })

  assert.equal(data.effectAllowed, "copy")
  assert.equal(hasAtlasObjectDrag(data), true)
  assert.deepEqual(parseAtlasObjectDrop(data), written)
})

test("operation lock rejects a second drop until deferred authorization publishes", async () => {
  const lock = createAtlasDropOperationLock()
  let release
  const deferred = new Promise((resolve) => { release = resolve })
  let secondCalls = 0
  const first = lock.run(async () => deferred)

  assert.equal(lock.active(), true)
  assert.equal(await lock.run(async () => { secondCalls += 1 }), false)
  assert.equal(secondCalls, 0)
  release()
  assert.equal(await first, true)
  assert.equal(lock.active(), false)
  assert.equal(await lock.run(async () => { secondCalls += 1 }), true)
  assert.equal(secondCalls, 1)
})

test("pending retry selects only the exact same-kind recovery operation", () => {
  const file = { operationId: "file-operation", document: "file" }
  const object = { operationId: "object-operation", subjectRef: "object" }
  assert.equal(selectAtlasPendingDropRecovery(
    { kind: "file", operationId: "file-operation" },
    { file, object },
  ), file)
  assert.equal(selectAtlasPendingDropRecovery(
    { kind: "object", operationId: "object-operation" },
    { file, object },
  ), object)
  assert.equal(selectAtlasPendingDropRecovery(
    { kind: "file", operationId: "object-operation" },
    { file, object },
  ), null)
  assert.equal(selectAtlasPendingDropRecovery(
    { kind: "object", operationId: "file-operation" },
    { file, object },
  ), null)
})

test("rejects forged, mixed, and unsupported object drops", () => {
  const mixed = transfer()
  writeAtlasObjectDrag(mixed, {
    subjectRef: createGalaxyObjectReference("ham.task", "task-42"),
    label: "Task",
  })
  mixed.files.push(new File(["x"], "note.md", { type: "text/markdown" }))
  assert.throws(() => parseAtlasObjectDrop(mixed), /cannot be dropped together/i)

  const forged = transfer()
  forged.setData(ATLAS_OBJECT_DRAG_MIME, JSON.stringify({
    schemaId: "gb.atlas.object-drag.v1",
    subjectRef: "gb:object:v1:artifact:unplaceable:latest",
    label: "Artifact",
  }))
  assert.throws(() => parseAtlasObjectDrop(forged), /cannot be placed/i)

  const extra = transfer()
  extra.setData(ATLAS_OBJECT_DRAG_MIME, JSON.stringify({
    schemaId: "gb.atlas.object-drag.v1",
    subjectRef: createGalaxyObjectReference("ham.task", "task-42"),
    label: "Task",
    authorized: true,
  }))
  assert.throws(() => parseAtlasObjectDrop(extra), /invalid or unavailable/i)
})

test("treats drag data as intent and requires a matching authorized place-capable hydration", () => {
  const requestedRef = createGalaxyObjectReference("ham.task", "task-42")
  const intent = {
    schemaId: "gb.atlas.object-drag.v1",
    subjectRef: requestedRef,
    label: "Untrusted label",
  }
  const projection = projectTaskObject({
    id: "task-42",
    title: "Authorized title",
    goal: "Review the evidence.",
    version: 3,
  })
  const hydration = {
    requestedRef,
    status: "resolved",
    resolvedRef: requestedRef,
    provider: "ham",
    projection,
    handles: [],
  }

  assert.deepEqual(authorizeAtlasObjectDrop(intent, hydration), {
    subjectRef: requestedRef,
    label: "Authorized title",
  })
  assert.throws(() => authorizeAtlasObjectDrop(intent, {
    ...hydration,
    projection: { ...projection, capabilities: projection.capabilities.filter((value) => value !== "place") },
  }), /permission to place/i)
  assert.throws(() => authorizeAtlasObjectDrop(intent, { ...hydration, requestedRef: createGalaxyObjectReference("ham.task", "other") }), /permission to place/i)
})

test("Atlas renders the pending card at the dropped world point and reauthorizes shelf objects before placement", async () => {
  const client = await readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8")
  assert.match(client, /function AtlasPendingDropCard[\s\S]*worldToScreen\(pending\.point, camera\)[\s\S]*phase === "error"/u)
  assert.match(client, /onPendingDrop\(\{[\s\S]*phase: "authorizing"[\s\S]*authorizeAtlasDropImportTarget\(plan, ensureCanvas\)/u)
  assert.match(client, /<AtlasSourceShelf[\s\S]*placements=\{atlas\.sourceCandidates\}/u)
  assert.match(client, /hydrateAtlasObjectReferences\(\[intent\.subjectRef\][\s\S]*authorizeAtlasObjectDrop\(intent,[\s\S]*placeReference\(recovery\.subjectRef, recovery\.operationId, recovery\.point\)/u)
  assert.match(client, /dropOperationLock\.run\(async \(\) => \{[\s\S]*await onAtlasObjectDrop/u)
  assert.match(client, /click, press Enter, or press Space[\s\S]*aria-describedby="atlas-source-shelf-instructions"[\s\S]*onClick=\{\(\) => \{[\s\S]*onPlace\(/u)
  assert.match(client, /sourcePlacementRequest[\s\S]*bounds\.width \/ 2[\s\S]*activeStore\.getCamera\(\)[\s\S]*onAtlasObjectDrop\(sourcePlacementRequest\.intent, point, targetCanvas\)/u)
  assert.match(client, /selectAtlasPendingDropRecovery\(pendingDrop,[\s\S]*atlasDropImportRecoveryRef\.current[\s\S]*atlasObjectDropRecoveryRef\.current/u)
})
