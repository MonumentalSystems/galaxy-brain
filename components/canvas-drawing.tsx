"use client"

import type React from "react"

import { useCallback, useEffect, useRef, useState } from "react"
import { Eraser, Highlighter, Pen, Square, Type } from "lucide-react"

import { Button } from "@/components/ui/button"
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

interface CanvasDrawingProps {
  flowId: string
  width: number
  height: number
  scale?: number
  translateX?: number
  translateY?: number
  isVisible?: boolean
}

export function CanvasDrawing({
  flowId,
  width,
  height,
  scale = 1,
  translateX = 0,
  translateY = 0,
  isVisible = true,
}: CanvasDrawingProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [canvasState, setCanvasState] = useState<CanvasState>(canvasService.getCanvasState(flowId))
  const [isDrawing, setIsDrawing] = useState(false)
  const [textInput, setTextInput] = useState("")
  const [textPosition, setTextPosition] = useState<{ x: number; y: number } | null>(null)
  const [showTextInput, setShowTextInput] = useState(false)

  // Subscribe to canvas state changes
  useEffect(() => {
    const unsubscribe = canvasService.subscribe(flowId, (state) => {
      setCanvasState(state)
    })

    return unsubscribe
  }, [flowId])

  // Draw on canvas when state changes
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // Apply transformation
    ctx.save()
    ctx.scale(scale, scale)
    ctx.translate(translateX, translateY)

    // Draw all elements
    canvasState.elements.forEach((element) => {
      if ("points" in element) {
        drawStroke(ctx, element)
      } else if ("text" in element) {
        drawText(ctx, element)
      }
    })

    // Draw current stroke if any
    if (canvasState.currentStroke) {
      drawStroke(ctx, canvasState.currentStroke)
    }

    // Restore transformation
    ctx.restore()
  }, [canvasState, scale, translateX, translateY])

  // Draw a stroke on the canvas
  const drawStroke = (ctx: CanvasRenderingContext2D, stroke: DrawingStroke) => {
    if (stroke.points.length === 0) return

    ctx.beginPath()
    ctx.lineCap = "round"
    ctx.lineJoin = "round"

    if (stroke.mode === "eraser") {
      ctx.globalCompositeOperation = "destination-out"
      ctx.lineWidth = stroke.style.width * 3 // Eraser is bigger
    } else {
      ctx.globalCompositeOperation = "source-over"
      ctx.lineWidth = stroke.style.width
    }

    ctx.strokeStyle = stroke.style.color
    ctx.globalAlpha = stroke.style.opacity

    const firstPoint = stroke.points[0]
    ctx.moveTo(firstPoint.x, firstPoint.y)

    for (let i = 1; i < stroke.points.length; i++) {
      const point = stroke.points[i]
      ctx.lineTo(point.x, point.y)
    }

    ctx.stroke()
    ctx.globalCompositeOperation = "source-over"
    ctx.globalAlpha = 1
  }

  // Draw text on the canvas
  const drawText = (ctx: CanvasRenderingContext2D, text: DrawingText) => {
    ctx.font = `${text.fontSize}px ${text.fontFamily}`
    ctx.fillStyle = text.color
    ctx.fillText(text.text, text.x, text.y)
  }

  // Handle mouse down event
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isVisible) return

      const canvas = canvasRef.current
      if (!canvas) return

      const rect = canvas.getBoundingClientRect()
      const x = (e.clientX - rect.left) / scale - translateX
      const y = (e.clientY - rect.top) / scale - translateY

      if (canvasState.mode === "text") {
        setTextPosition({ x, y })
        setShowTextInput(true)
        return
      }

      setIsDrawing(true)
      canvasService.startStroke(flowId, { x, y })
    },
    [flowId, isVisible, scale, translateX, translateY, canvasState.mode],
  )

  // Handle mouse move event
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isVisible || !isDrawing) return

      const canvas = canvasRef.current
      if (!canvas) return

      const rect = canvas.getBoundingClientRect()
      const x = (e.clientX - rect.left) / scale - translateX
      const y = (e.clientY - rect.top) / scale - translateY

      canvasService.continueStroke(flowId, { x, y })
    },
    [flowId, isVisible, isDrawing, scale, translateX, translateY],
  )

  // Handle mouse up event
  const handleMouseUp = useCallback(() => {
    if (!isVisible || !isDrawing) return

    setIsDrawing(false)
    canvasService.endStroke(flowId)
  }, [flowId, isVisible, isDrawing])

  // Handle mouse leave event
  const handleMouseLeave = useCallback(() => {
    if (!isVisible || !isDrawing) return

    setIsDrawing(false)
    canvasService.endStroke(flowId)
  }, [flowId, isVisible, isDrawing])

  // Handle text input submission
  const handleTextSubmit = useCallback(() => {
    if (!textPosition || !textInput.trim()) {
      setShowTextInput(false)
      setTextInput("")
      setTextPosition(null)
      return
    }

    canvasService.addText(flowId, textPosition.x, textPosition.y, textInput)
    setShowTextInput(false)
    setTextInput("")
    setTextPosition(null)
  }, [flowId, textPosition, textInput])

  // Set drawing mode
  const setMode = useCallback(
    (mode: DrawingMode) => {
      canvasService.setMode(flowId, mode)
    },
    [flowId],
  )

  // Set drawing color
  const setColor = useCallback(
    (color: string) => {
      canvasService.setStyle(flowId, { color })
    },
    [flowId],
  )

  // Set drawing width
  const setWidth = useCallback(
    (width: number) => {
      canvasService.setStyle(flowId, { width })
    },
    [flowId],
  )

  // Set drawing opacity
  const setOpacity = useCallback(
    (opacity: number) => {
      canvasService.setStyle(flowId, { opacity })
    },
    [flowId],
  )

  // Clear canvas
  const clearCanvas = useCallback(() => {
    canvasService.clearCanvas(flowId)
  }, [flowId])

  if (!isVisible) {
    return null
  }

  return (
    <div className="absolute inset-0 pointer-events-none">
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="absolute inset-0 pointer-events-auto"
        style={{ opacity: 0.9 }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      />

      {showTextInput && textPosition && (
        <div
          className="absolute bg-white border rounded-md shadow-md p-2 z-10"
          style={{
            left: textPosition.x * scale + translateX,
            top: textPosition.y * scale + translateY,
          }}
        >
          <input
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleTextSubmit()
              } else if (e.key === "Escape") {
                setShowTextInput(false)
                setTextInput("")
                setTextPosition(null)
              }
            }}
            autoFocus
            className="border rounded px-2 py-1 w-64"
            placeholder="Enter text..."
          />
          <div className="flex justify-end mt-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setShowTextInput(false)
                setTextInput("")
                setTextPosition(null)
              }}
              className="mr-2"
            >
              Cancel
            </Button>
            <Button size="sm" onClick={handleTextSubmit}>
              Add Text
            </Button>
          </div>
        </div>
      )}

      <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-white border rounded-md shadow-md flex items-center p-1 pointer-events-auto">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={canvasState.mode === "pen" ? "secondary" : "ghost"}
                size="icon"
                className="h-8 w-8"
                onClick={() => setMode("pen")}
              >
                <Pen className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Pen</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={canvasState.mode === "highlighter" ? "secondary" : "ghost"}
                size="icon"
                className="h-8 w-8"
                onClick={() => setMode("highlighter")}
              >
                <Highlighter className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Highlighter</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={canvasState.mode === "eraser" ? "secondary" : "ghost"}
                size="icon"
                className="h-8 w-8"
                onClick={() => setMode("eraser")}
              >
                <Eraser className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Eraser</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={canvasState.mode === "text" ? "secondary" : "ghost"}
                size="icon"
                className="h-8 w-8"
                onClick={() => setMode("text")}
              >
                <Type className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Text</TooltipContent>
          </Tooltip>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <div className="h-4 w-4 rounded-full border" style={{ backgroundColor: canvasState.style.color }} />
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
                  {[
                    "#000000",
                    "#FF0000",
                    "#00FF00",
                    "#0000FF",
                    "#FFFF00",
                    "#FF00FF",
                    "#00FFFF",
                    "#FF9900",
                    "#9900FF",
                    "#00FF99",
                  ].map((color) => (
                    <button
                      key={color}
                      className={`h-6 w-6 rounded-full border ${
                        canvasState.style.color === color ? "ring-2 ring-offset-2 ring-blue-500" : ""
                      }`}
                      style={{ backgroundColor: color }}
                      onClick={() => setColor(color)}
                    />
                  ))}
                </TabsContent>
                <TabsContent value="size" className="mt-2">
                  <Slider
                    value={[canvasState.style.width]}
                    min={1}
                    max={20}
                    step={1}
                    onValueChange={(value) => setWidth(value[0])}
                  />
                  <div className="flex justify-between mt-1 text-xs text-muted-foreground">
                    <span>Thin</span>
                    <span>Thick</span>
                  </div>
                </TabsContent>
                <TabsContent value="opacity" className="mt-2">
                  <Slider
                    value={[canvasState.style.opacity]}
                    min={0.1}
                    max={1}
                    step={0.1}
                    onValueChange={(value) => setOpacity(value[0])}
                  />
                  <div className="flex justify-between mt-1 text-xs text-muted-foreground">
                    <span>Transparent</span>
                    <span>Opaque</span>
                  </div>
                </TabsContent>
              </Tabs>
            </PopoverContent>
          </Popover>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={clearCanvas}>
                <Square className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clear Canvas</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  )
}
