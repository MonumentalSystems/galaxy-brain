import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  dispatchAtlasCommand,
  getAtlasCommandSearchValue,
  listAtlasCommands,
  resolveAtlasCommand,
} from "../lib/plugins/atlas-commands.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import { builtinPluginRegistry } from "../lib/plugins/builtins.js"

test("Atlas lists only code-owned registered commands with contextual availability", () => {
  const unavailable = listAtlasCommands()
  const available = listAtlasCommands({
    hasSelectedTask: true,
    hasSelectedPlacement: true,
    canPlaceReference: true,
    canRemovePlacement: true,
    hasSelectedFrame: true,
    canRemoveFrame: true,
    canMutateFrames: true,
    canCreateFrame: true,
    canCreateExperiment: true,
    canSearchHam: true,
    canImportFormalPackage: true,
    canOpenProofRegistry: true,
    canReviewRelations: true,
    canCreateCanvas: true,
  })

  assert.deepEqual(unavailable.map(({ id, enabled }) => ({ id, enabled })), [
    { id: "canvas.create.open", enabled: false },
    { id: "code.editor.open", enabled: false },
    { id: "code.graph.snapshot.import", enabled: false },
    { id: "datasource.manage.open", enabled: false },
    { id: "document.import", enabled: false },
    { id: "document.note.create", enabled: false },
    { id: "eln.experiment.create", enabled: false },
    { id: "frame.create.open", enabled: false },
    { id: "frame.remove", enabled: false },
    { id: "ham.memory.search.open", enabled: false },
    { id: "ink.draw.open", enabled: false },
    { id: "legacy.flow.portability.open", enabled: true },
    { id: "paper.import", enabled: false },
    { id: "placement.remove", enabled: false },
    { id: "proof.package.import", enabled: false },
    { id: "proof.registry.open", enabled: false },
    { id: "reference.place", enabled: false },
    { id: "relations.review.open", enabled: false },
    { id: "share.canvas-conversation.create", enabled: false },
    { id: "share.canvas.create", enabled: false },
    { id: "share.selection.create", enabled: false },
    { id: "surface.place.open", enabled: false },
    { id: "task.plan.open", enabled: false },
    { id: "voice.capture.open", enabled: false },
    { id: "web.capture.open", enabled: false },
  ])
  const unavailableById = Object.fromEntries(unavailable.map((command) => [command.id, command]))
  assert.equal(unavailableById["code.editor.open"].unavailableReason, "Wait for the Atlas canvas to finish loading.")
  assert.equal(unavailableById["code.graph.snapshot.import"].unavailableReason, "Wait for the Atlas canvas to finish loading.")
  assert.equal(unavailableById["canvas.create.open"].unavailableReason, "Wait for the current Atlas work to finish.")
  assert.equal(unavailableById["datasource.manage.open"].unavailableReason, "Wait for the Atlas canvas to finish loading.")
  assert.equal(unavailableById["document.import"].unavailableReason, "Wait for the Atlas canvas to finish loading.")
  assert.equal(unavailableById["document.note.create"].unavailableReason, "Wait for the Atlas canvas to finish loading.")
  assert.equal(unavailableById["eln.experiment.create"].unavailableReason, "Open the live Atlas to create a research record.")
  assert.equal(unavailableById["frame.create.open"].unavailableReason, "Create or open a durable Atlas canvas before editing frames.")
  assert.equal(unavailableById["frame.remove"].unavailableReason, "Select a frame first.")
  assert.equal(unavailableById["ham.memory.search.open"].unavailableReason, "Open the signed-in Atlas to search HAM memory.")
  assert.equal(unavailableById["ink.draw.open"].unavailableReason, "Wait for the Atlas canvas to finish loading.")
  assert.equal(unavailableById["legacy.flow.portability.open"].unavailableReason, null)
  assert.equal(unavailableById["paper.import"].unavailableReason, "Wait for the Atlas canvas to finish loading.")
  assert.equal(unavailableById["placement.remove"].unavailableReason, "Select a placement first.")
  assert.equal(unavailableById["proof.package.import"].unavailableReason, "Create or open a durable Atlas canvas before importing a formal project.")
  assert.equal(unavailableById["proof.registry.open"].unavailableReason, "Open the signed-in Atlas to browse proof graphs.")
  assert.equal(unavailableById["reference.place"].unavailableReason, "Wait for the Atlas canvas to finish loading.")
  assert.equal(unavailableById["relations.review.open"].unavailableReason, "Open the signed-in Atlas to review relation proposals.")
  assert.equal(unavailableById["share.canvas.create"].unavailableReason, "Wait for an exact durable Atlas revision.")
  assert.equal(unavailableById["share.canvas-conversation.create"].unavailableReason, "Select one exact conversation placement on a durable Atlas.")
  assert.equal(unavailableById["share.selection.create"].unavailableReason, "Select an object with an exact resolved revision.")
  assert.equal(unavailableById["surface.place.open"].unavailableReason, "Wait for the Atlas canvas to finish loading.")
  assert.equal(unavailableById["task.plan.open"].unavailableReason, "Select a task placement first.")
  assert.equal(unavailableById["voice.capture.open"].unavailableReason, "Wait for the Atlas canvas to finish loading.")
  assert.equal(unavailableById["web.capture.open"].unavailableReason, "Wait for the Atlas canvas to finish loading.")
  const availableById = Object.fromEntries(available.map((command) => [command.id, command]))
  assert.deepEqual(
    available
      .filter((command) => command.hudGroup === "create")
      .map(({ id, title }) => ({ id, title })),
    [
      { id: "canvas.create.open", title: "New canvas" },
      { id: "code.editor.open", title: "New code file" },
      { id: "document.import", title: "Import document" },
      { id: "document.note.create", title: "New Markdown note" },
      { id: "eln.experiment.create", title: "New research record" },
      { id: "frame.create.open", title: "New frame" },
      { id: "ink.draw.open", title: "New ink note" },
      { id: "paper.import", title: "Find arXiv paper" },
      { id: "web.capture.open", title: "Capture web content" },
    ],
  )
  assert.equal(
    available.filter((command) => command.hudGroup !== null && command.hudGroup !== "create").length,
    0,
  )
  assert.equal(
    unavailable.filter((command) => command.hudGroup === "create" && command.enabled).length,
    0,
  )
  for (const command of available) {
    const manifest = builtinPluginRegistry.getPlugin(command.pluginId)?.manifest
    assert.ok(manifest)
    assert.equal(Object.isFrozen(command), true)
    assert.equal(Object.isFrozen(command.plugin), true)
    assert.deepEqual(Object.keys(command.plugin).sort(), ["displayName", "id", "version"])
    assert.deepEqual(command.plugin, {
      id: command.pluginId,
      displayName: manifest.displayName,
      version: manifest.version,
    })
    assert.ok(manifest.contributes.commands.includes(command.id))
  }
  assert.deepEqual(availableById["ham.memory.search.open"].plugin, {
    id: "ham",
    displayName: "HAM",
    version: "1.0.0",
  })
  assert.match(
    getAtlasCommandSearchValue(unavailableById["placement.remove"]),
    /Remove from Atlas[\s\S]*atlas[\s\S]*Atlas[\s\S]*v1\.0\.0[\s\S]*Unavailable Select a placement first\./,
  )
  assert.equal(availableById["datasource.manage.open"].enabled, true)
  assert.equal(availableById["canvas.create.open"].enabled, true)
  assert.equal(availableById["ham.memory.search.open"].implementationId, "builtin.ham.memory-search.open")
  assert.equal(availableById["legacy.flow.portability.open"].enabled, true)
  assert.equal(availableById["paper.import"].implementationId, "builtin.paper.import")
  assert.equal(availableById["proof.package.import"].enabled, true)
  assert.equal(availableById["proof.registry.open"].implementationId, "builtin.proof.registry.open")
  assert.equal(availableById["relations.review.open"].enabled, true)
  assert.equal(availableById["task.plan.open"].implementationId, "builtin.task.plan.open")
  assert.equal(availableById["voice.capture.open"].enabled, true)
  assert.equal(availableById["web.capture.open"].implementationId, "builtin.web.capture.open")
  assert.equal(resolveAtlasCommand("unknown"), null)
})

