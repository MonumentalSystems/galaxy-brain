"use client"

import { useState } from "react"

import {
  ProofMissionSelector,
  type ProofMissionSelection,
} from "@/components/graph/proof-mission-selector"
import type { ProofDag } from "@/lib/proof-task-graph"

type ProofMissionPreviewClientProps = {
  proofDag: ProofDag
}

export function ProofMissionPreviewClient({ proofDag }: ProofMissionPreviewClientProps) {
  const [confirmedSelection, setConfirmedSelection] = useState<ProofMissionSelection | null>(null)

  return (
    <div className="grid gap-6">
      <ProofMissionSelector
        proofDag={proofDag}
        onSelection={setConfirmedSelection}
        onDraftInvalidated={() => setConfirmedSelection(null)}
      />

      <section
        aria-labelledby="confirmed-mission-heading"
        aria-live="polite"
        className="rounded-[1.4rem] border border-[#315a42]/25 bg-[#fffdf6] p-5 text-[#1e2a24] shadow-[0_16px_45px_rgba(30,42,36,0.09)] sm:p-6"
      >
        <p className="font-mono text-[0.68rem] uppercase tracking-[0.2em] text-[#6d6b52]">Confirmed intent · local preview only</p>
        <h2 id="confirmed-mission-heading" className="mt-1 font-serif text-2xl text-[#183b2b]">Mission selection</h2>

        {confirmedSelection ? (
          <dl className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-[#315a42]/20 bg-[#edf1dd]/70 p-3">
              <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-[#617067]">Mission ID</dt>
              <dd className="mt-1 break-words font-mono text-sm text-[#183b2b]">{confirmedSelection.missionId}</dd>
            </div>
            <div className="rounded-xl border border-[#315a42]/20 bg-[#edf1dd]/70 p-3">
              <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-[#617067]">Main theorem</dt>
              <dd className="mt-1 break-words font-mono text-sm text-[#183b2b]">{confirmedSelection.mainTheoremId}</dd>
            </div>
            <div className="rounded-xl border border-[#315a42]/20 bg-[#edf1dd]/70 p-3 sm:col-span-2">
              <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-[#617067]">
                Curated milestones · {confirmedSelection.milestoneIds.length}
              </dt>
              <dd className="mt-2">
                {confirmedSelection.milestoneIds.length > 0 ? (
                  <ul className="flex flex-wrap gap-2">
                    {confirmedSelection.milestoneIds.map((milestoneId) => (
                      <li key={milestoneId} className="rounded-full border border-[#315a42]/25 bg-[#f7edcf] px-3 py-1 font-mono text-xs text-[#43544a]">
                        {milestoneId}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-sm text-[#617067]">No curated milestones selected.</span>
                )}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="mt-3 text-sm leading-6 text-[#617067]">
            Complete the selector above and choose “Use mission selection” to inspect the immutable intent object here.
          </p>
        )}

        <p className="mt-4 border-t border-[#315a42]/15 pt-4 text-xs leading-5 text-[#617067]">
          Read-only confirmation: no network request, registration, workspace, claim, run, frontier activation, or verification state is created.
        </p>
      </section>
    </div>
  )
}
