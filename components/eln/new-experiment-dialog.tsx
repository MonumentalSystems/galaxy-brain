"use client"

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { focusFirstConnected } from "@/components/atlas/presenter-focus"
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/use-toast"
import {
  GalaxyBrainAPIError,
  galaxyBrainAPI,
  type CreateExperimentInput,
  type Experiment,
} from "@/lib/galaxy-brain-api"
import {
  elnExperimentRecoveryNamespace,
  listPendingExperimentCreates,
  removePendingExperimentCreate,
  writePendingExperimentCreate,
  type ElnExperimentRecoveryScope,
} from "@/lib/eln-experiment-recovery.js"

const DOMAINS = [
  "general",
  "kuramoto",
  "gelation",
  "neurogenesis",
  "memory",
  "fusion",
  "corpus",
  "tokenization",
] as const

interface NewExperimentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (experiment: Experiment, operationId: string) => void
  navigateOnCreated?: boolean
  recoveryScope: ElnExperimentRecoveryScope
  returnFocus?: HTMLElement | null
  fallbackFocus?: HTMLElement | null
}

type ExperimentCreateOperation = Readonly<{
  operationId: string
  input: CreateExperimentInput
}>

function safeCreateError(error: unknown) {
  if (error instanceof GalaxyBrainAPIError) {
    if (error.status === 401) return "Your session expired. Sign in again before retrying this exact request."
    if (error.status === 403) return "You do not have permission to create a research record."
    if (error.status === 409) return "This operation key conflicts with another request. Abandon it and start a new record."
    if (error.status === 410) return "This operation created a record that was later deleted. Abandon it before starting a new record."
    if (error.status === 422) return "The research record was rejected. Abandon this retry and check its fields."
  }
  return "The creation outcome is unconfirmed. Retry the exact request; Galaxy Brain will not create it twice."
}

