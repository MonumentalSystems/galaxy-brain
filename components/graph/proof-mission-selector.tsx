"use client"

import { Compass, GitBranch, Milestone } from "lucide-react"
import { useEffect, useId, useMemo, useState, type FormEvent } from "react"

import { Button } from "@/components/ui/button"
import { PROOF_MISSION_COMPILER_LIMITS } from "@/lib/proof-mission-compiler.js"
import { cn } from "@/lib/utils"
import type { ProofDag, ProofDagNode } from "@/lib/proof-task-graph"

const PREREQUISITE_RELATION_TYPES = new Set(["DEPENDS_ON", "REDUCES_TO", "USES", "AUTHORED_PREREQUISITE"])
const PREVIEW_RENDER_LIMIT = 120
const GOAL_OPTION_LIMIT = 120
const MILESTONE_CONTROL_LIMIT = Math.min(120, PROOF_MISSION_COMPILER_LIMITS.milestones)
const MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u

export type ProofMissionSelection = Readonly<{
  schemaId: "galaxy.proof-mission-selection.v1"
  missionId: string
  mainTheoremId: string
  milestoneIds: readonly string[]
}>

export interface ProofMissionSelectorProps {
  /** One parsed, passive proof corpus. Mission compilation happens outside this component. */
  proofDag: ProofDag
  /** Fires only after the user explicitly confirms the current selection. */
  onSelection: (selection: ProofMissionSelection) => void
  /** Fires synchronously before a user edit makes a previously confirmed selection stale. */
  onDraftInvalidated?: () => void
  /** Reports edits that would be lost if the containing presenter closes. */
  onDiscardRiskChange?: (hasDiscardRisk: boolean) => void
  /** Server-acknowledged candidate selection. A submitted browser draft is not acknowledgement. */
  acknowledgedSelection?: Pick<ProofMissionSelection, "missionId" | "mainTheoremId" | "milestoneIds"> | null
  className?: string
}

type Preview = {
  closure: ProofDagNode[]
  frontier: ProofDagNode[]
}

function proofPreview(proofDag: ProofDag, mainTheoremId: string): Preview {
  if (!mainTheoremId) return { closure: [], frontier: [] }

  const nodesById = new Map(proofDag.nodes.map((node) => [node.nodeId, node]))
  const closureIds = new Set<string>()
  const pending = [mainTheoremId]

  while (pending.length > 0) {
    const nodeId = pending.pop()
    if (!nodeId || closureIds.has(nodeId)) continue
    const node = nodesById.get(nodeId)
    if (!node) continue
    closureIds.add(nodeId)
    pending.push(...node.prerequisiteNodeIds)
  }

  const closure = proofDag.nodes.filter((node) => closureIds.has(node.nodeId))
  const frontier = closure.filter((node) => (
    node.prerequisiteNodeIds.every((prerequisiteId) => !closureIds.has(prerequisiteId))
  ))
  return { closure, frontier }
}

function goalCandidates(proofDag: ProofDag) {
  const prerequisiteSources = new Set(
    proofDag.edges
      .filter((edge) => PREREQUISITE_RELATION_TYPES.has(edge.relationType))
      .map((edge) => edge.source),
  )
  const terminal = proofDag.nodes.filter((node) => !prerequisiteSources.has(node.nodeId))
  const suggested = terminal.filter((node) => node.targetKind === "theorem")
  const suggestedIds = new Set(suggested.map((node) => node.nodeId))
  return {
    suggested,
    other: terminal.filter((node) => !suggestedIds.has(node.nodeId)),
  }
}

function nodeLabel(node: ProofDagNode) {
  return node.title === node.nodeId ? node.title : `${node.title} — ${node.nodeId}`
}

function freezeSelection(missionId: string, mainTheoremId: string, milestoneIds: string[]): ProofMissionSelection {
  return Object.freeze({
    schemaId: "galaxy.proof-mission-selection.v1" as const,
    missionId,
    mainTheoremId,
    milestoneIds: Object.freeze([...milestoneIds]),
  })
}

function selectionKey(missionId: string, mainTheoremId: string, milestoneIds: readonly string[]) {
  return JSON.stringify([missionId.trim(), mainTheoremId, milestoneIds])
}

