import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import {
  normalizePaperEnhanceReferences,
  paperEnhanceIntentAvailability,
  paperEnhanceIntentAvailabilityForInput,
  paperEnhanceReferenceInputState,
  paperEnhancePreset,
  paperTaskConstructorHref,
  paperTaskConstructorHrefFromLink,
  parsePaperTaskConstructorRequest,
} from "../lib/paper-enhance-handoff.js"

const anchorRef = createGalaxyObjectReference("document.anchor", `sha256:${"a".repeat(64)}`, {
  mode: "pinned",
  revision: `sha256:${"b".repeat(64)}`,
})

function pinned(index) {
  return createGalaxyObjectReference("document", `document-${index}`, {
    mode: "pinned",
    revision: `sha256:${index.toString(16).padStart(64, "0")}`,
  })
}

test("enhance presets and dismiss state remain pure local intent", async () => {
  let ioCalls = 0
  const io = () => { ioCalls += 1 }
  for (const intent of ["explain", "challenge", "compare", "synthesize"]) {
    const preset = paperEnhancePreset(intent, "A bounded paper")
    assert.equal(preset.intent, intent)
    assert.ok(preset.title.length <= 200)
  }
  assert.equal(ioCalls, 0)

  const reader = await readFile(new URL("../components/papers/durable-paper-reader.tsx", import.meta.url), "utf8")
  const select = reader.slice(reader.indexOf("function selectEnhanceIntent"), reader.indexOf("function dismissEnhance"))
  const dismiss = reader.slice(reader.indexOf("function dismissEnhance"), reader.indexOf("function dispatchEnhancement"))
  assert.doesNotMatch(select, /fetch|actionPort|dispatchTask|dataPort/)
  assert.doesNotMatch(dismiss, /fetch|actionPort|dispatchTask|dataPort/)
  assert.match(reader, /aria-expanded=\{enhanceOpen\}/)
  assert.match(reader, /min-h-11/)
})

test("compare and synthesize require two to eight distinct checked pinned references", () => {
  const one = normalizePaperEnhanceReferences(anchorRef)
  assert.equal(paperEnhanceIntentAvailability("compare", one, true).enabled, false)
  assert.equal(paperEnhanceIntentAvailability("synthesize", one, true).enabled, false)

  const two = normalizePaperEnhanceReferences(anchorRef, `${pinned(1)}\n${pinned(1)}`)
  assert.equal(two.length, 2, "duplicates are folded before enforcing the aggregate bound")
  assert.equal(paperEnhanceIntentAvailability("compare", two, false).enabled, false)
  assert.equal(paperEnhanceIntentAvailability("compare", two, true).enabled, true)
  assert.equal(paperEnhanceIntentAvailability("synthesize", two, true).enabled, true)

  const eight = normalizePaperEnhanceReferences(anchorRef, Array.from({ length: 7 }, (_, index) => pinned(index + 1)))
  assert.equal(eight.length, 8)
  assert.throws(
    () => normalizePaperEnhanceReferences(anchorRef, Array.from({ length: 8 }, (_, index) => pinned(index + 1))),
    /at most 8 distinct/,
  )
  assert.throws(() => normalizePaperEnhanceReferences(anchorRef, [`gb:${"a".repeat(501)}`]), /at most 500/)
  assert.throws(() => normalizePaperEnhanceReferences(anchorRef, [createGalaxyObjectReference("document", "latest")]), /pinned/)
})

