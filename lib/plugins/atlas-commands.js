import { builtinPluginRegistry } from "./builtins.js"
import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "../galaxy-object-reference.js"
import {
  inspectAtlasCanvasConversationShare,
  inspectAtlasCanvasShare,
  inspectAtlasObjectShareReference,
} from "../atlas-share.js"

const COMMAND_DEFINITIONS = Object.freeze({
  "builtin.canvas.create.open": Object.freeze({
    title: "New canvas",
    description: "Create a named spatial view in the current workspace without replacing its default canvas.",
    hudGroup: "create",
    requiresCanvasCreate: true,
  }),
  "builtin.code.editor.open": Object.freeze({
    title: "New code file",
    description: "Author UTF-8 source, preserve its exact bytes, and place the immutable revision on this Atlas.",
    hudGroup: "create",
    requiresAtlas: true,
  }),
  "builtin.code.graph.snapshot.import": Object.freeze({
    title: "Import code graph snapshot",
    description: "Review and preserve one exact Codebase Memory JSON snapshot, then place its pinned document on this Atlas.",
    requiresAtlas: true,
  }),
  "builtin.document.import": Object.freeze({
    title: "Import document",
    description: "Store exact file bytes, then place the immutable document revision on this Atlas.",
    hudGroup: "create",
    requiresAtlas: true,
  }),
  "builtin.document.note.create": Object.freeze({
    title: "New Markdown note",
    description: "Author exact Markdown with math, preserve it through the Documents plan, and place its pinned revision on this Atlas.",
    hudGroup: "create",
    requiresAtlas: true,
  }),
  "builtin.datasource.manage.open": Object.freeze({
    title: "Research datasources",
    description: "Connect, explicitly scan, browse, and durably import files from authorized server-owned sources.",
    requiresAtlas: true,
  }),
  "builtin.eln.experiment.create": Object.freeze({
    title: "New research record",
    description: "Open the canonical electronic lab notebook workflow for a new experiment.",
    hudGroup: "create",
    requiresExperimentCreate: true,
  }),
  "builtin.frame.create.open": Object.freeze({
    title: "New frame",
    description: "Add a presentation-only frame to organize this Atlas without changing object or relation authority.",
    hudGroup: "create",
    requiresAtlas: true,
    requiresFrameMutation: true,
    requiresFrameCreate: true,
  }),
  "builtin.frame.remove": Object.freeze({
    title: "Remove frame",
    description: "Remove the selected presentation frame without changing enclosed objects or relations.",
    requiresSelectedFrame: true,
    requiresAtlas: true,
    requiresFrameMutation: true,
  }),
  "builtin.ink.draw.open": Object.freeze({
    title: "New ink note",
    description: "Draw a bounded note, preserve its exact stroke revision, and place it on this Atlas.",
    hudGroup: "create",
    requiresAtlas: true,
  }),
  "builtin.ham.memory-search.open": Object.freeze({
    title: "Search HAM memory",
    description: "Search authorized HAM memory and open its canonical immutable workspace.",
    requiresHamMemory: true,
  }),
  "builtin.legacy.flow.portability.open": Object.freeze({
    title: "Legacy flow portability",
    description: "Download or inspect a bounded local flow export in a detached Task Constructor preview.",
  }),
  "builtin.placement.remove": Object.freeze({
    title: "Remove from Atlas",
    description: "Remove the selected placement without deleting its canonical object.",
    requiresSelectedPlacement: true,
    requiresAtlas: true,
  }),
  "builtin.paper.import": Object.freeze({
    title: "Find arXiv paper",
    description: "Import exact versioned metadata, privately preserve the exact PDF, and place its pinned document on this Atlas.",
    hudGroup: "create",
    requiresAtlas: true,
  }),
  "builtin.proof.package.import": Object.freeze({
    title: "Import formal project",
    description: "Register an immutable Rosetta package and place its exact passive proof graph on this Atlas.",
    requiresAtlas: true,
    requiresFormalPackageImport: true,
  }),
  "builtin.proof.registry.open": Object.freeze({
    title: "Browse proof graphs",
    description: "Open the Tasks-owned registry for exact proof graphs and their separately authorized work overlays.",
    requiresProofRegistry: true,
  }),
  "builtin.reference.place": Object.freeze({
    title: "Place reference",
    description: "Place an exact canonical gb:object:v1 reference on this Atlas.",
    requiresSelectedTask: false,
    requiresAtlas: true,
  }),
  "builtin.relations.review.open": Object.freeze({
    title: "Review proposed relations",
    description: "Accept or reject exact agent relation proposals through the human-authored control plane.",
    requiresRelationReview: true,
  }),
  "builtin.share.canvas.create": Object.freeze({
    title: "Share saved Atlas",
    description: "Create an immutable canvas-only link for signed-in members of this Galaxy tenant.",
    requiresCanvasShare: true,
  }),
  "builtin.share.selection.create": Object.freeze({
    title: "Share selected object",
    description: "Create an immutable object-only link without sharing a conversation transcript.",
    requiresSelectionShare: true,
  }),
  "builtin.surface.place.open": Object.freeze({
    title: "Place promoted Generous surface",
    description: "Choose a reviewed Generous surface and place its immutable promoted revision on this Atlas.",
    requiresAtlas: true,
  }),
  "builtin.task.plan.open": Object.freeze({
    title: "Open task constructor",
    description: "Build and version an atomic job plan for the selected HAM task.",
    requiresSelectedTask: true,
  }),
  "builtin.voice.capture.open": Object.freeze({
    title: "Voice note",
    description: "Dictate or type a transcript, review it, then preserve and place the exact text on this Atlas.",
    requiresAtlas: true,
  }),
  "builtin.share.canvas-conversation.create": Object.freeze({
    title: "Share Atlas + conversation",
    description: "Review and create one immutable tenant-scoped bundle of this saved Atlas and its selected exact conversation.",
    requiresCanvasConversationShare: true,
  }),
  "builtin.web.capture.open": Object.freeze({
    title: "Capture web content",
    description: "Preserve caller-supplied page bytes with their provenance URL, then place the pinned document on this Atlas.",
    hudGroup: "create",
    requiresAtlas: true,
  }),
})

