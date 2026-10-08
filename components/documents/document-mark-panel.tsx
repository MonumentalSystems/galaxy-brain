"use client"

import { Loader2 } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"

import { MarkdownRenderer } from "@/components/markdown-renderer"
import type { DocumentMarkList, DurableDocumentMarkSnapshot } from "@/lib/document-mark-client.js"
import type { DurableDocumentAnchor, PaperReaderDataPort } from "@/lib/paper-reader-client"
import { cn } from "@/lib/utils"

const DISCLOSURE_STEP = 20

export type DocumentMarkPanelProps = {
  anchor: DurableDocumentAnchor | null
  dataPort: Pick<PaperReaderDataPort, "listMarks">
  refreshToken?: number
  className?: string
}

function markLabel(mark: DurableDocumentMarkSnapshot) {
  if (mark.kind === "highlight") return "Evidence highlight"
  if (mark.kind === "ink") return "Legacy ink mark · read-only"
  return "Margin note"
}

export function DocumentMarkPanel({
  anchor,
  dataPort,
  refreshToken = 0,
  className,
}: DocumentMarkPanelProps) {
  const headingId = useId()
  const marksId = useId()
  const [resultState, setResultState] = useState<{ anchorKey: string; value: DocumentMarkList } | null>(null)
  const [loadingAnchorKey, setLoadingAnchorKey] = useState("")
  const [errorState, setErrorState] = useState<{ anchorKey: string; message: string } | null>(null)
  const [visibleCount, setVisibleCount] = useState(DISCLOSURE_STEP)
  const request = useRef({ generation: 0, anchorKey: "" })
  const anchorKey = anchor ? `${anchor.document_revision_id}:${anchor.id}:${anchor.ref}` : ""
  const result = resultState?.anchorKey === anchorKey ? resultState.value : null
  const error = errorState?.anchorKey === anchorKey ? errorState.message : ""
  const loading = Boolean(anchor) && (loadingAnchorKey === anchorKey || request.current.anchorKey !== anchorKey)
  const visibleMarks = result?.marks.slice(0, visibleCount) ?? []

  useEffect(() => {
    const generation = request.current.generation + 1
    request.current = { generation, anchorKey }
    const controller = new AbortController()
    let active = true
    setResultState(null)
    setErrorState(null)
    setVisibleCount(DISCLOSURE_STEP)
    setLoadingAnchorKey(anchor ? anchorKey : "")
    if (!anchor) return () => {
      active = false
      controller.abort()
    }
    dataPort.listMarks(anchor, controller.signal).then((next) => {
      if (!active || controller.signal.aborted
        || request.current.generation !== generation || request.current.anchorKey !== anchorKey) return
      setResultState({ anchorKey, value: next })
    }).catch((reason: unknown) => {
      if (!active || controller.signal.aborted
        || request.current.generation !== generation || request.current.anchorKey !== anchorKey) return
      setErrorState({
        anchorKey,
        message: reason instanceof Error ? reason.message : "Document marks could not be loaded.",
      })
    }).finally(() => {
      if (active && !controller.signal.aborted
        && request.current.generation === generation && request.current.anchorKey === anchorKey) setLoadingAnchorKey("")
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [anchor, anchorKey, dataPort, refreshToken])

  if (!anchor) return null

  return (
    <section
      className={cn("rounded-2xl border border-[color:var(--research-line)] bg-[hsl(var(--research-panel)/0.96)] p-4 shadow-sm", className)}
      aria-labelledby={headingId}
      aria-busy={loading}
    >
      <h2 id={headingId} className="research-display font-semibold">Document marks</h2>
      <div className="mt-2 text-sm" role="status" aria-live="polite" aria-atomic="true">
        {loading ? <p className="research-muted inline-flex items-center gap-2"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Loading marks…</p> : null}
        {error ? <p className="text-[#9b3f2a]" role="alert">{error}</p> : null}
        {!loading && !error && result?.marks.length === 0 ? <p className="research-muted">No marks refer to this coordinate yet.</p> : null}
      </div>
      {result?.marks.length ? (
        <ul id={marksId} className="mt-3 space-y-3">
          {visibleMarks.map((mark) => (
            <li key={mark.id} className="rounded-xl border border-[color:var(--research-line)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <p className="research-smallcaps inline-flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full border border-black/15" style={{ backgroundColor: mark.color }} aria-hidden="true" />
                  {markLabel(mark)} · {mark.semantic_role} · {mark.state}
                </p>
                <span className="research-muted">Revision {mark.version}</span>
              </div>
              {mark.body_markdown ? (
                <MarkdownRenderer content={mark.body_markdown} images="omit" className="research-markdown mt-3 text-sm" />
              ) : mark.kind === "highlight" ? (
                <p className="research-muted mt-3 text-sm">Highlighted source passage.</p>
              ) : (
                <p className="research-muted mt-3 text-sm">No written annotation.</p>
              )}
              <p className="research-muted mt-3 break-all font-mono text-[10px]">Author {mark.created_by_principal_id} · {mark.updated_at}</p>
            </li>
          ))}
        </ul>
      ) : null}
      {result && visibleMarks.length < result.marks.length ? (
        <button
          type="button"
          className="mt-3 min-h-11 rounded-lg border border-[color:var(--research-line)] px-4 py-2 text-sm font-medium hover:bg-[hsl(var(--research-accent-soft))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--research-accent))]"
          aria-controls={marksId}
          onClick={() => setVisibleCount((current) => Math.min(current + DISCLOSURE_STEP, result.marks.length))}
        >
          Show more marks ({visibleMarks.length.toLocaleString()} of {result.marks.length.toLocaleString()})
        </button>
      ) : null}
      {result?.completeness === "possibly-incomplete" ? (
        <p className="mt-3 rounded-lg border border-[#d8a879] bg-[#fff7e9] p-3 text-xs text-[#74421f]" role="note">
          The server returned its 1,000-mark limit. Additional marks may exist.
        </p>
      ) : null}
    </section>
  )
}
