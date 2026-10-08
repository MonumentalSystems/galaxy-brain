"use client"

import { Pencil, Redo2, Save, Trash2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type { DurableDocumentImport } from "@/lib/durable-document-import.js"
import {
  INK_CANVAS_HEIGHT,
  INK_CANVAS_WIDTH,
  MAX_INK_POINTS,
  MAX_INK_STROKES,
  serializeInkDocument,
  type InkPoint,
  type InkStroke,
} from "@/lib/ink-document.js"

export type InkDrawingPhase = "idle" | "importing" | "placing"

export type InkDrawingDialogProps = {
  open: boolean
  phase: InkDrawingPhase
  error: string
  imported: DurableDocumentImport | null
  ambiguous: boolean
  onOpenChange: (open: boolean) => void
  onSave: (file: File, title: string) => void
  onRetryPlacement: () => void
  onEdit: () => void
  returnFocus: HTMLElement | null
}

const COLORS = ["#1e2a24", "#315f49", "#4e5a8c", "#b66238", "#c79a4b"] as const

function path(stroke: InkStroke) {
  return stroke.points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" ")
}

export function InkDrawingDialog({
  open,
  phase,
  error,
  imported,
  ambiguous,
  onOpenChange,
  onSave,
  onRetryPlacement,
  onEdit,
  returnFocus,
}: InkDrawingDialogProps) {
  const [title, setTitle] = useState("Untitled ink note")
  const [strokes, setStrokes] = useState<InkStroke[]>([])
  const [current, setCurrent] = useState<InkStroke | null>(null)
  const [color, setColor] = useState<(typeof COLORS)[number]>(COLORS[0])
  const [width, setWidth] = useState(4)
  const [localError, setLocalError] = useState("")
  const titleRef = useRef<HTMLInputElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const busy = phase !== "idle"
  const pointCount = useMemo(
    () => strokes.reduce((total, stroke) => total + stroke.points.length, 0) + (current?.points.length ?? 0),
    [current, strokes],
  )

  useEffect(() => {
    if (open) return
    setTitle("Untitled ink note")
    setStrokes([])
    setCurrent(null)
    setColor(COLORS[0])
    setWidth(4)
    setLocalError("")
  }, [open])

  function point(event: PointerEvent<SVGSVGElement>): InkPoint | null {
    const svg = svgRef.current
    if (!svg) return null
    const rect = svg.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return {
      x: Math.max(0, Math.min(INK_CANVAS_WIDTH, ((event.clientX - rect.left) / rect.width) * INK_CANVAS_WIDTH)),
      y: Math.max(0, Math.min(INK_CANVAS_HEIGHT, ((event.clientY - rect.top) / rect.height) * INK_CANVAS_HEIGHT)),
    }
  }

  function begin(event: PointerEvent<SVGSVGElement>) {
    if (busy || imported || ambiguous || strokes.length >= MAX_INK_STROKES || pointCount >= MAX_INK_POINTS) return
    const first = point(event)
    if (!first) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setCurrent({ points: [first], color, width, opacity: 1 })
    setLocalError("")
    onEdit()
  }

  function continueStroke(event: PointerEvent<SVGSVGElement>) {
    if (!current || pointCount >= MAX_INK_POINTS) return
    const next = point(event)
    if (!next) return
    const previous = current.points[current.points.length - 1]
    if (Math.hypot(next.x - previous.x, next.y - previous.y) < 1.5) return
    setCurrent({ ...current, points: [...current.points, next] })
  }

  function finish(event: PointerEvent<SVGSVGElement>) {
    if (!current) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (current.points.length >= 2) setStrokes((value) => [...value, current])
    setCurrent(null)
  }

  function save() {
    if (busy) return
    if (imported) {
      onRetryPlacement()
      return
    }
    const normalizedTitle = title.trim()
    if (!normalizedTitle || Array.from(normalizedTitle).length > 240 || /[\u0000-\u001f\u007f-\u009f]/u.test(normalizedTitle)) {
      setLocalError("Enter a title between 1 and 240 characters.")
      titleRef.current?.focus()
      return
    }
    if (strokes.length < 1) {
      setLocalError("Draw at least one stroke before saving.")
      return
    }
    try {
      const document = serializeInkDocument(strokes)
      onSave(new File([document], "atlas-ink.json", { type: "application/json" }), normalizedTitle)
    } catch {
      setLocalError("This drawing is too large to preserve. Undo a few strokes and try again.")
    }
  }

  const status = phase === "importing"
    ? "Preserving the exact stroke document as an immutable revision."
    : phase === "placing"
      ? "The ink revision is durable. Placing its exact reference on this Atlas."
      : ""

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy && !ambiguous) onOpenChange(next) }}>
      <DialogContent
        className="flex h-[min(92dvh,820px)] max-w-[min(96vw,1100px)] flex-col overflow-hidden p-0"
        closeDisabled={busy || ambiguous}
        onOpenAutoFocus={(event) => { event.preventDefault(); titleRef.current?.focus() }}
        onCloseAutoFocus={(event) => {
          if (!returnFocus?.isConnected) return
          event.preventDefault()
          returnFocus.focus()
        }}
        onEscapeKeyDown={(event) => { if (busy || ambiguous) event.preventDefault() }}
        onPointerDownOutside={(event) => { if (busy || ambiguous) event.preventDefault() }}
      >
        <DialogHeader className="border-b border-[#355f49]/20 bg-[#f6f1e6] px-5 py-4 text-left">
          <DialogTitle className="research-display flex items-center gap-2 text-2xl">
            <Pencil className="h-5 w-5" aria-hidden="true" /> Ink note
          </DialogTitle>
          <DialogDescription>
            Draw one bounded note. Galaxy preserves its exact stroke data as a versioned document and stores only its reference and geometry on Atlas.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 border-b border-[#355f49]/15 bg-[#fffdf7] p-4 md:grid-cols-[1fr_auto_auto] md:items-end">
          <div className="grid gap-1.5">
            <label htmlFor="atlas-ink-title" className="text-sm font-semibold">Title</label>
            <Input
              ref={titleRef}
              id="atlas-ink-title"
              value={title}
              maxLength={240}
              disabled={busy || Boolean(imported) || ambiguous}
              onChange={(event) => { setTitle(event.target.value); setLocalError(""); onEdit() }}
            />
          </div>
          <div className="flex flex-wrap gap-1" aria-label="Ink color">
            {COLORS.map((choice) => (
              <Button
                key={choice}
                type="button"
                size="icon"
                variant={choice === color ? "secondary" : "outline"}
                disabled={busy || Boolean(imported) || ambiguous}
                aria-label={`Use ${choice} ink`}
                aria-pressed={choice === color}
                onClick={() => setColor(choice)}
              >
                <span className="h-4 w-4 rounded-full border border-black/20" style={{ backgroundColor: choice }} />
              </Button>
            ))}
          </div>
          <label className="grid min-w-36 gap-1 text-xs font-semibold">
            Stroke width {width}
            <input
              type="range"
              min="1"
              max="16"
              value={width}
              disabled={busy || Boolean(imported) || ambiguous}
              onChange={(event) => setWidth(Number(event.target.value))}
            />
          </label>
        </div>
        {imported ? (
          <div className="m-5 rounded-xl border border-[#93a48e]/45 bg-[#edf1e7] p-4 text-[#18372b]">
            <p className="font-semibold">{imported.title}</p>
            <p className="mt-1 break-all font-mono text-xs text-[#61766b]">{imported.ref}</p>
            <p className="mt-2 text-sm">The immutable ink document is safe. Retry only its Atlas placement.</p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto bg-[#d8c8a6]/20 p-4">
            <svg
              ref={svgRef}
              viewBox={`0 0 ${INK_CANVAS_WIDTH} ${INK_CANVAS_HEIGHT}`}
              role="img"
              aria-label="Ink drawing area"
              className="mx-auto aspect-video max-h-full w-full touch-none rounded-xl border border-[#355f49]/25 bg-[#fffdf7] shadow-sm"
              onPointerDown={begin}
              onPointerMove={continueStroke}
              onPointerUp={finish}
              onPointerCancel={finish}
            >
              {strokes.map((stroke, index) => (
                <path key={index} d={path(stroke)} fill="none" stroke={stroke.color} strokeWidth={stroke.width} strokeOpacity={stroke.opacity} strokeLinecap="round" strokeLinejoin="round" />
              ))}
              {current ? <path d={path(current)} fill="none" stroke={current.color} strokeWidth={current.width} strokeOpacity={current.opacity} strokeLinecap="round" strokeLinejoin="round" /> : null}
            </svg>
          </div>
        )}
        <div className="border-t border-[#355f49]/20 bg-[#f6f1e6] px-5 py-3">
          {localError ? <p role="alert" className="mb-2 text-sm text-destructive">{localError}</p> : null}
          {error ? <p role="alert" className="mb-2 text-sm text-destructive">{error}</p> : null}
          <DialogFooter className="items-center sm:justify-between">
            <span className="text-xs text-muted-foreground">{strokes.length} / {MAX_INK_STROKES} strokes · {pointCount} / {MAX_INK_POINTS} points</span>
            <div className="flex gap-2">
              <Button type="button" variant="outline" disabled={busy || Boolean(imported) || strokes.length === 0} onClick={() => { setStrokes((value) => value.slice(0, -1)); onEdit() }}>
                <Redo2 className="h-4 w-4 -scale-x-100" aria-hidden="true" /> Undo stroke
              </Button>
              <Button type="button" variant="ghost" disabled={busy || Boolean(imported) || strokes.length === 0} onClick={() => { setStrokes([]); onEdit() }}>
                <Trash2 className="h-4 w-4" aria-hidden="true" /> Clear
              </Button>
              <Button type="button" onClick={save} disabled={busy || (!imported && strokes.length === 0)}>
                <Save className="h-4 w-4" aria-hidden="true" />
                {phase === "importing" ? "Saving…" : phase === "placing" ? "Placing…" : imported ? "Retry placement" : ambiguous ? "Retry safe save" : "Save & place"}
              </Button>
            </div>
          </DialogFooter>
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{status}</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