test("canvas creation command opens only the static named-canvas presenter", () => {
  const result = dispatchAtlasCommand("canvas.create.open", {})
  assert.deepEqual(result, { ok: true, effect: { kind: "open-canvas-create" } })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.effect), true)
  assert.deepEqual(dispatchAtlasCommand("canvas.create.open", { makeDefault: true }), {
    ok: false,
    code: "invalid_input",
  })
})

test("frame commands expose only bounded human presentation effects", () => {
  assert.deepEqual(dispatchAtlasCommand("frame.create.open", {}), {
    ok: true,
    effect: { kind: "open-frame-create" },
  })
  assert.deepEqual(dispatchAtlasCommand("frame.remove", { frameId: "sources", title: "Sources" }), {
    ok: true,
    effect: { kind: "confirm-frame-remove", frameId: "sources", title: "Sources" },
  })
  assert.deepEqual(dispatchAtlasCommand("frame.remove", { frameId: "bad id", title: "Sources" }), {
    ok: false,
    code: "invalid_frame_id",
  })
})

test("HAM memory command opens only the static search surface", () => {
  const result = dispatchAtlasCommand("ham.memory.search.open", {})
  assert.deepEqual(result, { ok: true, effect: { kind: "open-ham-memory-search" } })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.effect), true)
  assert.deepEqual(dispatchAtlasCommand("ham.memory.search.open", { query: "injected" }), {
    ok: false,
    code: "invalid_input",
  })
})

