import type { CanvasSnapshot, CanvasSnapshotItem } from "./canvas-snapshot.js"
import type { GalaxyCanvasPlacement } from "./galaxy-canvas-adapter.js"

export const DOCUMENT_ANCHOR_PLACEMENT_STYLE: "gb.canvas.document-anchor-placement.v1"

export type CanvasDocumentAnchor = {
  id: `sha256:${string}`
  ref: string
  document_revision_id: string
  representation_sha256: string
  anchor_sha256: string
  title?: string
  selector_kind?: string
  selector: Record<string, unknown> & { kind?: string; page?: number; exact?: string }
}

export type DocumentAnchorPlacementRequest = {
  documentRevisionId: string
  anchorId: string
  subjectRef: string
}

export function documentAnchorReaderHref(anchor: CanvasDocumentAnchor, sourcePage?: number): string

export function createDocumentAnchorCanvasItem(
  anchor: CanvasDocumentAnchor,
  operationId: string,
  geometry?: Partial<Pick<CanvasSnapshotItem, "x" | "y" | "width" | "height" | "zIndex">>,
  sourcePage?: number,
): CanvasSnapshotItem

export function collectDocumentAnchorPlacementRequests(snapshot: CanvasSnapshot): Array<
  DocumentAnchorPlacementRequest & { items: CanvasSnapshotItem[] }
>

export function hydrateDocumentAnchorCanvasPlacements(
  snapshot: CanvasSnapshot,
  fetchAnchor: (request: DocumentAnchorPlacementRequest) => Promise<CanvasDocumentAnchor>,
  options?: { batchSize?: number },
): Promise<GalaxyCanvasPlacement[]>