export function NewExperimentDialog({
  open,
  onOpenChange,
  onCreated,
  navigateOnCreated = true,
  recoveryScope,
  returnFocus,
  fallbackFocus,
}: NewExperimentDialogProps) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  const [operation, setOperation] = useState<ExperimentCreateOperation | null>(null)
  const [error, setError] = useState("")
  const [abandonOpen, setAbandonOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)

  const [title, setTitle] = useState("")
  const [hypothesis, setHypothesis] = useState("")
  const [domain, setDomain] = useState("general")
  const [wandbRunId, setWandbRunId] = useState("")
  const [wandbProject, setWandbProject] = useState("")

  const restoreOperation = useCallback((pending: ExperimentCreateOperation) => {
    setOperation(pending)
    setTitle(pending.input.title)
    setHypothesis(pending.input.hypothesis || "")
    setDomain(pending.input.domain || "general")
    setWandbRunId(pending.input.wandb_run_id || "")
    setWandbProject(pending.input.wandb_project || "")
    setError("A previous creation outcome is unconfirmed. Retry this exact request before starting another record.")
  }, [])

  useEffect(() => {
    if (!open || operation || typeof window === "undefined") return
    try {
      const [pending] = listPendingExperimentCreates(window.localStorage, recoveryScope)
      if (pending) restoreOperation(pending)
    } catch {
      setError("Galaxy Brain could not open the safe creation journal. Reload before creating a record.")
    }
  }, [open, operation, recoveryScope, restoreOperation])

  useEffect(() => {
    if (!open || typeof window === "undefined") return
    const namespace = elnExperimentRecoveryNamespace(recoveryScope)
    const refresh = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage || !event.key?.startsWith(namespace) || operation) return
      const [pending] = listPendingExperimentCreates(window.localStorage, recoveryScope)
      if (pending) restoreOperation(pending)
    }
    window.addEventListener("storage", refresh)
    return () => window.removeEventListener("storage", refresh)
  }, [open, operation, recoveryScope, restoreOperation])

  const resetDraft = () => {
    setTitle("")
    setHypothesis("")
    setDomain("general")
    setWandbRunId("")
    setWandbProject("")
    setOperation(null)
    setError("")
    setAbandonOpen(false)
  }

  const closeConfirmed = () => {
    resetDraft()
    onOpenChange(false)
  }

  const requestClose = () => {
    if (submitting) return
    if (operation) {
      setAbandonOpen(true)
      return
    }
    closeConfirmed()
  }

  const abandonOperation = () => {
    if (operation && typeof window !== "undefined") {
      removePendingExperimentCreate(window.localStorage, recoveryScope, operation.operationId)
    }
    closeConfirmed()
  }

  const handleSubmit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
    if (submitting) return
    if (!title.trim()) {
      toast({ title: "Title required", description: "Please enter an experiment title.", variant: "destructive" })
      return
    }

    let nextOperation = operation
    if (!nextOperation) {
      const draft = Object.freeze({
        operationId: crypto.randomUUID(),
        input: Object.freeze({
        title: title.trim(),
        hypothesis: hypothesis.trim(),
        domain,
        ...(wandbRunId.trim() ? { wandb_run_id: wandbRunId.trim() } : {}),
        ...(wandbProject.trim() ? { wandb_project: wandbProject.trim() } : {}),
        }),
      })
      try {
        nextOperation = writePendingExperimentCreate(window.localStorage, recoveryScope, draft)
        setOperation(nextOperation)
      } catch {
        setError("Galaxy Brain could not save a safe retry journal, so no creation request was sent.")
        return
      }
    }
    setError("")
    setSubmitting(true)
    try {
      const result = await galaxyBrainAPI.createExperiment(
        nextOperation.input,
        `experiment-create:${nextOperation.operationId}`,
      )

      if (!result) {
        throw new Error("Experiment creation returned no confirmation")
      }

      /*
        The record exists, so the journal entry has done its job and is cleared
        before anything downstream runs. It used to be cleared after onCreated,
        and a caller that threw — placing the new experiment on an atlas, say —
        orphaned the entry: the form then reopened locked to a retry of a
        request that had already succeeded, for every canvas, until localStorage
        was cleared by hand.
      */
      removePendingExperimentCreate(window.localStorage, recoveryScope, nextOperation.operationId)
      /*
        The experiment is real either way, so say so before anything about
        placing it. A placement that fails keeps the dialog open to show why:
        closing it resets the draft and takes the message with it, which left
        the record created, the atlas unchanged, and nothing on screen saying
        so.
      */
      toast({ title: "Experiment created", description: `"${result.title}" is ready.` })
      try {
        onCreated?.(result, nextOperation.operationId)
      } catch (placementError) {
        setError(safeCreateError(placementError))
        return
      }
      closeConfirmed()
      if (navigateOnCreated) router.push(`/eln/experiment/${result.id}`)
    } catch (creationError) {
      setError(safeCreateError(creationError))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onOpenChange(true)
        else requestClose()
      }}
    >
      <DialogContent
        ref={contentRef}
        tabIndex={-1}
        className="atlas-command-presenter research-workbench max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] overflow-y-auto sm:max-w-[480px]"
        onCloseAutoFocus={(event) => {
          if (focusFirstConnected([returnFocus, fallbackFocus], contentRef.current)) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="research-display text-2xl font-semibold">New Experiment</DialogTitle>
          <DialogDescription className="atlas-command-presenter__muted">
            Start a new lab notebook entry. You can fill in protocol and results later.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4 py-2" onSubmit={handleSubmit}>
          {/* Title */}
          <div className="space-y-1.5">
            <Label className="research-kicker" htmlFor="exp-title">
              Title <span className="atlas-command-presenter__warning">*</span>
            </Label>
            <Input
              id="exp-title"
              className="research-control h-11 rounded-lg"
              placeholder="e.g. Kuramoto sync threshold at N=512"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={submitting || operation !== null}
            />
          </div>

          {/* Initial hypothesis */}
          <div className="space-y-1.5">
            <Label className="research-kicker" htmlFor="exp-hypothesis">Initial Hypothesis</Label>
            <Textarea
              id="exp-hypothesis"
              placeholder="What do you expect to happen and why?"
              className="research-control min-h-20 resize-y rounded-lg"
              value={hypothesis}
              onChange={(e) => setHypothesis(e.target.value)}
              disabled={submitting || operation !== null}
            />
          </div>

          {/* Domain */}
          <div className="space-y-1.5">
            <Label className="research-kicker" htmlFor="exp-domain">Domain</Label>
            <Select value={domain} onValueChange={setDomain} disabled={submitting || operation !== null}>
              <SelectTrigger id="exp-domain" className="research-control h-11 rounded-lg">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DOMAINS.map((d) => (
                  <SelectItem key={d} value={d} className="capitalize">
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* W&B */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="research-kicker" htmlFor="exp-wandb-run">W&amp;B Run ID</Label>
              <Input
                id="exp-wandb-run"
                className="research-control h-11 rounded-lg"
                placeholder="Optional"
                value={wandbRunId}
                onChange={(e) => setWandbRunId(e.target.value)}
                disabled={submitting || operation !== null}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="research-kicker" htmlFor="exp-wandb-project">W&amp;B Project</Label>
              <Input
                id="exp-wandb-project"
                className="research-control h-11 rounded-lg"
                placeholder="Optional"
                value={wandbProject}
                onChange={(e) => setWandbProject(e.target.value)}
                disabled={submitting || operation !== null}
              />
            </div>
          </div>
          {error ? (
            <p role="alert" className="atlas-command-presenter__warning rounded-md border border-[hsl(var(--field-alert-strong))] bg-[hsl(var(--field-alert)/0.12)] p-3 text-sm">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full rounded-lg shadow-none sm:w-auto"
              onClick={requestClose}
              disabled={submitting}
            >
              {operation ? "Abandon retry" : "Cancel"}
            </Button>
            <Button
              type="submit"
              className="min-h-11 w-full rounded-lg px-4 shadow-none sm:w-auto"
              disabled={submitting || !title.trim()}
            >
              {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {submitting ? "Creating…" : operation ? "Retry exact request" : "Create Experiment"}
            </Button>
          </DialogFooter>
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {submitting ? "Creating the research record." : operation && error ? "Creation outcome unconfirmed. Exact retry is available." : ""}
          </p>
        </form>
      </DialogContent>
      <AlertDialog open={abandonOpen} onOpenChange={setAbandonOpen}>
        <AlertDialogContent className="atlas-command-presenter research-workbench max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Stop retrying this research record?</AlertDialogTitle>
            <AlertDialogDescription className="atlas-command-presenter__muted">
              The first request may already have succeeded. Retrying the exact request is safe; abandoning it and
              creating a new one later can produce a second record.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Continue safe retry</AlertDialogCancel>
            <AlertDialogAction onClick={abandonOperation}>Abandon creation retry</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
