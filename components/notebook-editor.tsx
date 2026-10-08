"use client"

import { useCallback, useEffect, useState } from "react"
import { Bold, Eye, Italic, Pen, Save, X } from "lucide-react"

import { MarkdownRenderer } from "@/components/markdown-renderer"
import { PDFViewer } from "@/components/pdf-viewer"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { contentProcessingService } from "@/lib/content-processing-service"
import { type GalaxyNode, galaxyBrainService } from "@/lib/galaxy-brain-service"
import {
  getNotebookSaveStateLabel,
  hasNotebookEditorChanges,
  joinNodeTags,
  normalizeTagString,
} from "@/lib/notebook-editor-state"

interface NotebookEditorProps {
  node: GalaxyNode
  onSave: (node: GalaxyNode) => void
  onClose: () => void
}

export function NotebookEditor({ node, onSave, onClose }: NotebookEditorProps) {
  const [title, setTitle] = useState(node.title)
  const [content, setContent] = useState(node.content)
  const [tags, setTags] = useState(joinNodeTags(node.tags))
  const [hasChanges, setHasChanges] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [pendingAutoSave, setPendingAutoSave] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)

  const isMarkdown = node.tags?.includes("markdown") || node.metadata?.isMarkdown === true
  const isPDF = node.metadata?.isPDF === true

  useEffect(() => {
    setTitle(node.title)
    setContent(node.content)
    setTags(joinNodeTags(node.tags))
    setPendingAutoSave(false)
    setLastSavedAt(node.updatedAt)
  }, [node.id, node.title, node.content, node.tags, node.updatedAt])

  useEffect(() => {
    setHasChanges(hasNotebookEditorChanges(node, title, content, tags))
  }, [title, content, tags, node])

  const handleSave = useCallback(() => {
    const updatedNode = galaxyBrainService.updateNode(node.id, {
      title,
      content,
      tags: normalizeTagString(tags),
    })

    if (updatedNode) {
      try {
        contentProcessingService.enqueueNode(updatedNode.id)
      } catch {}
      setPendingAutoSave(false)
      setLastSavedAt(updatedNode.updatedAt)
      onSave(updatedNode)
    }
  }, [content, node.id, onSave, tags, title])

  const handleDone = useCallback(() => {
    if (hasChanges) {
      handleSave()
    }
    onClose()
  }, [handleSave, hasChanges, onClose])

  useEffect(() => {
    setPendingAutoSave(hasChanges)
    if (!hasChanges) return
    const timeout = setTimeout(() => {
      handleSave()
    }, 5000)
    return () => clearTimeout(timeout)
  }, [handleSave, hasChanges])

  return (
    <div className="flex h-full flex-col bg-transparent">
      <div className="border-b border-white/40 px-5 py-4 dark:border-white/10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div
              className={`h-3 w-3 rounded-full ${
                node.category === "ai"
                  ? "bg-purple-500"
                  : node.category === "document"
                    ? "bg-blue-500"
                    : node.category === "media"
                      ? "bg-green-500"
                      : node.category === "speech"
                        ? "bg-orange-500"
                        : "bg-gray-500"
              }`}
            />
            <span className="text-sm capitalize text-cosmic-500 dark:text-cosmic-400">
              {node.type} · {node.category}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-xs ${hasChanges ? "text-orange-500" : "text-emerald-600 dark:text-emerald-400"}`}>
              {getNotebookSaveStateLabel(hasChanges, pendingAutoSave, lastSavedAt)}
            </span>
            <Button
              size="sm"
              variant={hasChanges ? "default" : "outline"}
              className={hasChanges ? "rounded-xl" : "rounded-xl border-white/60 bg-white/70 shadow-sm hover:bg-white dark:border-white/10 dark:bg-cosmic-950/60"}
              onClick={handleSave}
              disabled={!hasChanges}
            >
              <Save className="mr-2 h-4 w-4" />
              {hasChanges ? "Save" : "Saved"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="rounded-xl border-white/60 bg-white/70 shadow-sm hover:bg-white dark:border-white/10 dark:bg-cosmic-950/60"
              onClick={handleDone}
              title="Save and close editor"
            >
              <X className="mr-2 h-4 w-4" />
              Done
            </Button>
          </div>
        </div>
      </div>

      <div className="custom-scrollbar flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-4xl space-y-6">
          <div className="rounded-[1.5rem] border border-white/60 bg-white/70 px-5 py-4 shadow-sm dark:border-white/10 dark:bg-cosmic-950/45">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Enter title..."
              className="font-display border-none bg-transparent px-0 text-3xl font-semibold text-cosmic-900 focus-visible:ring-0 dark:text-white"
            />
          </div>

          <div className="rounded-[1.25rem] border border-white/60 bg-white/60 px-5 py-3 shadow-sm dark:border-white/10 dark:bg-cosmic-950/35">
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="Tags (comma separated)..."
              className="border-none bg-transparent px-0 text-sm text-cosmic-500 focus-visible:ring-0 dark:text-cosmic-400"
            />
          </div>

          <div className="flex items-center justify-between rounded-[1.25rem] border border-white/60 bg-white/65 px-4 py-3 shadow-sm dark:border-white/10 dark:bg-cosmic-950/35">
            <div className="flex items-center gap-2">
              {!isPDF && (
                <>
                  <Button size="sm" variant="outline" className="rounded-xl border-white/60 bg-white/70 shadow-sm hover:bg-white dark:border-white/10 dark:bg-cosmic-950/60">
                    <Bold className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="outline" className="rounded-xl border-white/60 bg-white/70 shadow-sm hover:bg-white dark:border-white/10 dark:bg-cosmic-950/60">
                    <Italic className="h-4 w-4" />
                  </Button>
                </>
              )}
            </div>
            {(isMarkdown || isPDF) && !isPDF && (
              <Button
                size="sm"
                variant={showPreview ? "default" : "outline"}
                className={showPreview ? "gap-1.5 rounded-xl" : "gap-1.5 rounded-xl border-white/60 bg-white/70 shadow-sm hover:bg-white dark:border-white/10 dark:bg-cosmic-950/60"}
                onClick={() => setShowPreview(!showPreview)}
              >
                {showPreview ? <Pen className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                {showPreview ? "Edit" : "Preview"}
              </Button>
            )}
            {isPDF && (
              <span className="rounded-full bg-red-100 px-2.5 py-1 text-xs text-red-700 dark:bg-red-900/30 dark:text-red-300">
                PDF Document
              </span>
            )}
          </div>

          <div className="min-h-96">
            {isPDF && node.metadata?.pdfDataUrl ? (
              <PDFViewer data={node.metadata.pdfDataUrl} className="min-h-96" />
            ) : showPreview && isMarkdown ? (
              <div className="min-h-96 rounded-[1.5rem] border border-white/60 bg-white/75 px-6 py-5 shadow-sm dark:border-white/10 dark:bg-cosmic-950/45">
                <MarkdownRenderer content={content || "*Nothing to preview*"} />
              </div>
            ) : (
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={isMarkdown ? "Write markdown here..." : "Start writing..."}
                className={`min-h-96 resize-none rounded-[1.5rem] border border-white/60 bg-white/75 px-6 py-5 text-base leading-relaxed shadow-sm focus-visible:ring-galaxy-500 dark:border-white/10 dark:bg-cosmic-950/45 ${isMarkdown ? "font-mono text-sm" : ""}`}
              />
            )}
          </div>
        </div>
      </div>

      <div className="border-t border-white/40 px-5 py-4 text-xs text-cosmic-500 dark:border-white/10 dark:text-cosmic-400">
        <div className="flex items-center justify-between">
          <span>
            Created: {node.createdAt.toLocaleDateString()} · Updated: {node.updatedAt.toLocaleDateString()}
          </span>
          <span>{content.length} characters · done saves latest edits before closing</span>
        </div>
      </div>
    </div>
  )
}
