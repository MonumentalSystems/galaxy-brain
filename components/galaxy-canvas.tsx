"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { History, Minus, Plus, RotateCcw, Share2, Sparkles, Tags } from 'lucide-react'

import { RevisionHistoryPanel } from "@/components/revision-history-panel"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/use-toast"
import { NodePreview } from "@/components/node-preview"
import { galaxyBrainAPI } from "@/lib/galaxy-brain-api"
import { type GalaxyNode, galaxyBrainService } from "@/lib/galaxy-brain-service"
import { safeNavigator } from "@/lib/browser-utils"
import { contentProcessingService } from "@/lib/content-processing-service"
import { canConvert, convertFile } from "@/lib/markitdown-service"
import { pointOnCanvas, zoomCanvasAt } from "@/lib/canvas-viewport"
import { filterNodesForWorkspace } from "@/lib/workspace-node-scope"
import type { CanvasComponentMetadata } from "@/lib/types/canvas-components"

interface GalaxyCanvasProps {
  workspaceId: string
  workspaceRootFolderId: string
  onNodeSelect: (node: GalaxyNode | null) => void
  onNodeOpen?: (node: GalaxyNode) => void
  selectedNodeId?: string
  selectedNodeUpdatedAt?: number
  /**
   * Incremented by the toolbar to ask for a new note. The canvas owns pan and
   * zoom, so it -- not the caller -- decides where "here" is.
   */
  newNoteRequestId?: number
  handledNoteRequestId?: number
  onNewNoteRequestHandled?: (requestId: number) => void
}

function estimateWritableNodeHeight(title: string, content: string): number {
  const titleLines = Math.max(1, Math.ceil(Math.max(title.length, 12) / 28))
  const contentLines = Math.max(4, content.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(Math.max(line.length, 1) / 34)), 0))
  return Math.min(520, Math.max(220, 72 + titleLines * 20 + contentLines * 18))
}

function estimateSummary(content: string): string {
  const cleaned = content.replace(/\s+/g, " ").trim()
  if (!cleaned) return ""
  return cleaned.length > 220 ? `${cleaned.slice(0, 217)}...` : cleaned
}

function estimateTags(title: string, content: string): string[] {
  const text = `${title} ${content}`.toLowerCase()
  const words = text.match(/[a-z0-9-]{4,}/g) || []
  const stop = new Set(["this", "that", "with", "from", "have", "there", "their", "about", "would", "could", "should", "into", "what", "when", "where", "which", "through", "these", "those", "untitled", "note", "document", "summary"])
  const counts = new Map<string, number>()
  for (const word of words) {
    if (stop.has(word)) continue
    counts.set(word, (counts.get(word) || 0) + 1)
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 5)
    .map(([word]) => word)
}

function getCanvasComponentMetadata(node: GalaxyNode): CanvasComponentMetadata | null {
  if (!node.metadata?.componentType || !node.metadata?.shareTargetId || node.metadata?.shareTargetType !== "component") {
    return null
  }
  return {
    componentType: String(node.metadata.componentType) as CanvasComponentMetadata["componentType"],
    shareTargetId: String(node.metadata.shareTargetId),
    shareTargetType: "component",
  }
}

