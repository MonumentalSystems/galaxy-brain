"use client"

import { GitMerge, LoaderCircle } from "lucide-react"
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
  ConversationJoinError,
  joinConversationTurns,
  prepareConversationJoinIntent,
  type ConversationJoinIntent,
  type ConversationJoinReceipt,
} from "@/lib/conversation-join-client.js"

export type ConversationJoinTarget = Readonly<{
  tenantId: string
  conversationReference: string
  parentTurnReferences: readonly string[]
  expectedVersion: number
  labels: readonly string[]
}>

export type ConversationJoinDialogProps = {
  open: boolean
  target: ConversationJoinTarget | null
  initialIntent?: ConversationJoinIntent | null
  returnFocus?: HTMLElement | null
  onOpenChange: (open: boolean) => void
  onUncertain: (intent: ConversationJoinIntent, target: ConversationJoinTarget) => void
  onClearUncertain: () => void
  onJoined: (
    receipt: ConversationJoinReceipt,
    intent: ConversationJoinIntent,
    target: ConversationJoinTarget,
  ) => void
}

type JoinPhase = "idle" | "submitting" | "ambiguous" | "confirm-abandon" | "stale"

function snapshotJoinTarget(target: ConversationJoinTarget): ConversationJoinTarget {
  return {
    ...target,
    parentTurnReferences: [...target.parentTurnReferences],
    labels: [...target.labels],
  }
}

