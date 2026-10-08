"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { PenTool } from "lucide-react"

import { drawElements, getElementsBounds, parseCanvasState } from "@/lib/drawing-render"

type DrawingPreviewProps = {
  /** Stored CanvasState JSON (node.content). */
  content?: string | null
  /** Whiteboard mode renders a light grid background. */
  showGrid?: boolean
  className?: string
}

/**
 * Read-only thumbnail of a drawing/whiteboard node. Parses the stored
 * CanvasState and scales every stroke/text to fit the available box, so a
 * canvas card shows the actual sketch instead of raw JSON.
 */
export function DrawingPreview({ content, showGrid = false, className = "" }: DrawingPreviewProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })

  // Memoized so the render effect below is not re-run on every parent render:
  // parseCanvasState returns a fresh array each call, which would otherwise
  // change the effect's dependency identity continuously.
  const elements = useMemo(() => parseCanvasState(content)?.elements ?? [], [content])
  const isEmpty = elements.length === 0

  // Track the rendered size of the container.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect
      setBox({ w: Math.max(1, Math.floor(rect.width)), h: Math.max(1, Math.floor(rect.height)) })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Render whenever the content or box size changes.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || box.w === 0 || box.h === 0) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1
    canvas.width = Math.floor(box.w * dpr)
    canvas.height = Math.floor(box.h * dpr)

    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, box.w, box.h)
    ctx.fillStyle = showGrid ? "#fafafa" : "#ffffff"
    ctx.fillRect(0, 0, box.w, box.h)

    if (showGrid) {
      ctx.strokeStyle = "#e5e7eb"
      ctx.lineWidth = 0.5
      const gridSize = 16
      for (let x = gridSize; x < box.w; x += gridSize) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, box.h); ctx.stroke()
      }
      for (let y = gridSize; y < box.h; y += gridSize) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(box.w, y); ctx.stroke()
      }
    }

    const bounds = getElementsBounds(elements)
    if (bounds) {
      const pad = 8
      const contentW = Math.max(1, bounds.maxX - bounds.minX)
      const contentH = Math.max(1, bounds.maxY - bounds.minY)
      // Fit to box, allowing modest upscaling of tiny sketches.
      const scale = Math.min((box.w - pad * 2) / contentW, (box.h - pad * 2) / contentH, 4)
      const offsetX = (box.w - contentW * scale) / 2 - bounds.minX * scale
      const offsetY = (box.h - contentH * scale) / 2 - bounds.minY * scale
      ctx.translate(offsetX, offsetY)
      ctx.scale(scale, scale)
      drawElements(ctx, elements)
    }

    ctx.restore()
  }, [box, content, showGrid, elements])

  return (
    <div ref={wrapRef} className={`relative min-h-0 w-full flex-1 overflow-hidden rounded ${className}`}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} className="block" />
      {isEmpty && (
        <div className="absolute inset-0 flex items-center justify-center gap-1 text-[11px] text-gray-400">
          <PenTool className="h-3.5 w-3.5" />
          Empty {showGrid ? "whiteboard" : "drawing"} — click to open
        </div>
      )}
    </div>
  )
}
