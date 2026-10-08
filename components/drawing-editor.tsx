"use client"

import type React from "react"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Download,
  Eraser,
  Highlighter,
  MousePointer,
  Pen,
  Redo2,
  Save,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Slider } from "@/components/ui/slider"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  canvasService,
  type CanvasState,
  type DrawingMode,
  type DrawingStroke,
  type DrawingText,
} from "@/lib/canvas-service"

type DrawingEditorProps = {
  /** Unique ID used for canvas state (typically the node ID) */
  canvasId: string
  /** Initial canvas state JSON to load */
  initialState?: string | null
  /** Whether to show the grid background (whiteboard mode) */
  showGrid?: boolean
  onSave: (stateJson: string) => void
  onClose: () => void
}

const COLORS = [
  "#000000", "#FFFFFF", "#FF0000", "#00CC00", "#0066FF",
  "#FFCC00", "#FF6600", "#CC00FF", "#00CCCC", "#FF69B4",
  "#8B4513", "#708090", "#006400", "#191970", "#DC143C",
]

export function DrawingEditor({
  canvasId,
  initialState,
  showGrid = false,
  onSave,
  onClose,
}: DrawingEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [canvasState, setCanvasState] = useState<CanvasState>(canvasService.getCanvasState(canvasId))
  const [isDrawing, setIsDrawing] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const panStart = useRef({ x: 0, y: 0 })
  const [canvasSize, setCanvasSize] = useState({ w: 2000, h: 1500 })
  const [textInput, setTextInput] = useState("")
  const [textPos, setTextPos] = useState<{ x: number; y: number } | null>(null)
  const [undoStack, setUndoStack] = useState<string[]>([])
  const [redoStack, setRedoStack] = useState<string[]>([])

  // Load initial state
  useEffect(() => {
    if (initialState) {
      try {
        const parsed = JSON.parse(initialState) as CanvasState
        canvasService.loadCanvasState(canvasId, parsed)
      } catch {
        canvasService.initCanvas(canvasId)
      }
    } else {
      canvasService.initCanvas(canvasId)
    }
  }, [canvasId, initialState])

  // Subscribe to state changes
  useEffect(() => {
    return canvasService.subscribe(canvasId, (state) => {
      setCanvasState({ ...state })
    })
  }, [canvasId])

  // Render canvas
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // Background
    if (showGrid) {
      drawGrid(ctx, canvas.width, canvas.height, zoom, pan)
    } else {
      ctx.fillStyle = "#ffffff"
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }

    ctx.save()
    ctx.translate(pan.x, pan.y)
    ctx.scale(zoom, zoom)

    // Draw elements
    for (const el of canvasState.elements) {
      if ("points" in el) drawStroke(ctx, el)
      else if ("text" in el) drawText(ctx, el)
    }
    if (canvasState.currentStroke) drawStroke(ctx, canvasState.currentStroke)

    ctx.restore()
  }, [canvasState, zoom, pan, showGrid])

  // Resize canvas to container
  useEffect(() => {
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCanvasSize({
          w: Math.max(entry.contentRect.width, 800),
          h: Math.max(entry.contentRect.height, 600),
        })
      }
    })
    if (containerRef.current) resizeObserver.observe(containerRef.current)
    return () => resizeObserver.disconnect()
  }, [])

  const toCanvasCoords = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      x: (clientX - rect.left - pan.x) / zoom,
      y: (clientY - rect.top - pan.y) / zoom,
    }
  }, [pan.x, pan.y, zoom])

  const pushUndo = useCallback(() => {
    const state = canvasService.getCanvasState(canvasId)
    setUndoStack((prev) => [...prev.slice(-30), JSON.stringify(state.elements)])
    setRedoStack([])
  }, [canvasId])

  const undo = () => {
    if (undoStack.length === 0) return
    const state = canvasService.getCanvasState(canvasId)
    setRedoStack((prev) => [...prev, JSON.stringify(state.elements)])
    const last = undoStack[undoStack.length - 1]
    setUndoStack((prev) => prev.slice(0, -1))
    try {
      const elements = JSON.parse(last)
      canvasService.loadCanvasState(canvasId, { ...state, elements })
    } catch {}
  }

  const redo = () => {
    if (redoStack.length === 0) return
    const state = canvasService.getCanvasState(canvasId)
    setUndoStack((prev) => [...prev, JSON.stringify(state.elements)])
    const last = redoStack[redoStack.length - 1]
    setRedoStack((prev) => prev.slice(0, -1))
    try {
      const elements = JSON.parse(last)
      canvasService.loadCanvasState(canvasId, { ...state, elements })
    } catch {}
  }

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      // Middle-click or space+click for panning
      if (e.button === 1 || (e.button === 0 && canvasState.mode === "select")) {
        setIsPanning(true)
        panStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
        return
      }

      const { x, y } = toCanvasCoords(e.clientX, e.clientY)

      if (canvasState.mode === "text") {
        setTextPos({ x, y })
        return
      }

      pushUndo()
      setIsDrawing(true)
      canvasService.startStroke(canvasId, { x, y })
    },
    [canvasId, canvasState.mode, pan, pushUndo, toCanvasCoords],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (isPanning) {
        setPan({ x: e.clientX - panStart.current.x, y: e.clientY - panStart.current.y })
        return
      }
      if (!isDrawing) return
      const { x, y } = toCanvasCoords(e.clientX, e.clientY)
      canvasService.continueStroke(canvasId, { x, y })
    },
    [canvasId, isDrawing, isPanning, toCanvasCoords],
  )

  const handleMouseUp = useCallback(() => {
    if (isPanning) { setIsPanning(false); return }
    if (!isDrawing) return
    setIsDrawing(false)
    canvasService.endStroke(canvasId)
  }, [canvasId, isDrawing, isPanning])

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault()
      const delta = e.deltaY > 0 ? 0.9 : 1.1
      setZoom((z) => Math.max(0.1, Math.min(5, z * delta)))
    },
    [],
  )

  const handleTextSubmit = () => {
    if (!textPos || !textInput.trim()) { setTextPos(null); setTextInput(""); return }
    pushUndo()
    canvasService.addText(canvasId, textPos.x, textPos.y, textInput)
    setTextPos(null)
    setTextInput("")
  }

  const handleSave = () => {
    const state = canvasService.getCanvasState(canvasId)
    onSave(JSON.stringify(state))
  }

  const handleExport = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const url = canvas.toDataURL("image/png")
    const a = document.createElement("a")
    a.href = url
    a.download = "drawing.png"
    a.click()
  }

  const handleClear = () => {
    pushUndo()
    canvasService.clearCanvas(canvasId)
  }

  const setMode = (mode: DrawingMode) => canvasService.setMode(canvasId, mode)
  const setColor = (c: string) => canvasService.setStyle(canvasId, { color: c })
  const setBrushWidth = (w: number) => canvasService.setStyle(canvasId, { width: w })
  const setOpacity = (o: number) => canvasService.setStyle(canvasId, { opacity: o })

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-900 border-b gap-2 flex-wrap">
        <TooltipProvider delayDuration={300}>
          <div className="flex items-center gap-1">
            {/* Drawing modes */}
            {([
              ["select", MousePointer, "Select / Pan"],
              ["pen", Pen, "Pen"],
              ["highlighter", Highlighter, "Highlighter"],
              ["eraser", Eraser, "Eraser"],
              ["text", Type, "Text"],
            ] as const).map(([mode, Icon, label]) => (
              <Tooltip key={mode}>
                <TooltipTrigger asChild>
                  <Button
                    variant={canvasState.mode === mode ? "secondary" : "ghost"}
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setMode(mode)}
                  >
                    <Icon className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            ))}

            <div className="w-px h-6 bg-gray-200 dark:bg-gray-700 mx-1" />

            {/* Color picker */}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <div className="h-5 w-5 rounded-full border-2" style={{ backgroundColor: canvasState.style.color }} />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64">
                <Tabs defaultValue="color">
                  <TabsList className="w-full">
                    <TabsTrigger value="color">Color</TabsTrigger>
                    <TabsTrigger value="size">Size</TabsTrigger>
                    <TabsTrigger value="opacity">Opacity</TabsTrigger>
                  </TabsList>
                  <TabsContent value="color" className="flex flex-wrap gap-2 mt-2">
                    {COLORS.map((c) => (
                      <button
                        key={c}
                        className={`h-6 w-6 rounded-full border ${canvasState.style.color === c ? "ring-2 ring-offset-2 ring-blue-500" : ""}`}
                        style={{ backgroundColor: c }}
                        onClick={() => setColor(c)}
                      />
                    ))}
                  </TabsContent>
                  <TabsContent value="size" className="mt-2 space-y-1">
                    <Slider value={[canvasState.style.width]} min={1} max={30} step={1} onValueChange={(v) => setBrushWidth(v[0])} />
                    <div className="flex justify-between text-xs text-muted-foreground"><span>1px</span><span>{canvasState.style.width}px</span><span>30px</span></div>
                  </TabsContent>
                  <TabsContent value="opacity" className="mt-2 space-y-1">
                    <Slider value={[canvasState.style.opacity]} min={0.1} max={1} step={0.05} onValueChange={(v) => setOpacity(v[0])} />
                    <div className="flex justify-between text-xs text-muted-foreground"><span>10%</span><span>{Math.round(canvasState.style.opacity * 100)}%</span><span>100%</span></div>
                  </TabsContent>
                </Tabs>
              </PopoverContent>
            </Popover>

            <div className="w-px h-6 bg-gray-200 dark:bg-gray-700 mx-1" />

            {/* Undo/Redo */}
            <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={undo} disabled={undoStack.length === 0}>
                <Undo2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger><TooltipContent>Undo</TooltipContent></Tooltip>

            <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={redo} disabled={redoStack.length === 0}>
                <Redo2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger><TooltipContent>Redo</TooltipContent></Tooltip>

            <div className="w-px h-6 bg-gray-200 dark:bg-gray-700 mx-1" />

            {/* Zoom */}
            <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setZoom((z) => Math.min(5, z + 0.2))}>
                <ZoomIn className="h-4 w-4" />
              </Button>
            </TooltipTrigger><TooltipContent>Zoom In</TooltipContent></Tooltip>
            <span className="text-xs tabular-nums w-10 text-center">{Math.round(zoom * 100)}%</span>
            <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setZoom((z) => Math.max(0.1, z - 0.2))}>
                <ZoomOut className="h-4 w-4" />
              </Button>
            </TooltipTrigger><TooltipContent>Zoom Out</TooltipContent></Tooltip>
          </div>

          <div className="flex items-center gap-1">
            <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleClear}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger><TooltipContent>Clear All</TooltipContent></Tooltip>

            <Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleExport}>
                <Download className="h-4 w-4" />
              </Button>
            </TooltipTrigger><TooltipContent>Export PNG</TooltipContent></Tooltip>

            <Button variant="outline" size="sm" className="h-8 gap-1" onClick={handleSave}>
              <Save className="h-3.5 w-3.5" />
              Save
            </Button>
          </div>
        </TooltipProvider>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden relative"
        style={{ cursor: canvasState.mode === "select" ? "grab" : "crosshair" }}
      >
        <canvas
          ref={canvasRef}
          width={canvasSize.w}
          height={canvasSize.h}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
          className="absolute inset-0"
        />

        {/* Text input overlay */}
        {textPos && (
          <div
            className="absolute z-10 bg-white dark:bg-gray-800 border rounded-md shadow-lg p-2"
            style={{ left: textPos.x * zoom + pan.x, top: textPos.y * zoom + pan.y }}
          >
            <Input
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="Type text..."
              className="w-56 h-8 text-sm"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleTextSubmit()
                if (e.key === "Escape") { setTextPos(null); setTextInput("") }
              }}
            />
            <div className="flex justify-end gap-1 mt-1">
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => { setTextPos(null); setTextInput("") }}>
                Cancel
              </Button>
              <Button size="sm" className="h-6 text-xs" onClick={handleTextSubmit}>
                Add
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Drawing helpers ─────────────────────────────────────────

function drawStroke(ctx: CanvasRenderingContext2D, stroke: DrawingStroke) {
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

function drawText(ctx: CanvasRenderingContext2D, text: DrawingText) {
  ctx.font = `${text.fontSize}px ${text.fontFamily}`
  ctx.fillStyle = text.color
  ctx.fillText(text.text, text.x, text.y)
}

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, zoom: number, pan: { x: number; y: number }) {
  ctx.fillStyle = "#fafafa"
  ctx.fillRect(0, 0, w, h)

  const gridSize = 20 * zoom
  ctx.strokeStyle = "#e5e7eb"
  ctx.lineWidth = 0.5

  const startX = pan.x % gridSize
  const startY = pan.y % gridSize

  for (let x = startX; x < w; x += gridSize) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
  }
  for (let y = startY; y < h; y += gridSize) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
  }

  // Larger grid every 5 cells
  const bigGrid = gridSize * 5
  ctx.strokeStyle = "#d1d5db"
  ctx.lineWidth = 1
  const bigStartX = pan.x % bigGrid
  const bigStartY = pan.y % bigGrid
  for (let x = bigStartX; x < w; x += bigGrid) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
  }
  for (let y = bigStartY; y < h; y += bigGrid) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke()
  }
}
