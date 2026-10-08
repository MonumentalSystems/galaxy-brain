import type { DurableDocumentImport } from "./durable-document-import.js"
import type { InkPlacementDescriptor } from "./canvas/ink-placement.js"

export const INK_DOCUMENT_SCHEMA_ID: "gb.ink-document.v1"
export const INK_CANVAS_WIDTH: 960
export const INK_CANVAS_HEIGHT: 540
export const MAX_INK_STROKES: 128
export const MAX_INK_POINTS: 4096
export const MAX_INK_DOCUMENT_BYTES: number

export type InkPoint = { x: number; y: number }
export type InkStroke = { points: InkPoint[]; color: string; width: number; opacity: number }
export type InkDocument = {
  schemaId: "gb.ink-document.v1"
  width: 960
  height: 540
  strokes: readonly InkStroke[]
}

export function normalizeInkStrokes(value: unknown): ReadonlyArray<Readonly<InkStroke>>
export function normalizeInkDocument(value: unknown): Readonly<InkDocument>
export function serializeInkDocument(value: unknown): string
export function renderInkDocumentSvg(value: unknown): string
export function selectInkOriginalRepresentation(
  value: unknown,
  imported: DurableDocumentImport,
): Readonly<InkPlacementDescriptor>
