export type CanvasPan = { x: number; y: number }
export type CanvasRect = { left: number; top: number }

export function pointOnCanvas(
  clientX: number,
  clientY: number,
  rect: CanvasRect,
  pan: CanvasPan,
  zoom: number,
): { x: number; y: number }

export function zoomCanvasAt(
  clientX: number,
  clientY: number,
  rect: CanvasRect,
  pan: CanvasPan,
  zoom: number,
  requestedZoom: number,
): { zoom: number; pan: CanvasPan }
