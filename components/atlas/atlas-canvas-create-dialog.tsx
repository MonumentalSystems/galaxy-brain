"use client"

import { LoaderCircle } from "lucide-react"
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"

import { focusFirstConnected } from "@/components/atlas/presenter-focus"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  atlasCanvasCreateRecoveryKey,
  confirmAtlasCanvasCreateResponse,
  discardAtlasCanvasCreateRecovery,
  prepareAtlasCanvasCreateOperation,
  readPendingAtlasCanvasCreate,
  removePendingAtlasCanvasCreate,
  requirePendingAtlasCanvasCreate,
  writePendingAtlasCanvasCreate,
  type AtlasCanvasCreateOperation,
  type AtlasCanvasCreateScope,
} from "@/lib/canvas/atlas-canvas-create.js"
import { atlasCanvasHref } from "@/lib/canvas/atlas-location.js"
import { GalaxyBrainAPIError, galaxyBrainAPI } from "@/lib/galaxy-brain-api"
import type { CanvasRecord } from "@/lib/types/canvas"

export type AtlasCanvasCreateDialogProps = Readonly<{
  open: boolean
  onOpenChange: (open: boolean) => void
  onBusyChange: (busy: boolean) => void
  getBlockedReason: () => string | null
  scope: AtlasCanvasCreateScope
  canvases: readonly CanvasRecord[]
  returnFocus: HTMLElement | null
  fallbackFocus: HTMLElement | null
}>

type CreateFailure = Readonly<{ ambiguous: boolean; message: string }>

function safeCreateFailure(error: unknown): CreateFailure {
  if (error instanceof GalaxyBrainAPIError) {
    if (error.status === 401) return { ambiguous: false, message: "Sign in again before creating this canvas." }
    if (error.status === 403) return { ambiguous: false, message: "You are not authorized to create a canvas in this workspace." }
    if (error.status === 409) return { ambiguous: false, message: "That canvas slug is already in use, or this retry no longer matches its original request." }
    if (error.status === 422) return { ambiguous: false, message: "The canvas title or slug was rejected. Review the fields and try again." }
    if (error.status === 408 || error.status === 429 || error.status >= 500) {
      return { ambiguous: true, message: "The creation outcome is unconfirmed. Retry the exact request; Galaxy will not create it twice." }
    }
    return { ambiguous: false, message: "The canvas could not be created. Review the request and try again." }
  }
  return { ambiguous: true, message: "The creation outcome is unconfirmed. Retry the exact request; Galaxy will not create it twice." }
}

