export type AtlasCommand = {
  id: string
  pluginId: string
  plugin: Readonly<{
    id: string
    displayName: string
    version: string
  }>
  implementationId: string
  title: string
  description: string
  hudGroup: "create" | null
  enabled: boolean
  unavailableReason: string | null
}

export function listAtlasCommands(context?: {
  hasSelectedTask?: boolean
  hasSelectedPlacement?: boolean
  hasSelectedFrame?: boolean
  canPlaceReference?: boolean
  canRemovePlacement?: boolean
  canRemoveFrame?: boolean
  canMutateFrames?: boolean
  canCreateFrame?: boolean
  frameCreateUnavailableReason?: string
  canCreateExperiment?: boolean
  canShareCanvas?: boolean
  canShareCanvasConversation?: boolean
  canShareSelection?: boolean
  canvasShareUnavailableReason?: string
  canvasConversationShareUnavailableReason?: string
  selectionShareUnavailableReason?: string
  shareBusy?: boolean
  canSearchHam?: boolean
  canImportFormalPackage?: boolean
  canOpenProofRegistry?: boolean
  canReviewRelations?: boolean
  canCreateCanvas?: boolean
  canvasCreateUnavailableReason?: string
}): AtlasCommand[]
export function getAtlasCommandSearchValue(command: AtlasCommand): string
export function resolveAtlasCommand(commandId: string): Pick<AtlasCommand, "id" | "pluginId" | "implementationId"> | null
export type AtlasCommandEffect =
  | { kind: "open-canvas-create" }
  | { kind: "open-frame-create" }
  | { kind: "open-document-import" }
  | { kind: "open-markdown-note" }
  | { kind: "open-datasource-manager" }
  | { kind: "open-code-editor" }
  | { kind: "open-code-graph-snapshot-import" }
  | { kind: "open-eln-experiment-create" }
  | { kind: "open-ink-drawing" }
  | { kind: "open-ham-memory-search" }
  | { kind: "open-legacy-flow-portability" }
  | { kind: "open-paper-import" }
  | { kind: "open-voice-capture" }
  | { kind: "open-web-capture" }
  | { kind: "open-reference-place" }
  | { kind: "open-proof-package-import" }
  | { kind: "open-proof-registry" }
  | { kind: "open-relation-proposal-review" }
  | { kind: "open-surface-place" }
  | {
      kind: "create-object-share"
      selector: Readonly<{ objectRef: string }>
    }
  | {
      kind: "create-canvas-share"
      selector: Readonly<{ canvasId: string; version: number; contentHash: string }>
    }
  | {
      kind: "confirm-canvas-conversation-share"
      selector: Readonly<{
        canvasId: string
        version: number
        contentHash: string
        conversationRef: string
      }>
    }
  | {
      kind: "confirm-placement-remove"
      placementId: string
      subjectRef: string
    }
  | { kind: "confirm-frame-remove"; frameId: string; title: string }
  | {
      kind: "open-task-plan"
      subjectRef: string
      taskId: string
      revision: string | null
    }
export type AtlasCommandDispatchResult =
  | { ok: true; effect: AtlasCommandEffect }
  | { ok: false; code: "unknown_command" | "invalid_input" | "invalid_placement_id" | "invalid_frame_id" | "invalid_subject_ref" | "unsupported_implementation" | "exact_reference_required" | "content_hash_required" | "conversation_excluded" | "invalid_canvas" | "exact_conversation_required" | "conversation_scope_ambiguous" }
export function dispatchAtlasCommand(commandId: string, input: unknown): AtlasCommandDispatchResult
