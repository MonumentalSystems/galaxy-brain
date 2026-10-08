"use client"

import { useRef } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export type ReferenceHandoffPhase =
  | "authorizing"
  | "ready"
  | "reauthorizing"
  | "placing"
  | "error"

export type ReferenceHandoffDialogProps = {
  open: boolean
  phase: ReferenceHandoffPhase
  subjectRef: string
  kind?: "document" | "chat" | "surface" | null
  title?: string
  error: string
  onCancel: () => void
  onConfirm: () => void
  returnFocus: HTMLElement | null
}

function objectLabel(kind: ReferenceHandoffDialogProps["kind"]) {
  if (kind === "chat") return "conversation snapshot"
  if (kind === "document") return "document"
  if (kind === "surface") return "Generous surface"
  return "object"
}

function statusForPhase(phase: ReferenceHandoffPhase, kind: ReferenceHandoffDialogProps["kind"]) {
  const label = objectLabel(kind)
  if (phase === "authorizing") return `Checking that this exact ${label} is available to you.`
  if (phase === "reauthorizing") return "Checking access again before placement."
  if (phase === "placing") return `Placing the exact ${label} on the durable Atlas canvas.`
  if (phase === "ready") return `Exact ${label} ready for confirmation.`
  return "Placement needs your attention."
}

export function ReferenceHandoffDialog({
  open,
  phase,
  subjectRef,
  kind,
  title,
  error,
  onCancel,
  onConfirm,
  returnFocus,
}: ReferenceHandoffDialogProps) {
  const titleRef = useRef<HTMLHeadingElement>(null)
  const confirmed = phase === "reauthorizing" || phase === "placing"
  const loading = phase === "authorizing"
  const canConfirm = Boolean(subjectRef)
  const label = objectLabel(kind)
  const status = statusForPhase(phase, kind)

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !confirmed) onCancel()
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-[min(38rem,calc(100vw-1rem))] overflow-y-auto p-4 sm:max-h-[min(90dvh,44rem)] sm:p-6"
        closeDisabled={confirmed}
        aria-busy={loading || confirmed}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          titleRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          if (!returnFocus?.isConnected) return
          event.preventDefault()
          returnFocus.focus()
        }}
        onEscapeKeyDown={(event) => {
          if (confirmed) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (confirmed) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle
            ref={titleRef}
            tabIndex={-1}
            className="research-display pr-10 text-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Place exact {label} on Atlas?
          </DialogTitle>
          <DialogDescription>
            Atlas will store this pinned reference and presentation geometry only. Nothing is placed until you confirm.
          </DialogDescription>
        </DialogHeader>

        <section className="min-w-0 rounded-xl border border-border bg-muted/35 p-3" aria-labelledby="atlas-handoff-object-title">
          <h3 id="atlas-handoff-object-title" className="font-semibold">
            {title || `Exact ${label}`}
          </h3>
          <p className="mt-2 text-xs text-muted-foreground">Pinned Galaxy reference</p>
          <code className="mt-1 block break-all text-xs leading-5">{subjectRef || "Reference unavailable"}</code>
        </section>

        <p
          id="atlas-reference-handoff-status"
          className="min-h-6 text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {status}
        </p>

        {error ? (
          <p
            id="atlas-reference-handoff-error"
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" disabled={confirmed} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            className="min-h-11 w-full sm:w-auto"
            disabled={loading || confirmed || !canConfirm}
            aria-describedby={`atlas-reference-handoff-status${error ? " atlas-reference-handoff-error" : ""}`}
            onClick={onConfirm}
          >
            {!canConfirm
              ? "Unavailable"
              : phase === "authorizing"
              ? "Checking access…"
              : phase === "reauthorizing"
                ? "Checking access…"
                : phase === "placing"
                  ? "Placing…"
                  : phase === "error"
                    ? "Try again"
                    : "Place on this Atlas"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