test("voice capture command opens only the review-first voice surface", () => {
  const result = dispatchAtlasCommand("voice.capture.open", {})
  assert.deepEqual(result, { ok: true, effect: { kind: "open-voice-capture" } })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.effect), true)
  assert.deepEqual(dispatchAtlasCommand("voice.capture.open", { execute: true }), {
    ok: false,
    code: "invalid_input",
  })
})

test("ink command opens only the bounded drawing surface", () => {
  const result = dispatchAtlasCommand("ink.draw.open", {})
  assert.deepEqual(result, { ok: true, effect: { kind: "open-ink-drawing" } })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.effect), true)
  assert.deepEqual(dispatchAtlasCommand("ink.draw.open", { svg: "<svg/>" }), {
    ok: false,
    code: "invalid_input",
  })
})

test("code editor command opens only the code-owned, non-executing editor surface", () => {
  const result = dispatchAtlasCommand("code.editor.open", {})
  assert.deepEqual(result, { ok: true, effect: { kind: "open-code-editor" } })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.effect), true)
  assert.deepEqual(dispatchAtlasCommand("code.editor.open", { code: "alert(1)" }), {
    ok: false,
    code: "invalid_input",
  })
})

test("code graph import command opens only the closed exact-JSON review presenter", () => {
  const result = dispatchAtlasCommand("code.graph.snapshot.import", {})
  assert.deepEqual(result, { ok: true, effect: { kind: "open-code-graph-snapshot-import" } })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.effect), true)
  for (const input of [
    { url: "https://example.test/snapshot.json" },
    { query: "MATCH (n) DELETE n" },
    { destination: "foreign-canvas" },
  ]) {
    assert.deepEqual(dispatchAtlasCommand("code.graph.snapshot.import", input), {
      ok: false,
      code: "invalid_input",
    })
  }

  const atFrameCap = Object.fromEntries(listAtlasCommands({
    hasSelectedFrame: true,
    canPlaceReference: true,
    canRemoveFrame: true,
    canMutateFrames: true,
    canCreateFrame: false,
    frameCreateUnavailableReason: "This Atlas already has the maximum 100 presentation frames.",
  }).map((command) => [command.id, command]))
  assert.equal(atFrameCap["frame.create.open"].enabled, false)
  assert.equal(atFrameCap["frame.create.open"].unavailableReason, "This Atlas already has the maximum 100 presentation frames.")
  assert.equal(atFrameCap["frame.remove"].enabled, true)
})

