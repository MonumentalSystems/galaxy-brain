"use client"

import { Check, Loader2, X } from "lucide-react"
import { useEffect, useId, useRef } from "react"

import { MarkdownRenderer } from "@/components/markdown-renderer"
import { Button } from "@/components/ui/button"
import type {
  PaperAgentResultCandidate,
  PaperAgentResultDecision,
  PaperReaderBacklink,
} from "@/lib/paper-reader-client"

export function PaperAgentResultCard({
  candidate,
  backlink,
  busy,
  onDecision,
}: {
  candidate: PaperAgentResultCandidate
  backlink: PaperReaderBacklink
  busy: boolean
  onDecision: (action: PaperAgentResultDecision["action"]) => void
}) {
  const headingId = useId()
  const reviewHelpId = useId()
  const decisionStatusRef = useRef<HTMLDivElement | null>(null)
  const previousDecision = useRef(candidate.decision?.action)

  useEffect(() => {
    const currentDecision = candidate.decision?.action
    if (!previousDecision.current && currentDecision) decisionStatusRef.current?.focus()
    previousDecision.current = currentDecision
  }, [candidate.decision?.action])

  const decision = candidate.decision
  const decisionMessage = decision?.action === "accept"
    ? "Accepted into Galaxy as reviewed knowledge."
    : decision?.action === "reject"
      ? "Rejected. No Galaxy document was admitted."
      : "Review the cited result before admitting it to Galaxy."

  return (
    <article
      aria-labelledby={headingId}
      aria-busy={busy}
      className="rounded-xl border border-[color:var(--research-line)] bg-[#fffef9] p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="research-smallcaps text-[10px]">Agent result · review required</p>
          <h3 id={headingId} className="research-display mt-1 font-semibold">{backlink.label}</h3>
        </div>
        {busy ? <Loader2 aria-label="Saving review decision" className="h-4 w-4 shrink-0 animate-spin" /> : null}
      </div>

      <div className="research-prose mt-3 text-sm">
        <MarkdownRenderer content={candidate.summary} images="omit" />
      </div>

      <section className="mt-4" aria-label="Result citations">
        <h4 className="research-smallcaps text-[10px]">Citations</h4>
        {candidate.evidenceRefs.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {candidate.evidenceRefs.map((reference) => (
              <li key={reference} className="rounded-lg bg-[hsl(var(--research-accent-soft))] px-2 py-1.5">
                <code className="block break-all text-[10px]">{reference}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="research-muted mt-1 text-xs">No additional evidence references were returned.</p>
        )}
      </section>

      <details className="mt-4 border-t border-[color:var(--research-line)] pt-3 text-xs">
        <summary className="research-smallcaps min-h-11 cursor-pointer py-2">Source and task provenance</summary>
        <dl className="research-muted mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt>Task</dt><dd className="break-all font-mono">{candidate.taskId}</dd>
          <dt>Created</dt><dd>version {backlink.createdTaskVersion ?? "unknown"}</dd>
          <dt>Result</dt><dd>version {candidate.taskVersion}</dd>
          <dt>Event</dt><dd className="break-all font-mono">{candidate.eventId}</dd>
          {candidate.runId ? <><dt>Run</dt><dd className="break-all font-mono">{candidate.runId}</dd></> : null}
          <dt>Digest</dt><dd className="break-all font-mono">{candidate.resultHash}</dd>
          {candidate.actorRef ? <><dt>Agent</dt><dd className="break-all font-mono">{candidate.actorRef}</dd></> : null}
          {candidate.occurredAt ? <><dt>Completed</dt><dd>{candidate.occurredAt}</dd></> : null}
          {decision?.acceptedDocumentRef ? <><dt>Galaxy document</dt><dd className="break-all font-mono">{decision.acceptedDocumentRef}</dd></> : null}
        </dl>
      </details>

      <p id={reviewHelpId} className="research-muted mt-4 text-xs">
        HAM completion is candidate work. Only Accept admits these exact reviewed bytes into Galaxy.
      </p>
      {!decision ? (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={busy}
            aria-describedby={reviewHelpId}
            onClick={() => onDecision("reject")}
          >
            <X aria-hidden="true" className="mr-2 h-4 w-4" />Reject result
          </Button>
          <Button
            type="button"
            className="min-h-11"
            disabled={busy}
            aria-describedby={reviewHelpId}
            onClick={() => onDecision("accept")}
          >
            <Check aria-hidden="true" className="mr-2 h-4 w-4" />Accept into Galaxy
          </Button>
        </div>
      ) : null}
      <div
        ref={decisionStatusRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="research-muted mt-3 rounded-lg border border-[color:var(--research-line)] px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--research-accent))]"
      >
        {decisionMessage}
      </div>
    </article>
  )
}
