"use client"

import {
  asClientId,
  createCanvasStore,
  type CanvasStore,
  type CameraState,
  type Edge,
  type FrameStats,
  type Node,
  type NodeId,
  type Renderer,
  hitTestAny,
  nodeAABB,
  screenToWorld,
  worldToScreen,
  zoomAtScreenPoint,
} from "@canvas-harness/core"
import {
  Canvas,
  CanvasProvider,
  Minimap,
  useCamera,
  useCanvasStore,
  useIsMoving,
  useNode,
  useSelection,
} from "@canvas-harness/react"
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Command as CommandIcon,
  Link2,
  List,
  Mic,
  Minus,
  Network,
  Orbit,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  RotateCcw,
  Share2,
  Unlink,
  Wrench,
} from "lucide-react"
import { useSearchParams } from "next/navigation"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react"

import {
  GalaxyCanvasNodeView,
  UnavailableCanvasObject,
} from "@/components/canvas/galaxy-canvas-node"
import { AtlasCommandDeck } from "@/components/atlas/atlas-command-deck"
import { AtlasCanvasSwitcher } from "@/components/atlas/atlas-canvas-switcher"
import { AtlasCreateMenu } from "@/components/atlas/atlas-create-menu"
import {
  AtlasShareScopeDialog,
  type AtlasShareScope,
} from "@/components/atlas/atlas-share-scope-dialog"
import {
  AtlasCommandPresenterHost,
  type CodeGraphSnapshotImportPhase,
  type CodeGraphSnapshotImportRequest,
  type CodeEditorPreset,
  type CodeEditorSavePhase,
  type VoiceSavePhase,
  type VoiceSaveRequest,
} from "@/components/atlas/atlas-command-presenter-host"
import type { AtlasFrameDraft } from "@/components/atlas/atlas-frame-dialog"
import { AtlasHamMemoryBrowser } from "@/components/atlas/atlas-ham-memory-browser"
import { AtlasRelationComposeDialog } from "@/components/atlas/atlas-relation-compose-dialog"
import { RelationProposalReviewDialog } from "@/components/atlas/relation-proposal-review-dialog"
import {
  DocumentImportDialog,
  type DocumentImportPhase,
} from "@/components/atlas/document-import-dialog"
import {
  WebCaptureDialog,
  type AtlasWebCapturePhase,
} from "@/components/atlas/web-capture-dialog"
import { DatasourceManagerDialog } from "@/components/atlas/datasource-manager-dialog"
import {
  InkDrawingDialog,
  type InkDrawingPhase,
} from "@/components/atlas/ink-drawing-dialog"
import { InkPlacementPreview } from "@/components/atlas/ink-placement-preview"
import { PlacementRemoveDialog } from "@/components/atlas/placement-remove-dialog"
import { ReferencePlaceDialog } from "@/components/atlas/reference-place-dialog"
import {
  ReferenceHandoffDialog,
  type ReferenceHandoffPhase,
} from "@/components/atlas/reference-handoff-dialog"
import { FormalProjectPackageImportDialog } from "@/components/atlas/formal-project-package-import-dialog"
import { PromotedSurfacePlaceDialog } from "@/components/surfaces/promoted-surface-place-dialog"
import {
  ArxivPaperImportDialog,
  type ArxivPaperImportPhase,
} from "@/components/papers/arxiv-paper-import-dialog"
import { ObjectProjectionHost } from "@/components/projections/object-projection-host"
import { LegacyFlowPortabilityDialog } from "@/components/tasks/legacy-flow-portability-dialog"
import { ThemeToggle } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"
import { HudAction, HudDivider, HudLink, HudStatus, HudToolbar } from "@/components/ui/hud-toolbar"
import { safeNavigator, setBrowserTenantScope } from "@/lib/browser-utils"
import {
  authorizeAtlasDropImportTarget,
  ATLAS_DROP_INGESTION_PLAN_ID,
  atlasDropImportRegistered,
  AtlasDropImportError,
  atlasDropWorldPoint,
  commitAtlasDropCallbacks,
  createAtlasDropImportOwner,
  planAtlasDropImport,
  type AtlasDropCallbacks,
  type AtlasDropImportPlan,
} from "@/lib/atlas-drop-import.js"
import {
  createDocumentTransformClient,
  DocumentTransformClientError,
  type DocumentTransformResult,
} from "@/lib/document-transform-client.js"
import {
  applyAtlasHydrationAvailability,
  hydrateAtlasObjectReferences,
  type AtlasObjectHydrationResult,
} from "@/lib/atlas-object-hydration"
import {
  authorizeAtlasObjectDrop,
  createAtlasDropOperationLock,
  hasAtlasObjectDrag,
  parseAtlasObjectDrop,
  selectAtlasPendingDropRecovery,
  writeAtlasObjectDrag,
  type AtlasObjectDragIntent,
} from "@/lib/atlas-object-drop.js"
import { clearAtlasExactRepresentationCache } from "@/lib/atlas-exact-representation.js"
import { hydrateAtlasSurfaceSpecs } from "@/lib/atlas-surface-materialization.js"
import {
  authorizeAtlasReferenceHandoff,
  clearAtlasReferenceHandoffHref,
  parseAtlasReferenceHandoff,
} from "@/lib/atlas-reference-handoff.js"
import {
  listAtlasReferenceHandoffPlacementRecoveries,
  removeAtlasReferenceHandoffPlacementRecovery,
  writeAtlasReferenceHandoffPlacementRecovery,
  type AtlasReferenceHandoffPlacementRecovery,
} from "@/lib/atlas-reference-handoff-placement-recovery.js"
import { observeAtlasViewportVisibility } from "@/lib/atlas-viewport-visibility.js"
import {
  projectGalaxyCanvas,
  type GalaxyCanvasFrameData,
  type GalaxyCanvasNodeData,
  type GalaxyCanvasNodeType,
  type GalaxyCanvasPlacement,
  type GalaxyCanvasProjection,
  type GalaxyCanvasRelationData,
} from "@/lib/canvas/galaxy-canvas-adapter"
import {
  applyFrameGeometryOverrides,
  AtlasFrameMutationConflictError,
  AtlasFrameMutationTerminalError,
  clampAtlasFrameGeometry,
  canvasFrameFromInput,
  commandsForFrameGeometry,
  frameGeometryFromNode,
  prepareAtlasFrameMutationOperation,
  quarantineAtlasFrameMutationJournal,
  readPendingAtlasFrameMutation,
  reconcileAtlasFrameMutation,
  removePendingAtlasFrameMutation,
  writePendingAtlasFrameMutation,
  type AtlasFrameGeometry,
  type AtlasFrameMutationOperation,
  type AtlasFrameMutationScope,
} from "@/lib/canvas/atlas-frame"
import { cameraForAtlasNodes, panAtlasCamera, type AtlasCameraPanDirection } from "@/lib/canvas/atlas-camera"
import {
  resolveAtlasProjectedRelationEndpoint,
  resolveAtlasRuntimeRelationEndpoint,
  type AtlasRelationEndpointSide,
} from "@/lib/canvas/atlas-relation-navigation.js"
import {
  ATLAS_CONSTELLATION_ZOOM,
  deriveAtlasConstellationScene,
  initialAtlasConstellationLevel,
  nextAtlasConstellationLevel,
  type AtlasConstellationLevel,
  type AtlasSceneLevel,
} from "@/lib/canvas/atlas-constellation-lod"
import {
  atlasCanvasSwitchHasPendingWork,
  findAtlasCanvasSwitchTarget,
  normalizeAtlasCanvasCatalog,
  selectAtlasWorkspaceId,
} from "@/lib/canvas/atlas-canvas-catalog.js"
import { selectAtlasBaseProjection } from "@/lib/canvas/atlas-projection-mode.js"
import { ATLAS_CONSTELLATION_NODE_DEFINITION } from "@/lib/canvas/atlas-constellation-node-types"
import { atlasCanvasHref, parseAtlasLocation } from "@/lib/canvas/atlas-location.js"
import {
  buildAuthorizedCanvasProjection,
  projectAuthorizedHamRelationOverlay,
  projectAuthorizedObjectLinkRelations,
  selectAuthorizedHamRelationReferences,
  type AuthorizedCanvasSources,
  type AuthorizedObjectLink,
} from "@/lib/canvas/authorized-canvas-projection"
import { requestHamRelationOverlay } from "@/lib/ham-relation-overlay-client"
import {
  HAM_RELATION_OVERLAY_MAX_REFERENCES,
  type HamRelationOverlayResponse,
} from "@/lib/ham-relation-overlay-contract.js"
import {
  projectCanvasNodeObject,
  resolvedCanvasNodeRepresentation,
} from "@/lib/canvas/canvas-object-projection"
import {
  applyCanvasPlacementOverrides,
  canvasNodeGeometry,
  commandsForPlacementGeometry,
  mergeCanvasSnapshot,
  mergeCanvasSnapshotWithPlacementOverrides,
  type PlacementGeometry,
} from "@/lib/canvas/canvas-persistence"
import { hydrateDocumentAnchorCanvasPlacements } from "@/lib/canvas/document-anchor-placement.js"
import { openActionForAtlasNode } from "@/lib/canvas/atlas-open-href.js"
import {
  atlasContextLensLinks,
  type AtlasContextLensLink,
} from "@/lib/canvas/atlas-context-lenses.js"
import { resolveAtlasTaskSelection } from "@/lib/canvas/atlas-task-selection.js"
import { positionAtlasSelectionHud } from "@/lib/canvas/atlas-selection-hud.js"
import {
  atlasAuthoredRelationEligibility,
  inspectAtlasAuthoredRelationEndpoint,
  mergeAtlasAuthoredRelation,
  prepareAtlasAuthoredRelation,
  projectAtlasExactRelationPlacements,
  readAtlasAuthoredRelationRecovery,
  reconcileAtlasObjectLinks,
  removeAtlasAuthoredRelationRecovery,
  resolveAtlasAuthoredRelationEndpoint,
  validateAtlasAuthoredRelationReceipt,
  writeAtlasAuthoredRelationRecovery,
  type AtlasAuthoredRelation,
  type AtlasAuthoredRelationRequest,
} from "@/lib/canvas/atlas-authored-relation.js"
import { normalizeObjectLinkPage } from "@/lib/object-link-client.js"
import {
  authorizeInkPlacementDescriptor,
  normalizeInkPlacementDescriptor,
  reconcileInkPlacement,
  type InkPlacementDescriptor,
} from "@/lib/canvas/ink-placement.js"
import {
  inspectPlaceableReference,
  reconcileReferencePlacement,
  type ReferencePlacementPoint,
} from "@/lib/canvas/reference-placement.js"
import {
  PlacementRemovalConflictError,
  reconcilePlacementRemoval,
} from "@/lib/canvas/placement-removal.js"
import { GALAXY_CANVAS_NODE_DEFINITIONS } from "@/lib/canvas/galaxy-canvas-node-types"
import { asPlacementCanvasStore, asReadOnlyCanvasStore } from "@/lib/canvas/read-only-canvas-store"
import { galaxyBrainService } from "@/lib/galaxy-brain-service"
import {
  createGalaxyObjectReference,
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "@/lib/galaxy-object-reference"
import type {
  DurableDocumentImport,
  DurableDocumentImportMetadata,
} from "@/lib/durable-document-import.js"
import {
  assertCodeGraphSnapshotImportConfirmation,
  CodeGraphSnapshotImportError,
  createCodeGraphSnapshotImportTitle,
} from "@/lib/code-graph-snapshot-import.js"
import { DATASOURCE_FILE_INGESTION_PLAN_ID } from "@/lib/datasource-durable-import.js"
import {
  executeIngestionPlan,
  ingestionPlanTransformScope,
  IngestionPlanContractError,
  resolveIngestionPlanDefinition,
  type IngestionPlanExecutionResult,
} from "@/lib/plugins/ingestion-plans.js"
import { selectInkOriginalRepresentation } from "@/lib/ink-document.js"
import {
  removeCodeEditorDraftWithWorkspaceFallback,
  type CodeEditorDraftChannel,
  type CodeEditorDraftScope,
} from "@/lib/code-editor-draft.js"
import { removeVoiceInputDraftWithWorkspaceFallback } from "@/lib/voice-input-draft.js"
import {
  checkpointVoiceRecordingDraft,
  createVoiceRecordingDraft,
  createVoiceRecordingDraftStore,
  removeVoiceRecordingDraft,
  type VoiceRecordingDraft,
} from "@/lib/voice-recording-draft-store.js"
import {
  runVoiceCaptureSaga,
  type VoicePairPayload,
} from "@/lib/voice-capture-saga.js"
import { dispatchAtlasCommand, listAtlasCommands } from "@/lib/plugins/atlas-commands.js"
import {
  acquireExactArxivPaper,
  paperArxivImportRegistered,
} from "@/lib/paper-arxiv-acquisition.js"
import {
  listPaperImportPlacementRecoveries,
  paperImportPlacementRecoveryNamespace,
  removePaperImportPlacementRecovery,
  writePaperImportPlacementRecovery,
  type PaperImportPlacementRecovery,
} from "@/lib/paper-import-placement-recovery.js"
import {
  AtlasWebCaptureError,
  atlasWebCapturePlacementRecoveryNamespace,
  atlasWebCaptureRegistered,
  captureAtlasWebContent,
  claimAtlasWebCaptureFlight,
  createAtlasWebCapturePlacementRecovery,
  listAtlasWebCapturePlacementRecoveries,
  prepareAtlasWebCaptureIntent,
  releaseAtlasWebCaptureFlight,
  removeAtlasWebCapturePlacementRecovery,
  writeAtlasWebCapturePlacementRecovery,
  type AtlasWebCaptureInput,
  type AtlasWebCaptureIntent,
  type AtlasWebCapturePlacementRecovery,
} from "@/lib/atlas-web-capture.js"
import type { ArxivPaperMetadata } from "@/lib/types/papers"
import {
  formalProjectPackageAtlasPlacement,
  type FormalProjectPackageAtlasPlacement,
} from "@/lib/formal-project-package-atlas.js"
import type { FormalProjectPackageSummary } from "@/lib/formal-project-package-client.js"
import {
  atlasCanvasShareUnavailableReason,
  inspectAtlasCanvasConversationShare,
  inspectAtlasCanvasShare,
  inspectAtlasObjectShareReference,
} from "@/lib/atlas-share.js"
import type { GalaxyObjectProjection } from "@/lib/object-projection"
import { fetchTaskSnapshot } from "@/lib/ham-task-client"
import {
  GalaxyBrainAPIError,
  galaxyBrainAPI,
  type ConfirmedDocumentImport,
  type Experiment,
} from "@/lib/galaxy-brain-api"
import {
  elnExperimentRecoveryNamespace,
  listPendingExperimentPlacements,
  removePendingExperimentPlacement,
  writePendingExperimentPlacement,
  type PendingExperimentPlacement,
} from "@/lib/eln-experiment-recovery.js"
import type { CanvasEnvelope, CanvasRecord } from "@/lib/types/canvas"
import {
  canvasChangeAction,
  canvasReloadSatisfiesChange,
  type CanvasSnapshotFrame,
  type CanvasSnapshotItem,
} from "@/lib/canvas/canvas-snapshot.js"
import { createCanvasChangePoller } from "@/lib/canvas/canvas-convergence.js"
import type { GalaxyPaper } from "@/lib/types/papers"
import type { GalaxySurfaceRecord, GalaxySurfaceSpec } from "@/lib/types/surfaces"
import type { TaskSummary } from "@/lib/types/tasks"
import { filterNodesForWorkspace } from "@/lib/workspace-node-scope"

type AtlasView = "canvas" | "list"
type SelectedTaskContext = {
  task: TaskSummary
  subjectRef: string
}
type SelectedPlacementContext = {
  placementId: string
  subjectRef: string
  label: string
  relationRef: string | null
  relationUnavailableReason: string
  shareRef: string | null
  shareUnavailableReason: string
}
type SelectedFrameContext = { frameId: string; title: string }
type AtlasRelationEndpoint = SelectedPlacementContext & { relationRef: string }
type ExperimentPlacementRecovery = PendingExperimentPlacement
type SourceState = {
  label: string
  status: "ready" | "partial" | "unavailable"
  count: number
}
type AtlasResolvedHydration = Extract<AtlasObjectHydrationResult, { readonly status: "resolved" }> & {
  readonly surfaceSpec?: GalaxySurfaceSpec
}
type AtlasHydrationEntry = Exclude<AtlasObjectHydrationResult, { readonly status: "resolved" }>
  | AtlasResolvedHydration
  | { readonly status: "loading" }
type AtlasHydrationLookup = Readonly<Record<string, AtlasHydrationEntry>>
type AtlasHydrationState = {
  key: string | null
  byReference: AtlasHydrationLookup
}
type ReferencePlacementRequest = {
  operationId: string
  subjectRef: string
  attempt: number
  point?: ReferencePlacementPoint
  ink?: InkPlacementDescriptor
}

function selectedPlacementContextForNode(
  nodeData: GalaxyCanvasNodeData,
  hydration: AtlasHydrationEntry | undefined,
): SelectedPlacementContext {
  const candidate = hydration?.status === "resolved"
    ? hydration.resolvedRef
    : nodeData.subjectRef
  const inspected = inspectAtlasObjectShareReference(candidate)
  const relationEndpoint = resolveAtlasAuthoredRelationEndpoint(nodeData.subjectRef, hydration)
  return {
    placementId: nodeData.placementId,
    subjectRef: nodeData.subjectRef,
    label: hydration?.status === "resolved"
      ? hydration.projection.title
      : nodeData.display.title || "Selected object",
    relationRef: relationEndpoint.ok ? relationEndpoint.ref : null,
    relationUnavailableReason: relationEndpoint.ok ? "" : "Wait for this object's exact pinned revision to resolve.",
    shareRef: inspected.ok ? inspected.selector.objectRef : null,
    shareUnavailableReason: inspected.ok
      ? ""
      : inspected.code === "conversation_excluded"
        ? "Conversation transcripts require the explicit Atlas + conversation share scope."
        : inspected.code === "content_hash_required"
          ? "This object does not expose a shareable SHA-256 revision yet."
          : "Wait for this object's exact revision to resolve.",
  }
}
type ReferenceHandoffState = {
  subjectRef: string
  kind: "document" | "chat" | "surface" | null
  objectId: string
  revisionSha256: string
  sourceRevisionId: string | null
  title?: string
  phase: ReferenceHandoffPhase
  error: string
  operationId?: string
}
type AtlasDropImportRecovery = {
  document: DurableDocumentImport
  operationId: string
  point: ReferencePlacementPoint
  workspaceId: string
  canvasId: string
}
type AtlasObjectDropRecovery = {
  subjectRef: string
  operationId: string
  point: ReferencePlacementPoint
  label: string
  workspaceId: string
  canvasId: string
}
type AtlasPendingDrop = {
  kind: "file" | "object"
  label: string
  point: ReferencePlacementPoint
  phase: "authorizing" | "importing" | "extracting" | "placing" | "error"
  message: string
  operationId?: string
}
type AtlasSourcePlacementRequest = {
  requestId: string
  intent: AtlasObjectDragIntent
}
type FormalPackagePlacementRecovery = FormalProjectPackageAtlasPlacement & {
  workspaceId: string
  canvasId: string
}
type DocumentImportDraft = {
  file: File
  title: string
}
type DocumentImportRecovery = {
  document: DurableDocumentImport
  operationId: string
  workspaceId: string
  canvasId: string
}
type MarkdownNoteTarget = Readonly<{
  workspaceId: string
  canvasId: string
}>
type MarkdownNoteRecovery = MarkdownNoteTarget & {
  document: DurableDocumentImport
  operationId: string
}
type CodeGraphSnapshotTarget = Readonly<{
  workspaceId: string
  canvasId: string
}>
type CodeGraphSnapshotRecovery = CodeGraphSnapshotTarget & {
  document: DurableDocumentImport
  operationId: string
}
type DocumentAnalysisState = {
  document: DurableDocumentImport
  scope: string
  contextKey: string
  label: string
  message: string
  resumable: boolean
  dismissible: boolean
}

function documentAnalysisContextKey(tenantId: string, principalId: string, workspaceId: string) {
  return [tenantId, principalId, workspaceId]
    .map((value) => `${value.length}:${value}`)
    .join("|")
}

function createAtlasDocumentTransformClient() {
  try {
    return createDocumentTransformClient({ storage: window.localStorage })
  } catch (error) {
    if (error instanceof DocumentTransformClientError) throw error
    throw new DocumentTransformClientError(
      "operation-storage-unavailable",
      "Document analysis retry storage is unavailable.",
      { cause: error },
    )
  }
}

function ingestionOutcomeMessage(result: IngestionPlanExecutionResult) {
  if (result.status === "transforming") {
    return result.transform && "status" in result.transform
      && result.transform.status === "running" && result.transform.pollingExhausted
      ? "The exact original is durable. The bounded analysis window ended while document analysis was still running; placement can continue now."
      : "The exact original is durable. Document analysis is still running; placement can continue now."
  }
  if (result.status === "persisted") {
    return result.derivation.retryable
      ? "The exact original is durable. Its derived representation is temporarily unavailable and can be resumed; placement can continue now."
      : "The exact original is durable. Its derived representation failed, but the preserved original can still be placed."
  }
  if (result.derivation.receiptStatus === "fallback") {
    return "The exact original is durable. The primary transform was unavailable, and the registered fallback produced a usable representation."
  }
  if (result.derivation.receiptStatus === "partial") {
    return "The exact original is durable. Document analysis produced a partial representation, which remains explicitly marked partial."
  }
  return "The exact original and its derived document representation are durable."
}

function resumedTransformMessage(result: DocumentTransformResult) {
  if ("status" in result) {
    return result.pollingExhausted
      ? "The bounded analysis window ended while document analysis was still running. Resume the same operation when ready."
      : "Document analysis is still running. Resume the same operation when ready."
  }
  const effectiveReceipt = result.fallbackReceipt || result.receipt
  if (effectiveReceipt.status === "fallback") {
    return "The registered fallback produced a usable document representation."
  }
  if (effectiveReceipt.status === "partial") {
    return "Document analysis produced a partial representation, explicitly marked partial."
  }
  if (effectiveReceipt.status === "success") return "Document analysis completed successfully."
  return "Document analysis reached a terminal failure. The exact original remains durable."
}

function analysisStateForResult(
  result: IngestionPlanExecutionResult,
  label: string,
  scopePrefix: string,
  contextKey: string,
  planId: string = ATLAS_DROP_INGESTION_PLAN_ID,
): DocumentAnalysisState | null {
  const terminalNotice = result.status === "complete"
    && (result.derivation.receiptStatus === "fallback" || result.derivation.receiptStatus === "partial")
  if (!terminalNotice
    && result.status !== "transforming"
    && !(result.status === "persisted" && result.derivation.retryable)) {
    return null
  }
  const plan = resolveIngestionPlanDefinition(planId)
  if (!plan) return null
  return {
    document: result.confirmation.document,
    scope: ingestionPlanTransformScope(plan, result.confirmation.document, scopePrefix),
    contextKey,
    label,
    message: ingestionOutcomeMessage(result),
    resumable: !terminalNotice,
    dismissible: terminalNotice,
  }
}

function analysisStateForConfirmation(
  confirmation: ConfirmedDocumentImport,
  label: string,
  message: string,
  scopePrefix: string,
  contextKey: string,
  options: { resumable?: boolean; dismissible?: boolean } = {},
): DocumentAnalysisState | null {
  const plan = resolveIngestionPlanDefinition(ATLAS_DROP_INGESTION_PLAN_ID)
  if (!plan) return null
  return {
    document: confirmation.document,
    scope: ingestionPlanTransformScope(plan, confirmation.document, scopePrefix),
    contextKey,
    label,
    message,
    resumable: options.resumable ?? true,
    dismissible: options.dismissible ?? false,
  }
}

async function executeAtlasDocumentIngestionPlan(
  file: File,
  metadata: DurableDocumentImportMetadata,
  options: {
    signal: AbortSignal
    scopePrefix: string
    onPersisted: (confirmation: ConfirmedDocumentImport) => void
  },
) {
  // Constructing the bounded transform client before execution ensures that a
  // browser without safe retry storage cannot upload an original it cannot
  // subsequently reconcile through this plan.
  const transformClient = createAtlasDocumentTransformClient()
  return executeIngestionPlan(ATLAS_DROP_INGESTION_PLAN_ID, {
    file,
    metadata,
    signal: options.signal,
    scopePrefix: options.scopePrefix,
  }, {
    importDocument: async (selectedFile, importMetadata, signal) => {
      const confirmation = await galaxyBrainAPI.importDocument(selectedFile, importMetadata, signal)
      options.onPersisted(confirmation)
      return confirmation
    },
    transformDocument: (revisionId, requestOptions) => transformClient.transform(revisionId, requestOptions),
  })
}
type AtlasShareRequestBase = {
  idempotencyKey: string
  label: string
}
type AtlasShareRequest = AtlasShareRequestBase & (
  | { mode: "object-only"; selector: { objectRef: string } }
  | { mode: "canvas-only"; selector: { canvasId: string; version: number; contentHash: string } }
  | { mode: "canvas-plus-conversation"; selector: { canvasId: string; version: number; contentHash: string; conversationRef: string } }
)
type AtlasShareNotice = {
  state: "success" | "error"
  message: string
  url?: string
}

function atlasInkDescriptor(value: unknown, subjectRef: string, projection: GalaxyObjectProjection) {
  try {
    return authorizeInkPlacementDescriptor(value, subjectRef, projection)
  } catch {
    return null
  }
}

async function loadInkPlacementDescriptor(imported: DurableDocumentImport) {
  const response = await fetch(
    `/api/eln/documents/${encodeURIComponent(imported.revision_id)}/representations`,
    { cache: "no-store", headers: { Accept: "application/json" } },
  )
  if (!response.ok) throw new Error("Ink representation is unavailable")
  return selectInkOriginalRepresentation(await response.json(), imported)
}

function safeDocumentImportError(error: unknown) {
  if (error instanceof IngestionPlanContractError) {
    return { message: "The registered document ingestion plan is unavailable or changed. Nothing was uploaded.", ambiguous: false, field: null }
  }
  if (error instanceof DocumentTransformClientError && error.code === "operation-storage-unavailable") {
    return { message: "Document analysis retry storage is unavailable. Nothing was uploaded.", ambiguous: false, field: null }
  }
  if (!(error instanceof GalaxyBrainAPIError)) {
    return { message: "The import outcome is unconfirmed. Retry safely with the same file.", ambiguous: true, field: null }
  }
  if (error.status === 401 || error.status === 403) return { message: "Sign in again before importing this file.", ambiguous: false, field: null }
  if (error.status === 413) return { message: "The selected file exceeds its import limit.", ambiguous: false, field: "file" as const }
  if (error.status === 415) return { message: "Choose a supported file whose extension, media type, and bytes agree.", ambiguous: false, field: "file" as const }
  if (error.status === 409) return { message: "This import operation no longer matches its original file or title.", ambiguous: false, field: null }
  if (error.status === 422) return { message: "Check that the file and document title are valid.", ambiguous: false, field: null }
  return { message: "The import outcome is unconfirmed. Retry safely with the same file.", ambiguous: true, field: null }
}

function formalPackageSelectionContext(workspaceId: string, canvasId: string) {
  return JSON.stringify({ workspaceId, canvasId })
}

function parseFormalPackageSelectionContext(value: string) {
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).sort().join("\n") !== "canvasId\nworkspaceId"
      || typeof parsed.workspaceId !== "string" || !parsed.workspaceId
      || typeof parsed.canvasId !== "string" || !parsed.canvasId) return null
    return { workspaceId: parsed.workspaceId, canvasId: parsed.canvasId }
  } catch {
    return null
  }
}

function safeAtlasDropImportError(error: unknown) {
  if (error instanceof IngestionPlanContractError) {
    return "The registered document ingestion plan is unavailable or changed. Nothing was uploaded."
  }
  if (error instanceof DocumentTransformClientError && error.code === "operation-storage-unavailable") {
    return "Document analysis retry storage is unavailable. Nothing was uploaded."
  }
  if (!(error instanceof GalaxyBrainAPIError)) {
    return "The import outcome is unconfirmed. Drop the exact same file again to retry safely."
  }
  if (error.status === 401 || error.status === 403) return "Sign in again before importing this document."
  if (error.status === 413) return "The dropped file exceeds the 100 MB import limit."
  if (error.status === 415) return "Choose a valid supported PDF or UTF-8 text file."
  if (error.status === 409) return "This import operation no longer matches its original file bytes and title."
  if (error.status === 422) return "The dropped file or its deterministic title is invalid."
  return "The import outcome is unconfirmed. Drop the exact same file again to retry safely."
}

function safeCodeImportError(error: unknown) {
  if (!(error instanceof GalaxyBrainAPIError)) {
    return { message: "The save outcome is unconfirmed. Retry safely with the preserved draft.", ambiguous: true }
  }
  if (error.status === 401 || error.status === 403) return { message: "Sign in again before saving this source file.", ambiguous: false }
  if (error.status === 413) return { message: "The source file exceeds the editor limit.", ambiguous: false }
  if (error.status === 415 || error.status === 422) return { message: "Check the UTF-8 source, title, and filename.", ambiguous: false }
  if (error.status === 409) return { message: "This save operation no longer matches its original source bytes.", ambiguous: false }
  return { message: "The save outcome is unconfirmed. Retry safely with the preserved draft.", ambiguous: true }
}

function safeCodeGraphSnapshotImportError(error: unknown) {
  if (error instanceof CodeGraphSnapshotImportError) {
    return {
      message: "The stored confirmation did not match the reviewed exact JSON bytes. Retry the exact same file safely.",
      ambiguous: true,
    }
  }
  if (!(error instanceof GalaxyBrainAPIError)) {
    return {
      message: "The import outcome is unconfirmed. Retry safely with the same reviewed exact JSON file.",
      ambiguous: true,
    }
  }
  if (error.status === 401 || error.status === 403) {
    return { message: "Sign in again before importing this code graph snapshot.", ambiguous: false }
  }
  if (error.status === 413) return { message: "The code graph snapshot exceeds the import limit.", ambiguous: false }
  if (error.status === 415 || error.status === 422) {
    return { message: "Choose the same valid UTF-8 application/json snapshot reviewed above.", ambiguous: false }
  }
  if (error.status === 409) {
    return { message: "This import no longer matches its original exact bytes and title.", ambiguous: false }
  }
  return {
    message: "The import outcome is unconfirmed. Retry safely with the same reviewed exact JSON file.",
    ambiguous: true,
  }
}

function safeMarkdownNoteImportError(error: unknown) {
  if (error instanceof DocumentTransformClientError && error.code === "operation-storage-unavailable") {
    return { message: "Document analysis retry storage is unavailable. Nothing was saved.", ambiguous: false }
  }
  if (error instanceof IngestionPlanContractError) {
    return { message: "The registered Documents plan could not accept this note. Nothing was saved.", ambiguous: false }
  }
  const safe = safeCodeImportError(error)
  return {
    ...safe,
    message: safe.message
      .replace("source file", "Markdown note")
      .replace("source bytes", "note bytes"),
  }
}

async function createVoicePairRelation(payload: VoicePairPayload) {
  const response = await fetch("/api/eln/object-links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    throw new GalaxyBrainAPIError("The transcript-audio relation was not confirmed.", response.status)
  }
  try {
    return await response.json()
  } catch {
    throw new GalaxyBrainAPIError("The transcript-audio relation confirmation was invalid.", 502)
  }
}

function safeInkImportError(error: unknown) {
  if (!(error instanceof GalaxyBrainAPIError)) {
    return { message: "The ink save outcome is unconfirmed. Retry safely without changing the drawing.", ambiguous: true }
  }
  if (error.status === 401 || error.status === 403) return { message: "Sign in again before saving this ink note.", ambiguous: false }
  if (error.status === 413) return { message: "The drawing exceeds the bounded ink size.", ambiguous: false }
  if (error.status === 415 || error.status === 422) return { message: "The generated ink document was rejected.", ambiguous: false }
  if (error.status === 409) return { message: "This save operation no longer matches its original ink bytes.", ambiguous: false }
  return { message: "The ink save outcome is unconfirmed. Retry safely without changing the drawing.", ambiguous: true }
}
type ReferencePlacementCompletion = {
  operationId: string
  subjectRef: string
  placementId: string
  canvas: CanvasEnvelope
}
type PlacementRemovalRequest = {
  operationId: string
  placementId: string
  subjectRef: string
  attempt: number
}
type PlacementRemovalCompletion = {
  operationId: string
  placementId: string
  canvas: CanvasEnvelope
}
const EMPTY_ATLAS_HYDRATION: AtlasHydrationLookup = Object.freeze({})
const MARKDOWN_NOTE_DRAFT_CHANNEL: CodeEditorDraftChannel = "markdown-note"
const OBJECT_LINK_REFERENCE_LIMIT = 64
const OBJECT_LINK_ROW_LIMIT = 100
const OBJECT_LINK_CONCURRENCY = 6
export type LoadedAtlas = {
  projection: GalaxyCanvasProjection
  baseProjection: GalaxyCanvasProjection
  sources: SourceState[]
  workspaceId: string
  workspaceName: string
  canvases: readonly CanvasRecord[]
  canvasCatalogPotentiallyPartial: boolean
  durableCanvas: CanvasEnvelope | null
  tasks: TaskSummary[]
  sourceCandidates: readonly GalaxyCanvasPlacement[]
  objectLinks?: AuthorizedObjectLink[]
}

type RuntimeMetrics = { projectionMs: number; ingestionMs: number }
type AtlasLodLevel = AtlasSceneLevel
type AtlasDerivedScene = { store: CanvasStore; sourceStore: CanvasStore }
type RuntimeState = {
  store: CanvasStore
  sourceStore: CanvasStore
  constellations: Record<AtlasConstellationLevel, AtlasDerivedScene>
  metrics: RuntimeMetrics
}

async function createAtlasAuthoredRelation(
  request: AtlasAuthoredRelationRequest,
  signal: AbortSignal,
) {
  const response = await fetch("/api/eln/object-links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new GalaxyBrainAPIError("The authored relation was not confirmed.", response.status)
  }
  const body = await response.json().catch(() => null)
  return validateAtlasAuthoredRelationReceipt(body, request)
}

function safeAtlasAuthoredRelationError(error: unknown) {
  if (!(error instanceof GalaxyBrainAPIError)) {
    return {
      message: "The relation outcome is unconfirmed. Retry the same relation to reconcile it safely.",
      ambiguous: true,
    }
  }
  if (error.status === 401) return { message: "Sign in again before creating this relation.", ambiguous: false }
  if (error.status === 403) return { message: "You are not authorized to relate these objects.", ambiguous: false }
  if (error.status === 404) return { message: "One exact object is no longer readable.", ambiguous: false }
  if (error.status === 409) return { message: "This relation operation no longer matches its original request.", ambiguous: false }
  if (error.status === 422) return { message: "The exact relation endpoints or relation type are no longer valid.", ambiguous: false }
  return {
    message: "The relation outcome is unconfirmed. Retry the same relation to reconcile it safely.",
    ambiguous: true,
  }
}

function cameraEqual(left: CameraState, right: CameraState) {
  return left.x === right.x && left.y === right.y && left.z === right.z
}

function replaceStoreScene(store: CanvasStore, nodes: Node[], edges: Edge[]) {
  store.batch(() => {
    for (const edge of store.getAllEdges()) store.removeEdge(edge.id)
    for (const node of store.getAllNodes()) store.removeNode(node.id)
    for (const node of nodes) store.addNode(node)
    for (const edge of edges) store.addEdge(edge)
  })
}

function createConstellationScene(nodes: Node[], level: AtlasConstellationLevel): AtlasDerivedScene {
  const scene = deriveAtlasConstellationScene(nodes, level)
  const sourceStore = createCanvasStore({
    clientId: asClientId(`galaxy-phase2-atlas-${level}`),
    nodeTypes: [ATLAS_CONSTELLATION_NODE_DEFINITION],
  })
  replaceStoreScene(sourceStore, scene.nodes, scene.edges)
  return { sourceStore, store: asReadOnlyCanvasStore(sourceStore) }
}

async function requestAuthorizedArray<T>(path: string, signal: AbortSignal): Promise<T[]> {
  const response = await fetch(path, { cache: "no-store", signal })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(body?.detail || body?.error || `Authorized source failed (${response.status})`)
  }
  if (!Array.isArray(body)) throw new Error("Authorized source returned an invalid collection")
  return body as T[]
}

async function requestAuthorizedDocumentAnchor(
  documentRevisionId: string,
  anchorId: string,
  signal: AbortSignal,
) {
  const response = await fetch(
    `/api/eln/documents/${encodeURIComponent(documentRevisionId)}/anchors/${encodeURIComponent(anchorId)}`,
    { cache: "no-store", signal },
  )
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(body?.detail || body?.error || `Document anchor failed (${response.status})`)
  }
  return body
}

async function requestAtlasObjectLinks(reference: string, signal: AbortSignal) {
  const query = new URLSearchParams({ ref: reference, limit: String(OBJECT_LINK_ROW_LIMIT) })
  const response = await fetch(`/api/eln/object-links?${query}`, { cache: "no-store", signal })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok || !Array.isArray(body)) throw new Error("Object links are unavailable")
  const normalized = normalizeObjectLinkPage(body)
  return {
    links: [...normalized.links],
    saturated: body.length >= OBJECT_LINK_ROW_LIMIT,
    invalid: normalized.invalid,
  }
}

type AtlasObjectLinkPage = Awaited<ReturnType<typeof requestAtlasObjectLinks>>

async function mapAtlasObjectLinksWithConcurrency(
  references: string[],
  signal: AbortSignal,
): Promise<Array<PromiseSettledResult<AtlasObjectLinkPage>>> {
  const results = Array<PromiseSettledResult<AtlasObjectLinkPage>>(references.length)
  let cursor = 0
  await Promise.all(Array.from(
    { length: Math.min(OBJECT_LINK_CONCURRENCY, references.length) },
    async () => {
      while (cursor < references.length) {
        const index = cursor
        cursor += 1
        const reference = references[index]
        if (!reference) continue
        try {
          results[index] = {
            status: "fulfilled",
            value: await requestAtlasObjectLinks(reference, signal),
          }
        } catch (reason) {
          results[index] = { status: "rejected", reason }
        }
      }
    },
  ))
  return results
}

function visibleCanonicalReferences(
  projection: GalaxyCanvasProjection,
  durableCanvas: CanvasEnvelope | null,
) {
  const references = new Set<string>()
  for (const placement of projection.placements) {
    if (placement.authorized !== true || placement.availability === "unavailable") continue
    const parsed = parseGalaxyObjectReference(placement.subjectRef)
    if (parsed?.format !== "canonical") continue
    const canonical = serializeGalaxyObjectReference(parsed)
    if (canonical === placement.subjectRef) references.add(canonical)
  }
  const removed = new Set(durableCanvas?.content.removedItemIds ?? [])
  for (const item of durableCanvas?.content.items ?? []) {
    if (removed.has(item.id)) continue
    const parsed = parseGalaxyObjectReference(item.subjectRef)
    if (parsed?.format !== "canonical") continue
    const canonical = serializeGalaxyObjectReference(parsed)
    if (canonical === item.subjectRef) references.add(canonical)
  }
  return [...references]
}

function authorizedObjectLinkPlacements(
  projection: GalaxyCanvasProjection,
  hydrationByReference: AtlasHydrationLookup,
) {
  return projection.placements.map((placement) => (
    placement.authorized === false
      && placement.availability === "unavailable"
      && hydrationByReference[placement.subjectRef]?.status === "resolved"
      ? { ...placement, authorized: true, availability: "resolved" as const }
      : placement
  ))
}

function collectAtlasObjectLinks(results: Array<PromiseSettledResult<AtlasObjectLinkPage>>) {
  const links: AuthorizedObjectLink[] = []
  let failed = 0
  let saturated = false
  let invalid = 0
  for (const result of results) {
    if (result.status === "rejected") {
      failed += 1
      continue
    }
    if (result.value.saturated) saturated = true
    invalid += result.value.invalid
    links.push(...result.value.links)
  }
  return { links, failed, saturated, invalid }
}

function sourceResult<T>(label: string, result: PromiseSettledResult<T[]>) {
  return {
    label,
    status: result.status === "fulfilled" ? "ready" as const : "unavailable" as const,
    count: result.status === "fulfilled" ? result.value.length : 0,
    values: result.status === "fulfilled" ? result.value : [],
  }
}

function requestedCanvasId(search: string) {
  try {
    return parseAtlasLocation(search).canvasId
  } catch {
    throw new Error("Requested atlas is unavailable")
  }
}

function referenceHandoffError(code?: string) {
  if (code === "duplicate_intent") {
    return "This Atlas placement link contains more than one object reference. Return to the source and try again."
  }
  if (code === "unavailable") {
    return "This exact object is unavailable or you no longer have access to it. Nothing was placed."
  }
  if (code === "identity_mismatch" || code === "source_mismatch" || code === "revision_mismatch") {
    return "The authorized object no longer matches this exact placement request. Nothing was placed."
  }
  return "This Atlas placement link is invalid or no longer supported. Nothing was placed."
}

async function resolveReferenceHandoff(
  subjectRef: string,
  signal: AbortSignal,
  expected?: {
    kind?: "document" | "chat" | "surface"
    objectId?: string
    sourceRevisionId?: string
    revisionSha256?: string
  },
) {
  const batch = await hydrateAtlasObjectReferences([subjectRef], { signal, concurrency: 1 })
  if (signal.aborted) throw new DOMException("Atlas handoff request aborted", "AbortError")
  return authorizeAtlasReferenceHandoff(subjectRef, batch.byReference[subjectRef], expected)
}

async function loadAuthorizedAtlas(
  tenantId: string,
  signal: AbortSignal,
  requestedCanvas: string | null = null,
): Promise<LoadedAtlas> {
  setBrowserTenantScope(tenantId)
  galaxyBrainService.setTenantScope(tenantId)
  const workspaces = galaxyBrainService.getWorkspaces()
  let durableCanvas: CanvasEnvelope | null = null
  if (requestedCanvas) {
    try {
      durableCanvas = await galaxyBrainAPI.getCanvas(requestedCanvas)
    } catch (error) {
      if (
        error instanceof GalaxyBrainAPIError
        && (error.status === 401 || error.status === 403 || error.status === 404)
      ) throw error
      throw new Error("Requested atlas is unavailable")
    }
    if (durableCanvas.canvasId !== requestedCanvas) throw new Error("Requested atlas identity is invalid")
  }
  // Browser-local workspaces are only a legacy content cache. Unless an exact
  // canvas was requested, let the tenant's durable canvas catalog choose the
  // workspace so browsers with stale local caches still converge.
  const tenantCanvases = durableCanvas ? [] : await galaxyBrainAPI.getCanvases()
  const workspaceId = selectAtlasWorkspaceId(durableCanvas, tenantCanvases, workspaces)
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId)
  const listedCanvases = await galaxyBrainAPI.getCanvases(workspaceId)
  if (signal.aborted) throw new DOMException("Atlas request aborted", "AbortError")
  let canvasCatalog = normalizeAtlasCanvasCatalog(listedCanvases, {
    workspaceId,
    activeCanvas: durableCanvas,
    requestedCanvasId: requestedCanvas,
  })
  const workspaceNodes = workspace
    ? filterNodesForWorkspace(galaxyBrainService.getNodes(), workspace.rootFolderId)
        .filter((node) => node.type !== "folder")
        .map((node) => ({
          id: node.id,
          authorized: true as const,
          type: node.type,
          title: node.title,
          content: node.content,
          version: node.version,
          mediaType: typeof node.metadata?.mimeType === "string" ? node.metadata.mimeType : undefined,
        }))
    : []

  const [paperResult, experimentResult, taskResult, surfaceResult] = await Promise.allSettled([
    requestAuthorizedArray<GalaxyPaper>("/api/eln/papers?limit=60", signal),
    requestAuthorizedArray<Experiment>("/api/eln/experiments?limit=60", signal),
    fetchTaskSnapshot(signal, 2).then((page) => page.tasks),
    requestAuthorizedArray<GalaxySurfaceRecord>("/api/eln/surfaces?status=promoted&limit=60", signal),
  ])
  if (signal.aborted) throw new DOMException("Atlas request aborted", "AbortError")

  const papers = sourceResult("Papers", paperResult)
  const experiments = sourceResult("ELN", experimentResult)
  const tasks = sourceResult("Tasks", taskResult)
  const surfaces = sourceResult("Surfaces", surfaceResult)
  // The request filter is not the trust boundary: fail closed again before
  // any surface becomes an automatic Atlas projection.
  const promotedSurfaceValues = surfaces.values.filter((surface) => surface.status === "promoted")
  const promotedSurfaces = { ...surfaces, values: promotedSurfaceValues, count: promotedSurfaceValues.length }
  const sources: AuthorizedCanvasSources = {
    workspaceNodes,
    papers: papers.values.map((paper) => ({
      id: paper.id,
      authorized: true,
      title: paper.title,
      abstract: paper.abstract,
      metadataHash: paper.metadata_hash,
      authors: paper.authors,
      categories: paper.categories,
    })),
    experiments: experiments.values.map((experiment) => ({
      id: experiment.id,
      authorized: true,
      title: experiment.title,
      domain: experiment.domain,
      hypothesis: experiment.hypothesis,
      results: experiment.results,
      interpretation: experiment.interpretation,
      status: experiment.status,
      tags: experiment.tags,
      updatedAt: experiment.updated_at,
    })),
    tasks: tasks.values.map((task: TaskSummary) => ({
      id: task.id,
      authorized: true,
      title: task.title,
      goal: task.goal,
      why: task.why,
      state: task.state,
      lifecyclePhase: task.lifecyclePhase,
      riskMode: task.riskMode,
      version: task.version,
      resources: task.resources,
    })),
    surfaces: promotedSurfaces.values.map((surface) => ({
      id: surface.id,
      authorized: true,
      title: surface.title,
      status: surface.status,
      contentHash: surface.current_content_hash,
      spec: surface.current_spec,
    })),
  }

  const authorizedProjection = buildAuthorizedCanvasProjection(sources)
  if (!durableCanvas) {
    const defaultCanvas = canvasCatalog.canvases[0]
    if (defaultCanvas) {
      durableCanvas = await galaxyBrainAPI.getCanvas(defaultCanvas.canvasId)
      canvasCatalog = normalizeAtlasCanvasCatalog(listedCanvases, {
        workspaceId,
        activeCanvas: durableCanvas,
        requestedCanvasId: defaultCanvas.canvasId,
      })
    }
  }
  if (signal.aborted) throw new DOMException("Atlas request aborted", "AbortError")
  const selectedBaseProjection = selectAtlasBaseProjection(durableCanvas, authorizedProjection)

  const hydratedAnchors = durableCanvas
    ? await hydrateDocumentAnchorCanvasPlacements(
        durableCanvas.content,
        ({ documentRevisionId, anchorId }) => requestAuthorizedDocumentAnchor(
          documentRevisionId,
          anchorId,
          signal,
        ),
      )
    : []
  if (signal.aborted) throw new DOMException("Atlas request aborted", "AbortError")
  const occupiedPlacementIds = new Set(selectedBaseProjection.placements.map((placement) => placement.id))
  const anchorPlacements = hydratedAnchors.filter((placement) => {
    if (occupiedPlacementIds.has(placement.id)) return false
    occupiedPlacementIds.add(placement.id)
    return true
  })
  const placementProjection: GalaxyCanvasProjection = {
    placements: [...selectedBaseProjection.placements, ...anchorPlacements],
    relations: selectedBaseProjection.relations,
  }
  const visibleReferences = visibleCanonicalReferences(placementProjection, durableCanvas)
  const queriedReferences = visibleReferences.slice(0, OBJECT_LINK_REFERENCE_LIMIT)
  const objectLinkResults = await mapAtlasObjectLinksWithConcurrency(queriedReferences, signal)
  if (signal.aborted) throw new DOMException("Atlas request aborted", "AbortError")
  const collectedLinks = collectAtlasObjectLinks(objectLinkResults)
  const fulfilledLinkRequests = objectLinkResults.length - collectedLinks.failed
  // The current endpoint applies its row limit before referent authorization
  // and exposes no continuation token. Any nonempty query is therefore a
  // bounded partial view even when fewer than 100 authorized rows return.
  const objectLinkStatus: SourceState["status"] = queriedReferences.length > 0 && fulfilledLinkRequests === 0
    ? "unavailable"
    : queriedReferences.length > 0
      ? "partial"
      : "ready"
  const baseProjection: GalaxyCanvasProjection = {
    placements: placementProjection.placements,
    relations: placementProjection.relations,
  }

  return {
    projection: durableCanvas
      ? mergeCanvasSnapshot(baseProjection, durableCanvas.content)
      : baseProjection,
    baseProjection,
    workspaceId,
    workspaceName: workspace?.name ?? "Current workspace",
    canvases: canvasCatalog.canvases,
    canvasCatalogPotentiallyPartial: canvasCatalog.potentiallyPartial,
    durableCanvas,
    tasks: tasks.values,
    sourceCandidates: authorizedProjection.placements,
    objectLinks: collectedLinks.links,
    sources: [
      { label: "Workspace", status: "ready", count: workspaceNodes.length },
      ...[papers, experiments, tasks, promotedSurfaces].map(({ label, status, count }) => ({ label, status, count })),
      { label: "Pinned coordinates", status: "ready", count: anchorPlacements.length },
      { label: "Object links", status: objectLinkStatus, count: new Set(collectedLinks.links.map((link) => link.id)).size },
    ],
  }
}

function restoreRequestedSelection(store: CanvasStore, fallbackReference?: string) {
  if (typeof window === "undefined") return
  const parameters = new URLSearchParams(window.location.search)
  const requestedPlacement = parameters.get("placement")
  const requestedReference = parameters.get("ref") || fallbackReference
  const selected = store.getAllNodes().find((node) => {
    const data = node.data as Partial<GalaxyCanvasNodeData> | undefined
    if (data?.schemaId !== "gb.canvas.node.v1") return false
    if (requestedPlacement) return data.placementId === requestedPlacement
    return Boolean(requestedReference && data.subjectRef === requestedReference)
  })
  if (selected) store.setSelection([selected.id])
}

function createAtlasRuntime(input: GalaxyCanvasProjection, defaultSelectionRef?: string): RuntimeState {
  const projectionStart = performance.now()
  const projection = projectGalaxyCanvas(input)
  const projectionMs = performance.now() - projectionStart
  const store = createCanvasStore({
    clientId: asClientId("galaxy-phase2-atlas"),
    nodeTypes: [...GALAXY_CANVAS_NODE_DEFINITIONS],
  })
  const ingestionStart = performance.now()
  store.batch(() => {
    for (const node of projection.nodes) store.addNode(node)
    for (const edge of projection.edges) store.addEdge(edge)
  })
  restoreRequestedSelection(store, defaultSelectionRef)
  store.setCamera(cameraForAtlasNodes(store.getAllNodes(), store.getSelection()[0]))
  const camera = store.getCamera()
  const semanticNodes = projection.nodes.filter((node) => node.data?.schemaId === "gb.canvas.node.v1")
  const far = createConstellationScene(semanticNodes, "far")
  const medium = createConstellationScene(semanticNodes, "medium")
  far.store.setCamera(camera)
  medium.store.setCamera(camera)
  return {
    store: asPlacementCanvasStore(store),
    sourceStore: store,
    constellations: { far, medium },
    metrics: { projectionMs, ingestionMs: performance.now() - ingestionStart },
  }
}

function replaceAtlasRuntimeProjection(runtime: RuntimeState, input: GalaxyCanvasProjection) {
  const next = projectGalaxyCanvas(input)
  const selection = runtime.store.getSelection()
  const camera = runtime.store.getCamera()
  replaceStoreScene(runtime.sourceStore, next.nodes, next.edges)
  for (const level of ["far", "medium"] as const) {
    const scene = deriveAtlasConstellationScene(
      next.nodes.filter((node) => node.data?.schemaId === "gb.canvas.node.v1"),
      level,
    )
    const target = runtime.constellations[level]
    replaceStoreScene(target.sourceStore, scene.nodes, scene.edges)
    target.store.setSelection([])
    target.store.setCamera(camera)
  }
  runtime.store.setSelection(selection.filter((id) => (
    runtime.store.getNode(id as NodeId) || runtime.store.getEdge(id as Edge["id"])
  )))
  runtime.store.setCamera(camera)
}

function ConstellationNavigator({ level }: { level: AtlasConstellationLevel }) {
  const store = useCanvasStore()
  const selection = useSelection()

  useEffect(() => {
    const selectedId = selection[0]
    const node = selectedId ? store.getNode(selectedId as NodeId) : null
    if (!node || node.type !== "atlas.constellation") return
    const camera = store.getCamera()
    const center = { x: node.x + node.w / 2, y: node.y + node.h / 2 }
    const anchor = worldToScreen(center, camera)
    const targetZoom = level === "far"
      ? ATLAS_CONSTELLATION_ZOOM.leaveFar + 0.04
      : ATLAS_CONSTELLATION_ZOOM.leaveMedium + 0.08
    store.setSelection([])
    store.setCamera(zoomAtScreenPoint(camera, targetZoom, anchor))
  }, [level, selection, store])

  return null
}

function safeLegacyCanvasProjection(nodeType: GalaxyCanvasNodeType, data: GalaxyCanvasNodeData) {
  try {
    return projectCanvasNodeObject(nodeType, data)
  } catch {
    return null
  }
}

function AtlasContextLensLinks({
  links,
  ariaLabel,
  stacked = false,
}: {
  links: readonly AtlasContextLensLink[]
  ariaLabel: string
  stacked?: boolean
}) {
  if (links.length === 0) return null
  return (
    <nav
      aria-label={ariaLabel}
      className={stacked ? "mt-2 grid gap-2 sm:grid-cols-2" : "flex flex-wrap items-center gap-2"}
    >
      {links.map((link) => (
        <Button
          key={link.id}
          asChild
          variant="outline"
          size={stacked ? "default" : "sm"}
          className={stacked ? "w-full" : "min-h-10"}
        >
          <a href={link.href}>{link.label}</a>
        </Button>
      ))}
    </nav>
  )
}

type AtlasSelectionHudMeasurements = {
  viewport: { width: number; height: number }
  hud: { width: number; height: number }
  topInset: number
}

function AtlasSelectionHud({
  viewportRef,
  topObstacleRef,
  tasks,
  hydrationByReference,
  canRemovePlacement,
  canComposeRelation,
  relationSource,
  relationReferenceCounts,
  onExecuteTaskCommand,
  onExecutePlacementCommand,
  onRelationAction,
}: {
  viewportRef: { readonly current: HTMLDivElement | null }
  topObstacleRef: { readonly current: HTMLDivElement | null }
  tasks: TaskSummary[]
  hydrationByReference: AtlasHydrationLookup
  canRemovePlacement: boolean
  canComposeRelation: boolean
  relationSource: AtlasRelationEndpoint | null
  relationReferenceCounts: ReadonlyMap<string, number>
  onExecuteTaskCommand: (
    commandId: string,
    selection: SelectedTaskContext,
    trigger: HTMLButtonElement | null,
  ) => void
  onExecutePlacementCommand: (
    commandId: string,
    selection: SelectedPlacementContext,
    trigger: HTMLElement | null,
  ) => void
  onRelationAction: (selection: SelectedPlacementContext, trigger: HTMLElement | null) => void
}) {
  const [selectedId] = useSelection()
  if (!selectedId) return null
  return (
    <AtlasSelectedNodeHud
      nodeId={selectedId as NodeId}
      viewportRef={viewportRef}
      topObstacleRef={topObstacleRef}
      tasks={tasks}
      hydrationByReference={hydrationByReference}
      canRemovePlacement={canRemovePlacement}
      canComposeRelation={canComposeRelation}
      relationSource={relationSource}
      relationReferenceCounts={relationReferenceCounts}
      onExecuteTaskCommand={onExecuteTaskCommand}
      onExecutePlacementCommand={onExecutePlacementCommand}
      onRelationAction={onRelationAction}
    />
  )
}

function AtlasSelectedNodeHud({
  nodeId,
  viewportRef,
  topObstacleRef,
  tasks,
  hydrationByReference,
  canRemovePlacement,
  canComposeRelation,
  relationSource,
  relationReferenceCounts,
  onExecuteTaskCommand,
  onExecutePlacementCommand,
  onRelationAction,
}: {
  nodeId: NodeId
  viewportRef: { readonly current: HTMLDivElement | null }
  topObstacleRef: { readonly current: HTMLDivElement | null }
  tasks: TaskSummary[]
  hydrationByReference: AtlasHydrationLookup
  canRemovePlacement: boolean
  canComposeRelation: boolean
  relationSource: AtlasRelationEndpoint | null
  relationReferenceCounts: ReadonlyMap<string, number>
  onExecuteTaskCommand: (
    commandId: string,
    selection: SelectedTaskContext,
    trigger: HTMLButtonElement | null,
  ) => void
  onExecutePlacementCommand: (
    commandId: string,
    selection: SelectedPlacementContext,
    trigger: HTMLElement | null,
  ) => void
  onRelationAction: (selection: SelectedPlacementContext, trigger: HTMLElement | null) => void
}) {
  const node = useNode(nodeId)
  const camera = useCamera()
  const moving = useIsMoving()
  const hudRef = useRef<HTMLDivElement | null>(null)
  const constructorTriggerRef = useRef<HTMLButtonElement>(null)
  const removeTriggerRef = useRef<HTMLButtonElement>(null)
  const relationTriggerRef = useRef<HTMLButtonElement>(null)
  const [pinnedPosition, setPinnedPosition] = useState<{ left: number; top: number } | null>(null)
  const [measurements, setMeasurements] = useState<AtlasSelectionHudMeasurements>({
    viewport: { width: 0, height: 0 },
    hud: { width: 0, height: 0 },
    topInset: 0,
  })
  const nodeData = node?.data as GalaxyCanvasNodeData | undefined
  const hydration = nodeData?.schemaId === "gb.canvas.node.v1"
    ? hydrationByReference[nodeData.subjectRef]
    : undefined
  const contentAvailable = hydration
    ? hydration.status === "resolved"
    : nodeData?.availability === "resolved"
  const openAction = nodeData?.schemaId === "gb.canvas.node.v1" && contentAvailable
    ? openActionForAtlasNode(nodeData, hydration)
    : undefined
  const contextLensLinks = nodeData?.schemaId === "gb.canvas.node.v1"
    ? atlasContextLensLinks(nodeData.subjectRef, hydration)
    : []
  const selectedTaskContext = nodeData?.schemaId === "gb.canvas.node.v1"
    ? resolveAtlasTaskSelection({
        subjectRef: nodeData.subjectRef,
        availability: nodeData.availability,
        hydration,
        tasks,
      })
    : null
  const selectedPlacementContext = nodeData?.schemaId === "gb.canvas.node.v1"
    ? selectedPlacementContextForNode(nodeData, hydration)
    : null
  const relationEligibility = atlasAuthoredRelationEligibility(
    selectedPlacementContext,
    relationReferenceCounts,
  )
  useEffect(() => {
    const viewport = viewportRef.current
    const hud = hudRef.current
    if (!viewport || !hud) return undefined
    const measure = () => {
      const viewportRect = viewport.getBoundingClientRect()
      const obstacleRect = topObstacleRef.current?.getBoundingClientRect()
      const next = {
        viewport: { width: viewport.clientWidth, height: viewport.clientHeight },
        hud: { width: hud.offsetWidth, height: hud.offsetHeight },
        topInset: obstacleRect
          ? Math.max(0, obstacleRect.bottom - viewportRect.top)
          : 0,
      }
      setMeasurements((current) => (
        current.viewport.width === next.viewport.width
        && current.viewport.height === next.viewport.height
        && current.hud.width === next.hud.width
        && current.hud.height === next.hud.height
        && current.topInset === next.topInset
          ? current
          : next
      ))
    }
    measure()
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure)
      return () => window.removeEventListener("resize", measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(hud)
    if (topObstacleRef.current) observer.observe(topObstacleRef.current)
    return () => observer.disconnect()
  }, [node?.id, topObstacleRef, viewportRef])

  useLayoutEffect(() => {
    const hud = hudRef.current
    const viewport = viewportRef.current
    return () => {
      if (!hud?.contains(document.activeElement)) return
      viewport
        ?.querySelector<HTMLElement>("[data-canvas-host]")
        ?.focus({ preventScroll: true })
    }
  }, [nodeId, viewportRef])

  if (!node || nodeData?.schemaId !== "gb.canvas.node.v1" || !selectedPlacementContext) return null

  const position = positionAtlasSelectionHud({
    nodeBounds: nodeAABB(node),
    camera,
    viewport: measurements.viewport,
    hud: measurements.hud,
    pinnedPosition,
    insets: {
      top: measurements.topInset,
      bottom: 156,
    },
  })
  const pinned = pinnedPosition !== null
  const visiblePosition = moving && !pinned ? null : position

  return (
    <div
      ref={hudRef}
      className="atlas-selection-hud"
      data-ready={visiblePosition ? "true" : "false"}
      data-pinned={pinned ? "true" : "false"}
      data-placement={visiblePosition?.placement || (moving ? "moving" : "measuring")}
      style={position ? { transform: `translate3d(${position.left}px, ${position.top}px, 0)` } : undefined}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <HudToolbar label={`Actions for ${selectedPlacementContext.label}`}>
        {openAction ? (
          <HudLink label={openAction.label} icon={<ArrowRight />} href={openAction.href} tone="primary" />
        ) : null}
        {selectedTaskContext ? (
          <HudAction
            ref={constructorTriggerRef}
            label="Task constructor"
            icon={<Wrench />}
            onClick={() => onExecuteTaskCommand(
              "task.plan.open",
              selectedTaskContext,
              constructorTriggerRef.current,
            )}
          />
        ) : null}
        {contextLensLinks.length > 0 ? <HudDivider /> : null}
        {contextLensLinks.map((link) => (
          <HudLink
            key={link.id}
            label={link.label}
            icon={link.id === "graph" ? <Orbit /> : <List />}
            href={link.href}
          />
        ))}
        <HudDivider />
        <HudAction
          ref={relationTriggerRef}
          label={relationSource?.placementId === selectedPlacementContext.placementId
            ? "Cancel relation"
            : relationEligibility.ok
              ? relationSource
                ? `Link from ${relationSource.label}`
                : "Link from this object"
              : relationEligibility.reason}
          icon={<Link2 />}
          active={relationSource?.placementId === selectedPlacementContext.placementId}
          disabled={!canComposeRelation || (!relationEligibility.ok && relationSource?.placementId !== selectedPlacementContext.placementId)}
          onClick={() => onRelationAction(selectedPlacementContext, relationTriggerRef.current)}
        />
        <HudAction
          ref={removeTriggerRef}
          label="Remove placement"
          icon={<Unlink />}
          disabled={!canRemovePlacement}
          onClick={() => onExecutePlacementCommand(
            "placement.remove",
            selectedPlacementContext,
            removeTriggerRef.current,
          )}
        />
        <HudAction
          label={pinned ? "Unpin toolbar" : "Pin toolbar"}
          icon={pinned ? <PinOff /> : <Pin />}
          active={pinned}
          aria-pressed={pinned}
          onClick={() => setPinnedPosition(position && !pinned
            ? { left: position.left, top: position.top }
            : null)}
        />
        <HudStatus>{selectedPlacementContext.label}</HudStatus>
      </HudToolbar>
    </div>
  )
}

function SelectionInspector({
  tasks,
  hydrationByReference,
  exactRepresentationAuthorizationScope,
  canRemovePlacement,
  canComposeRelation,
  relationSource,
  relationReferenceCounts,
  onSelectedTaskChange,
  onSelectedPlacementChange,
  onSelectedFrameChange,
  onExecuteTaskCommand,
  onExecutePlacementCommand,
  onRelationAction,
  onRemoveFrame,
}: {
  tasks: TaskSummary[]
  hydrationByReference: AtlasHydrationLookup
  exactRepresentationAuthorizationScope: string
  canRemovePlacement: boolean
  canComposeRelation: boolean
  relationSource: AtlasRelationEndpoint | null
  relationReferenceCounts: ReadonlyMap<string, number>
  onSelectedTaskChange: (selection: SelectedTaskContext | null) => void
  onSelectedPlacementChange: (selection: SelectedPlacementContext | null) => void
  onSelectedFrameChange: (selection: SelectedFrameContext | null) => void
  onExecuteTaskCommand: (
    commandId: string,
    selection: SelectedTaskContext,
    trigger: HTMLButtonElement | null,
  ) => void
  onExecutePlacementCommand: (
    commandId: string,
    selection: SelectedPlacementContext,
    trigger: HTMLElement | null,
  ) => void
  onRelationAction: (selection: SelectedPlacementContext, trigger: HTMLElement | null) => void
  onRemoveFrame: (frame: CanvasSnapshotFrame) => void
}) {
  const [selectedId] = useSelection()
  const store = useCanvasStore()
  const camera = useCamera()
  const harnessMoving = useIsMoving()
  const inspectorViewportRef = useRef<HTMLElement | null>(null)
  const [inspectorViewportVisible, setInspectorViewportVisible] = useState(false)
  const [settledCamera, setSettledCamera] = useState<{ x: number; y: number; z: number } | null>(null)
  const moving = harnessMoving || !settledCamera
    || settledCamera.x !== camera.x
    || settledCamera.y !== camera.y
    || settledCamera.z !== camera.z
  const constructorTriggerRef = useRef<HTMLButtonElement>(null)
  const removeTriggerRef = useRef<HTMLButtonElement>(null)
  const relationTriggerRef = useRef<HTMLButtonElement>(null)
  const edgeInspectorRef = useRef<HTMLElement>(null)
  const node = selectedId ? store.getNode(selectedId as Node["id"]) : undefined
  const edge = selectedId && !node ? store.getEdge(selectedId as Edge["id"]) : undefined
  const rawNodeData = node?.data as GalaxyCanvasNodeData | GalaxyCanvasFrameData | undefined
  const nodeData = rawNodeData?.schemaId === "gb.canvas.node.v1" ? rawNodeData : undefined
  const frameData = rawNodeData?.schemaId === "gb.canvas.frame.v1" ? rawNodeData : undefined
  const edgeData = edge?.data as GalaxyCanvasRelationData | undefined
  const hydration = nodeData?.schemaId === "gb.canvas.node.v1"
    ? hydrationByReference[nodeData.subjectRef]
    : undefined
  const contentAvailable = hydration
    ? hydration.status === "resolved"
    : nodeData?.availability === "resolved"
  const selectedTaskContext = useMemo(
    () => nodeData?.schemaId === "gb.canvas.node.v1"
      ? resolveAtlasTaskSelection({
          subjectRef: nodeData.subjectRef,
          availability: nodeData.availability,
          hydration,
          tasks,
        })
      : null,
    [hydration, nodeData?.availability, nodeData?.schemaId, nodeData?.subjectRef, tasks],
  )
  const selectedPlacementContext = useMemo(
    () => nodeData?.schemaId === "gb.canvas.node.v1"
      ? selectedPlacementContextForNode(nodeData, hydration)
      : null,
    [hydration, nodeData],
  )
  const selectedFrameContext = useMemo(() => frameData && node
    ? { frameId: frameData.frameId, title: typeof node.content === "string" ? node.content : "Frame" }
    : null, [frameData, node])
  const relationEligibility = atlasAuthoredRelationEligibility(
    selectedPlacementContext,
    relationReferenceCounts,
  )
  const selectedRelationSource = resolveAtlasRuntimeRelationEndpoint(
    edge,
    "source",
    (nodeId) => store.getNode(nodeId),
  )
  const selectedRelationTarget = resolveAtlasRuntimeRelationEndpoint(
    edge,
    "target",
    (nodeId) => store.getNode(nodeId),
  )
  const focusSelectedRelationEndpoint = useCallback((side: AtlasRelationEndpointSide) => {
    if (!selectedId) return
    const liveEdge = store.getEdge(selectedId as Edge["id"])
    const endpoint = resolveAtlasRuntimeRelationEndpoint(
      liveEdge,
      side,
      (nodeId) => store.getNode(nodeId),
    )
    if (!endpoint) return
    const canvasHost = edgeInspectorRef.current
      ?.closest("main")
      ?.querySelector<HTMLElement>("[data-canvas-host]")
    store.setSelection([endpoint.nodeId])
    store.setCamera(cameraForAtlasNodes(store.getAllNodes(), endpoint.nodeId))
    window.requestAnimationFrame(() => canvasHost?.focus({ preventScroll: true }))
  }, [selectedId, store])
  const moveSelectedPlacement = useCallback((deltaX: number, deltaY: number) => {
    if (!selectedId) return
    const current = store.getNode(selectedId as Node["id"])
    if (!current) return
    store.updateNode(current.id, { x: current.x + deltaX, y: current.y + deltaY })
  }, [selectedId, store])

  useEffect(() => {
    const next = { x: camera.x, y: camera.y, z: camera.z }
    const timeout = window.setTimeout(() => setSettledCamera(next), 120)
    return () => window.clearTimeout(timeout)
  }, [camera.x, camera.y, camera.z])

  useEffect(() => {
    if (!inspectorViewportRef.current) return undefined
    return observeAtlasViewportVisibility(inspectorViewportRef.current, setInspectorViewportVisible)
  }, [nodeData?.placementId])

  useEffect(() => {
    const url = new URL(window.location.href)
    if (nodeData?.schemaId === "gb.canvas.node.v1") {
      url.searchParams.set("placement", nodeData.placementId)
      url.searchParams.set("ref", nodeData.subjectRef)
    } else {
      url.searchParams.delete("placement")
      url.searchParams.delete("ref")
    }
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`)
  }, [nodeData?.placementId, nodeData?.schemaId, nodeData?.subjectRef])

  useEffect(() => {
    onSelectedTaskChange(selectedTaskContext)
    return () => onSelectedTaskChange(null)
  }, [onSelectedTaskChange, selectedTaskContext])

  useEffect(() => {
    onSelectedPlacementChange(selectedPlacementContext)
    return () => onSelectedPlacementChange(null)
  }, [onSelectedPlacementChange, selectedPlacementContext])

  useEffect(() => {
    onSelectedFrameChange(selectedFrameContext)
    return () => onSelectedFrameChange(null)
  }, [onSelectedFrameChange, selectedFrameContext])

  if (frameData && node) {
    const frame: CanvasSnapshotFrame = {
      id: frameData.frameId,
      title: typeof node.content === "string" ? node.content : "Frame",
      x: node.x,
      y: node.y,
      width: node.w,
      height: node.h,
      tone: frameData.tone,
    }
    return (
      <aside className="atlas-inspector">
        <p className="research-kicker">Selected frame</p>
        <h2 className="research-display mt-2 text-2xl">{frame.title}</h2>
        <p className="mt-3 text-sm text-[#61766b]">Presentation only · {frame.tone} · {frame.width} × {frame.height}</p>
        <Button type="button" variant="outline" className="mt-5" onClick={() => onRemoveFrame(frame)}>
          Remove frame
        </Button>
      </aside>
    )
  }

  if (nodeData?.schemaId === "gb.canvas.node.v1") {
    const nodeType = node?.type as GalaxyCanvasNodeType
    const projection = hydration?.status === "resolved"
      ? hydration.projection
      : contentAvailable
        ? safeLegacyCanvasProjection(nodeType, nodeData)
        : null
    const openAction = contentAvailable ? openActionForAtlasNode(nodeData, hydration) : undefined
    const contextLensLinks = atlasContextLensLinks(nodeData.subjectRef, hydration)
    const ink = hydration?.status === "resolved" && projection
      ? atlasInkDescriptor(nodeData.placementState.style, nodeData.subjectRef, projection)
      : null
    return (
      <aside ref={inspectorViewportRef} className="atlas-inspector">
        <p className="sr-only" aria-live="polite">
          {projection ? `Selected ${projection.title}` : "Selected placement unavailable"}
        </p>
        <p className="research-kicker">Selected placement</p>
        {projection ? (
          <ObjectProjectionHost
            projection={projection}
            documentRevisionId={hydration?.status === "resolved" ? hydration.documentRevisionId : undefined}
            context="detail"
            zoom={3}
            moving={moving}
            streamExactRepresentation={inspectorViewportVisible && !nodeData.placementState.collapsed}
            exactRepresentationAuthorizationScope={exactRepresentationAuthorizationScope}
            resolvedRepresentation={hydration ? undefined : resolvedCanvasNodeRepresentation(nodeType, nodeData)}
            surfaceSpec={hydration?.status === "resolved"
              ? hydration.surfaceSpec
              : hydration ? undefined : nodeData.display.surfaceSpec}
            representationPreview={inspectorViewportVisible && !moving && !nodeData.placementState.collapsed && ink ? (
              <InkPlacementPreview
                descriptor={ink}
                label={`${projection.title} ink drawing`}
                className="max-h-72 w-full"
              />
            ) : undefined}
            className="mt-3 min-h-64"
          />
        ) : (
          <UnavailableCanvasObject className="mt-3 min-h-64" />
        )}
        {projection ? (
          <dl className="mt-4 space-y-2 text-sm text-[hsl(var(--field-muted))]">
            <div><dt className="font-semibold">Placement</dt><dd>{nodeData.placementId}</dd></div>
            <div><dt className="font-semibold">Type</dt><dd>{nodeType}</dd></div>
            <div><dt className="font-semibold">Revision</dt><dd>{projection.revision.id || projection.revision.policy}</dd></div>
            <div><dt className="font-semibold">Provenance</dt><dd>{projection.provenance.statement || projection.provenance.provider}</dd></div>
          </dl>
        ) : null}
        <fieldset className="atlas-placement-controls mt-4" aria-describedby="atlas-placement-move-help">
          <legend className="research-kicker px-1">Move placement</legend>
          <p id="atlas-placement-move-help" className="text-xs text-[hsl(var(--field-muted))]">
            Move in 24 pixel steps without dragging.
          </p>
          <div className="atlas-placement-direction-grid">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="col-start-2"
              aria-label="Move placement up 24 pixels"
              onClick={() => moveSelectedPlacement(0, -24)}
            >
              <ArrowUp aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="col-start-1 row-start-2"
              aria-label="Move placement left 24 pixels"
              onClick={() => moveSelectedPlacement(-24, 0)}
            >
              <ArrowLeft aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="col-start-2 row-start-2"
              aria-label="Move placement down 24 pixels"
              onClick={() => moveSelectedPlacement(0, 24)}
            >
              <ArrowDown aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="col-start-3 row-start-2"
              aria-label="Move placement right 24 pixels"
              onClick={() => moveSelectedPlacement(24, 0)}
            >
              <ArrowRight aria-hidden="true" />
            </Button>
          </div>
        </fieldset>
        {selectedTaskContext ? (
          <Button
            ref={constructorTriggerRef}
            type="button"
            className="mt-5 w-full"
            onClick={() => onExecuteTaskCommand("task.plan.open", selectedTaskContext, constructorTriggerRef.current)}
          >
            <Wrench className="h-4 w-4" aria-hidden="true" /> Open task constructor
          </Button>
        ) : null}
        {openAction ? (
          <Button asChild variant="outline" className="mt-2 w-full">
            <a href={openAction.href}>{openAction.label}</a>
          </Button>
        ) : null}
        <AtlasContextLensLinks
          links={contextLensLinks}
          ariaLabel="Selected object lenses"
          stacked
        />
        {selectedPlacementContext ? (
          <Button
            ref={relationTriggerRef}
            type="button"
            variant="outline"
            disabled={!canComposeRelation || (!relationEligibility.ok && relationSource?.placementId !== selectedPlacementContext.placementId)}
            className="mt-2 w-full"
            onClick={() => onRelationAction(selectedPlacementContext, relationTriggerRef.current)}
          >
            <Link2 className="h-4 w-4" aria-hidden="true" />
            {relationSource?.placementId === selectedPlacementContext.placementId
              ? "Cancel relation"
              : relationEligibility.ok
                ? relationSource
                  ? `Link from ${relationSource.label}`
                  : "Link from this object"
                : relationEligibility.reason}
          </Button>
        ) : null}
        {selectedPlacementContext ? (
          <Button
            ref={removeTriggerRef}
            type="button"
            variant="outline"
            disabled={!canRemovePlacement}
            className="mt-2 w-full border-[#b66238]/45 text-[#7f321c] hover:bg-[#b66238]/10 hover:text-[#7f321c]"
            onClick={() => onExecutePlacementCommand(
              "placement.remove",
              selectedPlacementContext,
              removeTriggerRef.current,
            )}
          >
            <Unlink className="h-4 w-4" aria-hidden="true" /> Remove from Atlas
          </Button>
        ) : null}
      </aside>
    )
  }
  if (edgeData?.schemaId === "gb.canvas.relation.v1") {
    return (
      <aside ref={edgeInspectorRef} className="atlas-inspector" aria-live="polite">
        <p className="research-kicker">Selected relation</p>
        <h2 className="research-display mt-2 text-xl font-semibold text-[#18372b]">{edge?.content || "Relation"}</h2>
        <p className="mt-3 text-sm text-[#3d554a]">{edgeData.trustClass} · {edgeData.owner}</p>
        <p className="mt-2 text-sm text-[#61766b]">{edgeData.provenance || "No provenance supplied."}</p>
        <dl className="mt-5 grid gap-3">
          {([
            ["source", "Source", selectedRelationSource],
            ["target", "Target", selectedRelationTarget],
          ] as const).map(([side, label, endpoint]) => (
            <div key={side} className="rounded-xl border border-[hsl(var(--field-border))] bg-[hsl(var(--field-panel))] p-3 text-[hsl(var(--field-ink))]">
              <dt className="research-kicker">{label}</dt>
              <dd className="mt-1 break-words text-sm font-semibold">{endpoint?.label || "Unavailable in the current Atlas"}</dd>
              <Button
                type="button"
                variant="outline"
                className="mt-3 h-auto min-h-11 w-full min-w-0 max-w-full whitespace-normal break-words"
                disabled={!endpoint}
                aria-label={endpoint ? `Focus ${side}: ${endpoint.label}` : `${label} unavailable`}
                onClick={() => focusSelectedRelationEndpoint(side)}
              >
                Focus {side}
              </Button>
            </div>
          ))}
        </dl>
      </aside>
    )
  }
  return (
    <aside className="atlas-inspector">
      <p className="research-kicker">Canvas context</p>
      <h2 className="research-display mt-2 text-xl font-semibold text-[#18372b]">Select a placement</h2>
      <p className="mt-3 text-sm leading-6 text-[#61766b]">
        The atlas receives only authorized display envelopes. Canonical content stays in its owning service.
      </p>
    </aside>
  )
}

function Diagnostics({ renderer, metrics }: { renderer: Renderer | null; metrics: RuntimeMetrics }) {
  const camera = useCamera()
  const selection = useSelection()
  const store = useCanvasStore()
  const [frameStats, setFrameStats] = useState<FrameStats>({ lastMs: 0, avgMs: 0, frames: 0, fps: 0 })
  const [drawCount, setDrawCount] = useState(0)
  const [overlayCount, setOverlayCount] = useState(0)

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!renderer) return
      setFrameStats(renderer.stats())
      setDrawCount(renderer.lastDrawCount())
      setOverlayCount(renderer.getOverlaySet().length)
    }, 500)
    return () => window.clearInterval(timer)
  }, [renderer])

  return (
    <div className="pointer-events-none absolute left-3 top-3 z-20 rounded-xl border border-white/80 bg-[#fffef9]/95 px-3 py-2 font-mono text-[11px] leading-5 text-[#315f49] shadow-sm backdrop-blur">
      <p className="flex items-center gap-1 font-semibold"><Activity className="h-3.5 w-3.5" /> Atlas diagnostics</p>
      <p>{store.getNodeCount()} nodes · {store.getEdgeCount()} edges · {overlayCount} live DOM</p>
      <p>{frameStats.fps} fps · {frameStats.avgMs.toFixed(2)} ms avg · {drawCount} drawn</p>
      <p>zoom {camera.z.toFixed(2)} · selected {selection.length}</p>
      <p>project {metrics.projectionMs.toFixed(2)} ms · ingest {metrics.ingestionMs.toFixed(2)} ms</p>
    </div>
  )
}

function AtlasSourceShelf({
  placements,
  disabled,
  onPlace,
}: {
  placements: readonly GalaxyCanvasPlacement[]
  disabled: boolean
  onPlace: (intent: AtlasObjectDragIntent) => void
}) {
  const draggedRef = useRef(false)
  const candidates = placements.filter((placement) => (
    placement.authorized === true
    && placement.availability !== "unavailable"
    && inspectPlaceableReference(placement.subjectRef).ok
  )).slice(0, 16)
  if (candidates.length === 0) return null
  return (
    <div className="mt-3 border-t border-[#d8c8a6] pt-3">
      <p className="research-kicker">Drag to place</p>
      <p id="atlas-source-shelf-instructions" className="text-xs text-[#61766b]">
        Drag to an exact point, or click, press Enter, or press Space to place at the viewport center.
      </p>
      <ul className="mt-2 grid max-h-56 gap-2 overflow-y-auto" aria-label="Authorized Atlas objects available to drag">
        {candidates.map((placement) => (
          <li key={`${placement.id}:${placement.subjectRef}`}>
            <button
              className="w-full cursor-grab rounded-lg border border-[#d8c8a6] bg-[#fffef9] px-3 py-2 text-left text-sm text-[#294438] shadow-sm active:cursor-grabbing"
              type="button"
              draggable
              disabled={disabled}
              aria-describedby="atlas-source-shelf-instructions"
              title="Drag to an exact point or activate to place at the canvas center"
              onClick={() => {
                if (draggedRef.current) {
                  draggedRef.current = false
                  return
                }
                onPlace({
                  schemaId: "gb.atlas.object-drag.v1",
                  subjectRef: placement.subjectRef,
                  label: placement.display.title,
                })
              }}
              onDragStart={(event) => {
                if (disabled) {
                  event.preventDefault()
                  return
                }
                draggedRef.current = true
                writeAtlasObjectDrag(event.dataTransfer, {
                  subjectRef: placement.subjectRef,
                  label: placement.display.title,
                })
              }}
              onDragEnd={() => {
                window.setTimeout(() => {
                  draggedRef.current = false
                }, 0)
              }}
            >
              <span className="block truncate font-semibold">{placement.display.title}</span>
              <span className="block truncate text-xs text-[#61766b]">{placement.display.subtitle || placement.nodeType}</span>
            </button>
          </li>
        ))}
      </ul>
      {placements.length > candidates.length ? (
        <p className="mt-2 text-xs text-[#61766b]">Showing the first 16 placeable authorized objects.</p>
      ) : null}
    </div>
  )
}

function AtlasPendingDropCard({
  pending,
  retryable,
  onRetry,
  onDismiss,
}: {
  pending: AtlasPendingDrop
  retryable: boolean
  onRetry: () => void
  onDismiss: () => void
}) {
  const camera = useCamera()
  const screen = worldToScreen(pending.point, camera)
  return (
    <div
      className={`pointer-events-auto absolute z-30 w-[min(320px,calc(100%-2rem))] rounded-xl border px-4 py-3 shadow-xl backdrop-blur ${pending.phase === "error"
        ? "border-[#b66238]/60 bg-[#fff2eb]/95 text-[#71331f]"
        : "border-[#6d7a68]/55 bg-[#fffef9]/95 text-[#294438]"}`}
      style={{ left: 0, top: 0, transform: `translate(${screen.x}px, ${screen.y}px)` }}
      role={pending.phase === "error" ? "alert" : "status"}
      aria-live="polite"
    >
      <p className="research-kicker">{pending.kind === "file" ? "Dropped file" : "Dropped object"}</p>
      <p className="mt-1 truncate font-semibold">{pending.label}</p>
      <p className="mt-1 text-sm">{pending.message}</p>
      {pending.phase === "error" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {retryable ? <Button type="button" size="sm" onClick={onRetry}>Retry placement</Button> : null}
          {!retryable ? <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button> : null}
        </div>
      ) : null}
    </div>
  )
}

type PersistenceNotice = {
  state: "local" | "saving" | "saved" | "conflict" | "error" | "reference-error" | "removal-error"
  message: string
}

type CanvasInvalidationNotice = {
  canvasId: string
  version: number
  contentHash: string
  waitingForLocalWork: boolean
}

type CanvasConvergenceReader = () => Readonly<{
  canvas: CanvasEnvelope | null
  pendingWork: boolean
}>

function waitForAtlasDropPublication() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve())
  })
}

function AtlasOverviewPanel({
  level,
  total,
  readable,
  unavailable,
  onZoomToObjects,
  onOpenList,
}: {
  level: AtlasConstellationLevel
  total: number
  readable: number
  unavailable: number
  onZoomToObjects: () => void
  onOpenList: () => void
}) {
  const scaleLabel = level === "far" ? "Landscape" : "Field"
  return (
    <aside className="atlas-overview-panel" aria-labelledby="atlas-overview-heading">
      <p className="research-kicker">Semantic scale</p>
      <div className="mt-1 flex items-start justify-between gap-3">
        <div>
          <h2 id="atlas-overview-heading" className="research-display text-2xl font-semibold">
            {scaleLabel} view
          </h2>
          <p className="mt-1 text-sm leading-5 text-[hsl(var(--field-muted))]">
            Density regions summarize Atlas placements without exposing their titles or references.
          </p>
        </div>
        <span className="atlas-overview-scale-badge">{scaleLabel}</span>
      </div>

      <dl className="atlas-overview-counts" aria-label="Atlas overview counts">
        <div><dt>Placements</dt><dd>{total}</dd></div>
        <div><dt>Readable</dt><dd>{readable}</dd></div>
        <div><dt>Unavailable</dt><dd>{unavailable}</dd></div>
      </dl>

      <ol className="atlas-overview-scale" aria-label={`Current semantic scale: ${scaleLabel}`}>
        {(["Landscape", "Field", "Objects"] as const).map((label) => (
          <li key={label} aria-current={label === scaleLabel ? "step" : undefined}>{label}</li>
        ))}
      </ol>

      <section className="atlas-overview-legend" aria-labelledby="atlas-overview-legend-heading">
        <h3 id="atlas-overview-legend-heading" className="research-kicker">Reading the field</h3>
        <ul>
          <li><span className="atlas-overview-legend-ring" aria-hidden="true" /> Solid ring: Atlas placement region</li>
          <li><span className="atlas-overview-legend-fill" aria-hidden="true" /> Inner fill: readable share of the region</li>
          <li><span className="atlas-overview-legend-alert" aria-hidden="true">!</span> Text count: placements currently unavailable</li>
        </ul>
      </section>

      <div className="atlas-overview-actions">
        <Button type="button" className="min-h-11" onClick={onZoomToObjects}>
          <Plus aria-hidden="true" /> Zoom to exact objects
        </Button>
        <Button type="button" variant="outline" className="min-h-11" onClick={onOpenList}>
          <List aria-hidden="true" /> Open placement list
        </Button>
      </div>
    </aside>
  )
}

function AtlasCanvas({
  projection,
  baseProjection,
  hydrationByReference,
  exactRepresentationAuthorizationScope,
  workspaceId,
  workspaceName,
  initialCanvas,
  tasks,
  showDiagnostics,
  preview = false,
  defaultSelectionRef,
  focusPlacementId,
  consumeMissingRelationFocus,
  referencePlacementRequest,
  placementRemovalRequest,
  canRemovePlacement,
  canComposeRelation,
  relationSource,
  relationReferenceCounts,
  onSelectedTaskChange,
  onSelectedPlacementChange,
  onSelectedFrameChange,
  onExecuteTaskCommand,
  onExecutePlacementCommand,
  onRelationAction,
  onFocusPlacementConsumed,
  onReferencePlacementTarget,
  onReferencePlacementComplete,
  onReferencePlacementError,
  pendingDrop,
  pendingDropRetryable,
  dropRecoveryBlocked,
  sourcePlacementRequest,
  onPendingDrop,
  onAtlasObjectDrop,
  onSourcePlacementConsumed,
  onPendingDropRetry,
  onPendingDropDismiss,
  onAtlasDropImport,
  onAtlasDropImportError,
  onPlacementRemovalComplete,
  onPlacementRemovalError,
  onRemoveFrame,
  onOpenList,
  canvasMutationsBlocked,
  onCanvasAccepted,
  onPendingWorkReaderChange,
}: {
  projection: GalaxyCanvasProjection
  baseProjection: GalaxyCanvasProjection
  hydrationByReference: AtlasHydrationLookup
  exactRepresentationAuthorizationScope: string
  workspaceId: string
  workspaceName: string
  initialCanvas: CanvasEnvelope | null
  tasks: TaskSummary[]
  showDiagnostics: boolean
  preview?: boolean
  defaultSelectionRef?: string
  focusPlacementId?: string
  consumeMissingRelationFocus: boolean
  referencePlacementRequest: ReferencePlacementRequest | null
  placementRemovalRequest: PlacementRemovalRequest | null
  canRemovePlacement: boolean
  canComposeRelation: boolean
  relationSource: AtlasRelationEndpoint | null
  relationReferenceCounts: ReadonlyMap<string, number>
  onSelectedTaskChange: (selection: SelectedTaskContext | null) => void
  onSelectedPlacementChange: (selection: SelectedPlacementContext | null) => void
  onSelectedFrameChange: (selection: SelectedFrameContext | null) => void
  onExecuteTaskCommand: (
    commandId: string,
    selection: SelectedTaskContext,
    trigger: HTMLButtonElement | null,
  ) => void
  onExecutePlacementCommand: (
    commandId: string,
    selection: SelectedPlacementContext,
    trigger: HTMLElement | null,
  ) => void
  onRelationAction: (selection: SelectedPlacementContext, trigger: HTMLElement | null) => void
  onFocusPlacementConsumed: (placementId: string) => void
  onReferencePlacementTarget: (operationId: string, canvasId: string) => void
  onReferencePlacementComplete: (completion: ReferencePlacementCompletion) => void
  onReferencePlacementError: (operationId: string, message: string) => void
  pendingDrop: AtlasPendingDrop | null
  pendingDropRetryable: boolean
  dropRecoveryBlocked: boolean
  sourcePlacementRequest: AtlasSourcePlacementRequest | null
  onPendingDrop: (pending: AtlasPendingDrop) => void
  onAtlasObjectDrop: (
    intent: AtlasObjectDragIntent,
    point: ReferencePlacementPoint,
    canvas: CanvasEnvelope,
  ) => Promise<void>
  onSourcePlacementConsumed: (requestId: string) => void
  onPendingDropRetry: () => void
  onPendingDropDismiss: () => void
  onAtlasDropImport: (
    plan: AtlasDropImportPlan,
    point: ReferencePlacementPoint,
    canvas: CanvasEnvelope,
  ) => Promise<void>
  onAtlasDropImportError: (message: string) => void
  onPlacementRemovalComplete: (completion: PlacementRemovalCompletion) => void
  onPlacementRemovalError: (operationId: string, message: string, retryable: boolean) => void
  onRemoveFrame: (frame: CanvasSnapshotFrame) => void
  onOpenList: () => void
  canvasMutationsBlocked: boolean
  onCanvasAccepted: (canvas: CanvasEnvelope) => void
  onPendingWorkReaderChange: (reader: CanvasConvergenceReader | null) => void
}) {
  const runtimeProjectionRef = useRef(projection)
  runtimeProjectionRef.current = projection
  const runtimeIdentity = `${workspaceId}:${initialCanvas?.canvasId || "local"}`
  const runtime = useMemo(() => {
    void runtimeIdentity
    return createAtlasRuntime(runtimeProjectionRef.current, defaultSelectionRef)
  }, [defaultSelectionRef, runtimeIdentity])
  const [lodLevel, setLodLevel] = useState<AtlasLodLevel>(() => (
    initialAtlasConstellationLevel(runtime.store.getCamera().z)
  ))
  const lodLevelRef = useRef(lodLevel)
  lodLevelRef.current = lodLevel
  const activeStore = lodLevel === "atomic"
    ? runtime.store
    : runtime.constellations[lodLevel].store
  const overviewCounts = projection.placements.reduce(
    (counts, placement) => {
      counts.total += 1
      if (placement.authorized && placement.availability !== "unavailable") counts.readable += 1
      else counts.unavailable += 1
      return counts
    },
    { total: 0, readable: 0, unavailable: 0 },
  )
  const [renderer, setRenderer] = useState<Renderer | null>(null)
  const [canvas, setCanvas] = useState(initialCanvas)
  const [notice, setNotice] = useState<PersistenceNotice>({
    state: initialCanvas ? "saved" : "local",
    message: preview
      ? "Preview fixture · placement changes stay local"
      : initialCanvas
        ? `Durable layout v${initialCanvas.version}`
        : "Move a card to create the durable layout",
  })
  const canvasRef = useRef(initialCanvas)
  const baseProjectionRef = useRef(baseProjection)
  baseProjectionRef.current = baseProjection
  const creatingRef = useRef<Promise<CanvasEnvelope> | null>(null)
  const pendingRef = useRef(new Map<string, PlacementGeometry>())
  const inFlightRef = useRef(new Map<string, PlacementGeometry>())
  const retryRef = useRef<{
    entries: [string, PlacementGeometry][]
    idempotencyKey: string
  } | null>(null)
  const pendingFrameRef = useRef(new Map<string, AtlasFrameGeometry>())
  const inFlightFrameRef = useRef(new Map<string, AtlasFrameGeometry>())
  const retryFrameRef = useRef<{
    entries: [string, AtlasFrameGeometry][]
    idempotencyKey: string
  } | null>(null)
  const interactionPendingRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const atlasSurfaceRef = useRef<HTMLDivElement | null>(null)
  const atlasSaveStatusRef = useRef<HTMLDivElement | null>(null)
  const atlasScaleStatusRef = useRef<HTMLDivElement | null>(null)
  const savingRef = useRef(false)
  const dropOperationLockRef = useRef<ReturnType<typeof createAtlasDropOperationLock> | null>(null)
  if (!dropOperationLockRef.current) dropOperationLockRef.current = createAtlasDropOperationLock()
  const dropOperationLock = dropOperationLockRef.current
  const handledSourcePlacementRequestRef = useRef<string | null>(null)
  const atlasDropCallbacksRef = useRef<AtlasDropCallbacks | null>(null)
  const suppressRef = useRef(false)
  const referenceOperationRef = useRef<string | null>(null)
  const removalOperationRef = useRef<string | null>(null)
  const referencePlacementRequestRef = useRef(referencePlacementRequest)
  referencePlacementRequestRef.current = referencePlacementRequest
  const placementRemovalRequestRef = useRef(placementRemovalRequest)
  placementRemovalRequestRef.current = placementRemovalRequest
  const flushPlacementsRef = useRef<() => void>(() => undefined)
  const flushFramesRef = useRef<() => void>(() => undefined)
  const renderCustomNode = useCallback(
    (id: NodeId) => (
      <GalaxyCanvasNodeView
        id={id}
        hydrationByReference={hydrationByReference}
        exactRepresentationAuthorizationScope={exactRepresentationAuthorizationScope}
      />
    ),
    [exactRepresentationAuthorizationScope, hydrationByReference],
  )
  const hasPendingCanvasChanges = useCallback(() => (
    savingRef.current
    || pendingRef.current.size > 0
    || inFlightRef.current.size > 0
    || retryRef.current !== null
    || pendingFrameRef.current.size > 0
    || inFlightFrameRef.current.size > 0
    || retryFrameRef.current !== null
    || interactionPendingRef.current
    || dropOperationLock.active()
    || referencePlacementRequestRef.current !== null
    || placementRemovalRequestRef.current !== null
  ), [dropOperationLock])

  useLayoutEffect(() => {
    onPendingWorkReaderChange(() => ({
      canvas: canvasRef.current,
      pendingWork: hasPendingCanvasChanges(),
    }))
    return () => onPendingWorkReaderChange(null)
  }, [hasPendingCanvasChanges, onPendingWorkReaderChange])

  useEffect(() => {
    const stores = [
      runtime.store,
      runtime.constellations.far.store,
      runtime.constellations.medium.store,
    ]
    let synchronizing = false
    let pendingLevel = lodLevelRef.current
    let scheduledFrame: number | null = null
    const commitPendingLevel = () => {
      scheduledFrame = null
      if (stores.some((store) => store.getInteractionState().mode !== "idle")) return
      if (pendingLevel === lodLevelRef.current) return
      lodLevelRef.current = pendingLevel
      setLodLevel(pendingLevel)
    }
    const schedulePendingLevel = () => {
      if (scheduledFrame !== null) return
      scheduledFrame = window.requestAnimationFrame(commitPendingLevel)
    }
    const unsubscribers = stores.map((source) => source.subscribe("camera", (camera) => {
      if (synchronizing) return
      synchronizing = true
      try {
        for (const target of stores) {
          if (target === source || cameraEqual(target.getCamera(), camera)) continue
          target.setCamera(camera)
        }
      } finally {
        synchronizing = false
      }
      pendingLevel = nextAtlasConstellationLevel(camera.z, lodLevelRef.current)
      schedulePendingLevel()
    }))
    const interactionUnsubscribers = stores.map((store) => store.subscribe("interaction", (interaction) => {
      if (interaction.mode === "idle") schedulePendingLevel()
    }))
    const camera = runtime.store.getCamera()
    for (const target of stores.slice(1)) target.setCamera(camera)
    const initialLevel = initialAtlasConstellationLevel(camera.z)
    lodLevelRef.current = initialLevel
    setLodLevel(initialLevel)
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
      for (const unsubscribe of interactionUnsubscribers) unsubscribe()
      if (scheduledFrame !== null) window.cancelAnimationFrame(scheduledFrame)
    }
  }, [runtime])

  useLayoutEffect(() => {
    return commitAtlasDropCallbacks(atlasDropCallbacksRef, {
      onImport: onAtlasDropImport,
      onError: onAtlasDropImportError,
    })
  }, [onAtlasDropImport, onAtlasDropImportError])

  useEffect(() => {
    suppressRef.current = true
    try {
      replaceAtlasRuntimeProjection(
        runtime,
        applyFrameGeometryOverrides(
          applyCanvasPlacementOverrides(projection, new Map([
            ...inFlightRef.current,
            ...pendingRef.current,
          ])),
          new Map([...inFlightFrameRef.current, ...pendingFrameRef.current]),
        ),
      )
    } finally {
      suppressRef.current = false
    }
  }, [projection, runtime])

  useEffect(() => {
    if (!focusPlacementId) return
    const node = runtime.sourceStore.getAllNodes().find((candidate) => {
      const data = candidate.data as Partial<GalaxyCanvasNodeData> | undefined
      return data?.schemaId === "gb.canvas.node.v1" && data.placementId === focusPlacementId
    })
    if (!node) {
      if (consumeMissingRelationFocus) onFocusPlacementConsumed(focusPlacementId)
      return
    }
    runtime.store.setSelection([node.id])
    runtime.store.setCamera(cameraForAtlasNodes(runtime.sourceStore.getAllNodes(), node.id))
    window.requestAnimationFrame(() => {
      atlasSurfaceRef.current
        ?.querySelector<HTMLElement>("[data-canvas-host]")
        ?.focus({ preventScroll: true })
    })
    onFocusPlacementConsumed(focusPlacementId)
  }, [consumeMissingRelationFocus, focusPlacementId, onFocusPlacementConsumed, projection, runtime.sourceStore, runtime.store])

  useEffect(() => {
    canvasRef.current = initialCanvas
    setCanvas(initialCanvas)
    setNotice({
      state: initialCanvas ? "saved" : "local",
      message: preview
        ? "Preview fixture · placement changes stay local"
        : initialCanvas
          ? `Durable layout v${initialCanvas.version}`
          : "Move a card to create the durable layout",
    })
  }, [initialCanvas, preview])

  const ensureCanvas = useCallback(async () => {
    if (canvasRef.current) return canvasRef.current
    if (!creatingRef.current) {
      creatingRef.current = galaxyBrainAPI.createCanvas({
        workspaceId,
        slug: "main",
        title: `${workspaceName} atlas`,
        makeDefault: true,
        idempotencyKey: `canvas-create:${workspaceId}`,
      }).finally(() => {
        creatingRef.current = null
      })
    }
    const created = await creatingRef.current
    canvasRef.current = created
    setCanvas(created)
    return created
  }, [workspaceId, workspaceName])

  const applyAuthoritativeSnapshot = useCallback((authoritative: CanvasEnvelope) => {
    suppressRef.current = true
    try {
      replaceAtlasRuntimeProjection(
        runtime,
        applyFrameGeometryOverrides(
          mergeCanvasSnapshotWithPlacementOverrides(
            baseProjectionRef.current,
            authoritative.content,
            new Map([...inFlightRef.current, ...pendingRef.current]),
          ),
          new Map([...inFlightFrameRef.current, ...pendingFrameRef.current]),
        ),
      )
    } finally {
      suppressRef.current = false
    }
    onCanvasAccepted(authoritative)
  }, [onCanvasAccepted, runtime])

  const publishReferencePlacement = useCallback((
    authoritative: CanvasEnvelope,
    item: CanvasSnapshotItem,
    operationId: string,
  ) => {
    canvasRef.current = authoritative
    setCanvas(authoritative)
    applyAuthoritativeSnapshot(authoritative)
    const geometryPending = pendingRef.current.size > 0 || inFlightRef.current.size > 0 || Boolean(retryRef.current)
    setNotice(geometryPending
      ? { state: "saving", message: "Reference placed; saving placement changes…" }
      : { state: "saved", message: `Durable layout v${authoritative.version}` })
    onReferencePlacementComplete({
      operationId,
      subjectRef: item.subjectRef,
      placementId: item.id,
      canvas: authoritative,
    })
  }, [applyAuthoritativeSnapshot, onReferencePlacementComplete])

  const publishPlacementRemoval = useCallback((
    authoritative: CanvasEnvelope,
    operationId: string,
    placementId: string,
  ) => {
    canvasRef.current = authoritative
    setCanvas(authoritative)
    applyAuthoritativeSnapshot(authoritative)
    setNotice({ state: "saved", message: `Durable layout v${authoritative.version}` })
    onPlacementRemovalComplete({ operationId, placementId, canvas: authoritative })
  }, [applyAuthoritativeSnapshot, onPlacementRemovalComplete])

  const referencePlacementCallbacksRef = useRef<{
    ensureCanvas: typeof ensureCanvas
    onError: typeof onReferencePlacementError
    onTarget: typeof onReferencePlacementTarget
    publish: typeof publishReferencePlacement
  } | null>(null)
  useLayoutEffect(() => {
    const callbacks = {
      ensureCanvas,
      onError: onReferencePlacementError,
      onTarget: onReferencePlacementTarget,
      publish: publishReferencePlacement,
    }
    referencePlacementCallbacksRef.current = callbacks
    return () => {
      if (referencePlacementCallbacksRef.current === callbacks) referencePlacementCallbacksRef.current = null
    }
  }, [ensureCanvas, onReferencePlacementError, onReferencePlacementTarget, publishReferencePlacement])

  useEffect(() => {
    const request = referencePlacementRequest
    const requestKey = request ? `${request.operationId}:${request.attempt}` : null
    if (!request || referenceOperationRef.current === requestKey) return
    referenceOperationRef.current = requestKey
    const activeRequest = request
    let cancelled = false

    async function execute() {
      if (preview) throw new Error("Reference placement is unavailable in preview mode.")
      if (
        savingRef.current
        || retryRef.current
        || pendingRef.current.size > 0
        || inFlightRef.current.size > 0
      ) {
        throw new Error("Wait for the current placement save to finish, then try again.")
      }
      savingRef.current = true
      setNotice({ state: "saving", message: "Placing canonical reference…" })
      try {
        const callbacks = referencePlacementCallbacksRef.current
        if (!callbacks) throw new Error("Reference placement callbacks are unavailable.")
        const current = await callbacks.ensureCanvas()
        if (cancelled || !referencePlacementCallbacksRef.current) return
        callbacks.onTarget(activeRequest.operationId, current.canvasId)
        const transport = {
          current,
          subjectRef: activeRequest.subjectRef,
          operationId: activeRequest.operationId,
          point: activeRequest.point,
          mutateCanvas: (canvasId: string, input: Parameters<typeof galaxyBrainAPI.mutateCanvas>[1]) => galaxyBrainAPI.mutateCanvas(canvasId, input),
          reloadCanvas: (canvasId: string) => galaxyBrainAPI.getCanvas(canvasId),
        }
        const result = activeRequest.ink
          ? await reconcileInkPlacement({ ...transport, descriptor: activeRequest.ink })
          : await reconcileReferencePlacement(transport)
        if (!cancelled) referencePlacementCallbacksRef.current?.publish(result.canvas, result.item, activeRequest.operationId)
      } finally {
        savingRef.current = false
        if (pendingRef.current.size > 0 && !retryRef.current) {
          window.setTimeout(() => flushPlacementsRef.current(), 0)
        }
      }
    }

    void execute().catch(() => {
      const callbacks = referencePlacementCallbacksRef.current
      if (cancelled || !callbacks) return
      setNotice({ state: "reference-error", message: "Reference placement outcome could not be confirmed." })
      callbacks.onError(
        activeRequest.operationId,
        "The placement outcome could not be confirmed. Retry to reconcile the same operation safely.",
      )
    })
    return () => {
      cancelled = true
    }
  }, [
    preview,
    referencePlacementRequest,
  ])

  useEffect(() => {
    const request = placementRemovalRequest
    const requestKey = request ? `${request.operationId}:${request.attempt}` : null
    if (!request || removalOperationRef.current === requestKey) return
    removalOperationRef.current = requestKey
    const activeRequest = request
    let cancelled = false

    async function execute() {
      if (preview) throw new Error("Placement removal is unavailable in preview mode.")
      if (
        savingRef.current
        || retryRef.current
        || pendingRef.current.size > 0
        || inFlightRef.current.size > 0
      ) {
        throw new Error("Wait for the current placement save to finish, then try again.")
      }
      savingRef.current = true
      setNotice({ state: "saving", message: "Removing placement from this Atlas…" })
      try {
        const current = await ensureCanvas()
        const result = await reconcilePlacementRemoval({
          current,
          placementId: activeRequest.placementId,
          subjectRef: activeRequest.subjectRef,
          operationId: activeRequest.operationId,
          mutateCanvas: (canvasId, input) => galaxyBrainAPI.mutateCanvas(canvasId, input),
          reloadCanvas: (canvasId) => galaxyBrainAPI.getCanvas(canvasId),
        })
        if (!cancelled) publishPlacementRemoval(result.canvas, activeRequest.operationId, result.placementId)
      } finally {
        savingRef.current = false
      }
    }

    void execute().catch((error: unknown) => {
      if (cancelled) return
      const message = error instanceof Error ? error.message : ""
      if (message === "Wait for the current placement save to finish, then try again.") {
        setNotice({ state: "saving", message })
        onPlacementRemovalError(activeRequest.operationId, message, false)
        return
      }
      if (error instanceof PlacementRemovalConflictError) {
        const conflictMessage = "This placement changed before it could be removed. Close the dialog and select it again."
        setNotice({ state: "removal-error", message: "Placement changed; removal was stopped." })
        onPlacementRemovalError(activeRequest.operationId, conflictMessage, false)
        return
      }
      setNotice({ state: "removal-error", message: "Placement removal outcome could not be confirmed." })
      onPlacementRemovalError(
        activeRequest.operationId,
        "The removal outcome could not be confirmed. Retry to reconcile the same operation safely.",
        true,
      )
    })
    return () => {
      cancelled = true
    }
  }, [
    ensureCanvas,
    onPlacementRemovalError,
    placementRemovalRequest,
    preview,
    publishPlacementRemoval,
  ])

  const persistEntries = useCallback(async (
    entries: [string, PlacementGeometry][],
    idempotencyKey = crypto.randomUUID(),
  ) => {
    if (entries.length === 0 || savingRef.current) return
    savingRef.current = true
    for (const [placementId, geometry] of entries) {
      inFlightRef.current.set(placementId, geometry)
    }
    setNotice({ state: "saving", message: "Saving placement changes…" })
    try {
      const current = await ensureCanvas()
      const commands = entries.flatMap(([placementId, geometry]) =>
        commandsForPlacementGeometry(current.content, projection, placementId, geometry),
      )
      if (commands.length === 0) {
        for (const [placementId] of entries) inFlightRef.current.delete(placementId)
        applyAuthoritativeSnapshot(current)
        retryRef.current = null
        setNotice({ state: "saved", message: `Durable layout v${current.version}` })
        return
      }
      const updated = await galaxyBrainAPI.mutateCanvas(current.canvasId, {
        expectedVersion: current.version,
        expectedContentHash: current.contentHash,
        idempotencyKey,
        commands,
      })
      canvasRef.current = updated
      setCanvas(updated)
      for (const [placementId] of entries) inFlightRef.current.delete(placementId)
      applyAuthoritativeSnapshot(updated)
      retryRef.current = null
      setNotice({ state: "saved", message: `Durable layout v${updated.version}` })
    } catch (error) {
      if (error instanceof GalaxyBrainAPIError && error.status === 409 && canvasRef.current) {
        try {
          const latest = await galaxyBrainAPI.getCanvas(canvasRef.current.canvasId)
          canvasRef.current = latest
          setCanvas(latest)
          applyAuthoritativeSnapshot(latest)
          retryRef.current = { entries, idempotencyKey: crypto.randomUUID() }
          setNotice({ state: "conflict", message: `Layout changed elsewhere; reloaded v${latest.version}` })
        } catch (reloadError) {
          retryRef.current = { entries, idempotencyKey }
          setNotice({
            state: "error",
            message: reloadError instanceof Error ? reloadError.message : "Unable to reload the durable layout",
          })
        }
      } else {
        retryRef.current = { entries, idempotencyKey }
        setNotice({ state: "error", message: error instanceof Error ? error.message : "Unable to save the layout" })
      }
    } finally {
      savingRef.current = false
      if (!retryFrameRef.current && pendingFrameRef.current.size > 0) {
        window.setTimeout(() => flushFramesRef.current(), 0)
      }
    }
  }, [applyAuthoritativeSnapshot, ensureCanvas, projection])

  const flushPlacements = useCallback(() => {
    if (savingRef.current || retryRef.current || pendingRef.current.size === 0) return
    const entries = [...pendingRef.current.entries()].slice(0, 20)
    for (const [placementId] of entries) pendingRef.current.delete(placementId)
    void persistEntries(entries).finally(() => {
      if (!retryRef.current && pendingRef.current.size > 0) window.setTimeout(flushPlacements, 0)
    })
  }, [persistEntries])
  flushPlacementsRef.current = flushPlacements

  const persistFrameEntries = useCallback(async (
    entries: [string, AtlasFrameGeometry][],
    idempotencyKey = crypto.randomUUID(),
  ) => {
    if (entries.length === 0 || savingRef.current) return
    savingRef.current = true
    for (const [frameId, geometry] of entries) inFlightFrameRef.current.set(frameId, geometry)
    setNotice({ state: "saving", message: "Saving frame changes…" })
    try {
      const current = await ensureCanvas()
      const commands = entries.flatMap(([frameId, geometry]) => commandsForFrameGeometry(current.content, frameId, geometry))
      if (commands.length === 0) {
        for (const [frameId] of entries) inFlightFrameRef.current.delete(frameId)
        applyAuthoritativeSnapshot(current)
        retryFrameRef.current = null
        setNotice({ state: "saved", message: `Durable layout v${current.version}` })
        return
      }
      const updated = await galaxyBrainAPI.mutateCanvas(current.canvasId, {
        expectedVersion: current.version,
        expectedContentHash: current.contentHash,
        idempotencyKey,
        commands,
      })
      canvasRef.current = updated
      setCanvas(updated)
      for (const [frameId] of entries) inFlightFrameRef.current.delete(frameId)
      applyAuthoritativeSnapshot(updated)
      retryFrameRef.current = null
      setNotice({ state: "saved", message: `Durable layout v${updated.version}` })
    } catch (error) {
      if (error instanceof GalaxyBrainAPIError && error.status === 409 && canvasRef.current) {
        try {
          const latest = await galaxyBrainAPI.getCanvas(canvasRef.current.canvasId)
          canvasRef.current = latest
          setCanvas(latest)
          applyAuthoritativeSnapshot(latest)
          // A 409 proves the attempted version was not committed. Only after
          // accepting that authoritative head may a new request identity be
          // minted for the rebased geometry.
          retryFrameRef.current = { entries, idempotencyKey: crypto.randomUUID() }
          setNotice({ state: "conflict", message: `Layout changed elsewhere; reloaded v${latest.version}` })
        } catch (reloadError) {
          retryFrameRef.current = { entries, idempotencyKey }
          setNotice({ state: "error", message: reloadError instanceof Error ? reloadError.message : "Unable to reload the durable layout" })
        }
      } else {
        // Timeouts, rate limits, and 5xx responses are ambiguous. Replay the
        // exact request key until the server outcome is reconciled.
        retryFrameRef.current = { entries, idempotencyKey }
        setNotice({ state: "error", message: error instanceof Error ? error.message : "Unable to save frame changes" })
      }
    } finally {
      savingRef.current = false
      if (!retryRef.current && pendingRef.current.size > 0) {
        window.setTimeout(() => flushPlacementsRef.current(), 0)
      }
    }
  }, [applyAuthoritativeSnapshot, ensureCanvas])

  const flushFrames = useCallback(() => {
    if (savingRef.current || retryFrameRef.current || pendingFrameRef.current.size === 0) return
    const entries = [...pendingFrameRef.current.entries()].slice(0, 20)
    for (const [frameId] of entries) pendingFrameRef.current.delete(frameId)
    void persistFrameEntries(entries)
  }, [persistFrameEntries])
  flushFramesRef.current = flushFrames

  useEffect(() => {
    if (!preview && pendingRef.current.size > 0 && timerRef.current === null) {
      timerRef.current = window.setTimeout(flushPlacements, 300)
    }
    const unsubscribeChange = runtime.store.subscribe("change", (batch) => {
      if (preview || suppressRef.current || batch.origin !== "local") return
      for (const operation of batch.ops) {
        if (operation.type !== "node.update") continue
        const node = runtime.store.getNode(operation.id)
        const data = node?.data as Partial<GalaxyCanvasNodeData> | Partial<GalaxyCanvasFrameData> | undefined
        if (!node) continue
        if (data?.schemaId === "gb.canvas.frame.v1" && data.frameId) {
          const bounded = frameGeometryFromNode(node)
          if (
            node.angle !== 0
            || node.x !== bounded.x
            || node.y !== bounded.y
            || node.w !== bounded.width
            || node.h !== bounded.height
          ) {
            suppressRef.current = true
            try {
              runtime.store.updateNode(node.id, {
                x: bounded.x,
                y: bounded.y,
                w: bounded.width,
                h: bounded.height,
                angle: 0,
              })
            } finally {
              suppressRef.current = false
            }
          }
          pendingFrameRef.current.set(data.frameId, bounded)
        } else if (data?.schemaId === "gb.canvas.node.v1" && data.placementId) {
          pendingRef.current.set(data.placementId, canvasNodeGeometry(node))
        }
      }
      if (pendingRef.current.size === 0 && pendingFrameRef.current.size === 0) return
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        flushPlacements()
        flushFrames()
      }, 300)
    })
    const unsubscribeInteraction = runtime.store.subscribe("interaction", (interaction) => {
      if (interaction.mode === "resizing" && interaction.resizeDraft && interaction.draggedIds.length === 1) {
        const node = runtime.store.getNode(interaction.draggedIds[0])
        const data = node?.data as Partial<GalaxyCanvasFrameData> | undefined
        if (data?.schemaId === "gb.canvas.frame.v1") {
          const bounded = clampAtlasFrameGeometry({
            x: interaction.resizeDraft.x,
            y: interaction.resizeDraft.y,
            width: interaction.resizeDraft.w,
            height: interaction.resizeDraft.h,
          })
          const handle = interaction.resizeHandle ?? ""
          const adjusted = {
            x: handle.includes("w")
              ? interaction.resizeDraft.x + interaction.resizeDraft.w - bounded.width
              : bounded.x,
            y: handle.includes("n")
              ? interaction.resizeDraft.y + interaction.resizeDraft.h - bounded.height
              : bounded.y,
            w: bounded.width,
            h: bounded.height,
            angle: 0,
          }
          if (
            adjusted.x !== interaction.resizeDraft.x
            || adjusted.y !== interaction.resizeDraft.y
            || adjusted.w !== interaction.resizeDraft.w
            || adjusted.h !== interaction.resizeDraft.h
            || interaction.resizeDraft.angle !== 0
          ) {
            runtime.store.setInteractionState({ resizeDraft: adjusted })
            return
          }
        }
      }
      interactionPendingRef.current = interaction.mode !== "idle"
      if (interaction.mode !== "idle" || (pendingRef.current.size === 0 && pendingFrameRef.current.size === 0)) return
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = null
      flushPlacements()
      flushFrames()
    })
    return () => {
      unsubscribeChange()
      unsubscribeInteraction()
      interactionPendingRef.current = false
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [flushFrames, flushPlacements, preview, runtime.store])

  const retryPersistence = useCallback(() => {
    const retry = retryRef.current
    if (retry) {
      retryRef.current = null
      void persistEntries(retry.entries, retry.idempotencyKey).finally(() => {
        if (!retryRef.current && pendingRef.current.size > 0) window.setTimeout(flushPlacements, 0)
      })
      return
    }
    const frameRetry = retryFrameRef.current
    if (!frameRetry) return
    retryFrameRef.current = null
    void persistFrameEntries(frameRetry.entries, frameRetry.idempotencyKey)
  }, [flushPlacements, persistEntries, persistFrameEntries])
  const changeZoom = useCallback((delta: number) => {
    const camera = runtime.store.getCamera()
    const bounds = atlasSurfaceRef.current?.getBoundingClientRect()
    const anchor = bounds
      ? { x: bounds.width / 2, y: bounds.height / 2 }
      : { x: 0, y: 0 }
    runtime.store.setCamera(zoomAtScreenPoint(
      camera,
      Math.max(0.08, Math.min(4, camera.z + delta)),
      anchor,
    ))
  }, [runtime.store])
  const panCamera = useCallback((direction: AtlasCameraPanDirection) => {
    runtime.store.setCamera(panAtlasCamera(runtime.store.getCamera(), direction))
  }, [runtime.store])
  const resetCamera = useCallback(() => {
    runtime.store.setCamera(cameraForAtlasNodes(runtime.sourceStore.getAllNodes(), runtime.store.getSelection()[0]))
  }, [runtime.sourceStore, runtime.store])
  const zoomToExactObjects = useCallback(() => {
    const camera = runtime.store.getCamera()
    const bounds = atlasSurfaceRef.current?.getBoundingClientRect()
    const anchor = bounds
      ? { x: bounds.width / 2, y: bounds.height / 2 }
      : { x: 0, y: 0 }
    runtime.store.setCamera(zoomAtScreenPoint(
      camera,
      ATLAS_CONSTELLATION_ZOOM.leaveMedium + 0.08,
      anchor,
    ))
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      atlasScaleStatusRef.current?.focus({ preventScroll: true })
    }))
  }, [runtime.store])
  const requestSelectedPlacementRemoval = useCallback((returnFocus: HTMLElement | null) => {
    if (!canRemovePlacement || lodLevelRef.current !== "atomic") return
    const selectedId = runtime.store.getSelection()[0]
    const selectedNode = selectedId ? runtime.store.getNode(selectedId as Node["id"]) : undefined
    const data = selectedNode?.data as GalaxyCanvasNodeData | GalaxyCanvasFrameData | undefined
    if (data?.schemaId === "gb.canvas.frame.v1") {
      const frame = projection.frames?.find((candidate) => candidate.id === data.frameId)
      if (frame) onRemoveFrame(frame)
      return
    }
    if (data?.schemaId !== "gb.canvas.node.v1") return
    onExecutePlacementCommand("placement.remove", {
      placementId: data.placementId,
      subjectRef: data.subjectRef,
      label: data.display.title || "Selected object",
      relationRef: null,
      relationUnavailableReason: "Wait for this object's exact pinned revision to resolve.",
      shareRef: null,
      shareUnavailableReason: "",
    }, returnFocus)
  }, [canRemovePlacement, onExecutePlacementCommand, onRemoveFrame, projection.frames, runtime.store])
  const blockMutationKeys = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const command = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    const target = event.target
    const editable = target instanceof HTMLElement
      && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
    if ((event.key === "Delete" || event.key === "Backspace") && !editable) {
      event.preventDefault()
      event.stopPropagation()
      const activeElement = document.activeElement
      const returnFocus = activeElement instanceof HTMLElement && activeElement !== document.body
        ? activeElement
        : event.currentTarget
      requestSelectedPlacementRemoval(returnFocus)
      return
    }
    if (command && ["v", "x", "z", "y"].includes(key)) {
      event.preventDefault()
      event.stopPropagation()
    }
  }, [requestSelectedPlacementRemoval])
  const handleFileDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = !preview && (hasAtlasObjectDrag(event.dataTransfer) || atlasDropImportRegistered())
      ? "copy"
      : "none"
  }, [preview])
  const blockFrameRotation = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (lodLevelRef.current !== "atomic") return
    const bounds = event.currentTarget.getBoundingClientRect()
    const camera = runtime.store.getCamera()
    const world = screenToWorld({ x: event.clientX - bounds.left, y: event.clientY - bounds.top }, camera)
    const selectedNodes = new Set<NodeId>()
    for (const id of runtime.store.getSelection()) {
      if (runtime.store.getNode(id as NodeId)) selectedNodes.add(id as NodeId)
    }
    const hit = hitTestAny(runtime.store, world, camera.z, selectedNodes)
    if (hit?.kind !== "rotate-handle") return
    const data = runtime.store.getNode(hit.nodeId)?.data as Partial<GalaxyCanvasFrameData> | undefined
    if (data?.schemaId !== "gb.canvas.frame.v1") return
    event.preventDefault()
    event.stopPropagation()
    event.nativeEvent.stopImmediatePropagation()
  }, [runtime.store])
  const handleFileDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const committedCallbacks = atlasDropCallbacksRef.current
    if (!committedCallbacks) return
    if (preview || savingRef.current || creatingRef.current || dropOperationLock.active() || retryRef.current
      || pendingRef.current.size > 0 || inFlightRef.current.size > 0
      || referencePlacementRequest || placementRemovalRequest || dropRecoveryBlocked) {
      committedCallbacks.onError(dropRecoveryBlocked
        ? "Finish or retry the pending dropped item before placing another."
        : "Wait for the live Atlas canvas to finish its current placement before importing.")
      return
    }
    try {
      const bounds = event.currentTarget.getBoundingClientRect()
      const point = atlasDropWorldPoint(
        { x: event.clientX, y: event.clientY },
        { left: bounds.left, top: bounds.top },
        activeStore.getCamera(),
      )
      if (hasAtlasObjectDrag(event.dataTransfer)) {
        const intent = parseAtlasObjectDrop(event.dataTransfer)
        onPendingDrop({
          kind: "object",
          label: intent.label,
          point,
          phase: "authorizing",
          message: "Checking current access and preparing this canvas…",
        })
        void dropOperationLock.run(async () => {
          const targetCanvas = await ensureCanvas()
          await onAtlasObjectDrop(intent, point, targetCanvas)
          await waitForAtlasDropPublication()
        }).catch(() => {
          committedCallbacks.onError("A durable authorized Atlas canvas could not be established. Nothing was placed.")
        })
        return
      }
      if (!atlasDropImportRegistered()) {
        committedCallbacks.onError("Document drop import is unavailable because its registered source is disabled.")
        return
      }
      const plan = planAtlasDropImport(event.dataTransfer)
      onPendingDrop({
        kind: "file",
        label: plan.title,
        point,
        phase: "authorizing",
        message: "Preparing this canvas for the exact original…",
      })
      void dropOperationLock.run(async () => {
        const targetCanvas = await authorizeAtlasDropImportTarget(plan, ensureCanvas)
        await atlasDropCallbacksRef.current?.onImport(plan, point, targetCanvas)
        await waitForAtlasDropPublication()
      }).catch((error: unknown) => {
        atlasDropCallbacksRef.current?.onError(error instanceof AtlasDropImportError
          ? error.message
          : "A durable authorized Atlas canvas could not be established. No document was uploaded.")
      })
    } catch (error) {
      committedCallbacks.onError(error instanceof AtlasDropImportError || error instanceof TypeError
        ? error.message
        : "The drop point is outside the supported Atlas canvas bounds.")
    }
  }, [activeStore, dropOperationLock, dropRecoveryBlocked, ensureCanvas, onAtlasObjectDrop, onPendingDrop, placementRemovalRequest, preview, referencePlacementRequest])

  useEffect(() => {
    if (!sourcePlacementRequest || handledSourcePlacementRequestRef.current === sourcePlacementRequest.requestId) return
    handledSourcePlacementRequestRef.current = sourcePlacementRequest.requestId
    onSourcePlacementConsumed(sourcePlacementRequest.requestId)
    if (preview || dropRecoveryBlocked || dropOperationLock.active()
      || referencePlacementRequestRef.current || placementRemovalRequestRef.current) {
      onAtlasDropImportError(dropRecoveryBlocked
        ? "Finish or retry the pending dropped item before placing another."
        : "Wait for the live Atlas canvas to finish its current placement before importing.")
      return
    }
    const surface = atlasSurfaceRef.current
    if (!surface) {
      onAtlasDropImportError("The Atlas viewport is not ready for centered placement.")
      return
    }
    const bounds = surface.getBoundingClientRect()
    let point: ReferencePlacementPoint
    try {
      point = atlasDropWorldPoint(
        { x: bounds.left + (bounds.width / 2), y: bounds.top + (bounds.height / 2) },
        { left: bounds.left, top: bounds.top },
        activeStore.getCamera(),
      )
    } catch {
      onAtlasDropImportError("The Atlas viewport center is outside the supported canvas bounds.")
      return
    }
    onPendingDrop({
      kind: "object",
      label: sourcePlacementRequest.intent.label,
      point,
      phase: "authorizing",
      message: "Checking current access and placing at the viewport center…",
    })
    void dropOperationLock.run(async () => {
      const targetCanvas = await ensureCanvas()
      await onAtlasObjectDrop(sourcePlacementRequest.intent, point, targetCanvas)
      await waitForAtlasDropPublication()
    }).then((started) => {
      if (!started) onAtlasDropImportError("Wait for the current dropped item before placing another.")
    }).catch(() => {
      onAtlasDropImportError("A durable authorized Atlas canvas could not be established. Nothing was placed.")
    })
  }, [
    activeStore,
    dropOperationLock,
    dropRecoveryBlocked,
    ensureCanvas,
    onAtlasDropImportError,
    onAtlasObjectDrop,
    onPendingDrop,
    onSourcePlacementConsumed,
    preview,
    sourcePlacementRequest,
  ])

  return (
    <CanvasProvider store={runtime.store}>
      <div className="atlas-canvas-layout" data-lod={lodLevel}>
        <CanvasProvider store={activeStore}>
          <div
            ref={atlasSurfaceRef}
            className={`atlas-canvas-viewport${canvasMutationsBlocked ? " pointer-events-none" : ""}`}
            aria-busy={canvasMutationsBlocked}
            onDragOverCapture={handleFileDragOver}
            onDropCapture={handleFileDrop}
            onKeyDownCapture={blockMutationKeys}
            onPointerDownCapture={blockFrameRotation}
          >
            <Canvas
              tool="select"
              background={{ color: "hsl(38 40% 96%)", pattern: "dots", gap: 24, patternColor: "hsl(41 25% 80%)" }}
              selectionColor="hsl(38 53% 54%)"
              maxDpr={1.5}
              onRenderer={setRenderer}
              renderCustomNodeView={lodLevel === "atomic" ? renderCustomNode : undefined}
            />
            {pendingDrop ? (
              <AtlasPendingDropCard
                pending={pendingDrop}
                retryable={pendingDropRetryable}
                onRetry={onPendingDropRetry}
                onDismiss={onPendingDropDismiss}
              />
            ) : null}
            {lodLevel === "atomic" ? (
              <AtlasSelectionHud
                viewportRef={atlasSurfaceRef}
                topObstacleRef={atlasSaveStatusRef}
                tasks={tasks}
                hydrationByReference={hydrationByReference}
                canRemovePlacement={canRemovePlacement}
                canComposeRelation={canComposeRelation}
                relationSource={relationSource}
                relationReferenceCounts={relationReferenceCounts}
                onExecuteTaskCommand={onExecuteTaskCommand}
                onExecutePlacementCommand={onExecutePlacementCommand}
                onRelationAction={onRelationAction}
              />
            ) : null}
            {lodLevel === "atomic" ? null : <ConstellationNavigator level={lodLevel} />}
            {showDiagnostics ? <Diagnostics renderer={renderer} metrics={runtime.metrics} /> : null}
            <div
              ref={atlasScaleStatusRef}
              tabIndex={-1}
              className="pointer-events-none absolute right-3 top-3 z-20 rounded-full border border-[#d8c8a6] bg-[#fffef9]/95 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[#315f49] shadow-sm backdrop-blur focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#315f49] focus-visible:ring-offset-2"
              aria-live="polite"
            >
              {lodLevel === "far" ? "Landscape" : lodLevel === "medium" ? "Field" : "Objects"}
            </div>
            <div ref={atlasSaveStatusRef} className="atlas-save-status" data-state={notice.state}>
              <span role="status" aria-live="polite" aria-atomic="true">
                {notice.message}
              </span>
              {notice.state === "conflict" || notice.state === "error" ? (
                <Button type="button" variant="outline" size="sm" onClick={retryPersistence}>Retry my placement</Button>
              ) : null}
              {canvas ? <span className="font-mono text-[10px]">{canvas.contentHash.slice(0, 18)}…</span> : null}
            </div>
            <div className="atlas-camera-controls" role="group" aria-label="Atlas camera controls">
              <div className="atlas-camera-pan-controls" role="group" aria-label="Pan Atlas without dragging">
                <Button className="atlas-camera-control col-start-2" type="button" variant="ghost" size="icon" aria-label="Pan Atlas up" onClick={() => panCamera("up")}><ArrowUp aria-hidden="true" /></Button>
                <Button className="atlas-camera-control col-start-1 row-start-2" type="button" variant="ghost" size="icon" aria-label="Pan Atlas left" onClick={() => panCamera("left")}><ArrowLeft aria-hidden="true" /></Button>
                <Button className="atlas-camera-control col-start-2 row-start-2" type="button" variant="ghost" size="icon" aria-label="Pan Atlas down" onClick={() => panCamera("down")}><ArrowDown aria-hidden="true" /></Button>
                <Button className="atlas-camera-control col-start-3 row-start-2" type="button" variant="ghost" size="icon" aria-label="Pan Atlas right" onClick={() => panCamera("right")}><ArrowRight aria-hidden="true" /></Button>
              </div>
              <div className="atlas-camera-zoom-controls" role="group" aria-label="Atlas zoom controls">
                <Button className="atlas-camera-control" type="button" variant="ghost" size="icon" aria-label="Zoom out" onClick={() => changeZoom(-0.15)}><Minus aria-hidden="true" /></Button>
                <Button className="atlas-camera-control" type="button" variant="ghost" size="icon" aria-label="Reset camera" onClick={resetCamera}><RotateCcw aria-hidden="true" /></Button>
                <Button className="atlas-camera-control" type="button" variant="ghost" size="icon" aria-label="Zoom in" onClick={() => changeZoom(0.15)}><Plus aria-hidden="true" /></Button>
              </div>
            </div>
            <div className="atlas-minimap">
              <Minimap width={190} height={130} position="bottom-right" viewportColor="#c79a4b" backgroundColor="#f9f6f1" borderColor="#d8c8a6" />
            </div>
          </div>
        </CanvasProvider>
        {lodLevel === "atomic" ? (
          <SelectionInspector
            tasks={tasks}
            hydrationByReference={hydrationByReference}
            exactRepresentationAuthorizationScope={exactRepresentationAuthorizationScope}
            canRemovePlacement={canRemovePlacement}
            canComposeRelation={canComposeRelation}
            relationSource={relationSource}
            relationReferenceCounts={relationReferenceCounts}
            onSelectedTaskChange={onSelectedTaskChange}
            onSelectedPlacementChange={onSelectedPlacementChange}
            onSelectedFrameChange={onSelectedFrameChange}
            onExecuteTaskCommand={onExecuteTaskCommand}
            onExecutePlacementCommand={onExecutePlacementCommand}
            onRelationAction={onRelationAction}
            onRemoveFrame={onRemoveFrame}
          />
        ) : (
          <AtlasOverviewPanel
            level={lodLevel}
            total={overviewCounts.total}
            readable={overviewCounts.readable}
            unavailable={overviewCounts.unavailable}
            onZoomToObjects={zoomToExactObjects}
            onOpenList={onOpenList}
          />
        )}
      </div>
    </CanvasProvider>
  )
}

function AccessibleAtlasList({
  headingRef,
  projection,
  hydrationByReference,
  tasks,
  canRemovePlacement,
  canComposeRelation,
  relationSource,
  relationReferenceCounts,
  onExecuteTaskCommand,
  onExecutePlacementCommand,
  onRelationAction,
  onFocusPlacement,
  onShareCanvasConversation,
  onRemoveFrame,
}: {
  headingRef: RefObject<HTMLHeadingElement | null>
  projection: GalaxyCanvasProjection
  hydrationByReference: AtlasHydrationLookup
  tasks: TaskSummary[]
  canRemovePlacement: boolean
  canComposeRelation: boolean
  relationSource: AtlasRelationEndpoint | null
  relationReferenceCounts: ReadonlyMap<string, number>
  onExecuteTaskCommand: (
    commandId: string,
    selection: SelectedTaskContext,
    trigger: HTMLButtonElement,
  ) => void
  onExecutePlacementCommand: (
    commandId: string,
    selection: SelectedPlacementContext,
    trigger: HTMLElement | null,
  ) => void
  onRelationAction: (selection: SelectedPlacementContext, trigger: HTMLElement | null) => void
  onFocusPlacement: (placementId: string) => void
  onShareCanvasConversation: (
    selection: SelectedPlacementContext,
    trigger: HTMLButtonElement,
  ) => void
  onRemoveFrame: (frame: CanvasSnapshotFrame) => void
}) {
  const empty = projection.placements.length === 0 && (projection.frames?.length ?? 0) === 0
  const placementsById = new Map<string, typeof projection.placements>()
  for (const placement of projection.placements) {
    const matches = placementsById.get(placement.id)
    if (matches) matches.push(placement)
    else placementsById.set(placement.id, [placement])
  }
  return (
    <>
    <header className="p-8 pb-0">
      <p className="research-kicker">Atlas index</p>
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="research-display mt-1 rounded-sm text-2xl font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Exact Atlas placements
      </h2>
      <p className="mt-2 text-sm text-[hsl(var(--field-muted))]">
        {projection.placements.length} placement{projection.placements.length === 1 ? "" : "s"} in the current authorized view.
      </p>
    </header>
    {empty ? (
      <p className="p-8 text-sm text-[#61766b]">No authorized resources are available in this workspace yet.</p>
    ) : null}
    {projection.frames?.length ? (
      <section className="p-8 pb-0" aria-labelledby="atlas-frame-list-heading">
        <h2 id="atlas-frame-list-heading" className="text-sm font-semibold text-[#31483d]">Presentation frames</h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {projection.frames.map((frame) => (
            <li key={frame.id} className="rounded-xl border border-[hsl(var(--field-border))] bg-[hsl(var(--field-panel))] p-4">
              <strong>{frame.title}</strong>
              <p className="mt-1 text-xs text-[#61766b]">{frame.tone} · {frame.width} × {frame.height}</p>
              <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => onRemoveFrame(frame)}>
                Remove frame
              </Button>
            </li>
          ))}
        </ul>
      </section>
    ) : null}
    <ol className="atlas-object-list">
      {projection.placements.map((placement) => {
        const hydration = hydrationByReference[placement.subjectRef]
        const data: GalaxyCanvasNodeData = {
          schemaId: "gb.canvas.node.v1",
          placementId: placement.id,
          subjectRef: placement.subjectRef,
          availability: placement.availability === "unavailable" ? "unavailable" : "resolved",
          display: placement.display || {
            title: "Unavailable reference",
            badges: ["Locked"],
          },
          placementState: {
            displayMode: placement.displayMode || "card",
            collapsed: placement.collapsed === true,
            style: placement.style || {},
          },
        }
        const contentAvailable = hydration
          ? hydration.status === "resolved"
          : data.availability === "resolved"
        const resolvedProjection = hydration?.status === "resolved"
          ? hydration.projection
          : contentAvailable
            ? safeLegacyCanvasProjection(placement.nodeType, data)
            : null
        const openAction = contentAvailable ? openActionForAtlasNode(data, hydration) : undefined
        const contextLensLinks = atlasContextLensLinks(data.subjectRef, hydration)
        const taskSelection = resolveAtlasTaskSelection({
          subjectRef: data.subjectRef,
          availability: data.availability,
          hydration,
          tasks,
        })
        const placementSelection = selectedPlacementContextForNode(data, hydration)
        const relationEligibility = atlasAuthoredRelationEligibility(
          placementSelection,
          relationReferenceCounts,
        )
        const parsedPlacementReference = parseGalaxyObjectReference(data.subjectRef)
        const canShareCanvasConversation = parsedPlacementReference?.format === "canonical"
          && parsedPlacementReference.kind === "chat"
          && parsedPlacementReference.selector.mode === "pinned"
        const ink = hydration?.status === "resolved" && resolvedProjection
          ? atlasInkDescriptor(data.placementState.style, data.subjectRef, resolvedProjection)
          : null
        return (
          <li key={placement.id}>
            {resolvedProjection ? (
              <ObjectProjectionHost
                projection={resolvedProjection}
                documentRevisionId={hydration?.status === "resolved" ? hydration.documentRevisionId : undefined}
                context="list"
                zoom={1.6}
                streamExactRepresentation={false}
                resolvedRepresentation={hydration ? undefined : resolvedCanvasNodeRepresentation(placement.nodeType, data)}
                surfaceSpec={hydration?.status === "resolved"
                  ? hydration.surfaceSpec
                  : hydration ? undefined : data.display.surfaceSpec}
                representationPreview={ink ? (
                  <InkPlacementPreview
                    descriptor={ink}
                    label={`${resolvedProjection.title} ink drawing`}
                    className="max-h-56 w-full"
                  />
                ) : undefined}
                actions={(
                  <div className="flex flex-wrap items-center gap-2">
                    {taskSelection ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="min-h-10"
                        aria-label={`Open task constructor for ${resolvedProjection.title}`}
                        onClick={(event) => onExecuteTaskCommand(
                          "task.plan.open",
                          taskSelection,
                          event.currentTarget,
                        )}
                      >
                        <Wrench className="h-4 w-4" aria-hidden="true" /> Open task constructor
                      </Button>
                    ) : null}
                    {canShareCanvasConversation ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="min-h-10"
                        aria-label={`Share this Atlas with ${resolvedProjection.title}`}
                        onClick={(event) => onShareCanvasConversation(
                          placementSelection,
                          event.currentTarget,
                        )}
                      >
                        <Share2 className="h-4 w-4" aria-hidden="true" /> Share Atlas + conversation
                      </Button>
                    ) : null}
                    {openAction ? (
                      <a className="font-semibold underline" href={openAction.href}>{openAction.label}</a>
                    ) : null}
                    <AtlasContextLensLinks
                      links={contextLensLinks}
                      ariaLabel={`Lenses for ${resolvedProjection.title}`}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="min-h-11"
                      disabled={!canComposeRelation || (!relationEligibility.ok && relationSource?.placementId !== placementSelection.placementId)}
                      onClick={(event) => onRelationAction(placementSelection, event.currentTarget)}
                    >
                      <Link2 className="h-4 w-4" aria-hidden="true" />
                      {relationSource?.placementId === placementSelection.placementId
                        ? "Cancel relation"
                        : relationEligibility.ok
                          ? relationSource
                            ? `Use ${resolvedProjection.title} as target`
                            : `Link from ${resolvedProjection.title}`
                          : relationEligibility.reason}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="min-h-10 border-[#b66238]/45 text-[#7f321c] hover:bg-[#b66238]/10 hover:text-[#7f321c]"
                      disabled={!canRemovePlacement}
                      aria-label={`Remove ${resolvedProjection.title} from this Atlas`}
                      onClick={(event) => onExecutePlacementCommand(
                        "placement.remove",
                        placementSelection,
                        event.currentTarget,
                      )}
                    >
                      <Unlink className="h-4 w-4" aria-hidden="true" /> Remove from Atlas
                    </Button>
                  </div>
                )}
              />
            ) : (
              <div className="space-y-3">
                <UnavailableCanvasObject />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-10 border-[#b66238]/45 text-[#7f321c] hover:bg-[#b66238]/10 hover:text-[#7f321c]"
                  disabled={!canRemovePlacement}
                  aria-label={`Remove ${placementSelection.label} from this Atlas`}
                  onClick={(event) => onExecutePlacementCommand(
                    "placement.remove",
                    placementSelection,
                    event.currentTarget,
                  )}
                >
                  <Unlink className="h-4 w-4" aria-hidden="true" /> Remove from Atlas
                </Button>
              </div>
            )}
          </li>
        )
      })}
    </ol>
    {projection.relations.length > 0 ? (
      <section className="p-8 pt-0" aria-labelledby="atlas-relation-list-heading">
        <h2 id="atlas-relation-list-heading" className="text-sm font-semibold text-[#31483d]">Authorized relations</h2>
        <ul className="mt-3 space-y-3">
          {projection.relations.map((relation) => {
            const source = resolveAtlasProjectedRelationEndpoint(
              relation,
              "source",
              (placementId) => placementsById.get(placementId),
            )
            const target = resolveAtlasProjectedRelationEndpoint(
              relation,
              "target",
              (placementId) => placementsById.get(placementId),
            )
            return (
              <li key={relation.id} className="rounded-xl border border-[hsl(var(--field-border))] bg-[hsl(var(--field-panel))] p-3 text-sm text-[hsl(var(--field-ink))]">
                <strong className="break-words">
                  {source?.label || "Unavailable source"}
                  {` ${relation.relationType.replaceAll("_", " ")} `}
                  {target?.label || "Unavailable target"}
                </strong>
                <p>{relation.trustClass} relation · {relation.owner}</p>
                <p>{relation.provenance}</p>
                <div className="mt-3 flex min-w-0 flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto min-h-11 min-w-0 max-w-full whitespace-normal break-words"
                    disabled={!source}
                    onClick={() => source && onFocusPlacement(source.placementId)}
                  >
                    Focus source{source ? `: ${source.label}` : ""}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto min-h-11 min-w-0 max-w-full whitespace-normal break-words"
                    disabled={!target}
                    onClick={() => target && onFocusPlacement(target.placementId)}
                  >
                    Focus target{target ? `: ${target.label}` : ""}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      </section>
    ) : null}
    </>
  )
}

export type AtlasV2ClientProps = {
  tenantId: string
  principalId: string
  initialAtlas?: LoadedAtlas
  mode?: "live" | "preview"
  defaultSelectionRef?: string
  headerSlot?: ReactNode
}

export function AtlasV2Client({
  tenantId,
  principalId,
  initialAtlas,
  mode = "live",
  defaultSelectionRef,
  headerSlot,
}: AtlasV2ClientProps) {
  const preview = mode === "preview"
  const searchParams = useSearchParams()
  const reactiveAtlasSearch = searchParams.toString()
  const exactRepresentationAuthorizationScope = useMemo(
    () => JSON.stringify([tenantId, principalId]),
    [principalId, tenantId],
  )
  const [atlas, setAtlas] = useState<LoadedAtlas | null>(initialAtlas ?? null)
  const [loading, setLoading] = useState(!initialAtlas)
  const [loadError, setLoadError] = useState("")
  const [mounted, setMounted] = useState(false)
  const [view, setView] = useState<AtlasView>("canvas")
  const [hudPinned, setHudPinned] = useState(true)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [reload, setReload] = useState(0)
  const [pendingInvalidation, setPendingInvalidation] = useState<CanvasInvalidationNotice | null>(null)
  const pendingInvalidationRef = useRef(pendingInvalidation)
  pendingInvalidationRef.current = pendingInvalidation
  const [selectedTaskContext, setSelectedTaskContext] = useState<SelectedTaskContext | null>(null)
  const [selectedPlacementContext, setSelectedPlacementContext] = useState<SelectedPlacementContext | null>(null)
  const [selectedFrameContext, setSelectedFrameContext] = useState<SelectedFrameContext | null>(null)
  const [commandDeckOpen, setCommandDeckOpen] = useState(false)
  const [canvasCreateOpen, setCanvasCreateOpen] = useState(false)
  const [canvasCreateBusy, setCanvasCreateBusy] = useState(false)
  const [frameCreateOpen, setFrameCreateOpen] = useState(false)
  const [frameMutationBusy, setFrameMutationBusy] = useState(false)
  const [frameMutationError, setFrameMutationError] = useState("")
  const [frameMutationOperation, setFrameMutationOperation] = useState<AtlasFrameMutationOperation | null>(null)
  const [hamMemoryOpen, setHamMemoryOpen] = useState(false)
  const [relationReviewOpen, setRelationReviewOpen] = useState(false)
  const [relationSource, setRelationSource] = useState<AtlasRelationEndpoint | null>(null)
  const [relationTarget, setRelationTarget] = useState<AtlasRelationEndpoint | null>(null)
  const [relationKind, setRelationKind] = useState<AtlasAuthoredRelation>("related")
  const [relationRequest, setRelationRequest] = useState<AtlasAuthoredRelationRequest | null>(null)
  const [relationComposeOpen, setRelationComposeOpen] = useState(false)
  const [relationComposeBusy, setRelationComposeBusy] = useState(false)
  const [relationComposeAmbiguous, setRelationComposeAmbiguous] = useState(false)
  const [relationComposeError, setRelationComposeError] = useState("")
  const [relationComposeReturnFocus, setRelationComposeReturnFocus] = useState<HTMLElement | null>(null)
  const relationModeReturnFocusRef = useRef<HTMLElement | null>(null)
  const relationModeCancelRef = useRef<HTMLButtonElement>(null)
  const [exactRelationRefreshEpoch, setExactRelationRefreshEpoch] = useState(0)
  const [experimentCreateOpen, setExperimentCreateOpen] = useState(false)
  const [experimentPlacementRecovery, setExperimentPlacementRecovery] = useState<ExperimentPlacementRecovery | null>(null)
  const [experimentPlacementError, setExperimentPlacementError] = useState("")
  const [constructorTask, setConstructorTask] = useState<TaskSummary | null>(null)
  const [constructorOpen, setConstructorOpen] = useState(false)
  const [constructorReturnFocus, setConstructorReturnFocus] = useState<HTMLElement | null>(null)
  const [legacyFlowPortabilityOpen, setLegacyFlowPortabilityOpen] = useState(false)
  const [referenceDialogOpen, setReferenceDialogOpen] = useState(false)
  const [formalPackageImportOpen, setFormalPackageImportOpen] = useState(false)
  const [formalPackagePlacement, setFormalPackagePlacement] = useState<FormalPackagePlacementRecovery | null>(null)
  const [formalPackagePlacementError, setFormalPackagePlacementError] = useState("")
  const [formalPackagePlacing, setFormalPackagePlacing] = useState(false)
  const [surfacePlaceOpen, setSurfacePlaceOpen] = useState(false)
  const [paperImportOpen, setPaperImportOpen] = useState(false)
  const [paperImportPhase, setPaperImportPhase] = useState<ArxivPaperImportPhase>("idle")
  const [paperImportError, setPaperImportError] = useState("")
  const [paperImportRecovery, setPaperImportRecovery] = useState<PaperImportPlacementRecovery | null>(null)
  const [webCaptureOpen, setWebCaptureOpen] = useState(false)
  const [webCapturePhase, setWebCapturePhase] = useState<AtlasWebCapturePhase>("idle")
  const [webCaptureError, setWebCaptureError] = useState("")
  const [webCaptureAmbiguous, setWebCaptureAmbiguous] = useState(false)
  const [webCaptureIntent, setWebCaptureIntent] = useState<AtlasWebCaptureIntent | null>(null)
  const [webCaptureRecovery, setWebCaptureRecovery] = useState<AtlasWebCapturePlacementRecovery | null>(null)
  const [referencePlacementRequest, setReferencePlacementRequest] = useState<ReferencePlacementRequest | null>(null)
  const [referencePlacementRetry, setReferencePlacementRetry] = useState<ReferencePlacementRequest | null>(null)
  const [referencePlacementError, setReferencePlacementError] = useState("")
  const [referencePlacementAnnouncement, setReferencePlacementAnnouncement] = useState("")
  const [canvasActionStatus, setCanvasActionStatus] = useState("")
  const relationModeAnnouncement = relationSource && !relationComposeOpen
    ? `Relation mode. From ${relationSource.label}. ${view === "list"
      ? "Choose another exact object from the list as the target."
      : "Select another exact object as the target."}`
    : ""
  const [referenceHandoff, setReferenceHandoff] = useState<ReferenceHandoffState | null>(null)
  const [referenceHandoffRecovery, setReferenceHandoffRecovery] = useState<AtlasReferenceHandoffPlacementRecovery | null>(null)
  const [referenceHandoffRecoveryWakeVersion, setReferenceHandoffRecoveryWakeVersion] = useState(0)
  const [referenceHandoffLocationVersion, setReferenceHandoffLocationVersion] = useState(0)
  const [documentImportOpen, setDocumentImportOpen] = useState(false)
  const [documentImportPhase, setDocumentImportPhase] = useState<DocumentImportPhase>("idle")
  const [documentImportError, setDocumentImportError] = useState("")
  const [documentIngestionNotice, setDocumentIngestionNotice] = useState("")
  const [documentImportErrorField, setDocumentImportErrorField] = useState<"file" | "title" | null>(null)
  const [documentImportAmbiguous, setDocumentImportAmbiguous] = useState(false)
  const [documentImportDraft, setDocumentImportDraft] = useState<DocumentImportDraft | null>(null)
  const [importedDocument, setImportedDocument] = useState<DurableDocumentImport | null>(null)
  const [documentImportRecovery, setDocumentImportRecovery] = useState<DocumentImportRecovery | null>(null)
  const [atlasDropImportPhase, setAtlasDropImportPhase] = useState<DocumentImportPhase>("idle")
  const [atlasDropImportRecovery, setAtlasDropImportRecovery] = useState<AtlasDropImportRecovery | null>(null)
  const [atlasDropImportError, setAtlasDropImportError] = useState("")
  const [atlasDropIngestionNotice, setAtlasDropIngestionNotice] = useState("")
  const [atlasDropImportLabel, setAtlasDropImportLabel] = useState("")
  const [atlasObjectDropRecovery, setAtlasObjectDropRecovery] = useState<AtlasObjectDropRecovery | null>(null)
  const [pendingDrop, setPendingDrop] = useState<AtlasPendingDrop | null>(null)
  const [sourcePlacementRequest, setSourcePlacementRequest] = useState<AtlasSourcePlacementRequest | null>(null)
  const [documentAnalysisState, setDocumentAnalysisState] = useState<DocumentAnalysisState | null>(null)
  const [documentAnalysisBusy, setDocumentAnalysisBusy] = useState(false)
  const [datasourceManagerOpen, setDatasourceManagerOpen] = useState(false)
  const [datasourcePlacementError, setDatasourcePlacementError] = useState("")
  const [importedDatasourceDocument, setImportedDatasourceDocument] = useState<DurableDocumentImport | null>(null)
  const [datasourceIngestionNotice, setDatasourceIngestionNotice] = useState("")
  const [inkDrawingOpen, setInkDrawingOpen] = useState(false)
  const [inkDrawingPhase, setInkDrawingPhase] = useState<InkDrawingPhase>("idle")
  const [inkDrawingError, setInkDrawingError] = useState("")
  const [inkDrawingAmbiguous, setInkDrawingAmbiguous] = useState(false)
  const [importedInkDocument, setImportedInkDocument] = useState<DurableDocumentImport | null>(null)
  const [importedInkPlacementId, setImportedInkPlacementId] = useState<string | null>(null)
  const [codeEditorOpen, setCodeEditorOpen] = useState(false)
  const [codeEditorPreset, setCodeEditorPreset] = useState<CodeEditorPreset>("code")
  const [codeSavePhase, setCodeSavePhase] = useState<CodeEditorSavePhase>("idle")
  const [codeSaveError, setCodeSaveError] = useState("")
  const [codeSaveAmbiguous, setCodeSaveAmbiguous] = useState(false)
  const [importedCodeDocument, setImportedCodeDocument] = useState<DurableDocumentImport | null>(null)
  const [importedCodePlacementId, setImportedCodePlacementId] = useState<string | null>(null)
  const [codeGraphSnapshotOpen, setCodeGraphSnapshotOpen] = useState(false)
  const [codeGraphSnapshotPhase, setCodeGraphSnapshotPhase] = useState<CodeGraphSnapshotImportPhase>("idle")
  const [codeGraphSnapshotError, setCodeGraphSnapshotError] = useState("")
  const [codeGraphSnapshotAmbiguous, setCodeGraphSnapshotAmbiguous] = useState(false)
  const [codeGraphSnapshotTarget, setCodeGraphSnapshotTarget] = useState<CodeGraphSnapshotTarget | null>(null)
  const [codeGraphSnapshotRecovery, setCodeGraphSnapshotRecovery] = useState<CodeGraphSnapshotRecovery | null>(null)
  const [markdownNotePhase, setMarkdownNotePhase] = useState<CodeEditorSavePhase>("idle")
  const [markdownNoteError, setMarkdownNoteError] = useState("")
  const [markdownNoteIngestionNotice, setMarkdownNoteIngestionNotice] = useState("")
  const [markdownNoteAmbiguous, setMarkdownNoteAmbiguous] = useState(false)
  const [markdownNoteTarget, setMarkdownNoteTarget] = useState<MarkdownNoteTarget | null>(null)
  const [markdownNoteRecovery, setMarkdownNoteRecovery] = useState<MarkdownNoteRecovery | null>(null)
  const [voiceCaptureOpen, setVoiceCaptureOpen] = useState(false)
  const [voiceSavePhase, setVoiceSavePhase] = useState<VoiceSavePhase>("idle")
  const [voiceSaveError, setVoiceSaveError] = useState("")
  const [voiceSaveAmbiguous, setVoiceSaveAmbiguous] = useState(false)
  const [importedVoiceDocument, setImportedVoiceDocument] = useState<DurableDocumentImport | null>(null)
  const [importedVoicePlacementId, setImportedVoicePlacementId] = useState<string | null>(null)
  const [voiceRecordingRecovery, setVoiceRecordingRecovery] = useState<VoiceRecordingDraft | null>(null)
  const [focusPlacementId, setFocusPlacementId] = useState<string>()
  const [relationFocusPlacementId, setRelationFocusPlacementId] = useState<string>()
  const [placementRemoveOpen, setPlacementRemoveOpen] = useState(false)
  const [placementRemoveTarget, setPlacementRemoveTarget] = useState<SelectedPlacementContext | null>(null)
  const [placementRemovalRequest, setPlacementRemovalRequest] = useState<PlacementRemovalRequest | null>(null)
  const [placementRemovalRetry, setPlacementRemovalRetry] = useState<PlacementRemovalRequest | null>(null)
  const [placementRemovalError, setPlacementRemovalError] = useState("")
  const [placementRemovalAnnouncement, setPlacementRemovalAnnouncement] = useState("")
  const [placementRemovalReturnFocus, setPlacementRemovalReturnFocus] = useState<HTMLElement | null>(null)
  const [shareBusy, setShareBusy] = useState(false)
  const [shareNotice, setShareNotice] = useState<AtlasShareNotice | null>(null)
  const [shareRetryRequest, setShareRetryRequest] = useState<AtlasShareRequest | null>(null)
  const [shareScopeOpen, setShareScopeOpen] = useState(false)
  const [shareScope, setShareScope] = useState<AtlasShareScope | null>(null)
  const [shareScopeRequest, setShareScopeRequest] = useState<AtlasShareRequest | null>(null)
  const [shareScopeReturnFocus, setShareScopeReturnFocus] = useState<HTMLElement | null>(null)
  const [hydrationState, setHydrationState] = useState<AtlasHydrationState>({
    key: null,
    byReference: EMPTY_ATLAS_HYDRATION,
  })
  const [hamRelationState, setHamRelationState] = useState<{
    key: string | null
    status: SourceState["status"]
    value?: HamRelationOverlayResponse
  }>({ key: null, status: "ready" })
  const hydrationGenerationRef = useRef(0)
  const referenceHandoffAbortRef = useRef<AbortController | null>(null)
  const referenceHandoffBusyRef = useRef(false)
  const referenceHandoffGenerationRef = useRef(0)
  const referenceHandoffOperationRef = useRef<string | null>(null)
  const referenceHandoffPlacementBindingRef = useRef<ReferenceHandoffState | null>(null)
  const referenceHandoffRecoveryRecordRef = useRef<AtlasReferenceHandoffPlacementRecovery | null>(null)
  const referenceHandoffRecoveryDismissedRef = useRef<string | null>(null)
  const preservedReferenceHandoffHrefRef = useRef<string | null>(null)
  const shareBusyRef = useRef(false)
  const documentImportBusyRef = useRef(false)
  const paperImportAbortRef = useRef<AbortController | null>(null)
  const relationComposeAbortRef = useRef<AbortController | null>(null)
  const exactRelationMutationGenerationRef = useRef(0)
  const paperImportGenerationRef = useRef(0)
  const webCaptureAbortRef = useRef<AbortController | null>(null)
  const webCaptureGenerationRef = useRef(0)
  const webCaptureFlightOwnerRef = useRef<number | null>(null)
  const atlasDropImportOwnerRef = useRef<ReturnType<typeof createAtlasDropImportOwner> | null>(null)
  if (!atlasDropImportOwnerRef.current) atlasDropImportOwnerRef.current = createAtlasDropImportOwner()
  const atlasDropImportOwner = atlasDropImportOwnerRef.current
  const atlasDropImportRecoveryRef = useRef<AtlasDropImportRecovery | null>(null)
  const atlasObjectDropRecoveryRef = useRef<AtlasObjectDropRecovery | null>(null)
  const documentImportAbortRef = useRef<AbortController | null>(null)
  const markdownNoteAbortRef = useRef<AbortController | null>(null)
  const codeGraphSnapshotAbortRef = useRef<AbortController | null>(null)
  const codeGraphSnapshotGenerationRef = useRef(0)
  const documentAnalysisAbortRef = useRef<AbortController | null>(null)
  const documentAnalysisGenerationRef = useRef(0)
  const documentAnalysisBusyRef = useRef(false)
  const currentAtlasTargetRef = useRef<{
    workspaceId: string
    canvasId: string | null
    ready: boolean
  }>({ workspaceId: "", canvasId: null, ready: false })
  const canvasConvergenceReaderRef = useRef<CanvasConvergenceReader | null>(null)
  const frameRecoveryAttemptRef = useRef<string | null>(null)
  const frameMutationBusyRef = useRef(false)
  const atlasLoadAbortRef = useRef<AbortController | null>(null)
  const atlasLoadGenerationRef = useRef(0)
  const focusAtlasAfterInvalidationRef = useRef(false)
  const commandTriggerRef = useRef<HTMLButtonElement>(null)
  const createHudTriggerRef = useRef<HTMLButtonElement>(null)
  const proofHudTriggerRef = useRef<HTMLButtonElement>(null)
  const voiceHudTriggerRef = useRef<HTMLButtonElement>(null)
  const commandPresenterReturnFocusRef = useRef<HTMLElement | null>(null)
  const atlasHeadingRef = useRef<HTMLHeadingElement>(null)
  const atlasListHeadingRef = useRef<HTMLHeadingElement>(null)
  const focusListAfterViewChangeRef = useRef(false)
  const loadErrorHeadingRef = useRef<HTMLHeadingElement>(null)
  const experimentRecoveryScope = useMemo(
    () => ({ tenantId, principalId }),
    [principalId, tenantId],
  )
  const paperImportRecoveryScope = experimentRecoveryScope
  const webCaptureRecoveryScope = experimentRecoveryScope
  const referenceHandoffRecoveryScope = experimentRecoveryScope
  const activeAtlasWorkspaceId = atlas?.workspaceId ?? null
  const canvasCreateScope = useMemo(() => atlas ? ({
    tenantId,
    principalId,
    workspaceId: atlas.workspaceId,
  }) : null, [atlas, principalId, tenantId])
  const frameMutationScope = useMemo<AtlasFrameMutationScope | null>(() => atlas?.durableCanvas ? ({
    tenantId,
    principalId,
    workspaceId: atlas.workspaceId,
    canvasId: atlas.durableCanvas.canvasId,
  }) : null, [atlas?.durableCanvas, atlas?.workspaceId, principalId, tenantId])

  useEffect(() => () => {
    codeGraphSnapshotAbortRef.current?.abort()
    codeGraphSnapshotAbortRef.current = null
    codeGraphSnapshotGenerationRef.current += 1
  }, [])

  useEffect(() => {
    webCaptureAbortRef.current?.abort()
    webCaptureAbortRef.current = null
    webCaptureGenerationRef.current += 1
    setWebCaptureOpen(false)
    setWebCapturePhase("idle")
    setWebCaptureError("")
    setWebCaptureAmbiguous(false)
    setWebCaptureIntent(null)
    setWebCaptureRecovery(null)
  }, [webCaptureRecoveryScope])

  useEffect(() => () => {
    paperImportAbortRef.current?.abort()
    relationComposeAbortRef.current?.abort()
    paperImportGenerationRef.current += 1
    webCaptureAbortRef.current?.abort()
    webCaptureGenerationRef.current += 1
    documentImportAbortRef.current?.abort()
    markdownNoteAbortRef.current?.abort()
    atlasDropImportOwner.abort()
    documentAnalysisAbortRef.current?.abort()
    documentAnalysisGenerationRef.current += 1
    referenceHandoffAbortRef.current?.abort()
    referenceHandoffGenerationRef.current += 1
  }, [atlasDropImportOwner])

  const replaceDocumentAnalysisState = useCallback((next: DocumentAnalysisState | null) => {
    documentAnalysisAbortRef.current?.abort()
    documentAnalysisAbortRef.current = null
    documentAnalysisGenerationRef.current += 1
    documentAnalysisBusyRef.current = false
    setDocumentAnalysisBusy(false)
    setDocumentAnalysisState(next)
  }, [])
  const codeDraftScope = useMemo<CodeEditorDraftScope | null>(() => {
    if (!atlas) return null
    return {
      tenantId,
      principalId,
      workspaceId: atlas.workspaceId,
      canvasId: atlas.durableCanvas?.canvasId || `local:${atlas.workspaceId}`,
    }
  }, [atlas, principalId, tenantId])
  const codeDraftAllowsWorkspaceFallback = Boolean(!atlas?.durableCanvas || atlas.durableCanvas.isDefault)
  useEffect(() => setMounted(true), [])
  const clearReferenceHandoffLocation = useCallback((preserveDialog: boolean) => {
    if (typeof window === "undefined") return
    const nextHref = clearAtlasReferenceHandoffHref(window.location.href)
    preservedReferenceHandoffHrefRef.current = preserveDialog ? nextHref : null
    const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (nextHref !== currentHref) {
      window.history.replaceState(window.history.state, "", nextHref)
    }
    setReferenceHandoffLocationVersion((value) => value + 1)
  }, [])

  const cancelReferenceHandoff = useCallback(() => {
    if (
      referenceHandoffRecovery
      && referenceHandoff?.operationId === referenceHandoffRecovery.operationId
    ) {
      referenceHandoffRecoveryDismissedRef.current = referenceHandoffRecovery.operationId
    }
    referenceHandoffAbortRef.current?.abort()
    referenceHandoffAbortRef.current = null
    referenceHandoffBusyRef.current = false
    referenceHandoffGenerationRef.current += 1
    referenceHandoffOperationRef.current = null
    referenceHandoffPlacementBindingRef.current = null
    preservedReferenceHandoffHrefRef.current = null
    setReferenceHandoff(null)
    clearReferenceHandoffLocation(false)
  }, [clearReferenceHandoffLocation, referenceHandoff, referenceHandoffRecovery])

  useEffect(() => {
    const onPopState = () => {
      preservedReferenceHandoffHrefRef.current = null
      setReferenceHandoffLocationVersion((value) => value + 1)
    }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [])

  useEffect(() => {
    if (preview || typeof window === "undefined") return
    // useSearchParams makes App Router navigations reactive, while the live
    // location remains authoritative after our history-preserving replaceState.
    const parsed = parseAtlasReferenceHandoff(window.location.search)
    if (parsed.state === "none") {
      const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`
      if (preservedReferenceHandoffHrefRef.current === currentHref) return
      preservedReferenceHandoffHrefRef.current = null
      referenceHandoffAbortRef.current?.abort()
      referenceHandoffAbortRef.current = null
      referenceHandoffBusyRef.current = false
      referenceHandoffGenerationRef.current += 1
      referenceHandoffOperationRef.current = null
      setReferenceHandoff(null)
      return
    }
    preservedReferenceHandoffHrefRef.current = null
    if (parsed.state === "invalid") {
      referenceHandoffAbortRef.current?.abort()
      referenceHandoffAbortRef.current = null
      referenceHandoffBusyRef.current = false
      referenceHandoffGenerationRef.current += 1
      referenceHandoffOperationRef.current = null
      setReferenceHandoff({
        subjectRef: "",
        kind: null,
        objectId: "",
        revisionSha256: "",
        sourceRevisionId: null,
        phase: "error",
        error: referenceHandoffError(parsed.code),
      })
      clearReferenceHandoffLocation(true)
      return
    }

    if (activeAtlasWorkspaceId) {
      let pending: AtlasReferenceHandoffPlacementRecovery | null = null
      try {
        pending = listAtlasReferenceHandoffPlacementRecoveries(
          window.localStorage,
          referenceHandoffRecoveryScope,
        ).find((candidate) => candidate.workspaceId === activeAtlasWorkspaceId) ?? null
      } catch {
        setReferenceHandoff({
          subjectRef: "",
          kind: null,
          objectId: "",
          revisionSha256: "",
          sourceRevisionId: null,
          phase: "error",
          error: "Galaxy Brain could not open the exact placement recovery journal. Reload before placing another object.",
        })
        clearReferenceHandoffLocation(true)
        return
      }
      if (pending) {
        // A prior confirmed operation is authoritative until it is reconciled.
        // Never let a fresh source link mint a second placement identity.
        referenceHandoffRecoveryDismissedRef.current = null
        setReferenceHandoffRecoveryWakeVersion((value) => value + 1)
        clearReferenceHandoffLocation(true)
        return
      }
    }

    const generation = referenceHandoffGenerationRef.current + 1
    referenceHandoffGenerationRef.current = generation
    referenceHandoffAbortRef.current?.abort()
    referenceHandoffBusyRef.current = false
    referenceHandoffOperationRef.current = null
    const controller = new AbortController()
    referenceHandoffAbortRef.current = controller
    setReferenceHandoff({
      subjectRef: parsed.subjectRef,
      kind: parsed.kind,
      objectId: parsed.objectId,
      revisionSha256: parsed.revisionSha256,
      sourceRevisionId: null,
      phase: "authorizing",
      error: "",
    })
    void resolveReferenceHandoff(parsed.subjectRef, controller.signal, {
      kind: parsed.kind,
      objectId: parsed.objectId,
      revisionSha256: parsed.revisionSha256,
    }).then((authorized) => {
      if (controller.signal.aborted || referenceHandoffGenerationRef.current !== generation) return
      if (!authorized.ok) {
        setReferenceHandoff({
          subjectRef: parsed.subjectRef,
          kind: parsed.kind,
          objectId: parsed.objectId,
          revisionSha256: parsed.revisionSha256,
          sourceRevisionId: null,
          phase: "error",
          error: referenceHandoffError(authorized.code),
        })
        clearReferenceHandoffLocation(true)
        return
      }
      setReferenceHandoff({
        subjectRef: authorized.subjectRef,
        kind: authorized.kind,
        objectId: authorized.objectId,
        sourceRevisionId: authorized.sourceRevisionId ?? null,
        revisionSha256: authorized.revisionSha256,
        title: authorized.projection.title,
        phase: "ready",
        error: "",
      })
    }).catch((error: unknown) => {
      if (
        controller.signal.aborted
        || referenceHandoffGenerationRef.current !== generation
        || (error instanceof DOMException && error.name === "AbortError")
      ) return
      setReferenceHandoff({
        subjectRef: parsed.subjectRef,
        kind: parsed.kind,
        objectId: parsed.objectId,
        revisionSha256: parsed.revisionSha256,
        sourceRevisionId: null,
        phase: "error",
        error: referenceHandoffError("unavailable"),
      })
      clearReferenceHandoffLocation(true)
    })
    return () => controller.abort()
  }, [activeAtlasWorkspaceId, clearReferenceHandoffLocation, preview, reactiveAtlasSearch, referenceHandoffLocationVersion, referenceHandoffRecoveryScope])

  useEffect(() => {
    if (preview || typeof window === "undefined" || !activeAtlasWorkspaceId || referencePlacementRequest) return
    let pending: AtlasReferenceHandoffPlacementRecovery | null = null
    try {
      pending = listAtlasReferenceHandoffPlacementRecoveries(
        window.localStorage,
        referenceHandoffRecoveryScope,
      ).find((candidate) => candidate.workspaceId === activeAtlasWorkspaceId) ?? null
    } catch {
      setReferenceHandoff({
        subjectRef: "",
        kind: null,
        objectId: "",
        revisionSha256: "",
        sourceRevisionId: null,
        phase: "error",
        error: "Galaxy Brain could not open the exact placement recovery journal. Reload before placing another object.",
      })
      return
    }
    if (!pending) return
    if (referenceHandoffRecoveryDismissedRef.current === pending.operationId) return

    const generation = referenceHandoffGenerationRef.current + 1
    referenceHandoffGenerationRef.current = generation
    referenceHandoffAbortRef.current?.abort()
    referenceHandoffBusyRef.current = false
    referenceHandoffOperationRef.current = pending.operationId
    referenceHandoffRecoveryRecordRef.current = pending
    referenceHandoffRecoveryDismissedRef.current = null
    preservedReferenceHandoffHrefRef.current = `${window.location.pathname}${window.location.search}${window.location.hash}`
    const controller = new AbortController()
    referenceHandoffAbortRef.current = controller
    setReferenceHandoffRecovery(pending)
    setReferenceHandoff({
      subjectRef: pending.subjectRef,
      kind: pending.kind,
      objectId: pending.objectId,
      sourceRevisionId: pending.sourceRevisionId,
      revisionSha256: pending.revisionSha256,
      phase: "authorizing",
      error: "",
      operationId: pending.operationId,
    })
    void resolveReferenceHandoff(pending.subjectRef, controller.signal, {
      kind: pending.kind,
      objectId: pending.objectId,
      ...(pending.sourceRevisionId ? { sourceRevisionId: pending.sourceRevisionId } : {}),
      revisionSha256: pending.revisionSha256,
    }).then((authorized) => {
      if (controller.signal.aborted || referenceHandoffGenerationRef.current !== generation) return
      referenceHandoffAbortRef.current = null
      setReferenceHandoff({
        subjectRef: pending.subjectRef,
        kind: pending.kind,
        objectId: pending.objectId,
        sourceRevisionId: pending.sourceRevisionId,
        revisionSha256: pending.revisionSha256,
        title: authorized.ok ? authorized.projection.title : undefined,
        phase: "error",
        error: authorized.ok
          ? "This exact placement may already have committed. Retry to reconcile the same operation safely."
          : referenceHandoffError(authorized.code),
        operationId: pending.operationId,
      })
    }).catch((error: unknown) => {
      if (
        controller.signal.aborted
        || referenceHandoffGenerationRef.current !== generation
        || (error instanceof DOMException && error.name === "AbortError")
      ) return
      referenceHandoffAbortRef.current = null
      setReferenceHandoff({
        subjectRef: pending.subjectRef,
        kind: pending.kind,
        objectId: pending.objectId,
        sourceRevisionId: pending.sourceRevisionId,
        revisionSha256: pending.revisionSha256,
        phase: "error",
        error: referenceHandoffError("unavailable"),
        operationId: pending.operationId,
      })
    })
    return () => controller.abort()
  }, [
    activeAtlasWorkspaceId,
    preview,
    referenceHandoffRecoveryScope,
    referenceHandoffRecoveryWakeVersion,
    referencePlacementRequest,
  ])
  useEffect(() => () => {
    clearAtlasExactRepresentationCache(exactRepresentationAuthorizationScope)
  }, [exactRepresentationAuthorizationScope])
  const failClosedAtlas = useCallback((message: string) => {
    atlasLoadGenerationRef.current += 1
    atlasLoadAbortRef.current?.abort()
    atlasLoadAbortRef.current = null
    focusAtlasAfterInvalidationRef.current = false
    pendingInvalidationRef.current = null
    setPendingInvalidation(null)
    setAtlas(null)
    setLoading(false)
    setLoadError(message)
    clearAtlasExactRepresentationCache(exactRepresentationAuthorizationScope)
    window.requestAnimationFrame(() => loadErrorHeadingRef.current?.focus())
  }, [exactRepresentationAuthorizationScope])
  const acceptCanvasSnapshot = useCallback((accepted: CanvasEnvelope) => {
    setAtlas((current) => {
      const observed = current?.durableCanvas
      if (!current || accepted.workspaceId !== current.workspaceId) return current
      if (!observed) {
        const catalogIncludesAccepted = current.canvases.some((canvas) => canvas.canvasId === accepted.canvasId)
        if (current.canvases.length > 0 && !catalogIncludesAccepted) return current
        return {
          ...current,
          canvases: catalogIncludesAccepted
            ? current.canvases.map((canvas) => canvas.canvasId === accepted.canvasId ? accepted : canvas)
            : [accepted],
          durableCanvas: accepted,
        }
      }
      if (observed.canvasId !== accepted.canvasId) return current
      if (accepted.version < observed.version) return current
      if (accepted.version === observed.version && accepted.contentHash !== observed.contentHash) return current
      if (accepted.version === observed.version) return current
      return {
        ...current,
        canvases: current.canvases.map((canvas) => canvas.canvasId === accepted.canvasId ? accepted : canvas),
        durableCanvas: accepted,
      }
    })
  }, [])
  const runFrameMutationOperation = useCallback((operation: AtlasFrameMutationOperation) => {
    const current = atlas?.durableCanvas
    const scope = frameMutationScope
    if (!current || !scope || frameMutationBusyRef.current) return
    if (operation.canvasId !== current.canvasId) {
      setCanvasActionStatus("The pending frame operation belongs to another Atlas canvas. Switch back to recover it.")
      return
    }
    if (canvasConvergenceReaderRef.current?.().pendingWork) {
      const message = "Wait for the current Atlas save to finish before recovering the frame operation."
      setFrameMutationError(message)
      setCanvasActionStatus(message)
      return
    }
    frameMutationBusyRef.current = true
    setFrameMutationBusy(true)
    setFrameMutationError("")
    setCanvasActionStatus(operation.kind === "create" ? "Recovering exact frame creation…" : "Recovering exact frame removal…")
    void reconcileAtlasFrameMutation({
      current,
      operation,
      mutateCanvas: (canvasId, input) => galaxyBrainAPI.mutateCanvas(canvasId, input),
      reloadCanvas: (canvasId) => galaxyBrainAPI.getCanvas(canvasId),
    }).then(({ canvas: updated }) => {
      removePendingAtlasFrameMutation(window.localStorage, scope, operation.operationId)
      frameRecoveryAttemptRef.current = null
      setFrameMutationOperation(null)
      acceptCanvasSnapshot(updated)
      if (operation.kind === "create") {
        setFrameCreateOpen(false)
        setCanvasActionStatus(`Created frame ${operation.frame.title}.`)
      } else {
        setSelectedFrameContext(null)
        setCanvasActionStatus(`Removed frame ${operation.frame.title}. Objects and relations were unchanged.`)
      }
    }).catch((error: unknown) => {
      if (error instanceof AtlasFrameMutationConflictError || error instanceof AtlasFrameMutationTerminalError) {
        // Reconciliation attached the authoritative reloaded head. Adopt it
        // before releasing the journal fence so the UI never resumes from
        // stale pre-conflict state.
        acceptCanvasSnapshot(error.canvas)
        // The authoritative canvas now binds this id to different frame
        // content, or a definite 4xx proved the absent operation cannot commit.
        removePendingAtlasFrameMutation(window.localStorage, scope, operation.operationId)
        frameRecoveryAttemptRef.current = null
        setFrameMutationOperation(null)
        const message = error instanceof AtlasFrameMutationConflictError
          ? "The frame identity changed before recovery completed. The authoritative canvas was loaded and the pending operation was stopped."
          : "The server rejected the frame operation. The authoritative canvas was loaded and the pending operation was stopped."
        setFrameMutationError(message)
        setCanvasActionStatus(message)
        return
      }
      const message = error instanceof Error ? error.message : "The frame outcome could not be confirmed."
      setFrameMutationError(`${message} Retry the exact journaled operation.`)
      setCanvasActionStatus(`${message} Retry the exact journaled operation.`)
    }).finally(() => {
      frameMutationBusyRef.current = false
      setFrameMutationBusy(false)
    })
  }, [acceptCanvasSnapshot, atlas?.durableCanvas, frameMutationScope])

  useEffect(() => {
    if (preview || !frameMutationScope || typeof window === "undefined") return
    let pending: AtlasFrameMutationOperation | null
    try {
      pending = readPendingAtlasFrameMutation(window.localStorage, frameMutationScope)
    } catch {
      try {
        const removed = quarantineAtlasFrameMutationJournal(window.localStorage, frameMutationScope)
        setFrameMutationOperation(null)
        frameRecoveryAttemptRef.current = null
        setCanvasActionStatus(removed
          ? "A malformed scoped frame recovery record was removed without replaying a request. You can edit frames again."
          : "No readable scoped frame recovery operation was found. You can edit frames again.")
      } catch {
        setCanvasActionStatus("Galaxy Brain could not safely remove the malformed scoped frame recovery record. Frame editing remains unavailable in this browser.")
      }
      return
    }
    if (!pending) {
      setFrameMutationOperation(null)
      frameRecoveryAttemptRef.current = null
      return
    }
    setFrameMutationOperation(pending)
    if (frameRecoveryAttemptRef.current === pending.operationId) return
    frameRecoveryAttemptRef.current = pending.operationId
    runFrameMutationOperation(pending)
  }, [frameMutationScope, preview, runFrameMutationOperation])

  const createAtlasFrame = useCallback((draft: AtlasFrameDraft) => {
    const current = atlas?.durableCanvas
    const scope = frameMutationScope
    if (!current || !scope || frameMutationBusyRef.current) return
    if (!frameMutationOperation && (current.content.frames?.length ?? 0) >= 100) {
      setFrameMutationError("This Atlas already has the maximum 100 presentation frames.")
      return
    }
    if (canvasConvergenceReaderRef.current?.().pendingWork) {
      setFrameMutationError("Wait for the current Atlas save to finish.")
      return
    }
    if (frameMutationOperation?.kind === "remove") {
      setFrameMutationError("Recover the pending frame removal before creating another frame.")
      return
    }
    if (frameMutationOperation && (
      frameMutationOperation.frame.title !== draft.title || frameMutationOperation.frame.tone !== draft.tone
    )) {
      setFrameMutationError("Retry the exact same frame request; its durable identity is journaled.")
      return
    }
    const offset = (current.content.frames?.length ?? 0) * 36
    const operation = frameMutationOperation ?? prepareAtlasFrameMutationOperation({
      ...scope,
      kind: "create",
      frame: canvasFrameFromInput({
        id: `frame-${crypto.randomUUID()}`,
        title: draft.title,
        tone: draft.tone,
        x: 80 + offset,
        y: 80 + offset,
        width: 720,
        height: 480,
      }),
    })
    try {
      const journaled = writePendingAtlasFrameMutation(window.localStorage, scope, operation)
      setFrameMutationOperation(journaled)
      runFrameMutationOperation(journaled)
    } catch (error) {
      setFrameMutationError(error instanceof Error ? error.message : "The frame recovery journal is unavailable.")
    }
  }, [atlas?.durableCanvas, frameMutationOperation, frameMutationScope, runFrameMutationOperation])

  const removeAtlasFrame = useCallback((frame: CanvasSnapshotFrame) => {
    const current = atlas?.durableCanvas
    const scope = frameMutationScope
    if (!current || !scope || frameMutationBusyRef.current) return
    const dispatched = dispatchAtlasCommand("frame.remove", { frameId: frame.id, title: frame.title })
    if (!dispatched.ok || dispatched.effect.kind !== "confirm-frame-remove") return
    if (frameMutationOperation && (
      frameMutationOperation.kind !== "remove" || frameMutationOperation.frame.id !== frame.id
    )) {
      setCanvasActionStatus("Recover the pending frame operation before removing another frame.")
      return
    }
    if (!frameMutationOperation
        && !window.confirm(`Remove the frame “${frame.title}”? Enclosed objects and relations will remain unchanged.`)) return
    if (canvasConvergenceReaderRef.current?.().pendingWork) {
      setCanvasActionStatus("Wait for the current Atlas save to finish before removing a frame.")
      return
    }
    const operation = frameMutationOperation ?? prepareAtlasFrameMutationOperation({
      ...scope,
      kind: "remove",
      frame,
    })
    try {
      const journaled = writePendingAtlasFrameMutation(window.localStorage, scope, operation)
      setFrameMutationOperation(journaled)
      runFrameMutationOperation(journaled)
    } catch (error) {
      setCanvasActionStatus(error instanceof Error ? error.message : "The frame recovery journal is unavailable.")
    }
  }, [atlas?.durableCanvas, frameMutationOperation, frameMutationScope, runFrameMutationOperation])
  const registerCanvasConvergenceReader = useCallback((reader: CanvasConvergenceReader | null) => {
    canvasConvergenceReaderRef.current = reader
  }, [])
  const requestAtlasReload = useCallback((
    blockedMessage: string,
    beforeReload?: () => void,
  ) => {
    if (canvasConvergenceReaderRef.current?.().pendingWork || frameMutationBusy || frameMutationOperation !== null) {
      setReferencePlacementAnnouncement(blockedMessage)
      setCanvasActionStatus(blockedMessage)
      return false
    }
    setCanvasActionStatus("")
    beforeReload?.()
    setReload((value) => value + 1)
    return true
  }, [frameMutationBusy, frameMutationOperation])
  const prepareCanvasNavigation = useCallback(() => {
    pendingInvalidationRef.current = null
    setPendingInvalidation(null)
    focusAtlasAfterInvalidationRef.current = false
  }, [])
  const requestInvalidatedCanvasReload = useCallback(() => {
    if (canvasConvergenceReaderRef.current?.().pendingWork || frameMutationBusy || frameMutationOperation !== null) {
      setPendingInvalidation((current) => current
        ? { ...current, waitingForLocalWork: true }
        : current)
      const message = "Finish the current Atlas placement before loading the accepted layout."
      setReferencePlacementAnnouncement(message)
      setCanvasActionStatus(message)
      return
    }
    setCanvasActionStatus("")
    focusAtlasAfterInvalidationRef.current = true
    setReload((value) => value + 1)
  }, [frameMutationBusy, frameMutationOperation])
  const requestListView = useCallback(() => {
    if (canvasConvergenceReaderRef.current?.().pendingWork || frameMutationBusy || frameMutationOperation !== null) {
      const message = "Finish the current Atlas placement before switching to the list."
      setReferencePlacementAnnouncement(message)
      setCanvasActionStatus(message)
      return false
    }
    setCanvasActionStatus("")
    focusListAfterViewChangeRef.current = true
    setView("list")
    return true
  }, [frameMutationBusy, frameMutationOperation])
  const requestRelationListView = useCallback(() => {
    if (!requestListView() || typeof window === "undefined") return
    focusListAfterViewChangeRef.current = false
    window.requestAnimationFrame(() => relationModeCancelRef.current?.focus({ preventScroll: true }))
  }, [requestListView])

  useEffect(() => {
    if (view !== "list" || !focusListAfterViewChangeRef.current) return
    focusListAfterViewChangeRef.current = false
    window.requestAnimationFrame(() => atlasListHeadingRef.current?.focus({ preventScroll: true }))
  }, [view])
  const requestAtlasRefresh = useCallback(() => {
    requestAtlasReload("Finish the current Atlas placement before refreshing.")
  }, [requestAtlasReload])
  const atlasPersistencePending = useCallback((includeCanvasCreate = true) => (
    atlasCanvasSwitchHasPendingWork({
      convergence: Boolean(canvasConvergenceReaderRef.current?.().pendingWork),
      referencePlacement: referencePlacementRequest !== null,
      placementRemoval: placementRemovalRequest !== null,
      dropImport: atlasDropImportOwner.busy(),
      documentImport: documentImportBusyRef.current || documentImportPhase !== "idle",
      referenceHandoff: referenceHandoffBusyRef.current,
      formalPackagePlacement: formalPackagePlacing,
      paperImport: paperImportPhase !== "idle",
      webCapture: webCapturePhase !== "idle",
      inkImport: inkDrawingPhase !== "idle",
      codeImport: codeSavePhase !== "idle",
      codeGraphImport: codeGraphSnapshotPhase !== "idle" || codeGraphSnapshotAmbiguous || codeGraphSnapshotRecovery !== null,
      markdownNote: markdownNotePhase !== "idle" || markdownNoteAmbiguous || markdownNoteRecovery !== null,
      voiceImport: voiceSavePhase !== "idle",
      relationWrite: relationComposeBusy,
      frameMutation: frameMutationBusy || frameMutationOperation !== null,
      canvasCreate: includeCanvasCreate && canvasCreateBusy,
    })
  ), [
    atlasDropImportOwner,
    canvasCreateBusy,
    codeSavePhase,
    codeGraphSnapshotAmbiguous,
    codeGraphSnapshotPhase,
    codeGraphSnapshotRecovery,
    documentImportPhase,
    formalPackagePlacing,
    frameMutationBusy,
    frameMutationOperation,
    inkDrawingPhase,
    markdownNoteAmbiguous,
    markdownNotePhase,
    markdownNoteRecovery,
    paperImportPhase,
    placementRemovalRequest,
    referencePlacementRequest,
    relationComposeBusy,
    voiceSavePhase,
    webCapturePhase,
  ])
  const canvasCreateBlockedReason = useCallback(() => {
    if (preview) return "Canvas creation is available on the live Atlas."
    if (!mounted || !atlas || loading || loadError) return "Wait for the current Atlas workspace to finish loading."
    if (canvasCreateBusy) return "Wait for the current canvas creation to finish."
    if (atlasPersistencePending(false)) return "Finish the current Atlas work before creating another canvas."
    return null
  }, [atlas, atlasPersistencePending, canvasCreateBusy, loadError, loading, mounted, preview])
  const switchAtlasCanvas = useCallback((canvasId: string) => {
    if (!atlas) {
      const message = "That Atlas canvas is not available in this workspace."
      setCanvasActionStatus(message)
      return
    }
    if (canvasId === atlas.durableCanvas?.canvasId) {
      const message = "This Atlas canvas is already open."
      setCanvasActionStatus(message)
      return
    }
    const target = findAtlasCanvasSwitchTarget(
      atlas.canvases,
      atlas.workspaceId,
      atlas.durableCanvas?.canvasId ?? null,
      canvasId,
    )
    if (!target) {
      const message = "That Atlas canvas is not available in this workspace."
      setCanvasActionStatus(message)
      return
    }
    if (atlasPersistencePending()) {
      const message = "Finish the current Atlas placement before switching canvases."
      setCanvasActionStatus(message)
      return
    }
    setCanvasActionStatus("")
    window.location.assign(atlasCanvasHref(canvasId))
  }, [
    atlas,
    atlasPersistencePending,
  ])

  const restorePendingExperimentPlacement = useCallback(() => {
    if (preview || typeof window === "undefined") return null
    const [pending] = listPendingExperimentPlacements(window.localStorage, experimentRecoveryScope)
    setExperimentPlacementRecovery(pending || null)
    if (pending) {
      setExperimentPlacementError("This research record is durable and waiting to be placed on this Atlas.")
    }
    return pending || null
  }, [experimentRecoveryScope, preview])

  useEffect(() => {
    if (preview || typeof window === "undefined") return
    try {
      restorePendingExperimentPlacement()
    } catch {
      setExperimentPlacementError("Galaxy Brain could not open the safe placement journal. Reload before placing another record.")
    }
    const namespace = elnExperimentRecoveryNamespace(experimentRecoveryScope)
    const refresh = (event: StorageEvent) => {
      if (
        event.storageArea !== window.localStorage
        || !event.key?.startsWith(namespace)
        || referencePlacementRequest
      ) return
      try {
        restorePendingExperimentPlacement()
      } catch {
        setExperimentPlacementError("Galaxy Brain could not refresh the safe placement journal.")
      }
    }
    window.addEventListener("storage", refresh)
    return () => window.removeEventListener("storage", refresh)
  }, [experimentRecoveryScope, preview, referencePlacementRequest, restorePendingExperimentPlacement])

  const restorePaperImportPlacement = useCallback(() => {
    if (preview || typeof window === "undefined" || !atlas) return null
    const pending = listPaperImportPlacementRecoveries(window.localStorage, paperImportRecoveryScope)
      .find((candidate) => candidate.workspaceId === atlas.workspaceId) ?? null
    setPaperImportRecovery(pending)
    if (pending) {
      setPaperImportError("This exact PDF is durable and waiting to be placed on its original Atlas canvas.")
    }
    return pending
  }, [atlas, paperImportRecoveryScope, preview])

  useEffect(() => {
    if (preview || typeof window === "undefined" || !atlas) return
    try {
      restorePaperImportPlacement()
    } catch {
      setPaperImportError("Galaxy Brain could not open the exact paper placement journal. Reload before importing another paper.")
    }
    const namespace = paperImportPlacementRecoveryNamespace(paperImportRecoveryScope)
    const refresh = (event: StorageEvent) => {
      if (
        event.storageArea !== window.localStorage
        || !event.key?.startsWith(namespace)
        || referencePlacementRequest
      ) return
      try {
        restorePaperImportPlacement()
      } catch {
        setPaperImportError("Galaxy Brain could not refresh the exact paper placement journal.")
      }
    }
    window.addEventListener("storage", refresh)
    return () => window.removeEventListener("storage", refresh)
  }, [atlas, paperImportRecoveryScope, preview, referencePlacementRequest, restorePaperImportPlacement])

  const restoreWebCapturePlacement = useCallback(() => {
    if (preview || typeof window === "undefined" || !atlas) return null
    const pending = listAtlasWebCapturePlacementRecoveries(window.localStorage, webCaptureRecoveryScope)
      .find((candidate) => candidate.workspaceId === atlas.workspaceId) ?? null
    setWebCaptureRecovery(pending)
    if (pending) {
      setWebCaptureError("This exact web capture is durable and waiting to be placed on its original Atlas canvas.")
    }
    return pending
  }, [atlas, preview, webCaptureRecoveryScope])

  useEffect(() => {
    if (preview || typeof window === "undefined" || !atlas) return
    try {
      restoreWebCapturePlacement()
    } catch {
      setWebCaptureError("Galaxy Brain could not open the web capture placement journal. Reload before capturing more content.")
    }
    const namespace = atlasWebCapturePlacementRecoveryNamespace(webCaptureRecoveryScope)
    const refresh = (event: StorageEvent) => {
      if (
        event.storageArea !== window.localStorage
        || !event.key?.startsWith(namespace)
        || referencePlacementRequest
      ) return
      try {
        restoreWebCapturePlacement()
      } catch {
        setWebCaptureError("Galaxy Brain could not refresh the web capture placement journal.")
      }
    }
    window.addEventListener("storage", refresh)
    return () => window.removeEventListener("storage", refresh)
  }, [atlas, preview, referencePlacementRequest, restoreWebCapturePlacement, webCaptureRecoveryScope])

  useEffect(() => {
    function openCommandDeck(event: globalThis.KeyboardEvent) {
      const key = event.key.toLowerCase()
      if (
        key !== "k"
        || (!event.ctrlKey && !event.metaKey)
        || event.altKey
        || event.shiftKey
        || event.repeat
        || event.isComposing
        || event.defaultPrevented
        || canvasCreateOpen
        || frameCreateOpen
        || constructorOpen
        || legacyFlowPortabilityOpen
        || codeEditorOpen
        || voiceCaptureOpen
        || experimentCreateOpen
        || paperImportOpen
        || webCaptureOpen
        || referenceDialogOpen
        || referenceHandoff !== null
        || formalPackageImportOpen
        || documentImportOpen
        || datasourceManagerOpen
        || inkDrawingOpen
        || hamMemoryOpen
        || relationComposeOpen
        || placementRemoveOpen
      ) return
      const target = event.target
      if (
        target instanceof HTMLElement
        && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) return
      event.preventDefault()
      setCommandDeckOpen((current) => !current)
    }
    window.addEventListener("keydown", openCommandDeck)
    return () => window.removeEventListener("keydown", openCommandDeck)
  }, [canvasCreateOpen, codeEditorOpen, constructorOpen, datasourceManagerOpen, documentImportOpen, experimentCreateOpen, formalPackageImportOpen, frameCreateOpen, hamMemoryOpen, inkDrawingOpen, legacyFlowPortabilityOpen, paperImportOpen, placementRemoveOpen, referenceDialogOpen, referenceHandoff, relationComposeOpen, voiceCaptureOpen, webCaptureOpen])

  useEffect(() => {
    if (initialAtlas) {
      setAtlas(initialAtlas)
      setLoading(false)
      setLoadError("")
      return
    }
    atlasLoadAbortRef.current?.abort()
    const controller = new AbortController()
    atlasLoadAbortRef.current = controller
    const generation = atlasLoadGenerationRef.current + 1
    atlasLoadGenerationRef.current = generation
    setLoading(true)
    setLoadError("")
    let canvasId: string | null
    try {
      canvasId = requestedCanvasId(window.location.search)
    } catch (error) {
      atlasLoadAbortRef.current = null
      focusAtlasAfterInvalidationRef.current = false
      setLoadError(error instanceof Error ? error.message : "Requested atlas is unavailable")
      setLoading(false)
      window.requestAnimationFrame(() => loadErrorHeadingRef.current?.focus())
      return () => controller.abort()
    }
    void loadAuthorizedAtlas(tenantId, controller.signal, canvasId)
      .then((loaded) => {
        if (controller.signal.aborted || atlasLoadGenerationRef.current !== generation) return
        atlasLoadAbortRef.current = null
        const invalidation = pendingInvalidationRef.current
        if (invalidation && canvasId !== null && canvasId !== invalidation.canvasId) {
          focusAtlasAfterInvalidationRef.current = false
          pendingInvalidationRef.current = null
          setPendingInvalidation(null)
        } else if (invalidation) {
          const reloaded = loaded.durableCanvas
          const accepted = canvasReloadSatisfiesChange(reloaded, invalidation)
          if (!accepted) {
            focusAtlasAfterInvalidationRef.current = false
            pendingInvalidationRef.current = null
            setPendingInvalidation(null)
            setAtlas(null)
            setLoadError("The updated Atlas revision could not be verified. Reload after the canvas head is consistent.")
            setLoading(false)
            window.requestAnimationFrame(() => loadErrorHeadingRef.current?.focus())
            return
          }
          pendingInvalidationRef.current = null
          setPendingInvalidation(null)
        }
        setAtlas(loaded)
        setLoading(false)
        if (focusAtlasAfterInvalidationRef.current) {
          focusAtlasAfterInvalidationRef.current = false
          window.requestAnimationFrame(() => atlasHeadingRef.current?.focus())
        }
      })
      .catch((error) => {
        if (
          controller.signal.aborted
          || atlasLoadGenerationRef.current !== generation
          || (error instanceof DOMException && error.name === "AbortError")
        ) return
        atlasLoadAbortRef.current = null
        const terminalAuthorizationFailure = error instanceof GalaxyBrainAPIError
          && (error.status === 401 || error.status === 403 || error.status === 404)
        if (terminalAuthorizationFailure) {
          pendingInvalidationRef.current = null
          setPendingInvalidation(null)
          setAtlas(null)
          clearAtlasExactRepresentationCache(exactRepresentationAuthorizationScope)
        }
        setLoadError(error instanceof Error ? error.message : "Unable to load the authorized atlas")
        setLoading(false)
        if (focusAtlasAfterInvalidationRef.current) {
          focusAtlasAfterInvalidationRef.current = false
          window.requestAnimationFrame(() => loadErrorHeadingRef.current?.focus())
        }
      })
    return () => {
      controller.abort()
      if (atlasLoadAbortRef.current === controller) atlasLoadAbortRef.current = null
    }
  }, [exactRepresentationAuthorizationScope, initialAtlas, reload, tenantId])

  useEffect(() => {
    const current = atlas?.durableCanvas
    setPendingInvalidation((pending) => {
      if (!pending || !current) return pending
      if (pending.canvasId !== current.canvasId || current.version > pending.version) return null
      if (current.version === pending.version && current.contentHash === pending.contentHash) return null
      return pending
    })
  }, [atlas?.durableCanvas])

  useEffect(() => {
    if (!pendingInvalidation) setCanvasActionStatus("")
  }, [pendingInvalidation])

  useEffect(() => {
    const current = atlas?.durableCanvas
    if (
      preview
      || !current
      || pendingInvalidation?.canvasId === current.canvasId
    ) return
    const poller = createCanvasChangePoller({
      request: (signal) => galaxyBrainAPI.getLatestCanvasChange(current.canvasId, signal),
      onEvent: (event) => {
        const observed = canvasConvergenceReaderRef.current?.().canvas ?? atlas?.durableCanvas
        if (!event || !observed || observed.canvasId !== event.canvasId) return "continue"
        const action = canvasChangeAction({
          version: observed.version,
          contentHash: observed.contentHash,
        }, false, event)
        if (action !== "notify") return "continue"
        setPendingInvalidation({
          canvasId: event.canvasId,
          version: event.version,
          contentHash: event.contentHash,
          waitingForLocalWork: Boolean(canvasConvergenceReaderRef.current?.().pendingWork),
        })
        return "stop"
      },
      onTerminalError: () => failClosedAtlas(
        "This Atlas is no longer available or your access has changed. Reload after restoring access.",
      ),
    })
    const handleVisibilityChange = () => {
      poller.setVisible(document.visibilityState !== "hidden")
    }
    document.addEventListener("visibilitychange", handleVisibilityChange)
    poller.start()
    poller.setVisible(document.visibilityState !== "hidden")
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      poller.stop()
    }
  }, [atlas?.durableCanvas, failClosedAtlas, pendingInvalidation?.canvasId, preview])

  const hydrationKey = !preview && atlas?.durableCanvas
    ? `${tenantId}:${atlas.durableCanvas.canvasId}:${atlas.durableCanvas.contentHash}`
    : null
  const hydrationByReference = hydrationState.key === hydrationKey
    ? hydrationState.byReference
    : EMPTY_ATLAS_HYDRATION
  const runtimeBaseProjection = useMemo(() => {
    if (!atlas) return null
    if (!atlas.durableCanvas) return atlas.baseProjection
    return applyAtlasHydrationAvailability(
      atlas.baseProjection,
      atlas.durableCanvas.content,
      hydrationByReference,
    )
  }, [atlas, hydrationByReference])
  const exactRelationPlacements = useMemo(() => {
    if (!atlas || !runtimeBaseProjection) return []
    const merged = atlas.durableCanvas
      ? mergeCanvasSnapshot(runtimeBaseProjection, atlas.durableCanvas.content)
      : runtimeBaseProjection
    return projectAtlasExactRelationPlacements(
      authorizedObjectLinkPlacements(merged, hydrationByReference),
      hydrationByReference,
    )
  }, [atlas, hydrationByReference, runtimeBaseProjection])
  const relationReferenceCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const placement of exactRelationPlacements) {
      const endpoint = inspectAtlasAuthoredRelationEndpoint(placement.subjectRef)
      if (!endpoint.ok || placement.authorized !== true || placement.availability === "unavailable") continue
      counts.set(endpoint.ref, (counts.get(endpoint.ref) ?? 0) + 1)
    }
    return counts
  }, [exactRelationPlacements])
  const exactRelationReferenceKey = useMemo(() => (
    [...new Set([
      selectedPlacementContext?.relationRef,
      relationSource?.relationRef,
      relationTarget?.relationRef,
      ...relationReferenceCounts.keys(),
    ].filter((value): value is string => Boolean(value)))]
      .slice(0, OBJECT_LINK_REFERENCE_LIMIT)
      .join("\u0000")
  ), [relationReferenceCounts, relationSource?.relationRef, relationTarget?.relationRef, selectedPlacementContext?.relationRef])
  const exactRelationCanvasId = atlas?.durableCanvas?.canvasId ?? null

  useEffect(() => {
    if (
      preview
      || !exactRelationCanvasId
      || hydrationState.key !== hydrationKey
      || !exactRelationReferenceKey
    ) return undefined
    const references = exactRelationReferenceKey.split("\u0000")
    const mutationGeneration = exactRelationMutationGenerationRef.current
    const controller = new AbortController()
    void mapAtlasObjectLinksWithConcurrency(references, controller.signal).then((results) => {
      if (controller.signal.aborted || exactRelationMutationGenerationRef.current !== mutationGeneration) return
      const collected = collectAtlasObjectLinks(results)
      const refreshes = results.map((result) => ({
        links: result.status === "fulfilled" ? result.value.links : [],
      }))
      setAtlas((current) => {
        if (
          !current
          || current.durableCanvas?.canvasId !== exactRelationCanvasId
          || exactRelationMutationGenerationRef.current !== mutationGeneration
        ) return current
        let links: readonly AuthorizedObjectLink[]
        try {
          links = reconcileAtlasObjectLinks(current.objectLinks ?? [], refreshes)
        } catch {
          return {
            ...current,
            sources: current.sources.map((source) => source.label === "Object links"
              ? { ...source, status: "unavailable" }
              : source),
          }
        }
        const uniqueCount = new Set(links.map((link) => link.id)).size
        const status: SourceState["status"] = collected.failed === results.length
          ? "unavailable"
          : "partial"
        return {
          ...current,
          objectLinks: [...links],
          sources: current.sources.map((source) => source.label === "Object links"
            ? { ...source, status, count: uniqueCount }
            : source),
        }
      })
    }).catch(() => undefined)
    return () => controller.abort()
  }, [exactRelationCanvasId, exactRelationReferenceKey, exactRelationRefreshEpoch, hydrationKey, hydrationState.key, preview])
  const hamRelationRequest = useMemo(() => {
    if (preview || !atlas || !runtimeBaseProjection) {
      return { ready: false, key: null, references: [] as readonly string[], eligibleCount: 0, clientTruncated: false }
    }
    if (atlas.durableCanvas && hydrationState.key !== hydrationKey) {
      return { ready: false, key: null, references: [] as readonly string[], eligibleCount: 0, clientTruncated: false }
    }
    if (Object.values(hydrationByReference).some((entry) => entry.status === "loading")) {
      return { ready: false, key: null, references: [] as readonly string[], eligibleCount: 0, clientTruncated: false }
    }
    const merged = atlas.durableCanvas
      ? mergeCanvasSnapshot(runtimeBaseProjection, atlas.durableCanvas.content)
      : runtimeBaseProjection
    const selection = selectAuthorizedHamRelationReferences(
      authorizedObjectLinkPlacements(merged, hydrationByReference),
    )
    return {
      ready: true,
      key: `${hydrationKey ?? "live"}:${selection.references.join("\u0000")}`,
      ...selection,
    }
  }, [atlas, hydrationByReference, hydrationKey, hydrationState.key, preview, runtimeBaseProjection])
  const runtimeProjection = useMemo(() => {
    if (!atlas || !runtimeBaseProjection) return null
    const merged = atlas.durableCanvas
      ? mergeCanvasSnapshot(runtimeBaseProjection, atlas.durableCanvas.content)
      : runtimeBaseProjection
    const preferredPlacementIds = atlas.durableCanvas
      ? atlas.durableCanvas.content.items
          .filter((item) => !atlas.durableCanvas?.content.removedItemIds.includes(item.id))
          .map((item) => item.id)
      : []
    const semanticRelations = projectAuthorizedObjectLinkRelations(
      exactRelationPlacements,
      (atlas.objectLinks ?? []).map((link) => ({ authorized: true, active: true, link })),
      { preferredPlacementIds },
    )
    const hamRelations = projectAuthorizedHamRelationOverlay(
      authorizedObjectLinkPlacements(merged, hydrationByReference),
      hamRelationState.key === hamRelationRequest.key ? hamRelationState.value : undefined,
      { preferredPlacementIds },
    )
    const occupiedRelationIds = new Set(merged.relations.map((relation) => relation.id))
    const semanticRelationIds = new Set(semanticRelations.map((relation) => relation.id))
    return {
      ...merged,
      relations: [
        ...merged.relations,
        ...semanticRelations.filter((relation) => !occupiedRelationIds.has(relation.id)),
        ...hamRelations.filter((relation) => (
          !occupiedRelationIds.has(relation.id) && !semanticRelationIds.has(relation.id)
        )),
      ],
    }
  }, [atlas, exactRelationPlacements, hamRelationRequest.key, hamRelationState, hydrationByReference, runtimeBaseProjection])
  const focusRelationPlacement = useCallback((placementId: string) => {
    const placement = runtimeProjection?.placements.find((candidate) => (
      candidate.id === placementId
      && candidate.authorized === true
      && candidate.availability !== "unavailable"
    ))
    if (!placement) {
      setRelationFocusPlacementId(undefined)
      setCanvasActionStatus("That relation endpoint is no longer available in the current Atlas.")
      return
    }
    setCanvasActionStatus("")
    setRelationFocusPlacementId(placementId)
    setView("canvas")
  }, [runtimeProjection])
  const atlasRuntimeReady = Boolean(!preview && mounted && atlas && runtimeProjection && !loading && !loadError)
  const atlasMutationReady = atlasRuntimeReady && !frameMutationBusy && frameMutationOperation === null
  currentAtlasTargetRef.current = {
    workspaceId: atlas?.workspaceId || "",
    canvasId: atlas?.durableCanvas?.canvasId || null,
    ready: atlasMutationReady,
  }
  const relationRecoveryScope = useMemo(() => atlas?.durableCanvas ? ({
    tenantId,
    principalId,
    canvasId: atlas.durableCanvas.canvasId,
  }) : null, [atlas?.durableCanvas, principalId, tenantId])
  const relationScopeKey = `${tenantId}:${principalId}:${atlas?.durableCanvas?.canvasId || "unavailable"}`
  const clearRelationComposer = useCallback((announcement = "", preserveRecovery = false) => {
    relationComposeAbortRef.current?.abort()
    relationComposeAbortRef.current = null
    if (!preserveRecovery && relationRecoveryScope && typeof window !== "undefined") {
      try {
        removeAtlasAuthoredRelationRecovery(window.sessionStorage, relationRecoveryScope)
      } catch {
        // A completed or explicitly abandoned browser operation does not retain an unusable checkpoint.
      }
    }
    setRelationSource(null)
    setRelationTarget(null)
    setRelationRequest(null)
    setRelationKind("related")
    setRelationComposeOpen(false)
    setRelationComposeBusy(false)
    setRelationComposeAmbiguous(false)
    setRelationComposeError("")
    setRelationComposeReturnFocus(null)
    relationModeReturnFocusRef.current = null
    if (announcement) setCanvasActionStatus(announcement)
  }, [relationRecoveryScope])

  const cancelRelationMode = useCallback((announcement = "Relation mode canceled.") => {
    const returnFocus = relationModeReturnFocusRef.current
    clearRelationComposer(announcement)
    if (typeof window === "undefined") return
    window.requestAnimationFrame(() => {
      const fallback = view === "canvas"
        ? atlasHeadingRef.current
          ?.closest("main")
          ?.querySelector<HTMLElement>("[data-canvas-host]")
        : atlasHeadingRef.current
      const target = returnFocus?.isConnected ? returnFocus : fallback
      target?.focus({ preventScroll: true })
    })
  }, [clearRelationComposer, view])

  useEffect(() => {
    clearRelationComposer("", true)
    if (!relationRecoveryScope || typeof window === "undefined") return
    try {
      const recovered = readAtlasAuthoredRelationRecovery(window.sessionStorage, relationRecoveryScope)
      if (!recovered) return
      const endpoint = (value: typeof recovered.source): AtlasRelationEndpoint => ({
        placementId: value.placementId,
        subjectRef: value.relationRef,
        label: value.label,
        relationRef: value.relationRef,
        relationUnavailableReason: "",
        shareRef: null,
        shareUnavailableReason: "",
      })
      setRelationSource(endpoint(recovered.source))
      setRelationTarget(endpoint(recovered.target))
      setRelationKind(recovered.request.relation)
      setRelationRequest(recovered.request)
      setRelationComposeAmbiguous(true)
      setRelationComposeError("A previous relation outcome is unconfirmed. Retry preserves the exact request.")
      setRelationComposeOpen(true)
    } catch {
      setCanvasActionStatus("The saved relation retry could not be restored safely.")
    }
  }, [clearRelationComposer, relationRecoveryScope, relationScopeKey])

  useEffect(() => {
    if (!relationSource || relationRequest || relationComposeBusy) return
    const sourceStillExact = exactRelationPlacements.some((placement) => (
      placement.id === relationSource.placementId
      && placement.subjectRef === relationSource.relationRef
      && placement.authorized === true
      && placement.availability !== "unavailable"
    ))
    if (!sourceStillExact || relationReferenceCounts.get(relationSource.relationRef) !== 1) {
      clearRelationComposer("Relation mode canceled because its exact source is no longer available.")
    }
  }, [clearRelationComposer, exactRelationPlacements, relationComposeBusy, relationReferenceCounts, relationRequest, relationSource])

  useEffect(() => {
    if (!relationSource || relationComposeOpen || relationComposeBusy) return undefined
    const cancelOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return
      const target = event.target
      if (target instanceof HTMLElement && (
        target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
      )) return
      event.preventDefault()
      cancelRelationMode()
    }
    window.addEventListener("keydown", cancelOnEscape)
    return () => window.removeEventListener("keydown", cancelOnEscape)
  }, [cancelRelationMode, relationComposeBusy, relationComposeOpen, relationSource])

  const relationAction = useCallback((selection: SelectedPlacementContext, trigger: HTMLElement | null) => {
    if (!atlasRuntimeReady) return
    if (relationSource?.placementId === selection.placementId) {
      cancelRelationMode()
      return
    }
    const eligibility = atlasAuthoredRelationEligibility(selection, relationReferenceCounts)
    if (!eligibility.ok) {
      setCanvasActionStatus(eligibility.reason)
      return
    }
    const endpoint: AtlasRelationEndpoint = { ...selection, relationRef: eligibility.ref }
    if (!relationSource) {
      relationModeReturnFocusRef.current = trigger
      setRelationSource(endpoint)
      setCanvasActionStatus("")
      return
    }
    if (relationSource.relationRef === endpoint.relationRef) {
      setCanvasActionStatus("Choose a different exact object as the relation target.")
      return
    }
    setRelationTarget(endpoint)
    setRelationKind("related")
    setRelationRequest(null)
    setRelationComposeAmbiguous(false)
    setRelationComposeError("")
    setRelationComposeReturnFocus(trigger)
    setRelationComposeOpen(true)
  }, [atlasRuntimeReady, cancelRelationMode, relationReferenceCounts, relationSource])

  const swapRelationDirection = useCallback(() => {
    if (!relationSource || !relationTarget || relationRequest || relationComposeBusy) return
    setRelationSource(relationTarget)
    setRelationTarget(relationSource)
  }, [relationComposeBusy, relationRequest, relationSource, relationTarget])

  const confirmAuthoredRelation = useCallback(() => {
    if (!atlasRuntimeReady || !atlas || !relationSource || !relationTarget || relationComposeBusy) return
    let request = relationRequest
    if (!request) {
      const sourceEligibility = atlasAuthoredRelationEligibility(relationSource, relationReferenceCounts)
      const targetEligibility = atlasAuthoredRelationEligibility(relationTarget, relationReferenceCounts)
      if (!sourceEligibility.ok || !targetEligibility.ok) {
        setRelationComposeError("One exact relation endpoint is no longer uniquely available.")
        return
      }
      if (
        relationSource.placementId === relationTarget.placementId
        || sourceEligibility.ref === targetEligibility.ref
      ) {
        setRelationComposeError("Choose two different exact objects.")
        return
      }
      try {
        request = prepareAtlasAuthoredRelation({
          fromRef: sourceEligibility.ref,
          toRef: targetEligibility.ref,
          relation: relationKind,
          idempotencyKey: `atlas-relation:${crypto.randomUUID()}`,
        })
      } catch {
        setRelationComposeError("The exact relation request is no longer valid.")
        return
      }
      if (!relationRecoveryScope || typeof window === "undefined") {
        setRelationComposeError("This Atlas cannot checkpoint a safe relation retry yet.")
        return
      }
      try {
        writeAtlasAuthoredRelationRecovery(window.sessionStorage, relationRecoveryScope, {
          source: relationSource,
          target: relationTarget,
          request,
        })
      } catch {
        setRelationComposeError("Browser retry storage is unavailable. The relation was not sent.")
        return
      }
      setRelationRequest(request)
    }
    const controller = new AbortController()
    relationComposeAbortRef.current?.abort()
    relationComposeAbortRef.current = controller
    setRelationComposeBusy(true)
    setRelationComposeError("")
    void createAtlasAuthoredRelation(request, controller.signal).then((confirmed) => {
      if (controller.signal.aborted) return
      relationComposeAbortRef.current = null
      exactRelationMutationGenerationRef.current += 1
      setExactRelationRefreshEpoch((current) => current + 1)
      setAtlas((current) => {
        if (!current) return current
        let links: readonly AuthorizedObjectLink[] = current.objectLinks ?? []
        try {
          links = mergeAtlasAuthoredRelation(links, confirmed)
        } catch {
          return current
        }
        const uniqueCount = new Set(links.map((link) => link.id)).size
        return {
          ...current,
          objectLinks: [...links],
          sources: current.sources.map((source) => source.label === "Object links"
            ? { ...source, status: "partial", count: uniqueCount }
            : source),
        }
      })
      clearRelationComposer("Authored relation saved. The semantic edge is now available in Atlas, Graph, and Field.")
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      relationComposeAbortRef.current = null
      const failure = safeAtlasAuthoredRelationError(error)
      setRelationComposeBusy(false)
      setRelationComposeAmbiguous(failure.ambiguous)
      setRelationComposeError(failure.message)
    })
  }, [atlas, atlasRuntimeReady, clearRelationComposer, relationComposeBusy, relationKind, relationRecoveryScope, relationReferenceCounts, relationRequest, relationSource, relationTarget])
  const canvasShareInspection = useMemo(
    () => inspectAtlasCanvasShare(atlas?.durableCanvas),
    [atlas?.durableCanvas],
  )
  const canvasConversationShareInspection = useMemo(
    () => inspectAtlasCanvasConversationShare(
      atlas?.durableCanvas,
      selectedPlacementContext?.subjectRef,
    ),
    [atlas?.durableCanvas, selectedPlacementContext?.subjectRef],
  )
  const atlasCommands = useMemo(
    () => listAtlasCommands({
      hasSelectedTask: selectedTaskContext !== null,
      hasSelectedPlacement: selectedPlacementContext !== null,
      hasSelectedFrame: selectedFrameContext !== null,
      canPlaceReference: atlasMutationReady,
      canRemovePlacement: atlasMutationReady && selectedPlacementContext !== null,
      canRemoveFrame: atlasMutationReady && selectedFrameContext !== null,
      canMutateFrames: atlasMutationReady && Boolean(atlas?.durableCanvas),
      canCreateFrame: atlasMutationReady && Boolean(atlas?.durableCanvas)
        && (atlas?.durableCanvas?.content.frames?.length ?? 0) < 100,
      frameCreateUnavailableReason: (atlas?.durableCanvas?.content.frames?.length ?? 0) >= 100
        ? "This Atlas already has the maximum 100 presentation frames."
        : "Create or open a durable Atlas canvas before editing frames.",
      canCreateExperiment: atlasMutationReady && experimentPlacementRecovery === null,
      canShareCanvas: atlasMutationReady && canvasShareInspection.ok,
      canShareCanvasConversation: atlasMutationReady && canvasConversationShareInspection.ok,
      canShareSelection: atlasRuntimeReady && Boolean(selectedPlacementContext?.shareRef),
      canvasShareUnavailableReason: atlasCanvasShareUnavailableReason(
        canvasShareInspection,
        Boolean(atlas?.durableCanvas),
      ),
      canvasConversationShareUnavailableReason: canvasConversationShareInspection.ok
        ? ""
        : canvasConversationShareInspection.code === "conversation_scope_ambiguous"
          ? "Select the only exact conversation placement on this Atlas."
          : canvasConversationShareInspection.code === "exact_reference_required"
            ? "Pin every Atlas object before sharing it with a conversation."
            : "Select one exact conversation placement on a durable Atlas.",
      selectionShareUnavailableReason: selectedPlacementContext?.shareUnavailableReason
        || "Select an object with an exact resolved revision.",
      shareBusy,
      canSearchHam: !preview,
      canImportFormalPackage: atlasMutationReady && Boolean(atlas?.durableCanvas?.canvasId),
      canOpenProofRegistry: !preview,
      canReviewRelations: !preview,
      canCreateCanvas: canvasCreateBlockedReason() === null,
      canvasCreateUnavailableReason: canvasCreateBlockedReason()
        ?? "Wait for the current Atlas work to finish.",
    }),
    [
      atlas?.durableCanvas,
      atlasMutationReady,
      atlasRuntimeReady,
      canvasShareInspection,
      canvasConversationShareInspection,
      canvasCreateBlockedReason,
      experimentPlacementRecovery,
      preview,
      selectedPlacementContext,
      selectedFrameContext,
      selectedTaskContext,
      shareBusy,
    ],
  )
  const canvasCreateCommand = atlasCommands.find(
    (command) => command.id === "canvas.create.open",
  ) ?? null
  const voiceHudCommand = atlasCommands.find(
    (command) => command.id === "voice.capture.open",
  ) ?? null
  const proofHudCommand = atlasCommands.find(
    (command) => command.id === "proof.registry.open",
  ) ?? null
  const createHudCommands = atlasCommands.filter(
    (command) => command.hudGroup === "create",
  )

  useEffect(() => {
    const generation = ++hydrationGenerationRef.current
    if (!hydrationKey || !atlas?.durableCanvas) {
      setHydrationState({ key: null, byReference: EMPTY_ATLAS_HYDRATION })
      return
    }
    const removed = new Set(atlas.durableCanvas.content.removedItemIds)
    const references = [...new Set(
      atlas.durableCanvas.content.items
        .filter((item) => !removed.has(item.id))
        .map((item) => item.subjectRef),
    )]
    if (references.length === 0) {
      setHydrationState({ key: hydrationKey, byReference: EMPTY_ATLAS_HYDRATION })
      return
    }

    const controller = new AbortController()
    setHydrationState({
      key: hydrationKey,
      byReference: Object.freeze(Object.fromEntries(
        references.map((reference) => [reference, Object.freeze({ status: "loading" as const })]),
      )),
    })
    void hydrateAtlasObjectReferences(references, { signal: controller.signal })
      .then((hydrated) => {
        if (controller.signal.aborted || generation !== hydrationGenerationRef.current) return
        setHydrationState({ key: hydrationKey, byReference: hydrated.byReference })
        return hydrateAtlasSurfaceSpecs(
          hydrated.byReference,
          (surfaceId, version, signal) => galaxyBrainAPI.resolveSurface(surfaceId, version, signal),
          controller.signal,
        ).then((byReference) => {
          if (controller.signal.aborted || generation !== hydrationGenerationRef.current) return
          setHydrationState({ key: hydrationKey, byReference })
        })
      })
      .catch(() => {
        if (controller.signal.aborted || generation !== hydrationGenerationRef.current) return
        setHydrationState({
          key: hydrationKey,
          byReference: Object.freeze(Object.fromEntries(
            references.map((reference) => [reference, Object.freeze({
              requestedRef: reference,
              status: "request-failed" as const,
            })]),
          )),
        })
      })
    return () => controller.abort()
  }, [atlas?.durableCanvas, hydrationKey])

  useEffect(() => {
    if (!hamRelationRequest.ready || !hamRelationRequest.key) {
      setHamRelationState({ key: null, status: "ready" })
      return
    }
    if (hamRelationRequest.references.length === 0) {
      setHamRelationState({ key: hamRelationRequest.key, status: "ready" })
      return
    }
    const controller = new AbortController()
    const requestKey = hamRelationRequest.key
    setHamRelationState({ key: requestKey, status: "unavailable" })
    void requestHamRelationOverlay(hamRelationRequest.references, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return
        setHamRelationState({ key: requestKey, status: value.provider.status, value })
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setHamRelationState({ key: requestKey, status: "unavailable" })
      })
    return () => controller.abort()
  }, [hamRelationRequest])

  const hydrationStatus = useMemo(() => {
    const entries = Object.values(hydrationByReference)
    if (entries.length === 0) return ""
    const loadingCount = entries.filter((entry) => entry.status === "loading").length
    if (loadingCount > 0) return `Resolving ${entries.length} durable references…`
    const readyCount = entries.filter((entry) => entry.status === "resolved").length
    return `${readyCount} durable references ready; ${entries.length - readyCount} unavailable.`
  }, [hydrationByReference])

  const executeTaskCommand = useCallback((
    commandId: string,
    selection: SelectedTaskContext | null,
    trigger: HTMLButtonElement | null,
  ) => {
    const result = dispatchAtlasCommand(commandId, { subjectRef: selection?.subjectRef })
    const expectedRevision = selection && Number.isSafeInteger(selection.task.version) && (selection.task.version || 0) > 0
      ? `version:${selection.task.version}`
      : null
    if (
      !selection
      || !result.ok
      || result.effect.kind !== "open-task-plan"
      || result.effect.taskId !== selection.task.id
      || result.effect.subjectRef !== selection.subjectRef
      || result.effect.revision !== expectedRevision
    ) return
    setCommandDeckOpen(false)
    const taskSnapshot = selection.task
    const returnFocus = trigger?.isConnected ? trigger : commandTriggerRef.current
    window.requestAnimationFrame(() => {
      setConstructorTask(taskSnapshot)
      setConstructorReturnFocus(returnFocus)
      setConstructorOpen(true)
    })
  }, [])

  const executePlacementCommand = useCallback((
    commandId: string,
    selection: SelectedPlacementContext | null,
    trigger: HTMLElement | null,
  ) => {
    if (!atlasMutationReady) return
    const result = dispatchAtlasCommand(commandId, {
      placementId: selection?.placementId,
      subjectRef: selection?.subjectRef,
    })
    if (
      !selection
      || !result.ok
      || result.effect.kind !== "confirm-placement-remove"
      || result.effect.placementId !== selection.placementId
      || result.effect.subjectRef !== selection.subjectRef
    ) return
    setCommandDeckOpen(false)
    setPlacementRemoveTarget(selection)
    setPlacementRemovalError("")
    setPlacementRemovalReturnFocus(trigger?.isConnected ? trigger : commandTriggerRef.current)
    window.requestAnimationFrame(() => setPlacementRemoveOpen(true))
  }, [atlasMutationReady])

  const performAtlasShare = useCallback(async (request: AtlasShareRequest) => {
    const bundle = await galaxyBrainAPI.createShareBundle(
      request.mode === "object-only" ? {
          schemaId: "gb.share-bundle.v1",
          mode: "object-only",
          selector: request.selector,
          idempotencyKey: request.idempotencyKey,
        } : request.mode === "canvas-only" ? {
          schemaId: "gb.share-bundle.v1",
          mode: "canvas-only",
          selector: request.selector,
          idempotencyKey: request.idempotencyKey,
        } : {
          schemaId: "gb.share-bundle.v2",
          mode: "canvas-plus-conversation",
          selector: request.selector,
          idempotencyKey: request.idempotencyKey,
        },
    )
    if (
      !bundle
      || bundle.schemaId !== (request.mode === "canvas-plus-conversation"
        ? "gb.share-bundle.v2"
        : "gb.share-bundle.v1")
      || bundle.mode !== request.mode
      || typeof bundle.id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(bundle.id)
    ) throw new Error("Share bundle confirmation was invalid")
    const url = `${window.location.origin}/share/${encodeURIComponent(bundle.id)}`
    let copied = false
    try {
      await safeNavigator().clipboard.writeText(url)
      copied = true
    } catch {
      // The visible link remains available when clipboard permission is denied.
    }
    setShareRetryRequest(null)
    setShareNotice({
      state: "success",
      message: `${request.label} ${copied ? "created and copied" : "created"}. Access is limited to signed-in members of this Galaxy tenant.`,
      url,
    })
  }, [])

  const runAtlasShare = useCallback(async (request: AtlasShareRequest) => {
    if (shareBusyRef.current) return
    shareBusyRef.current = true
    setShareBusy(true)
    setShareNotice(null)
    try {
      await performAtlasShare(request)
    } catch {
      setShareRetryRequest(request)
      setShareNotice({
        state: "error",
        message: "The immutable share outcome could not be confirmed. Retry safely with the same request.",
      })
    } finally {
      shareBusyRef.current = false
      setShareBusy(false)
    }
  }, [performAtlasShare])

  const executeSelectionShareCommand = useCallback(() => {
    const objectRef = selectedPlacementContext?.shareRef
    if (!objectRef) return
    const result = dispatchAtlasCommand("share.selection.create", { objectRef })
    if (!result.ok || result.effect.kind !== "create-object-share") return
    setCommandDeckOpen(false)
    void runAtlasShare({
      mode: "object-only",
      selector: result.effect.selector,
      idempotencyKey: `share:${crypto.randomUUID()}`,
      label: "Immutable selected-object share",
    })
  }, [runAtlasShare, selectedPlacementContext?.shareRef])

  const executeCanvasShareCommand = useCallback(() => {
    const current = atlas?.durableCanvas
    if (!current || shareBusyRef.current) return
    setCommandDeckOpen(false)
    shareBusyRef.current = true
    setShareBusy(true)
    setShareNotice(null)
    let retryRequest: AtlasShareRequest | null = null
    void galaxyBrainAPI.getCanvas(current.canvasId)
      .then(async (fresh) => {
        const inspected = inspectAtlasCanvasShare(fresh)
        if (!inspected.ok) {
          setShareRetryRequest(null)
          setShareNotice({
            state: "error",
            message: inspected.code === "exact_reference_required"
              ? "This saved Atlas still contains follow-latest references. Share an exact selected object instead."
              : inspected.code === "conversation_excluded"
                ? "This saved Atlas contains a conversation reference. Transcript-linked canvases are not shared from Atlas."
              : "The saved Atlas revision is not available for sharing.",
          })
          return
        }
        const result = dispatchAtlasCommand("share.canvas.create", inspected.selector)
        if (!result.ok || result.effect.kind !== "create-canvas-share") {
          setShareNotice({ state: "error", message: "The saved Atlas revision is not available for sharing." })
          return
        }
        const request: AtlasShareRequest = {
          mode: "canvas-only",
          selector: result.effect.selector,
          idempotencyKey: `share:${crypto.randomUUID()}`,
          label: "Immutable Atlas snapshot",
        }
        retryRequest = request
        setAtlas((value) => value ? { ...value, durableCanvas: fresh } : value)
        await performAtlasShare(request)
      })
      .catch(() => {
        setShareRetryRequest(retryRequest)
        setShareNotice({
          state: "error",
          message: retryRequest
            ? "The immutable share outcome could not be confirmed. Retry safely with the same request."
            : "The latest saved Atlas revision could not be loaded. No share link was created.",
        })
      })
      .finally(() => {
        shareBusyRef.current = false
        setShareBusy(false)
      })
  }, [atlas?.durableCanvas, performAtlasShare])

  const prepareCanvasConversationShare = useCallback((
    selected: SelectedPlacementContext,
    trigger: HTMLElement | null,
  ) => {
    const current = atlas?.durableCanvas
    if (!current || !selected || shareBusyRef.current) return
    setCommandDeckOpen(false)
    setShareScopeReturnFocus(trigger?.isConnected ? trigger : commandTriggerRef.current)
    setShareNotice(null)
    setShareRetryRequest(null)
    const inspected = inspectAtlasCanvasConversationShare(current, selected.subjectRef)
    if (!inspected.ok) {
      setShareNotice({
        state: "error",
        message: inspected.code === "conversation_scope_ambiguous"
          ? "The visible Atlas does not contain exactly this one conversation placement. No bundle was created."
          : "The visible exact Atlas and conversation revisions are not available for a combined bundle.",
      })
      return
    }
    const result = dispatchAtlasCommand("share.canvas-conversation.create", inspected.selector)
    if (!result.ok || result.effect.kind !== "confirm-canvas-conversation-share") {
      setShareNotice({ state: "error", message: "The combined share scope could not be verified." })
      return
    }
    const request: AtlasShareRequest = {
      mode: "canvas-plus-conversation",
      selector: result.effect.selector,
      idempotencyKey: `share:${crypto.randomUUID()}`,
      label: "Immutable Atlas + redacted conversation bundle",
    }
    setShareScope({
      canvasTitle: current.title,
      canvasVersion: current.version,
      itemCount: current.content.items.length,
      edgeCount: current.content.edges.length,
      conversationLabel: selected.label,
      conversationRef: result.effect.selector.conversationRef,
    })
    setShareScopeRequest(request)
    setShareScopeOpen(true)
  }, [atlas?.durableCanvas])

  const executeCanvasConversationShareCommand = useCallback(() => {
    if (!selectedPlacementContext) return
    prepareCanvasConversationShare(selectedPlacementContext, commandTriggerRef.current)
  }, [prepareCanvasConversationShare, selectedPlacementContext])

  const copyShareUrl = useCallback(() => {
    if (!shareNotice?.url) return
    const url = shareNotice.url
    const clipboard = safeNavigator().clipboard
    if (!clipboard?.writeText) {
      setShareNotice((notice) => notice && notice.url === url
        ? { ...notice, message: "Copy is unavailable here. Select the visible URL and copy it manually." }
        : notice)
      return
    }
    void clipboard.writeText(url)
      .then(() => setShareNotice((notice) => notice && notice.url === url
        ? {
            ...notice,
            message: "Immutable share link copied. Access remains limited to signed-in members of this Galaxy tenant.",
          }
        : notice))
      .catch(() => setShareNotice((notice) => notice && notice.url === url
        ? { ...notice, message: "Copy was denied. Select the visible URL and copy it manually." }
        : notice))
  }, [shareNotice?.url])

  const executeSelectedAtlasCommand = useCallback((
    commandId: string,
    trigger: HTMLElement | null = commandTriggerRef.current,
  ) => {
    commandPresenterReturnFocusRef.current = trigger?.isConnected ? trigger : commandTriggerRef.current
    if (commandId === "canvas.create.open") {
      const result = dispatchAtlasCommand(commandId, {})
      if (!result.ok || result.effect.kind !== "open-canvas-create") return
      const blockedReason = canvasCreateBlockedReason()
      if (blockedReason || !canvasCreateScope) {
        setCanvasActionStatus(blockedReason ?? "The current Atlas workspace is unavailable.")
        return
      }
      setCanvasActionStatus("")
      setCommandDeckOpen(false)
      window.requestAnimationFrame(() => setCanvasCreateOpen(true))
      return
    }
    if (commandId === "frame.create.open") {
      if (frameMutationOperation?.kind === "remove") {
        setCanvasActionStatus("Recover the pending frame removal before creating another frame.")
        return
      }
      const result = dispatchAtlasCommand(commandId, {})
      if (!result.ok || result.effect.kind !== "open-frame-create") return
      setCommandDeckOpen(false)
      setFrameMutationError("")
      window.requestAnimationFrame(() => setFrameCreateOpen(true))
      return
    }
    if (commandId === "share.selection.create") {
      executeSelectionShareCommand()
      return
    }
    if (commandId === "share.canvas.create") {
      executeCanvasShareCommand()
      return
    }
    if (commandId === "share.canvas-conversation.create") {
      executeCanvasConversationShareCommand()
      return
    }
    if (commandId === "code.editor.open") {
      if (!codeDraftScope) return
      if (markdownNotePhase !== "idle" || markdownNoteRecovery || markdownNoteAmbiguous) {
        setCanvasActionStatus("Finish or explicitly discard the current Markdown note recovery before opening a code file.")
        return
      }
      const result = dispatchAtlasCommand(commandId, {})
      if (!result.ok || result.effect.kind !== "open-code-editor") return
      setCommandDeckOpen(false)
      setCodeEditorPreset("code")
      setCodeSaveError("")
      window.requestAnimationFrame(() => setCodeEditorOpen(true))
      return
    }
    if (commandId === "code.graph.snapshot.import") {
      const result = dispatchAtlasCommand(commandId, {})
      if (!result.ok || result.effect.kind !== "open-code-graph-snapshot-import") return
      const target = currentAtlasTargetRef.current
      if (!codeGraphSnapshotRecovery && (!target.ready || !target.canvasId)) {
        setCanvasActionStatus("Wait for the live Atlas canvas to finish loading before importing a code graph snapshot.")
        return
      }
      setCanvasActionStatus("")
      setCommandDeckOpen(false)
      if (!codeGraphSnapshotRecovery && !codeGraphSnapshotAmbiguous) {
        setCodeGraphSnapshotTarget({ workspaceId: target.workspaceId, canvasId: target.canvasId as string })
        setCodeGraphSnapshotError("")
      }
      window.requestAnimationFrame(() => setCodeGraphSnapshotOpen(true))
      return
    }
    if (commandId === "document.note.create") {
      if (!codeDraftScope) return
      if (codeSavePhase !== "idle" || importedCodeDocument || codeSaveAmbiguous) {
        setCanvasActionStatus("Finish or explicitly discard the current code-file recovery before opening a Markdown note.")
        return
      }
      const result = dispatchAtlasCommand(commandId, {})
      if (!result.ok || result.effect.kind !== "open-markdown-note") return
      setCommandDeckOpen(false)
      setCodeEditorPreset("markdown-note")
      setMarkdownNoteError("")
      setMarkdownNoteIngestionNotice("")
      window.requestAnimationFrame(() => setCodeEditorOpen(true))
      return
    }
    if (commandId === "voice.capture.open") {
      if (!codeDraftScope) return
      const result = dispatchAtlasCommand(commandId, {})
      if (!result.ok || result.effect.kind !== "open-voice-capture") return
      setCommandDeckOpen(false)
      setVoiceSaveError("")
      window.requestAnimationFrame(() => setVoiceCaptureOpen(true))
      return
    }
    if (commandId === "document.import") {
      const result = dispatchAtlasCommand(commandId, {})
      if (!result.ok || result.effect.kind !== "open-document-import") return
      setCommandDeckOpen(false)
      setDocumentImportError("")
      setDocumentImportErrorField(null)
      window.requestAnimationFrame(() => setDocumentImportOpen(true))
      return
    }
    if (commandId === "datasource.manage.open") {
      const result = dispatchAtlasCommand(commandId, {})
      if (!result.ok || result.effect.kind !== "open-datasource-manager") return
      setCommandDeckOpen(false)
      setDatasourcePlacementError("")
      window.requestAnimationFrame(() => setDatasourceManagerOpen(true))
      return
    }
    if (commandId === "ink.draw.open") {
      const result = dispatchAtlasCommand(commandId, {})
      if (!result.ok || result.effect.kind !== "open-ink-drawing") return
      setCommandDeckOpen(false)
      setInkDrawingError("")
      window.requestAnimationFrame(() => setInkDrawingOpen(true))
      return
    }
    if (commandId === "ham.memory.search.open") {
      if (preview) return
      const result = dispatchAtlasCommand(commandId, {})
      if (!result.ok || result.effect.kind !== "open-ham-memory-search") return
      setCommandDeckOpen(false)
      window.requestAnimationFrame(() => setHamMemoryOpen(true))
      return
    }
    if (commandId === "legacy.flow.portability.open") {
      const result = dispatchAtlasCommand(commandId, {})
      if (!result.ok || result.effect.kind !== "open-legacy-flow-portability") return
      setCommandDeckOpen(false)
      window.requestAnimationFrame(() => setLegacyFlowPortabilityOpen(true))
      return
    }
    if (commandId === "eln.experiment.create") {
      const result = dispatchAtlasCommand(commandId, {})
      if (!result.ok || result.effect.kind !== "open-eln-experiment-create") return
      setCommandDeckOpen(false)
      window.requestAnimationFrame(() => setExperimentCreateOpen(true))
      return
    }
    if (commandId === "reference.place") {
      const result = dispatchAtlasCommand(commandId, {})
      if (!result.ok || result.effect.kind !== "open-reference-place") return
      setCommandDeckOpen(false)
      setReferencePlacementError("")
      window.requestAnimationFrame(() => setReferenceDialogOpen(true))
      return
    }
    if (commandId === "web.capture.open") {
      const result = dispatchAtlasCommand(commandId, {})
      if (!result.ok || result.effect.kind !== "open-web-capture") return
      setCommandDeckOpen(false)
      if (!webCaptureRecovery && !webCaptureAmbiguous) setWebCaptureError("")
      window.requestAnimationFrame(() => setWebCaptureOpen(true))
      return
    }
    if (commandId === "paper.import") {
      const result = dispatchAtlasCommand(commandId, {})
      if (!result.ok || result.effect.kind !== "open-paper-import") return
      setCommandDeckOpen(false)
      setPaperImportError("")
      window.requestAnimationFrame(() => setPaperImportOpen(true))
      return
    }
    if (commandId === "proof.package.import") {
      if (!atlasRuntimeReady || !atlas?.durableCanvas?.canvasId) return
      const result = dispatchAtlasCommand(commandId, {})
      if (!result.ok || result.effect.kind !== "open-proof-package-import") return
      setCommandDeckOpen(false)
      setFormalPackagePlacementError("")
      window.requestAnimationFrame(() => setFormalPackageImportOpen(true))
      return
    }
    if (commandId === "proof.registry.open") {
      if (preview) return
      const result = dispatchAtlasCommand(commandId, {})
      if (!result.ok || result.effect.kind !== "open-proof-registry") return
      setCommandDeckOpen(false)
      window.location.assign("/graph?proofRegistry=open")
      return
    }
    if (commandId === "relations.review.open") {
      if (preview) return
      const result = dispatchAtlasCommand(commandId, {})
      if (!result.ok || result.effect.kind !== "open-relation-proposal-review") return
      setCommandDeckOpen(false)
      window.requestAnimationFrame(() => setRelationReviewOpen(true))
      return
    }
    if (commandId === "surface.place.open") {
      const result = dispatchAtlasCommand(commandId, {})
      if (!result.ok || result.effect.kind !== "open-surface-place") return
      setCommandDeckOpen(false)
      setReferencePlacementError("")
      window.requestAnimationFrame(() => setSurfacePlaceOpen(true))
      return
    }
    if (commandId === "placement.remove") {
      executePlacementCommand(commandId, selectedPlacementContext, commandTriggerRef.current)
      return
    }
    if (commandId === "frame.remove") {
      const selected = selectedFrameContext
      const frame = runtimeProjection?.frames?.find((candidate) => candidate.id === selected?.frameId)
      if (frame) removeAtlasFrame(frame)
      return
    }
    executeTaskCommand(commandId, selectedTaskContext, commandTriggerRef.current)
  }, [
    atlas?.durableCanvas?.canvasId,
    atlasRuntimeReady,
    canvasCreateBlockedReason,
    canvasCreateScope,
    codeGraphSnapshotAmbiguous,
    codeGraphSnapshotRecovery,
    codeSaveAmbiguous,
    codeSavePhase,
    codeDraftScope,
    executeCanvasShareCommand,
    executeCanvasConversationShareCommand,
    executePlacementCommand,
    executeSelectionShareCommand,
    executeTaskCommand,
    frameMutationOperation,
    importedCodeDocument,
    markdownNoteAmbiguous,
    markdownNotePhase,
    markdownNoteRecovery,
    preview,
    selectedPlacementContext,
    selectedFrameContext,
    selectedTaskContext,
    runtimeProjection,
    removeAtlasFrame,
    webCaptureAmbiguous,
    webCaptureRecovery,
  ])

  const placeReference = useCallback((
    subjectRef: string,
    operationId?: string,
    point?: ReferencePlacementPoint,
  ) => {
    if (referencePlacementRequest) return false
    if (!atlasMutationReady) {
      setReferencePlacementError("Wait for the current Atlas mutation to finish.")
      return false
    }
    if (preview) {
      setReferencePlacementError("Reference placement is available on the live Atlas.")
      return false
    }
    if (!mounted || !atlas || !runtimeProjection || loading || loadError) {
      setReferencePlacementError("Wait for the live Atlas canvas to finish loading.")
      return false
    }
    setReferencePlacementError("")
    setReferencePlacementAnnouncement("")
    setView("canvas")
    const request = referencePlacementRetry?.subjectRef === subjectRef
      && (!operationId || referencePlacementRetry.operationId === operationId)
      ? { ...referencePlacementRetry, attempt: referencePlacementRetry.attempt + 1 }
      : { operationId: operationId || crypto.randomUUID(), subjectRef, attempt: 1, ...(point ? { point } : {}) }
    setReferencePlacementRetry(null)
    setReferencePlacementRequest(request)
    return true
  }, [atlas, atlasMutationReady, loadError, loading, mounted, preview, referencePlacementRequest, referencePlacementRetry, runtimeProjection])

  const confirmReferenceHandoff = useCallback(() => {
    const handoff = referenceHandoff
    if (
      !handoff?.subjectRef
      || referenceHandoffBusyRef.current
      || handoff.phase === "authorizing"
      || handoff.phase === "reauthorizing"
      || handoff.phase === "placing"
    ) return

    const recovery = referenceHandoffRecovery?.operationId === handoff.operationId
      ? referenceHandoffRecovery
      : null
    if (recovery) {
      if (!atlas || atlas.workspaceId !== recovery.workspaceId) {
        setReferenceHandoff({
          ...handoff,
          phase: "error",
          error: "This pending placement belongs to another workspace and cannot be moved here.",
        })
        return
      }
      if (atlas.durableCanvas?.canvasId !== recovery.canvasId) {
        requestAtlasReload("Finish the current Atlas placement before opening the recovery canvas.", () => {
          prepareCanvasNavigation()
          const next = new URL(window.location.href)
          next.searchParams.set("canvas", recovery.canvasId)
          next.searchParams.delete("placement")
          next.searchParams.delete("placeRef")
          window.history.replaceState(window.history.state, "", `${next.pathname}${next.search}${next.hash}`)
          preservedReferenceHandoffHrefRef.current = `${next.pathname}${next.search}${next.hash}`
          setReferenceHandoff({
            ...handoff,
            phase: "error",
            error: "Loading the exact Atlas canvas that owns this pending placement. Retry again after it finishes loading.",
          })
        })
        return
      }
    }

    referenceHandoffBusyRef.current = true
    const generation = referenceHandoffGenerationRef.current + 1
    referenceHandoffGenerationRef.current = generation
    referenceHandoffAbortRef.current?.abort()
    const controller = new AbortController()
    referenceHandoffAbortRef.current = controller
    setReferenceHandoff({ ...handoff, phase: "reauthorizing", error: "" })

    void resolveReferenceHandoff(handoff.subjectRef, controller.signal, {
      ...(handoff.kind ? { kind: handoff.kind } : {}),
      objectId: handoff.objectId,
      ...(handoff.sourceRevisionId ? { sourceRevisionId: handoff.sourceRevisionId } : {}),
      revisionSha256: handoff.revisionSha256,
    }).then((authorized) => {
      if (controller.signal.aborted || referenceHandoffGenerationRef.current !== generation) return
      referenceHandoffAbortRef.current = null
      if (!authorized.ok) {
        referenceHandoffBusyRef.current = false
        setReferenceHandoff({
          ...handoff,
          phase: "error",
          error: referenceHandoffError(authorized.code),
        })
        clearReferenceHandoffLocation(true)
        return
      }

      // The id is minted only after confirmation-time authorization succeeds,
      // then retained across an ambiguous or failed placement retry.
      const operationId = handoff.operationId || crypto.randomUUID()
      const authorizedHandoff: ReferenceHandoffState = {
        subjectRef: authorized.subjectRef,
        kind: authorized.kind,
        objectId: authorized.objectId,
        sourceRevisionId: authorized.sourceRevisionId ?? null,
        revisionSha256: authorized.revisionSha256,
        title: authorized.projection.title,
        phase: "placing",
        error: "",
        operationId,
      }
      referenceHandoffPlacementBindingRef.current = authorizedHandoff
      if (!placeReference(authorized.subjectRef, operationId)) {
        referenceHandoffPlacementBindingRef.current = null
        referenceHandoffBusyRef.current = false
        setReferenceHandoff({
          ...authorizedHandoff,
          phase: "error",
          error: "Atlas is busy or still loading. Nothing was placed. Try again when the current operation finishes.",
        })
        clearReferenceHandoffLocation(true)
        return
      }
      referenceHandoffOperationRef.current = operationId
      setReferenceHandoff(authorizedHandoff)
      clearReferenceHandoffLocation(true)
    }).catch((error: unknown) => {
      if (
        controller.signal.aborted
        || referenceHandoffGenerationRef.current !== generation
        || (error instanceof DOMException && error.name === "AbortError")
      ) return
      referenceHandoffAbortRef.current = null
      referenceHandoffBusyRef.current = false
      setReferenceHandoff({
        ...handoff,
        phase: "error",
        error: referenceHandoffError("unavailable"),
      })
      clearReferenceHandoffLocation(true)
    })
  }, [atlas, clearReferenceHandoffLocation, placeReference, prepareCanvasNavigation, referenceHandoff, referenceHandoffRecovery, requestAtlasReload])

  const changePaperImportOpen = useCallback((nextOpen: boolean) => {
    if (!nextOpen && paperImportPhase !== "idle") return
    setPaperImportOpen(nextOpen)
    if (!nextOpen && !paperImportRecovery) setPaperImportError("")
  }, [paperImportPhase, paperImportRecovery])

  const acquirePaperAndPlace = useCallback(async (selection: ArxivPaperMetadata) => {
    if (paperImportPhase !== "idle" || referencePlacementRequest) return
    if (!paperArxivImportRegistered()) {
      setPaperImportError("Exact arXiv import is unavailable because its registered Papers capability changed.")
      return
    }
    const target = currentAtlasTargetRef.current
    if (!target.ready || !target.canvasId) {
      setPaperImportError("Wait for a durable authorized Atlas canvas before importing a paper.")
      return
    }

    const operationId = crypto.randomUUID()
    const generation = paperImportGenerationRef.current + 1
    paperImportGenerationRef.current = generation
    paperImportAbortRef.current?.abort()
    const abortController = new AbortController()
    paperImportAbortRef.current = abortController
    setPaperImportError("")
    setPaperImportPhase("acquiring")
    try {
      const acquisition = await acquireExactArxivPaper(
        galaxyBrainAPI,
        selection,
        abortController.signal,
      )
      if (abortController.signal.aborted || paperImportGenerationRef.current !== generation) return
      let recovery: PaperImportPlacementRecovery
      try {
        recovery = writePaperImportPlacementRecovery(
          window.localStorage,
          paperImportRecoveryScope,
          {
            operationId,
            workspaceId: target.workspaceId,
            canvasId: target.canvasId,
            subjectRef: acquisition.document.ref,
            durableDocument: acquisition.document,
            arxiv_id: acquisition.revision.metadata.arxiv_id,
            arxiv_version: acquisition.revision.metadata.arxiv_version,
            title: acquisition.document.title,
          },
        )
      } catch {
        setPaperImportPhase("idle")
        setPaperImportError("The exact PDF is durable, but Galaxy Brain could not checkpoint its placement. It was not placed; reopen it from Papers before trying again.")
        return
      }
      setPaperImportRecovery(recovery)
      const current = currentAtlasTargetRef.current
      if (
        !current.ready
        || current.workspaceId !== recovery.workspaceId
        || current.canvasId !== recovery.canvasId
      ) {
        setPaperImportPhase("idle")
        setPaperImportError("The exact PDF is durable, but the original Atlas canvas is no longer active. Retry placement only; do not import or fetch it again.")
        return
      }
      setPaperImportPhase("placing")
      if (!placeReference(recovery.subjectRef, recovery.operationId)) {
        setPaperImportPhase("idle")
        setPaperImportError("The exact PDF is durable, but this Atlas is not ready to place it. Retry placement only.")
      }
    } catch (error) {
      if (abortController.signal.aborted || paperImportGenerationRef.current !== generation) return
      setPaperImportPhase("idle")
      setPaperImportError(error instanceof Error
        ? error.message
        : "The exact arXiv paper could not be imported and preserved privately.")
    } finally {
      if (paperImportAbortRef.current === abortController) paperImportAbortRef.current = null
    }
  }, [paperImportPhase, paperImportRecoveryScope, placeReference, referencePlacementRequest])

  const retryPaperImportPlacement = useCallback(() => {
    const recovery = paperImportRecovery
    if (!recovery || paperImportPhase !== "idle" || referencePlacementRequest) return
    if (!atlas || atlas.workspaceId !== recovery.workspaceId) {
      setPaperImportError("This exact paper import belongs to a different workspace and cannot be placed here.")
      return
    }
    if (atlas.durableCanvas?.canvasId !== recovery.canvasId) {
      requestAtlasReload("Finish the current Atlas placement before opening the paper recovery canvas.", () => {
        prepareCanvasNavigation()
        const next = new URL(window.location.href)
        next.searchParams.set("canvas", recovery.canvasId)
        next.searchParams.delete("placement")
        window.history.replaceState(null, "", `${next.pathname}${next.search}${next.hash}`)
        setPaperImportError("Loading the original Atlas canvas for this exact paper document…")
      })
      return
    }
    if (!atlasRuntimeReady) {
      setPaperImportError("Wait for the original Atlas canvas to finish loading before retrying placement.")
      return
    }
    setPaperImportError("")
    setPaperImportPhase("placing")
    if (!placeReference(recovery.subjectRef, recovery.operationId)) {
      setPaperImportPhase("idle")
      setPaperImportError("The exact PDF is durable, but this Atlas is not ready to place it. Retry placement only.")
    }
  }, [atlas, atlasRuntimeReady, paperImportPhase, paperImportRecovery, placeReference, prepareCanvasNavigation, referencePlacementRequest, requestAtlasReload])

  const changeWebCaptureOpen = useCallback((nextOpen: boolean) => {
    if (!nextOpen && webCapturePhase !== "idle") return
    setWebCaptureOpen(nextOpen)
    if (!nextOpen && !webCaptureRecovery && !webCaptureAmbiguous) {
      setWebCaptureError("")
      setWebCaptureIntent(null)
    }
  }, [webCaptureAmbiguous, webCapturePhase, webCaptureRecovery])

  const editWebCapture = useCallback(() => {
    if (webCapturePhase !== "idle" || webCaptureAmbiguous || webCaptureRecovery) return
    setWebCaptureError("")
    setWebCaptureIntent(null)
  }, [webCaptureAmbiguous, webCapturePhase, webCaptureRecovery])

  const abandonWebCapture = useCallback(() => {
    if (webCapturePhase !== "idle" || webCaptureRecovery) return
    webCaptureAbortRef.current?.abort()
    webCaptureGenerationRef.current += 1
    setWebCaptureIntent(null)
    setWebCaptureAmbiguous(false)
    setWebCaptureError("")
    setWebCaptureOpen(false)
  }, [webCapturePhase, webCaptureRecovery])

  const captureWebContentAndPlace = useCallback(async (input: AtlasWebCaptureInput) => {
    const generation = claimAtlasWebCaptureFlight(webCaptureFlightOwnerRef, webCaptureGenerationRef)
    if (generation === null) return
    try {
        if (webCapturePhase !== "idle" || webCaptureRecovery || referencePlacementRequest) return
        if (!atlasWebCaptureRegistered()) {
          setWebCaptureError("Web capture is unavailable because its registered capability changed.")
          return
        }
        const target = currentAtlasTargetRef.current
        if (!target.ready || !target.canvasId) {
          setWebCaptureError("Wait for a durable authorized Atlas canvas before saving a web capture.")
          return
        }

        let frozenIntent = webCaptureIntent
        try {
          frozenIntent ??= prepareAtlasWebCaptureIntent(input)
        } catch (error) {
          setWebCaptureError(error instanceof Error ? error.message : "The web capture fields are invalid.")
          return
        }
        setWebCaptureIntent(frozenIntent)
        webCaptureAbortRef.current?.abort()
        const abortController = new AbortController()
        webCaptureAbortRef.current = abortController
        setWebCaptureError("")
        setWebCapturePhase("capturing")
        try {
          const document = await captureAtlasWebContent(frozenIntent, { signal: abortController.signal })
          if (abortController.signal.aborted || webCaptureGenerationRef.current !== generation) return
          const recovery = createAtlasWebCapturePlacementRecovery({
            operationId: crypto.randomUUID(),
            workspaceId: target.workspaceId,
            canvasId: target.canvasId,
            subjectRef: document.ref,
            durableDocument: document,
            captureUrl: frozenIntent.capture.url,
            title: frozenIntent.capture.title,
            format: frozenIntent.capture.format,
          })
          setWebCaptureRecovery(recovery)
          setWebCaptureIntent(null)
          setWebCaptureAmbiguous(false)
          try {
            writeAtlasWebCapturePlacementRecovery(
              window.localStorage,
              webCaptureRecoveryScope,
              {
                operationId: recovery.operationId,
                workspaceId: recovery.workspaceId,
                canvasId: recovery.canvasId,
                subjectRef: recovery.subjectRef,
                durableDocument: recovery.durableDocument,
                captureUrl: recovery.captureUrl,
                title: recovery.title,
                format: recovery.format,
              },
            )
          } catch {
            setWebCapturePhase("idle")
            setWebCaptureError("The exact capture is durable, but its placement checkpoint could not be saved. Keep this dialog open and retry placement without capturing again.")
            return
          }
          const current = currentAtlasTargetRef.current
          if (
            !current.ready
            || current.workspaceId !== recovery.workspaceId
            || current.canvasId !== recovery.canvasId
          ) {
            setWebCapturePhase("idle")
            setWebCaptureError("The exact capture is durable, but the original Atlas canvas is no longer active. Retry placement only.")
            return
          }
          setWebCapturePhase("placing")
          if (!placeReference(recovery.subjectRef, recovery.operationId)) {
            setWebCapturePhase("idle")
            setWebCaptureError("The exact capture is durable, but this Atlas is not ready to place it. Retry placement only.")
          }
        } catch (error) {
          if (abortController.signal.aborted || webCaptureGenerationRef.current !== generation) return
          const captureError = error instanceof AtlasWebCaptureError ? error : null
          setWebCaptureAmbiguous(Boolean(captureError?.ambiguous))
          setWebCapturePhase("idle")
          setWebCaptureError(captureError?.message || "Web capture is temporarily unavailable. No unconfirmed details were accepted.")
        } finally {
          if (webCaptureAbortRef.current === abortController) webCaptureAbortRef.current = null
        }
    } finally {
      releaseAtlasWebCaptureFlight(webCaptureFlightOwnerRef, generation)
    }
  }, [placeReference, referencePlacementRequest, webCaptureIntent, webCapturePhase, webCaptureRecovery, webCaptureRecoveryScope])

  const retryWebCapturePlacement = useCallback(() => {
    const recovery = webCaptureRecovery
    if (!recovery || webCapturePhase !== "idle" || referencePlacementRequest) return
    if (!atlas || atlas.workspaceId !== recovery.workspaceId) {
      setWebCaptureError("This exact web capture belongs to a different workspace and cannot be placed here.")
      return
    }
    if (atlas.durableCanvas?.canvasId !== recovery.canvasId) {
      requestAtlasReload("Finish the current Atlas placement before opening the web-capture recovery canvas.", () => {
        prepareCanvasNavigation()
        const next = new URL(window.location.href)
        next.searchParams.set("canvas", recovery.canvasId)
        next.searchParams.delete("placement")
        window.history.replaceState(null, "", `${next.pathname}${next.search}${next.hash}`)
        setWebCaptureError("Loading the original Atlas canvas for this exact web capture…")
      })
      return
    }
    if (!atlasRuntimeReady) {
      setWebCaptureError("Wait for the original Atlas canvas to finish loading before retrying placement.")
      return
    }
    setWebCaptureError("")
    setWebCapturePhase("placing")
    if (!placeReference(recovery.subjectRef, recovery.operationId)) {
      setWebCapturePhase("idle")
      setWebCaptureError("The exact capture is durable, but this Atlas is not ready to place it. Retry placement only.")
    }
  }, [atlas, atlasRuntimeReady, placeReference, prepareCanvasNavigation, referencePlacementRequest, requestAtlasReload, webCapturePhase, webCaptureRecovery])

  const importFormalProjectPackage = useCallback(async (
    summary: FormalProjectPackageSummary,
    signal: AbortSignal,
    selectionContext: string,
  ): Promise<"selected" | "failed"> => {
    if (signal.aborted) return "failed"
    let basePlacement: FormalProjectPackageAtlasPlacement
    try {
      basePlacement = formalProjectPackageAtlasPlacement(summary)
    } catch {
      setFormalPackagePlacementError("The package is registered, but its exact graph placement identity is invalid.")
      return "failed"
    }
    const binding = parseFormalPackageSelectionContext(selectionContext)
    if (!binding) {
      setFormalPackagePlacementError("The package is registered, but its original Atlas target could not be recovered.")
      return "failed"
    }
    const placement = { ...basePlacement, ...binding }
    setFormalPackagePlacement(placement)
    setFormalPackagePlacementError("")
    const current = currentAtlasTargetRef.current
    if (!current.ready || current.workspaceId !== binding.workspaceId || current.canvasId !== binding.canvasId) {
      setFormalPackagePlacementError("The package is registered, but the original Atlas canvas is no longer active. Retry placement to return to that canvas without importing again.")
      return "failed"
    }
    setFormalPackagePlacing(true)
    if (!placeReference(placement.subjectRef, placement.operationId)) {
      setFormalPackagePlacing(false)
      setFormalPackagePlacementError("The package is registered, but this Atlas is not ready to place it. Retry placement without importing again.")
      return "failed"
    }
    return "selected"
  }, [placeReference])

  const retryFormalProjectPackagePlacement = useCallback(() => {
    const placement = formalPackagePlacement
    if (!placement || formalPackagePlacing || referencePlacementRequest) return
    if (!atlas || atlas.workspaceId !== placement.workspaceId) {
      setFormalPackagePlacementError("This imported graph belongs to a different workspace and cannot be placed here.")
      return
    }
    if (atlas.durableCanvas?.canvasId !== placement.canvasId) {
      requestAtlasReload("Finish the current Atlas placement before opening the graph recovery canvas.", () => {
        prepareCanvasNavigation()
        const next = new URL(window.location.href)
        next.searchParams.set("canvas", placement.canvasId)
        next.searchParams.delete("placement")
        window.history.replaceState(null, "", `${next.pathname}${next.search}${next.hash}`)
        setFormalPackagePlacementError("Loading the original Atlas canvas for this imported graph…")
      })
      return
    }
    if (!atlasRuntimeReady) {
      setFormalPackagePlacementError("Wait for the original Atlas canvas to finish loading before retrying placement.")
      return
    }
    setFormalPackagePlacementError("")
    setFormalPackagePlacing(true)
    if (!placeReference(placement.subjectRef, placement.operationId)) {
      setFormalPackagePlacing(false)
      setFormalPackagePlacementError("This Atlas is not ready to place the imported graph. Retry placement without importing again.")
    }
  }, [atlas, atlasRuntimeReady, formalPackagePlacement, formalPackagePlacing, placeReference, prepareCanvasNavigation, referencePlacementRequest, requestAtlasReload])

  const rejectAtlasDropImport = useCallback((message: string) => {
    setAtlasDropImportError(message)
    setPendingDrop((current) => current?.operationId ? current : current ? { ...current, phase: "error", message } : current)
    setReferencePlacementAnnouncement("This Atlas drop attempt was rejected without a durable write.")
  }, [])

  const importAtlasObjectDrop = useCallback(async (
    intent: AtlasObjectDragIntent,
    point: ReferencePlacementPoint,
    targetCanvas: CanvasEnvelope,
  ) => {
    if (atlasDropImportRecoveryRef.current || atlasObjectDropRecoveryRef.current) {
      setReferencePlacementAnnouncement("Finish or retry the pending dropped item before placing another.")
      return
    }
    if (!atlasRuntimeReady || !atlas || referencePlacementRequest || placementRemovalRequest) {
      rejectAtlasDropImport("Wait for the live Atlas canvas to finish its current placement before dropping an object.")
      return
    }
    if (
      targetCanvas.workspaceId !== atlas.workspaceId
      || (atlas.durableCanvas !== null && atlas.durableCanvas.canvasId !== targetCanvas.canvasId)
    ) {
      rejectAtlasDropImport("A durable authorized Atlas canvas is required before placing this object.")
      return
    }
    setAtlas((current) => current && current.workspaceId === targetCanvas.workspaceId
      ? { ...current, durableCanvas: targetCanvas }
      : current)
    setPendingDrop({
      kind: "object",
      label: intent.label,
      point,
      phase: "authorizing",
      message: "Checking current access before placement…",
    })
    try {
      const batch = await hydrateAtlasObjectReferences([intent.subjectRef], { concurrency: 1 })
      const authorized = authorizeAtlasObjectDrop(intent, batch.byReference[intent.subjectRef])
      const currentTarget = currentAtlasTargetRef.current
      if (
        !currentTarget.ready
        || currentTarget.workspaceId !== atlas.workspaceId
        || currentTarget.canvasId !== targetCanvas.canvasId
      ) throw new Error("The original Atlas canvas is no longer active. Drop the object again on its intended canvas.")
      const recovery = {
        subjectRef: authorized.subjectRef,
        operationId: crypto.randomUUID(),
        point,
        label: authorized.label,
        workspaceId: atlas.workspaceId,
        canvasId: targetCanvas.canvasId,
      }
      atlasObjectDropRecoveryRef.current = recovery
      setAtlasObjectDropRecovery(recovery)
      setPendingDrop({
        kind: "object",
        label: authorized.label,
        point,
        phase: "placing",
        message: "Placing the authorized object at this exact point…",
        operationId: recovery.operationId,
      })
      if (!placeReference(recovery.subjectRef, recovery.operationId, recovery.point)) {
        throw new Error("This Atlas is not ready to place the authorized object yet. Retry placement.")
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "This Galaxy object could not be authorized for placement."
      setPendingDrop((current) => current ? { ...current, phase: "error", message } : current)
      setReferencePlacementAnnouncement(message)
    }
  }, [atlas, atlasRuntimeReady, placeReference, placementRemovalRequest, referencePlacementRequest, rejectAtlasDropImport])

  const retryAtlasObjectDropPlacement = useCallback(() => {
    const recovery = atlasObjectDropRecoveryRef.current
    if (!recovery || referencePlacementRequest || !atlasRuntimeReady || !atlas) return
    if (recovery.workspaceId !== atlas.workspaceId || recovery.canvasId !== atlas.durableCanvas?.canvasId) {
      setPendingDrop((current) => current ? {
        ...current,
        phase: "error",
        message: "Return to the original Atlas canvas to retry this placement.",
      } : current)
      return
    }
    setPendingDrop({
      kind: "object",
      label: recovery.label,
      point: recovery.point,
      phase: "placing",
      message: "Reconciling the same placement operation…",
      operationId: recovery.operationId,
    })
    if (!placeReference(recovery.subjectRef, recovery.operationId, recovery.point)) {
      setPendingDrop((current) => current ? {
        ...current,
        phase: "error",
        message: "This Atlas is not ready to retry placement yet.",
      } : current)
    }
  }, [atlas, atlasRuntimeReady, placeReference, referencePlacementRequest])

  const importAtlasDrop = useCallback(async (
    plan: AtlasDropImportPlan,
    point: ReferencePlacementPoint,
    targetCanvas: CanvasEnvelope,
  ) => {
    if (!atlasDropImportRegistered()) {
      rejectAtlasDropImport("Document drop import is unavailable because its registered source is disabled.")
      return
    }
    if (atlasDropImportOwner.busy() || !atlasRuntimeReady || !atlas || referencePlacementRequest || placementRemovalRequest
      || atlasDropImportPhase !== "idle" || atlasDropImportRecoveryRef.current || atlasObjectDropRecoveryRef.current) {
      rejectAtlasDropImport(atlasDropImportRecoveryRef.current || atlasObjectDropRecoveryRef.current
        ? "Retry or finish placement of the already imported document before dropping another file."
        : "Wait for the live Atlas canvas to finish its current placement before importing.")
      return
    }
    if (
      !targetCanvas
      || targetCanvas.workspaceId !== atlas.workspaceId
      || (atlas.durableCanvas !== null && atlas.durableCanvas.canvasId !== targetCanvas.canvasId)
    ) {
      rejectAtlasDropImport("A durable authorized Atlas canvas is required before uploading a document.")
      return
    }
    setAtlas((current) => current && current.workspaceId === targetCanvas.workspaceId
      ? { ...current, durableCanvas: targetCanvas }
      : current)
    setAtlasDropImportError("")
    setAtlasDropIngestionNotice("")
    setAtlasDropImportLabel(plan.title)
    setPendingDrop({
      kind: "file",
      label: plan.title,
      point,
      phase: "importing",
      message: "Preserving the exact original…",
    })
    setReferencePlacementAnnouncement("Running the registered document ingestion plan: preserve exact bytes first, then run bounded document analysis.")
    setAtlasDropImportPhase("importing")
    const abortController = new AbortController()
    if (!atlasDropImportOwner.claim(abortController)) {
      rejectAtlasDropImport("Wait for the current dropped document analysis to finish before importing another file.")
      return
    }
    const attempt: { confirmation: ConfirmedDocumentImport | null } = { confirmation: null }
    let placementStarted = false
    const analysisContext = documentAnalysisContextKey(tenantId, principalId, atlas.workspaceId)
    const analysisScopePrefix = `atlas:${analysisContext}`
    let publishAdmission: () => void = () => {}
    const admissionPublished = new Promise<void>((resolve) => {
      let published = false
      publishAdmission = () => {
        if (published) return
        published = true
        resolve()
      }
    })
    const runImport = async () => {
      try {
      const result = await executeAtlasDocumentIngestionPlan(
        plan.file,
        {
          title: plan.title,
          filename: plan.filename,
          sourceKind: "upload",
          sourceUri: null,
          arxivId: null,
        },
        {
          signal: abortController.signal,
          scopePrefix: analysisScopePrefix,
          onPersisted: (confirmation) => {
            if (abortController.signal.aborted) return
            attempt.confirmation = confirmation
            setAtlasDropImportPhase("transforming")
            const recovery = {
              document: confirmation.document,
              operationId: confirmation.placementOperationId,
              point,
              workspaceId: atlas.workspaceId,
              canvasId: targetCanvas.canvasId,
            }
            atlasDropImportRecoveryRef.current = recovery
            setAtlasDropImportRecovery(recovery)
            const currentTarget = currentAtlasTargetRef.current
            if (
              currentTarget.ready
              && currentTarget.workspaceId === recovery.workspaceId
              && currentTarget.canvasId === recovery.canvasId
            ) {
              setAtlasDropImportPhase("placing")
              setPendingDrop({
                kind: "file",
                label: plan.title,
                point,
                phase: "placing",
                message: "Exact bytes are durable. Placing now while analysis continues…",
                operationId: recovery.operationId,
              })
              setReferencePlacementAnnouncement("The exact dropped file is durable. Placing it now while bounded document analysis continues.")
              placementStarted = placeReference(recovery.document.ref, recovery.operationId, recovery.point)
            }
            if (!placementStarted) {
              setPendingDrop({
                kind: "file",
                label: plan.title,
                point,
                phase: "error",
                message: "The original is durable, but placement could not start. Retry placement without uploading again.",
                operationId: recovery.operationId,
              })
            }
            publishAdmission()
          },
        },
      )
      if (abortController.signal.aborted) return
      setAtlasDropIngestionNotice(ingestionOutcomeMessage(result))
      replaceDocumentAnalysisState(analysisStateForResult(
        result,
        plan.title,
        analysisScopePrefix,
        analysisContext,
      ))
      if (!placementStarted) {
        setAtlasDropImportPhase("idle")
        setAtlasDropImportError("The document is durable, but the Atlas is not ready to place it yet. Retry placement without re-uploading.")
      }
      } catch (error) {
        if (abortController.signal.aborted) return
        if (!placementStarted) setAtlasDropImportPhase("idle")
        if (attempt.confirmation) {
          const message = "The exact original is durable, but the ingestion plan could not confirm its derived representation."
          setAtlasDropIngestionNotice(message)
          replaceDocumentAnalysisState(analysisStateForConfirmation(
            attempt.confirmation,
            plan.title,
            message,
            analysisScopePrefix,
            analysisContext,
          ))
          if (!placementStarted) {
            setAtlasDropImportError("The document is durable. Retry placement only; do not upload the file again.")
            setPendingDrop({
              kind: "file",
              label: plan.title,
              point,
              phase: "error",
              message: "The original is durable. Retry placement without uploading again.",
              operationId: attempt.confirmation.placementOperationId,
            })
          }
        } else {
          const message = safeAtlasDropImportError(error)
          setAtlasDropImportError(message)
          setPendingDrop({ kind: "file", label: plan.title, point, phase: "error", message })
        }
      } finally {
        publishAdmission()
        atlasDropImportOwner.release(abortController)
      }
    }
    void runImport()
    await admissionPublished
  }, [
    atlas,
    atlasDropImportPhase,
    atlasDropImportOwner,
    atlasRuntimeReady,
    placeReference,
    placementRemovalRequest,
    principalId,
    referencePlacementRequest,
    rejectAtlasDropImport,
    replaceDocumentAnalysisState,
    tenantId,
  ])

  const retryAtlasDropPlacement = useCallback(() => {
    const recovery = atlasDropImportRecovery
    if (!recovery || atlasDropImportPhase !== "idle" || referencePlacementRequest) return
    if (!atlas || recovery.workspaceId !== atlas.workspaceId) {
      setAtlasDropImportError("This imported document belongs to a different workspace and cannot be placed here.")
      return
    }
    if (recovery.canvasId !== atlas.durableCanvas?.canvasId) {
      requestAtlasReload("Finish the current Atlas placement before opening the drop-import recovery canvas.", () => {
        prepareCanvasNavigation()
        const next = new URL(window.location.href)
        next.searchParams.set("canvas", recovery.canvasId)
        next.searchParams.delete("placement")
        window.history.replaceState(null, "", `${next.pathname}${next.search}${next.hash}`)
        setAtlasDropImportError("Loading the exact Atlas canvas that owns this pending placement…")
      })
      return
    }
    if (!atlasRuntimeReady) {
      setAtlasDropImportError("Wait for the live Atlas canvas to finish loading before retrying placement.")
      return
    }
    setAtlasDropImportError("")
    setAtlasDropImportPhase("placing")
    setPendingDrop({
      kind: "file",
      label: atlasDropImportLabel || recovery.document.title || "Dropped document",
      point: recovery.point,
      phase: "placing",
      message: "Reconciling the same placement operation…",
      operationId: recovery.operationId,
    })
    if (!placeReference(recovery.document.ref, recovery.operationId, recovery.point)) {
      setAtlasDropImportPhase("idle")
      setAtlasDropImportError("The document is durable, but the Atlas is not ready to place it yet. Retry placement without re-uploading.")
      setPendingDrop((current) => current ? {
        ...current,
        phase: "error",
        message: "The document is durable, but this Atlas is not ready to retry placement yet.",
      } : current)
    }
  }, [atlas, atlasDropImportLabel, atlasDropImportPhase, atlasDropImportRecovery, atlasRuntimeReady, placeReference, prepareCanvasNavigation, referencePlacementRequest, requestAtlasReload])

  const resumeDocumentAnalysis = useCallback(async () => {
    const recovery = documentAnalysisState
    if (!recovery?.resumable || documentAnalysisBusyRef.current) return
    const target = currentAtlasTargetRef.current
    const currentContext = target.ready
      ? documentAnalysisContextKey(tenantId, principalId, target.workspaceId)
      : null
    if (!currentContext || currentContext !== recovery.contextKey) {
      setDocumentAnalysisState({
        ...recovery,
        message: "This analysis operation belongs to another Atlas context. Return to its workspace to resume it.",
      })
      return
    }
    const abortController = new AbortController()
    documentAnalysisAbortRef.current?.abort()
    documentAnalysisAbortRef.current = abortController
    const generation = documentAnalysisGenerationRef.current + 1
    documentAnalysisGenerationRef.current = generation
    documentAnalysisBusyRef.current = true
    setDocumentAnalysisBusy(true)
    setDocumentAnalysisState({ ...recovery, message: "Resuming the same bounded document-analysis operation…" })
    try {
      const client = createAtlasDocumentTransformClient()
      const result = await client.transform(recovery.document.revision_id, {
        scope: recovery.scope,
        signal: abortController.signal,
      })
      const latestTarget = currentAtlasTargetRef.current
      const latestContext = latestTarget.ready
        ? documentAnalysisContextKey(tenantId, principalId, latestTarget.workspaceId)
        : null
      if (
        abortController.signal.aborted
        || documentAnalysisGenerationRef.current !== generation
        || latestContext !== recovery.contextKey
      ) return
      const running = "status" in result
      setDocumentAnalysisState({
        ...recovery,
        message: resumedTransformMessage(result),
        resumable: running,
        dismissible: !running,
      })
    } catch (error) {
      if (abortController.signal.aborted || documentAnalysisGenerationRef.current !== generation) return
      const message = error instanceof DocumentTransformClientError
        ? error.message
        : "Document analysis could not be reconciled. The exact original remains durable."
      setDocumentAnalysisState({ ...recovery, message, resumable: true, dismissible: false })
    } finally {
      if (documentAnalysisGenerationRef.current === generation) {
        documentAnalysisBusyRef.current = false
        setDocumentAnalysisBusy(false)
        if (documentAnalysisAbortRef.current === abortController) documentAnalysisAbortRef.current = null
      }
    }
  }, [documentAnalysisState, principalId, tenantId])

  const placeInkReference = useCallback((
    imported: DurableDocumentImport,
    operationId: string,
    descriptorInput: InkPlacementDescriptor,
  ) => {
    if (referencePlacementRequest) return false
    if (preview || !mounted || !atlas || !runtimeProjection || loading || loadError) {
      setInkDrawingError("Wait for the live Atlas canvas to finish loading.")
      return false
    }
    let ink
    try {
      ink = normalizeInkPlacementDescriptor(descriptorInput)
    } catch {
      setInkDrawingError("The exact ink representation could not be verified.")
      return false
    }
    setInkDrawingError("")
    setReferencePlacementAnnouncement("")
    setView("canvas")
    const retry = referencePlacementRetry
    const request = retry?.subjectRef === imported.ref
      && retry.operationId === operationId
      && retry.ink
      ? { ...retry, attempt: retry.attempt + 1, ink }
      : { operationId, subjectRef: imported.ref, attempt: 1, ink }
    setReferencePlacementRetry(null)
    setReferencePlacementRequest(request)
    return true
  }, [atlas, loadError, loading, mounted, preview, referencePlacementRequest, referencePlacementRetry, runtimeProjection])

  const placeCreatedExperiment = useCallback((experiment: Experiment, operationId: string) => {
    if (!atlas) throw new Error("The Atlas workspace is unavailable.")
    const recovery = writePendingExperimentPlacement(window.localStorage, experimentRecoveryScope, {
      experimentId: experiment.id,
      title: experiment.title,
      subjectRef: createGalaxyObjectReference("eln.experiment", experiment.id),
      operationId,
      workspaceId: atlas.workspaceId,
      canvasId: atlas.durableCanvas?.canvasId || null,
    })
    setExperimentPlacementRecovery(recovery)
    setExperimentPlacementError("")
    if (!placeReference(recovery.subjectRef, recovery.operationId)) {
      setExperimentPlacementError("The research record is durable, but this Atlas is not ready to place it yet.")
    }
  }, [atlas, experimentRecoveryScope, placeReference])

  const bindReferencePlacementTarget = useCallback((operationId: string, canvasId: string) => {
    if (referenceHandoffOperationRef.current === operationId) {
      const handoff = referenceHandoffPlacementBindingRef.current
      const recovery = referenceHandoffRecoveryRecordRef.current
      if (
        !atlas
        || !handoff
        || handoff.operationId !== operationId
        || !handoff.kind
      ) {
        throw new Error("The exact object handoff is no longer authorized for placement.")
      }
      if (recovery) {
        if (recovery.workspaceId !== atlas.workspaceId) {
          throw new Error("The exact object handoff belongs to a different workspace.")
        }
        if (recovery.canvasId !== canvasId) {
          throw new Error("The exact object handoff belongs to a different Atlas canvas.")
        }
        if (
          recovery.subjectRef !== handoff.subjectRef
          || recovery.kind !== handoff.kind
          || recovery.objectId !== handoff.objectId
          || recovery.sourceRevisionId !== handoff.sourceRevisionId
          || recovery.revisionSha256 !== handoff.revisionSha256
        ) {
          throw new Error("The exact object handoff recovery identity changed.")
        }
      }
      const checkpoint = writeAtlasReferenceHandoffPlacementRecovery(
        window.localStorage,
        referenceHandoffRecoveryScope,
        {
          operationId,
          workspaceId: atlas.workspaceId,
          canvasId,
          subjectRef: handoff.subjectRef,
          kind: handoff.kind,
          objectId: handoff.objectId,
          sourceRevisionId: handoff.sourceRevisionId,
          revisionSha256: handoff.revisionSha256,
        },
      )
      referenceHandoffRecoveryRecordRef.current = checkpoint
      setReferenceHandoffRecovery(checkpoint)
    }
    if (webCaptureRecovery?.operationId === operationId) {
      if (!atlas || atlas.workspaceId !== webCaptureRecovery.workspaceId) {
        throw new Error("The exact web capture belongs to a different workspace.")
      }
      if (webCaptureRecovery.canvasId !== canvasId) {
        throw new Error("The exact web capture belongs to a different Atlas canvas.")
      }
      if (webCaptureRecovery.subjectRef !== webCaptureRecovery.durableDocument.ref) {
        throw new Error("The exact web capture document identity changed.")
      }
    }
    if (paperImportRecovery?.operationId === operationId) {
      if (!atlas || atlas.workspaceId !== paperImportRecovery.workspaceId) {
        throw new Error("The exact paper import belongs to a different workspace.")
      }
      if (paperImportRecovery.canvasId !== canvasId) {
        throw new Error("The exact paper import belongs to a different Atlas canvas.")
      }
      if (paperImportRecovery.subjectRef !== paperImportRecovery.durableDocument.ref) {
        throw new Error("The exact paper import document identity changed.")
      }
    }
    if (formalPackagePlacement?.operationId === operationId) {
      if (!atlas || atlas.workspaceId !== formalPackagePlacement.workspaceId) {
        throw new Error("The formal package import belongs to a different workspace.")
      }
      if (formalPackagePlacement.canvasId !== canvasId) {
        throw new Error("The formal package import belongs to a different Atlas canvas.")
      }
    }
    if (experimentPlacementRecovery?.operationId === operationId) {
      if (!atlas || atlas.workspaceId !== experimentPlacementRecovery.workspaceId) {
        throw new Error("The recovery belongs to a different workspace.")
      }
      if (experimentPlacementRecovery.canvasId && experimentPlacementRecovery.canvasId !== canvasId) {
        throw new Error("The recovery belongs to a different Atlas canvas.")
      }
      const bound = writePendingExperimentPlacement(window.localStorage, experimentRecoveryScope, {
        ...experimentPlacementRecovery,
        canvasId,
      })
      setExperimentPlacementRecovery(bound)
    }
    if (atlasDropImportRecovery?.operationId === operationId) {
      if (!atlas || atlas.workspaceId !== atlasDropImportRecovery.workspaceId) {
        throw new Error("The dropped import belongs to a different workspace.")
      }
      if (atlasDropImportRecovery.canvasId !== canvasId) {
        throw new Error("The dropped import belongs to a different Atlas canvas.")
      }
      setAtlasDropImportRecovery({ ...atlasDropImportRecovery, canvasId })
    }
  }, [atlas, atlasDropImportRecovery, experimentPlacementRecovery, experimentRecoveryScope, formalPackagePlacement, paperImportRecovery, referenceHandoffRecoveryScope, webCaptureRecovery])

  const retryCreatedExperimentPlacement = useCallback(() => {
    if (!experimentPlacementRecovery || referencePlacementRequest) return
    setExperimentPlacementError("")
    if (
      experimentPlacementRecovery.canvasId
      && atlas?.durableCanvas?.canvasId !== experimentPlacementRecovery.canvasId
    ) {
      requestAtlasReload("Finish the current Atlas placement before opening the experiment recovery canvas.", () => {
        prepareCanvasNavigation()
        const next = new URL(window.location.href)
        next.searchParams.set("canvas", experimentPlacementRecovery.canvasId!)
        next.searchParams.delete("placement")
        window.history.replaceState(null, "", `${next.pathname}${next.search}${next.hash}`)
        setExperimentPlacementError("Loading the exact Atlas canvas that owns this pending placement…")
      })
      return
    }
    if (atlas?.workspaceId !== experimentPlacementRecovery.workspaceId) {
      setExperimentPlacementError("This pending placement belongs to another workspace and cannot be moved here.")
      return
    }
    if (!placeReference(
      experimentPlacementRecovery.subjectRef,
      experimentPlacementRecovery.operationId,
    )) {
      setExperimentPlacementError("The research record is durable, but this Atlas is not ready to place it yet.")
    }
  }, [atlas, experimentPlacementRecovery, placeReference, prepareCanvasNavigation, referencePlacementRequest, requestAtlasReload])

  const importDocumentAndPlace = useCallback(async (file: File, title: string) => {
    if (!atlasDropImportRegistered()) {
      setDocumentImportError("Document import is unavailable because its exact ingestion plan is disabled or changed.")
      setDocumentImportErrorField(null)
      setDocumentImportAmbiguous(false)
      return
    }
    if (documentImportBusyRef.current || documentImportPhase !== "idle" || referencePlacementRequest) return
    const target = currentAtlasTargetRef.current
    if (!target.ready || !target.canvasId) {
      setDocumentImportError("Wait for a durable authorized Atlas canvas before importing a document.")
      setDocumentImportErrorField(null)
      setDocumentImportAmbiguous(false)
      return
    }
    const targetCanvasId = target.canvasId
    const draft = documentImportDraft?.file === file && documentImportDraft.title === title
      ? documentImportDraft
      : { file, title }
    setDocumentImportDraft(draft)
    setDocumentImportError("")
    setDocumentIngestionNotice("")
    setDocumentImportErrorField(null)
    setDocumentImportPhase("importing")
    documentImportBusyRef.current = true
    const abortController = new AbortController()
    documentImportAbortRef.current = abortController
    const attempt: { confirmation: ConfirmedDocumentImport | null } = { confirmation: null }
    const analysisContext = documentAnalysisContextKey(tenantId, principalId, target.workspaceId)
    const analysisScopePrefix = `atlas:${analysisContext}`
    try {
      const result = await executeAtlasDocumentIngestionPlan(
        draft.file,
        {
          title: draft.title,
          filename: draft.file.name,
          sourceKind: "upload",
          sourceUri: null,
          arxivId: null,
        },
        {
          signal: abortController.signal,
          scopePrefix: analysisScopePrefix,
          onPersisted: (confirmation) => {
            if (abortController.signal.aborted) return
            attempt.confirmation = confirmation
            setImportedDocument(confirmation.document)
            setDocumentImportRecovery({
              document: confirmation.document,
              operationId: confirmation.placementOperationId,
              workspaceId: target.workspaceId,
              canvasId: targetCanvasId,
            })
            setDocumentImportAmbiguous(false)
            setDocumentImportPhase("transforming")
            setDocumentIngestionNotice("The exact original is durable. Running bounded document analysis now.")
            replaceDocumentAnalysisState(analysisStateForConfirmation(
              confirmation,
              draft.title,
              "The exact original is durable. Document analysis is running in the background.",
              analysisScopePrefix,
              analysisContext,
              { resumable: false, dismissible: false },
            ))
          },
        },
      )
      if (abortController.signal.aborted) return
      const confirmation = result.confirmation
      const imported = confirmation.document
      setImportedDocument(imported)
      setDocumentImportRecovery({
        document: imported,
        operationId: confirmation.placementOperationId,
        workspaceId: target.workspaceId,
        canvasId: targetCanvasId,
      })
      setDocumentIngestionNotice(ingestionOutcomeMessage(result))
      replaceDocumentAnalysisState(analysisStateForResult(
        result,
        draft.title,
        analysisScopePrefix,
        analysisContext,
      ))
      setDocumentImportAmbiguous(false)
      const currentTarget = currentAtlasTargetRef.current
      if (
        !currentTarget.ready
        || currentTarget.workspaceId !== target.workspaceId
        || currentTarget.canvasId !== targetCanvasId
      ) {
        setDocumentImportPhase("idle")
        setDocumentImportErrorField(null)
        setDocumentImportError("The document is durable, but the original Atlas canvas is no longer active. Retry placement only; do not upload the file again.")
        return
      }
      setDocumentImportPhase("placing")
      if (!placeReference(imported.ref, confirmation.placementOperationId)) {
        setDocumentImportPhase("idle")
        setDocumentImportErrorField(null)
        setDocumentImportError("The document is durable, but the Atlas is not ready to place it yet.")
      }
    } catch (error) {
      if (abortController.signal.aborted) return
      if (attempt.confirmation) {
        setImportedDocument(attempt.confirmation.document)
        setDocumentImportRecovery({
          document: attempt.confirmation.document,
          operationId: attempt.confirmation.placementOperationId,
          workspaceId: target.workspaceId,
          canvasId: targetCanvasId,
        })
        const message = "The exact original is durable, but the ingestion plan could not confirm its derived representation."
        setDocumentIngestionNotice(message)
        replaceDocumentAnalysisState(analysisStateForConfirmation(
          attempt.confirmation,
          draft.title,
          message,
          analysisScopePrefix,
          analysisContext,
        ))
        setDocumentImportError("The document is durable. Retry placement only; do not upload the file again.")
        setDocumentImportErrorField(null)
        setDocumentImportAmbiguous(false)
        setDocumentImportPhase("idle")
        return
      }
      const safeError = safeDocumentImportError(error)
      setDocumentImportError(safeError.message)
      setDocumentImportErrorField(safeError.field)
      setDocumentImportAmbiguous(safeError.ambiguous)
      setDocumentImportPhase("idle")
    } finally {
      documentImportBusyRef.current = false
      if (documentImportAbortRef.current === abortController) documentImportAbortRef.current = null
    }
  }, [documentImportDraft, documentImportPhase, placeReference, principalId, referencePlacementRequest, replaceDocumentAnalysisState, tenantId])

  const retryImportedDocumentPlacement = useCallback(() => {
    const recovery = documentImportRecovery
    if (!recovery || documentImportPhase !== "idle" || referencePlacementRequest) return
    if (!atlas || recovery.workspaceId !== atlas.workspaceId) {
      setDocumentImportError("This imported document belongs to a different workspace and cannot be placed here.")
      return
    }
    if (recovery.canvasId !== atlas.durableCanvas?.canvasId) {
      requestAtlasReload("Finish the current Atlas placement before opening the document recovery canvas.", () => {
        prepareCanvasNavigation()
        const next = new URL(window.location.href)
        next.searchParams.set("canvas", recovery.canvasId)
        next.searchParams.delete("placement")
        window.history.replaceState(null, "", `${next.pathname}${next.search}${next.hash}`)
        setDocumentImportError("Loading the exact Atlas canvas that owns this pending placement…")
      })
      return
    }
    if (!atlasRuntimeReady) {
      setDocumentImportError("Wait for the original Atlas canvas to finish loading before retrying placement.")
      return
    }
    setDocumentImportError("")
    setDocumentImportErrorField(null)
    setDocumentImportPhase("placing")
    if (!placeReference(recovery.document.ref, recovery.operationId)) {
      setDocumentImportPhase("idle")
      setDocumentImportErrorField(null)
      setDocumentImportError("The document is durable, but the Atlas is not ready to place it yet.")
    }
  }, [atlas, atlasRuntimeReady, documentImportPhase, documentImportRecovery, placeReference, prepareCanvasNavigation, referencePlacementRequest, requestAtlasReload])

  const placeImportedDatasourceDocument = useCallback((
    confirmation: ConfirmedDocumentImport,
    importTarget: Readonly<{ workspaceId: string; canvasId: string }>,
    ingestionNotice: string,
    ingestionResult: IngestionPlanExecutionResult | null,
  ) => {
    setImportedDatasourceDocument(confirmation.document)
    setDatasourceIngestionNotice(ingestionNotice)
    setDatasourcePlacementError("")
    const analysisContext = documentAnalysisContextKey(tenantId, principalId, importTarget.workspaceId)
    if (ingestionResult) {
      replaceDocumentAnalysisState(analysisStateForResult(
        ingestionResult,
        confirmation.document.title,
        `atlas:${analysisContext}`,
        analysisContext,
        DATASOURCE_FILE_INGESTION_PLAN_ID,
      ))
    }
    if (referencePlacementRequest) return false
    const currentTarget = currentAtlasTargetRef.current
    if (currentTarget.workspaceId !== importTarget.workspaceId || currentTarget.canvasId !== importTarget.canvasId) {
      requestAtlasReload("Finish the current Atlas placement before opening the datasource recovery canvas.", () => {
        prepareCanvasNavigation()
        const next = new URL(window.location.href)
        next.searchParams.set("canvas", importTarget.canvasId)
        next.searchParams.delete("placement")
        next.searchParams.delete("ref")
        window.history.replaceState(null, "", `${next.pathname}${next.search}${next.hash}`)
        setDatasourcePlacementError("Loading the Atlas canvas where this durable datasource import started…")
      })
      return false
    }
    if (!currentTarget.ready) {
      setDatasourcePlacementError("Wait for the original Atlas canvas to finish loading before retrying placement.")
      return false
    }
    if (!placeReference(confirmation.document.ref, confirmation.placementOperationId)) {
      setDatasourcePlacementError("The document is durable, but the Atlas is not ready to place it yet.")
      return false
    }
    return true
  }, [placeReference, prepareCanvasNavigation, principalId, referencePlacementRequest, replaceDocumentAnalysisState, requestAtlasReload, tenantId])

  const changeDocumentImportOpen = useCallback((nextOpen: boolean) => {
    if (!nextOpen && (documentImportPhase === "importing" || documentImportPhase === "placing")) return
    if (!nextOpen && documentImportAmbiguous) return
    setDocumentImportOpen(nextOpen)
    if (!nextOpen && documentImportPhase === "transforming" && importedDocument) return
    if (nextOpen) return
    setDocumentImportError("")
    setDocumentIngestionNotice("")
    setDocumentImportErrorField(null)
    setDocumentImportDraft(null)
    setImportedDocument(null)
    setDocumentImportRecovery(null)
    setDocumentImportAmbiguous(false)
  }, [documentImportAmbiguous, documentImportPhase, importedDocument])

  const abandonDocumentImport = useCallback(() => {
    if (documentImportPhase !== "idle") return
    setDocumentImportOpen(false)
    setDocumentImportError("")
    setDocumentIngestionNotice("")
    setDocumentImportErrorField(null)
    setDocumentImportDraft(null)
    setImportedDocument(null)
    setDocumentImportRecovery(null)
    setDocumentImportAmbiguous(false)
  }, [documentImportPhase])

  const editDocumentImport = useCallback(() => {
    if (documentImportPhase !== "idle" || importedDocument || documentImportAmbiguous) return
    setDocumentImportError("")
    setDocumentIngestionNotice("")
    setDocumentImportErrorField(null)
    setDocumentImportDraft(null)
  }, [documentImportAmbiguous, documentImportPhase, importedDocument])

  const resolveAndPlaceInk = useCallback(async (
    imported: DurableDocumentImport,
    operationId: string,
  ) => {
    setInkDrawingPhase("placing")
    try {
      const descriptor = await loadInkPlacementDescriptor(imported)
      if (!placeInkReference(imported, operationId, descriptor)) {
        setInkDrawingPhase("idle")
        setInkDrawingError("The ink document is durable, but the Atlas is not ready to place it yet.")
      }
    } catch {
      setInkDrawingPhase("idle")
      setInkDrawingError("The ink document is durable, but its exact representation could not be loaded. Retry placement.")
    }
  }, [placeInkReference])

  const saveInkAndPlace = useCallback(async (file: File, title: string) => {
    if (inkDrawingPhase !== "idle" || referencePlacementRequest) return
    setInkDrawingError("")
    setInkDrawingPhase("importing")
    let imported: DurableDocumentImport | null = null
    try {
      const confirmation = await galaxyBrainAPI.importDocument(file, {
        title,
        filename: file.name,
        sourceKind: "upload",
        sourceUri: null,
        arxivId: null,
      })
      imported = confirmation.document
      setImportedInkDocument(imported)
      setImportedInkPlacementId(confirmation.placementOperationId)
      setInkDrawingAmbiguous(false)
      await resolveAndPlaceInk(imported, confirmation.placementOperationId)
    } catch (error) {
      if (imported) {
        setInkDrawingPhase("idle")
        setInkDrawingError("The ink document is durable, but placement could not start. Retry placement.")
        return
      }
      const safeError = safeInkImportError(error)
      setInkDrawingError(safeError.message)
      setInkDrawingAmbiguous(safeError.ambiguous)
      setInkDrawingPhase("idle")
    }
  }, [inkDrawingPhase, referencePlacementRequest, resolveAndPlaceInk])

  const retryImportedInkPlacement = useCallback(() => {
    if (!importedInkDocument || !importedInkPlacementId || inkDrawingPhase !== "idle") return
    setInkDrawingError("")
    void resolveAndPlaceInk(importedInkDocument, importedInkPlacementId)
  }, [importedInkDocument, importedInkPlacementId, inkDrawingPhase, resolveAndPlaceInk])

  const changeInkDrawingOpen = useCallback((nextOpen: boolean) => {
    if (!nextOpen && (inkDrawingPhase !== "idle" || inkDrawingAmbiguous)) return
    setInkDrawingOpen(nextOpen)
    if (nextOpen) return
    setInkDrawingError("")
    setImportedInkDocument(null)
    setImportedInkPlacementId(null)
    setInkDrawingAmbiguous(false)
  }, [inkDrawingAmbiguous, inkDrawingPhase])

  const editInkDrawing = useCallback(() => {
    if (inkDrawingPhase !== "idle" || importedInkDocument || inkDrawingAmbiguous) return
    setInkDrawingError("")
  }, [importedInkDocument, inkDrawingAmbiguous, inkDrawingPhase])

  const saveCodeAndPlace = useCallback(async (file: File, title: string) => {
    if (codeSavePhase !== "idle" || referencePlacementRequest) return
    setCodeSaveError("")
    setCodeSavePhase("importing")
    try {
      const confirmation = await galaxyBrainAPI.importDocument(file, {
        title,
        filename: file.name,
        sourceKind: "upload",
        sourceUri: null,
        arxivId: null,
      })
      setImportedCodeDocument(confirmation.document)
      setImportedCodePlacementId(confirmation.placementOperationId)
      setCodeSaveAmbiguous(false)
      setCodeSavePhase("placing")
      if (!placeReference(confirmation.document.ref, confirmation.placementOperationId)) {
        setCodeSavePhase("idle")
        setCodeSaveError("The source revision is durable, but this Atlas is not ready to place it yet.")
      }
    } catch (error) {
      const safeError = safeCodeImportError(error)
      setCodeSaveError(safeError.message)
      setCodeSaveAmbiguous(safeError.ambiguous)
      setCodeSavePhase("idle")
    }
  }, [codeSavePhase, placeReference, referencePlacementRequest])

  const retryImportedCodePlacement = useCallback(() => {
    if (!importedCodeDocument || !importedCodePlacementId || codeSavePhase !== "idle") return
    setCodeSaveError("")
    setCodeSavePhase("placing")
    if (!placeReference(importedCodeDocument.ref, importedCodePlacementId)) {
      setCodeSavePhase("idle")
      setCodeSaveError("The source revision is durable, but this Atlas is not ready to place it yet.")
    }
  }, [codeSavePhase, importedCodeDocument, importedCodePlacementId, placeReference])

  const changeCodeEditorOpen = useCallback((nextOpen: boolean) => {
    if (!nextOpen && (codeSavePhase !== "idle" || codeSaveAmbiguous)) return
    setCodeEditorOpen(nextOpen)
    if (nextOpen) return
    setCodeSaveError("")
    setImportedCodeDocument(null)
    setImportedCodePlacementId(null)
    setCodeSaveAmbiguous(false)
  }, [codeSaveAmbiguous, codeSavePhase])

  const abandonCodeSave = useCallback(() => {
    if (codeSavePhase !== "idle" || !codeDraftScope) return
    try {
      removeCodeEditorDraftWithWorkspaceFallback(window.sessionStorage, codeDraftScope, {
        allowWorkspaceFallback: codeDraftAllowsWorkspaceFallback,
      })
    } catch {}
    setCodeEditorOpen(false)
    setCodeSaveError("")
    setImportedCodeDocument(null)
    setImportedCodePlacementId(null)
    setCodeSaveAmbiguous(false)
  }, [codeDraftAllowsWorkspaceFallback, codeDraftScope, codeSavePhase])

  const editCodeDraft = useCallback(() => {
    if (codeSavePhase !== "idle" || importedCodeDocument || codeSaveAmbiguous) return
    setCodeSaveError("")
  }, [codeSaveAmbiguous, codeSavePhase, importedCodeDocument])

  const importCodeGraphSnapshotAndPlace = useCallback(async ({
    file,
    review,
  }: CodeGraphSnapshotImportRequest) => {
    if (codeGraphSnapshotPhase !== "idle" || referencePlacementRequest || codeGraphSnapshotRecovery) return
    const liveTarget = currentAtlasTargetRef.current
    const target = codeGraphSnapshotTarget ?? (
      liveTarget.ready && liveTarget.canvasId
        ? { workspaceId: liveTarget.workspaceId, canvasId: liveTarget.canvasId }
        : null
    )
    if (!target) {
      setCodeGraphSnapshotError("Wait for the live Atlas canvas to finish loading before importing this snapshot.")
      return
    }
    if (
      !liveTarget.ready
      || liveTarget.workspaceId !== target.workspaceId
      || liveTarget.canvasId !== target.canvasId
    ) {
      setCodeGraphSnapshotError("Return to the Atlas canvas where this import started before retrying its exact bytes.")
      return
    }
    setCodeGraphSnapshotTarget(target)
    setCodeGraphSnapshotError("")
    setCodeGraphSnapshotAmbiguous(false)
    setCodeGraphSnapshotPhase("importing")
    codeGraphSnapshotAbortRef.current?.abort()
    const controller = new AbortController()
    codeGraphSnapshotAbortRef.current = controller
    const generation = codeGraphSnapshotGenerationRef.current + 1
    codeGraphSnapshotGenerationRef.current = generation
    try {
      const confirmation = await galaxyBrainAPI.importDocument(file, {
        title: createCodeGraphSnapshotImportTitle(review),
        filename: file.name,
        sourceKind: "upload",
        sourceUri: null,
        arxivId: null,
      }, controller.signal)
      if (controller.signal.aborted || codeGraphSnapshotGenerationRef.current !== generation) return
      const exactConfirmation = assertCodeGraphSnapshotImportConfirmation(confirmation, review, file.name)
      const recovery: CodeGraphSnapshotRecovery = {
        workspaceId: target.workspaceId,
        canvasId: target.canvasId,
        document: exactConfirmation.document,
        operationId: exactConfirmation.placementOperationId,
      }
      codeGraphSnapshotAbortRef.current = null
      setCodeGraphSnapshotRecovery(recovery)
      const current = currentAtlasTargetRef.current
      if (
        !current.ready
        || current.workspaceId !== target.workspaceId
        || current.canvasId !== target.canvasId
      ) {
        setCodeGraphSnapshotPhase("idle")
        setCodeGraphSnapshotError("The exact JSON document is durable. Return to its original Atlas canvas and retry placement only.")
        return
      }
      setCodeGraphSnapshotPhase("placing")
      if (!placeReference(recovery.document.ref, recovery.operationId)) {
        setCodeGraphSnapshotPhase("idle")
        setCodeGraphSnapshotError("The exact JSON document is durable, but this Atlas is not ready to place it yet.")
      }
    } catch (error) {
      if (
        controller.signal.aborted
        || codeGraphSnapshotGenerationRef.current !== generation
        || (error instanceof DOMException && error.name === "AbortError")
      ) return
      codeGraphSnapshotAbortRef.current = null
      const safe = safeCodeGraphSnapshotImportError(error)
      setCodeGraphSnapshotPhase("idle")
      setCodeGraphSnapshotError(safe.message)
      setCodeGraphSnapshotAmbiguous(safe.ambiguous)
    }
  }, [
    codeGraphSnapshotPhase,
    codeGraphSnapshotRecovery,
    codeGraphSnapshotTarget,
    placeReference,
    referencePlacementRequest,
  ])

  const retryCodeGraphSnapshotPlacement = useCallback(() => {
    const recovery = codeGraphSnapshotRecovery
    if (!recovery || codeGraphSnapshotPhase !== "idle" || referencePlacementRequest) return
    if (!atlas || recovery.workspaceId !== atlas.workspaceId) {
      setCodeGraphSnapshotError("This durable JSON document belongs to a different workspace and cannot be placed here.")
      return
    }
    if (recovery.canvasId !== atlas.durableCanvas?.canvasId) {
      setCodeGraphSnapshotError("Return to the original Atlas canvas before retrying placement. The durable document recovery remains available here.")
      return
    }
    if (!atlasRuntimeReady) {
      setCodeGraphSnapshotError("Wait for the original Atlas canvas to finish loading before retrying placement.")
      return
    }
    setCodeGraphSnapshotError("")
    setCodeGraphSnapshotPhase("placing")
    if (!placeReference(recovery.document.ref, recovery.operationId)) {
      setCodeGraphSnapshotPhase("idle")
      setCodeGraphSnapshotError("The exact JSON document is durable, but this Atlas is not ready to place it yet.")
    }
  }, [
    atlas,
    atlasRuntimeReady,
    codeGraphSnapshotPhase,
    codeGraphSnapshotRecovery,
    placeReference,
    referencePlacementRequest,
  ])

  const keepCodeGraphSnapshotWithoutPlacing = useCallback(() => {
    if (codeGraphSnapshotPhase !== "idle" || !codeGraphSnapshotRecovery) return
    const discardedPlacementMatchesRetry = referencePlacementRetry?.subjectRef === codeGraphSnapshotRecovery.document.ref
      && referencePlacementRetry.operationId === codeGraphSnapshotRecovery.operationId
    if (discardedPlacementMatchesRetry) {
      setReferencePlacementRetry(null)
      setReferencePlacementAnnouncement("")
    }
    setCodeGraphSnapshotOpen(false)
    setCodeGraphSnapshotError("")
    setCodeGraphSnapshotRecovery(null)
    setCodeGraphSnapshotTarget(null)
    setCanvasActionStatus("The exact JSON document remains durable. Its pending Atlas placement was discarded.")
  }, [codeGraphSnapshotPhase, codeGraphSnapshotRecovery, referencePlacementRetry])

  const changeCodeGraphSnapshotOpen = useCallback((nextOpen: boolean) => {
    if (!nextOpen && (codeGraphSnapshotPhase !== "idle" || codeGraphSnapshotAmbiguous)) return
    setCodeGraphSnapshotOpen(nextOpen)
    if (nextOpen || codeGraphSnapshotRecovery) return
    setCodeGraphSnapshotError("")
    setCodeGraphSnapshotTarget(null)
  }, [codeGraphSnapshotAmbiguous, codeGraphSnapshotPhase, codeGraphSnapshotRecovery])

  const abandonCodeGraphSnapshotImport = useCallback(() => {
    if (codeGraphSnapshotPhase !== "idle" || codeGraphSnapshotRecovery) return
    codeGraphSnapshotAbortRef.current?.abort()
    codeGraphSnapshotAbortRef.current = null
    codeGraphSnapshotGenerationRef.current += 1
    setCodeGraphSnapshotOpen(false)
    setCodeGraphSnapshotError("")
    setCodeGraphSnapshotAmbiguous(false)
    setCodeGraphSnapshotTarget(null)
  }, [codeGraphSnapshotPhase, codeGraphSnapshotRecovery])

  const editCodeGraphSnapshotImport = useCallback(() => {
    if (codeGraphSnapshotPhase !== "idle" || codeGraphSnapshotRecovery || codeGraphSnapshotAmbiguous) return
    setCodeGraphSnapshotError("")
  }, [codeGraphSnapshotAmbiguous, codeGraphSnapshotPhase, codeGraphSnapshotRecovery])

  const saveMarkdownNoteAndPlace = useCallback(async (file: File, title: string) => {
    if (markdownNotePhase !== "idle" || referencePlacementRequest || markdownNoteRecovery) return
    const currentTarget = currentAtlasTargetRef.current
    const frozenTarget = markdownNoteTarget ?? (
      currentTarget.ready && currentTarget.canvasId
        ? { workspaceId: currentTarget.workspaceId, canvasId: currentTarget.canvasId }
        : null
    )
    if (!frozenTarget) {
      setMarkdownNoteError("Wait for the live Atlas canvas to finish loading before saving this note.")
      return
    }
    if (
      currentTarget.workspaceId !== frozenTarget.workspaceId
      || currentTarget.canvasId !== frozenTarget.canvasId
      || !currentTarget.ready
    ) {
      setMarkdownNoteError("Return to the Atlas canvas where this note started before retrying its exact save.")
      return
    }
    setMarkdownNoteTarget(frozenTarget)
    setMarkdownNoteError("")
    setMarkdownNoteIngestionNotice("")
    setMarkdownNotePhase("importing")
    const abortController = new AbortController()
    markdownNoteAbortRef.current = abortController
    let persistedConfirmation: ConfirmedDocumentImport | null = null
    const analysisContext = documentAnalysisContextKey(
      tenantId,
      principalId,
      frozenTarget.workspaceId,
    )
    try {
      const result = await executeAtlasDocumentIngestionPlan(
        file,
        {
          title,
          filename: file.name,
          sourceKind: "upload",
          sourceUri: null,
          arxivId: null,
        },
        {
          signal: abortController.signal,
          scopePrefix: `atlas:${analysisContext}`,
          onPersisted: (confirmation) => {
            persistedConfirmation = confirmation
            setMarkdownNoteRecovery({
              document: confirmation.document,
              operationId: confirmation.placementOperationId,
              ...frozenTarget,
            })
            setMarkdownNoteAmbiguous(false)
            setMarkdownNotePhase("transforming")
          },
        },
      )
      const confirmation = result.confirmation
      setMarkdownNoteIngestionNotice(ingestionOutcomeMessage(result))
      setMarkdownNoteRecovery({
        document: confirmation.document,
        operationId: confirmation.placementOperationId,
        ...frozenTarget,
      })
      replaceDocumentAnalysisState(analysisStateForResult(
        result,
        confirmation.document.title,
        `atlas:${analysisContext}`,
        analysisContext,
      ))
      const placementTarget = currentAtlasTargetRef.current
      if (
        placementTarget.workspaceId !== frozenTarget.workspaceId
        || placementTarget.canvasId !== frozenTarget.canvasId
        || !placementTarget.ready
      ) {
        setMarkdownNotePhase("idle")
        setMarkdownNoteError("The exact note is durable, but the target Atlas changed. Return to its original canvas and retry placement only.")
        return
      }
      setMarkdownNotePhase("placing")
      if (!placeReference(confirmation.document.ref, confirmation.placementOperationId)) {
        setMarkdownNotePhase("idle")
        setMarkdownNoteError("The exact note is durable, but this Atlas is not ready to place it yet. Retry placement only.")
      }
    } catch (error) {
      if (persistedConfirmation) {
        const confirmation = persistedConfirmation as ConfirmedDocumentImport
        setMarkdownNoteRecovery({
          document: confirmation.document,
          operationId: confirmation.placementOperationId,
          ...frozenTarget,
        })
        replaceDocumentAnalysisState(analysisStateForConfirmation(
          confirmation,
          confirmation.document.title,
          "The exact note is durable. Document analysis was interrupted and can be resumed; placement remains retry-only.",
          `atlas:${analysisContext}`,
          analysisContext,
        ))
        setMarkdownNoteAmbiguous(false)
        setMarkdownNoteIngestionNotice("The exact original is durable, but the ingestion plan could not confirm its derived representation.")
        setMarkdownNoteError("The exact note is durable, but analysis did not finish. Retry placement only; do not save another revision.")
      } else {
        const safeError = safeMarkdownNoteImportError(error)
        setMarkdownNoteError(safeError.message)
        setMarkdownNoteAmbiguous(safeError.ambiguous)
        if (!safeError.ambiguous) setMarkdownNoteTarget(null)
      }
      setMarkdownNotePhase("idle")
    } finally {
      if (markdownNoteAbortRef.current === abortController) markdownNoteAbortRef.current = null
    }
  }, [
    markdownNotePhase,
    markdownNoteRecovery,
    markdownNoteTarget,
    placeReference,
    principalId,
    referencePlacementRequest,
    replaceDocumentAnalysisState,
    tenantId,
  ])

  const retryMarkdownNotePlacement = useCallback(() => {
    const recovery = markdownNoteRecovery
    if (!recovery || markdownNotePhase !== "idle" || referencePlacementRequest) return
    if (!atlas || recovery.workspaceId !== atlas.workspaceId) {
      setMarkdownNoteError("This durable note belongs to a different workspace and cannot be placed here.")
      return
    }
    if (recovery.canvasId !== atlas.durableCanvas?.canvasId) {
      requestAtlasReload("Finish the current Atlas placement before opening the note recovery canvas.", () => {
        prepareCanvasNavigation()
        window.location.assign(atlasCanvasHref(recovery.canvasId))
      })
      return
    }
    if (!atlasRuntimeReady) {
      setMarkdownNoteError("Wait for the original Atlas canvas to finish loading before retrying placement.")
      return
    }
    setMarkdownNoteError("")
    setMarkdownNotePhase("placing")
    if (!placeReference(recovery.document.ref, recovery.operationId)) {
      setMarkdownNotePhase("idle")
      setMarkdownNoteError("The exact note is durable, but the Atlas is not ready to place it yet.")
    }
  }, [
    atlas,
    atlasRuntimeReady,
    markdownNotePhase,
    markdownNoteRecovery,
    placeReference,
    prepareCanvasNavigation,
    referencePlacementRequest,
    requestAtlasReload,
  ])

  const changeMarkdownNoteOpen = useCallback((nextOpen: boolean) => {
    if (!nextOpen && (markdownNotePhase !== "idle" || markdownNoteAmbiguous)) return
    setCodeEditorOpen(nextOpen)
    if (nextOpen) return
    setMarkdownNoteError("")
    if (!markdownNoteRecovery) {
      setMarkdownNoteIngestionNotice("")
      setMarkdownNoteTarget(null)
    }
  }, [markdownNoteAmbiguous, markdownNotePhase, markdownNoteRecovery])

  const abandonMarkdownNote = useCallback(() => {
    if (markdownNotePhase !== "idle" || !codeDraftScope) return
    try {
      removeCodeEditorDraftWithWorkspaceFallback(window.sessionStorage, codeDraftScope, {
        allowWorkspaceFallback: codeDraftAllowsWorkspaceFallback,
        channel: MARKDOWN_NOTE_DRAFT_CHANNEL,
      })
    } catch {}
    setCodeEditorOpen(false)
    setMarkdownNoteError("")
    setMarkdownNoteIngestionNotice("")
    setMarkdownNoteAmbiguous(false)
    setMarkdownNoteTarget(null)
    setMarkdownNoteRecovery(null)
  }, [codeDraftAllowsWorkspaceFallback, codeDraftScope, markdownNotePhase])

  const editMarkdownNote = useCallback(() => {
    if (markdownNotePhase !== "idle" || markdownNoteRecovery || markdownNoteAmbiguous) return
    setMarkdownNoteError("")
  }, [markdownNoteAmbiguous, markdownNotePhase, markdownNoteRecovery])

  const saveVoiceAndPlace = useCallback(async (request: VoiceSaveRequest) => {
    if (voiceSavePhase !== "idle" || referencePlacementRequest) return
    setVoiceSaveError("")
    const { transcriptFile, title } = request
    if (!request.recording) {
      setVoiceSavePhase("importing")
      try {
        const confirmation = await galaxyBrainAPI.importDocument(transcriptFile, {
          title,
          filename: transcriptFile.name,
          sourceKind: "upload",
          sourceUri: null,
          arxivId: null,
        })
        setImportedVoiceDocument(confirmation.document)
        setImportedVoicePlacementId(confirmation.placementOperationId)
        setVoiceSaveAmbiguous(false)
        setVoiceSavePhase("placing")
        if (!placeReference(confirmation.document.ref, confirmation.placementOperationId)) {
          setVoiceSavePhase("idle")
          setVoiceSaveError("The transcript revision is durable, but this Atlas is not ready to place it yet.")
        }
      } catch (error) {
        const safeError = safeCodeImportError(error)
        setVoiceSaveError(safeError.message)
        setVoiceSaveAmbiguous(safeError.ambiguous)
        setVoiceSavePhase("idle")
      }
      return
    }
    let activeDraft = voiceRecordingRecovery ?? request.recording
    setVoiceRecordingRecovery(activeDraft)
    let store: ReturnType<typeof createVoiceRecordingDraftStore> | null = null
    if (request.recordingStoreAvailable) {
      try { store = createVoiceRecordingDraftStore() } catch { store = null }
    }
    try {
      const result = await runVoiceCaptureSaga({
        draft: activeDraft,
        importDocument: (file, metadata) => galaxyBrainAPI.importDocument(file, metadata),
        createRelation: createVoicePairRelation,
        onPhase: setVoiceSavePhase,
        checkpoint: async (current, value) => {
          const next = store
            ? await checkpointVoiceRecordingDraft(store, codeDraftScope!, current, value)
            : await createVoiceRecordingDraft(codeDraftScope!, {
                ...current,
                checkpoints: { ...current.checkpoints, ...value },
              }, new Date(current.createdAt))
          activeDraft = next
          setVoiceRecordingRecovery(next)
          return next
        },
      })
      setVoiceRecordingRecovery(result.draft)
      setImportedVoiceDocument(result.transcript)
      setImportedVoicePlacementId(result.placementOperationId)
      setVoiceSaveAmbiguous(false)
      setVoiceSavePhase("placing")
      if (!placeReference(result.transcript.ref, result.placementOperationId)) {
        setVoiceSavePhase("idle")
        setVoiceSaveError("The audio, reviewed transcript, and their link are durable, but this Atlas is not ready to place the transcript yet.")
      }
    } catch (error) {
      const safeError = safeCodeImportError(error)
      const audioSaved = Boolean(activeDraft.checkpoints.audioImport)
      const transcriptSaved = Boolean(activeDraft.checkpoints.transcriptImport)
      const linked = Boolean(activeDraft.checkpoints.link)
      setVoiceSaveError(
        linked
          ? "The audio, reviewed transcript, and their link are durable. Retry transcript placement."
          : transcriptSaved
            ? "The audio and reviewed transcript are durable, but their link is unconfirmed. Retry the exact link before placement."
            : audioSaved
              ? "The exact audio original is durable, but the transcript is unconfirmed. Retry with this frozen review."
              : safeError.message,
      )
      setVoiceSaveAmbiguous(safeError.ambiguous || audioSaved || transcriptSaved || linked)
      setVoiceSavePhase("idle")
    }
  }, [codeDraftScope, placeReference, referencePlacementRequest, voiceRecordingRecovery, voiceSavePhase])

  const retryImportedVoicePlacement = useCallback(() => {
    if (!importedVoiceDocument || !importedVoicePlacementId || voiceSavePhase !== "idle") return
    setVoiceSaveError("")
    setVoiceSavePhase("placing")
    if (!placeReference(importedVoiceDocument.ref, importedVoicePlacementId)) {
      setVoiceSavePhase("idle")
      setVoiceSaveError("The transcript revision is durable, but this Atlas is not ready to place it yet.")
    }
  }, [importedVoiceDocument, importedVoicePlacementId, placeReference, voiceSavePhase])

  const changeVoiceCaptureOpen = useCallback((nextOpen: boolean) => {
    if (!nextOpen && (voiceSavePhase !== "idle" || voiceSaveAmbiguous)) return
    setVoiceCaptureOpen(nextOpen)
    if (nextOpen) return
    setVoiceSaveError("")
    setImportedVoiceDocument(null)
    setImportedVoicePlacementId(null)
    setVoiceSaveAmbiguous(false)
  }, [voiceSaveAmbiguous, voiceSavePhase])

  const abandonVoiceSave = useCallback(() => {
    if (voiceSavePhase !== "idle" || !codeDraftScope) return
    try {
      removeVoiceInputDraftWithWorkspaceFallback(window.sessionStorage, codeDraftScope, {
        allowWorkspaceFallback: codeDraftAllowsWorkspaceFallback,
      })
    } catch {}
    const captureId = voiceRecordingRecovery?.captureId
    try {
      const store = createVoiceRecordingDraftStore()
      if (captureId) void removeVoiceRecordingDraft(store, codeDraftScope, {
        captureId,
        allowWorkspaceFallback: codeDraftAllowsWorkspaceFallback,
      }).catch(() => {})
    } catch {}
    setVoiceCaptureOpen(false)
    setVoiceSaveError("")
    setImportedVoiceDocument(null)
    setImportedVoicePlacementId(null)
    setVoiceRecordingRecovery(null)
    setVoiceSaveAmbiguous(false)
  }, [codeDraftAllowsWorkspaceFallback, codeDraftScope, voiceRecordingRecovery?.captureId, voiceSavePhase])

  const editVoiceDraft = useCallback(() => {
    if (voiceSavePhase !== "idle" || importedVoiceDocument || voiceSaveAmbiguous) return
    setVoiceSaveError("")
  }, [importedVoiceDocument, voiceSaveAmbiguous, voiceSavePhase])

  const consumePlacementFocus = useCallback((placementId: string) => {
    setFocusPlacementId((current) => current === placementId ? undefined : current)
    setRelationFocusPlacementId((current) => current === placementId ? undefined : current)
  }, [])

  const completeReferencePlacement = useCallback((completion: ReferencePlacementCompletion) => {
    if (referencePlacementRequest?.operationId !== completion.operationId) return
    const markdownNoteCompletion = markdownNoteRecovery?.operationId === completion.operationId
      && markdownNoteRecovery.document.ref === completion.subjectRef
    const liveTarget = currentAtlasTargetRef.current
    const codeGraphSnapshotCompletion = codeGraphSnapshotRecovery?.operationId === completion.operationId
      && codeGraphSnapshotRecovery.document.ref === completion.subjectRef
    if (markdownNoteCompletion && (
      completion.canvas.workspaceId !== markdownNoteRecovery.workspaceId
      || completion.canvas.canvasId !== markdownNoteRecovery.canvasId
      || liveTarget.workspaceId !== markdownNoteRecovery.workspaceId
      || liveTarget.canvasId !== markdownNoteRecovery.canvasId
    )) {
      setMarkdownNotePhase("idle")
      setMarkdownNoteError("The placement confirmation belongs to a different Atlas target. The durable note remains available for retry on its original canvas.")
      setReferencePlacementRetry(null)
      setReferencePlacementRequest(null)
      return
    }
    if (codeGraphSnapshotCompletion && (
      completion.canvas.workspaceId !== codeGraphSnapshotRecovery.workspaceId
      || completion.canvas.canvasId !== codeGraphSnapshotRecovery.canvasId
      || liveTarget.workspaceId !== codeGraphSnapshotRecovery.workspaceId
      || liveTarget.canvasId !== codeGraphSnapshotRecovery.canvasId
    )) {
      setCodeGraphSnapshotPhase("idle")
      setCodeGraphSnapshotError("The placement confirmation belongs to a different Atlas target. The durable JSON document remains available for retry on its original canvas.")
      setReferencePlacementRetry(null)
      setReferencePlacementRequest(null)
      return
    }
    const completedReferenceHandoff = referenceHandoffOperationRef.current === completion.operationId
    const completedReferenceHandoffKind = completedReferenceHandoff
      ? referenceHandoffPlacementBindingRef.current?.kind
      : null
    let referenceHandoffRecoveryCleanupFailed = false
    if (completedReferenceHandoff) {
      try {
        removeAtlasReferenceHandoffPlacementRecovery(
          window.localStorage,
          referenceHandoffRecoveryScope,
          completion.operationId,
        )
      } catch {
        referenceHandoffRecoveryCleanupFailed = true
      }
      setReferenceHandoffRecovery(null)
      referenceHandoffRecoveryRecordRef.current = null
      referenceHandoffRecoveryDismissedRef.current = null
      referenceHandoffOperationRef.current = null
      referenceHandoffPlacementBindingRef.current = null
      referenceHandoffBusyRef.current = false
      setReferenceHandoff(null)
    }
    const url = new URL(window.location.href)
    url.searchParams.set("placement", completion.placementId)
    url.searchParams.set("ref", completion.subjectRef)
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`)
    setAtlas((currentAtlas) => currentAtlas
      ? { ...currentAtlas, durableCanvas: completion.canvas }
      : currentAtlas)
    setRelationFocusPlacementId(undefined)
    setFocusPlacementId(completion.placementId)
    setReferenceDialogOpen(false)
    setSurfacePlaceOpen(false)
    setReferencePlacementError("")
    setReferencePlacementRetry(null)
    const completedImport = importedDocument?.ref === completion.subjectRef
    const completedDatasourceImport = importedDatasourceDocument?.ref === completion.subjectRef
    const completedCode = importedCodeDocument?.ref === completion.subjectRef
    const completedCodeGraphSnapshot = codeGraphSnapshotCompletion
    const completedMarkdownNote = markdownNoteCompletion
    const completedVoice = importedVoiceDocument?.ref === completion.subjectRef
    const completedInk = importedInkDocument?.ref === completion.subjectRef
    const completedExperiment = experimentPlacementRecovery?.subjectRef === completion.subjectRef
    const completedFormalPackage = formalPackagePlacement?.subjectRef === completion.subjectRef
      && formalPackagePlacement.operationId === completion.operationId
    const completedPaperImport = paperImportRecovery?.subjectRef === completion.subjectRef
      && paperImportRecovery.operationId === completion.operationId
    const completedWebCapture = webCaptureRecovery?.subjectRef === completion.subjectRef
      && webCaptureRecovery.operationId === completion.operationId
    let paperImportRecoveryCleanupFailed = false
    let webCaptureRecoveryCleanupFailed = false
    const completedAtlasDropRecovery = atlasDropImportRecoveryRef.current
    const completedAtlasDrop = completedAtlasDropRecovery?.document.ref === completion.subjectRef
      && completedAtlasDropRecovery.operationId === completion.operationId
    const completedObjectDropRecovery = atlasObjectDropRecoveryRef.current
    const completedObjectDrop = completedObjectDropRecovery?.subjectRef === completion.subjectRef
      && completedObjectDropRecovery.operationId === completion.operationId
    if (completedAtlasDrop) {
      atlasDropImportRecoveryRef.current = null
      setAtlasDropImportPhase("idle")
      setAtlasDropImportRecovery(null)
      setAtlasDropImportError("")
      setAtlasDropImportLabel("")
      setPendingDrop(null)
    }
    if (completedObjectDrop) {
      atlasObjectDropRecoveryRef.current = null
      setAtlasObjectDropRecovery(null)
      setPendingDrop(null)
    }
    if (completedImport) {
      setDocumentImportPhase("idle")
      setDocumentImportOpen(false)
      setDocumentImportDraft(null)
      setImportedDocument(null)
      setDocumentImportRecovery(null)
      setDocumentImportError("")
      setDocumentIngestionNotice("")
      setDocumentImportErrorField(null)
      setDocumentImportAmbiguous(false)
    }
    if (completedDatasourceImport) {
      setDatasourceManagerOpen(false)
      setDatasourcePlacementError("")
      setDatasourceIngestionNotice("")
      setImportedDatasourceDocument(null)
    }
    if (completedCode && codeDraftScope) {
      try {
        removeCodeEditorDraftWithWorkspaceFallback(window.sessionStorage, codeDraftScope, {
          allowWorkspaceFallback: codeDraftAllowsWorkspaceFallback,
        })
      } catch {}
      setCodeSavePhase("idle")
      setCodeEditorOpen(false)
      setCodeSaveError("")
      setCodeSaveAmbiguous(false)
      setImportedCodeDocument(null)
      setImportedCodePlacementId(null)
    }
    if (completedCodeGraphSnapshot) {
      setCodeGraphSnapshotPhase("idle")
      setCodeGraphSnapshotOpen(false)
      setCodeGraphSnapshotError("")
      setCodeGraphSnapshotAmbiguous(false)
      setCodeGraphSnapshotTarget(null)
      setCodeGraphSnapshotRecovery(null)
    }
    if (completedMarkdownNote && codeDraftScope) {
      try {
        removeCodeEditorDraftWithWorkspaceFallback(window.sessionStorage, codeDraftScope, {
          allowWorkspaceFallback: codeDraftAllowsWorkspaceFallback,
          channel: MARKDOWN_NOTE_DRAFT_CHANNEL,
        })
      } catch {}
      setMarkdownNotePhase("idle")
      setCodeEditorOpen(false)
      setMarkdownNoteError("")
      setMarkdownNoteIngestionNotice("")
      setMarkdownNoteAmbiguous(false)
      setMarkdownNoteTarget(null)
      setMarkdownNoteRecovery(null)
    }
    if (completedVoice && codeDraftScope) {
      const captureId = voiceRecordingRecovery?.captureId
      try {
        removeVoiceInputDraftWithWorkspaceFallback(window.sessionStorage, codeDraftScope, {
          allowWorkspaceFallback: codeDraftAllowsWorkspaceFallback,
        })
      } catch {}
      try {
        const store = createVoiceRecordingDraftStore()
        if (captureId) void removeVoiceRecordingDraft(store, codeDraftScope, {
          captureId,
          allowWorkspaceFallback: codeDraftAllowsWorkspaceFallback,
        }).catch(() => {})
      } catch {}
      setVoiceSavePhase("idle")
      setVoiceCaptureOpen(false)
      setVoiceSaveError("")
      setVoiceSaveAmbiguous(false)
      setImportedVoiceDocument(null)
      setImportedVoicePlacementId(null)
      setVoiceRecordingRecovery(null)
    }
    if (completedInk) {
      setInkDrawingPhase("idle")
      setInkDrawingOpen(false)
      setInkDrawingError("")
      setInkDrawingAmbiguous(false)
      setImportedInkDocument(null)
      setImportedInkPlacementId(null)
    }
    if (completedExperiment) {
      try {
        removePendingExperimentPlacement(
          window.localStorage,
          experimentRecoveryScope,
          referencePlacementRequest.operationId,
        )
        const next = restorePendingExperimentPlacement()
        if (!next) setExperimentPlacementError("")
      } catch {
        setExperimentPlacementError("The placement is durable, but its local recovery marker could not be cleared.")
      }
    }
    if (completedFormalPackage) {
      setFormalPackagePlacing(false)
      setFormalPackagePlacement(null)
      setFormalPackagePlacementError("")
      setFormalPackageImportOpen(false)
    }
    if (completedPaperImport) {
      try {
        removePaperImportPlacementRecovery(
          window.localStorage,
          paperImportRecoveryScope,
          paperImportRecovery.operationId,
        )
      } catch {
        paperImportRecoveryCleanupFailed = true
      }
      setPaperImportPhase("idle")
      setPaperImportError("")
      setPaperImportRecovery(null)
      setPaperImportOpen(false)
    }
    if (completedWebCapture) {
      try {
        removeAtlasWebCapturePlacementRecovery(
          window.localStorage,
          webCaptureRecoveryScope,
          webCaptureRecovery.operationId,
        )
      } catch {
        webCaptureRecoveryCleanupFailed = true
      }
      setWebCapturePhase("idle")
      setWebCaptureError("")
      setWebCaptureAmbiguous(false)
      setWebCaptureIntent(null)
      setWebCaptureRecovery(null)
      setWebCaptureOpen(false)
    }
    setReferencePlacementAnnouncement(
      completedWebCapture
        ? webCaptureRecoveryCleanupFailed
          ? "Exact web content placed and selected, but its local recovery marker could not be cleared. A later retry will reconcile the same placement."
          : "Exact web content saved, placed as a pinned document, and selected. The provenance URL was not fetched."
      : completedPaperImport
        ? paperImportRecoveryCleanupFailed
          ? "Exact arXiv PDF placed and selected, but its local recovery marker could not be cleared. A later retry will reconcile the same placement."
          : "Exact arXiv PDF saved privately, placed as a pinned document, and selected. Use Open document in the selected placement."
        : completedFormalPackage
        ? "Formal project package imported; its exact passive proof graph was placed and selected."
        : completedInk
        ? "Ink revision saved, placed, and selected."
        : completedAtlasDrop
        ? "Dropped document imported durably, placed at its drop point, and selected."
        : completedVoice
        ? "Reviewed transcript saved, placed, and selected. No voice command was executed."
        : completedCode
        ? "Source revision saved, placed, and selected. No code was executed."
        : completedCodeGraphSnapshot
        ? "Exact Codebase Memory JSON saved, placed as a pinned document, and selected. No graph relations were created."
        : completedMarkdownNote
        ? `Markdown note saved through the Documents plan, placed as a pinned revision, and selected.${markdownNoteIngestionNotice ? ` ${markdownNoteIngestionNotice}` : ""}`
        : completedDatasourceImport
        ? `Datasource file imported durably, placed, and selected. ${datasourceIngestionNotice}`.trim()
        : completedImport
        ? `Document imported, placed, and selected. ${documentIngestionNotice}`.trim()
        : completedExperiment
          ? "Research record created, placed, and selected."
          : completedReferenceHandoff
            ? referenceHandoffRecoveryCleanupFailed
              ? `Exact ${completedReferenceHandoffKind === "chat" ? "conversation snapshot" : "document"} placed and selected, but its local recovery marker could not be cleared. A later retry will reconcile the same placement.`
              : `Exact ${completedReferenceHandoffKind === "chat" ? "conversation snapshot" : "document"} placed and selected.`
            : "Reference placed and selected.",
    )
    setReferencePlacementRequest(null)
  }, [
    codeGraphSnapshotRecovery,
    experimentPlacementRecovery,
    experimentRecoveryScope,
    codeDraftAllowsWorkspaceFallback,
    codeDraftScope,
    documentIngestionNotice,
    datasourceIngestionNotice,
    importedCodeDocument,
    markdownNoteRecovery,
    markdownNoteIngestionNotice,
    importedInkDocument,
    importedVoiceDocument,
    voiceRecordingRecovery?.captureId,
    importedDocument,
    importedDatasourceDocument,
    formalPackagePlacement,
    paperImportRecovery,
    paperImportRecoveryScope,
    webCaptureRecovery,
    webCaptureRecoveryScope,
    referencePlacementRequest,
    referenceHandoffRecoveryScope,
    restorePendingExperimentPlacement,
  ])

  const failReferencePlacement = useCallback((operationId: string, message: string) => {
    if (referencePlacementRequest?.operationId !== operationId) return
    const failedReferenceHandoff = referenceHandoffOperationRef.current === operationId
    if (failedReferenceHandoff) {
      referenceHandoffBusyRef.current = false
      setReferenceHandoff((current) => current?.operationId === operationId
        ? {
            ...current,
            phase: "error",
            error: "The exact document placement outcome could not be confirmed. Try again to reconcile the same operation safely.",
          }
        : current)
      clearReferenceHandoffLocation(true)
    }
    const importedPlacement = importedDocument?.ref === referencePlacementRequest.subjectRef
    const datasourcePlacement = importedDatasourceDocument?.ref === referencePlacementRequest.subjectRef
    const codePlacement = importedCodeDocument?.ref === referencePlacementRequest.subjectRef
    const codeGraphSnapshotPlacement = codeGraphSnapshotRecovery?.document.ref === referencePlacementRequest.subjectRef
      && codeGraphSnapshotRecovery.operationId === referencePlacementRequest.operationId
    const markdownNotePlacement = markdownNoteRecovery?.document.ref === referencePlacementRequest.subjectRef
      && markdownNoteRecovery.operationId === referencePlacementRequest.operationId
    const voicePlacement = importedVoiceDocument?.ref === referencePlacementRequest.subjectRef
    const inkPlacement = importedInkDocument?.ref === referencePlacementRequest.subjectRef
    const experimentPlacement = experimentPlacementRecovery?.subjectRef === referencePlacementRequest.subjectRef
    const formalPackagePlacementFailed = formalPackagePlacement?.subjectRef === referencePlacementRequest.subjectRef
      && formalPackagePlacement.operationId === referencePlacementRequest.operationId
    const paperImportPlacementFailed = paperImportRecovery?.subjectRef === referencePlacementRequest.subjectRef
      && paperImportRecovery.operationId === referencePlacementRequest.operationId
    const webCapturePlacementFailed = webCaptureRecovery?.subjectRef === referencePlacementRequest.subjectRef
      && webCaptureRecovery.operationId === referencePlacementRequest.operationId
    const atlasDropRecovery = atlasDropImportRecoveryRef.current
    const atlasDropPlacement = atlasDropRecovery?.document.ref === referencePlacementRequest.subjectRef
      && atlasDropRecovery.operationId === referencePlacementRequest.operationId
    const objectDropRecovery = atlasObjectDropRecoveryRef.current
    const objectDropPlacement = objectDropRecovery?.subjectRef === referencePlacementRequest.subjectRef
      && objectDropRecovery.operationId === referencePlacementRequest.operationId
    if (webCapturePlacementFailed) {
      setWebCapturePhase("idle")
      setWebCaptureError("The exact capture is durable, but placement is unconfirmed. Retry placement only; do not capture it again.")
    } else if (paperImportPlacementFailed) {
      setPaperImportPhase("idle")
      setPaperImportError("The exact PDF is durable, but placement is unconfirmed. Retry placement only; do not import or fetch it again.")
    } else if (formalPackagePlacementFailed) {
      setFormalPackagePlacing(false)
      setFormalPackagePlacementError("The package is registered, but placement is unconfirmed. Retry placement without importing again.")
    } else if (atlasDropPlacement) {
      setAtlasDropImportPhase("idle")
      setAtlasDropImportError("The document is durable, but placement is unconfirmed. Retry the exact point without re-uploading.")
      setPendingDrop({
        kind: "file",
        label: atlasDropImportLabel || "Dropped document",
        point: atlasDropRecovery.point,
        phase: "error",
        message: "The document is durable, but placement is unconfirmed. Retry the exact point.",
        operationId: atlasDropRecovery.operationId,
      })
    } else if (objectDropPlacement) {
      setPendingDrop({
        kind: "object",
        label: objectDropRecovery.label,
        point: objectDropRecovery.point,
        phase: "error",
        message: "Placement is unconfirmed. Retry the same operation at this exact point.",
        operationId: objectDropRecovery.operationId,
      })
    } else if (datasourcePlacement) {
      setDatasourcePlacementError("The document is durable, but placement is unconfirmed. Retry placement without reading or importing the file again.")
    } else if (importedPlacement) {
      setDocumentImportPhase("idle")
      setDocumentImportErrorField(null)
      setDocumentImportError("The document is durable, but placement is unconfirmed. Retry placement without re-uploading.")
    } else if (codePlacement) {
      setCodeSavePhase("idle")
      setCodeSaveError("The source revision is durable, but placement is unconfirmed. Retry placement without saving another revision.")
    } else if (codeGraphSnapshotPlacement) {
      setCodeGraphSnapshotPhase("idle")
      setCodeGraphSnapshotError("The exact JSON document is durable, but placement is unconfirmed. Retry placement only; do not import it again.")
    } else if (markdownNotePlacement) {
      setMarkdownNotePhase("idle")
      setMarkdownNoteError("The exact note is durable, but placement is unconfirmed. Retry placement only; do not save another revision.")
    } else if (voicePlacement) {
      setVoiceSavePhase("idle")
      setVoiceSaveError("The transcript revision is durable, but placement is unconfirmed. Retry placement without saving another revision.")
    } else if (inkPlacement) {
      setInkDrawingPhase("idle")
      setInkDrawingError("The ink revision is durable, but placement is unconfirmed. Retry placement without saving another revision.")
    } else if (experimentPlacement) {
      setExperimentPlacementError("The research record is durable, but placement is unconfirmed. Retry placement without recreating it.")
    } else {
      setReferencePlacementError(message)
    }
    setReferencePlacementRetry(referencePlacementRequest)
    setReferencePlacementAnnouncement("Reference placement outcome unconfirmed. Retry is available.")
    setReferencePlacementRequest(null)
  }, [atlasDropImportLabel, clearReferenceHandoffLocation, codeGraphSnapshotRecovery, experimentPlacementRecovery, formalPackagePlacement, importedCodeDocument, importedDatasourceDocument, importedDocument, importedInkDocument, importedVoiceDocument, markdownNoteRecovery, paperImportRecovery, referencePlacementRequest, webCaptureRecovery])

  const confirmPlacementRemoval = useCallback(() => {
    const target = placementRemoveTarget
    if (!target || placementRemovalRequest) return
    if (!atlasRuntimeReady) {
      setPlacementRemovalError("Wait for the live Atlas canvas to finish loading.")
      return
    }
    setPlacementRemovalError("")
    setPlacementRemovalAnnouncement("")
    const request = placementRemovalRetry
      && placementRemovalRetry.placementId === target.placementId
      && placementRemovalRetry.subjectRef === target.subjectRef
      ? { ...placementRemovalRetry, attempt: placementRemovalRetry.attempt + 1 }
      : {
          operationId: crypto.randomUUID(),
          placementId: target.placementId,
          subjectRef: target.subjectRef,
          attempt: 1,
        }
    setPlacementRemovalRetry(null)
    setPlacementRemovalRequest(request)
  }, [atlasRuntimeReady, placementRemovalRequest, placementRemovalRetry, placementRemoveTarget])

  const completePlacementRemoval = useCallback((completion: PlacementRemovalCompletion) => {
    if (placementRemovalRequest?.operationId !== completion.operationId) return
    const url = new URL(window.location.href)
    url.searchParams.delete("placement")
    url.searchParams.delete("ref")
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`)
    setAtlas((currentAtlas) => currentAtlas
      ? { ...currentAtlas, durableCanvas: completion.canvas }
      : currentAtlas)
    setFocusPlacementId(undefined)
    setRelationFocusPlacementId(undefined)
    setSelectedPlacementContext(null)
    setPlacementRemoveOpen(false)
    setPlacementRemoveTarget(null)
    setPlacementRemovalError("")
    setPlacementRemovalRetry(null)
    setPlacementRemovalAnnouncement("Placement removed from this Atlas. The canonical object was not deleted.")
    setPlacementRemovalRequest(null)
  }, [placementRemovalRequest])

  const failPlacementRemoval = useCallback((operationId: string, message: string, retryable: boolean) => {
    if (placementRemovalRequest?.operationId !== operationId) return
    setPlacementRemovalError(message)
    setPlacementRemovalRetry(retryable ? placementRemovalRequest : null)
    setPlacementRemovalAnnouncement(retryable
      ? "Placement removal outcome unconfirmed. Retry is available."
      : message)
    setPlacementRemovalRequest(null)
  }, [placementRemovalRequest])

  const changePlacementRemoveOpen = useCallback((nextOpen: boolean) => {
    if (!nextOpen && placementRemovalRequest) return
    setPlacementRemoveOpen(nextOpen)
    if (nextOpen) return
    setPlacementRemoveTarget(null)
    setPlacementRemovalError("")
    setPlacementRemovalRetry(null)
    setPlacementRemovalReturnFocus(null)
  }, [placementRemovalRequest])

  const retryPendingDrop = useCallback(() => {
    const recovery = selectAtlasPendingDropRecovery(pendingDrop, {
      file: atlasDropImportRecoveryRef.current,
      object: atlasObjectDropRecoveryRef.current,
    })
    if (!recovery) {
      setReferencePlacementAnnouncement("This pending card no longer matches a recoverable placement operation.")
      return
    }
    if (pendingDrop?.kind === "object") {
      retryAtlasObjectDropPlacement()
      return
    }
    retryAtlasDropPlacement()
  }, [pendingDrop, retryAtlasDropPlacement, retryAtlasObjectDropPlacement])

  const dismissPendingDrop = useCallback(() => {
    if (atlasDropImportRecoveryRef.current || atlasObjectDropRecoveryRef.current) return
    setPendingDrop(null)
    setAtlasDropImportError("")
  }, [])

  const pendingDropRecovery = selectAtlasPendingDropRecovery(pendingDrop, {
    file: atlasDropImportRecovery,
    object: atlasObjectDropRecovery,
  })
  const pendingDropRetryable = pendingDrop?.phase === "error" && pendingDropRecovery !== null
  const dropRecoveryBlocked = Boolean(atlasDropImportRecovery || atlasObjectDropRecovery)
  const sourceShelfDisabled = Boolean(
    preview
    || !atlasMutationReady
    || pendingDrop
    || referencePlacementRequest
    || placementRemovalRequest
    || dropRecoveryBlocked,
  )
  const requestSourcePlacement = useCallback((intent: AtlasObjectDragIntent) => {
    if (pendingDrop || atlasDropImportRecoveryRef.current || atlasObjectDropRecoveryRef.current
      || referencePlacementRequest || placementRemovalRequest || !atlasMutationReady) {
      setReferencePlacementAnnouncement("Finish the current or pending placement before placing another source.")
      return
    }
    setView("canvas")
    setSourcePlacementRequest({ requestId: crypto.randomUUID(), intent })
    setReferencePlacementAnnouncement(`Placing ${intent.label} at the Atlas viewport center.`)
  }, [atlasMutationReady, pendingDrop, placementRemovalRequest, referencePlacementRequest])
  const consumeSourcePlacementRequest = useCallback((requestId: string) => {
    setSourcePlacementRequest((current) => current?.requestId === requestId ? null : current)
  }, [])

  return (
    <>
    <main aria-label="Galaxy Brain Atlas workspace" className="research-workbench atlas-shell">
      <header className="atlas-shell-header">
        <div className="atlas-identity">
          <p className="research-kicker">Living research atlas</p>
          <h1 ref={atlasHeadingRef} tabIndex={-1} className="research-display rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">{atlas?.workspaceName || "Galaxy atlas"}</h1>
          <p className="atlas-identity-tagline">Canonical objects · durable placements</p>
          {atlas ? (
            <>
              <AtlasCanvasSwitcher
                canvases={atlas.canvases}
                activeCanvasId={atlas.durableCanvas?.canvasId ?? null}
                disabled={preview || loading}
                onSelect={switchAtlasCanvas}
                createAction={canvasCreateCommand ? {
                  label: canvasCreateCommand.title,
                  disabled: !canvasCreateCommand.enabled,
                  unavailableReason: canvasCreateCommand.unavailableReason,
                  onInvoke: (trigger) => executeSelectedAtlasCommand(canvasCreateCommand.id, trigger),
                } : null}
              />
              {atlas.canvasCatalogPotentiallyPartial ? (
                <p className="atlas-canvas-catalog-disclosure mt-1 text-xs text-[hsl(var(--research-muted))]">Showing the first 50 authorized canvases.</p>
              ) : null}
            </>
          ) : null}
        </div>
        <HudToolbar label="Atlas commands" pinned={hudPinned}>
          <HudAction
            ref={commandTriggerRef}
            label="Commands"
            icon={<CommandIcon />}
            aria-keyshortcuts="Control+K Meta+K"
            active={commandDeckOpen}
            onClick={() => setCommandDeckOpen(true)}
          />
          {createHudCommands.length > 0 ? (
            <AtlasCreateMenu
              ref={createHudTriggerRef}
              commands={createHudCommands}
              onSelect={(command) => executeSelectedAtlasCommand(command.id, createHudTriggerRef.current)}
            />
          ) : null}
          {voiceHudCommand ? (
            <HudAction
              ref={voiceHudTriggerRef}
              label={voiceHudCommand.title}
              icon={<Mic />}
              aria-haspopup="dialog"
              aria-expanded={voiceCaptureOpen}
              disabled={!voiceHudCommand.enabled}
              title={voiceHudCommand.enabled ? undefined : voiceHudCommand.unavailableReason ?? undefined}
              onClick={() => executeSelectedAtlasCommand(voiceHudCommand.id, voiceHudTriggerRef.current)}
            />
          ) : null}
          {proofHudCommand ? (
            <HudAction
              ref={proofHudTriggerRef}
              label={proofHudCommand.title}
              icon={<Network />}
              aria-haspopup="dialog"
              disabled={!proofHudCommand.enabled}
              title={proofHudCommand.enabled ? undefined : proofHudCommand.unavailableReason ?? undefined}
              onClick={() => executeSelectedAtlasCommand(proofHudCommand.id, proofHudTriggerRef.current)}
            />
          ) : null}
          <HudDivider />
          <HudAction label="Spatial" icon={<Orbit />} active={view === "canvas"} onClick={() => setView("canvas")} />
          <HudAction
            label="List"
            icon={<List />}
            active={view === "list"}
            disabled={referencePlacementRequest !== null || placementRemovalRequest !== null || frameMutationBusy || frameMutationOperation !== null}
            onClick={requestListView}
          />
          <HudDivider />
          <HudAction
            label="Refresh"
            icon={<RefreshCw className={loading ? "animate-spin" : ""} />}
            disabled={loading || referencePlacementRequest !== null || placementRemovalRequest !== null || frameMutationBusy || frameMutationOperation !== null}
            onClick={requestAtlasRefresh}
          />
          <HudAction
            label="Metrics"
            icon={<Activity />}
            active={showDiagnostics}
            onClick={() => setShowDiagnostics((value) => !value)}
          />
          <HudAction
            label={hudPinned ? "Unpin HUD" : "Pin HUD"}
            icon={hudPinned ? <PinOff /> : <Pin />}
            active={hudPinned}
            aria-pressed={hudPinned}
            onClick={() => setHudPinned((value) => !value)}
          />
          <HudStatus>{view === "canvas" ? "Press Ctrl+K for Atlas commands." : "Accessible object list."}</HudStatus>
        </HudToolbar>
        {atlas ? (
          <details className="atlas-source-status">
            <summary>Sources</summary>
            <ul aria-label="Authorized source status">
              {atlas.sources.map((source) => (
                <li key={source.label} data-state={source.status}>
                  {source.label}: {source.status === "unavailable"
                    ? "unavailable"
                    : `${source.count}${source.status === "partial" ? " (partial)" : ""}`}
                </li>
              ))}
              <li data-state={hamRelationState.status}>
                HAM relations (follow-latest{hamRelationRequest.clientTruncated
                  ? `, client-truncated to ${HAM_RELATION_OVERLAY_MAX_REFERENCES} of ${hamRelationRequest.eligibleCount}`
                  : ""}{hamRelationState.value?.provider.truncated ? ", provider-truncated" : ""}): {hamRelationState.status === "unavailable"
                  ? "unavailable"
                  : `${hamRelationState.value?.relations.length ?? 0}${hamRelationState.status === "partial" ? " (partial)" : ""}`}
              </li>
            </ul>
            <AtlasSourceShelf
              placements={atlas.sourceCandidates}
              disabled={sourceShelfDisabled}
              onPlace={requestSourcePlacement}
            />
          </details>
        ) : null}
        {hydrationStatus ? (
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {hydrationStatus}
          </p>
        ) : null}
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {pendingInvalidation
            ? loading
              ? "Reauthorizing and loading the updated Atlas…"
              : `Accepted Atlas layout v${pendingInvalidation.version} is available. Reload when the current placement is finished.`
            : ""}
        </p>
        {pendingInvalidation ? (
          <div className="atlas-invalidation-status flex flex-wrap items-center gap-3 rounded-xl border border-[#718579]/50 bg-[#f4f6e9] px-3 py-2 text-sm text-[#294438]">
            <span className="min-w-0 flex-1">
              {loading
                ? "Reauthorizing and loading the updated Atlas…"
                : `Accepted Atlas layout v${pendingInvalidation.version} is available. Reload when the current placement is finished.`}
            </span>
            <Button
              className="min-h-10"
              type="button"
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={requestInvalidatedCanvasReload}
            >
              {loading ? "Reauthorizing…" : "Reload accepted layout"}
            </Button>
          </div>
        ) : null}
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {relationModeAnnouncement}
        </p>
        {relationSource && !relationComposeOpen ? (
          <section
            className="atlas-relation-mode-strip flex min-w-0 flex-wrap items-center gap-3 rounded-xl border px-3 py-2 text-sm"
            aria-label="Relation mode"
          >
            <p className="min-w-0 flex-1">
              <span className="research-kicker mr-2">Relation mode</span>
              <strong className="break-words" title={relationSource.relationRef}>From {relationSource.label}.</strong>{" "}
              {view === "list"
                ? "Choose another exact object from the list as the target."
                : "Select another exact object as the target."}
            </p>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {view !== "list" ? (
                <Button
                  className="min-h-11 whitespace-normal"
                  type="button"
                  variant="outline"
                  onClick={requestRelationListView}
                >
                  <List aria-hidden="true" />
                  Choose target in List
                </Button>
              ) : null}
              <Button
                ref={relationModeCancelRef}
                className="min-h-11 whitespace-normal"
                type="button"
                variant="outline"
                aria-keyshortcuts="Escape"
                onClick={() => cancelRelationMode()}
              >
                Cancel relation
              </Button>
            </div>
          </section>
        ) : null}
        <p
          id="atlas-canvas-status"
          className={canvasActionStatus
            ? "atlas-action-status rounded-xl border border-[#b66238]/45 bg-[#fff2eb] px-3 py-2 text-sm text-[#71331f]"
            : "sr-only"}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {canvasActionStatus ? (
            <>{canvasActionStatus}</>
          ) : null}
        </p>
        {frameMutationOperation && !frameMutationBusy ? (
          <div
            className="flex max-w-2xl flex-wrap items-center gap-3 rounded-xl border border-[#b66238]/45 bg-[#fff2eb] px-3 py-2 text-sm text-[#71331f]"
            role="alert"
          >
            <span className="min-w-0 flex-1">
              A {frameMutationOperation.kind === "create" ? "frame creation" : "frame removal"} is journaled until its server outcome is confirmed.
            </span>
            {frameMutationOperation.kind === "create" ? (
              <Button type="button" size="sm" variant="outline" onClick={() => setFrameCreateOpen(true)}>
                Review exact frame
              </Button>
            ) : null}
            <Button type="button" size="sm" onClick={() => runFrameMutationOperation(frameMutationOperation)}>
              Retry exact operation
            </Button>
          </div>
        ) : null}
        {referencePlacementAnnouncement ? (
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {referencePlacementAnnouncement}
          </p>
        ) : null}
        {!documentImportOpen && documentImportRecovery && documentImportError ? (
          <div
            className="flex max-w-2xl flex-wrap items-center gap-3 rounded-xl border border-[#b66238]/45 bg-[#fff2eb] px-3 py-2 text-sm text-[#71331f]"
            role="alert"
          >
            <span className="min-w-0 flex-1">{documentImportError}</span>
            <a
              className="font-semibold underline underline-offset-4"
              href={`/documents/${encodeURIComponent(documentImportRecovery.document.revision_id)}`}
            >
              Open exact revision
            </a>
            <Button
              size="sm"
              type="button"
              disabled={documentImportPhase !== "idle"}
              onClick={retryImportedDocumentPlacement}
            >
              Retry placement
            </Button>
          </div>
        ) : null}
        {documentAnalysisState ? (
          <div
            className="flex max-w-2xl flex-wrap items-center gap-3 rounded-xl border border-[#6d7a68]/45 bg-[#f4f6e9] px-3 py-2 text-sm text-[#294438]"
            role="status"
            aria-live="polite"
          >
            <span className="min-w-0 flex-1">
              <strong>{documentAnalysisState.label}</strong>{" "}{documentAnalysisState.message}
            </span>
            <a
              className="font-semibold underline underline-offset-4"
              href={`/documents/${encodeURIComponent(documentAnalysisState.document.revision_id)}`}
            >
              Open exact revision
            </a>
            {documentAnalysisState.resumable ? (
              <Button
                size="sm"
                type="button"
                disabled={documentAnalysisBusy}
                onClick={() => { void resumeDocumentAnalysis() }}
              >
                {documentAnalysisBusy ? "Resuming…" : "Resume analysis"}
              </Button>
            ) : documentAnalysisState.dismissible ? (
              <Button size="sm" type="button" variant="ghost" onClick={() => replaceDocumentAnalysisState(null)}>
                Dismiss
              </Button>
            ) : null}
          </div>
        ) : null}
        {atlasDropImportPhase !== "idle" || atlasDropImportRecovery || atlasDropImportError || atlasDropIngestionNotice ? (
          <div
            className={`flex max-w-2xl flex-wrap items-center gap-3 rounded-xl border px-3 py-2 text-sm ${atlasDropImportError
              ? "border-[#b66238]/45 bg-[#fff2eb] text-[#71331f]"
              : "border-[#6d7a68]/45 bg-[#f4f6e9] text-[#294438]"}`}
            role={atlasDropImportError ? "alert" : "status"}
            aria-live="polite"
          >
            <span className="min-w-0 flex-1">
              {atlasDropImportError || (atlasDropImportPhase === "importing"
                ? `Importing exact bytes for ${atlasDropImportLabel || "the dropped document"}…`
                : atlasDropImportPhase === "transforming"
                  ? `The exact original is durable. Running bounded analysis for ${atlasDropImportLabel || "the dropped document"}…`
                  : atlasDropImportPhase === "placing"
                    ? `Placing ${atlasDropImportLabel || "the durable document"} at the drop point… ${atlasDropIngestionNotice}`
                    : atlasDropIngestionNotice)}
            </span>
            {atlasDropImportRecovery ? (
              <a
                className="font-semibold underline underline-offset-4"
                href={`/documents/${encodeURIComponent(atlasDropImportRecovery.document.revision_id)}`}
              >
                Open exact revision
              </a>
            ) : null}
            {atlasDropImportRecovery && atlasDropImportPhase === "idle" ? (
              <Button
                size="sm"
                type="button"
                disabled={referencePlacementRequest !== null}
                onClick={retryAtlasDropPlacement}
              >
                Retry placement only
              </Button>
            ) : null}
            {!atlasDropImportRecovery && atlasDropImportPhase === "idle" ? (
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => {
                  setAtlasDropImportError("")
                  setAtlasDropIngestionNotice("")
                  setAtlasDropImportLabel("")
                }}
              >
                Dismiss
              </Button>
            ) : null}
          </div>
        ) : null}
        {experimentPlacementRecovery ? (
          <div
            className="flex max-w-xl flex-wrap items-center gap-3 rounded-xl border border-[#c79a4b]/45 bg-[#fff8e8] px-3 py-2 text-sm text-[#56431f]"
            role="status"
            aria-live="polite"
          >
            <span className="min-w-0 flex-1">
              <strong>{experimentPlacementRecovery.title}</strong>{" "}
              {referencePlacementRequest?.subjectRef === experimentPlacementRecovery.subjectRef
                ? "is durable; placing it on this Atlas…"
                : experimentPlacementError || "is durable and waiting to be placed on this Atlas."}
            </span>
            <a
              className="font-semibold underline underline-offset-4"
              href={`/eln/experiment/${encodeURIComponent(experimentPlacementRecovery.experimentId)}`}
            >
              Open record
            </a>
            <Button
              size="sm"
              type="button"
              disabled={referencePlacementRequest !== null}
              onClick={retryCreatedExperimentPlacement}
            >
              Retry placement
            </Button>
          </div>
        ) : null}
        {placementRemovalAnnouncement ? (
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {placementRemovalAnnouncement}
          </p>
        ) : null}
        {shareBusy ? (
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            Creating immutable tenant-scoped share link…
          </p>
        ) : null}
        {shareNotice ? (
          <div
            className={`flex max-w-2xl flex-wrap items-center gap-3 rounded-xl border px-3 py-2 text-sm ${shareNotice.state === "error"
              ? "border-[#b66238]/45 bg-[#fff2eb] text-[#71331f]"
              : "border-[#6d7a68]/45 bg-[#f4f6e9] text-[#294438]"}`}
            role={shareNotice.state === "error" ? "alert" : "status"}
            aria-live="polite"
          >
            <Share2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">{shareNotice.message}</span>
            {shareNotice.url ? (
              <>
                <a
                  className="font-semibold underline underline-offset-4"
                  href={shareNotice.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open share
                </a>
                <Button size="sm" type="button" variant="outline" onClick={copyShareUrl}>
                  Copy link
                </Button>
              </>
            ) : shareRetryRequest ? (
              <Button
                size="sm"
                type="button"
                variant="outline"
                disabled={shareBusy}
                onClick={() => { void runAtlasShare(shareRetryRequest) }}
              >
                Retry same share
              </Button>
            ) : null}
            <Button
              size="sm"
              type="button"
              variant="ghost"
              aria-label="Dismiss share status"
              disabled={shareBusy}
              onClick={() => {
                setShareNotice(null)
                setShareRetryRequest(null)
              }}
            >
              Dismiss
            </Button>
          </div>
        ) : null}
        {/* The same trailing controls every other surface's top rail carries. */}
        <div className="atlas-header-account flex items-center gap-2">
          <ThemeToggle />
          {headerSlot}
        </div>
      </header>
      <section className="atlas-stage">
        {loading ? (
          <div className="flex flex-1 items-center justify-center p-8 text-sm text-[#61766b]">Loading authorized resources…</div>
        ) : loadError ? (
          <div className="m-auto max-w-lg p-8 text-center" role="alert">
            <h2 ref={loadErrorHeadingRef} tabIndex={-1} className="research-display rounded-sm text-xl font-semibold text-[#18372b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">Atlas unavailable</h2>
            <p className="mt-3 text-sm text-[#61766b]">{loadError}</p>
          </div>
        ) : atlas && runtimeProjection && runtimeBaseProjection && view === "canvas" && mounted ? (
          <AtlasCanvas
            projection={runtimeProjection}
            baseProjection={runtimeBaseProjection}
            hydrationByReference={hydrationByReference}
            exactRepresentationAuthorizationScope={exactRepresentationAuthorizationScope}
            workspaceId={atlas.workspaceId}
            workspaceName={atlas.workspaceName}
            initialCanvas={atlas.durableCanvas}
            tasks={atlas.tasks}
            showDiagnostics={showDiagnostics}
            preview={preview}
            defaultSelectionRef={defaultSelectionRef}
            focusPlacementId={relationFocusPlacementId || focusPlacementId}
            consumeMissingRelationFocus={relationFocusPlacementId !== undefined}
            referencePlacementRequest={referencePlacementRequest}
            placementRemovalRequest={placementRemovalRequest}
            canRemovePlacement={atlasMutationReady}
            canComposeRelation={atlasMutationReady}
            relationSource={relationSource}
            relationReferenceCounts={relationReferenceCounts}
            onSelectedTaskChange={setSelectedTaskContext}
            onSelectedPlacementChange={setSelectedPlacementContext}
            onSelectedFrameChange={setSelectedFrameContext}
            onExecuteTaskCommand={executeTaskCommand}
            onExecutePlacementCommand={executePlacementCommand}
            onRelationAction={relationAction}
            onFocusPlacementConsumed={consumePlacementFocus}
            onReferencePlacementTarget={bindReferencePlacementTarget}
            onReferencePlacementComplete={completeReferencePlacement}
            onReferencePlacementError={failReferencePlacement}
            pendingDrop={pendingDrop}
            pendingDropRetryable={pendingDropRetryable}
            dropRecoveryBlocked={dropRecoveryBlocked}
            sourcePlacementRequest={sourcePlacementRequest}
            onPendingDrop={setPendingDrop}
            onAtlasObjectDrop={importAtlasObjectDrop}
            onSourcePlacementConsumed={consumeSourcePlacementRequest}
            onPendingDropRetry={retryPendingDrop}
            onPendingDropDismiss={dismissPendingDrop}
            onAtlasDropImport={importAtlasDrop}
            onAtlasDropImportError={rejectAtlasDropImport}
            onPlacementRemovalComplete={completePlacementRemoval}
            onPlacementRemovalError={failPlacementRemoval}
            onRemoveFrame={removeAtlasFrame}
            onOpenList={requestListView}
            canvasMutationsBlocked={frameMutationBusy || frameMutationOperation !== null}
            onCanvasAccepted={acceptCanvasSnapshot}
            onPendingWorkReaderChange={registerCanvasConvergenceReader}
          />
        ) : atlas && view === "canvas" ? (
          <div className="flex flex-1 items-center justify-center p-8 text-sm text-[#61766b]">Preparing spatial surface…</div>
        ) : atlas && runtimeProjection ? (
          <div className="w-full overflow-auto">
            <AccessibleAtlasList
              headingRef={atlasListHeadingRef}
              projection={runtimeProjection}
              hydrationByReference={hydrationByReference}
              tasks={atlas.tasks}
              canRemovePlacement={atlasMutationReady}
              canComposeRelation={atlasMutationReady}
              relationSource={relationSource}
              relationReferenceCounts={relationReferenceCounts}
              onExecuteTaskCommand={executeTaskCommand}
              onExecutePlacementCommand={executePlacementCommand}
              onRelationAction={relationAction}
              onFocusPlacement={focusRelationPlacement}
              onShareCanvasConversation={prepareCanvasConversationShare}
              onRemoveFrame={removeAtlasFrame}
            />
          </div>
        ) : null}
      </section>
    </main>
    <AtlasCommandDeck
      commands={atlasCommands}
      open={commandDeckOpen}
      onOpenChange={setCommandDeckOpen}
      onSelect={executeSelectedAtlasCommand}
      returnFocus={commandTriggerRef.current}
    />
    <AtlasShareScopeDialog
      open={shareScopeOpen}
      busy={shareBusy}
      scope={shareScope}
      status={shareNotice}
      returnFocus={shareScopeReturnFocus}
      fallbackFocus={atlasHeadingRef.current}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && shareBusy) return
        setShareScopeOpen(nextOpen)
        if (nextOpen) return
        setShareScope(null)
        setShareScopeRequest(null)
        setShareRetryRequest(null)
        setShareNotice(null)
      }}
      onConfirm={() => {
        if (shareScopeRequest) void runAtlasShare(shareScopeRequest)
      }}
      onRetry={() => {
        const request = shareRetryRequest || shareScopeRequest
        if (request) void runAtlasShare(request)
      }}
      onCopy={copyShareUrl}
    />
    <AtlasHamMemoryBrowser
      open={hamMemoryOpen}
      onOpenChange={setHamMemoryOpen}
      returnFocus={commandTriggerRef.current}
      onMutationCommitted={() => {
        requestAtlasReload("Finish the current Atlas placement before refreshing HAM memory.")
      }}
    />
    <AtlasCommandPresenterHost
      returnFocus={commandPresenterReturnFocusRef.current?.isConnected
        ? commandPresenterReturnFocusRef.current
        : commandTriggerRef.current}
      fallbackFocus={atlasHeadingRef.current}
      canvas={canvasCreateScope && atlas ? {
        open: canvasCreateOpen,
        onOpenChange: setCanvasCreateOpen,
        onBusyChange: setCanvasCreateBusy,
        getBlockedReason: canvasCreateBlockedReason,
        scope: canvasCreateScope,
        canvases: atlas.canvases,
      } : null}
      frame={{
        open: frameCreateOpen,
        busy: frameMutationBusy,
        error: frameMutationError,
        recoveryDraft: frameMutationOperation?.kind === "create"
          ? { title: frameMutationOperation.frame.title, tone: frameMutationOperation.frame.tone }
          : null,
        onOpenChange: setFrameCreateOpen,
        onCreate: createAtlasFrame,
      }}
      eln={{
        open: experimentCreateOpen,
        onOpenChange: setExperimentCreateOpen,
        onCreated: placeCreatedExperiment,
        recoveryScope: experimentRecoveryScope,
      }}
      code={codeDraftScope ? {
        open: codeEditorOpen,
        preset: codeEditorPreset,
        phase: codeEditorPreset === "markdown-note" ? markdownNotePhase : codeSavePhase,
        error: codeEditorPreset === "markdown-note" ? markdownNoteError : codeSaveError,
        notice: codeEditorPreset === "markdown-note" ? markdownNoteIngestionNotice : "",
        imported: codeEditorPreset === "markdown-note"
          ? markdownNoteRecovery?.document ?? null
          : importedCodeDocument,
        ambiguous: codeEditorPreset === "markdown-note" ? markdownNoteAmbiguous : codeSaveAmbiguous,
        scope: codeDraftScope,
        allowWorkspaceFallback: codeDraftAllowsWorkspaceFallback,
        onOpenChange: codeEditorPreset === "markdown-note" ? changeMarkdownNoteOpen : changeCodeEditorOpen,
        onSave: codeEditorPreset === "markdown-note" ? saveMarkdownNoteAndPlace : saveCodeAndPlace,
        onRetryPlacement: codeEditorPreset === "markdown-note"
          ? retryMarkdownNotePlacement
          : retryImportedCodePlacement,
        onAbandon: codeEditorPreset === "markdown-note" ? abandonMarkdownNote : abandonCodeSave,
        onEdit: codeEditorPreset === "markdown-note" ? editMarkdownNote : editCodeDraft,
      } : null}
      codeGraph={{
        open: codeGraphSnapshotOpen,
        phase: codeGraphSnapshotPhase,
        error: codeGraphSnapshotError,
        imported: codeGraphSnapshotRecovery?.document ?? null,
        ambiguous: codeGraphSnapshotAmbiguous,
        onOpenChange: changeCodeGraphSnapshotOpen,
        onImport: (request) => { void importCodeGraphSnapshotAndPlace(request) },
        onRetryPlacement: retryCodeGraphSnapshotPlacement,
        onKeepWithoutPlacing: keepCodeGraphSnapshotWithoutPlacing,
        onAbandon: abandonCodeGraphSnapshotImport,
        onEdit: editCodeGraphSnapshotImport,
      }}
      voice={codeDraftScope ? {
        open: voiceCaptureOpen,
        phase: voiceSavePhase,
        error: voiceSaveError,
        imported: importedVoiceDocument,
        ambiguous: voiceSaveAmbiguous,
        recovery: voiceRecordingRecovery,
        scope: codeDraftScope,
        allowWorkspaceFallback: codeDraftAllowsWorkspaceFallback,
        onOpenChange: changeVoiceCaptureOpen,
        onSave: saveVoiceAndPlace,
        onRetryPlacement: retryImportedVoicePlacement,
        onAbandon: abandonVoiceSave,
        onEdit: editVoiceDraft,
      } : null}
      task={{
        task: constructorTask,
        open: constructorOpen,
        onOpenChange: setConstructorOpen,
        returnFocus: constructorReturnFocus,
        mode: preview ? "preview" : "live",
      }}
    />
    <InkDrawingDialog
      open={inkDrawingOpen}
      phase={inkDrawingPhase}
      error={inkDrawingError}
      imported={importedInkDocument}
      ambiguous={inkDrawingAmbiguous}
      onOpenChange={changeInkDrawingOpen}
      onSave={saveInkAndPlace}
      onRetryPlacement={retryImportedInkPlacement}
      onEdit={editInkDrawing}
      returnFocus={commandPresenterReturnFocusRef.current?.isConnected
        ? commandPresenterReturnFocusRef.current
        : commandTriggerRef.current}
    />
    <WebCaptureDialog
      open={webCaptureOpen}
      phase={webCapturePhase}
      error={webCaptureError}
      ambiguous={webCaptureAmbiguous}
      recovery={webCaptureRecovery}
      onOpenChange={changeWebCaptureOpen}
      onCapture={(input) => { void captureWebContentAndPlace(input) }}
      onRetryPlacement={retryWebCapturePlacement}
      onAbandonCapture={abandonWebCapture}
      onEdit={editWebCapture}
      returnFocus={commandPresenterReturnFocusRef.current?.isConnected
        ? commandPresenterReturnFocusRef.current
        : commandTriggerRef.current}
    />
    <ArxivPaperImportDialog
      open={paperImportOpen}
      phase={paperImportPhase}
      error={paperImportError}
      acquired={paperImportRecovery}
      onOpenChange={changePaperImportOpen}
      onAcquire={(selection) => { void acquirePaperAndPlace(selection) }}
      onRetryPlacement={retryPaperImportPlacement}
      onEdit={() => {
        if (!paperImportRecovery && paperImportPhase === "idle") setPaperImportError("")
      }}
      returnFocus={commandPresenterReturnFocusRef.current?.isConnected
        ? commandPresenterReturnFocusRef.current
        : commandTriggerRef.current}
    />
    <DocumentImportDialog
      open={documentImportOpen}
      phase={documentImportPhase}
      error={documentImportError}
      ingestionNotice={documentIngestionNotice}
      errorField={documentImportErrorField}
      imported={importedDocument}
      ambiguous={documentImportAmbiguous}
      onOpenChange={changeDocumentImportOpen}
      onImport={importDocumentAndPlace}
      onRetryPlacement={retryImportedDocumentPlacement}
      onAbandon={abandonDocumentImport}
      onEdit={editDocumentImport}
      returnFocus={commandPresenterReturnFocusRef.current?.isConnected
        ? commandPresenterReturnFocusRef.current
        : commandTriggerRef.current}
    />
    <DatasourceManagerDialog
      open={datasourceManagerOpen}
      ingestionScopePrefix={atlas
        ? `atlas:${documentAnalysisContextKey(tenantId, principalId, atlas.workspaceId)}`
        : null}
      ingestionTarget={atlas?.durableCanvas
        ? { workspaceId: atlas.workspaceId, canvasId: atlas.durableCanvas.canvasId }
        : null}
      placementBusy={Boolean(
        referencePlacementRequest
        && importedDatasourceDocument?.ref === referencePlacementRequest.subjectRef
      )}
      placementError={datasourcePlacementError}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && referencePlacementRequest) return
        setDatasourceManagerOpen(nextOpen)
        if (nextOpen) return
        setDatasourcePlacementError("")
        setDatasourceIngestionNotice("")
        setImportedDatasourceDocument(null)
      }}
      onDurableImport={placeImportedDatasourceDocument}
      returnFocus={commandTriggerRef.current}
    />
    <RelationProposalReviewDialog
      open={relationReviewOpen}
      onOpenChange={setRelationReviewOpen}
      returnFocus={commandTriggerRef.current}
      onCommitted={() => {
        requestAtlasReload("Finish the current Atlas placement before refreshing relations.")
      }}
    />
    <AtlasRelationComposeDialog
      open={relationComposeOpen}
      source={relationSource ? { label: relationSource.label, ref: relationSource.relationRef } : null}
      target={relationTarget ? { label: relationTarget.label, ref: relationTarget.relationRef } : null}
      relation={relationKind}
      busy={relationComposeBusy}
      frozen={relationRequest !== null}
      ambiguous={relationComposeAmbiguous}
      error={relationComposeError}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setRelationComposeOpen(true)
          return
        }
        clearRelationComposer("Relation mode canceled.")
      }}
      onRelationChange={setRelationKind}
      onSwap={swapRelationDirection}
      onConfirm={confirmAuthoredRelation}
      onAbandon={() => clearRelationComposer("Relation retry released.")}
      returnFocus={relationComposeReturnFocus}
      fallbackFocus={() => (
        atlasHeadingRef.current
          ?.closest("main")
          ?.querySelector<HTMLElement>("[data-canvas-host]")
        || atlasHeadingRef.current
      )}
    />
    <FormalProjectPackageImportDialog
      open={formalPackageImportOpen}
      placing={formalPackagePlacing}
      placement={formalPackagePlacement}
      placementError={formalPackagePlacementError}
      selectionContext={atlas?.durableCanvas
        ? formalPackageSelectionContext(atlas.workspaceId, atlas.durableCanvas.canvasId)
        : "atlas-unavailable"}
      onOpenChange={setFormalPackageImportOpen}
      onImported={importFormalProjectPackage}
      onRetryPlacement={retryFormalProjectPackagePlacement}
      returnFocus={commandTriggerRef.current}
    />
    <ReferenceHandoffDialog
      open={referenceHandoff !== null}
      phase={referenceHandoff?.phase || "authorizing"}
      subjectRef={referenceHandoff?.subjectRef || ""}
      kind={referenceHandoff?.kind}
      title={referenceHandoff?.title}
      error={referenceHandoff?.error || ""}
      onCancel={cancelReferenceHandoff}
      onConfirm={confirmReferenceHandoff}
      returnFocus={commandTriggerRef.current || atlasHeadingRef.current}
    />
    <ReferencePlaceDialog
      open={referenceDialogOpen}
      busy={referencePlacementRequest !== null}
      error={referencePlacementError}
      onOpenChange={setReferenceDialogOpen}
      onPlace={placeReference}
      onEdit={() => setReferencePlacementError("")}
      returnFocus={commandTriggerRef.current}
    />
    <PromotedSurfacePlaceDialog
      open={surfacePlaceOpen}
      busy={referencePlacementRequest !== null}
      placementError={referencePlacementError}
      onOpenChange={setSurfacePlaceOpen}
      onPlace={placeReference}
      onEdit={() => setReferencePlacementError("")}
      returnFocus={commandTriggerRef.current}
    />
    <PlacementRemoveDialog
      open={placementRemoveOpen}
      busy={placementRemovalRequest !== null}
      error={placementRemovalError}
      placementId={placementRemoveTarget?.placementId || "selected-placement"}
      label={placementRemoveTarget?.label || "selected object"}
      onOpenChange={changePlacementRemoveOpen}
      onConfirm={confirmPlacementRemoval}
      returnFocus={placementRemovalReturnFocus?.isConnected
        ? placementRemovalReturnFocus
        : commandTriggerRef.current}
      fallbackFocus={() => (
        atlasHeadingRef.current
          ?.closest("main")
          ?.querySelector<HTMLElement>("[data-canvas-host]")
        || atlasHeadingRef.current
      )}
    />
    <LegacyFlowPortabilityDialog
      open={legacyFlowPortabilityOpen}
      onOpenChange={setLegacyFlowPortabilityOpen}
      returnFocus={commandTriggerRef.current}
    />
    </>
  )
}
