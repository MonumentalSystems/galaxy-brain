"use client"

import { GitBranch, LoaderCircle } from "lucide-react"
import { useEffect, useRef, useState, type FormEvent } from "react"

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
import { Textarea } from "@/components/ui/textarea"
import {
  ConversationForkError,
  forkConversationTurn,
  prepareConversationForkIntent,
  type ConversationForkIntent,
  type ConversationForkReceipt,
} from "@/lib/conversation-fork-client.js"

export type ConversationForkTarget = Readonly<{
  tenantId: string
  conversationReference: string
  parentTurnReference: string
  expectedVersion: number
  title: string
}>

export type ConversationForkDialogProps = {
  open: boolean
  target: ConversationForkTarget | null
  initialIntent?: ConversationForkIntent | null
  returnFocus?: HTMLElement | null
  onOpenChange: (open: boolean) => void
  onUncertain: (intent: ConversationForkIntent, target: ConversationForkTarget) => void
  onClearUncertain: () => void
  onForked: (
    receipt: ConversationForkReceipt,
    intent: ConversationForkIntent,
    target: ConversationForkTarget,
  ) => void
}

type ForkPhase = "idle" | "submitting" | "ambiguous" | "confirm-abandon" | "stale"

export function ConversationForkDialog({
  open,
  target,
  initialIntent = null,
  returnFocus = null,
  onOpenChange,
  onUncertain,
  onClearUncertain,
  onForked,
}: ConversationForkDialogProps) {
  const [message, setMessage] = useState(initialIntent?.message ?? "")
  const [pendingIntent, setPendingIntent] = useState<ConversationForkIntent | null>(initialIntent)
  const [phase, setPhase] = useState<ForkPhase>(initialIntent ? "ambiguous" : "idle")
  const [error, setError] = useState("")
  const controllerRef = useRef<AbortController | null>(null)
  const generationRef = useRef(0)

  useEffect(() => () => {
    generationRef.current += 1
    controllerRef.current?.abort()
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!target || phase === "submitting" || phase === "stale") return
    setError("")
    let intent = pendingIntent
    if (!intent) {
      try {
        intent = prepareConversationForkIntent({
          conversationReference: target.conversationReference,
          parentTurnReference: target.parentTurnReference,
          expectedVersion: target.expectedVersion,
          message: message.trim(),
        })
      } catch (cause) {
        setError(cause instanceof ConversationForkError ? cause.message : "The fork request is invalid.")
        return
      }
      setPendingIntent(intent)
    }

    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const generation = ++generationRef.current
    const capturedTarget = target
    setPhase("submitting")
    try {
      const receipt = await forkConversationTurn(intent, { signal: controller.signal })
      if (controller.signal.aborted || generationRef.current !== generation) return
      setPendingIntent(null)
      setMessage("")
      setPhase("idle")
      onClearUncertain()
      onForked(receipt, intent, capturedTarget)
      onOpenChange(false)
    } catch (cause) {
      if (controller.signal.aborted || generationRef.current !== generation) return
      if (cause instanceof ConversationForkError) {
        setError(cause.message)
        if (cause.code === "stale_conversation") {
          setPendingIntent(null)
          setPhase("stale")
          onClearUncertain()
        } else if (cause.ambiguous) {
          setPhase("ambiguous")
          onUncertain(intent, capturedTarget)
        } else {
          setPendingIntent(null)
          setPhase("idle")
          onClearUncertain()
        }
      } else {
        setError("The conversation fork could not be completed.")
        setPhase("idle")
        setPendingIntent(null)
        onClearUncertain()
      }
    } finally {
      if (generationRef.current === generation) controllerRef.current = null
    }
  }

  const submitting = phase === "submitting"
  const retrying = (phase === "ambiguous" || phase === "confirm-abandon") && pendingIntent !== null
  const closeLocked = submitting || retrying
  const describedBy = error ? "conversation-fork-description conversation-fork-error" : "conversation-fork-description"

  return (
    <Dialog
      open={open && target !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && closeLocked) return
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent
        closeDisabled={closeLocked}
        className="research-panel max-h-[min(42rem,calc(100vh-2rem))] overflow-y-auto border-[color:var(--research-line)] sm:max-w-xl"
        aria-describedby={describedBy}
        onEscapeKeyDown={(event) => { if (closeLocked) event.preventDefault() }}
        onPointerDownOutside={(event) => { if (closeLocked) event.preventDefault() }}
        onCloseAutoFocus={(event) => {
          const destination = returnFocus?.isConnected
            ? returnFocus
            : document.querySelector<HTMLElement>("[data-conversation-graph-focus-fallback]")
          if (!destination) return
          event.preventDefault()
          destination.focus()
        }}
      >
        <DialogHeader>
          <p className="research-kicker">Exact conversation branch</p>
          <DialogTitle className="research-display">Fork from this turn</DialogTitle>
          <DialogDescription id="conversation-fork-description" className="research-muted leading-6">
            Add one user-authored turn branching from <strong>{target?.title ?? "the selected exact turn"}</strong>.
            The conversation service will append the immutable branch; this graph will not invent local conversation state.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={submit}>
          <div className="grid gap-2">
            <Label htmlFor="conversation-fork-message">First message on the new branch</Label>
            <Textarea
              id="conversation-fork-message"
              value={message}
              disabled={submitting || retrying || phase === "stale"}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "conversation-fork-help conversation-fork-error" : "conversation-fork-help"}
              onChange={(event) => { setMessage(event.target.value); setError("") }}
              className="min-h-36"
              placeholder="State the question, alternative, or assumption this branch should explore."
              autoFocus
            />
            <p id="conversation-fork-help" className="research-muted text-xs leading-5">
              The retry identity and exact message freeze on first submission. No artifact, task, proof, relation, or Atlas placement is created.
            </p>
          </div>

          {error ? <p id="conversation-fork-error" role="alert" className="text-sm font-medium text-destructive">{error}</p> : null}
          {phase === "ambiguous" ? (
            <p role="status" className="rounded-xl border border-[color:var(--research-line)] p-3 text-sm leading-6">
              Delivery is uncertain. Retry sends the same frozen body and idempotency key. This request remains recoverable in this browser tab until you retry or explicitly abandon it.
            </p>
          ) : null}
          {phase === "confirm-abandon" ? (
            <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm leading-6">
              The server may already have created this branch. Abandoning only discards the exact retry identity from this browser tab; it does not undo or repeat the request.
            </p>
          ) : null}
          {phase === "stale" ? (
            <p role="status" className="rounded-xl border border-[color:var(--research-line)] p-3 text-sm leading-6">
              Select the latest exact conversation snapshot in the conversation browser, then choose the turn again. Galaxy will not substitute latest automatically.
            </p>
          ) : null}

          <DialogFooter className="gap-2 sm:space-x-0">
            {phase === "confirm-abandon" ? (
              <>
                <Button type="button" variant="outline" onClick={() => setPhase("ambiguous")}>Keep exact retry</Button>
                <Button type="button" variant="destructive" onClick={() => {
                  setPendingIntent(null)
                  setPhase("idle")
                  onClearUncertain()
                  onOpenChange(false)
                }}>
                  I understand — abandon request
                </Button>
              </>
            ) : (
              <>
                {retrying ? (
                  <Button type="button" variant="outline" disabled={submitting} onClick={() => setPhase("confirm-abandon")}>Abandon uncertain request…</Button>
                ) : (
                  <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>Dismiss</Button>
                )}
                <Button type="submit" disabled={submitting || phase === "stale" || (!retrying && !message.trim())}>
                  {submitting ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <GitBranch aria-hidden="true" />}
                  {submitting ? "Creating branch…" : retrying ? "Retry exact fork" : "Create branch"}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
