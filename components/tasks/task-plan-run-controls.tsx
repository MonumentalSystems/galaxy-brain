"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CircleStop, LoaderCircle, Play, RefreshCw } from "lucide-react"

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
import { Button } from "@/components/ui/button"
import { safeSessionStorage } from "@/lib/browser-utils"
import {
  cancelTaskPlanRun,
  isTaskPlanRunTerminal,
  refreshTaskPlanRun,
  startTaskPlanRun,
  taskPlanRunStartBlocker,
  TaskPlanRunClientError,
  type TaskPlanRunPhase,
  type TaskPlanRunReceipt,
  type TaskPlanRunStatus,
  type TaskPlanRunTask,
} from "@/lib/task-plan-run-client.js"
import type { TaskPlanRecord } from "@/lib/types/task-plans"

export type TaskPlanRunControlsProps = {
  task: TaskPlanRunTask
  record: TaskPlanRecord | null
  mode: "live" | "preview"
  loading: boolean
  saving: boolean
  dirty: boolean
  candidatePending: boolean
  writeBlocked: boolean
  onMutationStateChange?: (pending: boolean) => void
}

type Activity = "idle" | "starting" | "refreshing" | "cancelling"
type TaskRunTone = "core" | "warning" | "danger" | "muted"

const PHASE_COPY: Record<TaskPlanRunPhase, { label: string; description: string; tone: TaskRunTone }> = {
  "wake-requested": {
    label: "Wake requested",
    description: "Hyades recorded the request. This does not yet mean an executor is running.",
    tone: "warning",
  },
  accepted: {
    label: "Accepted",
    description: "Hyades accepted the dispatch. Refresh manually to observe whether execution has started.",
    tone: "warning",
  },
  started: {
    label: "Started",
    description: "Hyades reports that the run has started.",
    tone: "core",
  },
  blocked: {
    label: "Blocked",
    description: "Hyades reports that the run is waiting on a bounded blocker.",
    tone: "warning",
  },
  completed: {
    label: "Completed",
    description: "Hyades reports that the run completed.",
    tone: "core",
  },
  failed: {
    label: "Failed",
    description: "Hyades reports that the run failed.",
    tone: "danger",
  },
  cancelled: {
    label: "Cancelled",
    description: "Hyades reports that cancellation is complete.",
    tone: "muted",
  },
  rejected: {
    label: "Rejected",
    description: "Hyades rejected the run before execution.",
    tone: "danger",
  },
  declined: {
    label: "Declined",
    description: "The executor declined the run before execution.",
    tone: "danger",
  },
}

function baselineIdentity(task: TaskPlanRunTask, record: TaskPlanRecord | null) {
  return record
    ? `${task.id}:${task.version ?? "latest"}:${record.id}:${record.current_version}:${record.current_content_hash}`
    : `${task.id}:${task.version ?? "latest"}:unsaved`
}

function idempotencyStorageKey(task: TaskPlanRunTask, record: TaskPlanRecord) {
  return `task-plan-run-idempotency:${baselineIdentity(task, record)}`
}

function getOrCreateIdempotencyKey(task: TaskPlanRunTask, record: TaskPlanRecord) {
  try {
    const storage = safeSessionStorage()
    const storageKey = idempotencyStorageKey(task, record)
    const existing = storage.getItem(storageKey)
    if (existing && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(existing)) {
      return { key: existing, storageKey }
    }
    const key = crypto.randomUUID()
    storage.setItem(storageKey, key)
    if (storage.getItem(storageKey) !== key) throw new Error("retry identity was not persisted")
    return { key, storageKey }
  } catch (error) {
    throw new TaskPlanRunClientError(
      "retry-storage-unavailable",
      "Run dispatch is unavailable because this browser could not preserve a safe retry identity.",
      { cause: error },
    )
  }
}

function clearIdempotencyKey(storageKey: string) {
  try {
    safeSessionStorage().removeItem(storageKey)
  } catch {
    // Acknowledged receipts are authoritative even if browser cleanup fails.
  }
}