export function AtlasCanvasCreateDialog({
  open,
  onOpenChange,
  onBusyChange,
  getBlockedReason,
  scope,
  canvases,
  returnFocus,
  fallbackFocus,
}: AtlasCanvasCreateDialogProps) {
  const [title, setTitle] = useState("")
  const [slug, setSlug] = useState("")
  const [operation, setOperation] = useState<AtlasCanvasCreateOperation | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [ambiguous, setAmbiguous] = useState(false)
  const [recoveryBlocked, setRecoveryBlocked] = useState(false)
  const [error, setError] = useState("")
  const [abandonOpen, setAbandonOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const generationRef = useRef(0)

  const restore = useCallback((pending: AtlasCanvasCreateOperation) => {
    setOperation(pending)
    setTitle(pending.title)
    setSlug(pending.slug)
    setAmbiguous(true)
    setRecoveryBlocked(false)
    setError("A previous creation outcome is unconfirmed. Retry this exact request before creating another canvas.")
  }, [])

  useEffect(() => () => {
    generationRef.current += 1
  }, [])

  useEffect(() => {
    if (!open || operation || typeof window === "undefined") return
    try {
      const pending = readPendingAtlasCanvasCreate(window.localStorage, scope)
      if (pending) restore(pending)
    } catch {
      setRecoveryBlocked(true)
      setError("Galaxy could not verify the safe creation journal. Review and explicitly discard it before starting another canvas.")
    }
  }, [open, operation, restore, scope])

  useEffect(() => {
    if (!open || typeof window === "undefined") return
    const recoveryKey = atlasCanvasCreateRecoveryKey(scope)
    const refresh = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage || event.key !== recoveryKey) return
      try {
        const pending = readPendingAtlasCanvasCreate(window.localStorage, scope)
        if (pending) {
          if (!operation) restore(pending)
          else {
            try {
              requirePendingAtlasCanvasCreate(window.localStorage, scope, operation)
            } catch {
              restore(pending)
            }
          }
        } else if (operation) {
          setRecoveryBlocked(true)
          setError("The exact creation journal was removed in another tab. Review recovery before sending again.")
        } else if (recoveryBlocked) {
          setRecoveryBlocked(false)
          setError("")
        }
      } catch {
        setRecoveryBlocked(true)
        setError("Galaxy could not refresh the safe creation journal.")
      }
    }
    window.addEventListener("storage", refresh)
    return () => window.removeEventListener("storage", refresh)
  }, [open, operation, recoveryBlocked, restore, scope])

  function resetDraft() {
    generationRef.current += 1
    setTitle("")
    setSlug("")
    setOperation(null)
    setSubmitting(false)
    setAmbiguous(false)
    setRecoveryBlocked(false)
    setError("")
    setAbandonOpen(false)
    onBusyChange(false)
  }

  function closeConfirmed() {
    resetDraft()
    onOpenChange(false)
  }

  function requestClose() {
    if (submitting) return
    if (operation || recoveryBlocked) {
      setAbandonOpen(true)
      return
    }
    closeConfirmed()
  }

  function abandonOperation() {
    if (typeof window !== "undefined") {
      try {
        if (operation) {
          const removed = removePendingAtlasCanvasCreate(window.localStorage, scope, operation.operationId)
          if (!removed) {
            const pending = readPendingAtlasCanvasCreate(window.localStorage, scope)
            if (pending) {
              restore(pending)
              setAbandonOpen(false)
              return
            }
          }
        } else if (recoveryBlocked) {
          discardAtlasCanvasCreateRecovery(window.localStorage, scope)
        }
      } catch {
        setError("Galaxy could not remove the exact retry journal. Reload before starting another canvas.")
        setAbandonOpen(false)
        return
      }
    }
    closeConfirmed()
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    if (recoveryBlocked) {
      setError("Review and explicitly discard the unreadable recovery journal before starting another canvas.")
      return
    }
    const blockedReason = getBlockedReason()
    if (blockedReason) {
      setError(blockedReason)
      return
    }

    let nextOperation = operation
    if (!nextOperation) {
      if (canvases.some((canvas) => canvas.workspaceId === scope.workspaceId && canvas.slug === slug.trim())) {
        setError("That canvas slug is already in use in this workspace.")
        return
      }
      let prepared: AtlasCanvasCreateOperation
      try {
        prepared = prepareAtlasCanvasCreateOperation({
          tenantId: scope.tenantId,
          principalId: scope.principalId,
          workspaceId: scope.workspaceId,
          title,
          slug,
        })
      } catch (cause) {
        setError(cause instanceof TypeError
          ? cause.message.replace(/^Invalid Atlas canvas creation:\s*/u, "")
          : "Review the title and slug before creating this canvas.")
        return
      }
      try {
        nextOperation = writePendingAtlasCanvasCreate(window.localStorage, scope, prepared)
        setOperation(nextOperation)
        setTitle(nextOperation.title)
        setSlug(nextOperation.slug)
      } catch (cause) {
        try {
          const pending = readPendingAtlasCanvasCreate(window.localStorage, scope)
          if (pending) {
            restore(pending)
            return
          }
        } catch {
          setRecoveryBlocked(true)
        }
        setRecoveryBlocked(true)
        setError("Galaxy could not verify the safe creation journal. Review and explicitly discard it before starting another canvas.")
        return
      }
    }

    try {
      nextOperation = requirePendingAtlasCanvasCreate(window.localStorage, scope, nextOperation)
    } catch {
      try {
        const pending = readPendingAtlasCanvasCreate(window.localStorage, scope)
        if (pending) restore(pending)
        else {
          setRecoveryBlocked(true)
          setError("The exact creation journal is missing. Review recovery before sending again.")
        }
      } catch {
        setRecoveryBlocked(true)
        setError("Galaxy could not verify the exact creation journal. Review recovery before sending again.")
      }
      return
    }

    const generation = ++generationRef.current
    setSubmitting(true)
    setAmbiguous(false)
    setError("")
    onBusyChange(true)
    try {
      const response = await galaxyBrainAPI.createCanvas({
        workspaceId: nextOperation.workspaceId,
        slug: nextOperation.slug,
        title: nextOperation.title,
        makeDefault: false,
        projectionMode: nextOperation.projectionMode,
        idempotencyKey: nextOperation.idempotencyKey,
      })
      const confirmed = await confirmAtlasCanvasCreateResponse(response, nextOperation)
      if (generationRef.current !== generation) return
      const href = atlasCanvasHref(confirmed.canvasId)
      window.location.assign(href)
      const removed = removePendingAtlasCanvasCreate(window.localStorage, scope, nextOperation.operationId)
      if (!removed) {
        const pending = readPendingAtlasCanvasCreate(window.localStorage, scope)
        if (pending) throw new TypeError("The confirmed creation journal changed before recovery cleanup")
      }
    } catch (cause) {
      if (generationRef.current !== generation) return
      const failure = safeCreateFailure(cause)
      setAmbiguous(failure.ambiguous)
      setError(failure.message)
      if (!failure.ambiguous) {
        try {
          removePendingAtlasCanvasCreate(window.localStorage, scope, nextOperation.operationId)
          setOperation(null)
        } catch {
          setOperation(nextOperation)
          setAmbiguous(true)
          setError("The request was rejected, but Galaxy could not clear its retry journal. Reload before creating another canvas.")
        }
      }
    } finally {
      if (generationRef.current === generation) {
        setSubmitting(false)
        onBusyChange(false)
      }
    }
  }

  const frozen = operation !== null
  const describedBy = error
    ? "atlas-canvas-create-description atlas-canvas-create-help atlas-canvas-create-error"
    : "atlas-canvas-create-description atlas-canvas-create-help"

  return (
    <>
      <Dialog open={open} onOpenChange={(nextOpen) => nextOpen ? onOpenChange(true) : requestClose()}>
        <DialogContent
          ref={contentRef}
          tabIndex={-1}
          closeDisabled={submitting}
          aria-describedby={describedBy}
          className="atlas-command-presenter research-workbench max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] overflow-y-auto sm:max-w-[480px]"
          onEscapeKeyDown={(event) => { if (submitting) event.preventDefault() }}
          onPointerDownOutside={(event) => { if (submitting) event.preventDefault() }}
          onCloseAutoFocus={(event) => {
            if (focusFirstConnected([returnFocus, fallbackFocus], contentRef.current)) event.preventDefault()
          }}
        >
          <DialogHeader>
            <p className="research-kicker">Atlas canvas</p>
            <DialogTitle className="research-display text-2xl font-semibold">New canvas</DialogTitle>
            <DialogDescription id="atlas-canvas-create-description" className="atlas-command-presenter__muted">
              Create one named spatial view in the current workspace. This does not move objects or replace the workspace default.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={submit}>
            <div className="grid gap-2">
              <Label className="research-kicker" htmlFor="atlas-canvas-create-title">Title</Label>
              <Input
                id="atlas-canvas-create-title"
                className="research-control min-h-11 rounded-lg"
                value={title}
                disabled={submitting || frozen}
                autoFocus
                onChange={(event) => { setTitle(event.target.value); setError("") }}
                placeholder="Proof atlas"
              />
            </div>
            <div className="grid gap-2">
              <Label className="research-kicker" htmlFor="atlas-canvas-create-slug">Slug</Label>
              <Input
                id="atlas-canvas-create-slug"
                className="research-control min-h-11 rounded-lg font-mono"
                value={slug}
                disabled={submitting || frozen}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => { setSlug(event.target.value); setError("") }}
                placeholder="proof-atlas"
              />
            </div>
            <p id="atlas-canvas-create-help" className="atlas-command-presenter__muted text-xs leading-5">
              Use 1–80 lowercase letters, numbers, and hyphens. Titles may be shared; the slug must be unique in this workspace.
              The request freezes on first submission so an uncertain delivery can be retried safely.
            </p>
            {error ? (
              <p id="atlas-canvas-create-error" role="alert" className="atlas-command-presenter__warning rounded-md border border-[hsl(var(--field-alert-strong))] bg-[hsl(var(--field-alert)/0.12)] p-3 text-sm">
                {error}
              </p>
            ) : null}
            <DialogFooter className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" disabled={submitting} onClick={requestClose}>
                {ambiguous || recoveryBlocked ? "Review recovery…" : "Cancel"}
              </Button>
              <Button type="submit" className="min-h-11 w-full sm:w-auto" disabled={submitting || recoveryBlocked || (!frozen && (!title.trim() || !slug.trim()))}>
                {submitting ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
                {submitting ? "Creating…" : ambiguous ? "Retry exact request" : "Create canvas"}
              </Button>
            </DialogFooter>
            <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {submitting ? "Creating the named canvas." : ambiguous ? "Canvas creation outcome unconfirmed. Exact retry is available." : ""}
            </p>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog open={abandonOpen} onOpenChange={setAbandonOpen}>
        <AlertDialogContent className="atlas-command-presenter research-workbench max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>{recoveryBlocked ? "Discard unreadable canvas recovery?" : "Stop retrying this canvas?"}</AlertDialogTitle>
            <AlertDialogDescription className="atlas-command-presenter__muted">
              {recoveryBlocked
                ? "The saved operation cannot be verified, and its request may already have succeeded. Discarding recovery allows a new request that could create another canvas."
                : "The first request may already have succeeded. Retrying the frozen request is safe; abandoning it and creating another canvas can create a duplicate title under a different slug."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">Keep exact retry</AlertDialogCancel>
            <AlertDialogAction className="atlas-command-presenter__danger-action min-h-11" onClick={abandonOperation}>
              I understand — discard recovery
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
