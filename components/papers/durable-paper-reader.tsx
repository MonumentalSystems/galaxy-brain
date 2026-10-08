"use client"

import Link from "next/link"
import {
  BookOpen,
  BoxSelect,
  Check,
  ExternalLink,
  FileText,
  Link2,
  ListTodo,
  Loader2,
  MousePointer2,
  PanelsTopLeft,
  PenLine,
  Play,
  Quote,
  RotateCcw,
  Scale,
  ShieldQuestion,
  Sparkles,
} from "lucide-react"
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"

import { MarkdownRenderer } from "@/components/markdown-renderer"
import { DocumentMarkPanel } from "@/components/documents/document-mark-panel"
import { PaperAgentResultCard } from "@/components/papers/paper-agent-result-card"
import { DocumentStructureReader } from "@/components/papers/document-structure-reader"
import {
  PDFViewer,
  type PDFExactTextHighlight,
  type PDFInkStroke,
  type PDFRegionHighlight,
  type PDFRegionSelection,
  type PDFTextSelection,
} from "@/components/pdf-viewer"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DocumentTransformClientError } from "@/lib/document-transform-client.js"
import type { DocumentLocalIndexStatus } from "@/lib/document-local-index.js"
import {
  paperEnhanceIntentAvailabilityForInput,
  paperEnhanceReferenceInputState,
  paperEnhancePreset,
  type PaperEnhanceIntent,
} from "@/lib/paper-enhance-handoff.js"
import type { DurableTransformReceipt, GalaxyDocumentStructure } from "@/lib/ingestion-contract.js"
import {
  chooseReaderRepresentationState,
  paperReaderSearch,
  parsePaperReaderLocation,
  projectExactPageRegion,
  shouldAcceptPaperMarkCompletion,
  shouldCommitPaperAnchorCompletion,
  rectangleToPageRegion,
  textQuoteAnchorForSelection,
  validateReaderDocumentIdentity,
  type PaperReaderLocation,
  type ReaderRepresentation,
} from "@/lib/paper-reader.js"
import type {
  DocumentMarkAnchor,
  DocumentMarkCreateIntent,
  DurableDocumentMark as ValidatedDurableDocumentMark,
} from "@/lib/document-mark-client.js"
import {
  createGalaxyPaperReaderDataPort,
  createGalaxyPaperReaderActionPort,
  paperTaskRecoveryKey,
  readPaperTaskRecoveries,
  type DurableDocumentAnchor,
  type PaperAgentResultCandidate,
  type PaperAgentResultDecision,
  type PaperReaderActionPort,
  type PaperReaderBacklink,
  type PaperReaderDataPort,
  type PaperReaderTaskRequest,
} from "@/lib/paper-reader-client"
import {
  placeDocumentAnchorRecoverably,
  validateDocumentAnchorPlacementRecovery,
} from "@/lib/canvas/document-anchor-canvas"
import { atlasPlacementHref } from "@/lib/canvas/atlas-location.js"
import { cn } from "@/lib/utils"

type ReaderTool = "read" | "pen" | "box"
type TransformPhase = "idle" | "starting" | "running" | "ready" | "failed" | "uncertain"

type DraftRegion = {
  page: number
  x: number
  y: number
  width: number
  height: number
  source: "box" | "pen" | "page"
}

type DraftQuote = {
  page: number
  exact: string
  representationId: string
  selector: { kind: "text-quote"; exact: string; page?: number }
}

type SessionDocumentMark = {
  mark: ValidatedDurableDocumentMark
  anchor: DocumentMarkAnchor
}

export type DurablePaperReaderProps = {
  documentRevisionId: string
  title: string
  tenantId: string
  principalId: string
  dataPort?: PaperReaderDataPort
  actionPort?: PaperReaderActionPort
  /** Override for deployments whose authorized representation-content route differs. */
  contentUrl?: (documentRevisionId: string, representation: ReaderRepresentation) => string
  className?: string
}

const defaultDataPort = createGalaxyPaperReaderDataPort()
const defaultActionPort = createGalaxyPaperReaderActionPort()

function currentLocation(): PaperReaderLocation {
  if (typeof window === "undefined") {
    return { schemaId: "gb.paper-reader-location.v1", view: "pdf", page: 1, anchorId: null }
  }
  return parsePaperReaderLocation(window.location.search)
}

function regionFromInk(stroke: Omit<PDFInkStroke, "id" | "color">): DraftRegion | null {
  if (stroke.points.length < 2) return null
  const xs = stroke.points.map((point) => point.x)
  const ys = stroke.points.map((point) => point.y)
  const padding = 0.006
  const x = Math.max(0, Math.min(...xs) - padding)
  const y = Math.max(0, Math.min(...ys) - padding)
  const right = Math.min(1, Math.max(...xs) + padding)
  const bottom = Math.min(1, Math.max(...ys) + padding)
  if (right - x < 0.01 || bottom - y < 0.01) return null
  return { page: stroke.pageNumber, x, y, width: right - x, height: bottom - y, source: "pen" }
}

function anchorRegion(anchor: DurableDocumentAnchor): DraftRegion | null {
  if (anchor.selector.kind !== "page-region") return null
  const xs = anchor.selector.polygon.filter((_, index) => index % 2 === 0)
  const ys = anchor.selector.polygon.filter((_, index) => index % 2 === 1)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return {
    page: anchor.selector.page,
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
    source: "box",
  }
}

function shortAnchor(anchor: DurableDocumentAnchor) {
  return `${anchor.id.slice(0, 15)}…${anchor.id.slice(-7)}`
}

function mergeSessionMark(current: SessionDocumentMark[], next: SessionDocumentMark) {
  return [...current.filter((item) => item.mark.id !== next.mark.id), next]
}

