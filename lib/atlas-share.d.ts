import type { CanvasEnvelope } from "./types/canvas"

export type AtlasShareInspection<T> =
  | { readonly ok: true; readonly selector: Readonly<T> }
  | { readonly ok: false; readonly code: "exact_reference_required" | "content_hash_required" | "conversation_excluded" | "invalid_canvas" | "exact_conversation_required" | "conversation_scope_ambiguous" }

export function inspectAtlasObjectShareReference(
  value: unknown,
): AtlasShareInspection<{ objectRef: string }>

export function inspectAtlasCanvasShare(
  canvas: CanvasEnvelope | null | undefined,
): AtlasShareInspection<{ canvasId: string; version: number; contentHash: string }>

export function inspectAtlasCanvasConversationShare(
  canvas: CanvasEnvelope | null | undefined,
  selectedReference: unknown,
): AtlasShareInspection<{
  canvasId: string
  version: number
  contentHash: string
  conversationRef: string
}>

export function atlasCanvasShareUnavailableReason(
  inspection: AtlasShareInspection<{ canvasId: string; version: number; contentHash: string }>,
  hasDurableCanvas: boolean,
): string
