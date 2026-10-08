const MIN_ZOOM = 0.25
const MAX_ZOOM = 2.5

/** Convert a pointer in the viewport into persistent canvas coordinates. */
export function pointOnCanvas(clientX, clientY, rect, pan, zoom) {
  return {
    x: (clientX - rect.left - pan.x) / zoom,
    y: (clientY - rect.top - pan.y) / zoom,
  }
}

/** Keep the material under the pointer stationary while changing scale. */
export function zoomCanvasAt(clientX, clientY, rect, pan, zoom, requestedZoom) {
  const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, requestedZoom))
  const point = pointOnCanvas(clientX, clientY, rect, pan, zoom)
  return {
    zoom: nextZoom,
    pan: {
      x: clientX - rect.left - point.x * nextZoom,
      y: clientY - rect.top - point.y * nextZoom,
    },
  }
}
