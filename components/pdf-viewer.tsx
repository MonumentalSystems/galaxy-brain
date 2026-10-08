"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, FileText, Loader2, ZoomIn, ZoomOut } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { TextQuoteSelector } from "@/lib/document-anchor.js"
import { normalizeTextAnchor } from "@/lib/paper-anchors"
import { projectExactTextQuote } from "@/lib/paper-reader.js"
import { pdfDocumentSource } from "@/lib/pdf-document-source"
import { loadPdfJs } from "@/lib/pdfjs-browser.js"

type PDFViewerProps = {
  /** PDF data as a remote URL, base64 data URL, or ArrayBuffer. */
  data: string | ArrayBuffer
  className?: string
  textHighlights?: PDFTextHighlight[]
  exactTextHighlights?: PDFExactTextHighlight[]
  inkStrokes?: PDFInkStroke[]
  regionHighlights?: PDFRegionHighlight[]
  inkMode?: boolean
  regionMode?: boolean
  inkColor?: string
  /** Controlled, one-based page. Omit to let the viewer own page navigation. */
  page?: number
  /** Initial one-based page for an uncontrolled viewer. */
  defaultPage?: number
  onPageChange?: (page: number) => void
  onTextSelection?: (selection: PDFTextSelection, at: PDFSelectionPoint) => void
  onInkStroke?: (stroke: Omit<PDFInkStroke, "id" | "color">, at: PDFSelectionPoint) => void
  onRegionSelection?: (region: PDFRegionSelection, at: PDFSelectionPoint) => void
}

export type PDFTextSelection = {
  pageNumber: number
  quote: string
  startOffset: number
  endOffset: number
}

/** Viewport point a selection was made at, for anchoring its actions. */
export type PDFSelectionPoint = { x: number; y: number }

export type PDFTextHighlight = PDFTextSelection & { id: string; color: string }

export type PDFExactTextHighlight = {
  id: string
  selector: TextQuoteSelector
  color: string
}

export type PDFInkStroke = {
  id: string
  pageNumber: number
  points: Array<{ x: number; y: number }>
  width: number
  color: string
}

export type PDFRegionSelection = {
  pageNumber: number
  x: number
  y: number
  width: number
  height: number
}

export type PDFRegionHighlight = PDFRegionSelection & { id: string; color: string }

type PageInfo = {
  pageNumber: number
  textContent: string
}

