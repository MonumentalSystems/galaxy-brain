"use client"

import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { type DatasourceRefreshPreview } from "@/lib/datasource-node-actions"

interface Props {
  open: boolean
  preview: DatasourceRefreshPreview | null
  resolvingStrategy: "overwrite" | "duplicate" | null
  onOpenChange: (open: boolean) => void
  onOverwrite: () => void
  onDuplicate: () => void
}

function previewText(value: string): string {
  const text = value.replace(/\s+/g, " ").trim()
  if (!text) return "No content"
  return text.length > 320 ? `${text.slice(0, 317)}...` : text
}

export function DatasourceRefreshDialog({
  open,
  preview,
  resolvingStrategy,
  onOpenChange,
  onOverwrite,
  onDuplicate,
}: Props) {
  const sourceTitle = preview?.imported.title || preview?.node.title || "Source"
  const localTitle = preview?.node.title || "Local note"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>Source Update Available</DialogTitle>
          <DialogDescription>
            Compare your local edits with the latest datasource content and choose how to resolve it.
          </DialogDescription>
        </DialogHeader>

        {preview ? (
          <div className="space-y-4">
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              {preview.hasConflict
                ? "Local edits differ from the last imported source version."
                : preview.sourceChanged
                  ? "The datasource has new content available for this note."
                  : "Review the latest datasource content before applying it."}
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Local</p>
                <p className="mt-1 text-sm font-medium">{localTitle}</p>
                <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">
                  {previewText(preview.node.content)}
                </p>
              </div>
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950/30">
                <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">Source</p>
                <p className="mt-1 text-sm font-medium">{sourceTitle}</p>
                <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">
                  {previewText(preview.imported.content)}
                </p>
              </div>
            </div>

            <div className="grid gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs dark:border-gray-800 dark:bg-gray-950/40">
              <p><span className="font-semibold">Datasource path:</span> {preview.imported.path || preview.node.metadata?.datasourcePath || "Unknown"}</p>
              {preview.imported.updated_at ? (
                <p><span className="font-semibold">Source updated:</span> {new Date(preview.imported.updated_at).toLocaleString()}</p>
              ) : null}
              {Array.isArray(preview.imported.warnings) && preview.imported.warnings.length > 0 ? (
                <p><span className="font-semibold">Warnings:</span> {preview.imported.warnings.join(" ")}</p>
              ) : null}
            </div>
          </div>
        ) : null}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={Boolean(resolvingStrategy)}>
            Keep Local
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onDuplicate} disabled={Boolean(resolvingStrategy)}>
              {resolvingStrategy === "duplicate" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Duplicate as New
            </Button>
            <Button onClick={onOverwrite} disabled={Boolean(resolvingStrategy)}>
              {resolvingStrategy === "overwrite" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Overwrite with Source
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
