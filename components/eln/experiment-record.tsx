"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { ArrowLeft, ExternalLink, Loader2, Save, Trash2, X } from "lucide-react"

import { TopRail, TopRailTitle } from "@/components/workspace/top-rail"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/use-toast"
import { TaskWorkspaceSurface, type TaskWorkspaceScale } from "@/components/workspace/task-workspace-surface"
import { assignToColumn, boardNodes } from "@/lib/board-layout.js"
import { type GalaxyNode, galaxyBrainService } from "@/lib/galaxy-brain-service"
import { ExperimentEvidenceDrawer } from "@/components/eln/experiment-evidence-drawer"
import { galaxyBrainAPI, type AddMetricInput, type Experiment, type ExperimentMetric } from "@/lib/galaxy-brain-api"
import {
  confirmedAttachmentRetry,
  experimentAttachmentOperationKey,
  type ConfirmedAttachmentRetry,
} from "@/lib/eln-experiment-attachments"
import {
  appendExperimentMetric,
  buildExperimentUpdatePatch,
  canonicalizeExperimentTags,
  classifyExperimentLoadError,
  buildWandbRunUrl,
  describeExperimentLoadError,
  experimentSaveCompletionState,
  formatExperimentTags,
  isExperimentSaveRequestActive,
  loadedExperimentForScope,
  mergeExperimentMetrics,
  mergeExperimentUpdate,
  observationExperimentForSubmission,
  parseConfigSnapshot,
  pendingExperimentObservationForScope,
  rebaseSubmittedExperimentField,
  shouldQueueExperimentSave,
  shouldScheduleQueuedExperimentSave,
} from "@/lib/eln-experiment-state"
import { experimentToResearchRecord } from "@/lib/research-record"
import {
  listPendingExperimentObservations,
  removePendingExperimentObservation,
  writePendingExperimentObservation,
  type PendingExperimentObservation,
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

const WORKSPACE_SCALES = new Set<TaskWorkspaceScale>(["atlas", "board", "record", "source"])

type SaveState = "idle" | "saving" | "saved"

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return "just now"
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay}d ago`
}

interface ExperimentRecordProps {
  experimentId: string
  tenantId: string
  principalId: string
  /** The account control, seated in the shared rail. */
  accountMenu?: ReactNode
}

/** Columns every research board starts with, so there is somewhere to add to. */
const BOARD_COLUMNS = ["Evidence", "Questions", "Next"]

export function ExperimentRecord({ experimentId, tenantId, principalId, accountMenu }: ExperimentRecordProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const requestedScale = searchParams.get("scale") as TaskWorkspaceScale | null
  const workspaceScale = requestedScale && WORKSPACE_SCALES.has(requestedScale)
    ? requestedScale
    : "record"

  const [experimentSelection, setExperimentSelection] = useState<{
    scopeKey: string
    experiment: Experiment
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [boardCards, setBoardCards] = useState<GalaxyNode[]>([])
  const [saveState, setSaveState] = useState<SaveState>("idle")
  const [saveQueueCycle, setSaveQueueCycle] = useState(0)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Editable fields
  const [title, setTitle] = useState("")
  const [status, setStatus] = useState<Experiment["status"]>("hypothesis")
  const [domain, setDomain] = useState("general")
  const [hypothesis, setHypothesis] = useState("")
  const [protocol, setProtocol] = useState("")
  const [results, setResults] = useState("")
  const [interpretation, setInterpretation] = useState("")
  const [conclusion, setConclusion] = useState("")
  const [tagsInput, setTagsInput] = useState("")
  const [configText, setConfigText] = useState("")
  const [wandbRunId, setWandbRunId] = useState("")
  const [wandbProject, setWandbProject] = useState("")
  const [localRunPath, setLocalRunPath] = useState("")
  const [linkedExperiments, setLinkedExperiments] = useState<string[]>([])
  const [attachmentRetry, setAttachmentRetry] = useState<ConfirmedAttachmentRetry | null>(null)
  const [pendingObservationSelection, setPendingObservationSelection] = useState<{
    scopeKey: string
    operation: PendingExperimentObservation
  } | null>(null)
  const [observationBusy, setObservationBusy] = useState(false)
  const [observationError, setObservationError] = useState<string | null>(null)
  const [observationStatus, setObservationStatus] = useState("")
  const recoveryScope = useMemo(() => ({ tenantId, principalId }), [tenantId, principalId])
  const observationScopeKey = useMemo(
    () => JSON.stringify([tenantId, principalId, experimentId]),
    [tenantId, principalId, experimentId],
  )
  const pendingObservation = pendingExperimentObservationForScope(
    pendingObservationSelection,
    observationScopeKey,
  )
  const experiment = loadedExperimentForScope(experimentSelection, observationScopeKey)
  const setExperiment = useCallback((update: Experiment | null | ((current: Experiment | null) => Experiment | null)) => {
    setExperimentSelection((currentSelection) => {
      const current = loadedExperimentForScope(currentSelection, observationScopeKey)
      const next = typeof update === "function" ? update(current) : update
      return next ? { scopeKey: observationScopeKey, experiment: next } : null
    })
  }, [observationScopeKey])

  // Debounce timer ref
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftGenerationRef = useRef(0)
  const saveRequestSequenceRef = useRef(0)
  const outstandingSaveRequestsRef = useRef(new Set<number>())
  const queuedSaveGenerationRef = useRef<number | null>(null)
  const acknowledgedDraftGenerationRef = useRef<number | null>(null)
  const mountedRef = useRef(true)
  const recordEpochRef = useRef(0)
  const activeExperimentIdRef = useRef<string | null>(experimentId)
  const activeObservationScopeKeyRef = useRef(observationScopeKey)

  const updateDraftField = useCallback((apply: () => void) => {
    draftGenerationRef.current += 1
    if (outstandingSaveRequestsRef.current.size > 0) {
      queuedSaveGenerationRef.current = draftGenerationRef.current
    }
    if (savedResetRef.current) {
      clearTimeout(savedResetRef.current)
      savedResetRef.current = null
    }
    setSaveState(outstandingSaveRequestsRef.current.size > 0 ? "saving" : "idle")
    apply()
  }, [])

  useEffect(() => {
    const outstandingSaveRequests = outstandingSaveRequestsRef.current
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      recordEpochRef.current += 1
      activeExperimentIdRef.current = null
      outstandingSaveRequests.clear()
      queuedSaveGenerationRef.current = null
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (savedResetRef.current) clearTimeout(savedResetRef.current)
      debounceRef.current = null
      savedResetRef.current = null
    }
  }, [])

  const loadNextPendingObservation = useCallback(() => {
    const [pending] = listPendingExperimentObservations(window.localStorage, recoveryScope, experimentId)
    setPendingObservationSelection(pending ? { scopeKey: observationScopeKey, operation: pending } : null)
    return pending ?? null
  }, [experimentId, observationScopeKey, recoveryScope])

  useLayoutEffect(() => {
    activeObservationScopeKeyRef.current = observationScopeKey
    recordEpochRef.current += 1
  }, [observationScopeKey])

  useEffect(() => {
    loadNextPendingObservation()
    setObservationBusy(false)
    setObservationError(null)
    setObservationStatus("")
  }, [loadNextPendingObservation])

  // Load experiment
  useEffect(() => {
    let cancelled = false
    const outstandingSaveRequests = outstandingSaveRequestsRef.current
    const recordEpoch = ++recordEpochRef.current
    activeExperimentIdRef.current = experimentId
    draftGenerationRef.current = 0
    acknowledgedDraftGenerationRef.current = null
    outstandingSaveRequests.clear()
    queuedSaveGenerationRef.current = null
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (savedResetRef.current) clearTimeout(savedResetRef.current)
    debounceRef.current = null
    savedResetRef.current = null
    setSaveState("idle")
    setExperimentSelection(null)
    setLoading(true)
    setNotFound(false)
    setLoadError(null)
    galaxyBrainAPI.getExperiment(experimentId).then((exp) => {
      if (cancelled) return
      if (!exp) {
        setLoadError("The lab notebook service returned an empty experiment response.")
        setLoading(false)
        return
      }
      setExperimentSelection({ scopeKey: observationScopeKey, experiment: exp })
      setTitle(exp.title)
      setStatus(exp.status)
      setDomain(exp.domain || "general")
      setHypothesis(exp.hypothesis || "")
      setProtocol(exp.protocol || "")
      setResults(exp.results || "")
      setInterpretation(exp.interpretation || "")
      setConclusion(exp.conclusion || "")
      setTagsInput(exp.tags?.join(", ") || "")
      setConfigText(Object.keys(exp.config_snapshot ?? {}).length > 0 ? JSON.stringify(exp.config_snapshot, null, 2) : "")
      setWandbRunId(exp.wandb_run_id ?? "")
      setWandbProject(exp.wandb_project ?? "")
      setLocalRunPath(exp.local_run_path ?? "")
      setLinkedExperiments(exp.linked_experiments ?? [])
      setAttachmentRetry(null)
      setLoading(false)
    }).catch((error: unknown) => {
      if (cancelled) return
      if (classifyExperimentLoadError(error) === "not-found") {
        setNotFound(true)
      } else {
        setLoadError(describeExperimentLoadError(error))
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
      if (recordEpochRef.current === recordEpoch) recordEpochRef.current += 1
      if (activeExperimentIdRef.current === experimentId) activeExperimentIdRef.current = null
      outstandingSaveRequests.clear()
      queuedSaveGenerationRef.current = null
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (savedResetRef.current) clearTimeout(savedResetRef.current)
      debounceRef.current = null
      savedResetRef.current = null
    }
  }, [experimentId, loadAttempt, observationScopeKey])

  const parsedConfig = useMemo(() => parseConfigSnapshot(configText), [configText])
  const canonicalTags = useMemo(() => canonicalizeExperimentTags(tagsInput), [tagsInput])
  const experimentDraft = useMemo(() => ({
    title,
    status,
    domain,
    hypothesis,
    protocol,
    config_snapshot: parsedConfig.value ?? experiment?.config_snapshot ?? {},
    wandb_run_id: wandbRunId.trim(),
    wandb_project: wandbProject.trim(),
    local_run_path: localRunPath.trim(),
    results,
    interpretation,
    conclusion,
    tags: canonicalTags,
    linked_experiments: linkedExperiments,
  }), [title, status, domain, hypothesis, protocol, parsedConfig.value, experiment?.config_snapshot, wandbRunId, wandbProject, localRunPath, results, interpretation, conclusion, canonicalTags, linkedExperiments])
  const updatePatch = useMemo(
    () => experiment && !parsedConfig.error
      ? buildExperimentUpdatePatch(experiment, experimentDraft)
      : {},
    [experiment, experimentDraft, parsedConfig.error],
  )
  const hasChanges = Boolean(experiment) && (parsedConfig.error !== null || Object.keys(updatePatch).length > 0)

  const doSave = useCallback(async () => {
    if (!experiment) return
    if (!parsedConfig.value || parsedConfig.error) {
      toast({ title: "Configuration needs attention", description: parsedConfig.error, variant: "destructive" })
      return
    }
    if (Object.keys(updatePatch).length === 0) return
    if (shouldQueueExperimentSave(outstandingSaveRequestsRef.current.size)) {
      queuedSaveGenerationRef.current = Math.max(
        queuedSaveGenerationRef.current ?? -1,
        draftGenerationRef.current,
      )
      return
    }

    const requestId = ++saveRequestSequenceRef.current
    const submittedGeneration = draftGenerationRef.current
    const requestEpoch = recordEpochRef.current
    const requestExperimentId = experimentId
    const isActiveSaveRequest = () => isExperimentSaveRequestActive(
      mountedRef.current,
      requestEpoch,
      recordEpochRef.current,
      requestExperimentId,
      activeExperimentIdRef.current,
    )
    outstandingSaveRequestsRef.current.add(requestId)
    if (savedResetRef.current) {
      clearTimeout(savedResetRef.current)
      savedResetRef.current = null
    }
    setSaveState("saving")
    const submittedFields = {
      title,
      status,
      domain,
      hypothesis,
      protocol,
      configText,
      wandbRunId,
      wandbProject,
      localRunPath,
      results,
      interpretation,
      conclusion,
      tagsInput,
      linkedExperiments,
    }

    try {
      const updated = await galaxyBrainAPI.updateExperiment(experiment.id, updatePatch)
      if (!isActiveSaveRequest()) return
      if (!updated) {
        toast({ title: "Save failed", description: "Check that the Galaxy Brain API is running.", variant: "destructive" })
        return
      }
      acknowledgedDraftGenerationRef.current = Math.max(
        acknowledgedDraftGenerationRef.current ?? -1,
        submittedGeneration,
      )
      setExperiment((current) => current ? mergeExperimentUpdate(current, updated) : updated)
      setTitle((current) => rebaseSubmittedExperimentField(submittedFields.title, current, updated.title))
      setStatus((current) => rebaseSubmittedExperimentField(submittedFields.status, current, updated.status))
      setDomain((current) => rebaseSubmittedExperimentField(submittedFields.domain, current, updated.domain || "general"))
      setHypothesis((current) => rebaseSubmittedExperimentField(submittedFields.hypothesis, current, updated.hypothesis || ""))
      setProtocol((current) => rebaseSubmittedExperimentField(submittedFields.protocol, current, updated.protocol || ""))
      setConfigText((current) => rebaseSubmittedExperimentField(
        submittedFields.configText,
        current,
        Object.keys(updated.config_snapshot ?? {}).length > 0 ? JSON.stringify(updated.config_snapshot, null, 2) : "",
      ))
      setWandbRunId((current) => rebaseSubmittedExperimentField(submittedFields.wandbRunId, current, updated.wandb_run_id ?? ""))
      setWandbProject((current) => rebaseSubmittedExperimentField(submittedFields.wandbProject, current, updated.wandb_project ?? ""))
      setLocalRunPath((current) => rebaseSubmittedExperimentField(submittedFields.localRunPath, current, updated.local_run_path ?? ""))
      setResults((current) => rebaseSubmittedExperimentField(submittedFields.results, current, updated.results || ""))
      setInterpretation((current) => rebaseSubmittedExperimentField(submittedFields.interpretation, current, updated.interpretation || ""))
      setConclusion((current) => rebaseSubmittedExperimentField(submittedFields.conclusion, current, updated.conclusion || ""))
      setTagsInput((current) => rebaseSubmittedExperimentField(
        submittedFields.tagsInput,
        current,
        formatExperimentTags(updated.tags ?? canonicalTags),
      ))
      setLinkedExperiments((current) => rebaseSubmittedExperimentField(submittedFields.linkedExperiments, current, updated.linked_experiments ?? []))
    } catch (error) {
      if (isActiveSaveRequest()) {
        toast({ title: "Save error", description: describeExperimentLoadError(error), variant: "destructive" })
      }
    } finally {
      if (!isActiveSaveRequest()) return
      outstandingSaveRequestsRef.current.delete(requestId)
      const completionState = experimentSaveCompletionState(
        draftGenerationRef.current,
        acknowledgedDraftGenerationRef.current,
        outstandingSaveRequestsRef.current.size,
      )
      setSaveState(completionState)
      if (completionState === "saved") {
        savedResetRef.current = setTimeout(() => {
          if (
            isActiveSaveRequest() &&
            outstandingSaveRequestsRef.current.size === 0 &&
            acknowledgedDraftGenerationRef.current === draftGenerationRef.current
          ) {
            setSaveState("idle")
          }
          savedResetRef.current = null
        }, 2000)
      }
      const queuedGeneration = queuedSaveGenerationRef.current
      queuedSaveGenerationRef.current = null
      if (shouldScheduleQueuedExperimentSave(queuedGeneration, submittedGeneration)) {
        setSaveQueueCycle((cycle) => cycle + 1)
      }
    }
  }, [experiment, experimentId, parsedConfig, updatePatch, title, status, domain, hypothesis, protocol, configText, wandbRunId, wandbProject, localRunPath, results, interpretation, conclusion, tagsInput, linkedExperiments, canonicalTags, setExperiment])

  // Debounced auto-save: fires 3 seconds after last edit
  useEffect(() => {
    if (!hasChanges || parsedConfig.error) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      doSave()
    }, 3000)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [hasChanges, parsedConfig.error, doSave, saveQueueCycle])

  const submitObservation = async (body?: string, composerScopeKey = observationScopeKey) => {
    const requestScopeKey = observationScopeKey
    const requestExperiment = observationExperimentForSubmission(
      experimentSelection,
      requestScopeKey,
      composerScopeKey,
    )
    if ((!requestExperiment && !pendingObservation) || observationBusy) return false
    if (!pendingObservation && composerScopeKey !== requestScopeKey) return false
    if (activeObservationScopeKeyRef.current !== requestScopeKey) return false
    const requestEpoch = recordEpochRef.current
    const requestExperimentId = pendingObservation?.experimentId ?? requestExperiment?.id ?? experimentId
    const isActiveObservationRequest = () => mountedRef.current
      && recordEpochRef.current === requestEpoch
      && activeObservationScopeKeyRef.current === requestScopeKey
      && activeExperimentIdRef.current === requestExperimentId
    setObservationBusy(true)
    setObservationError(null)
    setObservationStatus("Recording observation.")
    let operation = pendingObservation
    try {
      if (!operation) {
        operation = writePendingExperimentObservation(window.localStorage, recoveryScope, {
          operationId: crypto.randomUUID().toLowerCase(),
          experimentId: requestExperimentId,
          request: {
            schemaId: "gb.eln-observation-create.v1",
            body: body ?? "",
            observedAt: null,
          },
        })
        if (!isActiveObservationRequest()) return false
        setPendingObservationSelection({ scopeKey: requestScopeKey, operation })
      }
      const receipt = await galaxyBrainAPI.createExperimentObservation(
        operation.experimentId,
        {
          body: operation.request.body,
          ...(operation.request.observedAt === null ? {} : { observedAt: operation.request.observedAt }),
        },
        `eln-observation:${operation.operationId}`,
      )
      if (!isActiveObservationRequest() || receipt.experimentId !== requestExperimentId) return false
      setExperiment((current) => current ? {
        ...current,
        observation_refs: [
          ...(current.observation_refs ?? []).filter((item) => item.id !== receipt.observation.id),
          receipt.observation,
        ],
        observation_count: Math.max(
          current.observation_count ?? 0,
          new Set([...(current.observation_refs ?? []).map((item) => item.id), receipt.observation.id]).size,
        ),
      } : current)
      removePendingExperimentObservation(
        window.localStorage, recoveryScope, operation.experimentId, operation.operationId,
      )
      loadNextPendingObservation()
      setObservationStatus("Observation recorded.")
      toast({ title: "Observation recorded", description: "The immutable observation is now part of this experiment." })
      return true
    } catch (error) {
      if (!isActiveObservationRequest()) return false
      const message = describeExperimentLoadError(error)
      setObservationError(message)
      setObservationStatus("Observation needs attention.")
      toast({ title: "Observation needs attention", description: message, variant: "destructive" })
      return false
    } finally {
      if (isActiveObservationRequest()) setObservationBusy(false)
    }
  }

  const discardPendingObservation = () => {
    if (!pendingObservation || observationBusy) return
    removePendingExperimentObservation(
      window.localStorage, recoveryScope, pendingObservation.experimentId, pendingObservation.operationId,
    )
    loadNextPendingObservation()
    setObservationError(null)
    setObservationStatus("Pending observation discarded.")
  }

  const handleDelete = async () => {
    if (!experiment) return
    if (pendingObservation) {
      toast({
        title: "Resolve the pending observation first",
        description: "Retry or explicitly discard the pending observation before deleting this experiment.",
        variant: "destructive",
      })
      return
    }
    setDeleting(true)
    const ok = await galaxyBrainAPI.deleteExperiment(experiment.id)
    setDeleting(false)
    if (ok) {
      toast({ title: "Experiment deleted" })
      router.push("/eln")
    } else {
      toast({ title: "Delete failed", variant: "destructive" })
    }
  }

  // Board cards are ordinary canvas nodes parented to this experiment, so a
  // card added here is the same object the canvas shows and a clipped page can
  // be moved onto a board without becoming something else.
  const refreshBoardCards = useCallback(() => {
    setBoardCards(boardNodes(galaxyBrainService.getNodes(), experimentId))
  }, [experimentId])

  useEffect(() => {
    refreshBoardCards()
  }, [refreshBoardCards])

  const handleAddBoardCard = useCallback((column: string) => {
    const created = galaxyBrainService.createNode(
      "note",
      "Untitled card",
      "",
      "knowledge",
      experimentId,
    )
    // createNode does not take metadata, so the column is set immediately after.
    const placed = galaxyBrainService.updateNode(created.id, {
      metadata: { ...created.metadata, ...assignToColumn(column) },
    })
    setBoardCards((current) => [...current, placed ?? created])
  }, [experimentId])

  const changeWorkspaceScale = (nextScale: TaskWorkspaceScale) => {
    const next = new URLSearchParams(searchParams.toString())
    if (nextScale === "record") next.delete("scale")
    else next.set("scale", nextScale)
    const query = next.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  const recordRail = (
    <div className="p-3">
      <TopRail
        lead={<TopRailTitle title={title || "Experiment"}>{title || "Experiment"}</TopRailTitle>}
        accountMenu={accountMenu}
      />
    </div>
  )

  // ── Render states ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <main className="research-workbench min-h-screen pb-28 md:pb-12" aria-busy="true">
        {recordRail}
        <div className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
          <p className="sr-only" role="status" aria-live="polite">Loading experiment.</p>
          <Skeleton className="h-8 w-64 max-w-full bg-secondary" />
          <Skeleton className="h-5 w-96 max-w-full bg-muted" />
          <div className="mt-8 space-y-4">
            {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-24 w-full bg-muted" />)}
          </div>
        </div>
      </main>
    )
  }

  if (notFound) {
    return (
      <main className="research-workbench min-h-screen pb-28 md:pb-12">
        {recordRail}
        <div className="mx-auto max-w-4xl px-4 py-16 text-center sm:px-6">
          <p className="mb-4 text-muted-foreground">Experiment not found.</p>
          {pendingObservation && (
            <section className="mx-auto mb-6 max-w-xl space-y-3 rounded-lg border border-[hsl(var(--research-warm)/0.5)] bg-[hsl(var(--research-warm)/0.1)] p-4 text-left" aria-busy={observationBusy}>
              <h2 className="font-medium">Pending observation recovery</h2>
              <p className="text-sm text-muted-foreground">
                Retry the exact saved request to confirm whether it committed. A deleted committed observation returns 410 and remains available for explicit discard.
              </p>
              <p className="whitespace-pre-wrap rounded border bg-background/60 p-3 text-sm">{pendingObservation.request.body}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={observationBusy} onClick={() => void submitObservation()}>
                  Retry pending observation
                </Button>
                <Button type="button" variant="ghost" disabled={observationBusy} onClick={discardPendingObservation}>
                  Discard pending retry
                </Button>
              </div>
              {observationError && <p role="alert" className="text-sm text-destructive">{observationError}</p>}
              <p className="sr-only" role="status" aria-live="polite">{observationStatus}</p>
            </section>
          )}
          <Button variant="outline" className="research-control min-h-11" onClick={() => router.push("/eln")}>
            <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
            Back to Lab Notebook
          </Button>
        </div>
      </main>
    )
  }

  const handleAddMetric = async (metric: AddMetricInput) => {
    if (!experiment) return false
    let result: { added: number }
    try {
      result = await galaxyBrainAPI.addMetrics(experiment.id, [metric])
    } catch (error) {
      toast({ title: "Metric could not be added", description: describeExperimentLoadError(error), variant: "destructive" })
      return false
    }

    if (result.added !== 1) {
      toast({ title: "Metric was not added", description: "The ELN service returned an unexpected append count.", variant: "destructive" })
      return false
    }

    setExperiment((current) => appendExperimentMetric(current, metric, new Date().toISOString()))

    try {
      const refreshed = await galaxyBrainAPI.getExperiment(experiment.id)
      if (refreshed) {
        setExperiment((current) => mergeExperimentMetrics(current, refreshed.metrics))
      }
    } catch {
      toast({ title: "Metric added", description: "The point is saved and shown locally; reload later to reconcile the server history." })
      return true
    }

    toast({ title: "Metric added", description: `${metric.name} was appended to the experiment history.` })
    return true
  }

  const bindConfirmedAttachment = async (retry: ConfirmedAttachmentRetry) => {
    if (!experiment || activeExperimentIdRef.current !== experiment.id) return false
    const receipt = await galaxyBrainAPI.attachExperimentDocument(
      experiment.id,
      retry.documentRef,
      retry.idempotencyKey,
    )
    if (!mountedRef.current || activeExperimentIdRef.current !== receipt.experimentId) return false
    setExperiment((current) => current ? {
      ...current,
      attachment_refs: [
        ...(current.attachment_refs ?? []).filter(
          (item) => item.attachmentId !== receipt.attachment.attachmentId,
        ),
        receipt.attachment,
      ],
      attachment_count: Math.max(
        current.attachment_count ?? 0,
        new Set([...(current.attachment_refs ?? []).map((item) => item.attachmentId), receipt.attachment.attachmentId]).size,
      ),
    } : current)
    setAttachmentRetry(null)
    return true
  }

  const handleAttachDocument = async (file: File | null) => {
    if (!experiment) return false
    try {
      if (attachmentRetry) return await bindConfirmedAttachment(attachmentRetry)
      if (!file) return false
      const requestExperimentId = experiment.id
      const confirmation = await galaxyBrainAPI.importDocument(file, {
        title: file.name.replace(/\.[^.]+$/u, "") || file.name,
        filename: file.name,
        sourceKind: "upload",
      })
      if (!mountedRef.current || activeExperimentIdRef.current !== requestExperimentId) return false
      const idempotencyKey = await experimentAttachmentOperationKey(requestExperimentId, confirmation.document.ref)
      const retry = confirmedAttachmentRetry(confirmation, idempotencyKey)
      setAttachmentRetry(retry)
      return await bindConfirmedAttachment(retry)
    } catch (error) {
      toast({
        title: attachmentRetry ? "Attachment binding needs a retry" : "Document attachment was not completed",
        description: describeExperimentLoadError(error),
        variant: "destructive",
      })
      return false
    }
  }

  if (loadError) {
    return (
      <main className="research-workbench min-h-screen pb-28 md:pb-12">
        {recordRail}
        <div className="mx-auto max-w-4xl px-4 py-16 text-center sm:px-6">
          <div role="alert" className="mx-auto max-w-xl rounded-lg border border-destructive/40 bg-destructive/10 p-5">
            <p className="font-medium text-destructive">Experiment could not be loaded</p>
            <p className="mt-2 text-sm text-muted-foreground">{loadError}</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Button variant="outline" className="research-control min-h-11" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
                Try again
              </Button>
              <Button variant="ghost" className="min-h-11" onClick={() => router.push("/eln")}>
                <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
                Back to Lab Notebook
              </Button>
            </div>
          </div>
        </div>
      </main>
    )
  }

  if (!experiment) return null

  const configSnapshot = parsedConfig.value
  const configPreview = configSnapshot && Object.keys(configSnapshot).length > 0
    ? JSON.stringify(configSnapshot, null, 2)
    : ""

  const wandbUrl = buildWandbRunUrl(wandbProject, wandbRunId)

  const tags = canonicalTags
  const researchRecord = experimentToResearchRecord(
    experiment,
    parsedConfig.error ? {} : experimentDraft,
  )

  return (
    <main className="research-workbench min-h-screen pb-28 md:pb-12">
      {recordRail}
      <div className="mx-auto max-w-[1500px] space-y-7 px-4 pb-12 pt-4 sm:px-7 lg:px-10">

        {/* Header */}
        <div className="space-y-4 border-b border-[var(--research-line)] pb-6">

          <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start">
            {/* Editable title */}
            <Input
              value={title}
              onChange={(e) => updateDraftField(() => setTitle(e.target.value))}
              className="research-display h-auto min-w-0 flex-1 rounded-none border-0 border-b border-[var(--research-line)] bg-transparent px-0 py-1 text-3xl font-semibold text-foreground shadow-none placeholder:text-muted-foreground/60 focus-visible:border-primary focus-visible:ring-0"
              placeholder="Experiment title"
              aria-label="Experiment title"
            />

            {/* Controls */}
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end">
              {/* Save indicator */}
              <span className="text-xs" role="status" aria-live="polite" aria-atomic="true">
                {saveState === "saving" && (
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                    Saving…
                  </span>
                )}
                {saveState === "saved" && <span className="text-primary">Saved</span>}
                {saveState === "idle" && parsedConfig.error && <span id="save-config-error" className="text-destructive">Fix configuration</span>}
                {saveState === "idle" && !parsedConfig.error && hasChanges && <span className="text-[hsl(var(--field-warm-strong))]">Unsaved</span>}
              </span>

              <Button
                size="sm"
                variant="outline"
                onClick={doSave}
                disabled={!hasChanges || saveState === "saving" || Boolean(parsedConfig.error)}
                aria-describedby={parsedConfig.error ? "save-config-error" : undefined}
                className="research-control"
              >
                <Save className="h-4 w-4 mr-1.5" />
                Save
              </Button>

              <ExperimentEvidenceDrawer
                configText={configText}
                configError={parsedConfig.error}
                onConfigTextChange={(value) => updateDraftField(() => setConfigText(value))}
                wandbProject={wandbProject}
                onWandbProjectChange={(value) => updateDraftField(() => setWandbProject(value))}
                wandbRunId={wandbRunId}
                onWandbRunIdChange={(value) => updateDraftField(() => setWandbRunId(value))}
                localRunPath={localRunPath}
                onLocalRunPathChange={(value) => updateDraftField(() => setLocalRunPath(value))}
                legacyLinkedPapers={experiment.linked_papers ?? []}
                attachments={experiment.attachment_refs ?? []}
                attachmentRetryTitle={attachmentRetry?.title ?? null}
                onAttachDocument={handleAttachDocument}
                observations={experiment.observation_refs ?? []}
                pendingObservation={pendingObservation}
                observationBusy={observationBusy}
                observationError={observationError}
                observationStatus={observationStatus}
                observationAuthorityScopeKey={observationScopeKey}
                onAddObservation={submitObservation}
                onDiscardPendingObservation={discardPendingObservation}
                linkedExperiments={linkedExperiments}
                onLinkedExperimentsChange={(value) => updateDraftField(() => setLinkedExperiments(value))}
                metrics={experiment.metrics ?? []}
                onAddMetric={handleAddMetric}
                hamNodeId={experiment.ham_node_id}
              />

              {wandbUrl && (
                <Button size="sm" variant="outline" asChild className="research-control">
                  <a href={wandbUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4 mr-1.5" />
                    W&amp;B
                  </a>
                </Button>
              )}

              <Button
                size="sm"
                variant="ghost"
                className="min-h-9 min-w-9 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setDeleteDialogOpen(true)}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                <span className="sr-only">Delete experiment</span>
              </Button>
            </div>
          </div>

          {/* Status + Domain row */}
          <div className="flex flex-wrap gap-3">
            <div className="flex items-center gap-2">
              <Label className="whitespace-nowrap text-xs text-muted-foreground">Status</Label>
              <Select value={status} onValueChange={(v) => updateDraftField(() => setStatus(v as Experiment["status"]))}>
                <SelectTrigger className="research-control h-9 w-[130px] text-xs" aria-label="Experiment status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hypothesis">Hypothesis</SelectItem>
                  <SelectItem value="running">Running</SelectItem>
                  <SelectItem value="complete">Complete</SelectItem>
                  <SelectItem value="abandoned">Abandoned</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <Label className="whitespace-nowrap text-xs text-muted-foreground">Domain</Label>
              <Select value={domain} onValueChange={(value) => updateDraftField(() => setDomain(value))}>
                <SelectTrigger className="research-control h-9 w-[140px] text-xs" aria-label="Research domain">
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

            {experiment?.updated_at && (
              <span className="self-center font-mono text-[10px] text-muted-foreground">
                Updated {relativeTime(experiment.updated_at)}
              </span>
            )}
          </div>
        </div>

        <TaskWorkspaceSurface
          record={researchRecord}
          scale={workspaceScale}
          onScaleChange={changeWorkspaceScale}
          cards={boardCards}
          boardColumns={BOARD_COLUMNS}
          onAddCard={handleAddBoardCard}
          task={{
            id: experiment.ham_node_id,
            goal: parsedConfig.error
              ? experiment.hypothesis.trim() || experiment.title
              : hypothesis.trim() || title,
            state: experiment.ham_node_id ? "linked" : "draft",
          }}
        >
          {/* Six structured sections */}
          <div className="eln-record-editor space-y-6">
          {/* 1. Hypothesis */}
          <section className="space-y-2">
            <Label className="text-sm font-semibold">Hypothesis</Label>
            <Textarea
              value={hypothesis}
              onChange={(e) => updateDraftField(() => setHypothesis(e.target.value))}
              placeholder="What do you expect to happen and why?"
              className="min-h-[120px] resize-y"
              aria-label="Hypothesis"
            />
          </section>

          {/* 2. Protocol */}
          <section className="space-y-2">
            <Label className="text-sm font-semibold">Protocol</Label>
            <Textarea
              value={protocol}
              onChange={(e) => updateDraftField(() => setProtocol(e.target.value))}
              placeholder="Step-by-step experimental procedure"
              className="min-h-[120px] resize-y"
              aria-label="Protocol"
            />
          </section>

          {/* 3. Configuration */}
          <section className="space-y-2">
            <Label className="text-sm font-semibold">Configuration</Label>
            {configPreview ? (
              <Textarea
                value={configPreview}
                readOnly
                className="min-h-[120px] resize-y font-mono text-xs bg-muted/50 cursor-default"
                aria-label="Configuration snapshot preview"
              />
            ) : parsedConfig.error ? (
              <p id="record-config-error" role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                Configuration JSON is invalid. Open Evidence to correct it before saving.
              </p>
            ) : (
              <Textarea
                value=""
                readOnly
                placeholder="No config snapshot captured yet"
                className="min-h-[80px] bg-muted/30 cursor-default text-muted-foreground"
                aria-label="Configuration snapshot"
              />
            )}
            <p className="text-xs text-muted-foreground">Edit configuration and run evidence from the Evidence drawer.</p>
          </section>

          {/* 4. Results */}
          <section className="space-y-2">
            <Label className="text-sm font-semibold">Results</Label>
            <Textarea
              value={results}
              onChange={(e) => updateDraftField(() => setResults(e.target.value))}
              placeholder="Quantitative and qualitative outcomes"
              className="min-h-[120px] resize-y"
              aria-label="Results"
            />
          </section>

          {/* 5. Interpretation */}
          <section className="space-y-2">
            <Label className="text-sm font-semibold">Interpretation</Label>
            <Textarea
              value={interpretation}
              onChange={(e) => updateDraftField(() => setInterpretation(e.target.value))}
              placeholder="What do the results mean?"
              className="min-h-[120px] resize-y"
              aria-label="Interpretation"
            />
          </section>

          {/* 6. Conclusion */}
          <section className="space-y-2">
            <Label className="text-sm font-semibold">Conclusion</Label>
            <Textarea
              value={conclusion}
              onChange={(e) => updateDraftField(() => setConclusion(e.target.value))}
              placeholder="Does this support or refute the hypothesis?"
              className="min-h-[120px] resize-y"
              aria-label="Conclusion"
            />
          </section>
          </div>

          <Separator className="my-6" />

          {/* Tags */}
          <section className="space-y-3">
            <Label className="text-sm font-semibold">Tags</Label>
            <Input
              value={tagsInput}
              onChange={(e) => updateDraftField(() => setTagsInput(e.target.value))}
              placeholder="comma, separated, tags"
              aria-label="Tags (comma separated)"
            />
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="inline-flex min-h-6 items-center rounded-full border border-transparent bg-secondary px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground transition-colors hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    onClick={() => {
                      const next = tags.filter((t) => t !== tag)
                      updateDraftField(() => setTagsInput(next.join(", ")))
                    }}
                    aria-label={`Remove tag ${tag}`}
                  >
                    {tag}
                    <X className="ml-1 h-3 w-3" aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}
          </section>

          <Separator className="my-6" />

          {/* Metrics */}
          <section className="space-y-3">
            <Label className="text-sm font-semibold">Metrics</Label>
            <MetricsTable metrics={experiment.metrics ?? []} />
          </section>

          {/* Bottom padding */}
          <div className="h-2" />
        </TaskWorkspaceSurface>
      </div>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="research-workbench max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Delete Experiment</DialogTitle>
            <DialogDescription>
              This will permanently delete <strong>{experiment?.title}</strong> and all associated metrics. This cannot be undone.
              {pendingObservation && " Retry or explicitly discard the pending observation before deleting."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting || Boolean(pendingObservation)}>
              {deleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}

// ── Metrics sub-component ──────────────────────────────────────────────────────

function MetricsTable({ metrics }: { metrics: ExperimentMetric[] }) {
  if (metrics.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-[var(--research-line)] py-4 text-center text-sm text-muted-foreground">
        No metrics recorded yet.
      </p>
    )
  }

  return (
    <div className="eln-table-scroll overflow-x-auto rounded-lg border border-[var(--research-line)]" role="region" tabIndex={0} aria-label="Experiment metrics table">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40">
            <TableHead>Name</TableHead>
            <TableHead className="w-[110px] text-right">Value</TableHead>
            <TableHead className="w-[90px] text-right">Step</TableHead>
            <TableHead className="w-[100px]">Source</TableHead>
            <TableHead className="w-[160px]">Timestamp</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {metrics.map((m, i) => (
            <TableRow key={m.id ?? i}>
              <TableCell className="font-mono text-sm">{m.name}</TableCell>
              <TableCell className="text-right tabular-nums text-sm">{m.value}</TableCell>
              <TableCell className="text-right tabular-nums text-sm text-muted-foreground">
                {m.step ?? "—"}
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="text-xs">{m.source}</Badge>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {new Date(m.timestamp).toLocaleString()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
