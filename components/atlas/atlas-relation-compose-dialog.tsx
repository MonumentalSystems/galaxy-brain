"use client"

import { ArrowLeftRight, Link2, Loader2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  ATLAS_AUTHORED_RELATIONS,
  type AtlasAuthoredRelation,
} from "@/lib/canvas/atlas-authored-relation.js"

type RelationEndpoint = {
  label: string
  ref: string
}

type AtlasRelationComposeDialogProps = {
  open: boolean
  source: RelationEndpoint | null
  target: RelationEndpoint | null
  relation: AtlasAuthoredRelation
  busy: boolean
  frozen: boolean
  ambiguous: boolean
  error: string
  onOpenChange: (open: boolean) => void
  onRelationChange: (relation: AtlasAuthoredRelation) => void
  onSwap: () => void
  onConfirm: () => void
  onAbandon: () => void
  returnFocus: HTMLElement | null
  fallbackFocus?: () => HTMLElement | null
}

export function AtlasRelationComposeDialog({
  open,
  source,
  target,
  relation,
  busy,
  frozen,
  ambiguous,
  error,
  onOpenChange,
  onRelationChange,
  onSwap,
  onConfirm,
  onAbandon,
  returnFocus,
  fallbackFocus,
}: AtlasRelationComposeDialogProps) {
  const ready = Boolean(source && target && source.ref !== target.ref)
  const relationTriggerRef = useRef<HTMLButtonElement>(null)
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(returnFocus)
  const [abandonArmed, setAbandonArmed] = useState(false)
  useEffect(() => {
    if (open) returnFocusRef.current = returnFocus
  }, [open, returnFocus])
  useEffect(() => {
    if (!open || !ambiguous) setAbandonArmed(false)
  }, [ambiguous, open])
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && (busy || ambiguous)) return
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent
        closeDisabled={busy || ambiguous}
        closeDisabledLabel={ambiguous ? "Use Release retry to discard the saved operation" : undefined}
        className="research-panel max-h-[min(42rem,calc(100dvh-2rem))] overflow-y-auto border-[color:var(--research-line)] bg-[hsl(var(--research-paper))] text-[hsl(var(--research-ink))] motion-reduce:animate-none motion-reduce:transition-none"
        onEscapeKeyDown={(event) => {
          if (busy || ambiguous) event.preventDefault()
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          const initialTarget = frozen ? confirmButtonRef.current : relationTriggerRef.current
          initialTarget?.focus({ preventScroll: true })
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const previousTarget = returnFocusRef.current
          const targetElement = previousTarget?.isConnected ? previousTarget : fallbackFocus?.()
          targetElement?.focus({ preventScroll: true })
        }}
      >
        <DialogHeader>
          <DialogTitle className="research-display text-2xl">Create an authored relation</DialogTitle>
          <DialogDescription className="text-[hsl(var(--field-muted))]">
            Creates a durable authored assertion between two exact object revisions; it does not verify either object,
            alter their content, or write an edge into the Atlas layout.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3" aria-label="Relation direction">
          <section className="rounded-xl border border-[color:var(--research-line)] bg-white/55 p-3">
            <p className="research-kicker">Source</p>
            <p className="mt-1 font-semibold">{source?.label || "No source selected"}</p>
            {source ? <p className="mt-1 break-all font-mono text-xs text-[hsl(var(--field-muted))]">{source.ref}</p> : null}
          </section>
          <div className="grid grid-cols-[1fr_auto] items-end gap-2">
            <div className="grid gap-2">
              <Label htmlFor="atlas-authored-relation-kind">Relation</Label>
              <Select
                value={relation}
                disabled={busy || frozen}
                onValueChange={(value) => onRelationChange(value as AtlasAuthoredRelation)}
              >
                <SelectTrigger ref={relationTriggerRef} id="atlas-authored-relation-kind" className="min-h-11 bg-white/75">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ATLAS_AUTHORED_RELATIONS.map((option) => (
                    <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-11"
              disabled={!ready || busy || frozen}
              aria-label="Swap relation source and target"
              onClick={onSwap}
            >
              <ArrowLeftRight aria-hidden="true" />
            </Button>
          </div>
          <section className="rounded-xl border border-[color:var(--research-line)] bg-white/55 p-3">
            <p className="research-kicker">Target</p>
            <p className="mt-1 font-semibold">{target?.label || "No target selected"}</p>
            {target ? <p className="mt-1 break-all font-mono text-xs text-[hsl(var(--field-muted))]">{target.ref}</p> : null}
          </section>
        </div>

        {error ? (
          <p className="rounded-xl border border-[#b66238]/45 bg-[#b66238]/10 px-3 py-2 text-sm text-[#7f321c]" role="alert">
            {error}
          </p>
        ) : null}
        {abandonArmed ? (
          <p className="rounded-xl border border-[#b66238]/45 bg-[#b66238]/10 px-3 py-2 text-sm text-[#7f321c]" role="alert">
            Releasing this retry forgets its operation identity. If the first request committed, creating it again later may duplicate the assertion.
          </p>
        ) : null}
        <p className="sr-only" role="status" aria-live="polite">
          {busy ? "Saving authored relation." : ambiguous ? "Relation outcome is unconfirmed; retry preserves the same operation." : ""}
        </p>

        <DialogFooter className="gap-2 sm:space-x-0" aria-busy={busy}>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (!ambiguous) {
                onOpenChange(false)
                return
              }
              if (!abandonArmed) {
                setAbandonArmed(true)
                return
              }
              onAbandon()
            }}
          >
            {ambiguous ? (abandonArmed ? "Confirm release retry" : "Release retry…") : "Cancel"}
          </Button>
          <Button ref={confirmButtonRef} type="button" disabled={!ready || busy} onClick={onConfirm}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Link2 className="h-4 w-4" aria-hidden="true" />}
            {busy ? "Saving…" : ambiguous ? "Retry same relation" : "Create relation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
