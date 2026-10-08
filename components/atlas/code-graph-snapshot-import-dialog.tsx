"use client"

import { FileJson2, GitBranch, LoaderCircle } from "lucide-react"
import { useEffect, useRef, useState, type ChangeEvent } from "react"

import { Button } from "@/components/ui/button"
import { focusFirstConnected } from "@/components/atlas/presenter-focus"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { DurableDocumentImport } from "@/lib/durable-document-import.js"
import {
  CODE_GRAPH_SNAPSHOT_MEDIA_TYPE,
  CodeGraphSnapshotImportError,
  normalizeCodeGraphSnapshotReview,
  validateCodeGraphSnapshotFileDescriptor,
  type CodeGraphSnapshotReview,
} from "@/lib/code-graph-snapshot-import.js"

export type CodeGraphSnapshotImportPhase = "idle" | "importing" | "placing"

export type CodeGraphSnapshotImportRequest = Readonly<{
  file: File
  review: CodeGraphSnapshotReview
}>

export type CodeGraphSnapshotImportDialogProps = {
  open: boolean
  phase: CodeGraphSnapshotImportPhase
  error: string
  imported: DurableDocumentImport | null
  ambiguous: boolean
  onOpenChange: (open: boolean) => void
  onImport: (request: CodeGraphSnapshotImportRequest) => void
  onRetryPlacement: () => void
  onKeepWithoutPlacing: () => void
  onAbandon: () => void
  onEdit: () => void
  returnFocus: HTMLElement | null
  fallbackFocus: HTMLElement | null
}

type WorkerResponse = Readonly<{
  requestId: number
  ok: boolean
  review?: unknown
  error?: string
}>

function safeReviewError(error: unknown) {
  if (error instanceof CodeGraphSnapshotImportError) return error.message
  return "The snapshot could not be reviewed safely."
}

function createReviewWorker() {
  return new Worker(
    new URL("../../workers/code-graph-snapshot-import.worker.ts", import.meta.url),
    { type: "module" },
  )
}

