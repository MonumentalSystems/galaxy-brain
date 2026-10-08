"use client"

import { FormEvent, useEffect, useRef, useState } from "react"
import { AlertTriangle, Bot, Box, Clock3 } from "lucide-react"

import { TaskStatusBadge } from "@/components/tasks/task-status-badge"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { fetchAllTaskEvents, fetchTaskDetail, recordExternalTaskCompletion } from "@/lib/ham-task-client"
import { formatTaskFreshness } from "@/lib/ham-task-adapter"
import { loadTaskDocumentSources } from "@/lib/task-document-source.js"
import type { TaskDetail, TaskEvent, TaskSummary } from "@/lib/types/tasks"

type TaskDetailDialogProps = {
  task: TaskSummary | null
  open: boolean
  onOpenChange: (open: boolean) => void
  returnFocus: HTMLButtonElement | null
  allowMutations: boolean
}

function hasActionableVersion(detail: TaskDetail | null): detail is TaskDetail & { version: number } {
  return typeof detail?.version === "number" && Number.isSafeInteger(detail.version) && detail.version > 0
}

export function TaskDetailDialog({ task, open, onOpenChange, returnFocus, allowMutations }: TaskDetailDialogProps) {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [events, setEvents] = useState<TaskEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [reconcileSummary, setReconcileSummary] = useState("")
  const [performedByRef, setPerformedByRef] = useState("")
  const [evidenceRefs, setEvidenceRefs] = useState("")
  const [reconciling, setReconciling] = useState(false)
  const [reconcileStatus, setReconcileStatus] = useState("")
  const [sourceHrefs, setSourceHrefs] = useState<Record<string, string>>({})
  const eventCursorRef = useRef(0)
  const reconcileIdempotencyRef = useRef("")

  useEffect(() => {
    if (!open || !task) return
    let controller: AbortController | null = null
    let generation = 0
    eventCursorRef.current = 0
    setDetail(null)
    setEvents([])
    setReconcileSummary("")
    setPerformedByRef("")
    setEvidenceRefs("")
    setReconcileStatus("")
    reconcileIdempotencyRef.current = ""

    const load = async (initial: boolean) => {
      controller?.abort()
      controller = new AbortController()
      const requestController = controller
      generation += 1
      const currentGeneration = generation
      if (initial) setLoading(true)
      setError("")
      try {
        const [nextDetail, eventPage] = await Promise.all([
          fetchTaskDetail(task.id, requestController.signal),
          fetchAllTaskEvents(task.id, eventCursorRef.current, requestController.signal),
        ])
        if (currentGeneration !== generation) return
        setDetail(nextDetail)
        eventCursorRef.current = eventPage.nextCursor ?? eventCursorRef.current
        setEvents((current) => {
          const byId = new Map(current.map((event) => [event.id, event]))
          for (const event of eventPage.events) {
            if (!byId.has(event.id)) byId.set(event.id, event)
          }
          return Array.from(byId.values()).sort((left, right) =>
            (left.sequence || 0) - (right.sequence || 0) ||
            (left.occurredAt || "").localeCompare(right.occurredAt || ""),
          )
        })
        if (eventPage.hasMore) {
          setError("The activity timeline exceeded the 10,000-event safety bound. Newer events are not shown.")
        }
      } catch (nextError) {
        if (!requestController.signal.aborted && currentGeneration === generation) {
          setError(nextError instanceof Error ? nextError.message : "Task details failed to load")
        }
      } finally {
        if (initial && currentGeneration === generation) setLoading(false)
      }
    }

    void load(true)
    const interval = window.setInterval(() => void load(false), 15_000)
    return () => {
      generation += 1
      window.clearInterval(interval)
      controller?.abort()
    }
  }, [open, task])

  const shown = detail || task
  const sourceResourceKey = JSON.stringify(Array.from(new Set(
    (shown?.resources ?? [])
      .filter((claim) => !claim.redacted)
      .map((claim) => claim.resourceRef),
  )).sort())

  useEffect(() => {
    setSourceHrefs({})
    if (!open) return
    const resourceRefs = JSON.parse(sourceResourceKey) as string[]
    if (resourceRefs.length === 0) return
    const controller = new AbortController()
    void loadTaskDocumentSources(resourceRefs, { signal: controller.signal })
      .then((links) => {
        if (controller.signal.aborted) return
        setSourceHrefs(Object.fromEntries(links.map((link) => [link.resourceRef, link.href])))
      })
    return () => controller.abort()
  }, [open, sourceResourceKey, task?.id])

  const freshness = shown
    ? formatTaskFreshness(shown.activeRun?.heartbeatAt || shown.updatedAt || shown.createdAt)
    : "No activity timestamp"
  const canReconcileExternally = Boolean(
    allowMutations && hasActionableVersion(detail) && ["pending", "needs_clarification"].includes(detail.state),
  )

  function updateReconciliationDraft(update: () => void) {
    reconcileIdempotencyRef.current = ""
    setReconcileStatus("")
    update()
  }

  async function reconcileExternalCompletion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!hasActionableVersion(detail) || reconciling) {
      setReconcileStatus("External completion requires an authoritative HAM task version.")
      return
    }
    const summary = reconcileSummary.trim()
    const performer = performedByRef.trim()
    if (!summary || !performer) {
      setReconcileStatus("Completion summary and performed-by reference are required.")
      return
    }
    setReconciling(true)
    setReconcileStatus("Recording externally completed work without creating a synthetic run.")
    try {
      const idempotencyKey = reconcileIdempotencyRef.current || crypto.randomUUID()
      reconcileIdempotencyRef.current = idempotencyKey
      const nextDetail = await recordExternalTaskCompletion(detail.id, {
        expectedVersion: detail.version,
        summary,
        performedByRef: performer,
        references: evidenceRefs.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
      }, idempotencyKey)
      const eventPage = await fetchAllTaskEvents(detail.id)
      setDetail(nextDetail)
      setEvents(eventPage.events)
      eventCursorRef.current = eventPage.nextCursor || 0
      reconcileIdempotencyRef.current = ""
      setReconcileSummary("")
      setPerformedByRef("")
      setEvidenceRefs("")
      setReconcileStatus("External completion recorded with explicit provenance.")
    } catch (nextError) {
      setReconcileStatus(nextError instanceof Error ? nextError.message : "External completion could not be recorded")
    } finally {
      setReconciling(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[88vh] max-w-3xl overflow-y-auto"
        onCloseAutoFocus={(event) => {
          if (!returnFocus) return
          event.preventDefault()
          returnFocus.focus()
        }}
      >
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-2 pr-8">
            {shown ? <TaskStatusBadge state={shown.state} lifecyclePhase={shown.lifecyclePhase} /> : null}
            <span className="text-xs text-muted-foreground">{freshness}</span>
          </div>
          <DialogTitle>{shown?.title || "Task details"}</DialogTitle>
          <DialogDescription>
            Canonical task state and append-only activity from HAM. {allowMutations
              ? "Explicitly enabled human reconciliation is the only browser mutation."
              : "This surface is read-only; agent actions use each agent's own identity."}
          </DialogDescription>
        </DialogHeader>

        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {loading ? "Loading task details and activity." : ""}
        </p>
        {error ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p> : null}

        {shown ? (
          <div className="space-y-6">
            <section aria-labelledby="task-objective-heading" className="grid gap-4 rounded-lg border p-4 md:grid-cols-2">
              <div>
                <h2 id="task-objective-heading" className="text-sm font-semibold">Goal</h2>
                <MarkdownRenderer content={shown.goal} images="omit" className="mt-1 text-sm" />
              </div>
              <div>
                <h2 className="text-sm font-semibold">Why</h2>
                <MarkdownRenderer content={shown.why} images="omit" className="mt-1 text-sm text-muted-foreground" />
              </div>
              <dl className="contents text-sm">
                <div>
                  <dt className="inline-flex items-center gap-1 font-medium"><Bot className="h-4 w-4" aria-hidden="true" /> Claimant</dt>
                  <dd className="mt-1 text-muted-foreground">{shown.owner?.label || "Unclaimed"}</dd>
                </div>
                <div>
                  <dt className="inline-flex items-center gap-1 font-medium"><Clock3 className="h-4 w-4" aria-hidden="true" /> Current step</dt>
                  <dd className="mt-1 text-muted-foreground">{shown.stage}</dd>
                </div>
                <div>
                  <dt className="font-medium">Project</dt>
                  <dd className="mt-1 text-muted-foreground">{shown.projectRef || "Not reported"}</dd>
                </div>
                <div>
                  <dt className="font-medium">Requested by</dt>
                  <dd className="mt-1 text-muted-foreground">{shown.requestedByAgent || "Human or service requester"}</dd>
                </div>
              </dl>
            </section>

            {shown.resources.length > 0 ? (
              <section aria-labelledby="task-resources-heading">
                <h2 id="task-resources-heading" className="inline-flex items-center gap-1.5 font-semibold"><Box className="h-4 w-4" aria-hidden="true" /> Resources</h2>
                <ul className="mt-2 space-y-2">
                  {shown.resources.map((claim) => (
                    <li key={claim.id} className="rounded-md border p-2 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0 break-all">
                          <strong>{claim.mode}</strong>{" "}
                          {claim.redacted ? `${claim.resourceType || claim.resourceClass || "resource"} (private topology restricted)` : claim.resourceRef}
                        </span>
                        {!claim.redacted && sourceHrefs[claim.resourceRef] ? (
                          <a
                            className="shrink-0 font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            href={sourceHrefs[claim.resourceRef]}
                          >
                            Open exact source
                          </a>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {shown.conflicts.length > 0 ? (
              <section aria-labelledby="task-conflicts-heading" className="rounded-lg border border-amber-400/60 bg-amber-50 p-4 dark:bg-amber-950/30">
                <h2 id="task-conflicts-heading" className="inline-flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-4 w-4" aria-hidden="true" /> Potential conflicts</h2>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{shown.conflicts.map((conflict) => <li key={conflict.id}>{conflict.summary}</li>)}</ul>
              </section>
            ) : null}

            {detail?.acceptanceCriteria.length ? (
              <section aria-labelledby="task-acceptance-heading">
                <h2 id="task-acceptance-heading" className="font-semibold">Acceptance criteria</h2>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{detail.acceptanceCriteria.map((item) => <li key={item}>{item}</li>)}</ul>
              </section>
            ) : null}

            {canReconcileExternally ? (
              <details className="rounded-lg border p-4">
                <summary className="cursor-pointer font-semibold">Work completed outside this tracked run?</summary>
                <form className="mt-4 grid gap-4" onSubmit={reconcileExternalCompletion}>
                  <p className="text-sm text-muted-foreground">
                    Use this only when the task was genuinely completed elsewhere. It records the outcome and
                    provenance without inventing an agent claim or run.
                  </p>
                  <div className="grid gap-2">
                    <Label htmlFor="external-completion-summary">Completion summary</Label>
                    <Textarea
                      id="external-completion-summary"
                      value={reconcileSummary}
                      maxLength={4000}
                      required
                      onChange={(event) => updateReconciliationDraft(() => setReconcileSummary(event.target.value))}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="external-completion-performer">Performed by</Label>
                    <Input
                      id="external-completion-performer"
                      value={performedByRef}
                      maxLength={200}
                      placeholder="agent:codex-dgx or human:alice"
                      required
                      onChange={(event) => updateReconciliationDraft(() => setPerformedByRef(event.target.value))}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="external-completion-evidence">Evidence references (optional)</Label>
                    <Textarea
                      id="external-completion-evidence"
                      value={evidenceRefs}
                      placeholder={"commit:abc123\nhttps://github.com/owner/repo/pull/42"}
                      onChange={(event) => updateReconciliationDraft(() => setEvidenceRefs(event.target.value))}
                    />
                  </div>
                  <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{reconcileStatus}</p>
                  <div>
                    <Button type="submit" disabled={reconciling}>
                      {reconciling ? "Recording..." : "Record external completion"}
                    </Button>
                  </div>
                </form>
              </details>
            ) : null}

            <section aria-labelledby="task-activity-heading">
              <h2 id="task-activity-heading" className="font-semibold">Activity timeline</h2>
              {events.length > 0 ? (
                <ol className="mt-3 space-y-3 border-l pl-5">
                  {events.map((event) => (
                    <li key={event.id} className="relative text-sm">
                      <span className="absolute -left-[1.55rem] top-1 h-2.5 w-2.5 rounded-full border bg-background" aria-hidden="true" />
                      <MarkdownRenderer content={event.summary} images="omit" className="font-medium" />
                      <p className="text-xs text-muted-foreground">{event.actorRef || "System"} - {event.occurredAt ? new Date(event.occurredAt).toLocaleString() : "Time not recorded"}</p>
                      {event.evidenceRefs.length > 0 ? (
                        <ul className="mt-1 space-y-1 text-xs text-muted-foreground" aria-label="Authorized evidence references">
                          {event.evidenceRefs.map((reference) => <li key={reference}>{reference}</li>)}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : <p className="mt-2 text-sm text-muted-foreground">No activity events have been recorded yet.</p>}
            </section>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
