"use client"

import { useEffect, useMemo, useState } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { NotebookView, serializeCells, type NotebookCell } from "@/components/notebook-view"
import {
  type GalaxyNode,
  type GalaxyNodeRevision,
  galaxyBrainService,
  getNotebookRevisionBlockDiffs,
} from "@/lib/galaxy-brain-service"
import { contentProcessingService } from "@/lib/content-processing-service"
import { toast } from "@/components/ui/use-toast"

interface Props {
  node: GalaxyNode
  cells: NotebookCell[]
  onCellsChange: (cells: NotebookCell[]) => void
  onClose: () => void
}

export function NotebookPanel({ node, cells, onCellsChange, onClose }: Props) {
  const [showHistory, setShowHistory] = useState(false)
  const [revisions, setRevisions] = useState<GalaxyNodeRevision[]>(() => galaxyBrainService.getNodeHistory(node.id))
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const localRevisions = galaxyBrainService.getNodeHistory(node.id)
    setRevisions(localRevisions)
    setSelectedRevisionId((current) => {
      if (current && localRevisions.some((revision) => revision.id === current)) return current
      return localRevisions[1]?.id || localRevisions[0]?.id || null
    })
    void galaxyBrainService.hydrateNodeHistory(node.id).then((next) => {
      if (cancelled) return
      setRevisions(next)
      setSelectedRevisionId((current) => {
        if (current && next.some((revision) => revision.id === current)) return current
        return next[1]?.id || next[0]?.id || null
      })
    })
    return () => {
      cancelled = true
    }
  }, [node.id, node.version])

  const handleSaveClose = () => {
    const updated = galaxyBrainService.updateNode(node.id, { content: serializeCells(cells) })
    if (updated) {
      contentProcessingService.enqueueNode(node.id)
    }
    onClose()
  }

  const selectedRevision = revisions.find((revision) => revision.id === selectedRevisionId) || revisions[1] || null
  const revisionCells = useMemo(() => {
    if (!selectedRevision) return []
    try {
      return JSON.parse(selectedRevision.snapshot.content) as NotebookCell[]
    } catch {
      return []
    }
  }, [selectedRevision])
  const currentSerializedCells = useMemo(() => serializeCells(cells), [cells])
  const revisionSerializedCells = useMemo(() => (
    selectedRevision ? selectedRevision.snapshot.content : ""
  ), [selectedRevision])
  const blockDiffs = useMemo(() => (
    selectedRevision ? getNotebookRevisionBlockDiffs(currentSerializedCells, revisionSerializedCells) : []
  ), [currentSerializedCells, revisionSerializedCells, selectedRevision])

  const handleRestoreBlock = (blockIndex: number) => {
    if (!selectedRevision || !revisionCells[blockIndex]) return
    const restoredCell = {
      ...revisionCells[blockIndex],
      id: cells[blockIndex]?.id || revisionCells[blockIndex].id,
    }
    const nextCells = [...cells]
    if (blockIndex < nextCells.length) {
      nextCells[blockIndex] = restoredCell
    } else {
      nextCells.push(restoredCell)
    }
    onCellsChange(nextCells)
    toast({
      title: "Block restored",
      description: `Restored block ${blockIndex + 1} from version ${selectedRevision.version}`,
    })
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-cosmic-950/45 p-4 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-label="Notebook" className="app-panel flex h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-[1.75rem]">
        <div className="app-hero flex items-center justify-between border-b border-white/40 p-5 dark:border-white/10">
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 rounded-full bg-orange-500" />
            <h2 className="font-display text-xl font-semibold text-cosmic-900 dark:text-white">{node.title || "Notebook"}</h2>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="rounded-xl border-white/60 bg-white/70 shadow-sm hover:bg-white dark:border-white/10 dark:bg-cosmic-950/60" onClick={() => setShowHistory((value) => !value)}>
              {showHistory ? "Hide History" : "Block History"}
            </Button>
            <Button variant="outline" size="sm" className="rounded-xl border-white/60 bg-white/70 shadow-sm hover:bg-white dark:border-white/10 dark:bg-cosmic-950/60" onClick={handleSaveClose}>
              Save & Close
            </Button>
            <Button variant="ghost" size="icon" className="rounded-xl" aria-label="Close" onClick={onClose}>
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>
        <div className="flex-1 overflow-hidden flex">
          <NotebookView cells={cells} onChange={onCellsChange} className="h-full flex-1" />
          {showHistory && (
            <aside className="app-panel-muted flex w-96 flex-col border-l border-white/40 dark:border-white/10">
              <div className="border-b border-white/40 px-4 py-4 dark:border-white/10">
                <h3 className="font-display text-base font-semibold text-cosmic-900 dark:text-white">Block History</h3>
                <p className="text-xs text-cosmic-500 dark:text-cosmic-400">Restore a single block from a previous notebook revision.</p>
              </div>
              <div className="custom-scrollbar max-h-52 space-y-2 overflow-y-auto border-b border-white/40 px-3 py-3 dark:border-white/10">
                {revisions.length <= 1 ? (
                  <p className="text-xs text-muted-foreground">No previous notebook revisions yet.</p>
                ) : revisions.map((revision, index) => {
                  const isCurrent = index === 0
                  const isSelected = selectedRevision?.id === revision.id
                  return (
                    <button
                      key={revision.id}
                      type="button"
                      disabled={isCurrent}
                      onClick={() => !isCurrent && setSelectedRevisionId(revision.id)}
                      className={`w-full rounded-xl border p-2 text-left text-xs ${
                        isCurrent
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
                        : isSelected
                            ? "border-galaxy-300 bg-galaxy-50 dark:border-galaxy-800 dark:bg-galaxy-950/30"
                            : "border-white/60 bg-white/75 dark:border-white/10 dark:bg-cosmic-950/45"
                      }`}
                    >
                      <p className="font-medium">{revision.summary}</p>
                      <p className="mt-1 text-muted-foreground">
                        Version {revision.version} • {new Date(revision.timestamp).toLocaleString()}
                      </p>
                    </button>
                  )
                })}
              </div>
              <div className="custom-scrollbar flex-1 overflow-y-auto p-3 space-y-3">
                {!selectedRevision ? (
                  <p className="text-sm text-muted-foreground">Select a previous revision to compare blocks.</p>
                ) : blockDiffs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">This revision is not notebook-structured.</p>
                ) : (
                  blockDiffs.map((diff) => {
                    const revisionCell = revisionCells[diff.index]
                    const canRestore = Boolean(revisionCell)
                    return (
                      <div key={`${selectedRevision.id}-${diff.index}`} className="rounded-xl border border-white/60 bg-white/80 p-3 text-sm shadow-sm dark:border-white/10 dark:bg-cosmic-950/45">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="font-medium">Block {diff.index + 1}</p>
                            <p className="text-xs text-muted-foreground">
                              {diff.status === "type-changed"
                                ? `${diff.previousType || "unknown"} -> ${diff.currentType || "unknown"}`
                                : diff.status}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 rounded-xl border-white/60 bg-white/70 shadow-sm hover:bg-white dark:border-white/10 dark:bg-cosmic-950/60"
                            onClick={() => handleRestoreBlock(diff.index)}
                            disabled={!canRestore}
                          >
                            Restore Block
                          </Button>
                        </div>
                        <div className="mt-2 grid gap-2 text-xs">
                          <div className="rounded-lg bg-white/80 px-2 py-2 dark:bg-cosmic-950/65">
                            <p className="mb-1 font-semibold uppercase tracking-wide text-cosmic-500">Revision</p>
                            <p className="whitespace-pre-wrap">{diff.previousPreview || "No content"}</p>
                          </div>
                          <div className="rounded-md bg-emerald-50 px-2 py-2 dark:bg-emerald-950/30">
                            <p className="mb-1 font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Current</p>
                            <p className="whitespace-pre-wrap">{diff.currentPreview || "No content"}</p>
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  )
}