test("ELN command opens only the code-owned experiment workflow", () => {
  const result = dispatchAtlasCommand("eln.experiment.create", {})
  assert.deepEqual(result, { ok: true, effect: { kind: "open-eln-experiment-create" } })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.effect), true)
  assert.deepEqual(dispatchAtlasCommand("eln.experiment.create", { title: "Injected" }), {
    ok: false,
    code: "invalid_input",
  })
})

test("document import command opens only the code-owned import surface", () => {
  const result = dispatchAtlasCommand("document.import", {})
  assert.deepEqual(result, { ok: true, effect: { kind: "open-document-import" } })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.effect), true)
  assert.deepEqual(dispatchAtlasCommand("document.import", { url: "https://example.test/paper.pdf" }), {
    ok: false,
    code: "invalid_input",
  })
})

test("Markdown note command opens only the closed Documents-owned editor preset", () => {
  const result = dispatchAtlasCommand("document.note.create", {})
  assert.deepEqual(result, { ok: true, effect: { kind: "open-markdown-note" } })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.effect), true)
  for (const input of [
    { content: "# injected" },
    { mediaType: "text/html" },
    { destination: "foreign-canvas" },
    { execute: true },
  ]) {
    assert.deepEqual(dispatchAtlasCommand("document.note.create", input), {
      ok: false,
      code: "invalid_input",
    })
  }
})

test("web capture command opens only the code-owned caller-supplied capture surface", () => {
  const result = dispatchAtlasCommand("web.capture.open", {})
  assert.deepEqual(result, { ok: true, effect: { kind: "open-web-capture" } })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.effect), true)
  assert.deepEqual(dispatchAtlasCommand("web.capture.open", { url: "https://example.test" }), {
    ok: false,
    code: "invalid_input",
  })
})

test("paper import command opens only the Papers-owned exact arXiv surface", () => {
  const result = dispatchAtlasCommand("paper.import", {})
  assert.deepEqual(result, { ok: true, effect: { kind: "open-paper-import" } })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.effect), true)
  assert.deepEqual(dispatchAtlasCommand("paper.import", { pdfUrl: "https://example.test/paper.pdf" }), {
    ok: false,
    code: "invalid_input",
  })
})

test("legacy portability command opens only the local review surface", () => {
  const result = dispatchAtlasCommand("legacy.flow.portability.open", {})
  assert.deepEqual(result, { ok: true, effect: { kind: "open-legacy-flow-portability" } })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.effect), true)
  assert.deepEqual(dispatchAtlasCommand("legacy.flow.portability.open", { upload: true }), {
    ok: false,
    code: "invalid_input",
  })
})

test("proof registry command opens only the Tasks-owned exact graph browser", () => {
  const result = dispatchAtlasCommand("proof.registry.open", {})
  assert.deepEqual(result, { ok: true, effect: { kind: "open-proof-registry" } })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.effect), true)
  assert.deepEqual(dispatchAtlasCommand("proof.registry.open", { graph: "injected" }), {
    ok: false,
    code: "invalid_input",
  })
})

test("datasource command opens only the code-owned connector manager", () => {
  const result = dispatchAtlasCommand("datasource.manage.open", {})
  assert.deepEqual(result, { ok: true, effect: { kind: "open-datasource-manager" } })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.effect), true)
  assert.deepEqual(dispatchAtlasCommand("datasource.manage.open", { rootPath: "C:\\" }), {
    ok: false,
    code: "invalid_input",
  })
})

test("reference placement command accepts only exact empty input", () => {
  const result = dispatchAtlasCommand("reference.place", {})
  assert.deepEqual(result, { ok: true, effect: { kind: "open-reference-place" } })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.effect), true)
  assert.deepEqual(dispatchAtlasCommand("reference.place", { subjectRef: "anything" }), {
    ok: false,
    code: "invalid_input",
  })
})

