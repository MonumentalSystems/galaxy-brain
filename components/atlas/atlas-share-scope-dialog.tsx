"use client"

import { Copy, ExternalLink, Loader2, Share2 } from "lucide-react"
import { useRef } from "react"

import { focusFirstConnected } from "@/components/atlas/presenter-focus"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export type AtlasShareScope = {
  canvasTitle: string
  canvasVersion: number
  itemCount: number
  edgeCount: number
  conversationLabel: string
  conversationRef: string
}

export type AtlasShareScopeDialogProps = {
  open: boolean
  busy: boolean
  scope: AtlasShareScope | null
  status: { state: "success" | "error"; message: string; url?: string } | null
  returnFocus: HTMLElement | null
  fallbackFocus: HTMLElement | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  onRetry: () => void
  onCopy: () => void
}

export function AtlasShareScopeDialog({
  open,
  busy,
  scope,
  status,
  returnFocus,
  fallbackFocus,
  onOpenChange,
  onConfirm,
  onRetry,
  onCopy,
}: AtlasShareScopeDialogProps) {
  const contentRef = useRef<HTMLDivElement | null>(null)
  const titleRef = useRef<HTMLHeadingElement | null>(null)
  const created = Boolean(status?.state === "success" && status.url)

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen && busy) return
      onOpenChange(nextOpen)
    }}>
      <DialogContent
        ref={contentRef}
        closeDisabled={busy}
        className="research-workbench max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-2xl overflow-x-hidden overflow-y-auto p-4 sm:p-6"
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault() }}
        onInteractOutside={(event) => { if (busy) event.preventDefault() }}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          titleRef.current?.focus({ preventScroll: true })
        }}
        onCloseAutoFocus={(event) => {
          if (focusFirstConnected([returnFocus, fallbackFocus], contentRef.current)) event.preventDefault()
        }}
      >
        <DialogHeader className="pr-10 text-left">
          <DialogTitle
            ref={titleRef}
            tabIndex={-1}
            className="research-display rounded-sm text-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Share Atlas + redacted transcript
          </DialogTitle>
          <DialogDescription className="text-[hsl(var(--field-muted-strong))]">
            Create one immutable redacted transcript bundle from the exact saved revisions below. This does not change either private source.
          </DialogDescription>
        </DialogHeader>

        {scope ? (
          <dl className="grid gap-3 rounded-xl border border-[color:var(--research-line)] bg-[hsl(var(--research-paper))] p-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-semibold text-[hsl(var(--research-ink))]">Canvas snapshot</dt>
              <dd className="mt-1 text-[hsl(var(--field-muted-strong))]">
                {scope.canvasTitle}, revision {scope.canvasVersion}; {scope.itemCount} items and {scope.edgeCount} edges.
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-[hsl(var(--research-ink))]">Conversation snapshot</dt>
              <dd className="mt-1 text-[hsl(var(--field-muted-strong))]">{scope.conversationLabel}</dd>
              <dd className="mt-1 break-all font-mono text-xs text-[hsl(var(--field-muted-strong))]">{scope.conversationRef}</dd>
            </div>
            <div>
              <dt className="font-semibold text-[hsl(var(--research-ink))]">Access</dt>
              <dd className="mt-1 text-[hsl(var(--field-muted-strong))]">Signed-in members of this Galaxy tenant.</dd>
            </div>
            <div>
              <dt className="font-semibold text-[hsl(var(--research-ink))]">Not included</dt>
              <dd className="mt-1 text-[hsl(var(--field-muted-strong))]">
                Future canvas changes or turns, system/tool bodies, artifacts, runs, logs, presence, credentials, or edit rights.
              </dd>
            </div>
          </dl>
        ) : null}

        <div className="min-h-10" aria-live="polite" aria-atomic="true">
          {busy ? <p className="text-sm text-[hsl(var(--field-muted-strong))]">Creating immutable tenant-scoped bundle…</p> : null}
          {status ? (
            <p
              className={status.state === "error"
                ? "rounded-xl border border-[#b66238]/45 bg-[#b66238]/10 px-3 py-2 text-sm text-[#7f321c]"
                : "rounded-xl border border-[#6d7a68]/45 bg-[#6d7a68]/10 px-3 py-2 text-sm text-[#294638]"}
              role={status.state === "error" ? "alert" : "status"}
            >
              {status.message}
            </p>
          ) : null}
        </div>

        {status?.url ? (
          <label className="grid gap-2 text-sm font-semibold text-[hsl(var(--research-ink))]">
            Bundle URL
            <input
              readOnly
              value={status.url}
              onFocus={(event) => event.currentTarget.select()}
              className="min-h-11 w-full rounded-lg border border-[color:var(--research-line)] bg-white px-3 font-mono text-xs font-normal"
            />
          </label>
        ) : null}

        <DialogFooter className="gap-2 sm:space-x-0" aria-busy={busy}>
          <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => onOpenChange(false)}>
            {created ? "Close" : "Cancel"}
          </Button>
          {status?.state === "error" ? (
            <Button type="button" className="min-h-11" disabled={busy} onClick={onRetry}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Share2 className="h-4 w-4" aria-hidden="true" />}
              Retry same bundle
            </Button>
          ) : status?.url ? (
            <>
              <Button type="button" variant="outline" className="min-h-11" onClick={onCopy}>
                <Copy className="h-4 w-4" aria-hidden="true" /> Copy URL
              </Button>
              <Button type="button" className="min-h-11" asChild>
                <a href={status.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" aria-hidden="true" /> Open bundle
                </a>
              </Button>
            </>
          ) : (
            <Button type="button" className="min-h-11" disabled={busy || !scope} onClick={onConfirm}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Share2 className="h-4 w-4" aria-hidden="true" />}
              {busy ? "Creating…" : "Create tenant-scoped bundle"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
