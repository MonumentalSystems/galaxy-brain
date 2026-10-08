"use client"

import { GitBranch, Plus, Sparkles, Trash2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { parseGalaxyObjectReference, serializeGalaxyObjectReference } from "@/lib/galaxy-object-reference.js"
import {
  requestTaskPlanProposal,
  TaskPlanProposalClientError,
  type TaskPlanProposalBranchIntent,
  type TaskPlanProposalIntent,
} from "@/lib/task-plan-proposal-client.js"
import type {
  TaskPlanNodeKind,
  TaskPlanProposal,
  TaskPlanProposalAction,
  TaskPlanRecord,
} from "@/lib/types/task-plans"

type TaskPlanProposalProducerProps = {
  record: TaskPlanRecord | null
  disabledReason?: string
  onProposal: (proposal: TaskPlanProposal) => void
}

type BranchDraft = {
  id: string
  kind: TaskPlanProposalBranchIntent["kind"]
  title: string
  goal: string
  instruction: string
  inputRefs: string
}

const ACTIONS: ReadonlyArray<{ value: TaskPlanProposalAction; label: string }> = [
  { value: "branch", label: "Branch" },
  { value: "join", label: "Join" },
  { value: "compare", label: "Compare" },
  { value: "challenge", label: "Challenge" },
  { value: "synthesize", label: "Synthesize" },
]

const BRANCH_KINDS: ReadonlyArray<Exclude<TaskPlanNodeKind, "context" | "branch" | "join">> = [
  "research", "transform", "compare", "challenge", "synthesize", "checkpoint", "artifact",
]

function createBranchDraft(index: number): BranchDraft {
  return {
    id: crypto.randomUUID(),
    kind: index === 0 ? "research" : "challenge",
    title: "",
    goal: "",
    instruction: "",
    inputRefs: "",
  }
}

function boundedText(value: string, maximum: number, label: string): string
function boundedText(value: string, maximum: number, label: string, optional: true): string | null
function boundedText(value: string, maximum: number, label: string, optional = false): string | null {
  const normalized = value.trim()
  if (optional && !normalized) return null
  if (!normalized || Array.from(normalized).length > maximum || /[\ud800-\udfff]/u.test(normalized)) {
    throw new Error(`${label} must contain 1-${maximum.toLocaleString()} characters.`)
  }
  return normalized
}

function pinnedReferences(value: string, label: string) {
  const lines = value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean)
  if (lines.length > 64) throw new Error(`${label} may contain at most 64 references.`)
  const result = lines.map((item, index) => {
    const parsed = parseGalaxyObjectReference(item)
    if (!parsed || parsed.format !== "canonical" || parsed.selector.mode !== "pinned") {
      throw new Error(`${label} line ${index + 1} must be a canonical pinned Galaxy reference.`)
    }
    const serialized = serializeGalaxyObjectReference(parsed)
    if (Array.from(serialized).length > 500) {
      throw new Error(`${label} line ${index + 1} exceeds the 500-character proposal limit.`)
    }
    return serialized
  })
  if (new Set(result).size !== result.length) throw new Error(`${label} contains a duplicate reference.`)
  return result
}

function sourceRequirement(action: TaskPlanProposalAction) {
  if (action === "branch") return "Select exactly one saved source job."
  if (["join", "compare", "synthesize"].includes(action)) return "Select at least two saved source jobs."
  return "Select at least one saved source job."
}