export function listAtlasCommands({
  hasSelectedTask = false,
  hasSelectedPlacement = false,
  hasSelectedFrame = false,
  canPlaceReference = false,
  canRemovePlacement = false,
  canRemoveFrame = false,
  canMutateFrames = false,
  canCreateFrame = false,
  frameCreateUnavailableReason = "Create or open a durable Atlas canvas before editing frames.",
  canCreateExperiment = false,
  canShareCanvas = false,
  canShareCanvasConversation = false,
  canShareSelection = false,
  canvasShareUnavailableReason = "Wait for an exact durable Atlas revision.",
  canvasConversationShareUnavailableReason = "Select one exact conversation placement on a durable Atlas.",
  selectionShareUnavailableReason = "Select an object with an exact resolved revision.",
  shareBusy = false,
  canSearchHam = false,
  canImportFormalPackage = false,
  canOpenProofRegistry = false,
  canReviewRelations = false,
  canCreateCanvas = false,
  canvasCreateUnavailableReason = "Wait for the current Atlas work to finish.",
} = {}) {
  return builtinPluginRegistry.listContributions("commands").flatMap((registration) => {
    const definition = COMMAND_DEFINITIONS[registration.handler.implementationId]
    if (!definition) return []
    const registeredPlugin = builtinPluginRegistry.getPlugin(registration.pluginId)
    if (
      !registeredPlugin
      || registeredPlugin.manifest.id !== registration.pluginId
      || !registeredPlugin.manifest.contributes.commands.includes(registration.id)
    ) return []
    const plugin = Object.freeze({
      id: registeredPlugin.manifest.id,
      displayName: registeredPlugin.manifest.displayName,
      version: registeredPlugin.manifest.version,
    })
    const enabled = (
      (!definition.requiresSelectedTask || hasSelectedTask)
      && (!definition.requiresSelectedPlacement || hasSelectedPlacement)
      && (!definition.requiresSelectedFrame || hasSelectedFrame)
      && (!definition.requiresAtlas || canPlaceReference)
      && (!definition.requiresExperimentCreate || canCreateExperiment)
      && (!definition.requiresCanvasShare || (canShareCanvas && !shareBusy))
      && (!definition.requiresCanvasConversationShare || (canShareCanvasConversation && !shareBusy))
      && (!definition.requiresSelectionShare || (canShareSelection && !shareBusy))
      && (!definition.requiresHamMemory || canSearchHam)
      && (!definition.requiresFormalPackageImport || canImportFormalPackage)
      && (!definition.requiresProofRegistry || canOpenProofRegistry)
      && (!definition.requiresRelationReview || canReviewRelations)
      && (!definition.requiresCanvasCreate || canCreateCanvas)
      && (!definition.requiresFrameMutation || canMutateFrames)
      && (!definition.requiresFrameCreate || canCreateFrame)
      && (registration.handler.implementationId !== "builtin.placement.remove" || canRemovePlacement)
      && (registration.handler.implementationId !== "builtin.frame.remove" || canRemoveFrame)
    )
    return [Object.freeze({
      id: registration.id,
      pluginId: registration.pluginId,
      plugin,
      implementationId: registration.handler.implementationId,
      title: definition.title,
      description: definition.description,
      hudGroup: definition.hudGroup ?? null,
      enabled,
      unavailableReason: enabled
        ? null
        : definition.requiresSelectedPlacement && !hasSelectedPlacement
          ? "Select a placement first."
          : definition.requiresSelectedFrame && !hasSelectedFrame
            ? "Select a frame first."
          : definition.requiresExperimentCreate
            ? "Open the live Atlas to create a research record."
          : (definition.requiresCanvasShare || definition.requiresCanvasConversationShare || definition.requiresSelectionShare) && shareBusy
            ? "Wait for the current share link to finish."
          : definition.requiresCanvasShare
            ? canvasShareUnavailableReason
          : definition.requiresCanvasConversationShare
            ? canvasConversationShareUnavailableReason
          : definition.requiresSelectionShare
            ? selectionShareUnavailableReason
          : definition.requiresFormalPackageImport && !canImportFormalPackage
            ? "Create or open a durable Atlas canvas before importing a formal project."
          : definition.requiresProofRegistry
            ? "Open the signed-in Atlas to browse proof graphs."
          : definition.requiresRelationReview
            ? "Open the signed-in Atlas to review relation proposals."
          : definition.requiresCanvasCreate
            ? canvasCreateUnavailableReason
          : definition.requiresFrameCreate && !canCreateFrame
            ? frameCreateUnavailableReason
          : definition.requiresFrameMutation
            ? "Create or open a durable Atlas canvas before editing frames."
          : definition.requiresAtlas
            ? "Wait for the Atlas canvas to finish loading."
          : definition.requiresHamMemory
            ? "Open the signed-in Atlas to search HAM memory."
          : "Select a task placement first.",
    })]
  })
}

