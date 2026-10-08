"use client"

import dynamic from "next/dynamic"
import { useCallback, useEffect, useRef, useState } from "react"

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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { DetachedTaskPlanDraft, TaskConstructorTask } from "@/components/tasks/task-constructor"
import { getTaskConstructorCloseDecision } from "@/lib/task-plan"
import type { TaskPlanProposal, TaskPlanProposalDecision } from "@/lib/types/task-plans"

const TaskConstructor = dynamic(
  () => import("@/components/tasks/task-constructor").then((module) => module.TaskConstructor),
  {
    ssr: false,
    loading: () => <p role="status" className="p-6 text-sm text-muted-foreground">Loading the task constructor.</p>,
  },
)

export type TaskConstructorDialogProps = {
  task: TaskConstructorTask | null
  open: boolean
  onOpenChange: (open: boolean) => void
  returnFocus: HTMLElement | null
  fallbackFocus?: HTMLElement | null
  mode?: "live" | "preview"
  initialDraft?: DetachedTaskPlanDraft | null
  proposalCandidate?: TaskPlanProposal | null
  onProposalDecision?: (decision: TaskPlanProposalDecision) => void
}

type TaskConstructorInteractionState = {
  dirty: boolean
  saving: boolean
  candidatePending: boolean
  verifiedCandidate: TaskPlanProposal | null
  verifiedProposalHash: string | null
  verifiedTaskId: string | null
  runMutating: boolean
}

const EMPTY_INTERACTION_STATE: TaskConstructorInteractionState = {
  dirty: false,
  saving: false,
  candidatePending: false,
  verifiedCandidate: null,
  verifiedProposalHash: null,
  verifiedTaskId: null,
  runMutating: false,
}

function focusFirstAvailable(candidates: Array<HTMLElement | null>, excludedRoot?: HTMLElement | null) {
  for (const candidate of candidates) {
    if (
      !candidate?.isConnected
      || excludedRoot?.contains(candidate)
      || candidate.matches(":disabled, [aria-disabled='true'], [inert], [inert] *")
    ) continue
    candidate.focus({ preventScroll: true })
    if (document.activeElement === candidate) return true
  }
  return false
}

export function TaskConstructorDialog({
  task,
  open,
  onOpenChange,
  returnFocus,
  fallbackFocus = null,
  mode = "live",
  initialDraft = null,
  proposalCandidate = null,
  onProposalDecision,
}: TaskConstructorDialogProps) {
  const [interactionState, setInteractionState] = useState<TaskConstructorInteractionState>(EMPTY_INTERACTION_STATE)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [closeStatus, setCloseStatus] = useState("")
  const contentRef = useRef<HTMLDivElement | null>(null)
  const focusBeforeDiscardRef = useRef<HTMLElement | null>(null)
  const discardConfirmedRef = useRef(false)
  useEffect(() => {
    if (open) return
    setInteractionState(EMPTY_INTERACTION_STATE)
    setDiscardOpen(false)
    setCloseStatus("")
    discardConfirmedRef.current = false
  }, [open])

  const requestOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      onOpenChange(true)
      return
    }
    const decision = getTaskConstructorCloseDecision(interactionState)
    if (decision === "wait") {
      setCloseStatus(interactionState.runMutating
        ? "Wait for the current run request to finish before closing the constructor."
        : "Wait for the current plan save to finish before closing the constructor.")
      return
    }
    if (decision === "confirm") {
      const activeElement = document.activeElement
      focusBeforeDiscardRef.current = activeElement instanceof HTMLElement && contentRef.current?.contains(activeElement)
        ? activeElement
        : contentRef.current
      setCloseStatus("Unsaved task-plan work needs confirmation before closing.")
      setDiscardOpen(true)
      return
    }
    setCloseStatus("")
    onOpenChange(false)
  }, [interactionState, onOpenChange])

  const discardDraft = useCallback(() => {
    discardConfirmedRef.current = true
    if (interactionState.candidatePending
      && interactionState.verifiedCandidate === proposalCandidate
      && interactionState.verifiedTaskId === task?.id
      && interactionState.verifiedProposalHash) {
      onProposalDecision?.({ proposalHash: interactionState.verifiedProposalHash, outcome: "dismissed" })
    }
    setDiscardOpen(false)
    setInteractionState(EMPTY_INTERACTION_STATE)
    setCloseStatus("")
    onOpenChange(false)
  }, [interactionState, onOpenChange, onProposalDecision, proposalCandidate, task?.id])

  return (
    <Dialog open={open} onOpenChange={requestOpenChange}>
      <DialogContent
        ref={contentRef}
        tabIndex={-1}
        className="task-constructor-dialog max-h-[calc(100dvh-1rem)] max-w-[min(96vw,1600px)] overflow-y-auto p-2 sm:max-h-[94vh] sm:p-3"
        onEscapeKeyDown={(event) => {
          if (discardOpen) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (discardOpen) event.preventDefault()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          focusFirstAvailable([returnFocus, fallbackFocus], contentRef.current)
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{task ? `Construct plan for ${task.title}` : "Task constructor"}</DialogTitle>
          <DialogDescription>Build and version an atomic job plan associated with this canonical HAM task.</DialogDescription>
        </DialogHeader>
        {closeStatus ? (
          <p role="status" aria-live="polite" className="task-constructor__notice mx-2 rounded-lg border px-3 py-2 text-sm" data-tone="warning">
            {closeStatus}
          </p>
        ) : null}
        {task ? (
          <TaskConstructor
            task={task}
            mode={mode}
            initialDraft={initialDraft}
            proposalCandidate={proposalCandidate}
            onProposalDecision={onProposalDecision}
            onInteractionStateChange={setInteractionState}
          />
        ) : null}
        <AlertDialog
          open={discardOpen}
          onOpenChange={(nextOpen) => {
            setDiscardOpen(nextOpen)
            if (!nextOpen && !discardConfirmedRef.current) setCloseStatus("Continue editing the unsaved task plan.")
          }}
        >
          <AlertDialogContent
            className="task-constructor-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              if (discardConfirmedRef.current) return
              focusFirstAvailable([focusBeforeDiscardRef.current, contentRef.current])
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Discard unsaved task-plan work?</AlertDialogTitle>
              <AlertDialogDescription>
                Closing now will discard the current browser draft and any pending task-plan candidate. No immutable revision will be created.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction onClick={discardDraft} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                Discard work
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}
