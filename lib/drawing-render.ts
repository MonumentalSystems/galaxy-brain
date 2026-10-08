import type { CanvasState, DrawingElement, DrawingStroke, DrawingText } from "./canvas-service"

export type ElementsBounds = { minX: number; minY: number; maxX: number; maxY: number }

/** Parse a stored drawing/whiteboard node's content into a CanvasState, or null. */
export function parseCanvasState(json: string | null | undefined): CanvasState | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json)
    if (parsed && Array.isArray(parsed.elements)) {
      return parsed as CanvasState
    }
  } catch {
    // Not a serialized canvas (e.g. legacy plain text) — caller falls back.
  }
  return null
}

/** Compute the bounding box that contains every element, or null if empty. */
export function getElementsBounds(elements: DrawingElement[]): ElementsBounds | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const el of elements) {
    if ("points" in el) {
      const halfWidth = Math.max(el.style.width, 1) / 2
      for (const point of el.points) {
        minX = Math.min(minX, point.x - halfWidth)
        minY = Math.min(minY, point.y - halfWidth)
        maxX = Math.max(maxX, point.x + halfWidth)
        maxY = Math.max(maxY, point.y + halfWidth)
      }
    } else {
      // Approximate text extents from its font size and length.
      const width = el.text.length * el.fontSize * 0.55
      minX = Math.min(minX, el.x)
      minY = Math.min(minY, el.y - el.fontSize)
      maxX = Math.max(maxX, el.x + width)
      maxY = Math.max(maxY, el.y)
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null
  return { minX, minY, maxX, maxY }
}

export function drawStroke(ctx: CanvasRenderingContext2D, stroke: DrawingStroke) {
  if (stroke.points.length === 0) return
  ctx.beginPath()
  ctx.lineCap = "round"
  ctx.lineJoin = "round"

  if (stroke.mode === "eraser") {
    ctx.globalCompositeOperation = "destination-out"
    ctx.lineWidth = stroke.style.width * 3
  } else if (stroke.mode === "highlighter") {
    ctx.globalCompositeOperation = "multiply"
    ctx.lineWidth = stroke.style.width * 4
  } else {
    ctx.globalCompositeOperation = "source-over"
    ctx.lineWidth = stroke.style.width
  }

  ctx.strokeStyle = stroke.style.color
  ctx.globalAlpha = stroke.mode === "highlighter" ? 0.35 : stroke.style.opacity

  ctx.moveTo(stroke.points[0].x, stroke.points[0].y)
  for (let i = 1; i < stroke.points.length; i++) {
    ctx.lineTo(stroke.points[i].x, stroke.points[i].y)
  }
  ctx.stroke()
  ctx.globalCompositeOperation = "source-over"
  ctx.globalAlpha = 1
}

export function drawText(ctx: CanvasRenderingContext2D, text: DrawingText) {
  ctx.font = `${text.fontSize}px ${text.fontFamily}`
  ctx.fillStyle = text.color
  ctx.fillText(text.text, text.x, text.y)
}

/** Draw every element of a canvas into the already-transformed context. */
export function drawElements(ctx: CanvasRenderingContext2D, elements: DrawingElement[]) {
  for (const el of elements) {
    if ("points" in el) drawStroke(ctx, el)
    else if ("text" in el) drawText(ctx, el)
  }
}
