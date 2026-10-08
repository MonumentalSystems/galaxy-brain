import type { CameraState } from "@canvas-harness/core"
import type { GalaxyPluginRegistry } from "./plugins/registry.js"
import type { ReferencePlacementPoint } from "./canvas/reference-placement.js"
import type { CanvasEnvelope } from "./types/canvas"

export const ATLAS_DROP_IMPORT_SOURCE_ID: "document.upload"
export const ATLAS_DROP_IMPORT_IMPLEMENTATION_ID: "builtin.document.upload-source"
export const ATLAS_DROP_INGESTION_PLAN_ID: "document.upload-default"

export type AtlasDropImportErrorCode =
  | "no_file"
  | "url_not_supported"
  | "multiple_files"
  | "mixed_payload"
  | "directory_not_supported"
  | "invalid_filename"
  | "empty_file"
  | "file_too_large"
  | "unsupported_file_type"
  | "file_changed"
  | "canvas_unavailable"

export class AtlasDropImportError extends TypeError {
  readonly code: AtlasDropImportErrorCode
  constructor(code: AtlasDropImportErrorCode)
}

export type AtlasDropCallbacks = Readonly<{
  onImport: (plan: AtlasDropImportPlan, point: ReferencePlacementPoint, canvas: CanvasEnvelope) => void | Promise<void>
  onError: (message: string) => void
}>

export function commitAtlasDropCallbacks(
  target: { current: AtlasDropCallbacks | null },
  callbacks: AtlasDropCallbacks,
): () => void

export function createAtlasDropImportOwner(): Readonly<{
  busy(): boolean
  claim(controller: Pick<AbortController, "abort">): boolean
  release(controller: Pick<AbortController, "abort">): boolean
  abort(): void
}>

export type AtlasDropImportPlan = Readonly<{
  file: File
  title: string
  filename: string
  mediaType: string
}>

export function atlasDropTitle(filename: string): string
export function atlasDropImportRegistered(registry?: GalaxyPluginRegistry): boolean
export function planAtlasDropImport(transfer: Pick<DataTransfer, "files" | "items" | "types">): AtlasDropImportPlan
export function planAtlasFileImport(file: File): AtlasDropImportPlan
export function preflightAtlasDropImport(plan: AtlasDropImportPlan): Promise<AtlasDropImportPlan>
export function authorizeAtlasDropImportTarget(
  plan: AtlasDropImportPlan,
  ensureCanvas: () => Promise<CanvasEnvelope>,
): Promise<CanvasEnvelope>
export function atlasDropWorldPoint(
  clientPoint: Readonly<{ x: number; y: number }>,
  bounds: Readonly<{ left: number; top: number }>,
  camera: CameraState,
): ReferencePlacementPoint
