"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  useReactFlow,
  useStore,
} from "reactflow"
import "reactflow/dist/style.css"
import {
  ArchiveRestore,
  BadgeCheck,
  Boxes,
  GitBranch,
  GitMerge,
  LayoutTemplate,
  Network,
  PackageOpen,
  Pin,
  Save,
  Scale,
  Search,
  ShieldQuestion,
  Sparkles,
  Split,
  Trash2,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { HudAction, HudDivider, HudStatus, HudToolbar } from "@/components/ui/hud-toolbar"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { TaskPlanProposalProducer } from "@/components/tasks/task-plan-proposal-producer"
import { TaskPlanProposalPreview } from "@/components/tasks/task-plan-proposal-preview"
import { TaskPlanRunControls } from "@/components/tasks/task-plan-run-controls"
import { Textarea } from "@/components/ui/textarea"
import { GalaxyBrainAPIError, galaxyBrainAPI } from "@/lib/galaxy-brain-api"
import {
  TASK_PLAN_EDGE_KINDS,
  appendTaskPlanEdge,
  createStarterTaskPlan,
  createTaskPlanNode,
  createTaskPlanTitle,
  previewTaskPlanProposal,
  removeTaskPlanNodes,
  type TaskPlanProposalPreview as TaskPlanProposalResult,
} from "@/lib/task-plan"
import { createTaskPlanDraftGuard, createTaskPlanLatestRequestGuard } from "@/lib/task-plan-draft-guard.js"
import type {
  TaskPlanEdgeKind,
  TaskPlanNode,
  TaskPlanNodeConfig,
  TaskPlanNodeKind,
  TaskPlanProposal,
  TaskPlanProposalDecision,
  TaskPlanRecord,
  TaskPlanRevision,
  TaskPlanSpec,
} from "@/lib/types/task-plans"
import type { TaskSummary } from "@/lib/types/tasks"
import { cn } from "@/lib/utils"

export type TaskConstructorTask = Pick<TaskSummary, "id" | "title" | "goal" | "projectRef" | "version"> & {
  resources?: TaskSummary["resources"]
  state?: TaskSummary["state"]
  activeRun?: TaskSummary["activeRun"]
}

export type DetachedTaskPlanDraft = {
  id: string
  title: string
  spec: TaskPlanSpec
}

export type TaskConstructorProps = {
  task: TaskConstructorTask
  mode?: "live" | "preview"
  className?: string
  initialDraft?: DetachedTaskPlanDraft | null
  proposalCandidate?: TaskPlanProposal | null
  onProposalDecision?: (decision: TaskPlanProposalDecision) => void
  onInteractionStateChange?: (state: {
    dirty: boolean
    saving: boolean
    candidatePending: boolean
    verifiedCandidate: TaskPlanProposal | null
    verifiedProposalHash: string | null
    verifiedTaskId: string | null
    runMutating: boolean
  }) => void
}

type ProposalVerificationState = {
  candidate: TaskPlanProposal | null
  record: TaskPlanRecord | null
  proposalHash: string | null
  status: "idle" | "verifying" | "verified" | "invalid"
  preview: TaskPlanProposalResult | null
  error: string
}

type TaskPlanNodeData = TaskPlanNode & { onSelect: (nodeId: string) => void }

const nodeKindMeta: Record<TaskPlanNodeKind, {
  label: string
  icon: typeof Search
  tone: string
  description: string
}> = {
  context: { label: "Context", icon: Boxes, tone: "hsl(var(--task-context))", description: "References and constraints" },
  research: { label: "Research", icon: Search, tone: "hsl(var(--task-research))", description: "Collect cited evidence" },
  transform: { label: "Transform", icon: ArchiveRestore, tone: "hsl(var(--task-transform))", description: "Change representation" },
  compare: { label: "Compare", icon: Scale, tone: "hsl(var(--task-compare))", description: "Weigh alternatives" },
  challenge: { label: "Challenge", icon: ShieldQuestion, tone: "hsl(var(--task-challenge))", description: "Test assumptions" },
  synthesize: { label: "Synthesize", icon: Sparkles, tone: "hsl(var(--task-synthesize))", description: "Find useful fusions" },
  branch: { label: "Branch", icon: GitBranch, tone: "hsl(var(--task-branch))", description: "Fork independent work" },
  join: { label: "Join", icon: GitMerge, tone: "hsl(var(--task-join))", description: "Reunite branch evidence" },
  checkpoint: { label: "Review", icon: BadgeCheck, tone: "hsl(var(--task-checkpoint))", description: "Require a human decision" },
  artifact: { label: "Artifact", icon: PackageOpen, tone: "hsl(var(--task-artifact))", description: "Materialize a durable output" },
}

const toolbarKinds: TaskPlanNodeKind[] = [
  "context", "research", "transform", "compare", "challenge", "synthesize", "branch", "join", "checkpoint", "artifact",
]

const taskPlanNodeTypes: NodeTypes = { taskPlanNode: TaskPlanNodeCard }

function motionDuration(duration: number) {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : duration
}

function zoomTier(zoom: number) {
  if (zoom < 0.58) return "field"
  if (zoom < 0.92) return "jobs"
  return "details"
}

function TaskPlanNodeCard({ data, selected }: NodeProps<TaskPlanNodeData>) {
  const zoom = useStore((state) => state.transform[2])
  const tier = zoomTier(zoom)
  const meta = nodeKindMeta[data.kind]
  const Icon = meta.icon
  const referenceCount = (data.config.inputRefs?.length || 0) + (data.config.outputRefs?.length || 0)

  return (
    <article
      data-slot="task-plan-node"
      data-kind={data.kind}
      data-zoom-tier={tier}
      data-selected={selected ? "true" : "false"}
      className={cn(
        "task-constructor__node w-64 overflow-hidden rounded-2xl border transition",
        tier === "field" && "w-48 rounded-full",
      )}
      style={{ borderLeftColor: meta.tone, borderLeftWidth: 5 }}
    >
      <Handle type="target" position={Position.Left} className="task-constructor__handle !h-3 !w-3 !border-2" />
      <button
        type="button"
        onClick={() => data.onSelect(data.id)}
        className="task-constructor__node-button block min-h-12 w-full px-4 py-3 text-left outline-none"
        aria-label={`${meta.label} job: ${data.title}`}
        aria-pressed={selected}
      >
        <span className="flex items-center gap-2">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white" style={{ backgroundColor: meta.tone }}>
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="task-constructor__muted research-smallcaps block text-[11px]">{meta.label}</span>
            <span className="research-display block truncate text-base font-semibold">{data.title}</span>
          </span>
        </span>
        {tier !== "field" ? (
          <span className="task-constructor__muted mt-2 line-clamp-2 block text-xs leading-5">{data.goal || meta.description}</span>
        ) : null}
        {tier === "details" ? (
          <span className="task-constructor__muted mt-3 flex flex-wrap gap-1.5 text-[10px]">
            {data.config.requiresApproval ? <span className="task-constructor__notice rounded-full px-2 py-0.5" data-tone="warning">human gate</span> : null}
            {data.config.executorProfile ? <span className="task-constructor__chip rounded-full px-2 py-0.5">{data.config.executorProfile}</span> : null}
            {referenceCount ? <span className="task-constructor__chip rounded-full px-2 py-0.5">{referenceCount} refs</span> : null}
            {data.config.artifactType ? <span className="task-constructor__chip rounded-full px-2 py-0.5">{data.config.artifactType}</span> : null}
          </span>
        ) : null}
      </button>
      <Handle type="source" position={Position.Right} className="task-constructor__handle !h-3 !w-3 !border-2" />
    </article>
  )
}

function toFlowNodes(spec: TaskPlanSpec, onSelect: (nodeId: string) => void): Node<TaskPlanNodeData>[] {
  return spec.nodes.map((node) => ({
    id: node.id,
    type: "taskPlanNode",
    position: node.position,
    data: { ...node, onSelect },
  }))
}

function toFlowEdges(spec: TaskPlanSpec): Edge[] {
  const nodeTitles = new Map(spec.nodes.map((node) => [node.id, node.title]))
  return spec.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      ariaLabel: `${edge.kind} connection from ${nodeTitles.get(edge.source) || edge.source} to ${nodeTitles.get(edge.target) || edge.target}`,
      data: { kind: edge.kind },
      type: "smoothstep",
      animated: edge.kind === "branch" || edge.kind === "join",
      style: { stroke: edge.kind === "evidence" ? "hsl(var(--field-warm-strong))" : "hsl(var(--field-core))", strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: edge.kind === "evidence" ? "hsl(var(--field-warm-strong))" : "hsl(var(--field-core))" },
    }))
}

