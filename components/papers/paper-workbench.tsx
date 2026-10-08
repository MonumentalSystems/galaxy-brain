"use client"

import { FormEvent, useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import Link from "next/link"
import {
  BookOpen,
  BoxSelect,
  ChevronDown,
  Database,
  ExternalLink,
  Link2,
  ListTodo,
  Loader2,
  MessageSquareText,
  MousePointer2,
  PenLine,
  Quote,
  Search,
  Sparkles,
  Volume2,
  X,
} from "lucide-react"

import {
  PDFViewer,
  type PDFInkStroke,
  type PDFRegionHighlight,
  type PDFRegionSelection,
  type PDFSelectionPoint,
  type PDFTextHighlight,
  type PDFTextSelection,
} from "@/components/pdf-viewer"
import { PaperSelectionPalette } from "@/components/papers/paper-selection-palette"
import { MechanismNeighborhood, type MechanismNeighborhoodItem } from "@/components/papers/mechanism-neighborhood"
import { PaperTimeRail, type PaperTimeEvent } from "@/components/papers/paper-time-rail"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { TTSReaderPanel } from "@/components/panels/tts-reader-panel"
import { TopRail, TopRailTitle } from "@/components/workspace/top-rail"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { arxivPaperSource } from "@/lib/arxiv-paper-source"
import { GalaxyBrainAPIError, galaxyBrainAPI } from "@/lib/galaxy-brain-api"
import { createTask } from "@/lib/ham-task-client"
import { MECHANISM_CATALOG, mechanismHref, mechanismId, mechanismLabel, mechanismTag, normalizeMechanismTag, suggestMechanisms } from "@/lib/paper-mechanisms"
import {
  paperTaskRecoveryNamespace,
  readPaperTaskRecoveries,
  removePaperTaskRecovery,
  writePaperTaskRecovery,
} from "@/lib/paper-task-recovery"
import { DEFAULT_TENANT_ID } from "@/lib/tenant-browser-storage"
import type {
  ArxivPaperMetadata,
  GalaxyPaper,
  GalaxyPaperDetail,
  PaperAnnotation,
  PaperAnnotationAnchor,
  PaperTaskLink,
} from "@/lib/types/papers"
import type { CreateTaskInput } from "@/lib/types/tasks"

type Classification = {
  lens: PaperAnnotation["lens"]
  semanticRole: PaperAnnotation["semantic_role"]
  tags: string
  color: string
}

type SelectionMode = "browse" | "ink" | "region"
type ActiveSelection =
  | ({ type: "text" } & PDFTextSelection)
  | ({ type: "ink" } & Omit<PDFInkStroke, "id" | "color">)
  | ({ type: "region" } & PDFRegionSelection)

const initialClassification: Classification = {
  lens: "analysis",
  semanticRole: "note",
  tags: "",
  color: "#facc15",
}

const LEGACY_TASK_LINK_RECOVERY_KEY = "galaxy.paper-task-link-recovery.v1"

type PendingTaskLink = {
  createdAt: string
  paperId: string
  idempotencyKey: string
  taskInput: CreateTaskInput
  linkInput: {
    parent_ham_task_id?: string
    relation: PaperTaskLink["relation"]
    title_snapshot: string
    annotation_id?: string
    claim_id?: string
  }
  taskId?: string
  taskTitle?: string
}

function isPendingTaskLink(value: unknown): value is PendingTaskLink {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Partial<PendingTaskLink>
  return (
    typeof candidate.createdAt === "string"
    && typeof candidate.paperId === "string"
    && typeof candidate.idempotencyKey === "string"
    && candidate.taskInput?.riskMode === "diagnostic"
    && candidate.taskInput?.resourceMode === "read"
    && Boolean(candidate.linkInput?.relation)
  )
}

function tagsFrom(value: string) {
  return value.split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 32)
}

function selectionAnchor(selection: ActiveSelection): PaperAnnotationAnchor {
  if (selection.type === "text") {
    return {
      type: "text",
      quote: selection.quote,
      startOffset: selection.startOffset,
      endOffset: selection.endOffset,
    }
  }
  if (selection.type === "ink") {
    return { type: "ink", points: selection.points, width: selection.width }
  }
  return {
    type: "region",
    x: selection.x,
    y: selection.y,
    width: selection.width,
    height: selection.height,
  }
}

function selectionLabel(selection: ActiveSelection) {
  if (selection.type === "text") return `“${selection.quote}”`
  if (selection.type === "ink") return `Pen mark on page ${selection.pageNumber}`
  if (selection.width === 1 && selection.height === 1) return `Page ${selection.pageNumber}`
  return `Boxed region on page ${selection.pageNumber}`
}

function uniqueTags(...groups: string[][]) {
  const values: string[] = []
  for (const tag of groups.flat()) {
    if (!values.some((value) => value.toLocaleLowerCase() === tag.toLocaleLowerCase())) values.push(tag)
  }
  return values.slice(0, 32)
}

/*
  One round control in the selection cluster. Icon-only so the cluster stays
  small enough to sit over the page without hiding what was selected; the label
  is the accessible name and the tooltip.
*/
function SelectionAction({
  label,
  hint,
  icon,
  tone = "default",
  disabled = false,
  onClick,
}: {
  label: string
  hint?: string
  icon: ReactNode
  tone?: "default" | "warm" | "quiet"
  disabled?: boolean
  onClick: () => void
}) {
  const toneClass = tone === "warm"
    ? "text-[hsl(37_80%_76%)] hover:bg-[hsl(var(--research-warm)/0.24)] hover:text-[hsl(42_75%_92%)]"
    : tone === "quiet"
      ? "text-[hsl(148_10%_70%)] hover:bg-white/10 hover:text-white"
      : "text-[hsl(148_14%_82%)] hover:bg-white/10 hover:text-white"
  return (
    <button
      type="button"
      aria-label={label}
      title={hint ?? label}
      disabled={disabled}
      onClick={onClick}
      className={`grid h-9 w-9 shrink-0 place-items-center rounded-full transition disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--research-accent))] ${toneClass}`}
    >
      {icon}
    </button>
  )
}