export function CodeGraphSnapshotImportDialog({
  open,
  phase,
  error,
  imported,
  ambiguous,
  onOpenChange,
  onImport,
  onRetryPlacement,
  onKeepWithoutPlacing,
  onAbandon,
  onEdit,
  returnFocus,
  fallbackFocus,
}: CodeGraphSnapshotImportDialogProps) {
  const [file, setFile] = useState<File | null>(null)
  const [review, setReview] = useState<CodeGraphSnapshotReview | null>(null)
  const [reviewError, setReviewError] = useState("")
  const [reviewing, setReviewing] = useState(false)
  const workerRef = useRef<Worker | null>(null)
  const requestIdRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const stateActionRef = useRef<HTMLButtonElement>(null)
  const statePanelRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const busy = reviewing || phase !== "idle"

  useEffect(() => {
    if (!open) {
      workerRef.current?.terminate()
      workerRef.current = null
      requestIdRef.current += 1
      setFile(null)
      setReview(null)
      setReviewError("")
      setReviewing(false)
      return
    }
    if (!workerRef.current) {
      workerRef.current = createReviewWorker()
    }
    return () => {
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [open])

  useEffect(() => {
    if (!imported) return
    requestIdRef.current += 1
    setFile(null)
    setReview(null)
    setReviewError("")
    setReviewing(false)
  }, [imported])

  useEffect(() => {
    if (!open || (!imported && !ambiguous)) return
    const frame = window.requestAnimationFrame(() => {
      focusFirstConnected([stateActionRef.current, statePanelRef.current, contentRef.current])
    })
    return () => window.cancelAnimationFrame(frame)
  }, [ambiguous, imported, open])

  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null
    requestIdRef.current += 1
    const requestId = requestIdRef.current
    setFile(null)
    setReview(null)
    setReviewError("")
    onEdit()
    if (!selected) return
    try {
      validateCodeGraphSnapshotFileDescriptor(selected)
      setReviewing(true)
      const bytes = await selected.arrayBuffer()
      if (requestIdRef.current !== requestId) return
      const canonicalFile = selected.type
        ? selected
        : new File([bytes.slice(0)], selected.name, {
            type: CODE_GRAPH_SNAPSHOT_MEDIA_TYPE,
            lastModified: selected.lastModified,
          })
      const worker = workerRef.current ?? createReviewWorker()
      workerRef.current = worker
      worker.onmessage = (message: MessageEvent<WorkerResponse>) => {
        if (message.data?.requestId !== requestId || requestIdRef.current !== requestId) return
        setReviewing(false)
        if (!message.data.ok) {
          setReviewError(message.data.error || "The snapshot could not be reviewed safely.")
          return
        }
        try {
          const normalized = normalizeCodeGraphSnapshotReview(message.data.review)
          if (normalized.byteSize !== canonicalFile.size) {
            throw new CodeGraphSnapshotImportError("worker", "Snapshot review returned a mismatched byte size.")
          }
          setFile(canonicalFile)
          setReview(normalized)
        } catch (workerError) {
          setReviewError(safeReviewError(workerError))
        }
      }
      worker.onerror = () => {
        if (requestIdRef.current !== requestId) return
        worker.terminate()
        if (workerRef.current === worker) workerRef.current = null
        setReviewing(false)
        setReviewError("The snapshot review worker stopped unexpectedly. Choose the file again to retry.")
      }
      worker.postMessage({ requestId, bytes }, [bytes])
    } catch (selectionError) {
      if (requestIdRef.current !== requestId) return
      setReviewing(false)
      setReviewError(safeReviewError(selectionError))
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!busy && !ambiguous) onOpenChange(nextOpen) }}>
      <DialogContent
        ref={contentRef}
        tabIndex={-1}
        className="atlas-command-presenter research-workbench max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-[720px] overflow-y-auto p-0"
        closeDisabled={busy || ambiguous}
        closeDisabledLabel={ambiguous ? "Resolve the unconfirmed import first" : "Close unavailable while importing"}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          window.requestAnimationFrame(() => {
            focusFirstConnected([
              fileInputRef.current,
              stateActionRef.current,
              statePanelRef.current,
              contentRef.current,
            ])
          })
        }}
        onCloseAutoFocus={(event) => {
          if (focusFirstConnected([returnFocus, fallbackFocus], contentRef.current)) event.preventDefault()
        }}
        onEscapeKeyDown={(event) => { if (busy || ambiguous) event.preventDefault() }}
        onPointerDownOutside={(event) => { if (busy || ambiguous) event.preventDefault() }}
      >
        <DialogHeader className="atlas-command-presenter__section border-b px-5 py-4 pr-14 text-left">
          <DialogTitle className="research-display flex items-center gap-2 text-2xl">
            <GitBranch className="size-5" aria-hidden="true" />
            Import code graph snapshot
          </DialogTitle>
          <DialogDescription className="atlas-command-presenter__muted">
            Review one local Codebase Memory JSON file, preserve its exact bytes as an immutable
            document, then place the confirmed pinned revision on this Atlas. This does not project
            graph nodes or create relations.
          </DialogDescription>
        </DialogHeader>

        {!imported && !ambiguous ? (
          <div className="atlas-command-presenter__surface grid gap-3 px-5 py-4">
            <label className="grid gap-2 text-sm font-medium" htmlFor="code-graph-snapshot-file">
              Codebase Memory JSON snapshot
              <input
                ref={fileInputRef}
                id="code-graph-snapshot-file"
                type="file"
                accept="application/json,.json"
                disabled={busy}
                onChange={(event) => { void selectFile(event) }}
                className="min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-secondary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                aria-describedby="code-graph-snapshot-guidance"
              />
            </label>
            <p id="code-graph-snapshot-guidance" className="atlas-command-presenter__muted text-sm">
              Choose one UTF-8 <code>application/json</code> file. Review is bounded and local;
              do not include credentials, tokens, or private source text.
            </p>
            {reviewing ? (
              <p className="atlas-command-presenter__muted flex items-center gap-2 text-sm">
                <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                Reviewing snapshot…
              </p>
            ) : null}
          </div>
        ) : null}

        {review && file && !imported ? (
          <section className="atlas-command-presenter__card mx-5 grid gap-3 rounded-xl border p-4" aria-labelledby="code-graph-review-title">
            <h3 id="code-graph-review-title" className="flex items-center gap-2 font-semibold">
              <FileJson2 className="size-4" aria-hidden="true" />
              Exact-byte review
            </h3>
            <dl className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
              <dt className="atlas-command-presenter__muted">File</dt>
              <dd className="min-w-0 break-all">{file.name}</dd>
              <dt className="atlas-command-presenter__muted">Raw-byte SHA-256</dt>
              <dd className="min-w-0 break-all font-mono text-xs">{review.contentSha256}</dd>
              <dt className="atlas-command-presenter__muted">Declared provider</dt>
              <dd className="min-w-0 break-all">{review.provider.name} v{review.provider.version}</dd>
              <dt className="atlas-command-presenter__muted">Declared repository</dt>
              <dd className="min-w-0 break-all">{review.repository.repositoryId}</dd>
              <dt className="atlas-command-presenter__muted">Declared commit</dt>
              <dd className="min-w-0 break-all font-mono text-xs">{review.repository.commit}</dd>
              <dt className="atlas-command-presenter__muted">Declared digest</dt>
              <dd className="min-w-0 break-all font-mono text-xs">{review.declaredSnapshotDigest}</dd>
              <dt className="atlas-command-presenter__muted">Shape</dt>
              <dd>{review.nodeCount.toLocaleString()} nodes · {review.edgeCount.toLocaleString()} edges</dd>
            </dl>
            <p className="atlas-command-presenter__muted text-xs">
              The declared snapshot digest is provider metadata inside the immutable JSON. It is not
              the raw-file SHA-256 shown above.
            </p>
          </section>
        ) : null}

        {imported ? (
          <section
            ref={statePanelRef}
            tabIndex={-1}
            className="atlas-command-presenter__card mx-5 grid gap-3 rounded-xl border p-4"
            aria-busy={phase === "placing"}
          >
            <div>
              <h3 className="font-semibold">Pinned document is durable</h3>
              <p className="atlas-command-presenter__muted mt-1 break-all font-mono text-xs">{imported.ref}</p>
              <p className="atlas-command-presenter__muted mt-2 text-sm">
                Retry placement only. The exact JSON must not be uploaded again.
              </p>
            </div>
            <DialogFooter>
              <Button ref={stateActionRef} type="button" variant="outline" className="min-h-11" disabled={busy} onClick={onKeepWithoutPlacing}>
                Keep without placing
              </Button>
              <Button type="button" className="min-h-11" disabled={busy} onClick={onRetryPlacement}>
                {phase === "placing" ? "Placing…" : "Retry placement"}
              </Button>
            </DialogFooter>
          </section>
        ) : null}

        {ambiguous && !imported ? (
          <section ref={statePanelRef} tabIndex={-1} className="atlas-command-presenter__card mx-5 grid gap-3 rounded-xl border p-4">
            <p className="text-sm">
              The import outcome is unconfirmed. Retry with the same reviewed bytes, or explicitly
              abandon this recovery before selecting another file.
            </p>
            <DialogFooter>
              <Button ref={stateActionRef} type="button" variant="outline" className="min-h-11" disabled={busy} onClick={onAbandon}>
                Abandon recovery
              </Button>
              <Button
                type="button"
                className="min-h-11"
                disabled={busy || !file || !review}
                onClick={() => file && review && onImport({ file, review })}
              >
                Retry exact import
              </Button>
            </DialogFooter>
          </section>
        ) : null}

        {reviewError || error ? (
          <p role="alert" className="atlas-command-presenter__warning mx-5 rounded-md border p-3 text-sm">
            {reviewError || error}
          </p>
        ) : null}

        {phase !== "idle" ? (
          <p className="atlas-command-presenter__muted mx-5 flex items-center gap-2 text-sm">
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {phase === "importing" ? "Importing exact bytes…" : "Placing pinned document…"}
          </p>
        ) : null}

        {!imported && !ambiguous ? (
          <DialogFooter className="atlas-command-presenter__section gap-2 border-t px-5 py-4">
            <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              className="min-h-11"
              disabled={busy || !file || !review}
              onClick={() => file && review && onImport({ file, review })}
            >
              {phase === "importing" ? "Importing exact bytes…" : phase === "placing" ? "Placing…" : "Import and place"}
            </Button>
          </DialogFooter>
        ) : null}

        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {reviewing
            ? "Reviewing the selected JSON snapshot."
            : phase === "importing"
              ? "Importing the reviewed exact JSON bytes."
              : phase === "placing"
                ? "Placing the confirmed pinned document on this Atlas."
                : review
                  ? `Snapshot reviewed. ${review.nodeCount} nodes and ${review.edgeCount} edges declared.`
                  : ""}
        </p>
      </DialogContent>
    </Dialog>
  )
}
