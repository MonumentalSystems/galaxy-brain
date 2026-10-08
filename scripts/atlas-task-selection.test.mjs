import assert from "node:assert/strict"
import test from "node:test"

import { resolveAtlasTaskSelection } from "../lib/canvas/atlas-task-selection.js"
import {
  createGalaxyObjectReference,
} from "../lib/galaxy-object-reference.js"
import { dispatchAtlasCommand } from "../lib/plugins/atlas-commands.js"

const task = Object.freeze({
  id: "task-1",
  version: 7,
  title: "Inspect the exact task",
  projectionSource: "ham",
})
const latestRef = createGalaxyObjectReference("ham.task", task.id)
const pinnedRef = createGalaxyObjectReference("ham.task", task.id, {
  mode: "pinned",
  revision: "version:7",
})

function resolvedHydration(overrides = {}) {
  const projectionOverrides = overrides.projection || {}
  const provenanceOverrides = projectionOverrides.provenance || {}
  return {
    requestedRef: latestRef,
    status: "resolved",
    resolvedRef: latestRef,
    provider: "ham",
    handles: [],
    ...overrides,
    projection: {
      schemaId: "gb.object-projection.v1",
      ref: latestRef,
      kind: "ham.task",
      provenance: {
        provider: "ham",
        sourceId: task.id,
        sourceRevision: "version:7",
        ...provenanceOverrides,
      },
      ...projectionOverrides,
    },
  }
}

test("Atlas task selection pins the authorized hydrated snapshot before dispatch", () => {
  const selection = resolveAtlasTaskSelection({
    subjectRef: latestRef,
    availability: "resolved",
    hydration: resolvedHydration(),
    tasks: [task],
  })

  assert.equal(selection?.task, task)
  assert.equal(selection?.subjectRef, pinnedRef)
  assert.deepEqual(dispatchAtlasCommand("task.plan.open", { subjectRef: selection?.subjectRef }), {
    ok: true,
    effect: {
      kind: "open-task-plan",
      subjectRef: pinnedRef,
      taskId: task.id,
      revision: "version:7",
    },
  })
})

test("Atlas task selection supports an authorized in-memory projection and exact pinned input", () => {
  assert.equal(resolveAtlasTaskSelection({
    subjectRef: latestRef,
    availability: "resolved",
    tasks: [task],
  })?.subjectRef, pinnedRef)
  assert.equal(resolveAtlasTaskSelection({
    subjectRef: pinnedRef,
    availability: "resolved",
    tasks: [task],
  })?.subjectRef, pinnedRef)
})

test("Atlas task selection fails closed for unavailable, ambiguous, or invalid inputs", () => {
  const otherTaskRef = createGalaxyObjectReference("ham.task", "task-2")
  const paperRef = createGalaxyObjectReference("paper", "task-1")
  const wrongPinnedRef = createGalaxyObjectReference("ham.task", task.id, {
    mode: "pinned",
    revision: "version:6",
  })
  const unicodeTaskRef = createGalaxyObjectReference("ham.task", "tést")
  const noncanonicalUnicodeRef = unicodeTaskRef.replaceAll("%C3%A9", "%c3%a9")
  const cases = [
    { subjectRef: paperRef, availability: "resolved", tasks: [task] },
    { subjectRef: "gb:node:legacy", availability: "resolved", tasks: [task] },
    { subjectRef: noncanonicalUnicodeRef, availability: "resolved", tasks: [{ ...task, id: "tést" }] },
    { subjectRef: latestRef, availability: "unavailable", tasks: [task] },
    { subjectRef: latestRef, availability: "resolved", tasks: [] },
    { subjectRef: latestRef, availability: "resolved", tasks: [task, { ...task }] },
    { subjectRef: latestRef, availability: "resolved", tasks: [{ ...task, version: undefined }] },
    { subjectRef: latestRef, availability: "resolved", tasks: [{ ...task, projectionSource: "galaxy" }] },
    { subjectRef: wrongPinnedRef, availability: "resolved", tasks: [task] },
    { subjectRef: latestRef, availability: "resolved", hydration: { status: "loading" }, tasks: [task] },
    { subjectRef: latestRef, availability: "resolved", hydration: { requestedRef: latestRef, status: "unavailable" }, tasks: [task] },
    { subjectRef: latestRef, availability: "resolved", hydration: { requestedRef: latestRef, status: "request-failed" }, tasks: [task] },
    { subjectRef: latestRef, availability: "resolved", hydration: resolvedHydration({ requestedRef: otherTaskRef }), tasks: [task] },
    { subjectRef: latestRef, availability: "resolved", hydration: resolvedHydration({ resolvedRef: otherTaskRef }), tasks: [task] },
    { subjectRef: latestRef, availability: "resolved", hydration: resolvedHydration({ provider: "other" }), tasks: [task] },
    { subjectRef: latestRef, availability: "resolved", hydration: resolvedHydration({ projection: { ref: otherTaskRef } }), tasks: [task] },
    { subjectRef: latestRef, availability: "resolved", hydration: resolvedHydration({ projection: { kind: "paper" } }), tasks: [task] },
    { subjectRef: latestRef, availability: "resolved", hydration: resolvedHydration({ projection: { provenance: { sourceId: "task-2" } } }), tasks: [task] },
    { subjectRef: latestRef, availability: "resolved", hydration: resolvedHydration({ projection: { provenance: { sourceRevision: "version:8" } } }), tasks: [task] },
  ]

  cases.forEach((input) => assert.equal(resolveAtlasTaskSelection(input), null))
})