export function DurablePaperReader({
  documentRevisionId: rawRevisionId,
  title: rawTitle,
  tenantId,
  principalId,
  dataPort = defaultDataPort,
  actionPort = defaultActionPort,
  contentUrl,
  className,
}: DurablePaperReaderProps) {
  const identity = useMemo(
    () => validateReaderDocumentIdentity({ documentRevisionId: rawRevisionId, title: rawTitle }),
    [rawRevisionId, rawTitle],
  )
  const noteId = useId()
  const taskTitleId = useId()
  const taskGoalId = useId()
  const enhancePanelId = useId()
  const enhanceRefsId = useId()
  const enhanceRefsHelpId = useId()
  const [location, setLocation] = useState(currentLocation)
  const initialAnchorId = useRef(location.anchorId).current
  const [representations, setRepresentations] = useState<ReaderRepresentation[]>([])
  const [receipts, setReceipts] = useState<DurableTransformReceipt[]>([])
  const [localIndex, setLocalIndex] = useState<DocumentLocalIndexStatus | undefined>(undefined)
  const [anchors, setAnchors] = useState<DurableDocumentAnchor[]>([])
  const [backlinks, setBacklinks] = useState<PaperReaderBacklink[]>([])
  const [backlinksAnchorRef, setBacklinksAnchorRef] = useState("")
  const [agentResults, setAgentResults] = useState<PaperAgentResultCandidate[]>([])
  const [agentResultsLoading, setAgentResultsLoading] = useState(false)
  const [agentResultsError, setAgentResultsError] = useState("")
  const [agentResultBusyKey, setAgentResultBusyKey] = useState("")
  const [agentResultRefresh, setAgentResultRefresh] = useState(0)
  const [sessionMarks, setSessionMarks] = useState<SessionDocumentMark[]>([])
  const [markListRevision, setMarkListRevision] = useState(0)
  const [pendingMarks, setPendingMarks] = useState<readonly DocumentMarkCreateIntent[]>([])
  const [markRecoveryError, setMarkRecoveryError] = useState("")
  const [pendingTasks, setPendingTasks] = useState<PaperReaderTaskRequest[]>([])
  const [atlasPlacement, setAtlasPlacement] = useState<{ anchorId: string; href: string } | null>(null)
  const [tool, setTool] = useState<ReaderTool>("read")
  const [draft, setDraft] = useState<DraftRegion | null>(null)
  const [draftQuote, setDraftQuote] = useState<DraftQuote | null>(null)
  const [note, setNote] = useState("")
  const [taskTitle, setTaskTitle] = useState(`Investigate: ${identity.title}`.slice(0, 200))
  const [taskGoal, setTaskGoal] = useState("")
  const [enhanceOpen, setEnhanceOpen] = useState(false)
  const [enhanceIntent, setEnhanceIntent] = useState<PaperEnhanceIntent>("explain")
  const [enhanceRefsText, setEnhanceRefsText] = useState("")
  const [enhanceReadability, setEnhanceReadability] = useState<{
    signature: string
    status: "idle" | "checking" | "readable" | "unavailable"
  }>({ signature: "", status: "idle" })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("Loading exact document evidence…")
  const [error, setError] = useState("")
  const [transformPhase, setTransformPhase] = useState<TransformPhase>("idle")
  const [transformMessage, setTransformMessage] = useState("No derived representation has been requested.")
  const [transformError, setTransformError] = useState("")
  const transformController = useRef<AbortController | null>(null)
  const derivedViewTrigger = useRef<HTMLButtonElement | null>(null)
  const markStatusRef = useRef<HTMLDivElement | null>(null)
  const selectionGeneration = useRef(0)
  const noteEditGeneration = useRef(0)
  const markOperationGeneration = useRef(0)
  const agentResultGeneration = useRef(0)
  const mountedMarkScope = useRef<string | null>(null)
  const markScopeKey = useMemo(
    () => JSON.stringify([tenantId, principalId, identity.documentRevisionId]),
    [identity.documentRevisionId, principalId, tenantId],
  )

  const selectedAnchor = useMemo(
    () => anchors.find((anchor) => anchor.id === location.anchorId) ?? null,
    [anchors, location.anchorId],
  )
  const agentResultAnchorRef = useRef(selectedAnchor?.ref ?? "")
  agentResultAnchorRef.current = selectedAnchor?.ref ?? ""
  const enhanceReferenceState = useMemo(() => selectedAnchor
    ? paperEnhanceReferenceInputState(selectedAnchor.ref, enhanceRefsText)
    : { references: [] as readonly string[], error: "Select one saved exact anchor first." },
  [enhanceRefsText, selectedAnchor])
  const enhanceReferenceSignature = enhanceReferenceState.references.join("\n")
  const enhanceReferencesReadable = enhanceReadability.status === "readable"
    && enhanceReadability.signature === enhanceReferenceSignature
  const hasFreshEnhanceSelection = !selectedAnchor && Boolean(draft || draftQuote)
  const enhanceAvailabilityForIntent = (intent: PaperEnhanceIntent) => hasFreshEnhanceSelection
    ? {
        enabled: intent === "explain" || intent === "challenge",
        reason: intent === "explain" || intent === "challenge"
          ? "Ready from the selected exact evidence. Its anchor will be saved when you confirm."
          : "Save this exact anchor before adding and checking other pinned references.",
      }
    : paperEnhanceIntentAvailabilityForInput(
        intent,
        enhanceReferenceState,
        enhanceReferencesReadable,
      )
  const enhanceAvailability = enhanceAvailabilityForIntent(enhanceIntent)
  const selectedRepresentationState = useMemo(
    () => chooseReaderRepresentationState(representations, receipts),
    [receipts, representations],
  )
  const selectedRepresentations = selectedRepresentationState
  const quoteRepresentations = useMemo(
    () => [selectedRepresentations.text, selectedRepresentations.markdown]
      .filter((representation): representation is ReaderRepresentation => Boolean(representation)),
    [selectedRepresentations.markdown, selectedRepresentations.text],
  )
  const pdfUrl = selectedRepresentations.original
    ? (contentUrl ?? dataPort.representationContentUrl)(identity.documentRevisionId, selectedRepresentations.original)
    : ""

  const updateLocation = useCallback((next: Partial<Omit<PaperReaderLocation, "schemaId">>) => {
    setLocation((current) => ({ ...current, ...next }))
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    const search = paperReaderSearch(window.location.search, location)
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}${window.location.hash}`)
  }, [location])

  const refreshRecoveries = useCallback(() => {
    try {
      setPendingTasks(readPaperTaskRecoveries(
        window.localStorage,
        tenantId,
        principalId,
        identity.documentRevisionId,
      ))
    } catch {
      setPendingTasks([])
    }
  }, [identity.documentRevisionId, principalId, tenantId])

  const refreshMarkRecoveries = useCallback(() => {
    if (mountedMarkScope.current !== markScopeKey) return
    if (!actionPort?.listMarkRecoveries) {
      setPendingMarks([])
      setMarkRecoveryError("")
      return
    }
    try {
      setPendingMarks(actionPort.listMarkRecoveries())
      setMarkRecoveryError("")
    } catch (reason) {
      setPendingMarks([])
      setMarkRecoveryError(reason instanceof Error
        ? reason.message
        : "Local recovery storage is unavailable. No document mark will be sent.")
    }
  }, [actionPort, markScopeKey])

  useEffect(() => {
    mountedMarkScope.current = markScopeKey
    return () => {
      if (mountedMarkScope.current === markScopeKey) mountedMarkScope.current = null
      markOperationGeneration.current += 1
    }
  }, [markScopeKey])

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setLoading(true)
    setError("")
    const representationState = dataPort.loadRepresentationState
      ? dataPort.loadRepresentationState(identity.documentRevisionId, controller.signal)
      : dataPort.loadRepresentations(identity.documentRevisionId, controller.signal).then((items) => ({
          representations: items,
          receipts: [] as DurableTransformReceipt[],
          localIndex: undefined,
        }))
    Promise.all([
      representationState,
      dataPort.listAnchors(identity.documentRevisionId, controller.signal),
    ]).then(([nextRepresentationState, nextAnchors]) => {
      if (!active) return
      setRepresentations(nextRepresentationState.representations)
      setReceipts(nextRepresentationState.receipts)
      setLocalIndex(nextRepresentationState.localIndex)
      const available = chooseReaderRepresentationState(
        nextRepresentationState.representations,
        nextRepresentationState.receipts,
      )
      if (available.structure || available.markdown) {
        setTransformPhase("ready")
        setTransformMessage(available.structure
          ? "Structured text is ready; the exact original remains authoritative."
          : available.receipt?.status === "fallback"
            ? "A Markdown fallback is ready; the exact original remains authoritative."
            : "Converter-authored Markdown is ready; the exact original remains authoritative.")
      } else if (available.primaryReceipt?.status === "failed") {
        setTransformPhase("failed")
        setTransformError("The latest extraction did not produce a derived view. The original remains available.")
      }
      if (initialAnchorId && !nextAnchors.some((anchor) => anchor.id === initialAnchorId)) {
        return dataPort.getAnchor(identity.documentRevisionId, initialAnchorId, controller.signal).then((anchor) => {
          if (!active) return
          setAnchors([...nextAnchors, anchor])
          setStatus("Exact source coordinate restored from its durable deep link.")
        })
      }
      setAnchors(nextAnchors)
      setStatus(initialAnchorId
        ? "Exact source coordinate restored from its durable deep link."
        : "Exact revision restored. Select a region to create a durable coordinate.")
    }).catch((reason: unknown) => {
      if (!active) return
      setError(reason instanceof Error ? reason.message : "The document reader could not be restored.")
      setStatus("")
    }).finally(() => {
      if (active) setLoading(false)
    })
    refreshRecoveries()
    refreshMarkRecoveries()
    return () => {
      active = false
      controller.abort()
    }
  }, [dataPort, identity.documentRevisionId, initialAnchorId, refreshMarkRecoveries, refreshRecoveries])

  useEffect(() => () => transformController.current?.abort(), [])
  useEffect(() => {
    if (loading) return
    if (location.view === "structure" && !selectedRepresentations.structure) {
      updateLocation({ view: "pdf" })
    } else if (location.view === "markdown" && !selectedRepresentations.markdown) {
      updateLocation({ view: "pdf" })
    }
  }, [loading, location.view, selectedRepresentations.markdown, selectedRepresentations.structure, updateLocation])

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage) {
        refreshRecoveries()
        refreshMarkRecoveries()
      }
    }
    window.addEventListener("storage", handleStorage)
    return () => window.removeEventListener("storage", handleStorage)
  }, [refreshMarkRecoveries, refreshRecoveries])

  useEffect(() => {
    let active = true
    if (!selectedAnchor || !actionPort?.listBacklinks) {
      setBacklinks([])
      setBacklinksAnchorRef("")
      return
    }
    setBacklinks([])
    setBacklinksAnchorRef(selectedAnchor.ref)
    actionPort.listBacklinks(selectedAnchor).then((items) => {
      if (active) {
        setBacklinks(items)
        setBacklinksAnchorRef(selectedAnchor.ref)
      }
    }).catch(() => {
      if (active) setBacklinks([])
    })
    return () => { active = false }
  }, [actionPort, selectedAnchor])

  useEffect(() => {
    const generation = agentResultGeneration.current + 1
    agentResultGeneration.current = generation
    const controller = new AbortController()
    if (
      !selectedAnchor
      || backlinksAnchorRef !== selectedAnchor.ref
      || !actionPort?.listAgentResults
    ) {
      setAgentResults([])
      setAgentResultsLoading(false)
      setAgentResultsError("")
      return () => controller.abort()
    }
    setAgentResultsLoading(true)
    setAgentResultsError("")
    actionPort.listAgentResults(selectedAnchor, backlinks, controller.signal).then((results) => {
      if (agentResultGeneration.current === generation) setAgentResults(results)
    }).catch((reason: unknown) => {
      if (controller.signal.aborted || agentResultGeneration.current !== generation) return
      setAgentResults([])
      setAgentResultsError(reason instanceof Error ? reason.message : "Completed agent results could not be loaded.")
    }).finally(() => {
      if (agentResultGeneration.current === generation) setAgentResultsLoading(false)
    })
    return () => controller.abort()
  }, [actionPort, agentResultRefresh, backlinks, backlinksAnchorRef, selectedAnchor])

  useEffect(() => {
    setEnhanceOpen(false)
    setEnhanceIntent("explain")
    setEnhanceRefsText("")
    setEnhanceReadability({ signature: "", status: "idle" })
  }, [selectedAnchor?.ref])

  useEffect(() => {
    if (!selectedAnchor) return
    const region = anchorRegion(selectedAnchor)
    if (region && (region.page !== location.page || location.view !== "pdf")) {
      updateLocation({ page: region.page, view: "pdf" })
      return
    }
    if (selectedAnchor.selector.kind === "text-quote" && selectedAnchor.selector.page
      && selectedAnchor.selector.page !== location.page) {
      updateLocation({ page: selectedAnchor.selector.page })
    }
  }, [location.page, location.view, selectedAnchor, updateLocation])

  useEffect(() => {
    let active = true
    setAtlasPlacement(null)
    if (!selectedAnchor || typeof window === "undefined") return () => { active = false }
    void validateDocumentAnchorPlacementRecovery(
      selectedAnchor,
      tenantId,
      principalId,
      window.localStorage,
    ).then((recovery) => {
      if (!active || !recovery) return
      setAtlasPlacement({
        anchorId: selectedAnchor.id,
        href: atlasPlacementHref(recovery.canvasId, recovery.placementId),
      })
    }).catch(() => {
      if (active) setAtlasPlacement(null)
    })
    return () => { active = false }
  }, [identity.documentRevisionId, principalId, selectedAnchor, tenantId])

  const anchorHighlights = useMemo<PDFRegionHighlight[]>(() => anchors.flatMap((anchor) => {
    const region = anchorRegion(anchor)
    return region ? [{
      id: anchor.id,
      pageNumber: region.page,
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
      color: anchor.id === selectedAnchor?.id ? "#b66238" : "#3f6b57",
    }] : []
  }), [anchors, selectedAnchor?.id])

  const markRegionHighlights = useMemo<PDFRegionHighlight[]>(() => sessionMarks.flatMap(({ mark, anchor }) => {
    const region = projectExactPageRegion(anchor.selector)
    return region ? [{ ...region, id: `mark:${mark.id}`, color: mark.color }] : []
  }), [sessionMarks])

  const markTextHighlights = useMemo<PDFExactTextHighlight[]>(() => sessionMarks.flatMap(({ mark, anchor }) => (
    anchor.selector.kind === "text-quote"
      ? [{ id: `mark:${mark.id}`, selector: anchor.selector, color: `${mark.color}55` }]
      : []
  )), [sessionMarks])

  const regionHighlights = useMemo(
    () => [...anchorHighlights, ...markRegionHighlights],
    [anchorHighlights, markRegionHighlights],
  )

  const chooseRegion = useCallback((region: PDFRegionSelection) => {
    selectionGeneration.current += 1
    setAtlasPlacement(null)
    setDraft({ page: region.pageNumber, x: region.x, y: region.y, width: region.width, height: region.height, source: region.width === 1 && region.height === 1 ? "page" : "box" })
    setDraftQuote(null)
    updateLocation({ page: region.pageNumber, anchorId: null })
    setTool("read")
    setStatus("Region ready. Add a note, clip it, or create a task from the pinned coordinate.")
  }, [updateLocation])

  const chooseInk = useCallback((stroke: Omit<PDFInkStroke, "id" | "color">) => {
    selectionGeneration.current += 1
    setAtlasPlacement(null)
    const region = regionFromInk(stroke)
    if (!region) {
      setError("Draw a slightly larger mark so it identifies a stable page region.")
      return
    }
    setDraft(region)
    setDraftQuote(null)
    updateLocation({ page: region.page, anchorId: null })
    setTool("read")
    setStatus("Pen mark bounded to an exact page region. Add a note or create a task.")
  }, [updateLocation])

  const chooseText = useCallback((selection: PDFTextSelection) => {
    selectionGeneration.current += 1
    setAtlasPlacement(null)
    setError("")
    try {
      const planned = textQuoteAnchorForSelection(quoteRepresentations, selection.quote, selection.pageNumber)
      setDraft(null)
      setDraftQuote({
        page: selection.pageNumber,
        exact: selection.quote,
        representationId: planned.representation.id,
        selector: planned.selector,
      })
      updateLocation({ page: selection.pageNumber, anchorId: null })
      setTool("read")
      setStatus("Exact quote ready. Add a note, place it on the atlas, or create a task from this text.")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The selected text is not present in an exact text representation.")
    }
  }, [quoteRepresentations, updateLocation])

  const ensureAnchor = useCallback(async (expectedSelectionGeneration?: number) => {
    if (selectedAnchor && !draft && !draftQuote) return selectedAnchor
    if (draftQuote) {
      const anchor = await dataPort.createAnchor(
        identity.documentRevisionId,
        draftQuote.representationId,
        draftQuote.selector,
      )
      if (!shouldCommitPaperAnchorCompletion(expectedSelectionGeneration, selectionGeneration.current)) return anchor
      setAnchors((current) => current.some((item) => item.id === anchor.id) ? current : [...current, anchor])
      setDraftQuote(null)
      updateLocation({ page: draftQuote.page, anchorId: anchor.id })
      return anchor
    }
    if (!draft || !selectedRepresentations.structure) {
      throw new Error("A page-aware document-structure representation and selected region are required.")
    }
    const selector = rectangleToPageRegion(draft.page, draft)
    const anchor = await dataPort.createAnchor(
      identity.documentRevisionId,
      selectedRepresentations.structure.id,
      selector,
    )
    if (!shouldCommitPaperAnchorCompletion(expectedSelectionGeneration, selectionGeneration.current)) return anchor
    setAnchors((current) => current.some((item) => item.id === anchor.id) ? current : [...current, anchor])
    setDraft(null)
    updateLocation({ page: draft.page, anchorId: anchor.id })
    return anchor
  }, [dataPort, draft, draftQuote, identity.documentRevisionId, selectedAnchor, selectedRepresentations.structure, updateLocation])

  const sourceHrefFor = useCallback((anchor: DurableDocumentAnchor) => {
    if (typeof window === "undefined") return ""
    const region = anchorRegion(anchor)
    const quotePage = anchor.selector.kind === "text-quote" ? anchor.selector.page : undefined
    const search = paperReaderSearch(window.location.search, {
      view: "pdf",
      page: region?.page ?? quotePage ?? location.page,
      anchorId: anchor.id,
    })
    return `${window.location.origin}${window.location.pathname}${search}`
  }, [location.page])

  function beginMarkOperation() {
    const generation = markOperationGeneration.current + 1
    markOperationGeneration.current = generation
    return {
      generation,
      selectionGeneration: selectionGeneration.current,
      documentRevisionId: identity.documentRevisionId,
      scopeKey: markScopeKey,
    }
  }

  function isMountedMarkOperationScope(operation: ReturnType<typeof beginMarkOperation>) {
    return mountedMarkScope.current === operation.scopeKey
  }

  function isCurrentMarkOperation(
    operation: ReturnType<typeof beginMarkOperation>,
    requireCurrentSelection = true,
  ) {
    return shouldAcceptPaperMarkCompletion(operation, {
      generation: markOperationGeneration.current,
      selectionGeneration: selectionGeneration.current,
      documentRevisionId: identity.documentRevisionId,
    }, { requireSelection: requireCurrentSelection })
  }

  async function createMark(intent: "note" | "clip") {
    const frozenIntent = intent
    const frozenBody = note.trim()
    const frozenNoteEditGeneration = noteEditGeneration.current
    const operation = beginMarkOperation()
    setBusy(true)
    setError("")
    try {
      const anchor = await ensureAnchor(operation.selectionGeneration)
      if (!isCurrentMarkOperation(operation)) return
      if (!actionPort?.createMark) {
        setStatus(`Pinned ${shortAnchor(anchor)}. Mark persistence is not installed in this deployment yet.`)
        return
      }
      const mark = await actionPort.createMark({
        anchor,
        body: frozenBody,
        intent: frozenIntent,
        sourceHref: sourceHrefFor(anchor),
      })
      if (!isCurrentMarkOperation(operation)) return
      if (mark.anchor_id !== anchor.id) throw new Error("The saved mark acknowledgement targeted a different anchor.")
      setSessionMarks((current) => mergeSessionMark(current, {
        mark,
        anchor: anchor as unknown as DocumentMarkAnchor,
      }))
      setMarkListRevision((current) => current + 1)
      if (noteEditGeneration.current === frozenNoteEditGeneration) setNote("")
      setStatus(frozenIntent === "clip" ? "Clip saved with exact source lineage." : "Margin note saved with exact source lineage.")
    } catch (reason) {
      if (isCurrentMarkOperation(operation)) {
        setError(reason instanceof Error ? reason.message : "The anchored mark could not be created.")
      }
    } finally {
      if (isMountedMarkOperationScope(operation)) refreshMarkRecoveries()
      if (isCurrentMarkOperation(operation, false)) setBusy(false)
    }
  }

  async function retryMark(intent: DocumentMarkCreateIntent) {
    if (!actionPort?.retryMark) return
    const operation = beginMarkOperation()
    setBusy(true)
    setError("")
    try {
      const mark = await actionPort.retryMark(intent)
      if (!isCurrentMarkOperation(operation)) return
      setSessionMarks((current) => mergeSessionMark(current, { mark, anchor: intent.anchor }))
      if (selectedAnchor?.id === intent.anchor.id
        && selectedAnchor.ref === intent.anchor.ref
        && selectedAnchor.document_revision_id === intent.anchor.document_revision_id) {
        setMarkListRevision((current) => current + 1)
      }
      setStatus(mark.replayed
        ? "Recovered the existing document mark from the exact frozen request."
        : "Recovered and saved the exact frozen document mark request.")
      window.requestAnimationFrame(() => {
        if (isCurrentMarkOperation(operation)) markStatusRef.current?.focus()
      })
    } catch (reason) {
      if (isCurrentMarkOperation(operation)) {
        setError(reason instanceof Error ? reason.message : "The exact document mark request remains available to retry.")
      }
    } finally {
      if (isMountedMarkOperationScope(operation)) refreshMarkRecoveries()
      if (isCurrentMarkOperation(operation, false)) setBusy(false)
    }
  }

  async function dispatchTask(
    request?: PaperReaderTaskRequest,
    draft?: {
      title: string
      goal: string
      resourceRefs?: readonly string[]
      expectedSelectionGeneration?: number
      executionMode?: "review" | "run"
    },
  ) {
    if (!actionPort?.createTask) return
    setBusy(true)
    setError("")
    let pending = request
    try {
      if (!pending) {
        const anchor = await ensureAnchor(draft?.expectedSelectionGeneration)
        if (!shouldCommitPaperAnchorCompletion(draft?.expectedSelectionGeneration, selectionGeneration.current)) return
        pending = {
          schemaId: "gb.paper-task-request.v1",
          idempotencyKey: crypto.randomUUID(),
          requestedAt: new Date().toISOString(),
          anchor,
          resourceRefs: draft?.resourceRefs ?? [anchor.ref],
          title: draft?.title ?? taskTitle.trim(),
          goal: draft?.goal ?? taskGoal.trim(),
          sourceHref: sourceHrefFor(anchor),
          executionMode: draft?.executionMode ?? "review",
        }
      }
      const recoveryKey = paperTaskRecoveryKey(
        tenantId,
        principalId,
        identity.documentRevisionId,
        pending.idempotencyKey,
      )
      window.localStorage.setItem(recoveryKey, JSON.stringify(pending))
      refreshRecoveries()
      const backlink = await actionPort.createTask(pending)
      window.localStorage.removeItem(recoveryKey)
      refreshRecoveries()
      setBacklinks((current) => current.some((item) => item.id === backlink.id) ? current : [...current, backlink])
      setTaskGoal("")
      setEnhanceOpen(false)
      setStatus(pending.executionMode === "run"
        ? `Agent run ${backlink.status ?? "requested"} from the exact saved plan. Open the constructor to inspect its live status.`
        : "Task created from the pinned source. Open its exact version in the reviewable constructor when ready.")
    } catch (reason) {
      refreshRecoveries()
      setError(reason instanceof Error ? reason.message : "The task could not be created. It is available to retry.")
    } finally {
      setBusy(false)
    }
  }

  async function checkEnhanceReferences() {
    if (!selectedAnchor || !actionPort?.authorizeTaskRefs || enhanceReferenceState.references.length < 2) return
    const signature = enhanceReferenceSignature
    setEnhanceReadability({ signature, status: "checking" })
    setError("")
    try {
      await actionPort.authorizeTaskRefs(selectedAnchor.ref, enhanceReferenceState.references)
      setEnhanceReadability({ signature, status: "readable" })
      setStatus(`${enhanceReferenceState.references.length} pinned references are readable in this tenant.`)
    } catch {
      setEnhanceReadability({ signature, status: "unavailable" })
      setError("One or more selected references are unavailable. No task was created.")
    }
  }

  function selectEnhanceIntent(intent: PaperEnhanceIntent) {
    setEnhanceIntent(intent)
  }

  function dismissEnhance() {
    setEnhanceOpen(false)
    setEnhanceIntent("explain")
    setEnhanceRefsText("")
    setEnhanceReadability({ signature: "", status: "idle" })
  }

  function dispatchEnhancement(executionMode: "review" | "run") {
    if (!canAct || !enhanceAvailability.enabled) return
    const preset = paperEnhancePreset(enhanceIntent, identity.title)
    const resourceRefs = enhanceIntent === "explain" || enhanceIntent === "challenge"
      ? undefined
      : enhanceReferenceState.references
    void dispatchTask(undefined, {
      ...preset,
      resourceRefs,
      expectedSelectionGeneration: selectionGeneration.current,
      executionMode,
    })
  }

  async function decideAgentResult(
    candidate: PaperAgentResultCandidate,
    action: PaperAgentResultDecision["action"],
  ) {
    if (!selectedAnchor || !actionPort?.decideAgentResult) return
    const anchorRef = selectedAnchor.ref
    const busyKey = `${candidate.taskId}:${candidate.eventId}`
    setAgentResultBusyKey(busyKey)
    setAgentResultsError("")
    try {
      const decided = await actionPort.decideAgentResult(
        selectedAnchor,
        candidate,
        action,
        `paper-result:${candidate.resultHash.slice("sha256:".length)}:${action}`,
      )
      if (agentResultAnchorRef.current !== anchorRef) return
      setAgentResults((current) => current.map((item) => (
        item.taskId === decided.taskId && item.eventId === decided.eventId ? decided : item
      )))
      setStatus(action === "accept"
        ? "Agent result accepted as a cited, versioned Galaxy document."
        : "Agent result rejected. No Galaxy document was admitted.")
    } catch (reason) {
      if (agentResultAnchorRef.current === anchorRef) {
        setAgentResultsError(reason instanceof Error ? reason.message : "The review decision could not be saved.")
      }
    } finally {
      setAgentResultBusyKey((current) => current === busyKey ? "" : current)
    }
  }

  async function placeOnAtlas() {
    setBusy(true)
    setError("")
    try {
      const anchor = await ensureAnchor()
      const placed = await placeDocumentAnchorRecoverably(
        anchor,
        tenantId,
        principalId,
        window.localStorage,
        location.page,
      )
      setAtlasPlacement({
        anchorId: anchor.id,
        href: atlasPlacementHref(placed.canvasId, placed.placementId),
      })
      setStatus(placed.replayed
        ? "Recovered the existing durable canvas placement."
        : "Placed this pinned coordinate on the durable atlas canvas.")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The coordinate could not be placed on the atlas.")
    } finally {
      setBusy(false)
    }
  }

  async function transformDocument() {
    if (!dataPort.transformDocument) {
      setTransformPhase("failed")
      setTransformError("Document analysis is not installed in this deployment.")
      return
    }
    transformController.current?.abort()
    const controller = new AbortController()
    transformController.current = controller
    setTransformPhase("starting")
    setTransformError("")
    setTransformMessage("Starting bounded document analysis…")
    try {
      const result = await dataPort.transformDocument(
        identity.documentRevisionId,
        `${tenantId}:${principalId}`,
        controller.signal,
        { reprocess: Boolean(selectedRepresentations.markdown && !selectedRepresentations.structure) },
      )
      if (!("representations" in result)) {
        setTransformPhase("running")
        setTransformMessage("Analysis is still running. Resume to reconcile this same operation.")
        return
      }
      setRepresentations(result.representations as ReaderRepresentation[])
      setReceipts([result.receipt, ...(result.fallbackReceipt ? [result.fallbackReceipt] : [])])
      setLocalIndex(result.local_index)
      const available = chooseReaderRepresentationState(
        result.representations,
        [result.receipt, ...(result.fallbackReceipt ? [result.fallbackReceipt] : [])],
      )
      if (available.structure || available.markdown) {
        setTransformPhase("ready")
        setTransformMessage(available.structure
          ? "Structured text is ready. Choose it when you want the page-aware reading projection."
          : available.receipt?.status === "fallback"
            ? "The structure converter was unavailable, so a Markdown fallback is ready."
            : "The converter returned a partial Markdown view without page structure.")
        window.requestAnimationFrame(() => derivedViewTrigger.current?.focus())
      } else {
        setTransformPhase("failed")
        setTransformError("This analysis completed without a derived representation. The original remains available.")
      }
    } catch (reason) {
      if (controller.signal.aborted) return
      const uncertain = reason instanceof DocumentTransformClientError && reason.retryable
      setTransformPhase(uncertain ? "uncertain" : "failed")
      setTransformError(reason instanceof Error
        ? reason.message
        : "Document analysis could not be completed. The original remains available.")
    } finally {
      if (transformController.current === controller) transformController.current = null
    }
  }

  const activeRegion = draft ?? (selectedAnchor ? anchorRegion(selectedAnchor) : null)
  const activeQuote = draftQuote ?? (selectedAnchor?.selector.kind === "text-quote"
    ? {
        page: selectedAnchor.selector.page ?? location.page,
        exact: selectedAnchor.selector.exact,
        representationId: selectedAnchor.representation_id,
        selector: selectedAnchor.selector,
      }
    : null)
  const canAct = Boolean((activeRegion && selectedRepresentations.structure) || activeQuote)
  const latestReceipt = selectedRepresentationState.receipt
  const needsStructure = !selectedRepresentations.structure
  const markdownIsFallback = selectedRepresentationState.receipt?.status === "fallback"

  return (
    <Tabs
      value={location.view}
      onValueChange={(view) => updateLocation({ view: view as PaperReaderLocation["view"] })}
    >
    <section className={cn("research-workbench min-h-[720px] bg-[hsl(var(--research-paper))] text-[hsl(var(--research-ink))]", className)} aria-label={`Paper reader: ${identity.title}`}>
      <header className="border-b border-[color:var(--research-line)] bg-[hsl(var(--research-panel)/0.96)] px-4 py-3 md:px-6">
        <div className="mx-auto flex max-w-[1680px] flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="research-kicker">Exact document revision · living field reader</p>
            <h1 className="research-display truncate text-xl font-semibold md:text-2xl">{identity.title}</h1>
            <p className="research-muted mt-1 truncate font-mono text-[11px]">{identity.documentRevisionId}</p>
          </div>
          <TabsList className="h-auto flex-wrap gap-1 rounded-full border border-[color:var(--research-line)] bg-[hsl(var(--research-panel))] p-1" aria-label="Document representation">
            <TabsTrigger value="pdf" className="research-control min-h-10 rounded-full px-3 text-sm data-[state=active]:bg-[hsl(var(--research-accent))] data-[state=active]:text-white">
              <BookOpen aria-hidden="true" className="mr-2 inline h-4 w-4" />Original
            </TabsTrigger>
            <TabsTrigger
              value="structure"
              ref={selectedRepresentations.structure ? derivedViewTrigger : undefined}
              disabled={!selectedRepresentations.structure}
              className="research-control min-h-10 rounded-full px-3 text-sm data-[state=active]:bg-[hsl(var(--research-accent))] data-[state=active]:text-white disabled:opacity-45"
            >
              <Sparkles aria-hidden="true" className="mr-2 inline h-4 w-4" />Structured text
            </TabsTrigger>
            <TabsTrigger
              value="markdown"
              ref={markdownIsFallback ? derivedViewTrigger : undefined}
              disabled={!selectedRepresentations.markdown}
              className="research-control min-h-10 rounded-full px-3 text-sm data-[state=active]:bg-[hsl(var(--research-accent))] data-[state=active]:text-white disabled:opacity-45"
            >
              <FileText aria-hidden="true" className="mr-2 inline h-4 w-4" />{markdownIsFallback ? "Markdown fallback" : "Markdown + math"}
            </TabsTrigger>
          </TabsList>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1680px] gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_320px] lg:p-4">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-1 rounded-2xl border border-[color:var(--research-line)] bg-[hsl(var(--research-panel)/0.96)] p-2 shadow-sm" role="toolbar" aria-label="Paper mark tools">
            <ReaderToolButton label="Read" active={tool === "read"} icon={<MousePointer2 />} onClick={() => setTool("read")} />
            <ReaderToolButton label="Pen" active={tool === "pen"} icon={<PenLine />} onClick={() => { setTool("pen"); updateLocation({ view: "pdf" }) }} />
            <ReaderToolButton label="Box" active={tool === "box"} icon={<BoxSelect />} onClick={() => { setTool("box"); updateLocation({ view: "pdf" }) }} />
            <span className="mx-1 h-7 w-px bg-[color:var(--research-line)]" aria-hidden="true" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!selectedRepresentations.structure}
              onClick={() => chooseRegion({ pageNumber: location.page, x: 0, y: 0, width: 1, height: 1 })}
            >
              Anchor page
            </Button>
            <p className="research-muted ml-auto px-2 text-xs">One gesture → one immutable evidence coordinate</p>
          </div>

          <div className="min-h-[640px] overflow-hidden rounded-2xl border border-[color:var(--research-line)] bg-[#fffef9] shadow-sm">
            {loading ? (
              <div className="grid min-h-[640px] place-items-center" aria-busy="true"><span className="inline-flex items-center gap-2"><Loader2 className="h-5 w-5 animate-spin" />Loading exact revision…</span></div>
            ) : (
              <>
                <TabsContent value="pdf" className="m-0 min-h-[640px]">
                  {pdfUrl ? (
                    <PDFViewer
                      data={pdfUrl}
                      page={location.page}
                      onPageChange={(page) => updateLocation({ page })}
                      inkMode={tool === "pen"}
                      regionMode={tool === "box"}
                      regionHighlights={regionHighlights}
                      exactTextHighlights={markTextHighlights}
                      onInkStroke={(stroke) => chooseInk(stroke)}
                      onRegionSelection={(region) => chooseRegion(region)}
                      onTextSelection={(selection) => chooseText(selection)}
                      className="min-h-[640px]"
                    />
                  ) : (
                    <div className="grid min-h-[640px] place-items-center px-6 text-center">
                      <div><FileText className="mx-auto h-10 w-10 text-[hsl(var(--research-muted))]" /><p className="research-display mt-3 text-xl">Original PDF is unavailable</p><p className="research-muted mt-1 text-sm">The reader will not substitute derived text for missing source bytes.</p></div>
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="structure" className="m-0 min-h-[640px]">
                  {selectedRepresentations.structure?.content ? (
                    <DocumentStructureReader structure={selectedRepresentations.structure.content as GalaxyDocumentStructure} />
                  ) : null}
                </TabsContent>
                <TabsContent value="markdown" className="m-0 min-h-[640px]">
                  {selectedRepresentations.markdown ? (
                    <article className="research-prose mx-auto max-w-4xl px-6 py-10 md:px-12">
                      <p className="research-muted mb-5 text-sm">{markdownIsFallback
                        ? "Flat fallback projection. The exact PDF remains the authoritative source."
                        : "Converter-authored Markdown projection. The exact PDF remains the authoritative source."}</p>
                      <MarkdownRenderer content={String(selectedRepresentations.markdown.content)} images="embedded" className="research-markdown" />
                    </article>
                  ) : null}
                </TabsContent>
              </>
            )}
          </div>
        </div>

        <aside className="space-y-3" aria-label="Anchored paper actions">
          <section className="rounded-2xl border border-[color:var(--research-line)] bg-[hsl(var(--research-panel)/0.96)] p-4 shadow-sm" aria-labelledby="paper-analysis-heading">
            <p className="research-kicker">Derived reading views</p>
            <h2 id="paper-analysis-heading" className="research-display mt-1 text-lg font-semibold">Analyze the exact revision</h2>
            <div className="mt-2 min-h-10 text-sm" role="status" aria-live="polite" aria-atomic="true">
              {transformError ? <p role={transformPhase === "failed" ? "alert" : undefined} className="text-[#9b3f2a]">{transformError}</p> : <p className="research-muted">{transformMessage}</p>}
            </div>
            {localIndex ? (
              <p className="research-muted mt-2 border-t border-[color:var(--research-line)] pt-2 text-xs">
                {localIndex.status === "ready"
                  ? `${localIndex.chunk_count.toLocaleString()} local chunks · ${localIndex.source.representation_kind.replace("document-structure", "document structure")}`
                  : "Local index not built"}
              </p>
            ) : null}
            {needsStructure ? (
              <Button
                type="button"
                className="mt-3 min-h-11 w-full"
                disabled={loading || transformPhase === "starting" || !dataPort.transformDocument}
                onClick={() => void transformDocument()}
              >
                {transformPhase === "starting" ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles aria-hidden="true" className="mr-2 h-4 w-4" />}
                {transformPhase === "running" || transformPhase === "uncertain"
                  ? "Resume same analysis"
                  : selectedRepresentations.markdown
                    ? "Retry structure extraction"
                    : "Extract structure"}
              </Button>
            ) : null}
            {latestReceipt ? (
              <details className="mt-3 border-t border-[color:var(--research-line)] pt-3 text-xs">
                <summary className="research-smallcaps cursor-pointer">Extraction receipt</summary>
                <dl className="research-muted mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  <dt>Engine</dt><dd>{latestReceipt.engine} {latestReceipt.engine_version}</dd>
                  <dt>Status</dt><dd>{latestReceipt.status}{latestReceipt.diagnostic_code ? ` · ${latestReceipt.diagnostic_code}` : ""}</dd>
                  <dt>Receipt</dt><dd className="truncate font-mono" title={latestReceipt.id}>{latestReceipt.id}</dd>
                  <dt>Input</dt><dd className="truncate font-mono" title={latestReceipt.input_sha256}>{latestReceipt.input_sha256}</dd>
                  {latestReceipt.output_sha256 ? <><dt>Output</dt><dd className="truncate font-mono" title={latestReceipt.output_sha256}>{latestReceipt.output_sha256}</dd></> : null}
                </dl>
              </details>
            ) : null}
          </section>

          <div className="rounded-2xl border border-[color:var(--research-line)] bg-[hsl(var(--research-panel)/0.96)] p-4 shadow-sm">
            <p className="research-kicker">Selected evidence</p>
            {activeRegion || activeQuote ? (
              <>
                <p className="research-display mt-2 text-lg font-semibold">{activeQuote
                  ? `Page ${activeQuote.page} · exact quote`
                  : `Page ${activeRegion?.page} · ${activeRegion?.source === "pen" ? "pen extent" : activeRegion?.source === "page" ? "whole page" : "boxed region"}`}</p>
                <p className="research-muted mt-1 font-mono text-[11px]">{selectedAnchor ? shortAnchor(selectedAnchor) : "Unsaved coordinate"}</p>
                {activeQuote ? <blockquote className="mt-3 max-h-36 overflow-auto rounded-xl border-l-4 border-[hsl(var(--research-accent))] bg-[hsl(var(--research-accent-soft))] px-3 py-2 text-sm">{activeQuote.exact}</blockquote> : null}
                <Label htmlFor={noteId} className="research-smallcaps mt-4 block text-xs">Margin note</Label>
                <Textarea id={noteId} className="mt-2 min-h-24" value={note} maxLength={20_000} onChange={(event) => {
                  noteEditGeneration.current += 1
                  setNote(event.target.value)
                }} placeholder="What matters here?" />
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Button type="button" variant="outline" disabled={busy || !canAct} onClick={() => void createMark("clip")}><Quote className="mr-2 h-4 w-4" />Clip</Button>
                  <Button type="button" disabled={busy || !canAct || !note.trim()} onClick={() => void createMark("note")}><Link2 className="mr-2 h-4 w-4" />Save note</Button>
                </div>
                <Button type="button" variant="outline" className="mt-2 min-h-11 w-full" disabled={busy || !canAct} onClick={() => void placeOnAtlas()}><PanelsTopLeft aria-hidden="true" className="mr-2 h-4 w-4" />Place on atlas</Button>
                {atlasPlacement?.anchorId === location.anchorId ? <Link href={atlasPlacement.href} className="mt-2 inline-flex min-h-11 w-full items-center justify-center rounded-xl border border-[color:var(--research-line)] px-3 text-sm font-medium text-[hsl(var(--research-accent))] underline-offset-4 hover:bg-[hsl(var(--research-accent-soft))] hover:underline"><PanelsTopLeft aria-hidden="true" className="mr-2 h-4 w-4" />Open placed card in Atlas</Link> : null}
              </>
            ) : (
              <p className="research-muted mt-2 text-sm">Draw a box, make a pen mark, or choose a saved coordinate. Anchors remain bound to the page-aware structure digest.</p>
            )}
          </div>

          <section className="rounded-2xl border border-[color:var(--research-line)] bg-[hsl(var(--research-panel)/0.96)] p-4 shadow-sm" aria-labelledby="paper-enhance-heading">
            <p className="research-kicker">Reviewable agent work</p>
            <h2 id="paper-enhance-heading" className="research-display mt-1 text-lg font-semibold">Enhance this evidence</h2>
            <p className="research-muted mt-1 text-sm">Choose an intent locally. Galaxy creates nothing until you confirm the bounded task.</p>
            <Button
              type="button"
              variant="outline"
              className="mt-3 min-h-11 w-full"
              aria-expanded={enhanceOpen}
              aria-controls={enhancePanelId}
              disabled={!canAct || busy}
              onClick={() => setEnhanceOpen((current) => !current)}
            >
              <Sparkles aria-hidden="true" className="mr-2 h-4 w-4" />
              {enhanceOpen ? "Hide Enhance options" : "Enhance selected anchor"}
            </Button>
            {!canAct ? <p className="research-muted mt-2 text-xs">Select one exact quote or region to begin.</p> : null}

            {enhanceOpen && canAct ? (
              <div id={enhancePanelId} className="mt-4 space-y-4 border-t border-[color:var(--research-line)] pt-4">
                <fieldset>
                  <legend className="research-smallcaps text-xs">Intent preset</legend>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {([
                      ["explain", BookOpen, "Explain"],
                      ["challenge", ShieldQuestion, "Challenge"],
                      ["compare", Scale, "Compare"],
                      ["synthesize", Sparkles, "Synthesize"],
                    ] as const).map(([intent, Icon, label]) => {
                      const availability = enhanceAvailabilityForIntent(intent)
                      return (
                        <button
                          key={intent}
                          type="button"
                          className={cn(
                            "min-h-11 rounded-xl border px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--research-accent))]",
                            enhanceIntent === intent
                              ? "border-[hsl(var(--research-accent))] bg-[hsl(var(--research-accent-soft))]"
                              : "border-[color:var(--research-line)]",
                            !availability.enabled && "opacity-55",
                          )}
                          aria-pressed={enhanceIntent === intent}
                          aria-disabled={!availability.enabled}
                          aria-describedby={!availability.enabled ? enhanceRefsHelpId : undefined}
                          onClick={() => {
                            if (availability.enabled) selectEnhanceIntent(intent)
                          }}
                        >
                          <span className="inline-flex items-center gap-2 font-medium"><Icon aria-hidden="true" className="h-4 w-4" />{label}</span>
                        </button>
                      )
                    })}
                  </div>
                </fieldset>

                <div>
                  <Label htmlFor={enhanceRefsId}>Other pinned references</Label>
                  <Textarea
                    id={enhanceRefsId}
                    className="mt-1 min-h-24 font-mono text-xs"
                    value={enhanceRefsText}
                    maxLength={4_007}
                    aria-invalid={Boolean(enhanceReferenceState.error)}
                    aria-describedby={enhanceRefsHelpId}
                    onChange={(event) => {
                      setEnhanceRefsText(event.target.value)
                      setEnhanceReadability({ signature: "", status: "idle" })
                    }}
                    placeholder="One canonical pinned gb:object:v1 reference per line"
                  />
                  <p id={enhanceRefsHelpId} className={cn("mt-2 text-xs", enhanceReferenceState.error ? "text-[#9b3f2a]" : "research-muted")}>
                    {enhanceReferenceState.error || enhanceAvailability.reason} Maximum eight distinct references including the selected anchor.
                  </p>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 w-full"
                  disabled={busy || enhanceReadability.status === "checking" || enhanceReferenceState.references.length < 2 || !actionPort?.authorizeTaskRefs}
                  onClick={() => void checkEnhanceReferences()}
                >
                  {enhanceReadability.status === "checking" ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : <Check aria-hidden="true" className="mr-2 h-4 w-4" />}
                  Check selected references
                </Button>
                <p className="research-muted text-xs" role="status" aria-live="polite">
                  {enhanceReferencesReadable
                    ? `${enhanceReferenceState.references.length} references checked and readable.`
                    : enhanceReadability.status === "unavailable"
                      ? "The current selection is not fully readable."
                      : "Reference checks are read-only and do not create a task or relation."}
                </p>

                <p className="research-muted text-xs">Create a reviewable task, or save its exact starter plan and explicitly start the Hyades agent loop. Completed work returns here as a cited result for acceptance.</p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={dismissEnhance}>Dismiss</Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={busy || !actionPort?.createTask || !enhanceAvailability.enabled}
                    aria-describedby={enhanceRefsHelpId}
                    onClick={() => dispatchEnhancement("review")}
                  >
                    <ListTodo aria-hidden="true" className="mr-2 h-4 w-4" />Create reviewable task
                  </Button>
                  <Button
                    type="button"
                    className="min-h-11"
                    disabled={busy || !actionPort?.createTask || !enhanceAvailability.enabled}
                    aria-describedby={enhanceRefsHelpId}
                    onClick={() => dispatchEnhancement("run")}
                  >
                    <Play aria-hidden="true" className="mr-2 h-4 w-4" />Create + start agent
                  </Button>
                </div>
                {!actionPort?.createTask ? <p className="research-muted text-xs">Task dispatch is not installed; Galaxy will not invent local task state.</p> : null}
              </div>
            ) : null}
          </section>

          <details className="rounded-2xl border border-[color:var(--research-line)] bg-[hsl(var(--research-panel)/0.96)] shadow-sm" open={Boolean(activeRegion)}>
            <summary className="research-display cursor-pointer px-4 py-3 font-semibold">Create bounded task</summary>
            <div className="space-y-3 border-t border-[color:var(--research-line)] p-4">
              <div><Label htmlFor={taskTitleId}>Title</Label><Input id={taskTitleId} className="mt-1" value={taskTitle} maxLength={200} onChange={(event) => setTaskTitle(event.target.value)} /></div>
              <div><Label htmlFor={taskGoalId}>Goal</Label><Textarea id={taskGoalId} className="mt-1 min-h-24" value={taskGoal} maxLength={20_000} onChange={(event) => setTaskGoal(event.target.value)} placeholder="Explain, challenge, compare, or investigate this exact region." /></div>
              <Button type="button" className="w-full" disabled={busy || !canAct || !actionPort?.createTask || !taskTitle.trim() || !taskGoal.trim()} onClick={() => void dispatchTask()}><ListTodo className="mr-2 h-4 w-4" />Create task</Button>
              {!actionPort?.createTask && <p className="research-muted text-xs">Task dispatch is not installed in this deployment; the reader will not invent local task state.</p>}
            </div>
          </details>

          {markRecoveryError ? (
            <section className="rounded-2xl border border-[#b66238]/35 bg-[#fff5ed] p-4 text-[#7f321f]" role="alert">
              <h2 className="research-display font-semibold">Document mark recovery unavailable</h2>
              <p className="mt-1 text-sm">{markRecoveryError}</p>
            </section>
          ) : null}

          {pendingMarks.length > 0 && (
            <section className="rounded-2xl border border-[#c97943] bg-[#fff7e9] p-4" aria-labelledby="pending-paper-marks" role="region" aria-live="polite" aria-atomic="false">
              <h2 id="pending-paper-marks" className="research-display font-semibold">Recoverable document marks</h2>
              <p className="research-muted mt-1 text-xs">Retry preserves the exact frozen request bytes and scoped idempotency key.</p>
              <ul className="mt-2 space-y-2">{pendingMarks.map((intent) => (
                <li key={intent.idempotencyKey} className="rounded-xl border border-[#d8a879] bg-white/70 p-3">
                  <p className="text-sm font-medium">{intent.kind === "highlight" ? "Evidence highlight" : "Margin note"}</p>
                  <p className="research-muted mt-1 truncate font-mono text-[10px]">{intent.anchor.id}</p>
                  {intent.bodyMarkdown ? <p className="research-muted mt-1 line-clamp-2 whitespace-pre-wrap text-xs">{intent.bodyMarkdown}</p> : null}
                  <Button type="button" size="sm" variant="outline" className="mt-2 min-h-10" disabled={busy || !actionPort?.retryMark} onClick={() => void retryMark(intent)}><RotateCcw aria-hidden="true" className="mr-2 h-3.5 w-3.5" />Retry same request</Button>
                </li>
              ))}</ul>
            </section>
          )}

          {pendingTasks.length > 0 && (
            <section className="rounded-2xl border border-[#c97943] bg-[#fff7e9] p-4" aria-labelledby="pending-paper-tasks">
              <h2 id="pending-paper-tasks" className="research-display font-semibold">Recoverable task requests</h2>
              <ul className="mt-2 space-y-2">{pendingTasks.map((request) => <li key={request.idempotencyKey} className="rounded-xl border border-[#d8a879] bg-white/70 p-3"><p className="text-sm font-medium">{request.title}</p><Button type="button" size="sm" variant="outline" className="mt-2" disabled={busy || !actionPort?.createTask} onClick={() => void dispatchTask(request)}><RotateCcw className="mr-2 h-3.5 w-3.5" />Retry same request</Button></li>)}</ul>
            </section>
          )}

          <section className="rounded-2xl border border-[color:var(--research-line)] bg-[hsl(var(--research-panel)/0.96)] p-4 shadow-sm" aria-labelledby="paper-coordinates">
            <h2 id="paper-coordinates" className="research-display font-semibold">Saved coordinates</h2>
            {anchors.length ? <ul className="mt-3 space-y-1">{anchors.map((anchor) => {
              const region = anchorRegion(anchor)
              const quotePage = anchor.selector.kind === "text-quote" ? anchor.selector.page : undefined
              return <li key={anchor.id}><button type="button" className={cn("min-h-11 w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-[hsl(var(--research-accent-soft))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--research-accent))]", selectedAnchor?.id === anchor.id && "bg-[hsl(var(--research-accent-soft))]")} onClick={() => {
                selectionGeneration.current += 1
                updateLocation({ view: "pdf", page: region?.page ?? quotePage ?? location.page, anchorId: anchor.id })
              }}><span className="block font-medium">{region ? `Page ${region.page} region` : anchor.selector_kind}</span><span className="research-muted block truncate font-mono text-[10px]">{shortAnchor(anchor)}</span></button></li>
            })}</ul> : <p className="research-muted mt-2 text-sm">No canonical coordinates yet.</p>}
          </section>

          {selectedAnchor && (
            <section className="rounded-2xl border border-[color:var(--research-line)] bg-[hsl(var(--research-panel)/0.96)] p-4 shadow-sm" aria-labelledby="paper-backlinks">
              <h2 id="paper-backlinks" className="research-display font-semibold">Task backlinks</h2>
              {backlinks.length ? <ul className="mt-3 space-y-2">{backlinks.map((item) => <li key={item.id} className="rounded-xl border border-[color:var(--research-line)] p-3"><p className="research-smallcaps text-[10px]">{item.kind}{item.status ? ` · ${item.status}` : ""}</p><p className="mt-1 text-sm font-medium">{item.label}</p>{item.detail && <p className="research-muted mt-1 text-xs">{item.detail}</p>}{item.href && <Link href={item.href} className="mt-2 inline-flex min-h-11 items-center text-sm text-[hsl(var(--research-accent))] underline-offset-4 hover:underline">Open <ExternalLink className="ml-1 h-3.5 w-3.5" /></Link>}</li>)}</ul> : <p className="research-muted mt-2 text-sm">Nothing refers to this coordinate yet.</p>}
            </section>
          )}

          {selectedAnchor && (
            <section className="rounded-2xl border border-[color:var(--research-line)] bg-[hsl(var(--research-panel)/0.96)] p-4 shadow-sm" aria-labelledby="paper-agent-results">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="research-kicker">Agentic return path</p>
                  <h2 id="paper-agent-results" className="research-display mt-1 font-semibold">Completed research results</h2>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-11"
                  disabled={agentResultsLoading || backlinksAnchorRef !== selectedAnchor.ref}
                  onClick={() => setAgentResultRefresh((current) => current + 1)}
                >
                  {agentResultsLoading ? <Loader2 aria-hidden="true" className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RotateCcw aria-hidden="true" className="mr-2 h-3.5 w-3.5" />}
                  Refresh results
                </Button>
              </div>
              <p className="research-muted mt-2 text-xs">Completed HAM work remains a candidate until you review its exact result and citations.</p>
              <div className="mt-3" aria-live="polite" aria-busy={agentResultsLoading}>
                {agentResultsError ? <p role="alert" className="text-sm text-[#9b3f2a]">{agentResultsError}</p> : null}
                {!agentResultsError && agentResultsLoading ? <p className="research-muted text-sm">Checking linked tasks for completed results…</p> : null}
                {!agentResultsError && !agentResultsLoading && agentResults.length === 0 ? <p className="research-muted text-sm">No completed result is awaiting review for this coordinate.</p> : null}
              </div>
              {agentResults.length > 0 ? (
                <ul className="mt-3 space-y-3">
                  {agentResults.map((candidate) => {
                    const backlink = backlinks.find((item) => item.taskId === candidate.taskId)
                    if (!backlink) return null
                    const busyKey = `${candidate.taskId}:${candidate.eventId}`
                    return (
                      <li key={busyKey}>
                        <PaperAgentResultCard
                          candidate={candidate}
                          backlink={backlink}
                          busy={agentResultBusyKey === busyKey}
                          onDecision={(action) => void decideAgentResult(candidate, action)}
                        />
                      </li>
                    )
                  })}
                </ul>
              ) : null}
              {!actionPort?.decideAgentResult ? <p className="research-muted mt-3 text-xs">Result review is not installed in this deployment.</p> : null}
            </section>
          )}

          <DocumentMarkPanel anchor={selectedAnchor} dataPort={dataPort} refreshToken={markListRevision} />

          <div ref={markStatusRef} tabIndex={-1} aria-live="polite" aria-atomic="true" className="rounded-2xl border border-[color:var(--research-line)] bg-[hsl(var(--research-panel)/0.96)] p-4 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--research-accent))]">
            {error ? <p role="alert" className="text-[#9b3f2a]">{error}</p> : <p className="research-muted inline-flex items-start gap-2">{busy ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" /> : <Check className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--research-accent))]" />}{status}</p>}
          </div>
        </aside>
      </div>
    </section>
    </Tabs>
  )
}

function ReaderToolButton({ label, active, icon, onClick }: { label: string; active: boolean; icon: React.ReactNode; onClick: () => void }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={cn("research-control inline-flex min-h-10 items-center gap-2 rounded-full px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--research-accent))]", active ? "bg-[hsl(var(--research-accent))] text-white" : "hover:bg-[hsl(var(--research-accent-soft))]")}>{icon}{label}</button>
}