export function TaskPlanProposalProducer({
  record,
  disabledReason,
  onProposal,
}: TaskPlanProposalProducerProps) {
  const [expanded, setExpanded] = useState(false)
  const [action, setAction] = useState<TaskPlanProposalAction>("branch")
  const [sourceJobIds, setSourceJobIds] = useState<string[]>([])
  const [title, setTitle] = useState("")
  const [goal, setGoal] = useState("")
  const [instruction, setInstruction] = useState("")
  const [inputRefs, setInputRefs] = useState("")
  const [branches, setBranches] = useState<BranchDraft[]>(() => [createBranchDraft(0), createBranchDraft(1)])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const [status, setStatus] = useState("")
  const controllerRef = useRef<AbortController | null>(null)
  const requestRef = useRef(0)
  const baselineKey = record
    ? [
        record.id,
        record.current_version,
        record.current_content_hash,
        record.ham_task_id,
        record.current_spec.task.version ?? "unpinned",
      ].join(":")
    : "unavailable"
  const baselineKeyRef = useRef(baselineKey)
  const jobs = useMemo(() => record?.current_spec.nodes ?? [], [record])

  useEffect(() => {
    baselineKeyRef.current = baselineKey
    requestRef.current += 1
    controllerRef.current?.abort()
    controllerRef.current = null
    setSubmitting(false)
    setError("")
    setStatus("")
    setSourceJobIds([])
  }, [baselineKey])

  useEffect(() => () => {
    requestRef.current += 1
    controllerRef.current?.abort()
  }, [])

  function toggleSource(jobId: string, checked: boolean) {
    setError("")
    setSourceJobIds((current) => {
      if (!checked) return current.filter((item) => item !== jobId)
      if (current.includes(jobId)) return current
      if (current.length >= 16) {
        setError("A proposal may use at most 16 source jobs.")
        return current
      }
      return [...current, jobId]
    })
  }

  function updateBranch(id: string, patch: Partial<BranchDraft>) {
    setBranches((current) => current.map((branch) => branch.id === id ? { ...branch, ...patch } : branch))
  }

  function buildIntent(): TaskPlanProposalIntent {
    if (sourceJobIds.length < 1 || sourceJobIds.length > 16) throw new Error(sourceRequirement(action))
    if (action === "branch" && sourceJobIds.length !== 1) throw new Error(sourceRequirement(action))
    if (["join", "compare", "synthesize"].includes(action) && sourceJobIds.length < 2) {
      throw new Error(sourceRequirement(action))
    }
    const normalizedInputRefs = pinnedReferences(inputRefs, "Proposal inputs")
    const normalizedBranches: TaskPlanProposalBranchIntent[] = action === "branch"
      ? branches.map((branch, index) => ({
          kind: branch.kind,
          title: boundedText(branch.title, 200, `Branch ${index + 1} title`),
          goal: boundedText(branch.goal, 4_000, `Branch ${index + 1} goal`),
          instruction: boundedText(branch.instruction, 20_000, `Branch ${index + 1} instruction`, true),
          inputRefs: pinnedReferences(branch.inputRefs, `Branch ${index + 1} inputs`),
        }))
      : []
    if (action === "branch" && (normalizedBranches.length < 2 || normalizedBranches.length > 8)) {
      throw new Error("Branch proposals require two to eight branch jobs.")
    }
    const distinctReferences = new Set([
      ...normalizedInputRefs,
      ...normalizedBranches.flatMap((branch) => branch.inputRefs),
    ])
    if (distinctReferences.size > 64) throw new Error("A proposal may contain at most 64 distinct input references.")
    return {
      action,
      sourceJobIds,
      title: boundedText(title, 200, "Proposal title"),
      goal: boundedText(goal, 4_000, "Proposal goal"),
      instruction: boundedText(instruction, 20_000, "Proposal instruction", true),
      inputRefs: normalizedInputRefs,
      branches: normalizedBranches,
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!record || disabledReason || submitting) return
    setError("")
    setStatus("")
    let intent: TaskPlanProposalIntent
    try {
      intent = buildIntent()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "The proposal form is invalid.")
      return
    }

    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const request = ++requestRef.current
    const submittedBaseline = baselineKey
    const submittedRecord = record
    setSubmitting(true)
    setStatus("Producing a bounded candidate from the saved plan revision.")
    try {
      const proposal = await requestTaskPlanProposal(submittedRecord, intent, { signal: controller.signal })
      if (requestRef.current !== request || baselineKeyRef.current !== submittedBaseline) return
      onProposal(proposal)
      setStatus("Candidate received. Verifying its exact base and cryptographic hash before display.")
    } catch (nextError) {
      if (controller.signal.aborted || requestRef.current !== request) return
      setError(nextError instanceof TaskPlanProposalClientError
        ? nextError.message
        : "The task-plan proposal could not be produced.")
      setStatus("")
    } finally {
      if (requestRef.current === request) {
        controllerRef.current = null
        setSubmitting(false)
      }
    }
  }

  return (
    <section className="task-constructor__panel border-b px-4 py-4 sm:px-6" aria-labelledby="task-plan-producer-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="task-constructor__core research-kicker">Pure proposal producer</p>
          <h3 id="task-plan-producer-title" className="research-display mt-1 text-lg font-semibold">Propose saved-plan structure</h3>
          <p className="task-constructor__muted mt-1 max-w-3xl text-sm">
            Produce an additive candidate for review. This does not save a revision, mutate HAM, claim work, or start a run.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          aria-expanded={expanded}
          aria-controls="task-plan-producer-form"
          onClick={() => setExpanded((current) => !current)}
          className="task-constructor__control min-h-11"
        >
          <Sparkles aria-hidden="true" /> {expanded ? "Hide proposal form" : "Propose structure"}
        </Button>
      </div>

      {expanded ? (
        <form id="task-plan-producer-form" className="task-constructor__card mt-4 space-y-4 rounded-xl border p-4" onSubmit={submit}>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="task-plan-proposal-action">Action</Label>
              <select
                id="task-plan-proposal-action"
                value={action}
                disabled={submitting || Boolean(disabledReason)}
                onChange={(event) => { setAction(event.target.value as TaskPlanProposalAction); setError("") }}
                className="task-constructor__control min-h-11 rounded-md border px-3 text-sm"
              >
                {ACTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="task-plan-proposal-title">Candidate job title</Label>
              <Input id="task-plan-proposal-title" value={title} maxLength={200} disabled={submitting || Boolean(disabledReason)} onChange={(event) => setTitle(event.target.value)} />
            </div>
          </div>

          <fieldset className="grid gap-2" disabled={submitting || Boolean(disabledReason)}>
            <legend className="text-sm font-medium">Saved source jobs</legend>
            <p className="task-constructor__muted text-xs">{sourceRequirement(action)} Sources are bound to revision {record?.current_version ?? "—"}.</p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {jobs.map((job, index) => (
                <label key={job.id} className="task-constructor__card flex min-h-11 items-start gap-2 rounded-lg border px-3 py-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={sourceJobIds.includes(job.id)} onChange={(event) => toggleSource(job.id, event.target.checked)} />
                  <span>{index + 1}. {job.title} <span className="task-constructor__muted text-xs">({job.kind})</span></span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="task-plan-proposal-goal">Candidate goal</Label>
              <Textarea id="task-plan-proposal-goal" value={goal} maxLength={4_000} disabled={submitting || Boolean(disabledReason)} onChange={(event) => setGoal(event.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="task-plan-proposal-instruction">Instruction (optional)</Label>
              <Textarea id="task-plan-proposal-instruction" value={instruction} maxLength={20_000} disabled={submitting || Boolean(disabledReason)} onChange={(event) => setInstruction(event.target.value)} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="task-plan-proposal-inputs">Pinned input references (optional, one per line)</Label>
            <Textarea id="task-plan-proposal-inputs" value={inputRefs} disabled={submitting || Boolean(disabledReason)} onChange={(event) => setInputRefs(event.target.value)} className="font-mono text-xs" />
          </div>

          {action === "branch" ? (
            <fieldset className="space-y-3" disabled={submitting || Boolean(disabledReason)}>
              <legend className="text-sm font-medium">Branch jobs</legend>
              {branches.map((branch, index) => (
                <div key={branch.id} className="task-constructor__card space-y-3 rounded-xl border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold">Branch {index + 1}</p>
                    <Button type="button" variant="ghost" size="sm" disabled={branches.length <= 2} onClick={() => setBranches((current) => current.filter((item) => item.id !== branch.id))}>
                      <Trash2 aria-hidden="true" /> Remove
                    </Button>
                  </div>
                  <div className="grid gap-3 lg:grid-cols-3">
                    <div className="grid gap-1.5">
                      <Label htmlFor={`task-plan-branch-kind-${branch.id}`}>Kind</Label>
                      <select id={`task-plan-branch-kind-${branch.id}`} value={branch.kind} onChange={(event) => updateBranch(branch.id, { kind: event.target.value as BranchDraft["kind"] })} className="task-constructor__control min-h-11 rounded-md border px-3 text-sm">
                        {BRANCH_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                      </select>
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor={`task-plan-branch-title-${branch.id}`}>Title</Label>
                      <Input id={`task-plan-branch-title-${branch.id}`} value={branch.title} maxLength={200} onChange={(event) => updateBranch(branch.id, { title: event.target.value })} />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor={`task-plan-branch-goal-${branch.id}`}>Goal</Label>
                      <Input id={`task-plan-branch-goal-${branch.id}`} value={branch.goal} maxLength={4_000} onChange={(event) => updateBranch(branch.id, { goal: event.target.value })} />
                    </div>
                  </div>
                  <div className="grid gap-3 lg:grid-cols-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor={`task-plan-branch-instruction-${branch.id}`}>Instruction (optional)</Label>
                      <Textarea id={`task-plan-branch-instruction-${branch.id}`} value={branch.instruction} maxLength={20_000} onChange={(event) => updateBranch(branch.id, { instruction: event.target.value })} />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor={`task-plan-branch-inputs-${branch.id}`}>Pinned inputs (one per line)</Label>
                      <Textarea id={`task-plan-branch-inputs-${branch.id}`} value={branch.inputRefs} onChange={(event) => updateBranch(branch.id, { inputRefs: event.target.value })} className="font-mono text-xs" />
                    </div>
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" disabled={branches.length >= 8} onClick={() => setBranches((current) => [...current, createBranchDraft(current.length)])}>
                <Plus aria-hidden="true" /> Add branch job
              </Button>
            </fieldset>
          ) : null}

          {disabledReason ? <p role="status" className="task-constructor__muted text-sm font-medium">{disabledReason}</p> : null}
          {error ? <p role="alert" className="text-sm font-medium text-destructive">{error}</p> : null}
          {status ? <p role="status" aria-live="polite" className="task-constructor__core text-sm">{status}</p> : null}
          <Button type="submit" disabled={submitting || Boolean(disabledReason)} className="task-constructor__primary min-h-11">
            <GitBranch aria-hidden="true" /> {submitting ? "Producing…" : "Produce review candidate"}
          </Button>
        </form>
      ) : null}
    </section>
  )
}
