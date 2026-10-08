"use client"

import { useEffect, useMemo, useState } from "react"
import { History, RotateCcw } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  type GalaxyNode,
  type GalaxyNodeRevision,
  galaxyBrainService,
  getGalaxyNodeRevisionDiff,
} from "@/lib/galaxy-brain-service"

interface RevisionHistoryPanelProps {
  node: GalaxyNode
  onRestore: (revisionId: string) => void
  className?: string
  compact?: boolean
}

export function RevisionHistoryPanel({
  node,
  onRestore,
  className = "",
  compact = false,
}: RevisionHistoryPanelProps) {
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

  const selectedRevision = revisions.find((revision) => revision.id === selectedRevisionId) || revisions[1] || revisions[0] || null
  const diff = useMemo(() => (
    selectedRevision ? getGalaxyNodeRevisionDiff(node, selectedRevision.snapshot) : null
  ), [node, selectedRevision])

  return (
    <div className={className}>
      <div className="border-b border-white/40 px-4 py-4 dark:border-white/10">
        <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-base font-semibold text-cosmic-900 dark:text-white">Version History</h2>
          <p className="text-xs text-cosmic-500 dark:text-cosmic-400">
            Text edits, notebook block changes, metadata, and layout updates.
          </p>
        </div>
        <div className="app-chip">
          {revisions.length} revision{revisions.length === 1 ? "" : "s"}
        </div>
        </div>
      </div>

      {selectedRevision && diff ? (
        <div className="border-b border-white/40 bg-white/30 px-4 py-4 text-xs dark:border-white/10 dark:bg-white/5">
          <div className="flex items-center gap-2 font-medium text-cosmic-700 dark:text-cosmic-200">
            <History className="h-3.5 w-3.5" />
            Compare current version to v{selectedRevision.version}
          </div>
          <div className="mt-2 space-y-1 text-cosmic-600 dark:text-cosmic-300">
            {diff.summaryLines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
          {diff.beforePreview || diff.afterPreview ? (
            <div className="mt-3 grid gap-2">
              <div className="rounded-xl bg-white/70 px-3 py-3 shadow-sm dark:bg-cosmic-950/55">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-cosmic-500">Revision</p>
                <p className="whitespace-pre-wrap">{diff.beforePreview || "No content"}</p>
              </div>
              <div className="rounded-xl bg-emerald-50 px-3 py-3 dark:bg-emerald-950/30">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Current</p>
                <p className="whitespace-pre-wrap">{diff.afterPreview || "No content"}</p>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={compact ? "custom-scrollbar max-h-80 overflow-y-auto p-3 space-y-3" : "custom-scrollbar h-[calc(80vh-220px)] overflow-y-auto p-3 space-y-3"}>
        {revisions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No saved revisions yet.</p>
        ) : (
          revisions.map((revision, index) => {
            const isCurrent = index === 0
            const isSelected = selectedRevision?.id === revision.id
            return (
              <button
                key={revision.id}
                type="button"
                className={`w-full rounded-xl border p-3 text-left text-sm transition-colors ${
                  isSelected
                    ? "border-galaxy-300 bg-galaxy-50 dark:border-galaxy-800 dark:bg-galaxy-950/30"
                    : "border-white/60 bg-white/75 dark:border-white/10 dark:bg-cosmic-950/45"
                }`}
                onClick={() => setSelectedRevisionId(revision.id)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">{revision.summary}</p>
                    <p className="text-xs text-muted-foreground">
                      Version {revision.version} | {new Date(revision.timestamp).toLocaleString()}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {revision.changedFields.join(", ") || "No changed fields recorded"}
                    </p>
                  </div>
                  {isCurrent ? (
                    <span className="rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                      Current
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 shrink-0 rounded-xl border-white/60 bg-white/70 shadow-sm hover:bg-white dark:border-white/10 dark:bg-cosmic-950/60"
                      onClick={(event) => {
                        event.stopPropagation()
                        onRestore(revision.id)
                      }}
                    >
                      <RotateCcw className="mr-2 h-3.5 w-3.5" />
                      Restore
                    </Button>
                  )}
                </div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
