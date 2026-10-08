"use client"

import { memo, useEffect, useRef, useState } from "react"
import { Box, FileText, Loader2 } from "lucide-react"

import { DrawingPreview } from "@/components/drawing-preview"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { parseCells } from "@/components/notebook-view"
import { parseCanvasState } from "@/lib/drawing-render"
import { pdfDocumentSource } from "@/lib/pdf-document-source"
import { loadPdfJs } from "@/lib/pdfjs-browser.js"
import type { GalaxyNode } from "@/lib/galaxy-brain-service"

type NodePreviewProps = {
  node: GalaxyNode
  /** Writable text nodes show a "double-click to write" hint when empty. */
  isWritable?: boolean
}

/**
 * Renders the body of a canvas node card with a type-aware preview of its real
 * content: media plays, drawings/whiteboards render their strokes, notebooks
 * show their cells, code shows a snippet, PDFs show a first-page thumbnail.
 */
/*
  Dragging a card rewrites its node object on every pointer move, so an
  unmemoised preview re-rendered dozens of times a second and the image
  flickered as the browser re-read its source. Nothing a preview draws depends
  on where the card is, so it only re-renders when the content does.
*/
export const NodePreview = memo(NodePreviewBody, (previous, next) => (
  previous.isWritable === next.isWritable
  && previous.node.id === next.node.id
  && previous.node.type === next.node.type
  && previous.node.title === next.node.title
  && previous.node.content === next.node.content
  && previous.node.metadata === next.node.metadata
))
NodePreview.displayName = "NodePreview"

function NodePreviewBody({ node, isWritable = false }: NodePreviewProps) {
  const meta = node.metadata || {}
  const dataUrl = typeof meta.dataUrl === "string" ? meta.dataUrl : undefined

  if (node.type === "image" && dataUrl) {
    return (
      // User-imported data/blob URLs cannot use next/image's optimizer.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={dataUrl}
        alt={node.title}
        className="min-h-0 w-full flex-1 rounded object-contain bg-black/5 dark:bg-white/5"
      />
    )
  }

  if (node.type === "video" && dataUrl) {
    return <video src={dataUrl} controls className="min-h-0 w-full flex-1 rounded bg-black" />
  }

  if (node.type === "audio" && dataUrl) {
    return <audio src={dataUrl} controls className="w-full" />
  }

  if (node.type === "drawing" || node.type === "whiteboard") {
    return <DrawingPreview content={node.content} showGrid={node.type === "whiteboard"} />
  }

  if (node.type === "jupyter") {
    return <NotebookPreview content={node.content} />
  }

  if (node.type === "code") {
    return <CodePreview content={node.content} />
  }

  if (node.type === "3d") {
    return <ThreeDPlaceholder title={node.title} fileName={typeof meta.fileName === "string" ? meta.fileName : undefined} />
  }

  if (meta.isPDF && typeof meta.pdfDataUrl === "string") {
    return <PdfThumbnail data={meta.pdfDataUrl} fallbackText={node.content} />
  }

  return (
    <div className="min-h-0 flex-1 overflow-hidden text-xs text-gray-600 dark:text-gray-400">
      {node.content ? (
        <MarkdownRenderer
          content={node.content}
          images="omit"
          className="text-xs [&_h1]:!my-1 [&_h1]:!text-base [&_h2]:!my-1 [&_h2]:!text-sm [&_h3]:!my-1 [&_h3]:!text-xs [&_p]:!my-1 [&_p]:!leading-snug"
        />
      ) : isWritable ? "Double-click to write on the canvas…" : null}
    </div>
  )
}

function NotebookPreview({ content }: { content: string }) {
  const cells = parseCells(content || "")
  return (
    <div className="min-h-0 flex-1 space-y-1 overflow-hidden">
      {cells.slice(0, 4).map((cell) => (
        <div key={cell.id} className="rounded border border-gray-200 bg-gray-50 px-1.5 py-1 dark:border-gray-700 dark:bg-gray-900/60">
          <span
            className={`mr-1 rounded px-1 text-[9px] font-medium uppercase ${
              cell.type === "code"
                ? "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-200"
                : "bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-200"
            }`}
          >
            {cell.type}
          </span>
          {cell.type === "markdown" ? (
            <MarkdownRenderer
              content={(cell.content || "(empty)").split("\n")[0].slice(0, 200)}
              images="omit"
              className="inline-block max-w-full align-middle text-[10px] text-gray-600 dark:text-gray-300 [&_p]:!m-0 [&_p]:!inline [&_p]:!text-[10px]"
            />
          ) : (
            <span className="text-[10px] text-gray-600 dark:text-gray-300">
              {(cell.content || "(empty)").split("\n")[0].slice(0, 60)}
            </span>
          )}
        </div>
      ))}
      {cells.length > 4 && (
        <div className="text-[10px] text-gray-400">+{cells.length - 4} more cell{cells.length - 4 === 1 ? "" : "s"}</div>
      )}
    </div>
  )
}

