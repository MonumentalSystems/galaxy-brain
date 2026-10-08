"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { RefreshCw } from "lucide-react"

import { TaskCard } from "@/components/tasks/task-card"
import { TaskCreateForm } from "@/components/tasks/task-create-form"
import { TaskConstructorDialog } from "@/components/tasks/task-constructor-dialog"
import { TaskDetailDialog } from "@/components/tasks/task-detail-dialog"
import { ProofCampaignLauncher } from "@/components/tasks/proof-campaign-launcher"
import { Button } from "@/components/ui/button"
import { hydrateAtlasObjectReferences } from "@/lib/atlas-object-hydration.js"
import { fetchTaskDetail, fetchTaskSnapshot } from "@/lib/ham-task-client"
import { findLocalResourceConflicts } from "@/lib/ham-task-adapter"
import { authorizedPinnedTaskResourceRefs } from "@/lib/task-plan"
import { setBrowserTenantScope } from "@/lib/browser-utils"
import type { TaskSummary } from "@/lib/types/tasks"

const columns = [
  { id: "requested", title: "Requested", description: "Canonical work exists but delivery is not reported." },
  { id: "delivered", title: "Delivered", description: "Wake or delivery recorded; no claim inferred." },
  { id: "claimed", title: "Claimed", description: "Accepted by an agent; run not yet reported." },
  { id: "running", title: "Running", description: "A distinct durable run is active." },
  { id: "waiting", title: "Waiting", description: "Blocked on input, approval, authority, or capacity." },
  { id: "review", title: "Review", description: "Handed off or awaiting review." },
  { id: "terminal", title: "Terminal", description: "Completed, failed, or cancelled." },
  { id: "unknown", title: "Unclassified", description: "HAM reported a state this projection does not map yet." },
] as const

