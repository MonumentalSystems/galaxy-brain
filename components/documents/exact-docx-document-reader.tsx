"use client"

import { Download, FileArchive, Loader2, ShieldCheck, Sparkles } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { MarkdownRenderer } from "@/components/markdown-renderer"
import { DocumentStructureReader } from "@/components/papers/document-structure-reader"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  selectExactDerivedDocumentState,
  shouldAcceptDerivedDocumentCompletion,
  type ExactDerivedDocumentState,
} from "@/lib/document-derived-reader.js"
import {
  exactDocxDocumentDescriptor,
  type ExactDocxDocumentDescriptor,
} from "@/lib/document-docx-reader.js"
import { DocumentTransformClientError } from "@/lib/document-transform-client.js"
import type { DurableTransformReceipt, GalaxyDocumentStructure } from "@/lib/ingestion-contract.js"
import type { DurableDocumentRevision, PaperReaderDataPort } from "@/lib/paper-reader-client"
import type { ReaderRepresentation } from "@/lib/paper-reader.js"

type View = "original" | "structure" | "markdown"
type Phase = "idle" | "loading" | "starting" | "running" | "uncertain" | "ready" | "failed"

export type ExactDocxDocumentReaderProps = {
  revision: DurableDocumentRevision
  tenantId: string
  principalId: string
  dataPort: PaperReaderDataPort
}

function ReceiptDetails({ label, receipt }: { label: string; receipt: DurableTransformReceipt }) {
  return (
    <section className="mt-3 border-t border-[color:var(--research-line)] pt-3" aria-label={label}>
      <p className="research-smallcaps text-[10px]">{label}</p>
      <dl className="research-muted mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt>Provider</dt><dd className="min-w-0 break-all">{receipt.plugin_id}</dd>
        <dt>Engine</dt><dd className="min-w-0 break-all">{receipt.engine} {receipt.engine_version}</dd>
        <dt>Status</dt><dd className="min-w-0 break-all">{receipt.status}</dd>
        <dt>Receipt</dt><dd className="min-w-0 break-all font-mono">{receipt.id}</dd>
        <dt>Input</dt><dd className="min-w-0 break-all font-mono">sha256:{receipt.input_sha256}</dd>
        {receipt.output_sha256 ? <><dt>Output</dt><dd className="min-w-0 break-all font-mono">sha256:{receipt.output_sha256}</dd></> : null}
      </dl>
    </section>
  )
}