export function TaskConstructor({
  task,
  mode = "live",
  className,
  initialDraft = null,
  proposalCandidate = null,
  onProposalDecision,
  onInteractionStateChange,
}: TaskConstructorProps) {
  const constructorKey = `${mode}:${task.id}:${task.version ?? "latest"}:${mode === "preview" ? initialDraft?.id || "starter" : "live"}`
  return (
    <ReactFlowProvider>
      <TaskConstructorContent
        key={constructorKey}
        task={task}
        mode={mode}
        className={className}
        initialDraft={initialDraft}
        proposalCandidate={proposalCandidate}
        onProposalDecision={onProposalDecision}
        onInteractionStateChange={onInteractionStateChange}
      />
    </ReactFlowProvider>
  )
}

function taskPlanNodeOptionLabel(node: TaskPlanNode, index: number): string {
  return `${index + 1}. ${node.title} (${node.kind})`
}

function TaskConstructorContent({
  task,
  mode,
  className,
  initialDraft,
  proposalCandidate,
  onProposalDecision,
  onInteractionStateChange,
}: Required<Pick<TaskConstructorProps, "task" | "mode">> & Pick<
  TaskConstructorProps,
  "className" | "initialDraft" | "proposalCandidate" | "onProposalDecision" | "onInteractionStateChange"
>) {
  const taskContext = `${mode}:${task.id}:${task.version ?? "latest"}`
  const acceptedInitialDraft = useMemo(() => {
    if (
      mode !== "preview"
      || !initialDraft
      || initialDraft.spec.schema !== "gb.task-plan.v1"
      || initialDraft.spec.task.kind !== "galaxy.ham.task"
      || initialDraft.spec.task.id !== task.id
      || initialDraft.spec.task.version !== task.version
      || !initialDraft.title.trim()
      || Array.from(initialDraft.title).length > 200
    ) return null
    return initialDraft
  }, [initialDraft, mode, task.id, task.version])
  const initialSpec = useMemo(
    () => acceptedInitialDraft?.spec || createStarterTaskPlan({
        id: task.id,
        title: task.title,
        goal: task.goal,
        version: task.version,
        resources: task.resources,
      }),
    [acceptedInitialDraft, task.goal, task.id, task.resources, task.title, task.version],
  )
  const [draftGuard] = useState(() => createTaskPlanDraftGuard(taskContext))
  const [ledgerGuard] = useState(() => createTaskPlanLatestRequestGuard())
  const [proposalVerificationGuard] = useState(() => createTaskPlanLatestRequestGuard())
  const [proposalDismissalGuard] = useState(() => createTaskPlanLatestRequestGuard())
  const [spec, setSpec] = useState<TaskPlanSpec>(initialSpec)
  const [record, setRecord] = useState<TaskPlanRecord | null>(null)
  const [revisions, setRevisions] = useState<TaskPlanRevision[]>([])
  const initialTitle = acceptedInitialDraft?.title || createTaskPlanTitle(task.title)
  const [title, setTitle] = useState(initialTitle)
  const [selectedNodeId, setSelectedNodeId] = useState(initialSpec.nodes[0]?.id || "")
  const [connectionSource, setConnectionSource] = useState(initialSpec.nodes[0]?.id || "")
  const [connectionTarget, setConnectionTarget] = useState(initialSpec.nodes[1]?.id || "")
  const [connectionKind, setConnectionKind] = useState<TaskPlanEdgeKind>("control")
  const [connectionLabel, setConnectionLabel] = useState("")
  const [connectionDraftDirty, setConnectionDraftDirty] = useState(false)
  const [loading, setLoading] = useState(mode === "live")
  const [saving, setSaving] = useState(false)
  const [resolvingConflict, setResolvingConflict] = useState(false)
  const [runMutating, setRunMutating] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState(mode === "preview" ? "Interactive preview. Revisions remain in memory." : "Loading task plan.")
  const [error, setError] = useState("")
  const [ledgerWarning, setLedgerWarning] = useState("")
  const [toolbarPinned, setToolbarPinned] = useState(true)
  const [previewVersion, setPreviewVersion] = useState(0)
  const [generatedProposal, setGeneratedProposal] = useState<TaskPlanProposal | null>(null)
  const activeProposalCandidate = proposalCandidate ?? generatedProposal
  const [visibleProposal, setVisibleProposal] = useState<TaskPlanProposal | null>(() => (
    activeProposalCandidate?.base.hamTaskId === task.id
      && (!task.version || activeProposalCandidate.base.hamTaskVersion === task.version)
      ? activeProposalCandidate
      : null
  ))
  const [proposalVerification, setProposalVerification] = useState<ProposalVerificationState>({
    candidate: null,
    record: null,
    proposalHash: null,
    status: "idle",
    preview: null,
    error: "",
  })
  const [writeResolution, setWriteResolution] = useState<{
    kind: "conflict" | "replay"
    record: TaskPlanRecord | null
  } | null>(null)
  const saveIdempotencyRef = useRef("")
  const saveSequenceRef = useRef(0)
  const activeSaveRef = useRef(0)
  const lastProposalRef = useRef<TaskPlanProposal | null>(visibleProposal)
  const reactFlow = useReactFlow()
  const hasPinnedTaskVersion = mode === "preview" || (
    spec.task.kind === "galaxy.ham.task"
    && spec.task.id === task.id
    && Number.isSafeInteger(spec.task.version)
    && (spec.task.version || 0) > 0
  )
  const taskReferenceMatchesOpenTask = hasPinnedTaskVersion
    && (!task.version || spec.task.version === task.version)
  const savedTaskReferenceMatchesOpenTask = Boolean(record)
    && (!task.version || record?.current_spec.task.version === task.version)

  useEffect(() => {
    const candidateVerified = activeProposalCandidate === visibleProposal
      && proposalVerification.status === "verified"
      && proposalVerification.candidate === visibleProposal
      && proposalVerification.record === record
    onInteractionStateChange?.({
      dirty: dirty || connectionDraftDirty,
      saving,
      candidatePending: visibleProposal !== null,
      verifiedCandidate: candidateVerified ? visibleProposal : null,
      verifiedProposalHash: candidateVerified ? proposalVerification.proposalHash : null,
      verifiedTaskId: candidateVerified ? task.id : null,
      runMutating,
    })
  }, [
    connectionDraftDirty,
    dirty,
    onInteractionStateChange,
    activeProposalCandidate,
    proposalVerification,
    record,
    runMutating,
    saving,
    task.id,
    visibleProposal,
  ])

  useEffect(() => {
    const nextProposal = activeProposalCandidate?.base.hamTaskId === task.id
      && (!task.version || activeProposalCandidate.base.hamTaskVersion === task.version)
      ? activeProposalCandidate
      : null
    if (lastProposalRef.current === nextProposal) return
    lastProposalRef.current = nextProposal
    proposalDismissalGuard.begin()
    setVisibleProposal(nextProposal)
  }, [activeProposalCandidate, proposalDismissalGuard, task.id, task.version])

  useEffect(() => {
    if (proposalCandidate) setGeneratedProposal(null)
  }, [proposalCandidate])

  useEffect(() => () => {
    proposalDismissalGuard.begin()
  }, [proposalDismissalGuard])

  useEffect(() => {
    const request = proposalVerificationGuard.begin()
    let cancelled = false
    if (!visibleProposal || !record) {
      setProposalVerification({ candidate: visibleProposal, record, proposalHash: null, status: "idle", preview: null, error: "" })
      return () => {
        cancelled = true
      }
    }
    const candidate = visibleProposal
    const baseline = record
    const candidateHash = candidate.proposalHash
    setProposalVerification({ candidate, record: baseline, proposalHash: candidateHash, status: "verifying", preview: null, error: "" })
    void previewTaskPlanProposal(baseline, candidate).then((preview) => {
      if (cancelled || !proposalVerificationGuard.isLatest(request)) return
      setProposalVerification({ candidate, record: baseline, proposalHash: preview.proposalHash, status: "verified", preview, error: "" })
    }).catch((nextError) => {
      if (cancelled || !proposalVerificationGuard.isLatest(request)) return
      setProposalVerification({
        candidate,
        record: baseline,
        proposalHash: candidateHash,
        status: "invalid",
        preview: null,
        error: nextError instanceof Error ? nextError.message : "This task-plan candidate cannot be verified.",
      })
    })
    return () => {
      cancelled = true
    }
  }, [proposalVerificationGuard, record, visibleProposal])

  useEffect(() => {
    const nodeIds = new Set(spec.nodes.map((node) => node.id))
    setConnectionSource((current) => nodeIds.has(current) ? current : (selectedNodeId && nodeIds.has(selectedNodeId) ? selectedNodeId : spec.nodes[0]?.id || ""))
    setConnectionTarget((current) => {
      if (nodeIds.has(current) && current !== connectionSource) return current
      return spec.nodes.find((node) => node.id !== connectionSource)?.id || ""
    })
  }, [connectionSource, selectedNodeId, spec.nodes])

  const markChanged = useCallback((nextSpec: TaskPlanSpec) => {
    if (loading) return
    draftGuard.edit(taskContext)
    saveIdempotencyRef.current = ""
    setSpec(nextSpec)
    setDirty(true)
    setStatus("Unsaved plan changes.")
  }, [draftGuard, loading, taskContext])

  const changeTitle = useCallback((nextTitle: string) => {
    if (loading) return
    draftGuard.edit(taskContext)
    saveIdempotencyRef.current = ""
    setTitle(nextTitle)
    setDirty(true)
    setStatus("Unsaved plan changes.")
  }, [draftGuard, loading, taskContext])

  const refreshRevisionLedger = useCallback((nextRecord: TaskPlanRecord) => {
    const ledgerToken = draftGuard.capture(taskContext)
    const ledgerRequest = ledgerGuard.begin()
    setLedgerWarning("")
    void galaxyBrainAPI.getTaskPlanRevisions(nextRecord.id).then((nextRevisions) => {
      if (ledgerGuard.isLatest(ledgerRequest) && draftGuard.isContextCurrent(ledgerToken)) setRevisions(nextRevisions)
    }).catch(() => {
      if (ledgerGuard.isLatest(ledgerRequest) && draftGuard.isContextCurrent(ledgerToken)) {
        setLedgerWarning(`Plan revision ${nextRecord.current_version} is available, but its revision history could not be refreshed.`)
      }
    })
  }, [draftGuard, ledgerGuard, taskContext])

  useEffect(() => {
    setSpec(initialSpec)
    setTitle(initialTitle)
    setSelectedNodeId(initialSpec.nodes[0]?.id || "")
    setConnectionSource(initialSpec.nodes[0]?.id || "")
    setConnectionTarget(initialSpec.nodes[1]?.id || "")
    setConnectionKind("control")
    setConnectionLabel("")
    setConnectionDraftDirty(false)
    setRecord(null)
    setRevisions([])
    setDirty(false)
    setPreviewVersion(0)
    setGeneratedProposal(null)
    setError("")
    setLedgerWarning("")
    setSaving(false)
    setResolvingConflict(false)
    setRunMutating(false)
    setWriteResolution(null)
    activeSaveRef.current = 0
    saveIdempotencyRef.current = ""
    if (mode === "preview") {
      setLoading(false)
      setStatus("Interactive preview. Revisions remain in memory.")
      return
    }
    let active = true
    const loadToken = draftGuard.capture(taskContext)
    setLoading(true)
    setStatus("Loading task plan.")
    async function loadTaskPlan() {
      try {
        const nextRecord = await galaxyBrainAPI.getTaskPlanForHamTask(task.id)
        if (!active || !draftGuard.isContextCurrent(loadToken)) return
        if (!nextRecord) {
          setStatus(draftGuard.isCurrent(loadToken)
            ? "No saved plan yet. A starter construction is ready to revise."
            : "No saved plan yet. Your in-browser draft remains unsaved.")
          return
        }
        setRecord(nextRecord)
        if (draftGuard.isCurrent(loadToken)) {
          setSpec(nextRecord.current_spec)
          setTitle(nextRecord.title)
          setSelectedNodeId(nextRecord.current_spec.nodes[0]?.id || "")
          setDirty(false)
        }
        setStatus(draftGuard.isCurrent(loadToken)
          ? `Loaded plan revision ${nextRecord.current_version}.`
          : `Loaded plan revision ${nextRecord.current_version}; your newer in-browser edits remain unsaved.`)
        setLoading(false)
        refreshRevisionLedger(nextRecord)
      } catch {
        if (!active || !draftGuard.isContextCurrent(loadToken)) return
        setError("Task plan could not be loaded.")
        setStatus(draftGuard.isCurrent(loadToken) ? "" : "Your in-browser draft remains unsaved.")
      } finally {
        if (active && draftGuard.isContextCurrent(loadToken)) setLoading(false)
      }
    }
    void loadTaskPlan()
    return () => { active = false }
  }, [draftGuard, initialSpec, initialTitle, mode, refreshRevisionLedger, task.id, taskContext])

  const loadAuthoritativePlan = useCallback(() => {
    const latest = writeResolution?.record
    if (!latest) return
    draftGuard.edit(taskContext)
    saveIdempotencyRef.current = ""
    setRecord(latest)
    setSpec(latest.current_spec)
    setTitle(latest.title)
    setSelectedNodeId(latest.current_spec.nodes[0]?.id || "")
    setDirty(false)
    setWriteResolution(null)
    setError("")
    setStatus(`Loaded authoritative plan revision ${latest.current_version}; the prior browser draft was discarded.`)
  }, [draftGuard, taskContext, writeResolution])

  const refreshAuthoritativePlan = useCallback(async () => {
    if (!writeResolution || writeResolution.record || resolvingConflict) return
    setResolvingConflict(true)
    setError("")
    setStatus("Fetching the authoritative plan without changing your browser draft.")
    try {
      const latest = await galaxyBrainAPI.getTaskPlanForHamTask(task.id)
      if (!latest) {
        setError("No authoritative plan was returned. Your draft remains preserved and write-blocked; retry when the service is available.")
        setStatus("The remote plan could not be resolved yet.")
        return
      }
      setWriteResolution((current) => current ? { ...current, record: latest } : current)
      refreshRevisionLedger(latest)
      setStatus(`Authoritative revision ${latest.current_version} is ready to load. Your browser draft is still unchanged.`)
    } catch {
      setError("The authoritative plan is still unavailable. Your draft remains preserved and write-blocked; retry later.")
      setStatus("The remote plan could not be resolved yet.")
    } finally {
      setResolvingConflict(false)
    }
  }, [refreshRevisionLedger, resolvingConflict, task.id, writeResolution])

  const rebaseTaskReference = useCallback(() => {
    if (!Number.isSafeInteger(task.version) || (task.version || 0) <= 0) return
    markChanged({
      ...spec,
      task: { kind: "galaxy.ham.task", id: task.id, version: task.version },
    })
    setError("")
    setStatus(`Draft explicitly rebound to HAM task version ${task.version}. Review it before saving.`)
  }, [markChanged, spec, task.id, task.version])

  const proposalReview = useMemo(() => {
    if (!visibleProposal) return null
    if (activeProposalCandidate !== visibleProposal) {
      return { preview: null, disabledReason: "The candidate changed; waiting for the current candidate.", verificationState: "verifying" as const }
    }
    if (!record) {
      return {
        preview: null,
        disabledReason: loading
          ? "Wait for the saved task plan to load before applying this candidate."
          : "Save a task-plan revision before applying a candidate to its exact base.",
        verificationState: "verifying" as const,
      }
    }
    if (proposalVerification.candidate !== visibleProposal || proposalVerification.record !== record
      || proposalVerification.status === "idle" || proposalVerification.status === "verifying") {
      return {
        preview: null,
        disabledReason: "Verifying candidate integrity before it can change the browser draft.",
        verificationState: "verifying" as const,
      }
    }
    if (proposalVerification.status === "invalid" || !proposalVerification.preview) {
      return {
        preview: null,
        disabledReason: proposalVerification.error || "This task-plan candidate cannot be verified.",
        verificationState: "invalid" as const,
      }
    }
    let disabledReason = ""
    if (loading) disabledReason = "Wait for the saved task plan to load before applying this candidate."
    else if (saving || activeSaveRef.current !== 0) disabledReason = "Wait for the current plan save to finish."
    else if (resolvingConflict || writeResolution) disabledReason = "Resolve the authoritative plan revision before applying this candidate."
    else if (dirty || connectionDraftDirty) disabledReason = "Save or discard the current browser edits before applying this exact-base candidate."
    else if (!hasPinnedTaskVersion) disabledReason = "Rebase the plan to an exact HAM task version before applying this candidate."
    return { preview: proposalVerification.preview, disabledReason, verificationState: "verified" as const }
  }, [
    connectionDraftDirty,
    dirty,
    hasPinnedTaskVersion,
    loading,
    activeProposalCandidate,
    proposalVerification,
    record,
    resolvingConflict,
    saving,
    visibleProposal,
    writeResolution,
  ])

  const dismissProposal = useCallback(() => {
    if (!visibleProposal) return
    const candidate = visibleProposal
    const baseline = record
    const dismissalRequest = proposalDismissalGuard.begin()
    setVisibleProposal(null)
    setStatus("Task-plan candidate dismissed. The browser draft was not changed.")
    if (generatedProposal === candidate) {
      setGeneratedProposal(null)
      return
    }
    if (!baseline || (proposalVerification.status === "invalid"
      && proposalVerification.candidate === candidate
      && proposalVerification.record === baseline)) return
    const acknowledgeDismissal = (verifiedProposalHash: string) => {
      if (!proposalDismissalGuard.isLatest(dismissalRequest) || proposalCandidate !== candidate) return
      onProposalDecision?.({ proposalHash: verifiedProposalHash, outcome: "dismissed" })
    }
    if (proposalVerification.status === "verified"
      && proposalVerification.candidate === candidate
      && proposalVerification.record === baseline) {
      if (proposalVerification.proposalHash) acknowledgeDismissal(proposalVerification.proposalHash)
      return
    }
    void previewTaskPlanProposal(baseline, candidate).then((preview) => {
      acknowledgeDismissal(preview.proposalHash)
    }).catch(() => {
      // Invalid candidates are dismissed locally without acknowledging their unverified identity.
    })
  }, [generatedProposal, onProposalDecision, proposalCandidate, proposalDismissalGuard, proposalVerification, record, visibleProposal])

  const applyProposal = useCallback(() => {
    if (!visibleProposal || activeProposalCandidate !== visibleProposal
      || proposalVerification.status !== "verified"
      || proposalVerification.candidate !== visibleProposal
      || proposalVerification.record !== record
      || !proposalReview?.preview || proposalReview.disabledReason) return
    const proposalHash = proposalVerification.proposalHash
    if (!proposalHash) return
    const nextSpec = proposalReview.preview.spec
    markChanged(nextSpec)
    setSelectedNodeId(proposalReview.preview.addedNodeIds[0] || nextSpec.nodes[0]?.id || "")
    setVisibleProposal(null)
    if (generatedProposal === visibleProposal) setGeneratedProposal(null)
    if (proposalCandidate === visibleProposal) onProposalDecision?.({ proposalHash, outcome: "applied" })
    setStatus("Candidate applied to the local browser draft. Save revision to make it durable; nothing was executed.")
  }, [activeProposalCandidate, generatedProposal, markChanged, onProposalDecision, proposalCandidate, proposalReview, proposalVerification, record, visibleProposal])

  const proposalProducerDisabledReason = mode === "preview"
    ? "Detached previews cannot request server proposals."
    : loading
      ? "Wait for the saved task plan to load."
      : !record
        ? "Save the starter task plan before producing an exact-base candidate."
        : saving || activeSaveRef.current !== 0
          ? "Wait for the current plan save to finish."
          : resolvingConflict || writeResolution
            ? "Resolve the authoritative plan revision before producing a candidate."
            : dirty || connectionDraftDirty
              ? "Save or discard browser edits before producing a candidate from the saved revision."
              : !savedTaskReferenceMatchesOpenTask
                ? "Rebase and save this plan to the open HAM task version before producing a candidate."
                : activeProposalCandidate
                  ? "Review or dismiss the current candidate before producing another."
                  : ""

  const selectNode = useCallback((nodeId: string) => setSelectedNodeId(nodeId), [])
  const flowNodes = useMemo(() => toFlowNodes(spec, selectNode), [selectNode, spec])
  const flowEdges = useMemo(() => toFlowEdges(spec), [spec])
  const selectedNode = spec.nodes.find((node) => node.id === selectedNodeId) || null

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    if (loading) return
    const changed = applyNodeChanges(changes, flowNodes)
    const positionById = new Map(changed.map((node) => [node.id, node.position]))
    if (!changes.some((change) => change.type === "position" || change.type === "remove")) return
    const removedIds = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id))
    const positionedSpec = {
      ...spec,
      nodes: spec.nodes.map((node) => ({
        ...node,
        position: positionById.get(node.id) || node.position,
      })),
    }
    const nextSpec = removeTaskPlanNodes(positionedSpec, removedIds)
    if (!nextSpec) {
      setError("A task plan must contain at least one job.")
      return
    }
    setError("")
    markChanged(nextSpec)
    if (removedIds.has(selectedNodeId)) setSelectedNodeId(nextSpec.nodes[0]?.id || "")
  }, [flowNodes, loading, markChanged, selectedNodeId, spec])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    if (loading) return
    const changed = applyEdgeChanges(changes, flowEdges)
    if (!changes.some((change) => change.type === "remove")) return
    const remaining = new Set(changed.map((edge) => edge.id))
    markChanged({ ...spec, edges: spec.edges.filter((edge) => remaining.has(edge.id)) })
  }, [flowEdges, loading, markChanged, spec])

  const addConnection = useCallback((source: string, target: string, kind: TaskPlanEdgeKind, label?: string) => {
    if (loading) return
    try {
      const nextSpec = appendTaskPlanEdge(spec, { source, target, kind, label })
      setError("")
      markChanged(nextSpec)
      const sourceIndex = spec.nodes.findIndex((node) => node.id === source)
      const targetIndex = spec.nodes.findIndex((node) => node.id === target)
      const sourceNode = spec.nodes[sourceIndex]
      const targetNode = spec.nodes[targetIndex]
      const sourceTitle = sourceNode ? taskPlanNodeOptionLabel(sourceNode, sourceIndex) : source
      const targetTitle = targetNode ? taskPlanNodeOptionLabel(targetNode, targetIndex) : target
      setStatus(`Added ${kind} connection from ${sourceTitle} to ${targetTitle}. Unsaved plan changes.`)
      return true
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "That connection could not be added.")
      return
    }
  }, [loading, markChanged, spec])

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) {
      setError("Choose two jobs that still exist in this task plan.")
      return
    }
    addConnection(connection.source, connection.target, "control")
  }, [addConnection])

  const submitConnection = useCallback(() => {
    if (addConnection(connectionSource, connectionTarget, connectionKind, connectionLabel)) {
      setConnectionLabel("")
      setConnectionDraftDirty(false)
      setConnectionTarget(spec.nodes.find((node) => node.id !== connectionSource && node.id !== connectionTarget)?.id || connectionTarget)
    }
  }, [addConnection, connectionKind, connectionLabel, connectionSource, connectionTarget, spec.nodes])

  const addNode = useCallback((kind: TaskPlanNodeKind) => {
    if (loading) return
    const node = createTaskPlanNode(kind, spec.nodes.length)
    markChanged({ ...spec, nodes: [...spec.nodes, node] })
    setSelectedNodeId(node.id)
    window.requestAnimationFrame(() => void reactFlow.fitView({ padding: 0.2, duration: 300 }))
  }, [loading, markChanged, reactFlow, spec])

  const updateSelectedNode = useCallback((updates: Partial<Omit<TaskPlanNode, "id" | "kind">> & { config?: Partial<TaskPlanNodeConfig> }) => {
    if (loading || !selectedNode) return
    markChanged({
      ...spec,
      nodes: spec.nodes.map((node) => node.id === selectedNode.id ? {
        ...node,
        ...updates,
        config: updates.config ? { ...node.config, ...updates.config } : node.config,
      } : node),
    })
  }, [loading, markChanged, selectedNode, spec])

  const deleteSelectedNode = useCallback(() => {
    if (loading || !selectedNode || spec.nodes.length === 1) return
    const nextSpec = removeTaskPlanNodes(spec, new Set([selectedNode.id]))
    if (!nextSpec) return
    markChanged(nextSpec)
    setSelectedNodeId(nextSpec.nodes[0]?.id || "")
  }, [loading, markChanged, selectedNode, spec])

  const arrangePlan = useCallback(() => {
    if (loading) return
    const incoming = new Map(spec.nodes.map((node) => [node.id, 0]))
    const outgoing = new Map(spec.nodes.map((node) => [node.id, [] as string[]]))
    for (const edge of spec.edges) {
      incoming.set(edge.target, (incoming.get(edge.target) || 0) + 1)
      outgoing.get(edge.source)?.push(edge.target)
    }
    const depth = new Map<string, number>()
    const queue = spec.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id)
    for (const id of queue) depth.set(id, 0)
    while (queue.length) {
      const id = queue.shift()!
      for (const target of outgoing.get(id) || []) {
        depth.set(target, Math.max(depth.get(target) || 0, (depth.get(id) || 0) + 1))
        incoming.set(target, (incoming.get(target) || 1) - 1)
        if (incoming.get(target) === 0) queue.push(target)
      }
    }
    const rows = new Map<number, number>()
    markChanged({
      ...spec,
      nodes: spec.nodes.map((node) => {
        const column = depth.get(node.id) || 0
        const row = rows.get(column) || 0
        rows.set(column, row + 1)
        return { ...node, position: { x: 60 + column * 310, y: 70 + row * 220 } }
      }),
    })
    window.requestAnimationFrame(() => void reactFlow.fitView({ padding: 0.2, duration: 350 }))
  }, [loading, markChanged, reactFlow, spec])

  async function saveRevision() {
    if (writeResolution) {
      setError("Resolve the remote-plan conflict before saving another revision.")
      setStatus("The open draft is blocked from writing until you explicitly load the authoritative plan.")
      return
    }
    if (!hasPinnedTaskVersion) {
      setError("This draft is not bound to this exact HAM task version. Rebase it explicitly before saving.")
      setStatus("The draft remains unsaved because its submitted task reference is not pinned.")
      return
    }
    if (activeSaveRef.current !== 0) return
    const operation = ++saveSequenceRef.current
    activeSaveRef.current = operation
    const saveToken = draftGuard.capture(taskContext)
    const submittedRecord = record
    const submittedSpec = spec
    const submittedTitle = title
    setSaving(true)
    setError("")
    setStatus("Saving an immutable plan revision.")
    try {
      if (mode === "preview") {
        const nextVersion = previewVersion + 1
        if (activeSaveRef.current === operation && draftGuard.isCurrent(saveToken)) {
          setPreviewVersion(nextVersion)
          setDirty(false)
          setStatus(`Preview revision ${nextVersion} saved in memory. No server data changed.`)
        }
        return
      }
      const idempotencyKey = saveIdempotencyRef.current || crypto.randomUUID()
      saveIdempotencyRef.current = idempotencyKey
      const nextRecord = submittedRecord
        ? await galaxyBrainAPI.updateTaskPlan(submittedRecord.id, {
            base_version: submittedRecord.current_version,
            base_content_hash: submittedRecord.current_content_hash,
            title: submittedTitle,
            spec: submittedSpec,
            provenance: { source: "galaxy-task-constructor", ham_refs: [task.id] },
            idempotency_key: idempotencyKey,
          })
        : await galaxyBrainAPI.createTaskPlan({
            ham_task_id: task.id,
            title: submittedTitle,
            spec: submittedSpec,
            provenance: { source: "galaxy-task-constructor", ham_refs: [task.id] },
            idempotency_key: idempotencyKey,
          })
      if (!nextRecord) throw new Error("Task plan save returned no record")
      if (activeSaveRef.current !== operation || !draftGuard.isContextCurrent(saveToken)) return
      if (saveIdempotencyRef.current === idempotencyKey) saveIdempotencyRef.current = ""
      const replayed = nextRecord.replayed === true
      if (!replayed && draftGuard.isCurrent(saveToken)) {
        setRecord(nextRecord)
        setSpec(nextRecord.current_spec)
        setTitle(nextRecord.title)
        setDirty(false)
      } else {
        setDirty(true)
      }

      if (replayed) {
        setWriteResolution({ kind: "replay", record: nextRecord })
      } else {
        setRecord(nextRecord)
      }

      if (activeSaveRef.current !== operation || !draftGuard.isContextCurrent(saveToken)) return
      const draftIsCurrent = draftGuard.isCurrent(saveToken)
      if (replayed) {
        setError("This save operation was already applied, and the plan may have advanced since then. Review the open draft before saving another revision.")
        setStatus(`Reconciled an earlier save operation against current plan revision ${nextRecord.current_version}; the open draft remains unsaved.`)
      } else {
        setStatus(draftIsCurrent
          ? `Saved immutable plan revision ${nextRecord.current_version}.`
          : `Saved plan revision ${nextRecord.current_version}; newer changes remain unsaved.`)
      }
      activeSaveRef.current = 0
      setSaving(false)
      refreshRevisionLedger(nextRecord)
    } catch (nextError) {
      if (activeSaveRef.current !== operation || !draftGuard.isContextCurrent(saveToken)) return
      if (nextError instanceof GalaxyBrainAPIError && nextError.status === 409) {
        saveIdempotencyRef.current = ""
        try {
          const latestRecord = await galaxyBrainAPI.getTaskPlanForHamTask(task.id)
          if (
            latestRecord
            && activeSaveRef.current === operation
            && draftGuard.isContextCurrent(saveToken)
          ) {
            setWriteResolution({ kind: "conflict", record: latestRecord })
            refreshRevisionLedger(latestRecord)
          }
        } catch {
          // Preserve the open draft even when the newest baseline cannot be refreshed.
        }
        if (activeSaveRef.current !== operation || !draftGuard.isContextCurrent(saveToken)) return
        setDirty(true)
        setWriteResolution((current) => current || { kind: "conflict", record: null })
        setError("The plan changed elsewhere. Your browser draft was preserved and cannot overwrite the remote plan.")
        setStatus("Plan conflict detected. Load the authoritative plan explicitly to continue saving.")
        return
      }
      setError("Task plan could not be saved. Resolve the conflict or connection issue, then retry this draft.")
      setStatus("Plan changes remain in this browser until the conflict is resolved.")
    } finally {
      if (activeSaveRef.current === operation) {
        activeSaveRef.current = 0
        if (draftGuard.isContextCurrent(saveToken)) setSaving(false)
      }
    }
  }

  return (
    <section className={cn("task-constructor research-workbench overflow-hidden rounded-2xl border", className)} aria-labelledby={`constructor-${task.id}`}>
      <header className="task-constructor__header border-b px-4 py-4 sm:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <p className="research-kicker">Task constructor · {task.projectRef || "unscoped project"}</p>
            <h2 id={`constructor-${task.id}`} className="research-display mt-1 break-words text-2xl font-semibold">{task.title}</h2>
            <p className="task-constructor__muted mt-1 max-w-3xl text-sm">
              {mode === "preview"
                ? "A detached browser preview of atomic jobs. Preview revisions remain in memory and cannot execute or change server data."
                : "A versioned plan of atomic jobs. The HAM task remains the goal and authority boundary."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="task-constructor__chip rounded-full border px-3 py-1 text-xs">
              {record ? `revision ${record.current_version}` : previewVersion ? `preview revision ${previewVersion}` : "unsaved draft"}
            </span>
            <Button type="button" variant="outline" onClick={() => void saveRevision()} disabled={!hasPinnedTaskVersion || Boolean(writeResolution) || loading || saving || (Boolean(record) && !dirty)} className="task-constructor__control min-h-11">
              <Save className="h-4 w-4" aria-hidden="true" /> {saving ? "Saving…" : mode === "preview" ? "Save preview" : "Save revision"}
            </Button>
          </div>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,28rem)_1fr] sm:items-center">
          <Label htmlFor={`plan-title-${task.id}`} className="sr-only">Plan title</Label>
          <Input id={`plan-title-${task.id}`} value={title} maxLength={200} disabled={loading} onChange={(event) => changeTitle(event.target.value)} className="task-constructor__control" />
          <p role="status" aria-live="polite" className="task-constructor__muted text-xs">
            {hasPinnedTaskVersion
              ? status
              : "Explicitly rebase this draft before saving so its submitted task reference is pinned."}
          </p>
        </div>
        {error ? <p role="alert" className="task-constructor__notice mt-3 rounded-xl border px-3 py-2 text-sm" data-tone="danger">{error}</p> : null}
        {ledgerWarning ? <p role="status" className="task-constructor__notice mt-3 rounded-xl border px-3 py-2 text-sm" data-tone="warning">{ledgerWarning}</p> : null}
        {writeResolution?.record ? (
          <div className="task-constructor__notice mt-3 flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2 text-sm" data-tone="warning">
            <span>Remote revision {writeResolution.record.current_version} is authoritative. Loading it discards the open browser draft.</span>
            <Button type="button" variant="outline" onClick={loadAuthoritativePlan} disabled={saving || activeSaveRef.current !== 0} className="task-constructor__control min-h-11">
              Load remote revision
            </Button>
          </div>
        ) : null}
        {writeResolution && !writeResolution.record ? (
          <div className="task-constructor__notice mt-3 flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2 text-sm" data-tone="warning">
            <span>The authoritative plan could not be fetched. Your browser draft is preserved and write-blocked.</span>
            <Button type="button" variant="outline" onClick={() => void refreshAuthoritativePlan()} disabled={resolvingConflict} className="task-constructor__control min-h-11">
              {resolvingConflict ? "Fetching…" : "Retry remote plan"}
            </Button>
          </div>
        ) : null}
        {!taskReferenceMatchesOpenTask && mode === "live" && Number.isSafeInteger(task.version) && (task.version || 0) > 0 ? (
          <div className="task-constructor__notice mt-3 flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2 text-sm" data-tone="core">
            <span>This plan references an older or unpinned task snapshot.</span>
            <Button type="button" variant="outline" onClick={rebaseTaskReference} disabled={loading || saving || Boolean(writeResolution)} className="task-constructor__control min-h-11">
              Rebase to task v{task.version}
            </Button>
          </div>
        ) : null}
        <TaskPlanRunControls
          task={task}
          record={record}
          mode={mode}
          loading={loading}
          saving={saving}
          dirty={dirty || connectionDraftDirty}
          candidatePending={visibleProposal !== null}
          writeBlocked={Boolean(writeResolution) || resolvingConflict}
          onMutationStateChange={setRunMutating}
        />
      </header>

      {mode === "live" ? (
        <TaskPlanProposalProducer
          record={record}
          disabledReason={proposalProducerDisabledReason || undefined}
          onProposal={setGeneratedProposal}
        />
      ) : null}

      {visibleProposal ? (
        <TaskPlanProposalPreview
          proposal={visibleProposal}
          verificationState={proposalReview?.verificationState || "verifying"}
          applyDisabledReason={proposalReview?.disabledReason || undefined}
          onDismiss={dismissProposal}
          onApply={applyProposal}
        />
      ) : null}

      <div className="task-constructor__field grid xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="relative min-h-[640px] border-b xl:border-b-0 xl:border-r">
          <div className="absolute left-3 top-3 z-20 max-w-[calc(100%-1.5rem)]">
            <HudToolbar label="Task constructor tools" pinned={toolbarPinned}>
              {toolbarKinds.map((kind) => {
                const meta = nodeKindMeta[kind]
                const Icon = meta.icon
                return <HudAction key={kind} label={meta.label} icon={<Icon />} disabled={loading} onClick={() => addNode(kind)} />
              })}
              <HudDivider />
              <HudAction label="Arrange" icon={<LayoutTemplate />} disabled={loading} onClick={arrangePlan} />
              <HudAction label={toolbarPinned ? "Unpin" : "Pin"} icon={<Pin />} active={toolbarPinned} onClick={() => setToolbarPinned((value) => !value)} />
              <HudStatus aria-live="polite">{spec.nodes.length} jobs</HudStatus>
            </HudToolbar>
          </div>
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={taskPlanNodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            nodesDraggable={!loading}
            nodesConnectable={!loading}
            nodesFocusable={false}
            edgesFocusable
            fitView
            minZoom={0.18}
            maxZoom={1.8}
            proOptions={{ hideAttribution: true }}
            aria-label="Task construction graph"
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="hsl(var(--field-muted-strong))" />
            <Controls position="bottom-left" showInteractive={false} />
            <MiniMap
              position="bottom-right"
              nodeColor={(node) => nodeKindMeta[(node.data as TaskPlanNodeData).kind]?.tone || "hsl(var(--field-core))"}
              maskColor="hsl(var(--field-surface) / 0.74)"
              ariaLabel="Task plan overview"
            />
          </ReactFlow>
          <div className="task-constructor__chip task-constructor__muted pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border px-3 py-1 text-[11px] shadow-sm">
            Zoom reveals field → jobs → configuration
          </div>
        </div>

        <aside className="task-constructor__inspector p-4 xl:max-h-[720px] xl:overflow-y-auto" aria-label="Selected job configuration">
          {selectedNode ? (
            <div className="space-y-5">
              <div>
                <p className="research-kicker">{nodeKindMeta[selectedNode.kind].label} job</p>
                <h3 className="research-display mt-1 text-xl font-semibold">Configure atom</h3>
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`node-title-${selectedNode.id}`}>Title</Label>
                <Input id={`node-title-${selectedNode.id}`} value={selectedNode.title} maxLength={200} disabled={loading} onChange={(event) => updateSelectedNode({ title: event.target.value })} className="task-constructor__control" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`node-goal-${selectedNode.id}`}>Job goal</Label>
                <Textarea id={`node-goal-${selectedNode.id}`} value={selectedNode.goal} maxLength={4000} rows={3} disabled={loading} onChange={(event) => updateSelectedNode({ goal: event.target.value })} className="task-constructor__control" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`node-instruction-${selectedNode.id}`}>Instruction</Label>
                <Textarea id={`node-instruction-${selectedNode.id}`} value={selectedNode.config.instruction || ""} maxLength={20000} rows={5} disabled={loading} placeholder="Optional execution-neutral guidance" onChange={(event) => updateSelectedNode({ config: { instruction: event.target.value } })} className="task-constructor__control" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`node-profile-${selectedNode.id}`}>Executor policy</Label>
                <Input id={`node-profile-${selectedNode.id}`} value={selectedNode.config.executorProfile || ""} maxLength={200} disabled={loading} placeholder="e.g. research-high" onChange={(event) => updateSelectedNode({ config: { executorProfile: event.target.value } })} className="task-constructor__control" />
                <p className="task-constructor__muted text-xs">A policy reference, never an embedded API key or provider chain.</p>
              </div>
              <label className="task-constructor__card flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm">
                <input type="checkbox" checked={Boolean(selectedNode.config.requiresApproval)} disabled={loading} onChange={(event) => updateSelectedNode({ config: { requiresApproval: event.target.checked } })} className="h-4 w-4 accent-primary" />
                Require human approval before this job
              </label>
              <Button type="button" variant="outline" onClick={deleteSelectedNode} disabled={loading || spec.nodes.length === 1} className="task-constructor__danger min-h-11 w-full">
                <Trash2 className="h-4 w-4" aria-hidden="true" /> Remove job
              </Button>

              <form
                className="task-constructor__footer border-t pt-5"
                onSubmit={(event) => {
                  event.preventDefault()
                  submitConnection()
                }}
              >
                <fieldset className="grid gap-3" disabled={loading || spec.nodes.length < 2 || spec.edges.length >= 512}>
                  <legend className="task-constructor__muted research-smallcaps text-sm">Add connection</legend>
                  <p className="task-constructor__muted text-xs">Create the same typed DAG edge without dragging a canvas handle.</p>
                  <div className="grid gap-2">
                    <Label htmlFor={`connection-source-${task.id}`}>From job</Label>
                    <select
                      id={`connection-source-${task.id}`}
                      value={connectionSource}
                      onChange={(event) => {
                        setConnectionSource(event.target.value)
                        setConnectionDraftDirty(true)
                      }}
                      className="task-constructor__control min-h-11 rounded-md border px-3 text-sm"
                    >
                      {spec.nodes.map((node, index) => <option key={node.id} value={node.id}>{taskPlanNodeOptionLabel(node, index)}</option>)}
                    </select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={`connection-target-${task.id}`}>To job</Label>
                    <select
                      id={`connection-target-${task.id}`}
                      value={connectionTarget}
                      onChange={(event) => {
                        setConnectionTarget(event.target.value)
                        setConnectionDraftDirty(true)
                      }}
                      className="task-constructor__control min-h-11 rounded-md border px-3 text-sm"
                    >
                      {spec.nodes.map((node, index) => <option key={node.id} value={node.id}>{taskPlanNodeOptionLabel(node, index)}</option>)}
                    </select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={`connection-kind-${task.id}`}>Connection kind</Label>
                    <select
                      id={`connection-kind-${task.id}`}
                      value={connectionKind}
                      onChange={(event) => {
                        setConnectionKind(event.target.value as TaskPlanEdgeKind)
                        setConnectionDraftDirty(true)
                      }}
                      className="task-constructor__control min-h-11 rounded-md border px-3 text-sm"
                    >
                      {TASK_PLAN_EDGE_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                    </select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={`connection-label-${task.id}`}>Label <span className="task-constructor__muted font-normal">(optional)</span></Label>
                    <Input
                      id={`connection-label-${task.id}`}
                      value={connectionLabel}
                      aria-describedby={`connection-label-limit-${task.id}`}
                      onChange={(event) => {
                        setConnectionLabel(event.target.value)
                        setConnectionDraftDirty(true)
                      }}
                      className="task-constructor__control"
                    />
                    <p id={`connection-label-limit-${task.id}`} className="task-constructor__muted text-xs">
                      {Array.from(connectionLabel.trim()).length}/200 characters
                    </p>
                  </div>
                  <Button type="submit" variant="outline" className="task-constructor__control min-h-11">
                    <Network className="h-4 w-4" aria-hidden="true" /> Add connection
                  </Button>
                </fieldset>
              </form>

              <section aria-labelledby={`outline-${task.id}`} className="task-constructor__footer border-t pt-5">
                <h3 id={`outline-${task.id}`} className="task-constructor__muted research-smallcaps text-sm">Keyboard outline</h3>
                <p className="task-constructor__muted mt-1 text-xs">Select any job without dragging the canvas.</p>
                <ol className="mt-3 space-y-1.5">
                  {spec.nodes.map((node, index) => (
                    <li key={node.id}>
                      <button type="button" aria-pressed={node.id === selectedNode.id} onClick={() => { setSelectedNodeId(node.id); void reactFlow.setCenter(node.position.x, node.position.y, { zoom: 1, duration: motionDuration(250) }) }} className="task-constructor__outline-button task-constructor__card flex min-h-11 w-full items-center gap-2 rounded-lg border border-transparent px-3 py-2 text-left text-sm">
                        <span className="task-constructor__muted w-5 text-xs tabular-nums">{index + 1}</span>
                        <span className="truncate">{node.title}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              </section>

              {record || previewVersion ? (
                <details className="task-constructor__footer border-t pt-4">
                  <summary className="min-h-10 cursor-pointer py-2 text-sm font-semibold">Revision ledger</summary>
                  {mode === "preview" ? <p className="task-constructor__muted text-xs">{previewVersion} in-memory preview revision{previewVersion === 1 ? "" : "s"}.</p> : (
                    <ol className="task-constructor__muted mt-2 space-y-2 text-xs">
                      {revisions.map((revision) => <li key={revision.id}>v{revision.version} · {new Date(revision.created_at).toLocaleString()}</li>)}
                    </ol>
                  )}
                </details>
              ) : null}
            </div>
          ) : <p className="task-constructor__muted text-sm">Select a job to configure it.</p>}
        </aside>
      </div>
    </section>
  )
}