function safeError(error: unknown, fallback: string) {
  return error instanceof TaskPlanRunClientError ? error.message : fallback
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return null
  const timestamp = new Date(value)
  return Number.isNaN(timestamp.valueOf()) ? null : timestamp.toLocaleString()
}

export function TaskPlanRunControls({
  task,
  record,
  mode,
  loading,
  saving,
  dirty,
  candidatePending,
  writeBlocked,
  onMutationStateChange,
}: TaskPlanRunControlsProps) {
  const [activity, setActivity] = useState<Activity>("idle")
  const [receipt, setReceipt] = useState<TaskPlanRunReceipt | null>(null)
  const [snapshot, setSnapshot] = useState<TaskPlanRunStatus | null>(null)
  const [error, setError] = useState("")
  const [announcement, setAnnouncement] = useState("")
  const [startConfirmOpen, setStartConfirmOpen] = useState(false)
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false)
  const operationRef = useRef<{ generation: number; controller: AbortController | null }>({ generation: 0, controller: null })
  const contextKey = `${task.id}:${task.version ?? "latest"}`
  const currentContextRef = useRef(contextKey)
  const currentRunIdRef = useRef("")
  currentContextRef.current = contextKey

  useEffect(() => {
    operationRef.current.generation += 1
    operationRef.current.controller?.abort()
    operationRef.current.controller = null
    setActivity("idle")
    setReceipt(null)
    setSnapshot(null)
    setError("")
    setAnnouncement("")
    setStartConfirmOpen(false)
    setCancelConfirmOpen(false)
    return () => {
      operationRef.current.generation += 1
      operationRef.current.controller?.abort()
      operationRef.current.controller = null
    }
  }, [contextKey])

  const mutationPending = activity === "starting" || activity === "cancelling"
  useEffect(() => {
    onMutationStateChange?.(mutationPending)
    return () => onMutationStateChange?.(false)
  }, [mutationPending, onMutationStateChange])

  const runId = snapshot?.runId || receipt?.runId || task.activeRun?.id || ""
  currentRunIdRef.current = runId
  const phase = snapshot?.phase || receipt?.state || null
  const phaseCopy = phase ? PHASE_COPY[phase] : null
  const runPresent = Boolean(runId)
  const startDisabledReason = taskPlanRunStartBlocker({
    task,
    taskPlan: record,
    mode,
    loading,
    saving,
    dirty,
    candidatePending,
    writeBlocked,
    runPresent,
  })
  const canRefresh = mode === "live" && Boolean(runId) && activity === "idle"
  const canCancel = mode === "live" && Boolean(runId) && Boolean(phase) && !isTaskPlanRunTerminal(phase || "") && activity === "idle"

  const beginOperation = useCallback((nextActivity: Activity) => {
    // State updates are not synchronous, so use the live controller as the
    // immediate lock against double-clicks and competing run operations.
    if (operationRef.current.controller) return null
    const controller = new AbortController()
    const generation = operationRef.current.generation + 1
    operationRef.current = { generation, controller }
    setActivity(nextActivity)
    setError("")
    return { generation, controller, context: currentContextRef.current }
  }, [])

  const operationOwnsSlot = useCallback((operation: { generation: number; context: string }) => (
    operationRef.current.generation === operation.generation
    && currentContextRef.current === operation.context
  ), [])

  const operationIsCurrent = useCallback((operation: {
    generation: number
    context: string
    runId?: string
  }) => {
    if (operationRef.current.generation !== operation.generation
      || currentContextRef.current !== operation.context) return false
    return operation.runId === undefined || currentRunIdRef.current === operation.runId
  }, [])

  const start = useCallback(async () => {
    if (startDisabledReason || !record) return
    const submittedTask = task
    const submittedRecord = record
    const operation = beginOperation("starting")
    if (!operation) return
    setStartConfirmOpen(false)
    setAnnouncement(`Submitting saved plan revision ${submittedRecord.current_version}. Browser drafts are not included.`)
    try {
      const idempotency = getOrCreateIdempotencyKey(submittedTask, submittedRecord)
      const nextReceipt = await startTaskPlanRun(submittedTask, submittedRecord, {
        idempotencyKey: idempotency.key,
        signal: operation.controller.signal,
      })
      if (!operationIsCurrent(operation)) return
      clearIdempotencyKey(idempotency.storageKey)
      setReceipt(nextReceipt)
      setSnapshot(null)
      setAnnouncement(nextReceipt.state === "wake-requested"
        ? "Wake requested. Execution has not been observed; refresh manually for current status."
        : nextReceipt.state === "accepted"
          ? "Dispatch accepted. Execution has not been observed; refresh manually for current status."
          : `Hyades returned phase ${PHASE_COPY[nextReceipt.state].label.toLowerCase()}.`)
    } catch (nextError) {
      if (operation.controller.signal.aborted || !operationIsCurrent(operation)) return
      // The stable key remains in session storage after any ambiguous response,
      // including a close/reopen, so retry reaches Hyades' replay ledger.
      setError(safeError(nextError, "The exact saved plan could not be started. Retry the same request."))
      setAnnouncement(nextError instanceof TaskPlanRunClientError && nextError.code === "retry-storage-unavailable"
        ? "No run request was sent because safe retry storage is unavailable."
        : "The run request was not acknowledged. Its stable retry identity was preserved.")
    } finally {
      if (operationOwnsSlot(operation)) {
        operationRef.current.controller = null
        setActivity("idle")
      }
    }
  }, [beginOperation, operationIsCurrent, operationOwnsSlot, record, startDisabledReason, task])

  const refresh = useCallback(async () => {
    if (!canRefresh || !runId) return
    const pendingOperation = beginOperation("refreshing")
    if (!pendingOperation) return
    const operation = { ...pendingOperation, runId }
    setAnnouncement("Refreshing this exact Hyades run on request.")
    try {
      const nextSnapshot = await refreshTaskPlanRun(task.id, runId, { signal: operation.controller.signal })
      if (!operationIsCurrent(operation)) return
      setSnapshot(nextSnapshot)
      setAnnouncement(`Observed ${PHASE_COPY[nextSnapshot.phase].label.toLowerCase()} from Hyades.`)
    } catch (nextError) {
      if (operation.controller.signal.aborted || !operationIsCurrent(operation)) return
      setError(safeError(nextError, "The run could not be refreshed. The last visible snapshot is unchanged."))
      setAnnouncement("Refresh failed. The last visible run snapshot was preserved.")
    } finally {
      if (operationOwnsSlot(operation)) {
        operationRef.current.controller = null
        setActivity("idle")
      }
    }
  }, [beginOperation, canRefresh, operationIsCurrent, operationOwnsSlot, runId, task.id])

  const cancel = useCallback(async () => {
    if (!canCancel || !runId) return
    const pendingOperation = beginOperation("cancelling")
    if (!pendingOperation) return
    const operation = { ...pendingOperation, runId }
    setCancelConfirmOpen(false)
    setAnnouncement("Requesting cancellation for this exact Hyades run.")
    try {
      const nextSnapshot = await cancelTaskPlanRun(task.id, runId, { signal: operation.controller.signal })
      if (!operationIsCurrent(operation)) return
      setSnapshot(nextSnapshot)
      setAnnouncement(nextSnapshot.phase === "cancelled"
        ? "Hyades confirms that cancellation is complete."
        : `Cancellation was requested; Hyades currently reports ${PHASE_COPY[nextSnapshot.phase].label.toLowerCase()}.`)
    } catch (nextError) {
      if (operation.controller.signal.aborted || !operationIsCurrent(operation)) return
      setError(safeError(nextError, "The run could not be cancelled. The last visible snapshot is unchanged."))
      setAnnouncement("Cancellation failed. The last visible run snapshot was preserved.")
    } finally {
      if (operationOwnsSlot(operation)) {
        operationRef.current.controller = null
        setActivity("idle")
      }
    }
  }, [beginOperation, canCancel, operationIsCurrent, operationOwnsSlot, runId, task.id])

  const observedTime = useMemo(() => formatTimestamp(
    snapshot?.lastHeartbeatAt || snapshot?.completedAt || snapshot?.createdAt,
  ), [snapshot?.completedAt, snapshot?.createdAt, snapshot?.lastHeartbeatAt])

  return (
    <section className="task-constructor__card mt-3 rounded-xl border p-3" aria-labelledby={`task-run-${task.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={`task-run-${task.id}`} className="task-constructor__muted research-smallcaps text-xs">Saved-plan execution</h3>
          <p className="task-constructor__muted mt-1 text-xs leading-5">
            Starts only the exact immutable revision shown above. Unsaved edits and proposed jobs are never included.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!runPresent ? (
            <Button
              type="button"
              onClick={() => setStartConfirmOpen(true)}
              disabled={Boolean(startDisabledReason) || activity !== "idle"}
              title={startDisabledReason || "Review the exact saved revision before dispatch"}
              className="task-constructor__primary min-h-11"
            >
              {activity === "starting" ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
              {activity === "starting" ? "Starting…" : "Start run"}
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => void refresh()} disabled={!canRefresh} className="task-constructor__control min-h-11">
                <RefreshCw className={`h-4 w-4 ${activity === "refreshing" ? "animate-spin" : ""}`} aria-hidden="true" />
                {activity === "refreshing" ? "Refreshing…" : "Refresh"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setCancelConfirmOpen(true)} disabled={!canCancel} className="task-constructor__danger min-h-11">
                {activity === "cancelling" ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CircleStop className="h-4 w-4" aria-hidden="true" />}
                {activity === "cancelling" ? "Cancelling…" : "Request cancellation"}
              </Button>
            </>
          )}
        </div>
      </div>

      {startDisabledReason && !runPresent ? <p className="task-constructor__muted mt-2 text-xs">{startDisabledReason}</p> : null}
      {runPresent ? (
        <div className="task-constructor__notice mt-3 rounded-lg border px-3 py-2 text-sm" data-tone={phaseCopy?.tone === "muted" ? undefined : phaseCopy?.tone}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong>{phaseCopy?.label || "Active run reported by HAM"}</strong>
            <code className="break-all text-[11px]">{runId}</code>
          </div>
          <p className="mt-1 text-xs leading-5">
            {phaseCopy?.description || "Refresh manually to verify the current phase with Hyades."}
          </p>
          {receipt || snapshot ? (
            <p className="mt-1 break-all font-mono text-[11px] opacity-80">
              Plan {(snapshot || receipt)?.taskPlanId} · revision {(snapshot || receipt)?.taskPlanVersion} · {(snapshot || receipt)?.taskPlanContentSha256}
            </p>
          ) : null}
          {snapshot?.blockReason ? <p className="mt-1 text-xs">Bounded blocker: {snapshot.blockReason.replaceAll("_", " ")}</p> : null}
          {observedTime ? <p className="mt-1 text-[11px] opacity-80">Last observed {observedTime}</p> : null}
        </div>
      ) : null}
      {error ? <p role="alert" className="task-constructor__notice mt-3 rounded-lg border px-3 py-2 text-sm" data-tone="danger">{error}</p> : null}
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>

      <AlertDialog open={startConfirmOpen} onOpenChange={setStartConfirmOpen}>
        <AlertDialogContent className="task-constructor-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Start this exact saved plan?</AlertDialogTitle>
            <AlertDialogDescription>
              {record
                ? `Start task ${task.id} version ${task.version} from immutable plan revision ${record.current_version}. Unsaved browser edits and pending proposals are not included.`
                : "A saved exact task-plan revision is required."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep reviewing</AlertDialogCancel>
            <AlertDialogAction onClick={() => void start()} disabled={Boolean(startDisabledReason)} className="task-constructor__primary">
              Start saved revision
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={cancelConfirmOpen} onOpenChange={setCancelConfirmOpen}>
        <AlertDialogContent className="task-constructor-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Request cancellation?</AlertDialogTitle>
            <AlertDialogDescription>
              Ask Hyades to cancel run {runId || "unknown"}. The displayed phase will change only to the phase Hyades actually returns.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep run</AlertDialogCancel>
            <AlertDialogAction onClick={() => void cancel()} disabled={!canCancel} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Request cancellation
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