test("promoted surface placement command opens only the code-owned picker", () => {
  const result = dispatchAtlasCommand("surface.place.open", {})
  assert.deepEqual(result, { ok: true, effect: { kind: "open-surface-place" } })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.effect), true)
  assert.deepEqual(dispatchAtlasCommand("surface.place.open", { surfaceId: "draft" }), {
    ok: false,
    code: "invalid_input",
  })
})

test("placement removal command preserves exact canonical placement identity", () => {
  const subjectRef = createGalaxyObjectReference("document", "document-123")
  const result = dispatchAtlasCommand("placement.remove", {
    placementId: "reference-1234",
    subjectRef,
  })
  assert.deepEqual(result, {
    ok: true,
    effect: {
      kind: "confirm-placement-remove",
      placementId: "reference-1234",
      subjectRef,
    },
  })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.effect), true)
  assert.deepEqual(dispatchAtlasCommand("placement.remove", { placementId: "bad id", subjectRef }), {
    ok: false,
    code: "invalid_placement_id",
  })
  assert.deepEqual(dispatchAtlasCommand("placement.remove", {
    placementId: "reference-1234",
    subjectRef: " gb:object:v1:document:document-123:latest",
  }), { ok: false, code: "invalid_subject_ref" })
  assert.deepEqual(dispatchAtlasCommand("placement.remove", {
    placementId: "reference-1234",
    subjectRef,
    deleteCanonicalObject: true,
  }), { ok: false, code: "invalid_input" })
})

test("task command dispatch is deterministic, frozen, and preserves revision selection", () => {
  const latest = createGalaxyObjectReference("ham.task", "task-123")
  const pinned = createGalaxyObjectReference("ham.task", "task-123", { mode: "pinned", revision: "v7" })

  const first = dispatchAtlasCommand("task.plan.open", { subjectRef: latest })
  const second = dispatchAtlasCommand("task.plan.open", { subjectRef: latest })
  const pinnedResult = dispatchAtlasCommand("task.plan.open", { subjectRef: pinned })

  assert.deepEqual(first, second)
  assert.equal(first.ok, true)
  assert.equal(first.effect.taskId, "task-123")
  assert.equal(first.effect.revision, null)
  assert.equal(pinnedResult.ok, true)
  assert.equal(pinnedResult.effect.subjectRef, pinned)
  assert.equal(pinnedResult.effect.revision, "v7")
  assert.equal(Object.isFrozen(first), true)
  assert.equal(Object.isFrozen(first.effect), true)
})

test("task command dispatch fails closed for unregistered, non-task, legacy, and expanded input", () => {
  const taskRef = createGalaxyObjectReference("ham.task", "task-123")
  const paperRef = createGalaxyObjectReference("paper", "paper-123")

  assert.deepEqual(dispatchAtlasCommand("unknown", { subjectRef: taskRef }), {
    ok: false,
    code: "unknown_command",
  })
  assert.deepEqual(dispatchAtlasCommand("task.plan.open", { subjectRef: paperRef }), {
    ok: false,
    code: "invalid_subject_ref",
  })
  assert.deepEqual(dispatchAtlasCommand("task.plan.open", { subjectRef: "gb:node:legacy" }), {
    ok: false,
    code: "invalid_subject_ref",
  })
  assert.deepEqual(dispatchAtlasCommand("task.plan.open", { subjectRef: taskRef, implementationId: "evil.run" }), {
    ok: false,
    code: "invalid_input",
  })
  assert.deepEqual(dispatchAtlasCommand("task.plan.open", { subjectRef: "x".repeat(4097) }), {
    ok: false,
    code: "invalid_subject_ref",
  })
})

test("Atlas command execution contains no dynamic code or network path", async () => {
  const source = await readFile(new URL("../lib/plugins/atlas-commands.js", import.meta.url), "utf8")
  assert.doesNotMatch(source, /\bfetch\s*\(|\bimport\s*\(|\beval\s*\(|new Function|window\[|globalThis\[/)
})