function CodePreview({ content }: { content: string }) {
  const snippet = (content || "").split("\n").slice(0, 14).join("\n")
  return (
    <pre className="min-h-0 flex-1 overflow-hidden whitespace-pre-wrap rounded bg-slate-950/90 p-2 font-mono text-[10px] leading-snug text-slate-100">
      {snippet || "// empty"}
    </pre>
  )
}

function ThreeDPlaceholder({ title, fileName }: { title: string; fileName?: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 rounded bg-gradient-to-br from-indigo-50 to-purple-50 text-center text-gray-500 dark:from-indigo-950/40 dark:to-purple-950/40 dark:text-gray-400">
      <Box className="h-7 w-7 text-indigo-400" />
      <span className="px-2 text-[11px] font-medium">3D model</span>
      <span className="max-w-full truncate px-2 text-[10px] text-gray-400">{fileName || title}</span>
    </div>
  )
}

function PdfThumbnail({ data, fallbackText }: { data: string; fallbackText?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const pdfjs = await loadPdfJs()
        const doc = await pdfjs.getDocument(pdfDocumentSource(data)).promise
        const page = await doc.getPage(1)
        if (cancelled) return

        const canvas = canvasRef.current
        if (!canvas) return
        const targetWidth = 280
        const baseViewport = page.getViewport({ scale: 1 })
        const scale = targetWidth / baseViewport.width
        const viewport = page.getViewport({ scale })
        canvas.width = viewport.width
        canvas.height = viewport.height
        const ctx = canvas.getContext("2d")
        if (!ctx) return
        await page.render({ canvasContext: ctx, viewport }).promise
        if (!cancelled) setStatus("ready")
      } catch {
        if (!cancelled) setStatus("error")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [data])

  if (status === "error") {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-hidden">
        <div className="flex items-center gap-1 text-[11px] text-gray-500">
          <FileText className="h-3.5 w-3.5" /> PDF
        </div>
        {fallbackText ? (
          <p className="min-h-0 flex-1 overflow-hidden whitespace-pre-wrap text-xs text-gray-600 dark:text-gray-400">
            {fallbackText}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 justify-center overflow-hidden rounded bg-gray-100 dark:bg-gray-900/60">
      <canvas ref={canvasRef} className="max-w-full object-contain" style={{ height: "auto" }} />
      {status === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
        </div>
      )}
    </div>
  )
}

/** Short, human-readable description of a node's content for list/grid views. */
export function summarizeNodeContent(node: GalaxyNode): string {
  switch (node.type) {
    case "drawing":
    case "whiteboard": {
      const state = parseCanvasState(node.content)
      const count = state?.elements.length ?? 0
      const label = node.type === "whiteboard" ? "Whiteboard" : "Drawing"
      return count ? `${label} · ${count} element${count === 1 ? "" : "s"}` : `Empty ${label.toLowerCase()}`
    }
    case "jupyter": {
      const cells = parseCells(node.content || "")
      return `Notebook · ${cells.length} cell${cells.length === 1 ? "" : "s"}`
    }
    case "image":
      return typeof node.metadata?.fileName === "string" ? `Image · ${node.metadata.fileName}` : "Image"
    case "video":
      return typeof node.metadata?.fileName === "string" ? `Video · ${node.metadata.fileName}` : "Video"
    case "audio":
      return typeof node.metadata?.fileName === "string" ? `Audio · ${node.metadata.fileName}` : "Audio"
    case "3d":
      return typeof node.metadata?.fileName === "string" ? `3D model · ${node.metadata.fileName}` : "3D model"
    default:
      return node.content
  }
}
