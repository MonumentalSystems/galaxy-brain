"use client"

import Link from "next/link"
import { FileCode2, FileText, Link2, ListTodo, Loader2, PanelsTopLeft, Quote, RotateCcw, ShieldCheck, Sparkles } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { MarkdownRenderer } from "@/components/markdown-renderer"
import { DocumentMarkPanel } from "@/components/documents/document-mark-panel"
import { DocumentStructureReader } from "@/components/papers/document-structure-reader"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { atlasPlacementHref } from "@/lib/canvas/atlas-location.js"
import { placeDocumentAnchorRecoverably } from "@/lib/canvas/document-anchor-canvas"
import {
  ExactTextDocumentError,
  exactTextDocumentDescriptor,
  exactTextDocumentAnchorSearch,
  exactTextQuoteForSelection,
  isExactHtmlDocumentDescriptor,
  loadExactTextDocument,
  selectExactHtmlDerivedState,
  shouldAcceptExactHtmlDerivedCompletion,
  validateExactTextAnchorResponse,
  type ExactHtmlDerivedState,
  type ExactTextDocumentDescriptor,
} from "@/lib/document-text-reader.js"
import type { DocumentMarkCreateIntent } from "@/lib/document-mark-client.js"
import { DocumentTransformClientError } from "@/lib/document-transform-client.js"
import type { DurableTransformReceipt, GalaxyDocumentStructure } from "@/lib/ingestion-contract.js"
import {
  shouldAcceptPaperMarkCompletion,
  shouldCommitPaperAnchorCompletion,
  type ReaderRepresentation,
} from "@/lib/paper-reader.js"
import {
  paperTaskRecoveryKey,
  readPaperTaskRecoveries,
  type DurableDocumentAnchor,
  type DurableDocumentRevision,
  type PaperReaderActionPort,
  type PaperReaderDataPort,
  type PaperReaderTaskRequest,
} from "@/lib/paper-reader-client"

type HtmlReadingView = "source" | "structure" | "markdown"
type HtmlDerivedPhase = "idle" | "loading" | "starting" | "running" | "ready" | "failed" | "uncertain"

export type ExactTextDocumentReaderProps = {
  revision: DurableDocumentRevision
  tenantId: string
  principalId: string
  dataPort: PaperReaderDataPort
  actionPort: PaperReaderActionPort
  initialAnchorId?: string
  fetcher?: typeof fetch
}

function boundedTaskGoal(selection: string) {
  const prefix = "Investigate this exact immutable source passage:\n\n> "
  return `${prefix}${selection}`.slice(0, 4_000)
}

function HtmlTransformReceipt({
  label,
  receipt,
}: {
  label: string
  receipt: DurableTransformReceipt
}) {
  return (
    <section className="mt-3 border-t border-[color:var(--research-line)] pt-3" aria-label={label}>
      <p className="research-smallcaps text-[10px]">{label}</p>
      <dl className="research-muted mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt>Provider</dt><dd>{receipt.plugin_id}</dd>
        <dt>Engine</dt><dd>{receipt.engine} {receipt.engine_version}</dd>
        <dt>Status</dt><dd>{receipt.status}</dd>
        <dt>Receipt</dt><dd className="truncate font-mono" title={receipt.id}>{receipt.id}</dd>
        <dt>Input</dt><dd className="truncate font-mono" title={receipt.input_sha256}>{receipt.input_sha256}</dd>
        {receipt.output_sha256 ? <><dt>Output</dt><dd className="truncate font-mono" title={receipt.output_sha256}>{receipt.output_sha256}</dd></> : null}
      </dl>
    </section>
  )
}