export function PaperWorkbench({
  tenantId,
  principalId,
  initialMechanism,
  initialPaperId,
  accountMenu,
}: {
  tenantId: string
  principalId: string
  initialMechanism?: string
  initialPaperId?: string
  /** The account control, seated in the shared rail. */
  accountMenu?: ReactNode
}) {
  const [papers, setPapers] = useState<GalaxyPaper[]>([])
  const [selected, setSelected] = useState<GalaxyPaperDetail | null>(null)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<ArxivPaperMetadata[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("")
  const [error, setError] = useState("")
  const [selection, setSelection] = useState<ActiveSelection | null>(null)
  const [selectionPoint, setSelectionPoint] = useState<PDFSelectionPoint | null>(null)
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("browse")
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [readerOpen, setReaderOpen] = useState(false)
  const [annotationBody, setAnnotationBody] = useState("")
  const [classification, setClassification] = useState(initialClassification)
  const [mechanisms, setMechanisms] = useState<string[]>([])
  const [customMechanism, setCustomMechanism] = useState("")
  const [activeAnnotationId, setActiveAnnotationId] = useState("")
  const [claimStatement, setClaimStatement] = useState("")
  const [activeClaimId, setActiveClaimId] = useState("")
  const [evidenceRelation, setEvidenceRelation] = useState<"supports" | "refutes" | "context">("supports")
  const [taskTitle, setTaskTitle] = useState("")
  const [activeRevisionId, setActiveRevisionId] = useState("")
  const [pendingTaskLinks, setPendingTaskLinks] = useState<PendingTaskLink[]>([])
  const activeMechanism = initialMechanism ? normalizeMechanismTag(initialMechanism) : ""
  const recoveryNamespace = useMemo(
    () => paperTaskRecoveryNamespace(tenantId, principalId),
    [principalId, tenantId],
  )

  const refreshTaskRecoveries = useCallback(() => {
    const recoveries = readPaperTaskRecoveries(window.localStorage, recoveryNamespace)
      .filter(isPendingTaskLink)
    setPendingTaskLinks(recoveries)
  }, [recoveryNamespace])

  const reloadPapers = useCallback(async () => {
    const next = await galaxyBrainAPI.getPapers()
    setPapers(next)
    return next
  }, [])

  const clearRevisionCoordinates = useCallback(() => {
    setSelection(null)
    setSelectionMode("browse")
    setAnnotationBody("")
    setMechanisms([])
    setCustomMechanism("")
    setActiveAnnotationId("")
    setClaimStatement("")
    setActiveClaimId("")
  }, [])

  const switchRevision = useCallback((revisionId: string, preserveCoordinates = false) => {
    setActiveRevisionId(revisionId)
    if (!preserveCoordinates) clearRevisionCoordinates()
  }, [clearRevisionCoordinates])

  const openPaper = useCallback(async (paperId: string, preservedRevisionId = "") => {
    setError("")
    const detail = await galaxyBrainAPI.getPaper(paperId)
    if (!detail) {
      setError("The paper could not be loaded from Galaxy Brain.")
      return
    }
    const currentRevision = detail.revisions.find((revision) => revision.metadata_hash === detail.metadata_hash)
      ?? detail.revisions[0]
    const preservesRevision = Boolean(
      preservedRevisionId && detail.revisions.some((revision) => revision.id === preservedRevisionId),
    )
    setSelected(detail)
    switchRevision(preservesRevision ? preservedRevisionId : currentRevision?.id ?? "", preservesRevision)
    setTaskTitle(`Review: ${detail.title}`.slice(0, 200))
  }, [switchRevision])

  useEffect(() => {
    reloadPapers().then((items) => {
      if (!initialPaperId && items[0]?.id) void openPaper(items[0].id)
    })
    if (initialPaperId) void openPaper(initialPaperId)
  }, [initialPaperId, openPaper, reloadPapers])

  useEffect(() => {
    try {
      if (tenantId.toLowerCase() === DEFAULT_TENANT_ID) {
        window.localStorage.removeItem(LEGACY_TASK_LINK_RECOVERY_KEY)
      }
      refreshTaskRecoveries()
    } catch {
      setPendingTaskLinks([])
    }
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage && (event.key === null || event.key.startsWith(recoveryNamespace))) {
        refreshTaskRecoveries()
      }
    }
    window.addEventListener("storage", handleStorage)
    return () => window.removeEventListener("storage", handleStorage)
  }, [recoveryNamespace, refreshTaskRecoveries, tenantId])

  const refreshSelected = useCallback(async () => {
    if (selected) await openPaper(selected.id, activeRevisionId)
  }, [activeRevisionId, openPaper, selected])

  async function searchArxiv(event: FormEvent) {
    event.preventDefault()
    if (query.trim().length < 2) return
    setBusy(true)
    setError("")
    setStatus("Searching arXiv metadata…")
    try {
      const response = await galaxyBrainAPI.searchArxiv(query.trim())
      setResults(response.results)
      setLibraryOpen(true)
      setStatus(response.results.length
        ? `Found ${response.total.toLocaleString()} matches; showing ${response.results.length}.`
        : "No arXiv papers matched this search.")
    } catch (nextError) {
      setStatus("")
      setError(nextError instanceof GalaxyBrainAPIError
        ? nextError.message
        : "arXiv search is temporarily unavailable.")
    } finally {
      setBusy(false)
    }
  }

  async function importPaper(result: ArxivPaperMetadata) {
    setBusy(true)
    setError("")
    setStatus(`Importing metadata for ${result.arxiv_id}…`)
    const paper = await galaxyBrainAPI.importArxivPaper(`${result.arxiv_id}v${result.arxiv_version}`)
    setBusy(false)
    setStatus("")
    if (!paper) {
      setError("The paper metadata could not be imported.")
      return
    }
    await reloadPapers()
    await openPaper(paper.id)
  }

  const displayRevision = selected?.revisions.find((revision) => revision.id === activeRevisionId)
  const paperSource = selected && displayRevision
    ? arxivPaperSource(displayRevision.metadata, selected.id, activeRevisionId, Boolean(displayRevision.document))
    : null
  const paperPdfUrl = paperSource?.readerUrl || ""
  const revisionAnnotations = useMemo(
    () => selected?.annotations.filter((annotation) => annotation.paper_revision_id === activeRevisionId) ?? [],
    [activeRevisionId, selected],
  )
  const annotationTags = useMemo(
    () => uniqueTags(tagsFrom(classification.tags), mechanisms),
    [classification.tags, mechanisms],
  )
  const mechanismSuggestions = useMemo(() => suggestMechanisms(
    displayRevision?.metadata.title,
    displayRevision?.metadata.abstract,
    selection?.type === "text" ? selection.quote : "",
    annotationBody,
  ), [annotationBody, displayRevision, selection])

  /*
    Read aloud follows the reading, not the document: a quoted passage is
    almost always what someone wants spoken. With nothing selected the title
    and abstract are the honest fallback, because the stored PDF is bytes and
    this workbench has no extracted full text to offer.
  */
  const readerText = useMemo(() => {
    if (selection?.type === "text" && selection.quote.trim()) return selection.quote
    if (!displayRevision) return ""
    const { title, abstract } = displayRevision.metadata
    return [title, abstract].filter((part) => part?.trim()).join("\n\n")
  }, [displayRevision, selection])

  async function savePaperToGalaxy() {
    if (!paperSource || !displayRevision || !selected || displayRevision.document) return
    setBusy(true)
    setError("")
    setStatus("Fetching this exact paper revision for private durable storage…")
    try {
      const document = await galaxyBrainAPI.fetchPaperDocument(selected.id, displayRevision.id)
      setStatus(`Stored this exact PDF as a durable private Galaxy document (${(document.byte_size / 1_000_000).toFixed(1)} MB).`)
      try {
        await refreshSelected()
      } catch {
        setStatus("Stored durably; the paper view could not refresh yet.")
      }
    } catch (nextError) {
      setStatus("")
      setError(nextError instanceof Error ? nextError.message : "The paper could not be saved to Galaxy")
    } finally {
      setBusy(false)
    }
  }

  async function makeStoredPaperDurable() {
    if (!displayRevision?.document || displayRevision.document.durable_document || !selected) return
    setBusy(true)
    setError("")
    setStatus("Connecting the stored PDF to Galaxy's durable document spine…")
    try {
      await galaxyBrainAPI.bridgePaperDocument(selected.id, displayRevision.id)
      setStatus("The exact stored PDF is now a durable Galaxy document.")
      try {
        await refreshSelected()
      } catch {
        setStatus("Connected durably; the paper view could not refresh yet.")
      }
    } catch (nextError) {
      setStatus("")
      setError(nextError instanceof Error ? nextError.message : "The stored PDF could not be connected")
    } finally {
      setBusy(false)
    }
  }

  const mechanismNeighborhoodItems = useMemo<MechanismNeighborhoodItem[]>(() => {
    if (!activeMechanism) return []
    const activeId = mechanismId(activeMechanism)
    const matchingPapers = papers.filter((paper) =>
      suggestMechanisms(paper.title, paper.abstract).some((item) => item.id === activeId),
    )
    const matchingAnnotations = selected?.annotations.filter((annotation) => annotation.tags.includes(activeMechanism)) ?? []
    const matchingAnnotationIds = new Set(matchingAnnotations.map((annotation) => annotation.id))
    const matchingClaims = selected?.claims.filter((claim) =>
      claim.tags.includes(activeMechanism) || Boolean(claim.source_annotation_id && matchingAnnotationIds.has(claim.source_annotation_id)),
    ) ?? []
    const matchingClaimIds = new Set(matchingClaims.map((claim) => claim.id))

    const paperItems: MechanismNeighborhoodItem[] = matchingPapers.map((paper) => ({
      id: `paper:${paper.id}`,
      kind: "paper",
      label: paper.title,
      detail: `${paper.authors.map((author) => author.name).join(", ")} · arXiv:${paper.arxiv_id}v${paper.arxiv_version}`,
      relation: "contains",
    }))
    const annotationItems: MechanismNeighborhoodItem[] = matchingAnnotations.map((annotation) => ({
      id: `annotation:${annotation.id}`,
      kind: "evidence",
      label: annotation.anchor.type === "text" ? annotation.anchor.quote : `${annotation.anchor.type} coordinate · p.${annotation.page_number}`,
      detail: annotation.body || `Immutable ${annotation.anchor.type} coordinate on revision ${annotation.paper_revision_id}.`,
      relation: annotation.semantic_role === "evidence" ? "supports" : "context",
    }))
    const claimItems: MechanismNeighborhoodItem[] = matchingClaims.map((claim) => ({
      id: `claim:${claim.id}`,
      kind: "claim",
      label: claim.statement,
      detail: `Claim status: ${claim.status}. Kept distinct from its evidence coordinates.`,
      relation: claim.status === "refuted" ? "challenges" : "supports",
    }))
    const taskItems: MechanismNeighborhoodItem[] = (selected?.task_links ?? []).filter((task) =>
      Boolean(task.annotation_id && matchingAnnotationIds.has(task.annotation_id)) || Boolean(task.claim_id && matchingClaimIds.has(task.claim_id)),
    ).map((task) => ({
      id: `task:${task.id}`,
      kind: "task",
      label: task.title_snapshot,
      detail: `HAM task ${task.ham_task_id} preserves this mechanism's exact Galaxy source reference.`,
      relation: "task-from",
    }))
    const relatedIds = new Set(suggestMechanisms(...matchingPapers.flatMap((paper) => [paper.title, paper.abstract])).map((item) => item.id))
    const relatedItems: MechanismNeighborhoodItem[] = MECHANISM_CATALOG.filter((item) =>
      item.id !== activeId && relatedIds.has(item.id),
    ).slice(0, 2).map((item) => ({
      id: `mechanism:${item.id}`,
      kind: "mechanism",
      label: item.label,
      detail: `A neighboring mechanism found in the same paper context. Open it to inspect the connection rather than treating it as equivalence.`,
      relation: "resembles",
      mechanismTag: mechanismTag(item.id),
    }))
    return [...paperItems, ...annotationItems, ...claimItems, ...taskItems, ...relatedItems]
  }, [activeMechanism, papers, selected])

  const paperTimeEvents = useMemo<PaperTimeEvent[]>(() => {
    if (!selected) return []
    const events: PaperTimeEvent[] = [{
      id: `publication:${selected.id}`,
      kind: "publication",
      label: "Paper published",
      detail: selected.title,
      date: selected.published_at || selected.imported_at,
    }]
    for (const revision of selected.revisions) events.push({ id: `revision:${revision.id}`, kind: "revision", label: `Revision v${revision.arxiv_version}`, detail: "Immutable source and metadata revision", date: revision.imported_at })
    for (const annotation of selected.annotations) events.push({ id: `annotation:${annotation.id}`, kind: "coordinate", label: `${annotation.anchor.type} · p.${annotation.page_number}`, detail: annotation.body || `${annotation.semantic_role} coordinate`, date: annotation.created_at })
    for (const claim of selected.claims) events.push({ id: `claim:${claim.id}`, kind: "claim", label: claim.statement, detail: `Claim status: ${claim.status}`, date: claim.created_at })
    for (const task of selected.task_links) events.push({ id: `task:${task.id}`, kind: "task", label: task.title_snapshot, detail: `HAM task ${task.ham_task_id}`, date: task.created_at })
    return events
  }, [selected])

  function chooseSelection(next: ActiveSelection, at?: PDFSelectionPoint) {
    setSelection(next)
    setSelectionPoint(at ?? null)
    setSelectionMode("browse")
    setAnnotationBody("")
    if (next.type === "text") {
      setClaimStatement(next.quote)
      const suggested = suggestMechanisms(next.quote)
      setMechanisms((current) => uniqueTags(current, suggested.map((item) => mechanismTag(item.id))))
    }
  }

  async function persistSelection(
    requestedKind: "highlight" | "comment" = "highlight",
    body = annotationBody,
    clearSelection = true,
  ) {
    if (!selected || !selection || !activeRevisionId) return null
    setBusy(true)
    setError("")
    const created = await galaxyBrainAPI.createPaperAnnotation(selected.id, {
      paper_revision_id: activeRevisionId,
      kind: selection.type === "ink" ? "ink" : requestedKind,
      page_number: selection.pageNumber,
      anchor: selectionAnchor(selection),
      body,
      color: classification.color,
      lens: classification.lens,
      semantic_role: classification.semanticRole,
      tags: annotationTags,
      idempotency_key: crypto.randomUUID(),
    })
    setBusy(false)
    if (!created) {
      setError("The selected evidence coordinate could not be saved.")
      return null
    }
    if (clearSelection) setSelection(null)
    setAnnotationBody("")
    setActiveAnnotationId(created.id)
    await refreshSelected()
    return created
  }

  async function createClaim() {
    if (!selected || !claimStatement.trim()) return
    if (activeAnnotationId && !selected.annotations.some((annotation) => annotation.id === activeAnnotationId)) {
      setError("The selected annotation does not belong to this paper.")
      return
    }
    setBusy(true)
    const claim = await galaxyBrainAPI.createPaperClaim(selected.id, {
      source_annotation_id: activeAnnotationId || undefined,
      statement: claimStatement.trim(),
      tags: annotationTags,
      idempotency_key: crypto.randomUUID(),
    })
    setBusy(false)
    if (!claim) {
      setError("The claim could not be saved.")
      return
    }
    setActiveClaimId(claim.id)
    setClaimStatement("")
    await refreshSelected()
  }

  async function saveSelectionAsClaim() {
    if (!selection || !selected) return
    const statement = selection.type === "text" ? selection.quote : annotationBody.trim()
    if (!statement) {
      setError("Add a short statement before turning a visual region into a claim.")
      return
    }
    const annotation = await persistSelection("comment", annotationBody, false)
    if (!annotation) return
    setBusy(true)
    const claim = await galaxyBrainAPI.createPaperClaim(selected.id, {
      source_annotation_id: annotation.id,
      statement,
      tags: annotationTags,
      idempotency_key: crypto.randomUUID(),
    })
    setBusy(false)
    if (!claim) {
      setError("The coordinate was saved, but its claim could not be created.")
      return
    }
    setSelection(null)
    setActiveClaimId(claim.id)
    setClaimStatement("")
    setStatus("Claim saved with its exact paper coordinate.")
    await refreshSelected()
  }

  async function linkEvidence() {
    if (!selected || !activeClaimId || !activeAnnotationId) return
    if (
      !selected.claims.some((claim) => claim.id === activeClaimId)
      || !selected.annotations.some((annotation) => annotation.id === activeAnnotationId)
    ) {
      setError("Select a claim and annotation from the current paper.")
      return
    }
    const linked = await galaxyBrainAPI.linkClaimEvidence(selected.id, activeClaimId, activeAnnotationId, evidenceRelation)
    if (!linked) setError("The claim/evidence relation could not be saved.")
    else await refreshSelected()
  }

  function persistTaskLink(operation: PendingTaskLink) {
    try {
      writePaperTaskRecovery(window.localStorage, recoveryNamespace, operation)
      refreshTaskRecoveries()
      return true
    } catch {
      return false
    }
  }

  function clearTaskLink(operation: PendingTaskLink) {
    try {
      removePaperTaskRecovery(window.localStorage, recoveryNamespace, operation.idempotencyKey)
      refreshTaskRecoveries()
    } catch {
      setPendingTaskLinks((current) => current.filter(
        (candidate) => candidate.idempotencyKey !== operation.idempotencyKey,
      ))
    }
  }

  async function continueTaskLink(operation: PendingTaskLink) {
    setBusy(true)
    setError("")
    let recoverable = operation
    try {
      if (!recoverable.taskId) {
        const task = await createTask(recoverable.taskInput, recoverable.idempotencyKey)
        recoverable = { ...recoverable, taskId: task.id, taskTitle: task.title }
        if (!persistTaskLink(recoverable)) {
          setPendingTaskLinks((current) => [
            ...current.filter((candidate) => candidate.idempotencyKey !== recoverable.idempotencyKey),
            recoverable,
          ])
        }
      }
      const link = await galaxyBrainAPI.createPaperTaskLink(recoverable.paperId, {
        ...recoverable.linkInput,
        ham_task_id: recoverable.taskId!,
        title_snapshot: recoverable.taskTitle || recoverable.linkInput.title_snapshot,
      })
      if (!link) throw new Error("Galaxy could not save the paper link.")
      clearTaskLink(recoverable)
      setStatus(recoverable.linkInput.annotation_id
        ? "HAM task created and linked to the exact paper coordinate. It grants no execution authority by itself."
        : "Document task posted to HAM and linked. It grants no execution authority by itself.")
      if (selected?.id === recoverable.paperId) await refreshSelected()
    } catch (nextError) {
      persistTaskLink(recoverable)
      const taskReference = recoverable.taskId ? ` HAM task: ${recoverable.taskId}.` : ""
      const reason = nextError instanceof Error ? nextError.message : "Task-link operation failed."
      setError(`${reason}${taskReference} Retry the pending operation; Galaxy will reuse its idempotency key and will not create a second task.`)
    } finally {
      setBusy(false)
    }
  }

  async function createDocumentTask() {
    if (!selected || !taskTitle.trim() || pendingTaskLinks.length > 0) return
    const operation: PendingTaskLink = {
      createdAt: new Date().toISOString(),
      paperId: selected.id,
      idempotencyKey: crypto.randomUUID(),
      taskInput: {
        title: taskTitle.trim(),
        goal: `Review arXiv ${selected.arxiv_id} and produce a traceable analysis.`,
        why: "The source paper is loaded in Galaxy Brain with versioned annotations and evidence links.",
        acceptanceCriteria: ["Review relevant claims", "Link supporting or refuting evidence", "Record conclusions with source references"],
        riskMode: "diagnostic",
        resourceKeys: [`paper:${selected.id}`],
        resourceMode: "read",
      },
      linkInput: { relation: "document-task", title_snapshot: taskTitle.trim() },
    }
    if (persistTaskLink(operation)) await continueTaskLink(operation)
    else setError("Task recovery storage is unavailable; no HAM task was created.")
  }

  async function createSelectionTask(intent: "task" | "enhance") {
    if (!selected || !selection || pendingTaskLinks.length > 0) return
    const label = selectionLabel(selection)
    const coordinate = await persistSelection("comment", annotationBody, false)
    if (!coordinate) return
    const mechanismNames = annotationTags
      .filter((tag) => tag.startsWith("mechanism:"))
      .map(mechanismLabel)
    const title = `${intent === "enhance" ? "Enhance" : "Investigate"}: ${label.replace(/[“”]/g, "")}`.slice(0, 200)
    const operation: PendingTaskLink = {
      createdAt: new Date().toISOString(),
      paperId: selected.id,
      idempotencyKey: crypto.randomUUID(),
      taskInput: {
        title,
        goal: intent === "enhance"
          ? `Expand this exact paper coordinate with current cited sources, explanations, and cross-domain mechanism links${mechanismNames.length ? ` for ${mechanismNames.join(", ")}` : ""}.`
          : `Investigate this exact paper coordinate and return a traceable conclusion${mechanismNames.length ? ` about ${mechanismNames.join(", ")}` : ""}.`,
        why: `Galaxy preserves page ${selection.pageNumber}, paper revision ${activeRevisionId}, and annotation ${coordinate.id} as the task's evidence coordinate.`,
        acceptanceCriteria: intent === "enhance"
          ? ["Return a concise synthesis", "Cite every external source", "Separate observation from inference", "Record useful mechanism links and counterevidence"]
          : ["Return a conclusion", "Cite the source coordinate", "Identify uncertainty or contradictory evidence"],
        riskMode: "diagnostic",
        resourceKeys: [`paper:${selected.id}`, `paper-annotation:${coordinate.id}`],
        resourceMode: "read",
      },
      linkInput: {
        relation: "document-task",
        title_snapshot: title,
        annotation_id: coordinate.id,
      },
    }
    if (persistTaskLink(operation)) {
      setSelection(null)
      await continueTaskLink(operation)
    } else {
      setError("Task recovery storage is unavailable; the coordinate was saved but no HAM task was created.")
    }
  }

  async function createSubtask() {
    if (!selected || !taskTitle.trim() || pendingTaskLinks.length > 0) return
    const parent = selected.task_links.find((link) => link.relation === "document-task" && !link.annotation_id)
    if (!parent) {
      setError("Create a document task before adding subtasks.")
      return
    }
    if (!activeAnnotationId && !activeClaimId) {
      setError("Select an annotation or claim to scope this subtask.")
      return
    }
    if (
      (activeAnnotationId && !selected.annotations.some((annotation) => annotation.id === activeAnnotationId))
      || (activeClaimId && !selected.claims.some((claim) => claim.id === activeClaimId))
    ) {
      setError("The selected task coordinate does not belong to this paper.")
      return
    }
    const operation: PendingTaskLink = {
      createdAt: new Date().toISOString(),
      paperId: selected.id,
      idempotencyKey: crypto.randomUUID(),
      taskInput: {
        title: taskTitle.trim(),
        goal: activeClaimId ? "Evaluate the selected claim." : "Analyze the selected paper annotation.",
        why: `Subtask of HAM task ${parent.ham_task_id}; Galaxy preserves the paper evidence coordinate.`,
        acceptanceCriteria: ["Return a conclusion", "Cite the source annotation or claim", "Identify uncertainty or contradictory evidence"],
        riskMode: "diagnostic",
        resourceKeys: [`paper:${selected.id}`],
        resourceMode: "read",
      },
      linkInput: {
        parent_ham_task_id: parent.ham_task_id,
        relation: "subtask",
        title_snapshot: taskTitle.trim(),
        annotation_id: activeAnnotationId || undefined,
        claim_id: activeClaimId || undefined,
      },
    }
    if (persistTaskLink(operation)) await continueTaskLink(operation)
    else setError("Task recovery storage is unavailable; no HAM task was created.")
  }

  async function copyCitation() {
    if (!selected || !selection || !displayRevision) return
    const coordinate = await persistSelection("highlight", annotationBody, false)
    if (!coordinate) return
    const page = selection.pageNumber
    const citation = `[${displayRevision.metadata.title}](${displayRevision.metadata.abs_url}) — p. ${page}, arXiv v${displayRevision.arxiv_version}, Galaxy annotation ${coordinate.id}`
    try {
      await navigator.clipboard.writeText(citation)
      setSelection(null)
      setStatus("Versioned Markdown citation copied.")
    } catch {
      setError("The coordinate was saved, but the browser did not allow clipboard access.")
    }
  }

  const textHighlights = useMemo<PDFTextHighlight[]>(() => revisionAnnotations.flatMap((annotation) => {
    if (annotation.anchor.type !== "text") return []
    return [{ id: annotation.id, pageNumber: annotation.page_number, ...annotation.anchor, color: annotation.color }]
  }), [revisionAnnotations])
  const inkStrokes = useMemo<PDFInkStroke[]>(() => revisionAnnotations.flatMap((annotation) => {
    if (annotation.anchor.type !== "ink") return []
    return [{ id: annotation.id, pageNumber: annotation.page_number, ...annotation.anchor, color: annotation.color }]
  }), [revisionAnnotations])
  const regionHighlights = useMemo<PDFRegionHighlight[]>(() => revisionAnnotations.flatMap((annotation) => {
    if (annotation.anchor.type !== "region") return []
    return [{ id: annotation.id, pageNumber: annotation.page_number, ...annotation.anchor, color: annotation.color }]
  }), [revisionAnnotations])

  function addMechanism(value: string) {
    const tag = mechanismTag(value)
    if (!tag) return
    setMechanisms((current) => uniqueTags(current, [tag]))
    setCustomMechanism("")
  }

  return (
    <main className="research-workbench mx-auto min-h-[calc(100vh-4rem)] max-w-[1900px] p-4">
      <TopRail
        lead={(
          <TopRailTitle title={selected && displayRevision ? displayRevision.metadata.title : undefined}>
            {selected && displayRevision ? displayRevision.metadata.title : "Papers"}
          </TopRailTitle>
        )}
        actions={selected && displayRevision ? (
          <>
            {selected.revisions.length > 1 && (
              <select
                aria-label="Paper revision"
                className="min-h-9 shrink-0 rounded-md border border-[var(--research-line)] bg-[hsl(var(--research-panel))] px-2 text-sm"
                value={activeRevisionId}
                onChange={(event) => switchRevision(event.target.value)}
              >
                {selected.revisions.map((revision) => <option key={revision.id} value={revision.id}>v{revision.arxiv_version}</option>)}
              </select>
            )}
            {paperSource && !displayRevision.document && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-9 shrink-0 border-[var(--research-line)] bg-[hsl(var(--research-panel))] hover:bg-[hsl(var(--research-accent-soft))]"
                disabled={busy}
                onClick={() => void savePaperToGalaxy()}
              >
                <Database className="mr-1.5 h-3.5 w-3.5" />Save to Galaxy
              </Button>
            )}
            {displayRevision.document && !displayRevision.document.durable_document && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-9 shrink-0 border-[var(--research-line)] bg-[hsl(var(--research-panel))] hover:bg-[hsl(var(--research-accent-soft))]"
                disabled={busy}
                onClick={() => void makeStoredPaperDurable()}
              >
                <Database className="mr-1.5 h-3.5 w-3.5" />Make durable
              </Button>
            )}
            {displayRevision.document && (
              <Badge variant="secondary" className="shrink-0" title={`SHA-256 ${displayRevision.document.content_sha256}`}>
                <Database className="mr-1 h-3.5 w-3.5" />{displayRevision.document.durable_document ? "Durable in Galaxy" : "Stored privately"} · {(displayRevision.document.byte_size / 1_000_000).toFixed(1)} MB
              </Badge>
            )}
            {displayRevision.document?.durable_document && (
              <Button asChild size="sm" variant="ghost" className="h-9 shrink-0">
                <a href={`/documents/${encodeURIComponent(displayRevision.document.durable_document.revision_id)}`}>
                  Open document
                </a>
              </Button>
            )}
            <Button asChild size="sm" variant="ghost" className="h-9 shrink-0">
              <a href={displayRevision.metadata.abs_url} target="_blank" rel="noreferrer" title="Open the arXiv abstract">
                Abstract <ExternalLink className="ml-1 h-3 w-3" />
              </a>
            </Button>
            {displayRevision.metadata.license_url && (
              <Button asChild size="sm" variant="ghost" className="h-9 shrink-0">
                <a href={displayRevision.metadata.license_url} target="_blank" rel="noreferrer" title="Open the licence this revision is published under">
                  License <ExternalLink className="ml-1 h-3 w-3" />
                </a>
              </Button>
            )}
          </>
        ) : undefined}
        accountMenu={accountMenu}
      >
        {/*
          Finding a paper and marking one up are the two things this surface
          does, so both live on its rail. The tools stay put rather than
          floating over the reader, which is why the pin they needed to stick
          while the page scrolled is gone.
        */}
        <form className="flex shrink-0 items-center gap-1.5" onSubmit={searchArxiv}>
          <Label htmlFor="arxiv-query" className="sr-only">Search arXiv</Label>
          <Input
            id="arxiv-query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a paper on arXiv"
            minLength={2}
            maxLength={300}
            className="h-9 w-56 bg-[hsl(var(--research-paper))]"
          />
          <Button type="submit" size="icon" className="h-9 w-9 shrink-0" disabled={busy} aria-label="Search arXiv">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          </Button>
        </form>

        {/*
          The library is how you get to a paper, not how you read one, so it
          hangs off the rail beside the search that fills it rather than taking
          a column away from the page for the whole session.
        */}
        <Popover open={libraryOpen} onOpenChange={setLibraryOpen}>
          <PopoverTrigger
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-[var(--research-line)] bg-[hsl(var(--research-panel))] px-3 text-sm text-foreground/80 transition hover:bg-[hsl(var(--research-accent-soft))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--research-accent))]"
            aria-label="Paper library"
          >
            <BookOpen className="h-4 w-4" aria-hidden="true" />
            Library
            <span className="text-xs text-muted-foreground">{papers.length}</span>
            <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden="true" />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-96 p-0">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="research-smallcaps text-xs text-muted-foreground">Paper shelf</span>
              <Link href="/library" className="text-xs font-medium text-primary underline-offset-4 hover:underline">
                Open full Library
              </Link>
            </div>
            {results.length > 0 && (
              <div className="border-b p-3">
                <p className="research-smallcaps mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <Search className="h-3.5 w-3.5" aria-hidden="true" />
                  arXiv results · import a versioned reference
                </p>
                <div className="max-h-56 space-y-2 overflow-auto" aria-label="arXiv search results">
                  {results.map((result) => (
                    <button
                      key={`${result.arxiv_id}v${result.arxiv_version}`}
                      className="min-h-11 w-full rounded-lg border p-2 text-left text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => importPaper(result)}
                    >
                      <span className="font-medium">{result.title}</span>
                      <span className="mt-1 block text-muted-foreground">{result.arxiv_id} · Import</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="p-3">
              <p className="research-smallcaps mb-2 text-xs text-muted-foreground">
                {papers.length} versioned reference{papers.length === 1 ? "" : "s"}
              </p>
              <div className="max-h-[22rem] space-y-2 overflow-auto">
                {papers.length === 0 && (
                  <p className="px-1 py-6 text-center text-sm text-muted-foreground">
                    Search arXiv above to import your first paper.
                  </p>
                )}
                {papers.map((paper) => (
                  <button
                    key={paper.id}
                    className={`min-h-11 w-full rounded-lg border p-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected?.id === paper.id ? "border-primary bg-primary/5" : "hover:bg-muted"}`}
                    onClick={() => { void openPaper(paper.id); setLibraryOpen(false) }}
                    aria-current={selected?.id === paper.id ? "true" : undefined}
                  >
                    <span className="line-clamp-2 font-medium">{paper.title}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">{paper.arxiv_id}v{paper.arxiv_version}</span>
                  </button>
                ))}
              </div>
            </div>
          </PopoverContent>
        </Popover>

        {paperSource && (
          <>
            {/*
              Plain controls rather than the floating HUD primitive: the rail is
              already the container, so a second bordered slab inside it read as
              a separate object sitting on the bar.
            */}
            {/*
              Pen and Box are tools you pick up and put down: clicking the
              active one releases it and text selection is what is left. A
              third button for "no tool" only named the absence of one.
            */}
            <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Paper marking tools">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectionMode((current) => current === "ink" ? "browse" : "ink")}
                aria-pressed={selectionMode === "ink"}
                className={selectionMode === "ink"
                  ? "rounded-md bg-[hsl(var(--research-accent))] text-white hover:bg-[hsl(var(--research-accent))] hover:text-white"
                  : "rounded-md text-foreground/70 hover:bg-[hsl(var(--research-accent-soft))] hover:text-foreground"}
                title={selectionMode === "ink" ? "Put the pen down" : "Draw one atomic mark"}
              >
                <PenLine className="mr-2 h-4 w-4" />
                Pen
              </Button>
              {/*
                The pen's colour belongs on the pen, not buried in a panel two
                disclosures down from the mark it applies to.
              */}
              <label
                className="relative inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full border border-[var(--research-line)]"
                style={{ background: classification.color }}
                title={`Ink colour: ${classification.color}`}
              >
                <span className="sr-only">Ink colour</span>
                <input
                  type="color"
                  value={classification.color}
                  onChange={(event) => setClassification((current) => ({ ...current, color: event.target.value }))}
                  className="absolute inset-0 cursor-pointer opacity-0"
                />
              </label>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectionMode((current) => current === "region" ? "browse" : "region")}
                aria-pressed={selectionMode === "region"}
                className={selectionMode === "region"
                  ? "rounded-md bg-[hsl(var(--research-accent))] text-white hover:bg-[hsl(var(--research-accent))] hover:text-white"
                  : "rounded-md text-foreground/70 hover:bg-[hsl(var(--research-accent-soft))] hover:text-foreground"}
                title={selectionMode === "region" ? "Put the clipper down" : "Clip a figure, equation or passage to cite"}
              >
                <BoxSelect className="mr-2 h-4 w-4" />
                Clip
              </Button>
            </div>

            <Button
              variant="outline"
              size="sm"
              className="h-9 shrink-0 border-[var(--research-line)] bg-[hsl(var(--research-panel))] hover:bg-[hsl(var(--research-accent-soft))]"
              disabled={!readerText}
              title={selection?.type === "text" ? "Read the selected passage aloud" : "Read the title and abstract aloud"}
              onClick={() => setReaderOpen(true)}
            >
              <Volume2 className="mr-2 h-4 w-4" />
              Read aloud
            </Button>


          </>
        )}
      </TopRail>

      {(error || status) && (
        <div
          role={error ? "alert" : "status"}
          aria-live="polite"
          className={`mb-4 rounded-xl border px-4 py-3 text-sm ${error ? "border-destructive/60 bg-destructive/5 text-destructive" : "bg-muted/40 text-muted-foreground"}`}
        >
          {error || status}
        </div>
      )}

      <div>
        <section className="min-w-0 space-y-3" aria-label="Paper workbench">
          {selected && displayRevision ? (
            <>
              {activeMechanism && (
                <MechanismNeighborhood
                  mechanismTag={activeMechanism}
                  items={mechanismNeighborhoodItems}
                />
              )}

              {/*
                Provenance is a standing fact about the document, not news. It
                reads as one quiet line under the title rather than a banner
                between the reader and the page.
              */}
              {displayRevision.document ? (
                <p className="research-kicker text-[#5c7566]" title="Every highlight, figure, equation and note stays pinned to this revision and its SHA-256 provenance.">
                  stored privately · pinned to this revision
                </p>
              ) : paperSource?.access === "private-research" ? (
                <p className="research-kicker text-[#5c7566]" title="Save it to Galaxy to keep the exact PDF privately with a canonical durable document identity.">
                  reading from arXiv · not yet stored
                </p>
              ) : null}


      {/*
        What you can do with a selection is offered where the selection is,
        rather than on a bar at the top of the page: the cluster follows the
        cursor that made it, so the action and its subject stay together.
      */}
      {paperSource && selection && selectionPoint && (
        <div
          className="pointer-events-none fixed z-40"
          style={{
            left: `${selectionPoint.x}px`,
            top: `${selectionPoint.y + 12}px`,
            transform: "translateX(-50%)",
          }}
          role="group"
          aria-label="Actions for selected paper coordinate"
        >
          <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-[hsl(var(--research-accent)/0.5)] bg-[hsl(157_22%_17%)] p-1 shadow-[0_14px_34px_-14px_hsl(var(--galaxy-shadow)/0.75)]">
            <SelectionAction
              label="Note"
              hint={annotationBody.trim() ? "Save this note" : "Write a note in the context card first"}
              icon={<MessageSquareText className="h-4 w-4" />}
              disabled={busy || !annotationBody.trim()}
              onClick={() => void persistSelection("comment")}
            />
            <SelectionAction
              label="Task"
              icon={<ListTodo className="h-4 w-4" />}
              disabled={busy || pendingTaskLinks.length > 0}
              onClick={() => void createSelectionTask("task")}
            />
            <SelectionAction
              label="Claim"
              icon={<Quote className="h-4 w-4" />}
              disabled={busy}
              onClick={() => void saveSelectionAsClaim()}
            />
            <SelectionAction
              label="Cite"
              icon={<Link2 className="h-4 w-4" />}
              disabled={busy}
              onClick={() => void copyCitation()}
            />
            <SelectionAction
              label="Enhance"
              icon={<Sparkles className="h-4 w-4" />}
              tone="warm"
              disabled={busy || pendingTaskLinks.length > 0}
              onClick={() => void createSelectionTask("enhance")}
            />
            <span className="mx-0.5 h-6 w-px shrink-0 bg-white/20" aria-hidden="true" />
            <SelectionAction
              label="Clear selection"
              icon={<X className="h-4 w-4" />}
              tone="quiet"
              onClick={() => { setSelection(null); setSelectionPoint(null) }}
            />
          </div>
        </div>
      )}

              {/*
                The selection context used to stack under the toolbar, so making
                a selection pushed the page down. It floats by the reader now,
                holding the mechanisms and note that the action cluster cannot.
              */}

              {paperSource ? (
                /*
                  The reader is the point of this page, so it gets the height.
                  Centred at a fixed measure rather than stretched to the full
                  column: a page of a paper is a fixed-width object, and reading
                  it is easier when it sits where a book would.
                */
                <div className={selection ? "grid gap-4 lg:grid-cols-2" : ""}>
                <Card className={selection ? "w-full overflow-hidden" : "mx-auto w-full max-w-5xl overflow-hidden"}>
                  <PDFViewer
                    data={paperPdfUrl}
                    className="h-[calc(100vh-13rem)] min-h-[32rem]"
                    textHighlights={textHighlights}
                    inkStrokes={inkStrokes}
                    regionHighlights={regionHighlights}
                    inkMode={selectionMode === "ink"}
                    regionMode={selectionMode === "region"}
                    inkColor={classification.color}
                    onTextSelection={(next, at) => chooseSelection({ type: "text", ...next }, at)}
                    onInkStroke={(next, at) => chooseSelection({ type: "ink", ...next }, at)}
                    onRegionSelection={(next, at) => chooseSelection({ type: "region", ...next }, at)}
                  />
                </Card>

                {/*
                  Reading and annotating happen together, so the note sits
                  beside the page rather than over it: the card used to float
                  across the document it was describing.
                */}
                {selection && (
                  <div className="max-h-[calc(100vh-13rem)] overflow-auto">
                    <PaperSelectionPalette
                      pageNumber={selection.pageNumber}
                      selectionLabel={selectionLabel(selection)}
                      isTextSelection={selection.type === "text"}
                      mechanisms={mechanisms}
                      suggestions={mechanismSuggestions}
                      customMechanism={customMechanism}
                      note={annotationBody}
                      busy={busy}
                      onClear={() => { setSelection(null); setSelectionPoint(null) }}
                      onToggleMechanism={(tag) => setMechanisms((current) => current.includes(tag) ? current.filter((value) => value !== tag) : uniqueTags(current, [tag]))}
                      onCustomMechanismChange={setCustomMechanism}
                      onAddMechanism={addMechanism}
                      onNoteChange={setAnnotationBody}
                    />
                  </div>
                )}
                </div>
              ) : (
                <Card>
                  <CardContent className="flex min-h-[48vh] flex-col items-center justify-center gap-4 p-8 text-center">
                    <BookOpen className="h-10 w-10 text-muted-foreground" />
                    <div className="max-w-xl space-y-2">
                      <p className="font-medium">This revision has invalid arXiv source metadata</p>
                      <p className="text-sm text-muted-foreground">Galaxy could not derive a canonical PDF URL. The official abstract remains available for inspection.</p>
                    </div>
                    <Button asChild>
                      <a href={displayRevision.metadata.abs_url} target="_blank" rel="noreferrer">Open arXiv abstract <ExternalLink className="ml-1 h-4 w-4" /></a>
                    </Button>
                  </CardContent>
                </Card>
              )}

              <details className="group rounded-xl border bg-card">
                <summary className="min-h-12 cursor-pointer list-none px-4 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                  Paper memory · {revisionAnnotations.length} coordinates · {selected.claims.length} claims · {selected.task_links.length} tasks
                  <span className="ml-2 text-xs font-normal text-muted-foreground">Open the proof map and task controls</span>
                </summary>
                <div className="grid gap-4 border-t p-4 xl:grid-cols-3">
                  <section className="space-y-3" aria-labelledby="coordinate-heading">
                    <h2 id="coordinate-heading" className="font-medium">Coordinates</h2>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="text-xs">Lens<select className="mt-1 min-h-10 w-full rounded-md border bg-background p-2" value={classification.lens} onChange={(event) => setClassification((current) => ({ ...current, lens: event.target.value as Classification["lens"] }))}><option value="proof">Proof</option><option value="audit">Audit</option><option value="analysis">Analysis</option></select></label>
                      <label className="text-xs">Role<select className="mt-1 min-h-10 w-full rounded-md border bg-background p-2" value={classification.semanticRole} onChange={(event) => setClassification((current) => ({ ...current, semanticRole: event.target.value as Classification["semanticRole"] }))}><option value="claim">Claim</option><option value="evidence">Evidence</option><option value="note">Note</option></select></label>
                    </div>
                    <div className="grid grid-cols-[1fr_auto] gap-2">
                      <Input value={classification.tags} onChange={(event) => setClassification((current) => ({ ...current, tags: event.target.value }))} placeholder="Other tags" aria-label="Other annotation tags" />
                      <Input className="h-10 w-12 p-1" type="color" value={classification.color} aria-label="Annotation color" onChange={(event) => setClassification((current) => ({ ...current, color: event.target.value }))} />
                    </div>
                    <div className="max-h-72 space-y-2 overflow-auto">
                      {revisionAnnotations.map((annotation) => (
                        <div key={annotation.id} className={`rounded-lg border text-xs ${activeAnnotationId === annotation.id ? "border-primary" : ""}`}>
                          <button onClick={() => { setActiveAnnotationId(annotation.id); if (annotation.anchor.type === "text") setClaimStatement(annotation.anchor.quote) }} className="min-h-11 w-full p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                            <span>p.{annotation.page_number} · {annotation.anchor.type} · {annotation.semantic_role} · {annotation.lens}</span>
                            {annotation.anchor.type === "text" && <span className="research-prose mt-1 block line-clamp-2 text-sm text-muted-foreground">{annotation.anchor.quote}</span>}
                            {annotation.anchor.type === "region" && <span className="mt-1 block text-muted-foreground">Box at {Math.round(annotation.anchor.x * 100)}%, {Math.round(annotation.anchor.y * 100)}%</span>}
                          </button>
                          {annotation.body && (
                            <MarkdownRenderer content={annotation.body} images="omit" className="research-prose mx-2 mb-2 rounded bg-muted p-2 text-sm text-foreground" />
                          )}
                          {annotation.tags.filter((tag) => tag.startsWith("mechanism:")).length > 0 && (
                            <nav className="flex flex-wrap gap-1 border-t p-2" aria-label="Annotation mechanisms">
                              {annotation.tags.filter((tag) => tag.startsWith("mechanism:")).map((tag) => (
                                <Link key={tag} href={mechanismHref(tag)} className="research-smallcaps inline-flex min-h-9 items-center rounded-full border border-primary/25 bg-primary/5 px-2.5 text-[11px] text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                  {mechanismLabel(tag)} ↗
                                </Link>
                              ))}
                            </nav>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="space-y-3" aria-labelledby="claims-heading">
                    <h2 id="claims-heading" className="font-medium">Claims & evidence</h2>
                    <Textarea value={claimStatement} onChange={(event) => setClaimStatement(event.target.value)} placeholder="Claim statement" maxLength={20_000} />
                    <Button className="w-full" variant="outline" onClick={createClaim} disabled={!claimStatement.trim() || busy}>Create claim</Button>
                    <div className="max-h-72 space-y-2 overflow-auto">
                      {selected.claims.map((claim) => {
                        const evidence = selected.evidence_links.flatMap((link) => {
                          if (link.claim_id !== claim.id) return []
                          const annotation = selected.annotations.find((candidate) => candidate.id === link.annotation_id)
                          return annotation ? [{ link, annotation }] : []
                        })
                        return (
                          <div key={claim.id} className={`rounded-lg border text-xs ${activeClaimId === claim.id ? "border-primary" : ""}`}>
                            <button onClick={() => setActiveClaimId(claim.id)} className="min-h-11 w-full p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"><Badge variant="outline">{claim.status}</Badge><span className="ml-2">{claim.statement}</span></button>
                            {evidence.length > 0 && <ul className="space-y-1 border-t px-2 py-2 text-muted-foreground">{evidence.map(({ link, annotation }) => <li key={`${link.claim_id}:${link.annotation_id}`}><strong className="text-foreground">{link.relation}</strong> · p.{annotation.page_number} · {annotation.anchor.type === "text" ? annotation.anchor.quote : `${annotation.anchor.type} coordinate`}{annotation.body ? ` — ${annotation.body}` : ""}</li>)}</ul>}
                          </div>
                        )
                      })}
                    </div>
                    <div className="flex gap-2">
                      <select className="min-h-10 min-w-0 flex-1 rounded-md border bg-background p-2 text-xs" value={evidenceRelation} aria-label="Evidence relation" onChange={(event) => setEvidenceRelation(event.target.value as typeof evidenceRelation)}><option value="supports">supports</option><option value="refutes">refutes</option><option value="context">context</option></select>
                      <Button size="sm" onClick={linkEvidence} disabled={!activeClaimId || !activeAnnotationId}>Link evidence</Button>
                    </div>
                  </section>

                  <section className="space-y-3" aria-labelledby="tasks-heading">
                    <h2 id="tasks-heading" className="flex items-center gap-2 font-medium"><ListTodo className="h-4 w-4" />Tasks</h2>
                    <p className="text-xs text-muted-foreground">HAM owns lifecycle. Galaxy keeps the paper, revision, claim, and coordinate references.</p>
                    <Label htmlFor="paper-task-title">Task title</Label>
                    <Input id="paper-task-title" value={taskTitle} maxLength={200} onChange={(event) => setTaskTitle(event.target.value)} />
                    {pendingTaskLinks.map((pendingTaskLink) => (
                      <div key={pendingTaskLink.idempotencyKey} className="space-y-2 rounded-md border border-amber-500/60 bg-amber-500/5 p-3 text-xs" role="status">
                        <p className="font-medium">Unfinished HAM link operation</p>
                        <p className="break-all text-muted-foreground">{pendingTaskLink.taskId ? `Task ${pendingTaskLink.taskId} exists in HAM and still needs its Galaxy link.` : "Galaxy will retry task creation with the original idempotency key, then save its link."}</p>
                        <div className="grid grid-cols-2 gap-2">
                          <Button size="sm" disabled={busy} onClick={() => void continueTaskLink(pendingTaskLink)}>Retry pending link</Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            title="Stop tracking this operation. Any task already created in HAM stays there."
                            onClick={() => {
                              clearTaskLink(pendingTaskLink)
                              setStatus("Stopped tracking the unfinished link. Any task already in HAM is unaffected.")
                            }}
                          >
                            Discard
                          </Button>
                        </div>
                      </div>
                    ))}
                    <div className="grid grid-cols-2 gap-2">
                      <Button onClick={createDocumentTask} disabled={busy || pendingTaskLinks.length > 0}>Document task</Button>
                      <Button variant="outline" onClick={createSubtask} disabled={busy || pendingTaskLinks.length > 0}>Evidence subtask</Button>
                    </div>
                    <div className="max-h-40 space-y-1 overflow-auto text-xs text-muted-foreground">{selected.task_links.map((link) => <div key={link.id}>{link.relation}: {link.title_snapshot} ({link.ham_task_id})</div>)}</div>
                  </section>
                </div>
              </details>

              <PaperTimeRail
                events={paperTimeEvents}
                onEventSelect={(event) => {
                  if (event.id.startsWith("revision:")) switchRevision(event.id.slice("revision:".length))
                  if (event.id.startsWith("annotation:")) setActiveAnnotationId(event.id.slice("annotation:".length))
                  if (event.id.startsWith("claim:")) setActiveClaimId(event.id.slice("claim:".length))
                  setStatus(`${event.label}: ${event.detail}`)
                }}
              />
            </>
          ) : selected ? (
            <Card><CardContent className="p-8 text-center text-destructive">This paper has no immutable metadata revision.</CardContent></Card>
          ) : (
            <Card className="flex min-h-[70vh] items-center justify-center">
              <CardContent className="max-w-md text-center text-muted-foreground">
                <BookOpen className="mx-auto mb-4 h-10 w-10" />
                <p className="font-medium text-foreground">Open a paper, then select what matters.</p>
                <p className="mt-2 text-sm">Exact words, pen marks, and boxed regions become versioned coordinates—not loose notes beside a document.</p>
              </CardContent>
            </Card>
          )}
        </section>
      </div>

      {readerOpen && <TTSReaderPanel initialText={readerText} onClose={() => setReaderOpen(false)} />}
    </main>
  )
}