export function ProofMissionSelector({
  proofDag,
  onSelection,
  onDraftInvalidated,
  onDiscardRiskChange,
  acknowledgedSelection,
  className,
}: ProofMissionSelectorProps) {
  const fieldId = useId()
  const missionIdField = `${fieldId}-mission-id`
  const mainTheoremId = `${fieldId}-main-theorem`
  const mainTheoremFilterId = `${fieldId}-main-theorem-filter`
  const previewId = `${fieldId}-preview`
  const [missionId, setMissionId] = useState("")
  const [mainTheoremFilter, setMainTheoremFilter] = useState("")
  const [selectedMainTheoremId, setSelectedMainTheoremId] = useState("")
  const [selectedMilestoneIds, setSelectedMilestoneIds] = useState<string[]>([])
  const draftKey = selectionKey(missionId, selectedMainTheoremId, selectedMilestoneIds)
  const acknowledgedDraftKey = acknowledgedSelection
    ? selectionKey(
        acknowledgedSelection.missionId,
        acknowledgedSelection.mainTheoremId,
        acknowledgedSelection.milestoneIds,
      )
    : ""
  const hasDraftInput = Boolean(
    missionId.trim()
    || selectedMainTheoremId
    || selectedMilestoneIds.length,
  )
  const hasDiscardRisk = hasDraftInput && draftKey !== acknowledgedDraftKey

  useEffect(() => {
    onDiscardRiskChange?.(hasDiscardRisk)
  }, [hasDiscardRisk, onDiscardRiskChange])

  useEffect(() => () => onDiscardRiskChange?.(false), [onDiscardRiskChange])

  const isPassiveRepository = proofDag.graphKind === "repository-field"
  const goals = useMemo(() => goalCandidates(proofDag), [proofDag])
  const allGoalCandidates = useMemo(() => [...goals.suggested, ...goals.other], [goals])
  const normalizedGoalFilter = mainTheoremFilter.trim().toLowerCase()
  const matchingGoalCandidates = useMemo(() => {
    if (!normalizedGoalFilter) return allGoalCandidates
    return allGoalCandidates.filter((node) => (
      node.nodeId.toLowerCase().includes(normalizedGoalFilter)
      || node.title.toLowerCase().includes(normalizedGoalFilter)
    ))
  }, [allGoalCandidates, normalizedGoalFilter])
  const renderedGoalCandidates = useMemo(() => {
    const selected = allGoalCandidates.find((node) => node.nodeId === selectedMainTheoremId)
    const matchesWithoutSelected = matchingGoalCandidates.filter((node) => node.nodeId !== selectedMainTheoremId)
    const availableMatchSlots = selected ? GOAL_OPTION_LIMIT - 1 : GOAL_OPTION_LIMIT
    return selected
      ? [selected, ...matchesWithoutSelected.slice(0, availableMatchSlots)]
      : matchesWithoutSelected.slice(0, availableMatchSlots)
  }, [allGoalCandidates, matchingGoalCandidates, selectedMainTheoremId])
  const suggestedGoalIds = useMemo(() => new Set(goals.suggested.map((node) => node.nodeId)), [goals.suggested])
  const renderedSuggestedGoals = renderedGoalCandidates.filter((node) => suggestedGoalIds.has(node.nodeId))
  const renderedOtherGoals = renderedGoalCandidates.filter((node) => !suggestedGoalIds.has(node.nodeId))
  const matchingGoalIds = useMemo(() => new Set(matchingGoalCandidates.map((node) => node.nodeId)), [matchingGoalCandidates])
  const renderedMatchCount = renderedGoalCandidates.filter((node) => matchingGoalIds.has(node.nodeId)).length
  const omittedGoalMatchCount = matchingGoalCandidates.length - renderedMatchCount
  const selectedGoalDoesNotMatch = Boolean(
    selectedMainTheoremId && !matchingGoalIds.has(selectedMainTheoremId),
  )
  const preview = useMemo(
    () => proofPreview(proofDag, selectedMainTheoremId),
    [proofDag, selectedMainTheoremId],
  )
  const authoredMilestoneIds = useMemo(() => new Set(
    proofDag.edges
      .filter((edge) => edge.relationType === "MILESTONE_OF")
      .map((edge) => edge.source),
  ), [proofDag])
  const allMilestoneCandidates = useMemo(() => {
    return preview.closure
      .filter((node) => node.nodeId !== selectedMainTheoremId)
      .sort((left, right) => Number(authoredMilestoneIds.has(right.nodeId)) - Number(authoredMilestoneIds.has(left.nodeId)))
  }, [authoredMilestoneIds, preview.closure, selectedMainTheoremId])
  const milestoneCandidates = useMemo(
    () => allMilestoneCandidates.slice(0, MILESTONE_CONTROL_LIMIT),
    [allMilestoneCandidates],
  )
  const omittedMilestoneCandidateCount = allMilestoneCandidates.length - milestoneCandidates.length
  const closureExceedsCompilerLimit = preview.closure.length > PROOF_MISSION_COMPILER_LIMITS.targets

  useEffect(() => {
    setMissionId("")
    setMainTheoremFilter("")
    setSelectedMainTheoremId("")
    setSelectedMilestoneIds([])
  }, [proofDag.graphId, proofDag.contentSha256])

  useEffect(() => {
    const allowed = new Set(milestoneCandidates.map((node) => node.nodeId))
    setSelectedMilestoneIds((current) => current.filter((nodeId) => allowed.has(nodeId)))
  }, [milestoneCandidates])

  function toggleMilestone(nodeId: string) {
    onDraftInvalidated?.()
    setSelectedMilestoneIds((current) => (
      current.includes(nodeId)
        ? current.filter((id) => id !== nodeId)
        : [...current, nodeId]
    ))
  }

  function submitSelection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedMissionId = missionId.trim()
    if (
      !isPassiveRepository
      || !selectedMainTheoremId
      || !MISSION_ID.test(normalizedMissionId)
      || closureExceedsCompilerLimit
    ) return
    const allowedMilestones = new Set(milestoneCandidates.map((node) => node.nodeId))
    onSelection(freezeSelection(
      normalizedMissionId,
      selectedMainTheoremId,
      selectedMilestoneIds.filter((nodeId) => allowedMilestones.has(nodeId)),
    ))
  }

  return (
    <section
      aria-labelledby={`${fieldId}-heading`}
      className={cn(
        "graph-surface overflow-hidden rounded-[1.4rem] border",
        className,
      )}
    >
      <header className="graph-surface__header border-b px-5 py-4 sm:px-6">
        <div className="flex items-start gap-3">
          <span aria-hidden="true" className="graph-surface__card graph-surface__core grid size-11 shrink-0 place-items-center rounded-full border">
            <Compass className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="graph-surface__muted font-mono text-[0.68rem] uppercase tracking-[0.2em]">Mission aperture</p>
            <h2 id={`${fieldId}-heading`} className="font-serif text-2xl leading-tight">Choose one theorem to pursue</h2>
            <p className="graph-surface__muted mt-1 max-w-3xl break-words text-sm leading-6">
              Start from the passive {proofDag.title} corpus. This surface previews a bounded mission; it does not create a workspace, claims, runs, or verification state.
            </p>
          </div>
        </div>
      </header>

      {!isPassiveRepository ? (
        <p role="alert" className="graph-surface__danger m-5 rounded-xl border p-4 text-sm sm:m-6">
          Mission selection accepts a passive repository-field graph only. This graph is already marked {proofDag.graphKind || "with an unknown kind"}.
        </p>
      ) : (
        <form className="grid gap-6 p-5 sm:p-6" onSubmit={submitSelection}>
          <div className="grid gap-2">
            <label htmlFor={missionIdField} className="text-sm font-semibold">Mission ID</label>
            <input
              id={missionIdField}
              type="text"
              required
              maxLength={120}
              pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,119}"
              autoComplete="off"
              spellCheck={false}
              aria-describedby={`${fieldId}-mission-id-help`}
              className="graph-surface__control min-h-11 w-full rounded-xl border px-3 py-2 font-mono text-sm"
              value={missionId}
              onChange={(event) => {
                onDraftInvalidated?.()
                setMissionId(event.target.value)
              }}
              placeholder="winding-prototime-v1"
            />
            <p id={`${fieldId}-mission-id-help`} className="graph-surface__muted text-xs leading-5">
              A durable, explicit identifier: letters, numbers, period, underscore, colon, or hyphen; 120 characters maximum.
            </p>
          </div>

          <div className="grid gap-2">
            <label htmlFor={mainTheoremId} className="text-sm font-semibold">Main theorem</label>
            <label htmlFor={mainTheoremFilterId} className="graph-surface__muted text-xs font-medium">Filter terminal targets by title or ID</label>
            <input
              id={mainTheoremFilterId}
              type="search"
              autoComplete="off"
              aria-controls={mainTheoremId}
              aria-describedby={`${fieldId}-main-filter-status`}
              className="graph-surface__control min-h-11 w-full rounded-xl border px-3 py-2 text-sm"
              value={mainTheoremFilter}
              onChange={(event) => setMainTheoremFilter(event.target.value)}
              placeholder="Search all terminal theorem titles and IDs"
            />
            <p id={`${fieldId}-main-filter-status`} className="graph-surface__muted text-xs leading-5" role="status" aria-live="polite">
              {matchingGoalCandidates.length.toLocaleString()} of {allGoalCandidates.length.toLocaleString()} terminal targets match. Showing {renderedMatchCount.toLocaleString()} match{renderedMatchCount === 1 ? "" : "es"}{omittedGoalMatchCount > 0 ? `; ${omittedGoalMatchCount.toLocaleString()} matching targets are omitted from this bounded control` : ""}.
              {selectedGoalDoesNotMatch ? " The current selection remains available even though it does not match this filter." : ""}
            </p>
            <select
              id={mainTheoremId}
              required
              aria-describedby={`${fieldId}-main-help ${previewId}`}
              className="graph-surface__control min-h-11 w-full rounded-xl border px-3 py-2 text-sm"
              value={selectedMainTheoremId}
              onChange={(event) => {
                const nextMainTheoremId = event.target.value
                if (nextMainTheoremId === selectedMainTheoremId) return
                onDraftInvalidated?.()
                setSelectedMainTheoremId(nextMainTheoremId)
                setSelectedMilestoneIds([])
              }}
            >
              <option value="">Select one formal target…</option>
              {renderedSuggestedGoals.length > 0 ? (
                <optgroup label="Suggested terminal theorems">
                  {renderedSuggestedGoals.map((node) => <option key={node.nodeId} value={node.nodeId}>{nodeLabel(node)}</option>)}
                </optgroup>
              ) : null}
              {renderedOtherGoals.length > 0 ? (
                <optgroup label="Other formal targets">
                  {renderedOtherGoals.map((node) => <option key={node.nodeId} value={node.nodeId}>{nodeLabel(node)}</option>)}
                </optgroup>
              ) : null}
            </select>
            <p id={`${fieldId}-main-help`} className="graph-surface__muted text-xs leading-5">
              The mission compiler will derive this target&apos;s complete prerequisite closure from the immutable source graph. Structural roots are not proof-status claims.
            </p>
          </div>

          <fieldset className="graph-surface__card grid gap-3 rounded-2xl border p-4">
            <legend className="px-1 text-sm font-semibold">Curated milestones <span className="graph-surface__muted font-normal">(optional)</span></legend>
            {milestoneCandidates.length > 0 ? (
              <>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {milestoneCandidates.map((node) => {
                    const checkboxId = `${fieldId}-milestone-${node.nodeId}`
                    return (
                      <li key={node.nodeId}>
                        <label htmlFor={checkboxId} className="graph-surface__control flex min-h-11 min-w-0 cursor-pointer items-start gap-3 rounded-xl border px-3 py-2 text-sm">
                          <input
                            id={checkboxId}
                            type="checkbox"
                            className="mt-0.5 size-5 shrink-0 accent-[hsl(var(--field-core))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                            checked={selectedMilestoneIds.includes(node.nodeId)}
                            onChange={() => toggleMilestone(node.nodeId)}
                          />
                          <span className="min-w-0"><span className="block break-words font-medium">{node.title}</span><span className="graph-surface__muted block break-all font-mono text-[0.68rem]">{node.nodeId}{authoredMilestoneIds.has(node.nodeId) ? " · authored milestone" : ""}</span></span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
                {omittedMilestoneCandidateCount > 0 ? (
                  <p className="graph-surface__warning rounded-xl border p-3 text-xs leading-5" role="status">
                    Showing {milestoneCandidates.length.toLocaleString()} of {allMilestoneCandidates.length.toLocaleString()} eligible milestone targets. {omittedMilestoneCandidateCount.toLocaleString()} are omitted from these controls; the compiler still validates the complete prerequisite closure.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="graph-surface__muted text-sm leading-6">The selected theorem has no prerequisite targets to curate as milestones.</p>
            )}
          </fieldset>

          <section id={previewId} aria-labelledby={`${fieldId}-preview-heading`} className="graph-surface__panel rounded-2xl border p-4 sm:p-5">
            <div className="flex items-center gap-2">
              <GitBranch aria-hidden="true" className="size-4" />
              <h3 id={`${fieldId}-preview-heading`} className="font-serif text-lg">Read-only structure preview</h3>
            </div>
            {!selectedMainTheoremId ? (
              <p className="graph-surface__muted mt-2 text-sm">Select a main theorem to reveal its prerequisite closure and structural roots.</p>
            ) : (
              <div className="mt-3 grid gap-4 sm:grid-cols-2" aria-live="polite">
                <div className="min-w-0">
                  <p className="graph-surface__muted font-mono text-[0.68rem] uppercase tracking-[0.16em]">Prerequisite closure · {preview.closure.length}</p>
                  <ol className="mt-2 max-h-44 space-y-1 overflow-auto pr-1 text-sm">
                    {preview.closure.slice(0, PREVIEW_RENDER_LIMIT).map((node) => <li key={node.nodeId} className="graph-surface__card min-w-0 rounded-lg border px-2.5 py-1.5"><span className="block break-words font-medium">{node.title}</span></li>)}
                  </ol>
                  {preview.closure.length > PREVIEW_RENDER_LIMIT ? <p className="graph-surface__muted mt-2 text-xs">Showing the first {PREVIEW_RENDER_LIMIT} of {preview.closure.length} targets.</p> : null}
                </div>
                <div className="min-w-0">
                  <p className="graph-surface__warning inline-flex rounded-full border px-2 py-1 font-mono text-[0.68rem] uppercase tracking-[0.16em]">Structural roots · {preview.frontier.length}</p>
                  <ul className="mt-2 space-y-1 text-sm">
                    {preview.frontier.slice(0, PREVIEW_RENDER_LIMIT).map((node) => <li key={node.nodeId} className="graph-surface__warning min-w-0 rounded-lg border px-2.5 py-1.5"><span className="block break-words font-medium">{node.title}</span><span className="graph-surface__muted block text-xs">No predecessor inside this closure · not a proof or claim state</span></li>)}
                  </ul>
                  {preview.frontier.length > PREVIEW_RENDER_LIMIT ? <p className="graph-surface__muted mt-2 text-xs">Showing the first {PREVIEW_RENDER_LIMIT} of {preview.frontier.length} structural roots.</p> : null}
                </div>
              </div>
            )}
          </section>

          {closureExceedsCompilerLimit ? (
            <p role="alert" className="graph-surface__danger rounded-xl border p-4 text-sm leading-6">
              This prerequisite closure contains {preview.closure.length.toLocaleString()} targets, exceeding the compiler limit of {PROOF_MISSION_COMPILER_LIMITS.targets.toLocaleString()}. Choose a narrower theorem; this selection cannot be confirmed or compiled.
            </p>
          ) : null}

          <footer className="graph-surface__footer flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="graph-surface__muted flex items-center gap-2 text-xs leading-5"><Milestone aria-hidden="true" className="size-4 shrink-0" />Selection is intent only; activation is a separate, explicit step.</p>
            <Button type="submit" className="min-h-11 px-5" disabled={!selectedMainTheoremId || !MISSION_ID.test(missionId.trim()) || closureExceedsCompilerLimit}>
              Use mission selection
            </Button>
          </footer>
        </form>
      )}
    </section>
  )
}
