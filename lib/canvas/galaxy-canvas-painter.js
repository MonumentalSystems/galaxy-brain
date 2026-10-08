import { GALAXY_CANVAS_NODE_TYPES } from "./galaxy-canvas-adapter.js"

const TYPE_PRESENTATION = Object.freeze({
  "galaxy.paper": { label: "Paper", accent: "#4e5a8c", wash: "#eef0f8" },
  "galaxy.note": { label: "Note", accent: "#87672f", wash: "#faf4e7" },
  "galaxy.document": { label: "Document", accent: "#596655", wash: "#eef3ec" },
  "galaxy.media": { label: "Media", accent: "#8a4c31", wash: "#faeee8" },
  "galaxy.eln-record": { label: "ELN record", accent: "#356751", wash: "#e8f3ee" },
  "galaxy.task": { label: "Task", accent: "#805b18", wash: "#faf1dd" },
  "galaxy.chat": { label: "Conversation", accent: "#315f70", wash: "#e8f2f5" },
  "galaxy.proof": { label: "Proof", accent: "#704477", wash: "#f5ebf6" },
  "galaxy.surface": { label: "Surface", accent: "#315f70", wash: "#e8f2f5" },
})

const NODE_TYPE_SET = new Set(GALAXY_CANVAS_NODE_TYPES)

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null
}

function boundedText(value, maximum, fallback) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum
    ? value
    : fallback
}

function fitText(ctx, value, maxWidth) {
  if (ctx.measureText(value).width <= maxWidth) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (ctx.measureText(`${value.slice(0, middle)}…`).width <= maxWidth) low = middle
    else high = middle - 1
  }
  return `${value.slice(0, low)}…`
}

/** Cheap, network-free LOD and drag representation for every Galaxy node. */
export function paintGalaxyCanvasNode(ctx, node) {
  const data = record(node?.data)
  const display = record(data?.display)
  const unavailable = data?.availability === "unavailable"
  const presentation = NODE_TYPE_SET.has(node?.type) && !unavailable
    ? TYPE_PRESENTATION[node.type]
    : null
  const accent = presentation?.accent ?? "#64748b"
  const wash = presentation?.wash ?? "#f1f5f9"
  const label = unavailable ? "Content" : presentation?.label ?? "Unavailable"
  const title = unavailable
    ? "Preview unavailable"
    : boundedText(display?.title, 240, "Unavailable canvas item")
  const meta = unavailable
    ? "Content locked"
    : boundedText(display?.status, 80, boundedText(display?.revision, 160, "Read only"))
  const horizontalPadding = Math.min(14, Math.max(6, node.w * 0.06))
  const availableWidth = Math.max(0, node.w - horizontalPadding * 2)

  ctx.fillStyle = "#fffdf9"
  ctx.fillRect(0, 0, node.w, node.h)
  ctx.fillStyle = wash
  ctx.fillRect(0, 0, node.w, Math.min(38, node.h))
  ctx.strokeStyle = accent
  ctx.lineWidth = 1.5
  ctx.strokeRect(0.75, 0.75, Math.max(0, node.w - 1.5), Math.max(0, node.h - 1.5))

  ctx.textBaseline = "top"
  ctx.fillStyle = accent
  ctx.font = "600 10px system-ui, -apple-system, sans-serif"
  ctx.fillText(fitText(ctx, label.toUpperCase(), availableWidth), horizontalPadding, 10)

  ctx.fillStyle = "#1e2a24"
  ctx.font = "600 15px system-ui, -apple-system, sans-serif"
  ctx.fillText(fitText(ctx, title, availableWidth), horizontalPadding, Math.min(49, node.h - 22))

  if (node.h >= 88) {
    ctx.fillStyle = "#66706a"
    ctx.font = "400 11px system-ui, -apple-system, sans-serif"
    ctx.fillText(fitText(ctx, meta, availableWidth), horizontalPadding, node.h - 22)
  }
}
