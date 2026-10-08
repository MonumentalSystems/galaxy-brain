"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronDown, ChevronRight, FileText, FolderOpen, Loader2, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Trash2, Upload } from 'lucide-react'

import { DatasourceRefreshDialog } from "@/components/datasource-refresh-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { toast } from "@/components/ui/use-toast"
import { extractPDFText } from "@/components/pdf-viewer"
import { type GalaxyNode, galaxyBrainService } from "@/lib/galaxy-brain-service"
import { contentProcessingService } from "@/lib/content-processing-service"
import {
  canRefreshDatasourceNode,
  fetchDatasourceRefreshPreview,
  refreshDatasourceNode,
  resolveDatasourceRefresh,
  type DatasourceRefreshPreview,
} from "@/lib/datasource-node-actions"
import { canConvert, convertFile } from "@/lib/markitdown-service"
import { searchHam } from "@/lib/ham-search-client"

interface GalaxyExplorerProps {
  workspaceId: string
  workspaceRootFolderId: string
  onNodeSelect: (node: GalaxyNode | null) => void
  selectedNodeId?: string
  selectedNodeUpdatedAt?: number
}

export function GalaxyExplorer({
  workspaceId,
  workspaceRootFolderId,
  onNodeSelect,
  selectedNodeId,
  selectedNodeUpdatedAt,
}: GalaxyExplorerProps) {
  const [nodes, setNodes] = useState<GalaxyNode[]>([])
  const [searchTerm, setSearchTerm] = useState("")
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [renamingNodeId, setRenamingNodeId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [hamResults, setHamResults] = useState<GalaxyNode[]>([])
  const [refreshingNodeId, setRefreshingNodeId] = useState<string | null>(null)
  const [refreshPreview, setRefreshPreview] = useState<DatasourceRefreshPreview | null>(null)
  const [resolvingStrategy, setResolvingStrategy] = useState<"overwrite" | "duplicate" | null>(null)

  const syncNodes = useCallback(() => {
    const latest = galaxyBrainService.getNodes()
      .filter((node) => !node.parentId || node.parentId === workspaceId || node.parentId === workspaceRootFolderId)
      .sort((a, b) => a.id.localeCompare(b.id))
    setNodes((prev) => {
      const prevSignature = prev
        .map((node) => `${node.id}:${node.title}:${node.updatedAt.getTime()}:${node.parentId || ""}`)
        .join("|")
      const nextSignature = latest
        .map((node) => `${node.id}:${node.title}:${node.updatedAt.getTime()}:${node.parentId || ""}`)
        .join("|")
      return prevSignature === nextSignature ? prev : latest
    })
  }, [workspaceId, workspaceRootFolderId])

  // Refresh nodes from local storage periodically (picks up nodes added by search)
  useEffect(() => {
    syncNodes()
    const interval = setInterval(syncNodes, 2000)
    return () => clearInterval(interval)
  }, [syncNodes])

  useEffect(() => {
    syncNodes()
  }, [selectedNodeId, selectedNodeUpdatedAt, syncNodes])

  // HAM search when typing in sidebar
  useEffect(() => {
    if (!searchTerm.trim() || searchTerm.length < 2) {
      setHamResults([])
      return
    }
    const timer = setTimeout(async () => {
      try {
        const results = await searchHam({ query: searchTerm, mode: "search", topK: 8 })
        // Convert HAM results to GalaxyNode format
        setHamResults(results.map((r: any) => ({
          id: `ham-${r.id}`,
          type: r.metadata?.type || "note",
          title: r.metadata?.title || r.content.substring(0, 50) + "...",
          content: r.content,
          category: "knowledge" as const,
          parentId: null,
          position: { x: 0, y: 0 },
          size: { width: 300, height: 200 },
          tags: [],
          metadata: { hamId: r.id, hamTier: r.tier, hamScore: r.score },
          createdAt: r.timestamp ? new Date(r.timestamp) : new Date(),
          updatedAt: new Date(),
        })))
      } catch (err) {
        console.error("HAM sidebar search error:", err)
      }
    }, 400)
    return () => clearTimeout(timer)
  }, [searchTerm])

  const filteredNodes = searchTerm.trim()
    ? [
        // HAM results first (semantic + BM25)
        ...hamResults,
        // Then local matches
        ...nodes.filter(node =>
          node.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
          node.content.toLowerCase().includes(searchTerm.toLowerCase())
        ).filter(n => !hamResults.some(h => h.content === n.content)),
      ]
    : nodes

  const toggleFolder = (folderId: string) => {
    setExpandedFolders(prev => {
      const newSet = new Set(prev)
      if (newSet.has(folderId)) {
        newSet.delete(folderId)
      } else {
        newSet.add(folderId)
      }
      return newSet
    })
  }

  const handleCreateFolder = () => {
    const newFolder = galaxyBrainService.createNode(
      "folder",
      "New Folder",
      "",
      "knowledge",
      workspaceRootFolderId
    )
    setNodes(prev => [...prev, newFolder])
  }

  type FileKind = "text" | "pdf" | "binary"
  const detectNodeType = (
    file: File,
  ): { type: string; category: "ai" | "document" | "media" | "speech" | "knowledge"; kind: FileKind } => {
    const name = file.name.toLowerCase()
    const mime = file.type
    if (mime === "application/pdf" || name.endsWith(".pdf")) {
      return { type: "document", category: "document", kind: "pdf" }
    }
    if (mime.startsWith("image/")) return { type: "image", category: "media", kind: "binary" }
    if (mime.startsWith("video/")) return { type: "video", category: "media", kind: "binary" }
    if (mime.startsWith("audio/")) return { type: "audio", category: "speech", kind: "binary" }
    if (/\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|rb|php|sh|sql|json|yaml|yml|toml|css|html)$/.test(name)) {
      return { type: "code", category: "knowledge", kind: "text" }
    }
    if (/\.(md|markdown|txt|csv|log|xml|svg)$/.test(name) || mime.startsWith("text/")) {
      return { type: "note", category: "knowledge", kind: "text" }
    }
    // Rich document formats — MarkItDown will convert these to markdown
    if (/\.(docx?|pptx?|xlsx?|epub|msg|eml|html?)$/.test(name)) {
      return { type: "document", category: "document", kind: "binary" }
    }
    return { type: "document", category: "document", kind: "binary" }
  }

  const readFileAsText = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "")
      reader.onerror = () => reject(reader.error)
      reader.readAsText(file)
    })

  const handleImport = () => {
    fileInputRef.current?.click()
  }

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return

    const created: GalaxyNode[] = []
    const failed: { name: string; reason: string }[] = []

    for (const file of files) {
      const { type, category, kind } = detectNodeType(file)
      let content = ""
      let extractionNote = ""

      if (kind === "pdf") {
        toast({ title: "Extracting PDF text…", description: file.name })
      }

      try {
        // Try MarkItDown first for supported formats (PDF, DOCX, PPTX, XLSX, etc.)
        if (canConvert(file.name)) {
          const mdResult = await convertFile(file)
          if (mdResult && mdResult.markdown.trim()) {
            content = mdResult.markdown
            extractionNote = `${content.length.toLocaleString()} chars via MarkItDown`
          }
        }

        // Fall back to native extraction if MarkItDown didn't handle it
        if (!content) {
          if (kind === "text") {
            content = await readFileAsText(file)
            extractionNote = `${content.length.toLocaleString()} chars`
          } else if (kind === "pdf") {
            content = await extractPDFText(file)
            if (!content.trim()) {
              extractionNote = "no extractable text (scanned/image-only?)"
              content = `[pdf] ${file.name} — ${extractionNote}`
            } else {
              extractionNote = `${content.length.toLocaleString()} chars extracted`
            }
          } else {
            content = `[${file.type || "binary"}] ${file.name} (${file.size} bytes)`
            extractionNote = "metadata only"
          }
        }
      } catch (err: any) {
        const reason = err?.message || err?.name || String(err) || "unknown error"
        console.error("[galaxy-explorer] Failed to read file", file.name, err)
        failed.push({ name: file.name, reason })
        toast({
          title: `Could not read ${file.name}`,
          description: reason,
          variant: "destructive",
        })
        continue
      }

      try {
        const node = galaxyBrainService.createNode(type, file.name, content, category, workspaceRootFolderId)
        created.push(node)
        // Enqueue for embedding + HAM ingestion
        contentProcessingService.enqueueNode(node.id)
        toast({
          title: `Imported ${file.name}`,
          description: extractionNote,
        })
      } catch (err: any) {
        console.error("Failed to save node", file.name, err)
        failed.push({ name: file.name, reason: err?.message || "save failed" })
      }
    }

    if (created.length > 0) {
      setNodes(prev => [...prev, ...created])
      onNodeSelect(created[created.length - 1])
    }
    if (failed.length > 0) {
      toast({
        title: `Failed to import ${failed.length} file${failed.length === 1 ? "" : "s"}`,
        description: failed.map(f => `${f.name}: ${f.reason}`).join("\n"),
        variant: "destructive",
      })
    }

    // Reset so selecting the same file again re-triggers onChange
    e.target.value = ""
  }

  const handleCreateNote = () => {
    const newNote = galaxyBrainService.createNode(
      "note",
      "New Note",
      "",
      "knowledge",
      workspaceRootFolderId
    )
    setNodes(prev => [...prev, newNote])
    onNodeSelect(newNote)
  }

  const startRename = (node: GalaxyNode) => {
    setRenamingNodeId(node.id)
    setRenameValue(node.title)
  }

  const commitRename = () => {
    if (!renamingNodeId) return
    const trimmed = renameValue.trim()
    if (!trimmed) {
      setRenamingNodeId(null)
      return
    }
    const updated = galaxyBrainService.updateNode(renamingNodeId, { title: trimmed })
    if (updated) {
      setNodes(prev => prev.map(n => (n.id === renamingNodeId ? { ...n, title: trimmed } : n)))
    }
    setRenamingNodeId(null)
  }

  const cancelRename = () => {
    setRenamingNodeId(null)
  }

  const handleDeleteNode = (nodeId: string) => {
    galaxyBrainService.deleteNode(nodeId)
    setNodes(prev => prev.filter(node => node.id !== nodeId))
    if (selectedNodeId === nodeId) {
      onNodeSelect(null)
    }
  }

  const handleRefreshNode = async (node: GalaxyNode) => {
    if (!canRefreshDatasourceNode(node) || refreshingNodeId === node.id) return
    setRefreshingNodeId(node.id)
    try {
      const preview = await fetchDatasourceRefreshPreview(node)
      if (preview.hasConflict || preview.sourceChanged) {
        setRefreshPreview(preview)
        return
      }
      const updated = await refreshDatasourceNode(node, { force: true })
      setNodes(prev => prev.map((entry) => (entry.id === node.id ? updated : entry)))
      if (selectedNodeId === node.id) {
        onNodeSelect(updated)
      }
      toast({ title: "Source refreshed", description: updated.metadata?.datasourcePath || updated.title })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not refresh this datasource item."
      toast({ title: "Refresh failed", description: message, variant: "destructive" })
    } finally {
      setRefreshingNodeId(null)
    }
  }

  const resolveRefresh = async (strategy: "overwrite" | "duplicate") => {
    if (!refreshPreview) return
    setResolvingStrategy(strategy)
    try {
      const resolvedNode = await resolveDatasourceRefresh(refreshPreview, strategy)
      if (strategy === "overwrite") {
        setNodes((prev) => prev.map((entry) => (entry.id === resolvedNode.id ? resolvedNode : entry)))
        if (selectedNodeId === resolvedNode.id) onNodeSelect(resolvedNode)
      } else {
        setNodes((prev) => [...prev, resolvedNode])
      }
      toast({
        title: strategy === "overwrite" ? "Source refreshed" : "Source duplicated",
        description: strategy === "overwrite"
          ? ((resolvedNode.metadata?.datasourcePath as string) || resolvedNode.title)
          : `${resolvedNode.title} created from datasource`,
      })
      setRefreshPreview(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not resolve datasource refresh."
      toast({ title: "Refresh failed", description: message, variant: "destructive" })
    } finally {
      setResolvingStrategy(null)
    }
  }

  const renderNode = (node: GalaxyNode, level: number = 0) => {
    const isFolder = node.type === "folder"
    const isExpanded = expandedFolders.has(node.id)
    const isSelected = selectedNodeId === node.id
    const children = nodes.filter(n => n.parentId === node.id)
    const latestRevision = galaxyBrainService.getNodeHistory(node.id)[0]

    return (
      <div key={node.id}>
        <ContextMenu>
          <ContextMenuTrigger>
            <div
              className={`group flex items-center gap-2 rounded-xl p-2.5 cursor-pointer transition-colors ${
                isSelected
                  ? "bg-galaxy-100 text-cosmic-900 dark:bg-galaxy-900/40 dark:text-white"
                  : "hover:bg-white/80 dark:hover:bg-white/5"
              }`}
              style={{ paddingLeft: `${level * 16 + 8}px` }}
              onClick={() => {
                if (renamingNodeId === node.id) return
                if (isFolder) {
                  toggleFolder(node.id)
                } else {
                  onNodeSelect(node)
                }
              }}
              onDoubleClick={(e) => {
                e.stopPropagation()
                startRename(node)
              }}
            >
              {isFolder && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-4 w-4 p-0"
                  aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleFolder(node.id)
                  }}
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                </Button>
              )}
              
              {isFolder ? (
                <FolderOpen className="h-4 w-4 text-galaxy-500" />
              ) : (
                <FileText className="h-4 w-4 text-cosmic-400 dark:text-cosmic-500" />
              )}
              
              {renamingNodeId === node.id ? (
                <Input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  className="h-6 text-sm py-0 px-1 flex-1"
                  autoFocus
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      commitRename()
                    } else if (e.key === "Escape") {
                      cancelRename()
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{node.title}</span>
                  {latestRevision ? (
                    <span className="truncate text-[10px] text-cosmic-500 dark:text-cosmic-400">
                      {latestRevision.summary}
                    </span>
                  ) : null}
                </div>
              )}
              
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-4 w-4 p-0 opacity-0 group-hover:opacity-100 focus:opacity-100"
                    aria-label="More options"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onNodeSelect(node) }}>
                    Open
                  </DropdownMenuItem>
                  {canRefreshDatasourceNode(node) && (
                    <DropdownMenuItem onClick={(e) => { e.stopPropagation(); void handleRefreshNode(node) }} disabled={refreshingNodeId === node.id}>
                      {refreshingNodeId === node.id ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                      Refresh From Source
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); startRename(node) }}>
                    <Pencil className="h-4 w-4 mr-2" />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={(e) => { e.stopPropagation(); handleDeleteNode(node.id) }}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => onNodeSelect(node)}>
              Open
            </ContextMenuItem>
            {canRefreshDatasourceNode(node) && (
              <ContextMenuItem onClick={() => void handleRefreshNode(node)} disabled={refreshingNodeId === node.id}>
                {refreshingNodeId === node.id ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                Refresh From Source
              </ContextMenuItem>
            )}
            <ContextMenuItem onClick={() => startRename(node)}>
              <Pencil className="h-4 w-4 mr-2" />
              Rename
            </ContextMenuItem>
            <ContextMenuItem onClick={() => handleDeleteNode(node.id)}>
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        {isFolder && isExpanded && children.map(child => renderNode(child, level + 1))}
      </div>
    )
  }

  const rootNodes = filteredNodes.filter((node) => (
    !node.parentId ||
    node.parentId === workspaceId ||
    node.parentId === workspaceRootFolderId
  ))

  return (
    <div className="h-full flex flex-col">
      {/* Search */}
      <div className="border-b border-white/40 p-4 dark:border-white/10">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-cosmic-400 dark:text-cosmic-500" />
          <Input
            placeholder="Search files..."
            aria-label="Search files"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="h-10 rounded-xl border-white/60 bg-white/70 pl-10 shadow-sm dark:border-white/10 dark:bg-cosmic-950/60"
          />
        </div>
      </div>

      {/* Actions */}
      <div className="border-b border-white/40 p-4 dark:border-white/10">
        <div className="flex gap-2 flex-wrap">
          <Button size="sm" variant="outline" className="rounded-xl border-white/60 bg-white/70 shadow-sm hover:bg-white dark:border-white/10 dark:bg-cosmic-950/60" onClick={handleCreateNote}>
            <Plus className="h-4 w-4 mr-1" />
            Note
          </Button>
          <Button size="sm" variant="outline" className="rounded-xl border-white/60 bg-white/70 shadow-sm hover:bg-white dark:border-white/10 dark:bg-cosmic-950/60" onClick={handleCreateFolder}>
            <Plus className="h-4 w-4 mr-1" />
            Folder
          </Button>
          <Button size="sm" variant="outline" className="rounded-xl border-white/60 bg-white/70 shadow-sm hover:bg-white dark:border-white/10 dark:bg-cosmic-950/60" onClick={handleImport}>
            <Upload className="h-4 w-4 mr-1" />
            Import
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFilesSelected}
          />
        </div>
      </div>

      {/* File tree */}
      <div className="custom-scrollbar flex-1 overflow-y-auto p-3">
        {rootNodes.length === 0 ? (
          <div className="py-10 text-center text-cosmic-500 dark:text-cosmic-400">
            <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No files found</p>
          </div>
        ) : (
          <div className="space-y-1">
            {rootNodes.map(node => renderNode(node))}
          </div>
        )}
      </div>
      <DatasourceRefreshDialog
        open={Boolean(refreshPreview)}
        preview={refreshPreview}
        resolvingStrategy={resolvingStrategy}
        onOpenChange={(open) => {
          if (!open) setRefreshPreview(null)
        }}
        onOverwrite={() => void resolveRefresh("overwrite")}
        onDuplicate={() => void resolveRefresh("duplicate")}
      />
    </div>
  )
}