export function PDFViewer({
  data,
  className = "",
  textHighlights = [],
  exactTextHighlights = [],
  inkStrokes = [],
  regionHighlights = [],
  inkMode = false,
  regionMode = false,
  inkColor = "#f97316",
  page,
  defaultPage = 1,
  onPageChange,
  onTextSelection,
  onInkStroke,
  onRegionSelection,
}: PDFViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const inkLayerRef = useRef<SVGSVGElement>(null)
  const [numPages, setNumPages] = useState(0)
  const [uncontrolledPage, setUncontrolledPage] = useState(() => Math.max(1, Math.trunc(defaultPage)))
  const [scale, setScale] = useState(1.2)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pdfDoc, setPdfDoc] = useState<any>(null)
  const [extractedText, setExtractedText] = useState<PageInfo[]>([])
  const [showText, setShowText] = useState(false)
  const [draftStroke, setDraftStroke] = useState<Array<{ x: number; y: number }>>([])
  const [draftRegion, setDraftRegion] = useState<{
    start: { x: number; y: number }
    end: { x: number; y: number }
  } | null>(null)

  useEffect(() => {
    if (inkMode || regionMode) setShowText(false)
    setDraftStroke([])
    setDraftRegion(null)
  }, [inkMode, regionMode])

  // Load PDF document
  useEffect(() => {
    let cancelled = false

    async function loadPDF() {
      setLoading(true)
      setError(null)

      try {
        const pdfjsLib = await loadPdfJs()

        const doc = await pdfjsLib.getDocument(pdfDocumentSource(data)).promise
        if (cancelled) return

        setPdfDoc(doc)
        setNumPages(doc.numPages)
        setUncontrolledPage((current) => Math.min(doc.numPages, Math.max(1, current)))

        // Extract text from all pages
        const pages: PageInfo[] = []
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i)
          const textContent = await page.getTextContent()
          const text = textContent.items
            .map((item: any) => item.str)
            .join(" ")
          pages.push({ pageNumber: i, textContent: text })
        }
        if (!cancelled) setExtractedText(pages)
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to load PDF:", err)
          setError("Failed to load PDF. The file may be corrupted or unsupported.")
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadPDF()
    return () => { cancelled = true }
  }, [data])

  const currentPage = Math.min(
    Math.max(1, numPages || 1),
    Math.max(1, Math.trunc(page ?? uncontrolledPage)),
  )

  const changePage = useCallback((nextPage: number) => {
    const bounded = Math.min(Math.max(1, numPages || 1), Math.max(1, Math.trunc(nextPage)))
    if (page === undefined) setUncontrolledPage(bounded)
    onPageChange?.(bounded)
  }, [numPages, onPageChange, page])

  // Render current page to canvas
  useEffect(() => {
    // Loading and text mode unmount the canvas. Render when it mounts again.
    if (loading || showText || !pdfDoc || !canvasRef.current) return
    const canvas = canvasRef.current
    let cancelled = false
    let renderTask: { promise: Promise<void>; cancel: () => void } | undefined

    async function renderPage() {
      try {
        const page = await pdfDoc.getPage(currentPage)
        if (cancelled) return
        const viewport = page.getViewport({ scale })
        const context = canvas.getContext("2d")!

        canvas.height = viewport.height
        canvas.width = viewport.width

        const task = page.render({ canvasContext: context, viewport })
        renderTask = task
        await task.promise
      } catch (err) {
        if (!cancelled) console.error("Failed to render page:", err)
      }
    }
    void renderPage()
    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [pdfDoc, currentPage, scale, loading, showText])

  const currentInk = useMemo(
    () => inkStrokes.filter((stroke) => stroke.pageNumber === currentPage),
    [currentPage, inkStrokes],
  )

  const currentRegions = useMemo(
    () => regionHighlights.filter((region) => region.pageNumber === currentPage),
    [currentPage, regionHighlights],
  )

  const projectedTextHighlights = useMemo<PDFTextHighlight[]>(() => exactTextHighlights.flatMap((highlight) => {
    const projected = projectExactTextQuote(extractedText, highlight.selector)
    return projected ? [{ ...projected, id: highlight.id, color: highlight.color }] : []
  }), [exactTextHighlights, extractedText])

  const selectionForPage = useCallback((page: PageInfo, element: HTMLParagraphElement) => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return
    const range = selection.getRangeAt(0)
    if (!element.contains(range.commonAncestorContainer)) return
    const prefix = range.cloneRange()
    prefix.selectNodeContents(element)
    prefix.setEnd(range.startContainer, range.startOffset)
    const anchor = normalizeTextAnchor(range.toString(), prefix.toString().length)
    if (!anchor) return
    const rect = range.getBoundingClientRect()
    onTextSelection?.(
      { pageNumber: page.pageNumber, ...anchor },
      { x: rect.left + rect.width / 2, y: rect.bottom },
    )
  }, [onTextSelection])

  const inkPoint = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    const bounds = inkLayerRef.current?.getBoundingClientRect()
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    }
  }, [])

  const normalizedRegion = useMemo(() => {
    if (!draftRegion) return null
    const x = Math.min(draftRegion.start.x, draftRegion.end.x)
    const y = Math.min(draftRegion.start.y, draftRegion.end.y)
    return {
      x,
      y,
      width: Math.abs(draftRegion.end.x - draftRegion.start.x),
      height: Math.abs(draftRegion.end.y - draftRegion.start.y),
    }
  }, [draftRegion])

  const finishInk = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (draftStroke.length >= 2) {
      onInkStroke?.(
        { pageNumber: currentPage, points: draftStroke, width: 3 },
        { x: event.clientX, y: event.clientY },
      )
    }
    setDraftStroke([])
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }, [currentPage, draftStroke, onInkStroke])

  const finishRegion = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (normalizedRegion && normalizedRegion.width >= 0.01 && normalizedRegion.height >= 0.01) {
      onRegionSelection?.(
        { pageNumber: currentPage, ...normalizedRegion },
        { x: event.clientX, y: event.clientY },
      )
    }
    setDraftRegion(null)
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }, [currentPage, normalizedRegion, onRegionSelection])

  if (loading) {
    return (
      <div className={`flex items-center justify-center p-8 ${className}`}>
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <span className="ml-3 text-muted-foreground">Loading PDF...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className={`flex flex-col items-center justify-center p-8 text-center ${className}`}>
        <FileText className="h-12 w-12 text-muted-foreground mb-3" />
        <p className="text-sm text-destructive">{error}</p>
      </div>
    )
  }

  return (
    <div className={`flex flex-col ${className}`}>
      {/* Toolbar */}
      <div className="flex items-center justify-between p-2 border-b bg-muted/30">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => changePage(currentPage - 1)}
            disabled={currentPage <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm tabular-nums px-2">
            {currentPage} / {numPages}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => changePage(currentPage + 1)}
            disabled={currentPage >= numPages}
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setScale((s) => Math.max(0.5, s - 0.2))}
            aria-label="Zoom out"
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <span className="text-sm tabular-nums w-12 text-center">
            {Math.round(scale * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setScale((s) => Math.min(3, s + 0.2))}
            aria-label="Zoom in"
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="ml-2 text-xs"
            onClick={() => setShowText(!showText)}
          >
            {showText ? "Canvas" : "Text"}
          </Button>
          {regionMode && !showText && (
            <Button
              variant="outline"
              size="sm"
              className="ml-2 text-xs"
              onClick={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect()
                onRegionSelection?.(
                  { pageNumber: currentPage, x: 0, y: 0, width: 1, height: 1 },
                  { x: bounds.left + bounds.width / 2, y: bounds.bottom },
                )
              }}
            >
              Select page
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4 flex justify-center">
        {showText ? (
          <div className="max-w-2xl w-full space-y-4">
            {extractedText.map((page) => (
              <div key={page.pageNumber}>
                <h4 className="text-xs font-medium text-muted-foreground mb-1">
                  Page {page.pageNumber}
                </h4>
                <p
                  className="text-sm leading-relaxed whitespace-pre-wrap select-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  tabIndex={0}
                  onMouseUp={(event) => selectionForPage(page, event.currentTarget)}
                  onKeyUp={(event) => selectionForPage(page, event.currentTarget)}
                >
                  <HighlightedText
                    text={page.textContent || "(No text content on this page)"}
                    highlights={[...textHighlights, ...projectedTextHighlights].filter((highlight) => highlight.pageNumber === page.pageNumber)}
                  />
                </p>
              </div>
            ))}
          </div>
        ) : (
          <div className="relative max-w-full shadow-md">
            <canvas
              ref={canvasRef}
              className="block max-w-full"
              style={{ height: "auto" }}
            />
            <svg
              ref={inkLayerRef}
              viewBox="0 0 1000 1000"
              preserveAspectRatio="none"
              className={`absolute inset-0 h-full w-full ${(inkMode || regionMode) ? "cursor-crosshair touch-none" : "pointer-events-none"}`}
              aria-label={inkMode ? "Ink annotation layer" : regionMode ? "Region selection layer" : undefined}
              onPointerDown={(event) => {
                if (!inkMode && !regionMode) return
                const point = inkPoint(event)
                if (!point) return
                event.currentTarget.setPointerCapture(event.pointerId)
                if (inkMode) setDraftStroke([point])
                if (regionMode) setDraftRegion({ start: point, end: point })
              }}
              onPointerMove={(event) => {
                if ((!inkMode && !regionMode) || !event.currentTarget.hasPointerCapture(event.pointerId)) return
                const point = inkPoint(event)
                if (!point) return
                if (inkMode) setDraftStroke((points) => [...points.slice(-4_095), point])
                if (regionMode) setDraftRegion((region) => region ? { ...region, end: point } : null)
              }}
              onPointerUp={inkMode ? finishInk : finishRegion}
              onPointerCancel={(event) => {
                setDraftStroke([])
                setDraftRegion(null)
                event.currentTarget.releasePointerCapture?.(event.pointerId)
              }}
            >
              {currentRegions.map((region) => (
                <rect
                  key={region.id}
                  x={region.x * 1000}
                  y={region.y * 1000}
                  width={region.width * 1000}
                  height={region.height * 1000}
                  fill={`${region.color}22`}
                  stroke={region.color}
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {currentInk.map((stroke) => (
                <polyline
                  key={stroke.id}
                  points={stroke.points.map((point) => `${point.x * 1000},${point.y * 1000}`).join(" ")}
                  fill="none"
                  stroke={stroke.color}
                  strokeWidth={stroke.width * 2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {draftStroke.length > 0 && (
                <polyline
                  points={draftStroke.map((point) => `${point.x * 1000},${point.y * 1000}`).join(" ")}
                  fill="none"
                  stroke={inkColor}
                  strokeWidth={6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {normalizedRegion && (
                <rect
                  x={normalizedRegion.x * 1000}
                  y={normalizedRegion.y * 1000}
                  width={normalizedRegion.width * 1000}
                  height={normalizedRegion.height * 1000}
                  fill={`${inkColor}22`}
                  stroke={inkColor}
                  strokeWidth={2}
                  strokeDasharray="8 6"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
          </div>
        )}
      </div>
    </div>
  )
}

function HighlightedText({ text, highlights }: { text: string; highlights: PDFTextHighlight[] }) {
  const normalized = highlights
    .map((highlight) => ({
      ...highlight,
      startOffset: Math.max(0, Math.min(text.length, highlight.startOffset)),
      endOffset: Math.max(0, Math.min(text.length, highlight.endOffset)),
    }))
    .filter((highlight) => highlight.endOffset > highlight.startOffset)
    .sort((left, right) => left.startOffset - right.startOffset)
  const pieces: React.ReactNode[] = []
  let cursor = 0
  for (const highlight of normalized) {
    if (highlight.startOffset < cursor) continue
    pieces.push(text.slice(cursor, highlight.startOffset))
    pieces.push(
      <mark key={highlight.id} style={{ backgroundColor: highlight.color }} className="rounded-sm px-0.5 text-inherit">
        {text.slice(highlight.startOffset, highlight.endOffset)}
      </mark>,
    )
    cursor = highlight.endOffset
  }
  pieces.push(text.slice(cursor))
  return <>{pieces}</>
}

/**
 * Extract all text from a PDF file. Useful for indexing PDF content
 * into the knowledge base without rendering.
 */
export async function extractPDFText(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer()
  const pdfjsLib = await loadPdfJs()

  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise
  const pages: string[] = []

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const textContent = await page.getTextContent()
    const text = textContent.items.map((item: any) => item.str).join(" ")
    pages.push(text)
  }

  return pages.join("\n\n")
}