test("partial and over-cap reference input stays disabled instead of throwing during interaction", async () => {
  const partial = paperEnhanceReferenceInputState(anchorRef, "g")
  assert.equal(partial.references.length, 0)
  assert.match(partial.error, /canonical pinned/u)
  assert.deepEqual(paperEnhanceIntentAvailabilityForInput("compare", partial, false), {
    enabled: false,
    reason: partial.error,
  })

  const overCapText = Array.from({ length: 8 }, (_, index) => pinned(index + 1)).join("\n")
  const overCap = paperEnhanceReferenceInputState(anchorRef, overCapText)
  assert.equal(overCap.references.length, 0)
  assert.match(overCap.error, /at most 8 distinct/u)
  assert.deepEqual(paperEnhanceIntentAvailabilityForInput("synthesize", overCap, false), {
    enabled: false,
    reason: overCap.error,
  })

  const reader = await readFile(new URL("../components/papers/durable-paper-reader.tsx", import.meta.url), "utf8")
  assert.match(reader, /paperEnhanceReferenceInputState\(selectedAnchor\.ref, enhanceRefsText\)/u)
  assert.equal(reader.match(/paperEnhanceIntentAvailabilityForInput\(/gu)?.length, 1)
  assert.doesNotMatch(reader, /paperEnhanceIntentAvailability\(/u)
})

test("task constructor links bind an exact safe task id and version", () => {
  const href = paperTaskConstructorHref({ id: "task-reader-1", version: 7 })
  assert.equal(href, "/tasks?construct=task-reader-1&version=7")
  assert.deepEqual(parsePaperTaskConstructorRequest({ construct: "task-reader-1", version: "7" }), {
    taskId: "task-reader-1",
    version: 7,
  })
  assert.equal(parsePaperTaskConstructorRequest({}), null)
  assert.throws(() => parsePaperTaskConstructorRequest({ construct: "task-reader-1", version: "latest" }), /invalid/)
  assert.throws(() => parsePaperTaskConstructorRequest({ construct: ["task-reader-1"], version: "7" }), /invalid/)
})

test("durable task backlinks recover only exact creation-version constructor links", () => {
  const taskLatest = createGalaxyObjectReference("ham.task", "task-reader-1")
  const taskVersion = createGalaxyObjectReference("ham.task", "task-reader-1", {
    mode: "pinned",
    revision: "version:7",
  })
  assert.equal(paperTaskConstructorHrefFromLink({
    from_ref: anchorRef,
    to_ref: taskLatest,
    provenance: { source_ref: taskVersion },
  }), "/tasks?construct=task-reader-1&version=7")
  assert.equal(paperTaskConstructorHrefFromLink({
    from_ref: anchorRef,
    to_ref: taskLatest,
    provenance: { source_ref: taskLatest },
  }), undefined)
  assert.equal(paperTaskConstructorHrefFromLink({
    from_ref: anchorRef,
    to_ref: createGalaxyObjectReference("ham.task", "different-task"),
    provenance: { source_ref: taskVersion },
  }), undefined)
})

test("handoff uses only task plus authored context link writes and exact projection reads", async () => {
  const [reader, client, queue, page] = await Promise.all([
    readFile(new URL("../components/papers/durable-paper-reader.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/paper-reader-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/tasks/task-queue-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/tasks/page.tsx", import.meta.url), "utf8"),
  ])
  assert.match(client, /hydrateAtlasObjectReferences\(references/)
  assert.match(client, /relation: "context_for"/)
  assert.match(client, /paperTaskConstructorHref\(result\.operation\.task!\)/)
  assert.doesNotMatch(client, /relations\.propose|run\.create|claim\.create|surface\.create|canvas\.arrange/)
  assert.match(queue, /fetchTaskDetail\(constructorRequest\.taskId/)
  assert.match(queue, /fetchTaskDetail\(task\.id, controller\.signal\)/)
  assert.doesNotMatch(queue, /openExactConstructor\(task, task\.version, trigger/)
  assert.match(queue, /task\.version !== expectedVersion/)
  assert.match(queue, /authorizedPinnedTaskResourceRefs\(task\.resources\)/)
  assert.match(queue, /hydrateAtlasObjectReferences\(references/)
  assert.match(page, /parsePaperTaskConstructorRequest\(await searchParams\)/)
  assert.match(reader, /Reference checks are read-only and do not create a task or relation/)
})
