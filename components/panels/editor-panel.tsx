"use client"

import { useState } from "react"
import { History, Loader2, RefreshCw } from "lucide-react"

import { DatasourceRefreshDialog } from "@/components/datasource-refresh-dialog"
import { NotebookEditor } from "@/components/notebook-editor"
import { RevisionHistoryPanel } from "@/components/revision-history-panel"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/use-toast"
import {
  canRefreshDatasourceNode,
  fetchDatasourceRefreshPreview,
  refreshDatasourceNode,
  resolveDatasourceRefresh,
  type DatasourceRefreshPreview,
} from "@/lib/datasource-node-actions"
import { type GalaxyNode, galaxyBrainService } from "@/lib/galaxy-brain-service"

interface Props {
  node: GalaxyNode
  onSave: (node: GalaxyNode) => void
  onClose: () => void
}

export function EditorPanel({ node, onSave, onClose }: Props) {
  const [refreshing, setRefreshing] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [refreshPreview, setRefreshPreview] = useState<DatasourceRefreshPreview | null>(null)
  const [resolvingStrategy, setResolvingStrategy] = useState<"overwrite" | "duplicate" | null>(null)
  const datasourceName = typeof node.metadata?.datasourceDisplayName === "string" ? node.metadata.datasourceDisplayName : ""
  const datasourcePath = typeof node.metadata?.datasourcePath === "string" ? node.metadata.datasourcePath : ""
  const importedAt = typeof node.metadata?.datasourceImportedAt === "string" ? node.metadata.datasourceImportedAt : ""
  const refreshedAt = typeof node.metadata?.datasourceRefreshedAt === "string" ? node.metadata.datasourceRefreshedAt : ""
  const warnings = Array.isArray(node.metadata?.datasourceWarnings) ? node.metadata.datasourceWarnings.map(String) : []
  const isDatasourceBacked = Boolean(datasourceName || datasourcePath)
  const isRefreshable = canRefreshDatasourceNode(node)
  const revisions = galaxyBrainService.getNodeHistory(node.id)
  const latestRevision = revisions[0] || null

  const handleRefresh = async () => {
    if (!isRefreshable || refreshing) return
    setRefreshing(true)
    try {
      const preview = await fetchDatasourceRefreshPreview(node)
      if (preview.hasConflict || preview.sourceChanged) {
        setRefreshPreview(preview)
        return
      }
      const refreshedNode = await refreshDatasourceNode(node, { force: true })
      onSave(refreshedNode)
      toast({ title: "Source refreshed", description: datasourcePath || datasourceName || refreshedNode.title })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not refresh this datasource item."
      toast({ title: "Refresh failed", description: message, variant: "destructive" })
    } finally {
      setRefreshing(false)
    }
  }

  const resolveRefresh = async (strategy: "overwrite" | "duplicate") => {
    if (!refreshPreview) return
    setResolvingStrategy(strategy)
    try {
      const resolvedNode = await resolveDatasourceRefresh(refreshPreview, strategy)
      if (strategy === "overwrite") {
        onSave(resolvedNode)
      }
      toast({
        title: strategy === "overwrite" ? "Source refreshed" : "Source duplicated",
        description: strategy === "overwrite"
          ? (resolvedNode.metadata?.datasourcePath as string || resolvedNode.title)
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

  const handleRestoreRevision = (revisionId: string) => {
    const confirmed = window.confirm("Restore this version? Your current editor contents will be replaced.")
    if (!confirmed) return
    const restored = galaxyBrainService.restoreNodeRevision(node.id, revisionId)
    if (!restored) {
      toast({ title: "Restore failed", description: "Could not restore that version.", variant: "destructive" })
      return
    }
    onSave(restored)
    toast({ title: "Version restored", description: `Restored ${restored.title}` })
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-cosmic-950/45 p-4 backdrop-blur-sm">
      <>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Note editor"
          className="app-panel flex h-[84vh] w-full max-w-6xl overflow-hidden rounded-[1.75rem]"
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="app-hero border-b border-white/40 px-5 py-4 text-xs text-cosmic-700 dark:border-white/10 dark:text-cosmic-200">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="app-chip">Version {node.version || revisions[0]?.version || 1}</span>
                  <span>{revisions.length} saved revision{revisions.length === 1 ? "" : "s"}</span>
                  {latestRevision ? (
                    <span>
                      Latest: {latestRevision.summary} at {new Date(latestRevision.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    </span>
                  ) : null}
                  {isDatasourceBacked ? <span>Imported from {datasourceName || "Datasource"}</span> : null}
                  {datasourcePath ? <span className="truncate">Path: {datasourcePath}</span> : null}
                  {importedAt ? <span>Imported: {new Date(importedAt).toLocaleString()}</span> : null}
                  {refreshedAt ? <span>Refreshed: {new Date(refreshedAt).toLocaleString()}</span> : null}
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" className="h-8 rounded-xl border-white/60 bg-white/70 shadow-sm hover:bg-white dark:border-white/10 dark:bg-cosmic-950/60" onClick={() => setShowHistory((value) => !value)}>
                    <History className="mr-2 h-3.5 w-3.5" />
                    {showHistory ? "Hide history" : `History (${revisions.length})`}
                  </Button>
                  {isRefreshable ? (
                    <Button size="sm" variant="outline" className="h-8 rounded-xl border-white/60 bg-white/70 shadow-sm hover:bg-white dark:border-white/10 dark:bg-cosmic-950/60" onClick={handleRefresh} disabled={refreshing}>
                      {refreshing ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
                      Refresh from source
                    </Button>
                  ) : null}
                </div>
              </div>
              {isDatasourceBacked && warnings.length > 0 ? (
                <p className="mt-1 text-amber-700 dark:text-amber-300">{warnings.join(" ")}</p>
              ) : null}
            </div>
            <NotebookEditor node={node} onSave={onSave} onClose={onClose} />
          </div>

          {showHistory ? (
            <aside className="app-panel-muted w-80 border-l border-white/40 dark:border-white/10">
              <RevisionHistoryPanel node={node} onRestore={handleRestoreRevision} />
            </aside>
          ) : null}
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
      </>
    </div>
  )
}
