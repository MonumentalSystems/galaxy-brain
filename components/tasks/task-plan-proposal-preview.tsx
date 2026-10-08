"use client"

import { GitBranch, Network, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { TaskPlanProposal, TaskPlanProposalOperation } from "@/lib/types/task-plans"

type TaskPlanProposalPreviewProps = {
  proposal: TaskPlanProposal
  verificationState: "verifying" | "verified" | "invalid"
  applyDisabledReason?: string
  onDismiss: () => void
  onApply: () => void
}

function operationLabel(operation: TaskPlanProposalOperation) {
  if (operation.op === "node.add") return `${operation.node.kind}: ${operation.node.title}`
  return `${operation.edge.kind}: ${operation.edge.source} → ${operation.edge.target}`
}

export function TaskPlanProposalPreview({
  proposal,
  verificationState,
  applyDisabledReason,
  onDismiss,
  onApply,
}: TaskPlanProposalPreviewProps) {
  const verified = verificationState === "verified"
  const titleId = verified ? `task-plan-proposal-${proposal.proposalHash.slice(-12)}` : "task-plan-proposal-pending"
  const addedJobs = verified ? proposal.operations.filter((operation) => operation.op === "node.add").length : 0
  const addedConnections = verified ? proposal.operations.length - addedJobs : 0

  return (
    <section
      aria-labelledby={titleId}
      className="task-constructor__candidate border-b px-4 py-4 sm:px-6"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="task-constructor__muted research-kicker">Task-local candidate{verified ? ` · ${proposal.action}` : ""}</p>
          <h3 id={titleId} className="research-display mt-1 text-xl font-semibold">Review proposed plan additions</h3>
          {verified ? <p className="mt-1 max-w-3xl text-sm leading-6">{proposal.summary}</p> : null}
          <p role="status" aria-live="polite" aria-atomic="true" className="task-constructor__muted mt-2 text-xs leading-5">
            {verificationState === "verifying"
              ? "Verifying this candidate before displaying or applying its contents. You can dismiss it now."
              : verificationState === "invalid"
                ? "This candidate failed integrity verification and cannot be applied. Dismiss it to continue."
                : "Preview only: this candidate is not saved or executed, creates no HAM task, and asserts no Galaxy semantic relation."}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={onDismiss} className="task-constructor__control min-h-11">
            <X className="h-4 w-4" aria-hidden="true" /> Dismiss
          </Button>
          <Button
            type="button"
            onClick={onApply}
            disabled={Boolean(applyDisabledReason)}
            aria-describedby={applyDisabledReason ? `${titleId}-disabled` : undefined}
            className="task-constructor__primary min-h-11"
          >
            <GitBranch className="h-4 w-4" aria-hidden="true" /> Apply to local draft
          </Button>
        </div>
      </div>
      {verified ? (
        <>
          <div className="task-constructor__muted mt-3 flex flex-wrap gap-2 text-xs">
            <span className="task-constructor__chip rounded-full border px-2.5 py-1">base revision {proposal.base.taskPlanVersion}</span>
            <span className="task-constructor__chip rounded-full border px-2.5 py-1">{addedJobs} added job{addedJobs === 1 ? "" : "s"}</span>
            <span className="task-constructor__chip rounded-full border px-2.5 py-1">{addedConnections} added connection{addedConnections === 1 ? "" : "s"}</span>
          </div>
          <details className="task-constructor__card mt-3 rounded-xl border px-3 py-2">
            <summary className="min-h-8 cursor-pointer text-sm font-semibold">Inspect candidate operations</summary>
            <ol className="mt-2 space-y-1 text-xs">
              {proposal.operations.map((operation, index) => (
                <li key={operation.op === "node.add" ? operation.node.id : operation.edge.id} className="flex items-start gap-2">
                  <Network className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{index + 1}. {operationLabel(operation)}</span>
                </li>
              ))}
            </ol>
          </details>
        </>
      ) : null}
      {applyDisabledReason ? (
        <p id={`${titleId}-disabled`} role="status" aria-live="polite" className="task-constructor__muted mt-3 text-sm font-medium">
          {applyDisabledReason}
        </p>
      ) : null}
    </section>
  )
}