export function ConversationJoinDialog({
  open,
  target,
  initialIntent = null,
  returnFocus = null,
  onOpenChange,
  onUncertain,
  onClearUncertain,
  onJoined,
}: ConversationJoinDialogProps) {
  const [message, setMessage] = useState(initialIntent?.message ?? "")
  const [pendingIntent, setPendingIntent] = useState<ConversationJoinIntent | null>(initialIntent)
  const [pendingTarget, setPendingTarget] = useState<ConversationJoinTarget | null>(
    initialIntent && target ? snapshotJoinTarget(target) : null,
  )
  const [phase, setPhase] = useState<JoinPhase>(initialIntent ? "ambiguous" : "idle")
  const [error, setError] = useState("")
  const controllerRef = useRef<AbortController | null>(null)
  const generationRef = useRef(0)

  useEffect(() => () => {
    generationRef.current += 1
    controllerRef.current?.abort()
  }, [])

  const displayedTarget = pendingIntent && pendingTarget ? pendingTarget : target
  const targetShapeError = !displayedTarget
    ? ""
    : displayedTarget.parentTurnReferences.length < 2 || displayedTarget.parentTurnReferences.length > 8
      ? "Choose between two and eight exact turns before opening the synthesis dialog."
      : displayedTarget.labels.length !== displayedTarget.parentTurnReferences.length
        || displayedTarget.labels.some((label) => !label.trim())
        ? "Each selected exact turn needs one ordered label before synthesis can begin."
        : ""

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!displayedTarget || targetShapeError || phase === "submitting" || phase === "stale") return
    setError("")
    let intent = pendingIntent
    let capturedTarget = pendingTarget
    if (!intent) {
      capturedTarget = snapshotJoinTarget(displayedTarget)
      try {
        intent = prepareConversationJoinIntent({
          conversationReference: capturedTarget.conversationReference,
          parentTurnReferences: capturedTarget.parentTurnReferences,
          expectedVersion: capturedTarget.expectedVersion,
          message: message.trim(),
        })
      } catch (cause) {
        setError(cause instanceof ConversationJoinError ? cause.message : "The synthesis request is invalid.")
        return
      }
      setPendingIntent(intent)
      setPendingTarget(capturedTarget)
    }
    if (!capturedTarget) return

    // Dispatch itself crosses the ambiguity boundary: a navigation or reload
    // can abort the browser wait after the server has committed. Preserve the
    // exact frozen request before sending, then clear it only after a verified
    // receipt or a conclusive rejection.
    onUncertain(intent, capturedTarget)

    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const generation = ++generationRef.current
    setPhase("submitting")
    try {
      const receipt = await joinConversationTurns(intent, { signal: controller.signal })
      if (controller.signal.aborted || generationRef.current !== generation) return
      setPendingIntent(null)
      setPendingTarget(null)
      setMessage("")
      setPhase("idle")
      onClearUncertain()
      onJoined(receipt, intent, capturedTarget)
      onOpenChange(false)
    } catch (cause) {
      if (controller.signal.aborted || generationRef.current !== generation) return
      if (cause instanceof ConversationJoinError) {
        setError(cause.message)
        if (cause.code === "stale_conversation") {
          setPendingIntent(null)
          setPendingTarget(null)
          setPhase("stale")
          onClearUncertain()
        } else if (cause.ambiguous) {
          setPhase("ambiguous")
          onUncertain(intent, capturedTarget)
        } else {
          setPendingIntent(null)
          setPendingTarget(null)
          setPhase("idle")
          onClearUncertain()
        }
      } else {
        setError("The conversation synthesis could not be completed.")
        setPendingIntent(null)
        setPendingTarget(null)
        setPhase("idle")
        onClearUncertain()
      }
    } finally {
      if (generationRef.current === generation) controllerRef.current = null
    }
  }

  const submitting = phase === "submitting"
  const retrying = (phase === "ambiguous" || phase === "confirm-abandon") && pendingIntent !== null
  const closeLocked = submitting || retrying
  const describedBy = error || targetShapeError
    ? "conversation-join-description conversation-join-error"
    : "conversation-join-description"

  return (
    <Dialog
      open={open && displayedTarget !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && closeLocked) return
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent
        closeDisabled={closeLocked}
        className="research-panel max-h-[min(46rem,calc(100vh-2rem))] overflow-y-auto border-[color:var(--research-line)] sm:max-w-xl"
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
          <p className="research-kicker">Exact conversation synthesis</p>
          <DialogTitle className="research-display">Join selected turns</DialogTitle>
          <DialogDescription id="conversation-join-description" className="research-muted leading-6">
            Author one synthesis turn with the selected exact turns as its immutable parents. The conversation service records the join; this graph will not invent local lineage.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={submit}>
          <fieldset className="grid gap-2 rounded-xl border border-[color:var(--research-line)] p-3">
            <legend className="px-1 text-sm font-medium">Selected parent turns</legend>
            <ol className="grid gap-2" aria-label="Exact turns that the synthesis will join">
              {displayedTarget?.parentTurnReferences.map((reference, index) => (
                <li key={reference} className="grid min-h-11 grid-cols-[auto_1fr] items-center gap-3 text-sm">
                  <span aria-hidden="true" className="grid size-7 place-items-center rounded-full border border-[color:var(--research-line)] text-xs tabular-nums">
                    {index + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{displayedTarget.labels[index] ?? "Unlabelled turn"}</span>
                    <code className="research-muted block truncate text-xs">{reference}</code>
                  </span>
                </li>
              ))}
            </ol>
          </fieldset>

          <div className="grid gap-2">
            <Label htmlFor="conversation-join-message">Synthesis message</Label>
            <Textarea
              id="conversation-join-message"
              value={message}
              disabled={submitting || retrying || phase === "stale" || Boolean(targetShapeError)}
              aria-invalid={Boolean(error || targetShapeError)}
              aria-describedby={error || targetShapeError ? "conversation-join-help conversation-join-error" : "conversation-join-help"}
              onChange={(event) => { setMessage(event.target.value); setError("") }}
              className="min-h-36"
              placeholder="Reconcile the selected branches, preserve disagreements, and state the resulting conclusion or next question."
              autoFocus
            />
            <p id="conversation-join-help" className="research-muted text-xs leading-5">
              Parent turns, message, retry identity, and expected version freeze on first submission. No artifact, task, proof, relation, or Atlas placement is created.
            </p>
          </div>

          {error || targetShapeError ? (
            <p id="conversation-join-error" role="alert" className="text-sm font-medium text-destructive">
              {error || targetShapeError}
            </p>
          ) : null}
          {phase === "ambiguous" ? (
            <p role="status" className="rounded-xl border border-[color:var(--research-line)] p-3 text-sm leading-6">
              Delivery is uncertain. Retry sends the same frozen parents, message, expected version, and idempotency key. This request remains recoverable in this browser tab until you retry or explicitly abandon it.
            </p>
          ) : null}
          {phase === "confirm-abandon" ? (
            <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm leading-6">
              The server may already have created this synthesis. Abandoning only discards the exact retry identity from this browser tab; it does not undo or repeat the request.
            </p>
          ) : null}
          {phase === "stale" ? (
            <p role="status" className="rounded-xl border border-[color:var(--research-line)] p-3 text-sm leading-6">
              Select the latest exact conversation snapshot, choose the parent turns again, and reopen synthesis. Galaxy will not substitute latest automatically.
            </p>
          ) : null}

          <DialogFooter className="gap-2 sm:space-x-0">
            {phase === "confirm-abandon" ? (
              <>
                <Button className="min-h-11" type="button" variant="outline" onClick={() => setPhase("ambiguous")}>
                  Keep exact retry
                </Button>
                <Button className="min-h-11" type="button" variant="destructive" onClick={() => {
                  setPendingIntent(null)
                  setPendingTarget(null)
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
                  <Button className="min-h-11" type="button" variant="outline" disabled={submitting} onClick={() => setPhase("confirm-abandon")}>
                    Abandon uncertain request…
                  </Button>
                ) : (
                  <Button className="min-h-11" type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
                    Dismiss
                  </Button>
                )}
                <Button className="min-h-11" type="submit" disabled={submitting || phase === "stale" || Boolean(targetShapeError) || (!retrying && !message.trim())}>
                  {submitting ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <GitMerge aria-hidden="true" />}
                  {submitting ? "Creating synthesis…" : retrying ? "Retry exact synthesis" : "Join turns"}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