export function GalaxyCanvas({
  workspaceId,
  workspaceRootFolderId,
  onNodeSelect,
  onNodeOpen,
  selectedNodeId,
  selectedNodeUpdatedAt,
  newNoteRequestId,
  handledNoteRequestId = 0,
  onNewNoteRequestHandled,
}: GalaxyCanvasProps) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const [nodes, setNodes] = useState<GalaxyNode[]>([])
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [draggedNode, setDraggedNode] = useState<string | null>(null)
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState("")
  const [draftContent, setDraftContent] = useState("")
  const [historyNodeId, setHistoryNodeId] = useState<string | null>(null)

  const syncWorkspaceNodes = useCallback(() => {
    const allNodes = galaxyBrainService.getNodes()
    const scopedIds = new Set(filterNodesForWorkspace(allNodes, workspaceRootFolderId).map((node) => node.id))
    const workspaceNodes = allNodes.filter((node) =>
      node.type !== "folder" && (scopedIds.has(node.id) || node.parentId === workspaceId),
    )
    setNodes(workspaceNodes)
  }, [workspaceId, workspaceRootFolderId])

  // Load and resync nodes when the active selection changes outside the canvas.
  useEffect(() => {
    syncWorkspaceNodes()
  }, [selectedNodeId, selectedNodeUpdatedAt, syncWorkspaceNodes])

  const selectedNode = selectedNodeId ? nodes.find((node) => node.id === selectedNodeId) || null : null

  useEffect(() => {
    if (!selectedNodeId || historyNodeId === selectedNodeId) return
    setHistoryNodeId(null)
  }, [historyNodeId, selectedNodeId])

  // Capture the pointer at the viewport, not the transformed world, so a drag
  // remains continuous when it crosses a note or leaves its visual footprint.
  const handlePointerDown = useCallback((e: React.PointerEvent, nodeId?: string) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest("button, input, textarea, video, audio, a, [contenteditable]")) return
    canvasRef.current?.setPointerCapture(e.pointerId)
    if (nodeId) {
      setDraggedNode(nodeId)
      const node = nodes.find(n => n.id === nodeId)
      if (node) {
        onNodeSelect(node)
      }
    } else {
      setIsDragging(true)
      onNodeSelect(null)
    }
    setDragStart({ x: e.clientX, y: e.clientY })
  }, [nodes, onNodeSelect])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (isDragging) {
      const deltaX = e.clientX - dragStart.x
      const deltaY = e.clientY - dragStart.y
      setPan(prev => ({ x: prev.x + deltaX, y: prev.y + deltaY }))
      setDragStart({ x: e.clientX, y: e.clientY })
    } else if (draggedNode) {
      const deltaX = (e.clientX - dragStart.x) / zoom
      const deltaY = (e.clientY - dragStart.y) / zoom
      
      setNodes(prev => prev.map(node => 
        node.id === draggedNode 
          ? { ...node, position: { x: node.position.x + deltaX, y: node.position.y + deltaY } }
          : node
      ))
      setDragStart({ x: e.clientX, y: e.clientY })
    }
  }, [isDragging, draggedNode, dragStart, zoom])

  const isWritableNode = useCallback((node: GalaxyNode) => {
    return ["note", "document", "prompt", "canvas-note"].includes(node.type)
  }, [])

  const startInlineEdit = useCallback((node: GalaxyNode) => {
    if (!isWritableNode(node)) return
    setEditingNodeId(node.id)
    setDraftTitle(node.title)
    setDraftContent(node.content)
    onNodeSelect(node)
  }, [isWritableNode, onNodeSelect])

  const commitInlineEdit = useCallback(() => {
    if (!editingNodeId) return
    const nextTitle = draftTitle.trim() || "Untitled Note"
    const nextHeight = estimateWritableNodeHeight(nextTitle, draftContent)
    const updated = galaxyBrainService.updateNode(editingNodeId, {
      title: nextTitle,
      content: draftContent,
      size: { ...(nodes.find((node) => node.id === editingNodeId)?.size || { width: 340, height: 240 }), height: nextHeight },
    })
    if (updated) {
      setNodes(prev => prev.map((node) => (
        node.id === editingNodeId ? updated : node
      )))
      onNodeSelect(updated)
    }
    setEditingNodeId(null)
  }, [draftContent, draftTitle, editingNodeId, nodes, onNodeSelect])

  const cancelInlineEdit = useCallback(() => {
    setEditingNodeId(null)
  }, [])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (draggedNode) {
      const node = nodes.find(n => n.id === draggedNode)
      if (node) {
        galaxyBrainService.updateNode(node.id, { position: node.position })
      }
    }
    setIsDragging(false)
    setDraggedNode(null)
    if (canvasRef.current?.hasPointerCapture(e.pointerId)) {
      canvasRef.current.releasePointerCapture(e.pointerId)
    }
  }, [draggedNode, nodes])

  // Handle file drop
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return

    const readText = (f: File): Promise<string> =>
      new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "")
        reader.onerror = () => reject(reader.error)
        reader.readAsText(f)
      })

    const readDataUrl = (f: File): Promise<string> =>
      new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "")
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(f)
      })

    type Kind = "image" | "video" | "audio" | "pdf" | "markdown" | "text" | "convertible" | "binary"
    const detectKind = (f: File): Kind => {
      const name = f.name.toLowerCase()
      if (f.type.startsWith("image/")) return "image"
      if (f.type.startsWith("video/")) return "video"
      if (f.type.startsWith("audio/")) return "audio"
      if (f.type === "application/pdf" || name.endsWith(".pdf")) return "pdf"
      if (/\.(md|markdown)$/.test(name)) return "markdown"
      if (f.type.startsWith("text/") ||
          /\.(txt|csv|log|xml|svg|json|yaml|yml|toml|css|html?|tsx?|jsx?|py|rs|go|java|c|cpp|h|rb|php|sh|sql)$/.test(name)) {
        return "text"
      }
      if (canConvert(f.name)) return "convertible"
      return "binary"
    }

    for (const [index, file] of files.entries()) {
      const point = pointOnCanvas(e.clientX, e.clientY, rect, pan, zoom)
      const x = point.x
      const y = point.y + (index * 50)
      const kind = detectKind(file)

      let nodeType = "document"
      let category: "ai" | "document" | "media" | "speech" | "knowledge" = "knowledge"
      let content = ""
      let metadata: Record<string, any> = {
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
      }
      let tags: string[] = []

      try {
        switch (kind) {
          case "image": {
            nodeType = "image"
            category = "media"
            metadata.dataUrl = await readDataUrl(file)
            tags = ["image", "visual"]
            break
          }
          case "video": {
            nodeType = "video"
            category = "media"
            metadata.dataUrl = await readDataUrl(file)
            tags = ["video", "visual", "media"]
            break
          }
          case "audio": {
            nodeType = "audio"
            category = "speech"
            metadata.dataUrl = await readDataUrl(file)
            tags = ["audio", "media"]
            break
          }
          case "pdf": {
            nodeType = "document"
            category = "document"
            metadata.pdfDataUrl = await readDataUrl(file)
            metadata.isPDF = true
            tags = ["pdf"]
            // Also extract text via MarkItDown if available
            if (canConvert(file.name)) {
              try {
                const result = await convertFile(file)
                if (result?.markdown) content = result.markdown
              } catch {}
            }
            break
          }
          case "markdown": {
            nodeType = "note"
            category = "knowledge"
            content = await readText(file)
            metadata.isMarkdown = true
            tags = ["markdown"]
            break
          }
          case "text": {
            nodeType = "note"
            category = "knowledge"
            content = await readText(file)
            break
          }
          case "convertible": {
            nodeType = "document"
            category = "document"
            const result = await convertFile(file)
            content = result?.markdown ?? ""
            if (content) metadata.isMarkdown = true
            break
          }
          case "binary": {
            nodeType = "document"
            category = "document"
            content = `[${file.type || "binary"}] ${file.name} (${file.size} bytes)`
            break
          }
        }
      } catch (err) {
        console.error("Failed to read file", file.name, err)
        toast({ title: "Couldn't read file", description: file.name, variant: "destructive" })
      }

      const newNode = galaxyBrainService.createNode(
        nodeType,
        file.name,
        content,
        category,
        workspaceRootFolderId,
        { x, y }
      )

      const updated = galaxyBrainService.updateNode(newNode.id, {
        tags,
        metadata: { ...(newNode.metadata || {}), ...metadata },
      })
      const nodeToAdd = updated ?? newNode

      setNodes(prev => [...prev, nodeToAdd])
      contentProcessingService.enqueueNode(nodeToAdd.id)
    }
  }, [pan, zoom, workspaceRootFolderId])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const handleCanvasDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget && e.target !== worldRef.current) return
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const { x, y } = pointOnCanvas(e.clientX, e.clientY, rect, pan, zoom)
    const newNode = galaxyBrainService.createCanvasNote(
      workspaceRootFolderId,
      { x, y },
      "Untitled Note",
      "",
      { width: 340, height: 220 },
    )
    setNodes(prev => [...prev, newNode])
    startInlineEdit(newNode)
  }, [pan, startInlineEdit, workspaceRootFolderId, zoom])

  // The toolbar's New Note lands on the canvas rather than opening an editor,
  // in the middle of whatever the person is currently looking at.
  const lastNoteRequest = useRef(handledNoteRequestId)
  useEffect(() => {
    if (newNoteRequestId === undefined || newNoteRequestId <= lastNoteRequest.current) return
    lastNoteRequest.current = newNoteRequestId

    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const size = { width: 340, height: 220 }
    const centre = {
      x: (rect.width / 2 - pan.x) / zoom - size.width / 2,
      y: (rect.height / 2 - pan.y) / zoom - size.height / 2,
    }

    const newNode = galaxyBrainService.createCanvasNote(
      workspaceRootFolderId,
      centre,
      "Untitled Note",
      "",
      size,
    )
    setNodes(prev => [...prev, newNode])
    startInlineEdit(newNode)
    onNewNoteRequestHandled?.(newNoteRequestId)
  }, [newNoteRequestId, onNewNoteRequestHandled, pan.x, pan.y, startInlineEdit, workspaceRootFolderId, zoom])

  const handleShareNode = useCallback(async (node: GalaxyNode) => {
    try {
      const componentMeta = getCanvasComponentMetadata(node)
      const selector = await galaxyBrainService.pinNodeRevisionForShare(node.id)
      const bundle = await galaxyBrainAPI.createShareBundle({
        schemaId: "gb.share-bundle.v1",
        mode: "object-only",
        selector,
        idempotencyKey: `share:${crypto.randomUUID()}`,
      })
      if (!bundle) throw new Error("Share bundle failed")
      const shareUrl = `${window.location.origin}/share/${bundle.id}`
      await safeNavigator().clipboard.writeText(shareUrl)
      toast({
        title: componentMeta ? "Component share link copied" : "Share link copied",
        description: shareUrl,
      })
    } catch {
      toast({ title: "Share failed", description: "Could not create a share link for this note.", variant: "destructive" })
    }
  }, [])

  const handleSummarizeNode = useCallback((node: GalaxyNode) => {
    const summary = estimateSummary(node.content)
    if (!summary) {
      toast({ title: "Nothing to summarize", description: "Write a bit more on the canvas note first.", variant: "destructive" })
      return
    }
    const updated = galaxyBrainService.updateNode(node.id, {
      metadata: { ...node.metadata, summary },
    })
    if (updated) {
      setNodes(prev => prev.map((entry) => (entry.id === node.id ? updated : entry)))
      onNodeSelect(updated)
      toast({ title: "Summary generated", description: summary })
    }
  }, [onNodeSelect])

  const handleTagNode = useCallback((node: GalaxyNode) => {
    const nextTags = Array.from(new Set([...(node.tags || []), ...estimateTags(node.title, node.content)]))
    if (nextTags.length === (node.tags || []).length) {
      toast({ title: "No new tags", description: "Try adding more specific content first." })
      return
    }
    const updated = galaxyBrainService.updateNode(node.id, { tags: nextTags })
    if (updated) {
      setNodes(prev => prev.map((entry) => (entry.id === node.id ? updated : entry)))
      onNodeSelect(updated)
      toast({ title: "Tags updated", description: nextTags.join(", ") })
    }
  }, [onNodeSelect])

  const handleRestoreRevision = useCallback((node: GalaxyNode, revisionId: string) => {
    const confirmed = window.confirm("Restore this canvas note version? Your current note contents will be replaced.")
    if (!confirmed) return
    const restored = galaxyBrainService.restoreNodeRevision(node.id, revisionId)
    if (!restored) {
      toast({ title: "Restore failed", description: "Could not restore that version.", variant: "destructive" })
      return
    }
    setNodes((prev) => prev.map((entry) => (entry.id === node.id ? restored : entry)))
    onNodeSelect(restored)
    toast({ title: "Version restored", description: `Restored ${restored.title}` })
  }, [onNodeSelect])

  const zoomAtViewportCentre = useCallback((factor: number) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const next = zoomCanvasAt(rect.left + rect.width / 2, rect.top + rect.height / 2, rect, pan, zoom, zoom * factor)
    setPan(next.pan)
    setZoom(next.zoom)
  }, [pan, zoom])

  useEffect(() => {
    const viewport = canvasRef.current
    if (!viewport) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = viewport.getBoundingClientRect()
      const next = zoomCanvasAt(event.clientX, event.clientY, rect, pan, zoom, zoom * (event.deltaY > 0 ? 0.9 : 1.1))
      setPan(next.pan)
      setZoom(next.zoom)
    }
    viewport.addEventListener("wheel", onWheel, { passive: false })
    return () => viewport.removeEventListener("wheel", onWheel)
  }, [pan, zoom])

  // Zoom controls
  const handleZoomIn = () => zoomAtViewportCentre(1.2)
  const handleZoomOut = () => zoomAtViewportCentre(1 / 1.2)
  const handleResetView = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }
  const zoomDepth = zoom < 0.5 ? "distant" : zoom < 0.85 ? "medium" : "near"

  return (
    <div className="research-canvas relative h-full w-full overflow-hidden" data-zoom-depth={zoomDepth}>
      {/* The atlas grid is fixed to the viewport; the objects live in a separate transformed world. */}
      <div 
        className="research-canvas-grid pointer-events-none absolute inset-0"
        style={{
          backgroundImage: `
            linear-gradient(hsl(var(--research-accent) / 0.10) 1px, transparent 1px),
            linear-gradient(90deg, hsl(var(--research-accent) / 0.10) 1px, transparent 1px)
          `,
          backgroundSize: `${32 * zoom}px ${32 * zoom}px`,
          backgroundPosition: `${pan.x}px ${pan.y}px`,
        }}
      />

      {/* Pan and zoom act on the world, not on the viewport or its controls. */}
      <div
        ref={canvasRef}
        className="absolute inset-0 cursor-grab touch-none active:cursor-grabbing"
        onPointerDown={(e) => handlePointerDown(e)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDoubleClick={handleCanvasDoubleClick}
      >
        <div
          ref={worldRef}
          className="absolute inset-0"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0" }}
        >
        {/* Nodes */}
        {nodes.map((node) => (
          <div
            key={node.id}
            role="button"
            tabIndex={0}
            aria-label={`${node.title} (${node.type})`}
            aria-pressed={selectedNodeId === node.id}
            data-state={selectedNodeId === node.id ? "selected" : "idle"}
            className="research-canvas-sheet absolute cursor-pointer overflow-hidden"
            style={{
              left: node.position.x,
              top: node.position.y,
              width: node.size.width,
              height: node.size.height,
            }}
            onPointerDown={(e) => {
              e.stopPropagation()
              handlePointerDown(e, node.id)
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              if (isWritableNode(node)) startInlineEdit(node)
              else onNodeOpen?.(node)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                e.stopPropagation()
                if (isWritableNode(node)) startInlineEdit(node)
                else onNodeOpen?.(node)
              } else if (e.key === " ") {
                e.preventDefault()
                e.stopPropagation()
                onNodeSelect(node)
              }
            }}
          >
            {editingNodeId === node.id ? (
              <div
                className="p-4 h-full flex flex-col gap-3"
                onPointerDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <input
                  className="w-full bg-transparent text-sm font-medium outline-none border-b border-[var(--research-line)] pb-1"
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  placeholder="Untitled Note"
                  autoFocus
                />
                <textarea
                  className="flex-1 w-full resize-none rounded-md border border-[var(--research-line)] bg-transparent p-3 text-xs text-foreground outline-none"
                  value={draftContent}
                  onChange={(e) => setDraftContent(e.target.value)}
                  placeholder="Start writing directly on the canvas..."
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault()
                      commitInlineEdit()
                    } else if (e.key === "Escape") {
                      e.preventDefault()
                      cancelInlineEdit()
                    }
                  }}
                />
                <div className="flex items-center justify-between gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                  <span>Esc to cancel • Ctrl/Cmd+Enter to save</span>
                  <Button size="sm" className="h-7" onClick={commitInlineEdit}>Save</Button>
                </div>
              </div>
            ) : zoomDepth === "distant" ? (
              <div className="flex h-full flex-col justify-center gap-1 px-4" style={{ fontSize: `${10 / zoom}px` }}>
                <span className="research-smallcaps truncate text-[0.8em]">{node.type.replaceAll("-", " ")}</span>
                <strong className="research-display truncate font-semibold leading-none">{node.title}</strong>
              </div>
            ) : (
              <div className="p-4 h-full flex flex-col">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="research-smallcaps shrink-0 text-[10px]">{node.type.replaceAll("-", " ")}</span>
                    <h3 className="research-display truncate text-base font-semibold">{node.title}</h3>
                    {getCanvasComponentMetadata(node)?.componentType === "RichText" && (
                      <span className="rounded-full bg-slate-100 dark:bg-slate-900 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:text-slate-300">
                        RichText
                      </span>
                    )}
                  </div>
                  {zoomDepth === "near" && selectedNodeId === node.id && isWritableNode(node) && (
                    <div className="flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="Summarize note"
                        aria-label="Summarize note"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleSummarizeNode(node)
                        }}
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="Auto-tag note"
                        aria-label="Auto-tag note"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleTagNode(node)
                        }}
                      >
                        <Tags className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="Version history"
                        aria-label="Version history"
                        onClick={(e) => {
                          e.stopPropagation()
                          setHistoryNodeId((current) => current === node.id ? null : node.id)
                        }}
                      >
                        <History className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="Share note"
                        aria-label="Share note"
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleShareNode(node)
                        }}
                      >
                        <Share2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
                <NodePreview node={node} isWritable={isWritableNode(node)} />
                {zoomDepth === "near" && selectedNodeId === node.id && typeof node.metadata?.summary === "string" && node.metadata.summary && (
                  <div className="mt-2 border-l-2 border-[hsl(var(--research-accent))] pl-2 text-[11px] text-foreground/75">
                    {node.metadata.summary as string}
                  </div>
                )}
                {zoomDepth === "near" && node.tags && node.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {node.tags.slice(0, 2).map((tag) => (
                      <span key={tag} className="border-b border-[var(--research-line)] px-1 py-0.5 text-xs text-foreground/75">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        </div>
      </div>

      {/* Zoom controls */}
      {historyNodeId && selectedNode && selectedNode.id === historyNodeId && isWritableNode(selectedNode) ? (
        <div className="absolute bottom-[5.75rem] left-4 z-20 w-[min(360px,calc(100%-6rem))] overflow-hidden rounded-xl border border-[var(--research-line)] bg-[hsl(var(--research-panel))] shadow-lg md:bottom-4">
          <RevisionHistoryPanel
            node={selectedNode}
            compact
            onRestore={(revisionId) => handleRestoreRevision(selectedNode, revisionId)}
          />
        </div>
      ) : null}

      <div className="absolute bottom-[5.75rem] right-4 flex flex-col gap-2 md:bottom-4">
        <Button size="icon" variant="outline" aria-label="Zoom in" title="Zoom in" onClick={handleZoomIn}>
          <Plus className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="outline" aria-label="Zoom out" title="Zoom out" onClick={handleZoomOut}>
          <Minus className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="outline" aria-label="Reset view" title="Reset view" onClick={handleResetView}>
          <RotateCcw className="h-4 w-4" />
        </Button>
      </div>

      <div className="research-canvas-caption pointer-events-none absolute left-4 top-4 max-w-[min(31rem,calc(100%-2rem))] border-l-2 pl-3">
        <span className="research-smallcaps block text-xs">Infinite research desk</span>
        <span className="block text-sm">Drop a file here · double-click to write · drag to arrange · scroll to zoom</span>
      </div>
    </div>
  )
}