export function TaskQueueView({
  allowMutations,
  showProofCampaignControl,
  proofCampaignControlConfigured,
  allowProofCampaignMutations,
  constructorRequest,
  tenantId,
}: {
  allowMutations: boolean
  showProofCampaignControl: boolean
  proofCampaignControlConfigured: boolean
  allowProofCampaignMutations: boolean
  constructorRequest: { taskId: string; version: number } | { error: true } | null
  tenantId: string
}) {
  setBrowserTenantScope(tenantId)
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [selectedTask, setSelectedTask] = useState<TaskSummary | null>(null)
  const [constructorTask, setConstructorTask] = useState<TaskSummary | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [constructorOpen, setConstructorOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [status, setStatus] = useState("Loading the shared queue.")
  const [truncated, setTruncated] = useState(false)
  const returnFocusRef = useRef<HTMLButtonElement | null>(null)
  const constructorReturnFocusRef = useRef<HTMLButtonElement | null>(null)
  const queueHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const requestRef = useRef<{ controller: AbortController; generation: number } | null>(null)
  const constructorRequestRef = useRef<{ controller: AbortController; generation: number } | null>(null)
  const snapshotRef = useRef("")

  const load = useCallback(async (announce = false) => {
    requestRef.current?.controller.abort()
    const controller = new AbortController()
    const generation = (requestRef.current?.generation || 0) + 1
    requestRef.current = { controller, generation }
    setLoading(true)
    setError("")
    try {
      // The task-page cursor paginates into older rows; it is not a change
      // cursor. Poll the newest bounded snapshot so updated tasks cannot be
      // hidden behind a stale pagination position.
      const page = await fetchTaskSnapshot(controller.signal)
      if (requestRef.current?.generation !== generation) return
      const fingerprint = page.tasks.map((task) => `${task.id}:${task.version}:${task.updatedAt || ""}`).join("|")
      const changed = fingerprint !== snapshotRef.current
      snapshotRef.current = fingerprint
      setTasks(page.tasks)
      setTruncated(Boolean(page.truncated))
      setStatus(announce || changed
        ? `Queue ${announce ? "refreshed" : "updated"}. ${page.tasks.length} task${page.tasks.length === 1 ? "" : "s"} received.`
        : "")
    } catch (nextError) {
      if (controller.signal.aborted) return
      setError(nextError instanceof Error ? nextError.message : "The task queue could not be loaded")
      setStatus("")
    } finally {
      if (requestRef.current?.generation === generation) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
    const interval = window.setInterval(() => void load(false), 15_000)
    return () => {
      window.clearInterval(interval)
      requestRef.current?.controller.abort()
    }
  }, [load])

  const openExactConstructor = useCallback(async (
    task: TaskSummary,
    expectedVersion: number,
    trigger: HTMLButtonElement | null,
    signal?: AbortSignal,
  ) => {
    if (task.id.length < 1 || task.version !== expectedVersion) {
      throw new Error("Exact task version mismatch")
    }
    const references = authorizedPinnedTaskResourceRefs(task.resources)
    if (references.length > 0) {
      const hydration = await hydrateAtlasObjectReferences(references, { signal })
      if (
        hydration.results.length !== references.length
        || hydration.results.some((result, index) => (
          result.status !== "resolved" || result.requestedRef !== references[index]
        ))
      ) throw new Error("Task references are unavailable")
    }
    if (signal?.aborted) return
    constructorReturnFocusRef.current = trigger
    setConstructorTask(task)
    setConstructorOpen(true)
    setStatus(`Opened the exact version ${expectedVersion} task constructor.`)
  }, [])

  const requestConstructor = useCallback((task: TaskSummary, trigger: HTMLButtonElement) => {
    const expectedVersion = task.version
    if (!expectedVersion) {
      setError("This task has no exact version, so Galaxy Brain will not construct a plan from it.")
      return
    }
    constructorRequestRef.current?.controller.abort()
    const controller = new AbortController()
    const generation = (constructorRequestRef.current?.generation || 0) + 1
    constructorRequestRef.current = { controller, generation }
    setError("")
    setStatus("Checking the task's pinned references before opening its constructor.")
    void fetchTaskDetail(task.id, controller.signal)
      .then((currentTask) => openExactConstructor(currentTask, expectedVersion, trigger, controller.signal))
      .catch(() => {
        if (controller.signal.aborted || constructorRequestRef.current?.generation !== generation) return
        setError("The exact task version or one of its pinned references is unavailable.")
        setStatus("")
      })
  }, [openExactConstructor])

  useEffect(() => {
    if (!constructorRequest) return
    if ("error" in constructorRequest) {
      setError("The requested task-constructor link is invalid.")
      setStatus("")
      return
    }
    constructorRequestRef.current?.controller.abort()
    const controller = new AbortController()
    const generation = (constructorRequestRef.current?.generation || 0) + 1
    constructorRequestRef.current = { controller, generation }
    setError("")
    setStatus("Opening the exact linked task and checking its pinned references.")
    void fetchTaskDetail(constructorRequest.taskId, controller.signal)
      .then((task) => openExactConstructor(task, constructorRequest.version, null, controller.signal))
      .catch(() => {
        if (controller.signal.aborted || constructorRequestRef.current?.generation !== generation) return
        setError("The exact requested task/version or one of its pinned references is unavailable.")
        setStatus("")
      })
    return () => controller.abort()
  }, [constructorRequest, openExactConstructor])

  const grouped = useMemo(() => {
    const result = new Map(columns.map((column) => [column.id, [] as TaskSummary[]]))
    for (const task of tasks) result.get(task.lifecyclePhase)?.push(task)
    return result
  }, [tasks])
  const localConflicts = useMemo(() => findLocalResourceConflicts(tasks), [tasks])

  return (
    <div className="space-y-8">
      {showProofCampaignControl ? (
        <ProofCampaignLauncher
          configured={proofCampaignControlConfigured}
          allowMutations={allowProofCampaignMutations}
          tasks={tasks}
        />
      ) : null}
      {allowMutations ? <TaskCreateForm onCreated={() => void load(true)} /> : (
        <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
          Read-only projection. HAM remains authoritative; agents claim and update work with their own Nostr identities.
        </p>
      )}

      <section aria-labelledby="shared-task-queue-heading">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 ref={queueHeadingRef} tabIndex={-1} id="shared-task-queue-heading" className="font-display text-2xl font-semibold">Shared task queue</h2>
            <p className="mt-1 text-sm text-muted-foreground">HAM is canonical. This server-authorized observer projection polls durable tasks and events every 15 seconds; private topology is redacted before it reaches the browser.</p>
          </div>
          <Button type="button" variant="outline" onClick={() => void load(true)} disabled={loading}>
            <RefreshCw className={loading ? "animate-spin" : ""} aria-hidden="true" />
            {loading ? "Refreshing" : "Refresh queue"}
          </Button>
        </div>

        <p role="status" aria-live="polite" className="sr-only">{status}</p>
        {error ? <p role="alert" className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p> : null}
        {truncated ? (
          <p role="status" className="mb-4 rounded-md border border-amber-400/60 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
            Showing the 1,000 most recently updated tasks. Older tasks are not included in this bounded live view.
          </p>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-4">
          {columns.map((column) => {
            const items = grouped.get(column.id) || []
            return (
              <section key={column.id} aria-labelledby={`queue-${column.id}`} className="rounded-2xl border border-white/70 bg-white/45 p-3 dark:border-white/10 dark:bg-cosmic-950/35">
                <div className="mb-3">
                  <h3 id={`queue-${column.id}`} className="font-semibold">{column.title} <span className="text-sm font-normal text-muted-foreground">({items.length})</span></h3>
                  <p className="mt-1 text-xs text-muted-foreground">{column.description}</p>
                </div>
                {items.length > 0 ? (
                  <ul className="space-y-3">
                    {items.map((task) => (
                      <li key={task.id}>
                        <TaskCard
                          task={task}
                          localConflicts={localConflicts.get(task.id)}
                          onOpen={(nextTask, trigger) => {
                            returnFocusRef.current = trigger
                            setSelectedTask(nextTask)
                            setDetailOpen(true)
                          }}
                          onConstruct={(nextTask, trigger) => {
                            requestConstructor(nextTask, trigger)
                          }}
                        />
                      </li>
                    ))}
                  </ul>
                ) : <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">No tasks in this state.</p>}
              </section>
            )
          })}
        </div>
      </section>

      <TaskDetailDialog
        task={selectedTask}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        returnFocus={returnFocusRef.current}
        allowMutations={allowMutations}
      />
      <TaskConstructorDialog
        task={constructorTask}
        open={constructorOpen}
        onOpenChange={setConstructorOpen}
        returnFocus={constructorReturnFocusRef.current}
        fallbackFocus={queueHeadingRef.current}
      />
    </div>
  )
}