export function getAtlasCommandSearchValue(command) {
  return [
    command.title,
    command.description,
    command.id,
    command.plugin.id,
    command.plugin.displayName,
    `v${command.plugin.version}`,
    command.unavailableReason ? `Unavailable ${command.unavailableReason}` : "",
  ].join(" ")
}

export function resolveAtlasCommand(commandId) {
  const registration = builtinPluginRegistry.resolve("commands", commandId)
  if (!registration) return null
  const definition = COMMAND_DEFINITIONS[registration.handler.implementationId]
  if (!definition) return null
  return Object.freeze({
    id: registration.id,
    pluginId: registration.pluginId,
    implementationId: registration.handler.implementationId,
  })
}

function failure(code) {
  return Object.freeze({ ok: false, code })
}

export function dispatchAtlasCommand(commandId, input) {
  const registration = resolveAtlasCommand(commandId)
  if (!registration) return failure("unknown_command")
  if (!input || typeof input !== "object" || Array.isArray(input)) return failure("invalid_input")
  if (registration.implementationId === "builtin.canvas.create.open") {
    if (Object.keys(input).length !== 0) return failure("invalid_input")
    return Object.freeze({
      ok: true,
      effect: Object.freeze({ kind: "open-canvas-create" }),
    })
  }
  if (registration.implementationId === "builtin.frame.create.open") {
    if (Object.keys(input).length !== 0) return failure("invalid_input")
    return Object.freeze({ ok: true, effect: Object.freeze({ kind: "open-frame-create" }) })
  }
  if (registration.implementationId === "builtin.document.import") {
    if (Object.keys(input).length !== 0) return failure("invalid_input")
    return Object.freeze({
      ok: true,
      effect: Object.freeze({ kind: "open-document-import" }),
    })
  }
  if (registration.implementationId === "builtin.document.note.create") {
    if (Object.keys(input).length !== 0) return failure("invalid_input")
    return Object.freeze({
      ok: true,
      effect: Object.freeze({ kind: "open-markdown-note" }),
    })
  }
  if (registration.implementationId === "builtin.legacy.flow.portability.open") {
    if (Object.keys(input).length !== 0) return failure("invalid_input")
    return Object.freeze({
      ok: true,
      effect: Object.freeze({ kind: "open-legacy-flow-portability" }),
    })
  }
  if (registration.implementationId === "builtin.datasource.manage.open") {
    if (Object.keys(input).length !== 0) return failure("invalid_input")
    return Object.freeze({
      ok: true,
      effect: Object.freeze({ kind: "open-datasource-manager" }),
    })
  }
  if (registration.implementationId === "builtin.code.editor.open") {
    if (Object.keys(input).length !== 0) return failure("invalid_input")
    return Object.freeze({
      ok: true,
      effect: Object.freeze({ kind: "open-code-editor" }),
    })
  }
  if (registration.implementationId === "builtin.code.graph.snapshot.import") {
    if (Object.keys(input).length !== 0) return failure("invalid_input")
    return Object.freeze({
      ok: true,
      effect: Object.freeze({ kind: "open-code-graph-snapshot-import" }),
    })
  }
  if (registration.implementationId === "builtin.eln.experiment.create") {
    if (Object.keys(input).length !== 0) return failure("invalid_input")
    return Object.freeze({
      ok: true,
      effect: Object.freeze({ kind: "open-eln-experiment-create" }),
    })
  }
  if (registration.implementationId === "builtin.ink.draw.open") {
    if (Object.keys(input).length !== 0) return failure("invalid_input")
    return Object.freeze({
      ok: true,
      effect: Object.freeze({ kind: "open-ink-drawing" }),
    })
  }
  if (registration.implementationId === "builtin.ham.memory-search.open") {
    if (Object.keys(input).length !== 0) return failure("invalid_input")
    return Object.freeze({
      ok: true,
      effect: Object.freeze({ kind: "open-ham-memory-search" }),
    })
  }
  if (registration.implementationId === "builtin.voice.capture.open") {
    if (Object.keys(input).length !== 0) return failure("invalid_input")
    return Object.freeze({
      ok: true,
      effect: Object.freeze({ kind: "open-voice-capture" }),
    })
  }
  if (registration.implementationId === "builtin.reference.place") {
    if (Object.keys(input).length !== 0) return failure("invalid_input")
    return Object.freeze({
      ok: true,
      effect: Object.freeze({ kind: "open-reference-place" }),
    })
  }
  if (registration.implementationId === "builtin.web.capture.open") {
    if (Object.keys(input).length !== 0) return failure("invalid_input")
    return Object.freeze({
      ok: true,
      effect: Object.freeze({ kind: "open-web-capture" }),
    })
  }
  if (registration.implementationId === "builtin.paper.import") {
    if (Object.keys(input).length !== 0) return failure("invalid_input")
    return Object.freeze({
      ok: true,
      effect: Object.freeze({ kind: "open-paper-import" }),
    })
  }
  if (registration.implementationId === "builtin.proof.package.import") {
    if (Object.keys(input).length !== 0) return failure("invalid_input")
    return Object.freeze({
      ok: true,
      effect: Object.freeze({ kind: "open-proof-package-import" }),
    })
  }
  if (registration.implementationId === "builtin.proof.registry.open") {
    if (Object.keys(input).length !== 0) return failure("invalid_input")
    return Object.freeze({
      ok: true,
      effect: Object.freeze({ kind: "open-proof-registry" }),
    })
  }
  if (registration.implementationId === "builtin.relations.review.open") {
    if (Object.keys(input).length !== 0) return failure("invalid_input")
    return Object.freeze({
      ok: true,
      effect: Object.freeze({ kind: "open-relation-proposal-review" }),
    })
  }
  if (registration.implementationId === "builtin.surface.place.open") {
    if (Object.keys(input).length !== 0) return failure("invalid_input")
    return Object.freeze({
      ok: true,
      effect: Object.freeze({ kind: "open-surface-place" }),
    })
  }
  if (registration.implementationId === "builtin.share.selection.create") {
    const keys = Object.keys(input)
    if (keys.length !== 1 || keys[0] !== "objectRef") return failure("invalid_input")
    const inspected = inspectAtlasObjectShareReference(input.objectRef)
    if (!inspected.ok) return failure(inspected.code)
    return Object.freeze({
      ok: true,
      effect: Object.freeze({ kind: "create-object-share", selector: inspected.selector }),
    })
  }
  if (registration.implementationId === "builtin.share.canvas.create") {
    const keys = Object.keys(input).sort()
    if (
      keys.length !== 3
      || keys[0] !== "canvasId"
      || keys[1] !== "contentHash"
      || keys[2] !== "version"
    ) return failure("invalid_input")
    const inspected = inspectAtlasCanvasShare({ ...input, content: { items: [], edges: [] } })
    if (!inspected.ok) return failure(inspected.code)
    return Object.freeze({
      ok: true,
      effect: Object.freeze({ kind: "create-canvas-share", selector: inspected.selector }),
    })
  }
  if (registration.implementationId === "builtin.share.canvas-conversation.create") {
    const keys = Object.keys(input).sort()
    if (
      keys.length !== 4
      || keys[0] !== "canvasId"
      || keys[1] !== "contentHash"
      || keys[2] !== "conversationRef"
      || keys[3] !== "version"
    ) return failure("invalid_input")
    const inspected = inspectAtlasCanvasConversationShare(
      { ...input, content: { items: [{ subjectRef: input.conversationRef }], edges: [] } },
      input.conversationRef,
    )
    if (!inspected.ok) return failure(inspected.code)
    return Object.freeze({
      ok: true,
      effect: Object.freeze({ kind: "confirm-canvas-conversation-share", selector: inspected.selector }),
    })
  }
  if (registration.implementationId === "builtin.placement.remove") {
    const keys = Object.keys(input).sort()
    if (keys.length !== 2 || keys[0] !== "placementId" || keys[1] !== "subjectRef") {
      return failure("invalid_input")
    }
    if (
      typeof input.placementId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.placementId)
    ) return failure("invalid_placement_id")
    if (typeof input.subjectRef !== "string" || input.subjectRef.length > 4096) {
      return failure("invalid_subject_ref")
    }
    const reference = parseGalaxyObjectReference(input.subjectRef)
    if (!reference || reference.format !== "canonical") return failure("invalid_subject_ref")
    let canonical
    try {
      canonical = serializeGalaxyObjectReference(reference)
    } catch {
      return failure("invalid_subject_ref")
    }
    if (canonical !== input.subjectRef) return failure("invalid_subject_ref")
    return Object.freeze({
      ok: true,
      effect: Object.freeze({
        kind: "confirm-placement-remove",
        placementId: input.placementId,
        subjectRef: canonical,
      }),
    })
  }
  if (registration.implementationId === "builtin.frame.remove") {
    const keys = Object.keys(input).sort()
    if (keys.length !== 2 || keys[0] !== "frameId" || keys[1] !== "title") return failure("invalid_input")
    if (typeof input.frameId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.frameId)) {
      return failure("invalid_frame_id")
    }
    if (typeof input.title !== "string" || input.title.trim() !== input.title || !input.title || input.title.length > 120) {
      return failure("invalid_input")
    }
    return Object.freeze({
      ok: true,
      effect: Object.freeze({ kind: "confirm-frame-remove", frameId: input.frameId, title: input.title }),
    })
  }
  if (registration.implementationId !== "builtin.task.plan.open") {
    return failure("unsupported_implementation")
  }
  const keys = Object.keys(input)
  if (keys.length !== 1 || keys[0] !== "subjectRef") return failure("invalid_input")
  if (typeof input.subjectRef !== "string" || input.subjectRef.length > 4096) {
    return failure("invalid_subject_ref")
  }
  const reference = parseGalaxyObjectReference(input.subjectRef)
  if (reference?.format !== "canonical" || reference.kind !== "ham.task") {
    return failure("invalid_subject_ref")
  }
  return Object.freeze({
    ok: true,
    effect: Object.freeze({
      kind: "open-task-plan",
      subjectRef: serializeGalaxyObjectReference(reference),
      taskId: reference.id,
      revision: reference.selector.mode === "pinned" ? reference.selector.revision : null,
    }),
  })
}
