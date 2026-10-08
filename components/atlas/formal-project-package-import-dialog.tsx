"use client"

import { PackageOpen } from "lucide-react"
import { useState } from "react"

import { FormalProjectPackageImport } from "@/components/graph/formal-project-package-import"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { FormalProjectPackageAtlasPlacement } from "@/lib/formal-project-package-atlas.js"
import type { FormalProjectPackageSummary } from "@/lib/formal-project-package-client.js"

export type FormalProjectPackageImportDialogProps = {
  open: boolean
  placing: boolean
  placement: FormalProjectPackageAtlasPlacement | null
  placementError: string
  selectionContext: string
  onOpenChange: (open: boolean) => void
  onImported: (
    summary: FormalProjectPackageSummary,
    signal: AbortSignal,
    selectionContext: string,
  ) => Promise<"selected" | "failed">
  onRetryPlacement: () => void
  returnFocus: HTMLElement | null
}

export function FormalProjectPackageImportDialog({
  open,
  placing,
  placement,
  placementError,
  selectionContext,
  onOpenChange,
  onImported,
  onRetryPlacement,
  returnFocus,
}: FormalProjectPackageImportDialogProps) {
  const [importing, setImporting] = useState(false)
  const busy = importing || placing

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!busy) onOpenChange(nextOpen) }}>
      <DialogContent
        className="max-h-[min(90vh,820px)] max-w-[min(94vw,860px)] overflow-y-auto"
        closeDisabled={busy}
        onCloseAutoFocus={(event) => {
          if (!returnFocus?.isConnected) return
          event.preventDefault()
          returnFocus.focus()
        }}
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault() }}
        onPointerDownOutside={(event) => { if (busy) event.preventDefault() }}
      >
        <DialogHeader>
          <DialogTitle className="research-display flex items-center gap-2 text-2xl">
            <PackageOpen className="size-5" aria-hidden="true" />
            Import a passive proof graph
          </DialogTitle>
          <DialogDescription>
            Review and register one immutable Rosetta formal-project package, then place its exact
            pinned repository-field graph on this Atlas. This creates no mission or live proof work.
          </DialogDescription>
        </DialogHeader>

        <FormalProjectPackageImport
          disabled={Boolean(placement) || placing || selectionContext === "atlas-unavailable"}
          completionMode="atlas-placement"
          onImportingChange={setImporting}
          selectionContext={selectionContext}
          onImported={onImported}
        />

        {placement ? (
          <section className="grid gap-3 rounded-xl border border-[#355f49]/20 bg-[#e9ead9]/45 p-3" aria-busy={placing}>
            <div>
              <h3 className="text-sm font-semibold">Imported graph placement</h3>
              <p className="mt-1 break-all font-mono text-[11px] text-[#557060]">{placement.subjectRef}</p>
            </div>
            {placementError ? (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {placementError}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                Keep imported without placing
              </Button>
              <Button type="button" disabled={busy} onClick={onRetryPlacement}>
                {placing ? "Placing…" : "Retry placement"}
              </Button>
            </DialogFooter>
            <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {placing ? "Placing the exact pinned passive proof graph on this Atlas." : placementError}
            </p>
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
