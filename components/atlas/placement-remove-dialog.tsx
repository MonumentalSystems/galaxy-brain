"use client"

import { Loader2, Unlink } from "lucide-react"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"

type PlacementRemoveDialogProps = {
  open: boolean
  busy: boolean
  error: string
  placementId: string
  label: string
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  returnFocus: HTMLElement | null
  fallbackFocus?: () => HTMLElement | null
}

export function PlacementRemoveDialog({
  open,
  busy,
  error,
  placementId,
  label,
  onOpenChange,
  onConfirm,
  returnFocus,
  fallbackFocus,
}: PlacementRemoveDialogProps) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && busy) return
        onOpenChange(nextOpen)
      }}
    >
      <AlertDialogContent
        className="research-panel border-[color:var(--research-line)] bg-[hsl(var(--research-paper))] text-[hsl(var(--research-ink))]"
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const target = returnFocus?.isConnected ? returnFocus : fallbackFocus?.()
          target?.focus({ preventScroll: true })
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="research-display text-2xl">Remove from this Atlas?</AlertDialogTitle>
          <AlertDialogDescription className="space-y-3 text-[hsl(var(--field-muted))]">
            <span className="block">
              This removes only the spatial placement for <strong>{label}</strong>. The canonical object,
              its revisions, and semantic relations remain in their owning services.
            </span>
            <span className="block break-all font-mono text-xs">Placement: {placementId}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p className="rounded-xl border border-[#b66238]/45 bg-[#b66238]/10 px-3 py-2 text-sm text-[#7f321c]" role="alert">
            {error}
          </p>
        ) : null}
        <p className="sr-only" role="status" aria-live="polite">
          {busy ? "Removing placement from this Atlas." : ""}
        </p>
        <AlertDialogFooter aria-busy={busy}>
          <AlertDialogCancel disabled={busy}>Keep placement</AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={busy} onClick={onConfirm}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Unlink className="h-4 w-4" aria-hidden="true" />}
            {busy ? "Removing…" : "Remove from Atlas"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