export function ExactTextDocumentReader({
  revision,
  tenantId,
  principalId,
  dataPort,
  actionPort,
  initialAnchorId,
  fetcher = fetch,
}: ExactTextDocumentReaderProps) {
  const descriptorState = useMemo<{ descriptor: ExactTextDocumentDescriptor | null; error: string }>(
    () => {
      try {
        return { descriptor: exactTextDocumentDescriptor(revision, revision.revision_id), error: "" }
      } catch (reason) {
        return {
          descriptor: null,
          error: reason instanceof Error ? reason.message : "The exact document metadata could not be verified.",
        }
      }
    },
    [revision],
  )
  const descriptor = descriptorState.descriptor
  const htmlDerivedEligible = descriptor !== null && isExactHtmlDocumentDescriptor(descriptor)
  const [content, setContent] = useState<string | null>(null)
  const [contentRevisionId, setContentRevisionId] = useState("")
  const [loadError, setLoadError] = useState("")
  const [htmlView, setHtmlView] = useState<HtmlReadingView>("source")
  const [htmlDerivedState, setHtmlDerivedState] = useState<ExactHtmlDerivedState | null>(null)
  const [htmlDerivedStateRevisionId, setHtmlDerivedStateRevisionId] = useState("")
  const [htmlDerivedPhase, setHtmlDerivedPhase] = useState<HtmlDerivedPhase>("idle")
  const [htmlDerivedMessage, setHtmlDerivedMessage] = useState("No derived HTML reading view has been requested.")
  const [htmlDerivedError, setHtmlDerivedError] = useState("")
  const contentRootRef = useRef<HTMLElement | null>(null)
  const [selection, setSelection] = useState("")
  const [preparedAnchor, setPreparedAnchor] = useState<{ exact: string; anchor: DurableDocumentAnchor } | null>(null)
  const preparedAnchorRef = useRef<{ exact: string; anchor: DurableDocumentAnchor } | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState("")
  const [status, setStatus] = useState("Select a literal passage to clip it, create a task, or place it on Atlas.")
  const [actionHref, setActionHref] = useState<{ href: string; label: string } | null>(null)
  const [taskTitle, setTaskTitle] = useState(() => `Investigate: ${revision.title}`.slice(0, 200))
  const [taskGoal, setTaskGoal] = useState("")
  const [pendingTasks, setPendingTasks] = useState<PaperReaderTaskRequest[]>([])
  const [markNote, setMarkNote] = useState("")
  const [pendingMarks, setPendingMarks] = useState<readonly DocumentMarkCreateIntent[]>([])
  const [markRecoveryError, setMarkRecoveryError] = useState("")
  const [markListRevision, setMarkListRevision] = useState(0)
  const markStatusRef = useRef<HTMLDivElement | null>(null)
  const selectionGeneration = useRef(0)
  const markOperationGeneration = useRef(0)
  const noteEditGeneration = useRef(0)
  const mountedMarkScope = useRef<string | null>(null)
  const htmlDerivedRequestGeneration = useRef(0)
  const htmlDerivedRevision = useRef(descriptor?.revisionId ?? "")
  const htmlTransformController = useRef<AbortController | null>(null)
  htmlDerivedRevision.current = descriptor?.revisionId ?? ""
  const markScopeKey = useMemo(
    () => JSON.stringify([tenantId, principalId, descriptor?.revisionId ?? ""]),
    [descriptor?.revisionId, principalId, tenantId],
  )
  const activeContent = descriptor && contentRevisionId === descriptor.revisionId ? content : null
  const activeHtmlDerivedState = descriptor && htmlDerivedStateRevisionId === descriptor.revisionId
    ? htmlDerivedState
    : null
  const htmlStructure = activeHtmlDerivedState?.structure ?? null
  const htmlMarkdown = activeHtmlDerivedState?.markdown ?? null
  const htmlFallbackReceipt = activeHtmlDerivedState?.fallbackReceipt ?? null
  const sourceViewSelected = !htmlDerivedEligible || htmlView === "source"
  const sourceVerified = activeContent !== null && !loadError

  const refreshRecoveries = useCallback(() => {
    if (!descriptor || typeof window === "undefined") return
    try {
      setPendingTasks(readPaperTaskRecoveries(
        window.localStorage,
        tenantId,
        principalId,
        descriptor.revisionId,
      ))
    } catch {
      setPendingTasks([])
    }
  }, [descriptor, principalId, tenantId])

  const replaceDocumentAnchor = useCallback((anchorId: string | null) => {
    if (typeof window === "undefined") return
    const search = exactTextDocumentAnchorSearch(window.location.search, anchorId)
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${search}${window.location.hash}`,
    )
  }, [])

  const refreshMarkRecoveries = useCallback(() => {
    if (mountedMarkScope.current !== markScopeKey) return
    if (!actionPort.listMarkRecoveries) {
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

  const commitHtmlDerivedState = useCallback((
    representations: ReaderRepresentation[],
    receipts: DurableTransformReceipt[],
    operation: { generation: number; revisionId: string },
  ) => {
    if (!descriptor || !shouldAcceptExactHtmlDerivedCompletion(operation, {
      generation: htmlDerivedRequestGeneration.current,
      revisionId: htmlDerivedRevision.current,
    })) return false
    let available: ExactHtmlDerivedState
    try {
      available = selectExactHtmlDerivedState(descriptor, representations, receipts)
    } catch {
      setHtmlDerivedState(null)
      setHtmlDerivedStateRevisionId(operation.revisionId)
      setHtmlDerivedPhase("failed")
      setHtmlDerivedMessage("")
      setHtmlDerivedError("Derived reading state could not be verified against this exact source. The source remains available.")
      return false
    }
    setHtmlDerivedState(available)
    setHtmlDerivedStateRevisionId(operation.revisionId)
    if (available.structure || available.markdown) {
      setHtmlDerivedPhase("ready")
      setHtmlDerivedError("")
      setHtmlDerivedMessage(available.fallbackReceipt
        ? `Primary analysis ${available.primaryReceipt?.status === "skipped" ? "was skipped" : "failed"}; its receipt-bound fallback is ready. Derived views are read-only.`
        : available.structure
          ? "Receipt-bound structured text is ready. Derived views are read-only."
          : "Receipt-bound Markdown and math are ready. Derived views are read-only.")
      return true
    }
    if (available.primaryReceipt?.status === "failed") {
      setHtmlDerivedPhase("failed")
      setHtmlDerivedMessage("")
      setHtmlDerivedError("The latest analysis produced no derived reading view. The exact source remains available.")
      return false
    }
    setHtmlDerivedPhase("idle")
    setHtmlDerivedError("")
    setHtmlDerivedMessage("No receipt-bound derived HTML reading view is available yet.")
    return false
  }, [descriptor])

  useEffect(() => {
    setHtmlView("source")
    if (!descriptor || !htmlDerivedEligible) {
      htmlDerivedRequestGeneration.current += 1
      htmlTransformController.current?.abort()
      htmlTransformController.current = null
      setHtmlDerivedState(null)
      setHtmlDerivedStateRevisionId("")
      setHtmlDerivedPhase("idle")
      setHtmlDerivedError("")
      setHtmlDerivedMessage("No derived HTML reading view has been requested.")
      return undefined
    }
    if (!dataPort.loadRepresentationState) {
      setHtmlDerivedPhase("idle")
      setHtmlDerivedError("")
      setHtmlDerivedMessage("Derived reading state is unavailable. The exact source remains available.")
      return undefined
    }
    htmlTransformController.current?.abort()
    const controller = new AbortController()
    const generation = htmlDerivedRequestGeneration.current + 1
    const revisionId = descriptor.revisionId
    htmlDerivedRequestGeneration.current = generation
    htmlTransformController.current = controller
    setHtmlDerivedPhase("loading")
    setHtmlDerivedError("")
    setHtmlDerivedMessage("Checking receipt-bound HTML reading views…")
    dataPort.loadRepresentationState(revisionId, controller.signal).then((state) => {
      if (controller.signal.aborted || !shouldAcceptExactHtmlDerivedCompletion(
        { generation, revisionId },
        { generation: htmlDerivedRequestGeneration.current, revisionId: htmlDerivedRevision.current },
      )) return
      commitHtmlDerivedState(state.representations, state.receipts, { generation, revisionId })
    }).catch(() => {
      if (controller.signal.aborted || !shouldAcceptExactHtmlDerivedCompletion(
        { generation, revisionId },
        { generation: htmlDerivedRequestGeneration.current, revisionId: htmlDerivedRevision.current },
      )) return
      setHtmlDerivedPhase("failed")
      setHtmlDerivedMessage("")
      setHtmlDerivedError("Derived reading state could not be loaded. The exact source remains available.")
    })
    return () => {
      controller.abort()
      if (htmlTransformController.current === controller) htmlTransformController.current = null
    }
  }, [commitHtmlDerivedState, dataPort, descriptor, htmlDerivedEligible])

  useEffect(() => () => {
    htmlTransformController.current?.abort()
    htmlDerivedRequestGeneration.current += 1
  }, [dataPort, descriptor?.revisionId])

  useEffect(() => {
    if ((htmlView === "structure" && !htmlStructure) || (htmlView === "markdown" && !htmlMarkdown)) {
      setHtmlView("source")
    }
  }, [htmlMarkdown, htmlStructure, htmlView])

  useEffect(() => {
    if (!descriptor) return undefined
    const controller = new AbortController()
    setContent(null)
    setContentRevisionId("")
    setLoadError("")
    loadExactTextDocument(descriptor, { fetcher, signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted && htmlDerivedRevision.current === descriptor.revisionId) {
        setContent(value)
        setContentRevisionId(descriptor.revisionId)
      }
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      setLoadError(
        reason instanceof ExactTextDocumentError
          ? reason.message
          : "The exact text representation could not be opened.",
      )
    })
    return () => controller.abort()
  }, [descriptor, fetcher])

  useEffect(() => {
    refreshRecoveries()
    refreshMarkRecoveries()
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
    if (!descriptor || activeContent === null || !initialAnchorId) return undefined
    const currentPreparedAnchor = preparedAnchorRef.current
    if (currentPreparedAnchor?.anchor.id === initialAnchorId
      && currentPreparedAnchor.anchor.document_revision_id === descriptor.revisionId
      && currentPreparedAnchor.anchor.representation_id === descriptor.representationId
      && currentPreparedAnchor.anchor.representation_sha256 === descriptor.contentSha256) return undefined
    const controller = new AbortController()
    let active = true
    const expectedSelectionGeneration = selectionGeneration.current
    dataPort.getAnchor(descriptor.revisionId, initialAnchorId, controller.signal).then(async (response) => {
      if (!active) return
      if (response.selector?.kind !== "text-quote") {
        throw new ExactTextDocumentError("The restored coordinate is not an exact text quote")
      }
      const selector = exactTextQuoteForSelection(activeContent, response.selector.exact)
      const anchor = await validateExactTextAnchorResponse(response, descriptor, selector)
      if (!active || !shouldCommitPaperAnchorCompletion(expectedSelectionGeneration, selectionGeneration.current)) return
      selectionGeneration.current += 1
      setSelection(selector.exact)
      preparedAnchorRef.current = { exact: selector.exact, anchor }
      setPreparedAnchor({ exact: selector.exact, anchor })
      setTaskGoal(boundedTaskGoal(selector.exact))
      setStatus("Exact source passage restored from its durable deep link.")
      setActionError("")
    }).catch((reason: unknown) => {
      if (!active || controller.signal.aborted
        || !shouldCommitPaperAnchorCompletion(expectedSelectionGeneration, selectionGeneration.current)) return
      setActionError(reason instanceof Error ? reason.message : "The exact source passage could not be restored.")
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [activeContent, dataPort, descriptor, initialAnchorId])

  const captureSelection = useCallback(() => {
    if (!sourceViewSelected || activeContent === null || typeof window === "undefined") return
    const browserSelection = window.getSelection()
    const root = contentRootRef.current
    if (
      !browserSelection
      || browserSelection.rangeCount < 1
      || !root
      || !browserSelection.anchorNode
      || !browserSelection.focusNode
      || !root.contains(browserSelection.anchorNode)
      || !root.contains(browserSelection.focusNode)
    ) return
    selectionGeneration.current += 1
    replaceDocumentAnchor(null)
    if (browserSelection.isCollapsed) {
      setSelection("")
      preparedAnchorRef.current = null
      setPreparedAnchor(null)
      setActionHref(null)
      setActionError("")
      setStatus("Select a literal passage to clip it, create a task, or place it on Atlas.")
      return
    }
    try {
      const selector = exactTextQuoteForSelection(activeContent, browserSelection.toString())
      setSelection(selector.exact)
      preparedAnchorRef.current = null
      setPreparedAnchor(null)
      setActionHref(null)
      setActionError("")
      setTaskGoal(boundedTaskGoal(selector.exact))
      setStatus("Exact unique source passage ready.")
    } catch (reason) {
      setSelection("")
      preparedAnchorRef.current = null
      setPreparedAnchor(null)
      setActionHref(null)
      setActionError(reason instanceof Error ? reason.message : "The selection is not an exact unique source passage.")
    }
  }, [activeContent, replaceDocumentAnchor, sourceViewSelected])

  const ensureAnchor = useCallback(async (expectedSelectionGeneration?: number) => {
    if (!sourceViewSelected) throw new Error("Return to Source before creating an exact-source action.")
    if (!descriptor || activeContent === null) throw new Error("The exact source is not ready.")
    const selector = exactTextQuoteForSelection(activeContent, selection)
    if (preparedAnchor?.exact === selector.exact) return preparedAnchor.anchor
    const response = await dataPort.createAnchor(descriptor.revisionId, descriptor.representationId, selector)
    const anchor = await validateExactTextAnchorResponse(response, descriptor, selector)
    if (!shouldCommitPaperAnchorCompletion(expectedSelectionGeneration, selectionGeneration.current)) return anchor
    preparedAnchorRef.current = { exact: selector.exact, anchor }
    setPreparedAnchor({ exact: selector.exact, anchor })
    replaceDocumentAnchor(anchor.id)
    return anchor
  }, [activeContent, dataPort, descriptor, preparedAnchor, replaceDocumentAnchor, selection, sourceViewSelected])

  const sourceHrefFor = useCallback((anchor: DurableDocumentAnchor) => {
    if (typeof window === "undefined") {
      return `/documents/${anchor.document_revision_id}${exactTextDocumentAnchorSearch("", anchor.id)}`
    }
    const search = exactTextDocumentAnchorSearch(window.location.search, anchor.id)
    return `${window.location.origin}${window.location.pathname}${search}${window.location.hash}`
  }, [])

  function beginMarkOperation() {
    const generation = markOperationGeneration.current + 1
    markOperationGeneration.current = generation
    return {
      generation,
      selectionGeneration: selectionGeneration.current,
      documentRevisionId: descriptor?.revisionId ?? "",
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
      documentRevisionId: descriptor?.revisionId ?? "",
    }, { requireSelection: requireCurrentSelection })
  }

  async function createSelectionMark(intent: "clip" | "note") {
    if (!sourceViewSelected) return
    if (!actionPort.createMark) {
      setActionError("Mark persistence is not installed in this deployment.")
      return
    }
    const frozenNote = markNote.trim()
    const frozenNoteEditGeneration = noteEditGeneration.current
    if (intent === "note" && !frozenNote) {
      setActionError("Write a note before saving it.")
      return
    }
    const operation = beginMarkOperation()
    setBusy(true)
    setActionError("")
    try {
      const anchor = await ensureAnchor(operation.selectionGeneration)
      if (!isCurrentMarkOperation(operation)) return
      const mark = await actionPort.createMark({
        anchor,
        body: intent === "clip" ? "" : frozenNote,
        intent,
        sourceHref: sourceHrefFor(anchor),
      })
      if (!isCurrentMarkOperation(operation)) return
      if (mark.anchor_id !== anchor.id) return
      setMarkListRevision((current) => current + 1)
      if (intent === "note" && noteEditGeneration.current === frozenNoteEditGeneration) setMarkNote("")
      setStatus(intent === "clip"
        ? "Highlight saved with exact immutable source lineage."
        : "Margin note saved with exact immutable source lineage.")
    } catch (reason) {
      if (isCurrentMarkOperation(operation)) {
        setActionError(reason instanceof Error ? reason.message : "The exact document mark could not be saved.")
      }
    } finally {
      if (isMountedMarkOperationScope(operation)) refreshMarkRecoveries()
      if (isCurrentMarkOperation(operation, false)) setBusy(false)
    }
  }

  async function retryMark(intent: DocumentMarkCreateIntent) {
    if (!sourceViewSelected || !actionPort.retryMark) return
    const operation = beginMarkOperation()
    setBusy(true)
    setActionError("")
    try {
      const mark = await actionPort.retryMark(intent)
      if (!isCurrentMarkOperation(operation)) return
      const currentAnchor = preparedAnchor?.anchor
      if (currentAnchor?.id === intent.anchor.id
        && currentAnchor.ref === intent.anchor.ref
        && currentAnchor.document_revision_id === intent.anchor.document_revision_id) {
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
        setActionError(reason instanceof Error ? reason.message : "The exact document mark request remains available to retry.")
      }
    } finally {
      if (isMountedMarkOperationScope(operation)) refreshMarkRecoveries()
      if (isCurrentMarkOperation(operation, false)) setBusy(false)
    }
  }

  async function createTask(recovery?: PaperReaderTaskRequest) {
    if (!sourceViewSelected) return
    if (!actionPort.createTask) {
      setActionError("Task creation is not installed in this deployment.")
      return
    }
    const title = recovery?.title ?? taskTitle.trim()
    const goal = recovery?.goal ?? taskGoal.trim()
    if (!recovery && (!title || title.length > 200 || !goal || goal.length > 4_000)) {
      setActionError("Task title and goal must remain within their displayed limits.")
      return
    }
    const expectedSelectionGeneration = selectionGeneration.current
    setBusy(true)
    setActionError("")
    try {
      const anchor = recovery?.anchor ?? await ensureAnchor(expectedSelectionGeneration)
      if (!recovery && !shouldCommitPaperAnchorCompletion(expectedSelectionGeneration, selectionGeneration.current)) return
      const request: PaperReaderTaskRequest = recovery ?? {
        schemaId: "gb.paper-task-request.v1" as const,
        idempotencyKey: crypto.randomUUID(),
        requestedAt: new Date().toISOString(),
        anchor,
        resourceRefs: [anchor.ref],
        title,
        goal,
        sourceHref: sourceHrefFor(anchor),
      }
      const recoveryKey = paperTaskRecoveryKey(tenantId, principalId, descriptor!.revisionId, request.idempotencyKey)
      window.localStorage.setItem(recoveryKey, JSON.stringify(request))
      refreshRecoveries()
      const backlink = await actionPort.createTask(request)
      window.localStorage.removeItem(recoveryKey)
      refreshRecoveries()
      setActionHref(backlink.href ? { href: backlink.href, label: "Open task in Task Constructor" } : null)
      setStatus("Task created from the exact source passage.")
    } catch (reason) {
      refreshRecoveries()
      setActionError(reason instanceof Error ? reason.message : "The task could not be created. Its recovery record was preserved.")
    } finally {
      setBusy(false)
    }
  }

  async function placeSelection() {
    if (!sourceViewSelected) return
    const expectedSelectionGeneration = selectionGeneration.current
    setBusy(true)
    setActionError("")
    try {
      const anchor = await ensureAnchor(expectedSelectionGeneration)
      if (!shouldCommitPaperAnchorCompletion(expectedSelectionGeneration, selectionGeneration.current)) return
      const placed = await placeDocumentAnchorRecoverably(anchor, tenantId, principalId, window.localStorage)
      setActionHref({ href: atlasPlacementHref(placed.canvasId, placed.placementId), label: "Open placed card in Atlas" })
      setStatus(placed.replayed ? "Recovered the existing Atlas placement." : "Placed the exact passage on Atlas.")
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "The exact passage could not be placed on Atlas.")
    } finally {
      setBusy(false)
    }
  }

  async function transformHtmlDocument() {
    if (!descriptor || !htmlDerivedEligible || !sourceVerified) return
    if (!dataPort.transformDocument) {
      setHtmlDerivedPhase("failed")
      setHtmlDerivedError("Document analysis is not installed in this deployment. The exact source remains available.")
      return
    }
    htmlTransformController.current?.abort()
    const controller = new AbortController()
    const generation = htmlDerivedRequestGeneration.current + 1
    const revisionId = descriptor.revisionId
    htmlDerivedRequestGeneration.current = generation
    htmlTransformController.current = controller
    setHtmlDerivedPhase("starting")
    setHtmlDerivedError("")
    setHtmlDerivedMessage("Starting bounded HTML analysis…")
    try {
      const result = await dataPort.transformDocument(
        revisionId,
        `${tenantId}:${principalId}`,
        controller.signal,
      )
      if (controller.signal.aborted || !shouldAcceptExactHtmlDerivedCompletion(
        { generation, revisionId },
        { generation: htmlDerivedRequestGeneration.current, revisionId: htmlDerivedRevision.current },
      )) return
      if (!("representations" in result)) {
        setHtmlDerivedPhase("running")
        setHtmlDerivedError("")
        setHtmlDerivedMessage("HTML analysis is still running. Resume to reconcile this same operation.")
        return
      }
      const representations = result.representations as ReaderRepresentation[]
      const receipts = [result.receipt, ...(result.fallbackReceipt ? [result.fallbackReceipt] : [])]
      commitHtmlDerivedState(representations, receipts, { generation, revisionId })
    } catch (reason) {
      if (controller.signal.aborted || !shouldAcceptExactHtmlDerivedCompletion(
        { generation, revisionId },
        { generation: htmlDerivedRequestGeneration.current, revisionId: htmlDerivedRevision.current },
      )) return
      const uncertain = reason instanceof DocumentTransformClientError && reason.retryable
      setHtmlDerivedPhase(uncertain ? "uncertain" : "failed")
      setHtmlDerivedMessage(uncertain
        ? "HTML analysis may still be running. Resume to reconcile this same operation."
        : "")
      setHtmlDerivedError(uncertain
        ? ""
        : reason instanceof DocumentTransformClientError
          ? reason.message
          : "HTML analysis could not be completed. The exact source remains available.")
    } finally {
      if (htmlTransformController.current === controller) htmlTransformController.current = null
    }
  }

  if (!descriptor) {
    return (
      <main className="research-workbench grid min-h-[70vh] place-items-center bg-[hsl(var(--research-paper))] px-6 text-[hsl(var(--research-ink))]">
        <section className="max-w-xl rounded-2xl border border-[#b66238]/35 bg-[#fff5ed] p-6 text-[#7f321f]" role="alert">
          <h1 className="research-display text-xl font-semibold">The exact representation could not be verified</h1>
          <p className="mt-2 text-sm">{descriptorState.error}</p>
          <p className="mt-2 text-xs">No alternate or stale content was displayed.</p>
        </section>
      </main>
    )
  }

  const Icon = descriptor.markdown ? FileText : FileCode2
  const sourceActions = sourceViewSelected && sourceVerified ? (
    <aside className="border-b border-[color:var(--research-line)] bg-[hsl(var(--research-accent-soft))]/45 px-4 py-4 sm:px-7" aria-labelledby="exact-text-actions-title" aria-busy={busy}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="exact-text-actions-title" className="research-display text-lg font-semibold">Read · mark · act</h2>
          <p className="research-muted mt-1 text-sm">Select text below. Rendered Markdown or math is accepted only when it is one literal, unique passage in the verified source.</p>
        </div>
        {selection ? <span className="rounded-full border border-[color:var(--research-line)] bg-[hsl(var(--research-panel))] px-3 py-1 font-mono text-xs">{Array.from(selection).length.toLocaleString()} exact characters</span> : null}
      </div>
      {selection ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
          <div>
            <blockquote className="max-h-28 overflow-auto whitespace-pre-wrap rounded-xl border border-[color:var(--research-line)] bg-[hsl(var(--research-panel))] p-3 text-sm">{selection}</blockquote>
            <div className="mt-3">
              <Label htmlFor="exact-text-mark-note">Margin note</Label>
              <Textarea
                id="exact-text-mark-note"
                className="mt-1 min-h-20"
                value={markNote}
                maxLength={65_536}
                onChange={(event) => {
                  noteEditGeneration.current += 1
                  setMarkNote(event.target.value)
                }}
              />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" variant="outline" className="min-h-11" disabled={busy || !actionPort.createMark} onClick={() => void createSelectionMark("clip")}><Quote aria-hidden="true" className="mr-2 h-4 w-4" />Highlight</Button>
              <Button type="button" className="min-h-11" disabled={busy || !actionPort.createMark || !markNote.trim()} onClick={() => void createSelectionMark("note")}><Link2 aria-hidden="true" className="mr-2 h-4 w-4" />Save note</Button>
              <Button type="button" className="min-h-11" disabled={busy || !actionPort.createTask || !taskTitle.trim() || !taskGoal.trim()} onClick={() => void createTask()}><ListTodo aria-hidden="true" className="mr-2 h-4 w-4" />Create task</Button>
              <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => void placeSelection()}><PanelsTopLeft aria-hidden="true" className="mr-2 h-4 w-4" />Place on Atlas</Button>
            </div>
          </div>
          <div className="grid gap-3">
            <div><Label htmlFor="exact-text-task-title">Task title</Label><Input id="exact-text-task-title" className="mt-1" value={taskTitle} maxLength={200} onChange={(event) => setTaskTitle(event.target.value)} /></div>
            <div><Label htmlFor="exact-text-task-goal">Task goal</Label><Textarea id="exact-text-task-goal" className="mt-1 min-h-24" value={taskGoal} maxLength={4_000} onChange={(event) => setTaskGoal(event.target.value)} /></div>
          </div>
        </div>
      ) : null}
      <div ref={markStatusRef} tabIndex={-1} className="mt-3 min-h-6 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--research-accent))]" role="status" aria-live="polite" aria-atomic="true">{busy ? "Saving the exact source action…" : status}</div>
      {actionError ? <p className="mt-2 rounded-lg border border-[#b66238]/35 bg-[#fff5ed] p-3 text-sm text-[#7f321f]" role="alert">{actionError}</p> : null}
      {markRecoveryError ? <p className="mt-2 rounded-lg border border-[#b66238]/35 bg-[#fff5ed] p-3 text-sm text-[#7f321f]" role="alert">{markRecoveryError}</p> : null}
      {actionHref ? <Link href={actionHref.href} className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-[hsl(var(--research-accent))] underline-offset-4 hover:underline">{actionHref.label}</Link> : null}
      {pendingMarks.length ? (
        <section className="mt-3 rounded-xl border border-[#d8a879] bg-white/70 p-3" aria-labelledby="pending-exact-text-marks" role="region" aria-live="polite" aria-atomic="false">
          <h3 id="pending-exact-text-marks" className="research-display font-semibold">Pending mark recovery</h3>
          <ul className="mt-2 space-y-2">
            {pendingMarks.map((intent) => (
              <li key={intent.idempotencyKey} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm">{intent.kind === "highlight" ? "Evidence highlight" : "Margin note"}</span>
                <Button type="button" size="sm" variant="outline" disabled={busy || !actionPort.retryMark} onClick={() => void retryMark(intent)}><RotateCcw aria-hidden="true" className="mr-2 h-3.5 w-3.5" />Retry same request</Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {pendingTasks.length ? (
        <section className="mt-3 rounded-xl border border-[#d8a879] bg-white/70 p-3" aria-labelledby="exact-text-recovery-title">
          <h3 id="exact-text-recovery-title" className="research-display font-semibold">Pending task recovery</h3>
          <ul className="mt-2 space-y-2">
            {pendingTasks.map((request) => (
              <li key={request.idempotencyKey} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm">{request.title}</span>
                <Button type="button" size="sm" variant="outline" disabled={busy || !actionPort.createTask} onClick={() => void createTask(request)}><RotateCcw aria-hidden="true" className="mr-2 h-3.5 w-3.5" />Retry same request</Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  ) : null
  const sourceDocument = (
    <>
      {loadError ? (
        <section className="m-4 rounded-xl border border-[#b66238]/35 bg-[#fff5ed] p-5 text-[#7f321f] sm:m-7" role="alert" aria-labelledby="exact-document-error-title">
          <h2 id="exact-document-error-title" className="research-display text-xl font-semibold">The exact representation could not be verified</h2>
          <p className="mt-2 text-sm">{loadError}</p>
          <p className="mt-2 text-xs">No alternate or stale content was displayed.</p>
        </section>
      ) : activeContent === null ? (
        <section className="grid min-h-72 place-items-center p-8" aria-busy="true" role="status" aria-live="polite">
          <p className="inline-flex items-center gap-2"><Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" />Verifying exact UTF-8 bytes…</p>
        </section>
      ) : (
        <section
          ref={contentRootRef}
          className={descriptor.markdown ? "px-5 py-7 sm:px-10 sm:py-10" : "p-4 sm:p-7"}
          aria-label={descriptor.markdown ? "Exact Markdown document" : "Exact text or source document"}
          onPointerUp={captureSelection}
          onKeyUp={captureSelection}
        >
          {descriptor.markdown ? (
            <MarkdownRenderer content={activeContent} images="omit" className="research-markdown mx-auto max-w-4xl" />
          ) : (
            <pre className="max-h-[72vh] overflow-auto whitespace-pre rounded-xl border border-[color:var(--research-line)] bg-[#fffdf7] p-4 text-sm leading-6 text-[#1e2a24] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--research-accent))]" tabIndex={0} aria-label={`Exact contents of ${descriptor.displayFilename}`}><code>{activeContent}</code></pre>
          )}
        </section>
      )}
      <DocumentMarkPanel anchor={preparedAnchor?.anchor ?? null} dataPort={dataPort} refreshToken={markListRevision} className="m-4 sm:m-7" />
    </>
  )
  const htmlTabsActive = htmlDerivedEligible && sourceVerified
  return (
    <main className="research-workbench min-h-[calc(100vh-5rem)] bg-[hsl(var(--research-paper))] p-3 pb-24 text-[hsl(var(--research-ink))] sm:p-5 sm:pb-24">
      <article className="mx-auto max-w-6xl overflow-hidden rounded-2xl border border-[color:var(--research-line)] bg-[hsl(var(--research-panel))] shadow-sm" aria-labelledby="exact-document-title">
        <header className="border-b border-[color:var(--research-line)] px-4 py-4 sm:px-7 sm:py-6">
          <p className="research-kicker flex items-center gap-2"><Icon aria-hidden="true" className="h-4 w-4" />Exact immutable document</p>
          <h1 id="exact-document-title" className="research-display mt-2 text-2xl font-semibold sm:text-3xl">{descriptor.title}</h1>
          <p className="research-muted mt-2 break-all font-mono text-xs">{descriptor.displayFilename}</p>
          <dl className="research-muted mt-4 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
            <dt>Media type</dt><dd className="font-mono">{descriptor.mediaType}</dd>
            <dt>Revision</dt><dd className="break-all font-mono">sha256:{descriptor.revisionSha256}</dd>
            <dt>Content</dt><dd className="break-all font-mono">sha256:{descriptor.contentSha256}</dd>
            <dt>Representation</dt><dd className="break-all font-mono">{descriptor.representationRef}</dd>
          </dl>
        </header>

        {htmlTabsActive ? (
          <Tabs
            value={htmlView}
            onValueChange={(value) => {
              if (value === "source" || value === "structure" || value === "markdown") setHtmlView(value)
            }}
          >
            <section className="border-b border-[color:var(--research-line)] bg-[#f7f2e6] px-4 py-4 sm:px-7" aria-labelledby="html-reading-views-title">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 id="html-reading-views-title" className="research-display text-lg font-semibold">HTML reading views</h2>
                  <p className="research-muted mt-1 max-w-2xl text-sm">Source is the escaped, hash-verified authority. Receipt-bound projections are read-only and never create source anchors.</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={!dataPort.transformDocument || htmlDerivedPhase === "starting"}
                  onClick={() => void transformHtmlDocument()}
                >
                  {htmlDerivedPhase === "starting" ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles aria-hidden="true" className="mr-2 h-4 w-4" />}
                  {htmlDerivedPhase === "running" || htmlDerivedPhase === "uncertain" ? "Resume analysis" : "Analyze HTML"}
                </Button>
              </div>
              <TabsList className="mt-4 h-auto min-h-11 flex-wrap justify-start" aria-label="HTML reading view">
                <TabsTrigger value="source" className="min-h-11">Source</TabsTrigger>
                {htmlStructure ? <TabsTrigger value="structure" className="min-h-11">Structured text</TabsTrigger> : null}
                {htmlMarkdown ? <TabsTrigger value="markdown" className="min-h-11">Markdown + math</TabsTrigger> : null}
              </TabsList>
              <div className="mt-3 min-h-6 text-sm" role="status" aria-live="polite" aria-atomic="true">
                {htmlDerivedMessage}
              </div>
              {htmlDerivedError ? <p className="mt-2 rounded-lg border border-[#b66238]/35 bg-[#fff5ed] p-3 text-sm text-[#7f321f]" role="alert">{htmlDerivedError}</p> : null}
              {activeHtmlDerivedState?.primaryReceipt ? (
                <HtmlTransformReceipt label="Primary transform receipt" receipt={activeHtmlDerivedState.primaryReceipt} />
              ) : null}
              {htmlFallbackReceipt ? <HtmlTransformReceipt label="Fallback transform receipt" receipt={htmlFallbackReceipt} /> : null}
            </section>
            {sourceActions}
            <TabsContent value="source" className="m-0">{sourceDocument}</TabsContent>
            {htmlStructure ? (
              <TabsContent value="structure" className="m-0">
                <p className="border-b border-[color:var(--research-line)] bg-[#fff8df] px-5 py-3 text-sm text-[#624d20]" role="note">Read-only derived structure. Return to Source to select, mark, create a task, or place content on Atlas.</p>
                <DocumentStructureReader structure={htmlStructure.content as GalaxyDocumentStructure} />
              </TabsContent>
            ) : null}
            {htmlMarkdown ? (
              <TabsContent value="markdown" className="m-0">
                <p className="border-b border-[color:var(--research-line)] bg-[#fff8df] px-5 py-3 text-sm text-[#624d20]" role="note">Read-only derived Markdown and math. Return to Source to select, mark, create a task, or place content on Atlas.</p>
                <section className="px-5 py-7 sm:px-10 sm:py-10" aria-label="Receipt-bound derived Markdown and math">
                  <MarkdownRenderer content={htmlMarkdown.content as string} images="omit" className="research-markdown mx-auto max-w-4xl" />
                </section>
              </TabsContent>
            ) : null}
          </Tabs>
        ) : (
          <>{sourceActions}{sourceDocument}</>
        )}

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[color:var(--research-line)] px-4 py-3 text-xs text-[hsl(var(--research-muted))] sm:px-7">
          <span className="inline-flex items-center gap-1.5"><ShieldCheck aria-hidden="true" className="h-4 w-4" />Verified against the immutable representation hash</span>
          <span className="max-w-full truncate font-mono" title={descriptor.documentRef}>{descriptor.documentRef}</span>
        </footer>
      </article>
    </main>
  )
}