export function ExactDocxDocumentReader({ revision, tenantId, principalId, dataPort }: ExactDocxDocumentReaderProps) {
  const descriptorState = useMemo<{ descriptor: ExactDocxDocumentDescriptor | null; error: string }>(() => {
    try {
      return { descriptor: exactDocxDocumentDescriptor(revision, revision.revision_id), error: "" }
    } catch (reason) {
      return { descriptor: null, error: reason instanceof Error ? reason.message : "The exact DOCX metadata could not be verified." }
    }
  }, [revision])
  const descriptor = descriptorState.descriptor
  const [view, setView] = useState<View>("original")
  const [derived, setDerived] = useState<ExactDerivedDocumentState | null>(null)
  const [phase, setPhase] = useState<Phase>("idle")
  const [message, setMessage] = useState("No derived DOCX reading view has been requested.")
  const [error, setError] = useState("")
  const generation = useRef(0)
  const activeRevision = useRef(descriptor?.revisionId ?? "")
  const controllerRef = useRef<AbortController | null>(null)
  activeRevision.current = descriptor?.revisionId ?? ""

  const commit = useCallback((
    representations: ReaderRepresentation[],
    receipts: DurableTransformReceipt[],
    operation: { generation: number; revisionId: string },
  ) => {
    if (!descriptor || !shouldAcceptDerivedDocumentCompletion(operation, {
      generation: generation.current, revisionId: activeRevision.current,
    })) return false
    try {
      const selected = selectExactDerivedDocumentState(descriptor, representations, receipts, { label: "DOCX" })
      setDerived(selected)
      setError("")
      if (selected.structure || selected.markdown) {
        setPhase("ready")
        setMessage(selected.fallbackReceipt
          ? "Primary analysis failed or was skipped; its receipt-bound MarkItDown fallback is ready."
          : "Receipt-bound read-only DOCX projections are ready.")
      } else {
        setPhase(receipts.length ? "failed" : "idle")
        setMessage(receipts.length ? "Analysis produced no verified derived reading view." : "No derived DOCX reading view has been requested.")
      }
      return true
    } catch {
      setDerived(null)
      setPhase("failed")
      setMessage("")
      setError("Derived DOCX reading state could not be verified against this exact source. The original remains available.")
      return false
    }
  }, [descriptor])

  useEffect(() => {
    controllerRef.current?.abort()
    setDerived(null)
    setView("original")
    setError("")
    if (!descriptor) return undefined
    if (!dataPort.loadRepresentationState) {
      setPhase("idle")
      setMessage("Derived reading state is unavailable. The exact original remains available.")
      return undefined
    }
    const controller = new AbortController()
    const operation = { generation: generation.current + 1, revisionId: descriptor.revisionId }
    generation.current = operation.generation
    controllerRef.current = controller
    setPhase("loading")
    setMessage("Checking receipt-bound DOCX reading views…")
    dataPort.loadRepresentationState(descriptor.revisionId, controller.signal).then((state) => {
      if (!controller.signal.aborted) commit(state.representations, state.receipts, operation)
    }).catch(() => {
      if (controller.signal.aborted || !shouldAcceptDerivedDocumentCompletion(operation, {
        generation: generation.current, revisionId: activeRevision.current,
      })) return
      setPhase("failed")
      setMessage("")
      setError("Derived DOCX reading state could not be loaded. The exact original remains available.")
    }).finally(() => {
      if (controllerRef.current === controller) controllerRef.current = null
    })
    return () => {
      controller.abort()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [commit, dataPort, descriptor])

  useEffect(() => () => controllerRef.current?.abort(), [])
  useEffect(() => {
    if ((view === "structure" && !derived?.structure) || (view === "markdown" && !derived?.markdown)) {
      setView("original")
    }
  }, [derived, view])

  async function analyze() {
    if (!descriptor) return
    if (!dataPort.transformDocument) {
      setPhase("failed")
      setError("Document analysis is not installed in this deployment. The exact original remains available.")
      return
    }
    controllerRef.current?.abort()
    const controller = new AbortController()
    const operation = { generation: generation.current + 1, revisionId: descriptor.revisionId }
    generation.current = operation.generation
    controllerRef.current = controller
    setPhase("starting")
    setError("")
    setMessage("Starting bounded DOCX analysis…")
    try {
      const result = await dataPort.transformDocument(
        descriptor.revisionId, `${tenantId}:${principalId}`, controller.signal,
      )
      if (controller.signal.aborted || !shouldAcceptDerivedDocumentCompletion(operation, {
        generation: generation.current, revisionId: activeRevision.current,
      })) return
      if (!("representations" in result)) {
        setPhase("running")
        setMessage("DOCX analysis is still running. Resume to reconcile this same operation.")
        return
      }
      const receipts = [result.receipt, ...(result.fallbackReceipt ? [result.fallbackReceipt] : [])]
      commit(result.representations as ReaderRepresentation[], receipts, operation)
    } catch (reason) {
      if (controller.signal.aborted || !shouldAcceptDerivedDocumentCompletion(operation, {
        generation: generation.current, revisionId: activeRevision.current,
      })) return
      const uncertain = reason instanceof DocumentTransformClientError && reason.retryable
      setPhase(uncertain ? "uncertain" : "failed")
      setMessage(uncertain ? "DOCX analysis may still be running. Resume to reconcile this same operation." : "")
      setError(uncertain ? "" : reason instanceof DocumentTransformClientError
        ? reason.message : "DOCX analysis could not be completed. The exact original remains available.")
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }

  if (!descriptor) {
    return (
      <main className="research-workbench grid min-h-[70vh] place-items-center bg-[hsl(var(--research-paper))] px-6 text-[hsl(var(--research-ink))]">
        <section className="max-w-xl rounded-2xl border border-[#b66238]/35 bg-[#fff5ed] p-6 text-[#7f321f]" role="alert">
          <h1 className="research-display text-xl font-semibold">The exact DOCX could not be verified</h1>
          <p className="mt-2 text-sm">{descriptorState.error}</p>
          <p className="mt-2 text-xs">No alternate or stale content was displayed.</p>
        </section>
      </main>
    )
  }

  return (
    <main className="research-workbench min-h-[calc(100vh-5rem)] bg-[hsl(var(--research-paper))] p-3 pb-24 text-[hsl(var(--research-ink))] sm:p-5 sm:pb-24">
      <article className="mx-auto max-w-6xl overflow-hidden rounded-2xl border border-[color:var(--research-line)] bg-[hsl(var(--research-panel))] shadow-sm" aria-labelledby="exact-docx-title">
        <header className="border-b border-[color:var(--research-line)] px-4 py-4 sm:px-7 sm:py-6">
          <p className="research-kicker flex items-center gap-2"><FileArchive aria-hidden="true" className="h-4 w-4" />Exact immutable DOCX</p>
          <h1 id="exact-docx-title" className="research-display mt-2 break-words text-2xl font-semibold sm:text-3xl">{descriptor.title}</h1>
          <p className="research-muted mt-2 break-all font-mono text-xs">{descriptor.originalFilename}</p>
          <dl className="research-muted mt-4 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
            <dt>Media type</dt><dd className="break-all font-mono">{descriptor.mediaType}</dd>
            <dt>Revision</dt><dd className="break-all font-mono">sha256:{descriptor.revisionSha256}</dd>
            <dt>Content</dt><dd className="break-all font-mono">sha256:{descriptor.contentSha256}</dd>
            <dt>Representation</dt><dd className="break-all font-mono">{descriptor.representationRef}</dd>
          </dl>
        </header>
        <Tabs value={view} onValueChange={(next) => {
          if (next === "original" || next === "structure" || next === "markdown") setView(next)
        }}>
          <section className="border-b border-[color:var(--research-line)] bg-[hsl(var(--research-paper))] px-4 py-4 sm:px-7" aria-labelledby="docx-reading-views-title">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 id="docx-reading-views-title" className="research-display text-lg font-semibold">DOCX reading views</h2>
                <p className="research-muted mt-1 max-w-2xl text-sm">The downloadable original is authoritative. Derived structure, Markdown, and math are receipt-bound read-only views without source selectors.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <a href={descriptor.contentUrl} download={descriptor.originalFilename} className="inline-flex min-h-11 items-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium shadow-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--research-accent))] focus-visible:ring-offset-2">
                  <Download aria-hidden="true" className="mr-2 h-4 w-4" />Download exact original
                </a>
                <Button type="button" variant="outline" className="min-h-11" aria-busy={phase === "starting"} disabled={!dataPort.transformDocument || phase === "starting"} onClick={() => void analyze()}>
                  {phase === "starting" ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles aria-hidden="true" className="mr-2 h-4 w-4" />}
                  {phase === "running" || phase === "uncertain" ? "Resume analysis" : "Analyze DOCX"}
                </Button>
              </div>
            </div>
            <TabsList className="mt-4 h-auto min-h-11 flex-wrap justify-start" aria-label="DOCX reading view">
              <TabsTrigger value="original" className="min-h-11">Exact original</TabsTrigger>
              {derived?.structure ? <TabsTrigger value="structure" className="min-h-11">Structured text</TabsTrigger> : null}
              {derived?.markdown ? <TabsTrigger value="markdown" className="min-h-11">Markdown + math</TabsTrigger> : null}
            </TabsList>
            <div className="mt-3 min-h-6 text-sm" role="status" aria-live="polite" aria-atomic="true">{message}</div>
            {error ? <p className="mt-2 rounded-lg border border-[#b66238]/35 bg-[#fff5ed] p-3 text-sm text-[#7f321f]" role="alert">{error}</p> : null}
            {derived?.primaryReceipt ? <ReceiptDetails label="Primary transform receipt" receipt={derived.primaryReceipt} /> : null}
            {derived?.fallbackReceipt ? <ReceiptDetails label="Fallback transform receipt" receipt={derived.fallbackReceipt} /> : null}
          </section>
          <TabsContent value="original" className="m-0">
            <section className="px-5 py-8 sm:px-10" aria-labelledby="docx-original-title">
              <h2 id="docx-original-title" className="research-display text-xl font-semibold">Exact original package</h2>
              <p className="research-muted mt-2 max-w-3xl text-sm">Galaxy preserves these bytes unchanged. Browser-side Office rendering is intentionally not used; download the original for layout-faithful reading or analyze it for bounded read-only projections.</p>
              <dl className="mt-5 grid gap-x-5 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
                <dt>Stored filename</dt><dd className="break-all font-mono">{descriptor.displayFilename}</dd>
                <dt>Original filename</dt><dd className="break-all font-mono">{descriptor.originalFilename}</dd>
                <dt>Size</dt><dd>{descriptor.byteSize.toLocaleString()} bytes</dd>
              </dl>
            </section>
          </TabsContent>
          {derived?.structure ? (
            <TabsContent value="structure" className="m-0">
              <p className="border-b border-[color:var(--research-line)] bg-[#fff8df] px-5 py-3 text-sm text-[#624d20]" role="note">Read-only derived structure. It cannot create anchors, marks, excerpts, tasks, or regions without exact source mapping.</p>
              <DocumentStructureReader structure={derived.structure.content as GalaxyDocumentStructure} />
            </TabsContent>
          ) : null}
          {derived?.markdown ? (
            <TabsContent value="markdown" className="m-0">
              <p className="border-b border-[color:var(--research-line)] bg-[#fff8df] px-5 py-3 text-sm text-[#624d20]" role="note">Read-only derived Markdown and math. Images are omitted and no rendered selection is treated as an exact DOCX selector.</p>
              <section className="px-5 py-7 sm:px-10 sm:py-10" aria-label="Receipt-bound DOCX Markdown and math">
                <MarkdownRenderer content={derived.markdown.content as string} images="omit" className="research-markdown mx-auto max-w-4xl" />
              </section>
            </TabsContent>
          ) : null}
        </Tabs>
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[color:var(--research-line)] px-4 py-3 text-xs text-[hsl(var(--research-muted))] sm:px-7">
          <span className="inline-flex items-center gap-1.5"><ShieldCheck aria-hidden="true" className="h-4 w-4" />Exact original preserved; derived views require current receipt and hash lineage</span>
          <span className="max-w-full break-all font-mono">{descriptor.documentRef}</span>
        </footer>
      </article>
    </main>
  )
}
