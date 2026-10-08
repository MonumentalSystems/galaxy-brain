"use client"

import { Check, LoaderCircle, RefreshCw, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { parseGalaxyObjectReference } from "@/lib/galaxy-object-reference"
import {
  decideRelationProposal,
  fetchRelationProposalReviews,
  RelationProposalReviewError,
  type RelationProposalReviewItem,
} from "@/lib/relation-proposal-review-client.js"

type PendingDecision = {
  proposalId: string
  decision: "accept" | "reject"
  reason: string
  idempotencyKey: string
}

function referenceLabel(reference: string) {
  const parsed = parseGalaxyObjectReference(reference)
  if (!parsed || parsed.format !== "canonical") return { label: reference, revision: "invalid" }
  const revision = parsed.selector.mode === "pinned" ? parsed.selector.revision : "latest"
  const shortRevision = revision.length > 28 ? `${revision.slice(0, 17)}…${revision.slice(-8)}` : revision
  return { label: `${parsed.kind} · ${parsed.id}`, revision: shortRevision }
}

export function RelationProposalReviewDialog({
  open,
  onOpenChange,
  onCommitted,
  returnFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCommitted?: () => void
  returnFocus?: HTMLElement | null
}) {
  const [items, setItems] = useState<readonly RelationProposalReviewItem[]>([])
  const [bounded, setBounded] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [pendingId, setPendingId] = useState<string | null>(null)
  const retry = useRef<PendingDecision | null>(null)

  const load = useCallback((signal?: AbortSignal, cursor: string | null = null, append = false) => {
    setLoading(true)
    setError("")
    return fetchRelationProposalReviews(signal, cursor)
      .then((page) => {
        setItems((current) => append
          ? [...new Map([...current, ...page.items].map((item) => [item.proposalId, item])).values()]
          : page.items)
        setBounded(page.bounded)
        setNextCursor(page.nextCursor)
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return
        setError(cause instanceof Error ? cause.message : "Relation review is unavailable.")
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setNotice("")
    void load(controller.signal)
    return () => controller.abort()
  }, [load, open])

  const decide = useCallback(async (
    proposal: RelationProposalReviewItem,
    decision: "accept" | "reject",
  ) => {
    const reason = (reasons[proposal.proposalId] || "").trim()
    if (!reason) {
      setError("Enter a brief reason before accepting or rejecting this proposal.")
      return
    }
    const previous = retry.current
    const operation = previous
      && previous.proposalId === proposal.proposalId
      && previous.decision === decision
      && previous.reason === reason
      ? previous
      : { proposalId: proposal.proposalId, decision, reason, idempotencyKey: crypto.randomUUID() }
    retry.current = operation
    setPendingId(proposal.proposalId)
    setError("")
    setNotice("")
    try {
      const receipt = await decideRelationProposal(
        proposal, decision, reason, operation.idempotencyKey,
      )
      retry.current = null
      setItems((current) => current.filter((item) => item.proposalId !== proposal.proposalId))
      setReasons((current) => {
        const next = { ...current }
        delete next[proposal.proposalId]
        return next
      })
      setNotice(receipt.decision === "accepted"
        ? "Proposal accepted as an authored relation. This does not verify either object."
        : "Proposal rejected. No active relation was created.")
      onCommitted?.()
    } catch (cause) {
      if (cause instanceof RelationProposalReviewError && cause.code === "stale_relation_proposal") {
        retry.current = null
        setItems((current) => current.filter((item) => item.proposalId !== proposal.proposalId))
        setNotice("This proposal was decided elsewhere. The pending queue has been refreshed.")
        void load()
        return
      }
      setError(cause instanceof Error ? cause.message : "Relation proposal could not be decided.")
    } finally {
      setPendingId(null)
    }
  }, [load, onCommitted, reasons])

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (pendingId && !nextOpen) return
      onOpenChange(nextOpen)
      if (!nextOpen) returnFocus?.focus()
    }}>
      <DialogContent
        closeDisabled={Boolean(pendingId)}
        className="max-h-[min(88vh,760px)] max-w-3xl overflow-hidden border-[#6d7a68]/40 bg-[#f9f6f1] p-0 text-[#1e2a24]"
      >
        <DialogHeader className="border-b border-[#6d7a68]/25 bg-[#eef1e7] px-6 py-5 pr-14">
          <p className="research-kicker">Human control plane</p>
          <DialogTitle className="research-display text-2xl">Review proposed relations</DialogTitle>
          <DialogDescription className="text-[#53665c]">
            Agents can suggest exact links. Only this human review can create an authored active relation.
            Acceptance never upgrades a claim, proof, or verification state.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto px-6 py-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <p className="text-sm text-[#53665c]">
              {loading ? "Loading pending proposals…" : `${items.length} pending proposal${items.length === 1 ? "" : "s"}`}
              {bounded ? " · more pending proposals available" : ""}
            </p>
            <Button type="button" size="sm" variant="outline" onClick={() => void load()} disabled={loading || Boolean(pendingId)}>
              {loading ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
              Refresh
            </Button>
          </div>

          {error ? <p className="mb-4 rounded-xl border border-[#b66238]/45 bg-[#fff3ea] px-4 py-3 text-sm text-[#7a3822]" role="alert">{error}</p> : null}
          {notice ? <p className="mb-4 rounded-xl border border-[#6d7a68]/40 bg-[#eef1e7] px-4 py-3 text-sm text-[#33473d]" role="status">{notice}</p> : null}

          {!loading && items.length === 0 && !error ? (
            <div className="rounded-2xl border border-dashed border-[#6d7a68]/45 bg-white/65 p-8 text-center">
              <p className="research-display text-xl">No pending relations</p>
              <p className="mt-2 text-sm text-[#607067]">Agent proposals will appear here after both exact endpoints remain readable to you.</p>
            </div>
          ) : null}

          <ul className="space-y-4">
            {items.map((proposal) => {
              const busy = pendingId === proposal.proposalId
              return (
                <li key={proposal.proposalId} className="rounded-2xl border border-[#6d7a68]/35 bg-white/80 p-4 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#4e5a8c]">{proposal.relation.replaceAll("_", " ")}</p>
                      <p className="mt-1 text-xs text-[#607067]">Proposed {new Date(proposal.createdAt).toLocaleString()}</p>
                    </div>
                    <span className="rounded-full border border-[#c79a4b]/45 bg-[#fff8e7] px-2.5 py-1 text-xs text-[#68552e]">agent proposal</span>
                  </div>
                  <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                    <div className="min-w-0 rounded-xl bg-[#eef1e7]/80 p-3">
                      <dt className="text-xs font-semibold text-[#607067]">From</dt>
                      <dd className="mt-1 min-w-0">
                        <span className="block truncate font-medium" title={proposal.fromRef}>{referenceLabel(proposal.fromRef).label}</span>
                        <code className="mt-1 block truncate text-[11px] text-[#607067]">{referenceLabel(proposal.fromRef).revision}</code>
                        <span className="sr-only">Exact reference {proposal.fromRef}</span>
                      </dd>
                    </div>
                    <div className="min-w-0 rounded-xl bg-[#eef1e7]/80 p-3">
                      <dt className="text-xs font-semibold text-[#607067]">To</dt>
                      <dd className="mt-1 min-w-0">
                        <span className="block truncate font-medium" title={proposal.toRef}>{referenceLabel(proposal.toRef).label}</span>
                        <code className="mt-1 block truncate text-[11px] text-[#607067]">{referenceLabel(proposal.toRef).revision}</code>
                        <span className="sr-only">Exact reference {proposal.toRef}</span>
                      </dd>
                    </div>
                  </dl>
                  <div className="mt-3 rounded-xl border-l-4 border-[#4e5a8c] bg-[#f5f3eb] px-4 py-3">
                    <p className="text-xs font-semibold text-[#607067]">Agent rationale</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{proposal.rationale}</p>
                  </div>
                  <label className="mt-4 block text-sm font-semibold" htmlFor={`proposal-reason-${proposal.proposalId}`}>
                    Human decision reason
                  </label>
                  <textarea
                    id={`proposal-reason-${proposal.proposalId}`}
                    value={reasons[proposal.proposalId] || ""}
                    maxLength={4096}
                    disabled={Boolean(pendingId)}
                    onChange={(event) => {
                      retry.current = null
                      setReasons((current) => ({ ...current, [proposal.proposalId]: event.target.value }))
                    }}
                    className="mt-2 min-h-20 w-full resize-y rounded-xl border border-[#6d7a68]/40 bg-[#fffdf7] px-3 py-2 text-sm outline-none focus-visible:ring-4 focus-visible:ring-[#4e5a8c]/35 disabled:opacity-60"
                    placeholder="Why should this relation become authored—or be rejected?"
                  />
                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    <Button type="button" variant="outline" disabled={Boolean(pendingId)} onClick={() => void decide(proposal, "reject")}>
                      {busy ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <X aria-hidden="true" />}
                      Reject
                    </Button>
                    <Button type="button" disabled={Boolean(pendingId) || !proposal.acceptEligible} onClick={() => void decide(proposal, "accept")}>
                      {busy ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Check aria-hidden="true" />}
                      Accept as authored link
                    </Button>
                  </div>
                  {!proposal.acceptEligible ? (
                    <p className="mt-2 text-right text-xs text-[#7a3822]">This legacy proposal is not pinned. It can be rejected, but cannot become an active link.</p>
                  ) : null}
                </li>
              )
            })}
          </ul>
          {nextCursor ? (
            <div className="mt-4 flex justify-center">
              <Button type="button" variant="outline" disabled={loading || Boolean(pendingId)} onClick={() => void load(undefined, nextCursor, true)}>
                {loading ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
                Load next bounded page
              </Button>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
