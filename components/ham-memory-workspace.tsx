"use client"

import { useEffect, useId, useMemo, useRef, useState } from "react"
import { ArrowRight, BookOpen, Link2, Loader2, Plus, RefreshCw, Split, Trash2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { galaxyBrainAPI } from "@/lib/galaxy-brain-api"
import { createGalaxyObjectReference, parseGalaxyObjectReference } from "@/lib/galaxy-object-reference.js"
import { buildHamMemorySupersedeChanges, describeHamMemoryEdge } from "@/lib/ham-memory-contract.js"
import type { HamMemoryDetail, HamMemoryEdge, HamMemoryRelation } from "@/lib/ham-memory-client"
import type { GalaxyPaper } from "@/lib/types/papers"

export const HAM_AUTHORITATIVE_RELATIONS = [
  "cites",
  "contradicts",
  "verifies",
  "depends-on",
] as const

export type HamAuthoritativeRelation = HamMemoryRelation

const GALAXY_LINK_RELATIONS = [
  "related",
  "cites",
  "part_of",
  "derived_from",
  "context_for",
  "formalized_by",
  "defined_in",
  "implements",
  "depends_on",
  "documents",
  "corresponds_to",
] as const

type GalaxyLinkRelation = (typeof GALAXY_LINK_RELATIONS)[number]

const HAM_CONTROL_CLASS = "min-h-11 border-slate-300 bg-[#fffdf7] text-slate-950 caret-slate-950 placeholder:text-slate-500 focus-visible:border-amber-400 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#09111f]"
const HAM_SELECT_CLASS = `${HAM_CONTROL_CLASS} rounded-md px-3 text-sm`

function pinnedPaperReference(paper: GalaxyPaper) {
  return createGalaxyObjectReference("paper", paper.id, {
    mode: "pinned",
    revision: `sha256:${paper.metadata_hash}`,
  })
}

export interface HamMemoryDraft {
  title: string
  content: string
  organization: HamMemoryDetail["organization"]
}

interface HamMemoryWorkspaceProps {
  memory: HamMemoryDetail
  edges: HamMemoryEdge[]
  truncated?: boolean
  busy?: boolean
  error?: string
  readOnlyReason?: string
  onClose: () => void
  onReload: () => void | Promise<void>
  onSupersede: (draft: HamMemoryDraft) => void | Promise<void>
  onAddEdge: (input: { relation: HamAuthoritativeRelation; targetMemoryId: string }) => void | Promise<void>
  onRemoveEdge: (edge: HamMemoryEdge) => void | Promise<void>
  onGalaxyLinkCreated?: () => void | Promise<void>
  returnFocus?: HTMLElement | null
}

function cloneDraft(memory: HamMemoryDetail): HamMemoryDraft {
  return {
    title: memory.title ?? "",
    content: memory.content,
    organization: {
      ...memory.organization,
      scopes: [...memory.organization.scopes],
    },
  }
}

async function createAuthoredGalaxyLink(fromRef: string, toRef: string, relation: GalaxyLinkRelation) {
  const from = parseGalaxyObjectReference(fromRef)
  const to = parseGalaxyObjectReference(toRef)
  if (from?.format !== "canonical" || to?.format !== "canonical") {
    throw new Error("Both endpoints must be canonical Galaxy object references.")
  }
  if (fromRef === toRef) throw new Error("A link must connect two different objects.")
  const response = await fetch("/api/eln/object-links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from_ref: fromRef,
      to_ref: toRef,
      relation,
      basis: "authored",
      provenance: { source: "manual", source_system: "galaxy-ham-workspace" },
      idempotency_key: `ham-workspace-${crypto.randomUUID()}`,
    }),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: unknown } | null
    const detail = typeof payload?.detail === "string" ? payload.detail : ""
    throw new Error(response.status === 401
      ? "Sign in again before linking Galaxy evidence."
      : response.status === 403
        ? "You are not authorized to link this Galaxy evidence."
        : response.status === 404
          ? "Galaxy could not read one of these objects. Reload the memory and choose the evidence again."
          : response.status === 422 && detail.startsWith("Durable ")
            ? `${detail}. Choose an exact saved revision instead of a latest reference.`
            : response.status === 503
              ? "Galaxy cannot reach the evidence authorization service right now. Try again shortly."
              : "Galaxy could not create the authored evidence link. Try again.")
  }
}

export function HamMemoryWorkspace({
  memory,
  edges,
  truncated = false,
  busy = false,
  error = "",
  readOnlyReason,
  onClose,
  onReload,
  onSupersede,
  onAddEdge,
  onRemoveEdge,
  onGalaxyLinkCreated,
  returnFocus = null,
}: HamMemoryWorkspaceProps) {
  const titleId = useId()
  const editFormId = `${titleId}-edit-form`
  const saveHelpId = `${titleId}-save-help`
  const panelRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [draft, setDraft] = useState(() => cloneDraft(memory))
  const [edgeRelation, setEdgeRelation] = useState<HamAuthoritativeRelation>("cites")
  const [targetMemoryId, setTargetMemoryId] = useState("")
  const [galaxyRelation, setGalaxyRelation] = useState<GalaxyLinkRelation>("related")
  const [galaxyTarget, setGalaxyTarget] = useState("")
  const [papers, setPapers] = useState<GalaxyPaper[]>([])
  const [linkState, setLinkState] = useState<"idle" | "saving" | "saved">("idle")
  const [localError, setLocalError] = useState("")
  const stateReadOnlyReason = memory.state === "active"
    ? undefined
    : `This ${memory.state} HAM memory is historical and read-only. Its exact content and relations remain visible, but only an active memory can be superseded or have HAM-native relations changed.`
  const mutationReadOnlyReason = readOnlyReason ?? stateReadOnlyReason
  const mutationsDisabled = busy || Boolean(mutationReadOnlyReason)
  const readOnlyStatusId = `${titleId}-read-only-status`

  useEffect(() => {
    setDraft(cloneDraft(memory))
  }, [memory])

  useEffect(() => {
    const previousFocus = returnFocus?.isConnected
      ? returnFocus
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    closeRef.current?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose()
        return
      }
      if (event.key !== "Tab" || !panelRef.current) return
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.offsetParent !== null)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener("keydown", keydown)
    return () => {
      window.removeEventListener("keydown", keydown)
      previousFocus?.focus()
    }
  }, [onClose, returnFocus])

  useEffect(() => {
    let active = true
    void galaxyBrainAPI.getPapers(100).then((items) => {
      if (active) setPapers(items)
    }).catch(() => undefined)
    return () => { active = false }
  }, [])

  // HAM exposes the operational head by stable memory ID. Historical reads
  // are not available yet, so retain the canonical follow-latest selector and
  // display the independently returned memory version alongside it.
  const memoryRef = useMemo(() => createGalaxyObjectReference("ham.memory", memory.id), [memory.id])
  const scopes = draft.organization.scopes.join(", ")
  const draftChange = useMemo(() => {
    try {
      return {
        changed: Object.keys(buildHamMemorySupersedeChanges(memory, draft)).length > 0,
        error: "",
      }
    } catch (cause) {
      return {
        changed: false,
        error: cause instanceof Error ? cause.message : "The replacement memory is invalid.",
      }
    }
  }, [draft, memory])

  const setOrganization = (field: "project" | "repo" | "task" | "sequence", value: string) => {
    setDraft((current) => ({
      ...current,
      organization: { ...current.organization, [field]: value },
    }))
  }

  const addEdge = async () => {
    if (mutationReadOnlyReason) return
    const target = targetMemoryId.trim()
    if (!/^[1-9][0-9]{0,18}$/.test(target) || target === memory.id) {
      setLocalError("Choose a different numeric HAM memory identifier.")
      return
    }
    setLocalError("")
    await onAddEdge({ relation: edgeRelation, targetMemoryId: target })
    setTargetMemoryId("")
  }

  const submitDraft = async () => {
    if (mutationReadOnlyReason) return
    if (draftChange.error) {
      setLocalError(draftChange.error)
      return
    }
    if (!draftChange.changed) {
      setLocalError("Change the memory or its organization before creating a replacement.")
      return
    }
    setLocalError("")
    await onSupersede(draft)
  }

  const linkGalaxyObject = async () => {
    const target = galaxyTarget.trim()
    const parsedTarget = parseGalaxyObjectReference(target)
    if (parsedTarget?.format !== "canonical") {
      setLocalError("Enter or select a canonical gb:object:v1 reference.")
      return
    }
    if (parsedTarget.kind === "paper" && parsedTarget.selector.mode !== "pinned") {
      setLocalError("Paper evidence must identify an exact immutable revision. Choose a saved paper below instead of entering a latest reference.")
      return
    }
    setLocalError("")
    setLinkState("saving")
    try {
      await createAuthoredGalaxyLink(memoryRef, target, galaxyRelation)
      setLinkState("saved")
      await onGalaxyLinkCreated?.()
    } catch (cause) {
      setLinkState("idle")
      setLocalError(cause instanceof Error ? cause.message : "Galaxy link could not be created.")
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-stretch justify-end bg-black/55" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-white/10 bg-[#09111f] text-slate-100 shadow-2xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-white/10 p-5 pb-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[.22em] text-amber-300">Canonical HAM memory</p>
            <h2 id={titleId} className="mt-1 truncate text-xl font-semibold">{memory.title || `Memory ${memory.id}`}</h2>
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-400">
              <span>#{memory.id}</span><span>version {memory.version}</span><span>{memory.state}</span>
              {memory.tier !== undefined ? <span>tier {memory.tier}</span> : null}
            </div>
            <code className="mt-2 block max-w-full truncate text-[11px] text-slate-500" title={memoryRef}>{memoryRef}</code>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button type="button" size="icon" variant="ghost" className="size-11" disabled={busy} onClick={() => void onReload()} aria-label="Reload canonical HAM memory"><RefreshCw className="h-4 w-4" /></Button>
            <Button ref={closeRef} type="button" size="icon" variant="ghost" className="size-11" onClick={onClose} aria-label="Close HAM memory workspace"><X className="h-4 w-4" /></Button>
          </div>
        </header>

        {(error || localError) && <p className="mx-5 mt-4 shrink-0 rounded-xl border border-red-400/40 bg-red-950/70 p-3 text-sm text-red-100" role="alert">{localError || error}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {mutationReadOnlyReason ? <p id={readOnlyStatusId} className="mt-4 rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100" role="status">{mutationReadOnlyReason}</p> : null}

        <form id={editFormId} className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); void submitDraft() }}>
          <div className="space-y-2"><Label htmlFor={`${titleId}-memory-title`}>Title</Label><Input id={`${titleId}-memory-title`} className={HAM_CONTROL_CLASS} value={draft.title} maxLength={1000} readOnly={Boolean(mutationReadOnlyReason)} aria-describedby={mutationReadOnlyReason ? readOnlyStatusId : undefined} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} /></div>
          <div className="space-y-2"><Label htmlFor={`${titleId}-memory-content`}>Exact content</Label><Textarea id={`${titleId}-memory-content`} className={HAM_CONTROL_CLASS} value={draft.content} rows={9} maxLength={200_000} readOnly={Boolean(mutationReadOnlyReason)} aria-describedby={mutationReadOnlyReason ? readOnlyStatusId : undefined} onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))} /></div>

          <fieldset className="rounded-2xl border border-white/10 p-4" disabled={Boolean(mutationReadOnlyReason)} aria-describedby={mutationReadOnlyReason ? readOnlyStatusId : undefined}>
            <legend className="px-2 text-sm font-semibold">HAM-native organization</legend>
            <p className="mb-3 text-xs text-slate-400">These fields stay on the HAM memory; they are not Galaxy permissions or local folders.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {(["project", "repo", "task", "sequence"] as const).map((field) => (
                <div key={field} className="space-y-1.5"><Label htmlFor={`${titleId}-${field}`}>{field[0].toUpperCase() + field.slice(1)}</Label><Input id={`${titleId}-${field}`} className={HAM_CONTROL_CLASS} value={draft.organization[field] ?? ""} onChange={(event) => setOrganization(field, event.target.value)} /></div>
              ))}
            </div>
            <div className="mt-3 space-y-1.5"><Label htmlFor={`${titleId}-scopes`}>Scopes</Label><Input id={`${titleId}-scopes`} className={HAM_CONTROL_CLASS} value={scopes} placeholder="project:research, repo:owner/name" onChange={(event) => setDraft((current) => ({ ...current, organization: { ...current.organization, scopes: event.target.value.split(",").map((value) => value.trim()).filter(Boolean).slice(0, 32) } }))} /></div>
            {draftChange.error ? <p className="mt-2 text-xs text-red-200" role="alert">{draftChange.error}</p> : null}
          </fieldset>
        </form>

        <section className="mt-7 border-t border-white/10 pt-5" aria-labelledby={`${titleId}-relations`}>
          <h3 id={`${titleId}-relations`} className="text-base font-semibold">Authoritative HAM relations</h3>
          <p className="mt-1 text-xs text-slate-400">Direction below is the canonical stored direction. Reverse labels are presentation only.</p>
          <ul className="mt-3 space-y-2">
            {edges.map((edge) => {
              const label = describeHamMemoryEdge(edge, memory.id)
              return <li key={edge.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[.03] p-3"><div className="min-w-0 flex-1"><p className="text-sm font-medium">{label.label} <code className="text-amber-200">#{label.other}</code></p>{edge.adjacent?.title ? <p className="mt-1 truncate text-xs text-slate-300">{edge.adjacent.title}</p> : null}<p className="mt-1 text-[11px] uppercase tracking-wide text-slate-500">{label.tone} · stored {edge.relation} · v{edge.version}</p></div>{edge.kind === "typed" ? <Button type="button" size="icon" variant="ghost" disabled={mutationsDisabled} onClick={() => void onRemoveEdge(edge)} aria-label={`Remove ${edge.relation} relation to memory ${label.other}`} aria-describedby={mutationReadOnlyReason ? readOnlyStatusId : undefined}><Trash2 className="h-4 w-4" /></Button> : null}</li>
            })}
            {edges.length === 0 ? <li className="rounded-xl border border-dashed border-white/10 p-4 text-sm text-slate-500">No authoritative relations are visible for this memory.</li> : null}
          </ul>
          {truncated ? <p className="mt-2 rounded-lg border border-amber-300/20 bg-amber-300/10 p-2 text-xs text-amber-100" role="status">This is a bounded neighborhood. More HAM relations exist; refine the memory selection before treating this view as exhaustive.</p> : null}
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <select aria-label="HAM relation type" value={edgeRelation} disabled={Boolean(mutationReadOnlyReason)} aria-describedby={mutationReadOnlyReason ? readOnlyStatusId : undefined} onChange={(event) => setEdgeRelation(event.target.value as HamAuthoritativeRelation)} className={HAM_SELECT_CLASS}>{HAM_AUTHORITATIVE_RELATIONS.map((relation) => <option key={relation} value={relation}>{relation.replaceAll("_", " ")}</option>)}</select>
            <Input className={HAM_CONTROL_CLASS} aria-label="Target HAM memory ID" inputMode="numeric" placeholder="Target memory ID" value={targetMemoryId} readOnly={Boolean(mutationReadOnlyReason)} aria-describedby={mutationReadOnlyReason ? readOnlyStatusId : undefined} onChange={(event) => setTargetMemoryId(event.target.value)} />
            <Button type="button" className="min-h-11" disabled={mutationsDisabled} onClick={() => void addEdge()} aria-describedby={mutationReadOnlyReason ? readOnlyStatusId : undefined}><Plus className="mr-2 h-4 w-4" />Add</Button>
          </div>
        </section>

        <section className="mt-7 border-t border-white/10 pt-5" aria-labelledby={`${titleId}-galaxy-links`}>
          <h3 id={`${titleId}-galaxy-links`} className="flex items-center gap-2 text-base font-semibold"><Link2 className="h-4 w-4" />Link Galaxy evidence</h3>
          <p className="mt-1 text-xs text-slate-400">Creates an authored Galaxy assertion. It does not alter or impersonate a HAM-native edge.</p>
          {papers.length > 0 ? <div className="mt-3 space-y-1.5"><Label htmlFor={`${titleId}-paper`}><BookOpen className="mr-1 inline h-3.5 w-3.5" />Saved paper revision</Label><select id={`${titleId}-paper`} value="" onChange={(event) => { if (event.target.value) { setGalaxyTarget(event.target.value); setLinkState("idle"); setLocalError("") } }} className={`w-full ${HAM_SELECT_CLASS}`}><option value="">Choose an exact saved Galaxy paper…</option>{papers.map((paper) => <option key={paper.id} value={pinnedPaperReference(paper)}>{paper.title}</option>)}</select></div> : null}
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
            <select aria-label="Galaxy authored relation" value={galaxyRelation} onChange={(event) => setGalaxyRelation(event.target.value as GalaxyLinkRelation)} className={HAM_SELECT_CLASS}>{GALAXY_LINK_RELATIONS.map((relation) => <option key={relation} value={relation}>{relation.replaceAll("_", " ")}</option>)}</select>
            <Input className={HAM_CONTROL_CLASS} aria-label="Canonical Galaxy object reference" placeholder="gb:object:v1:paper:…:pinned:sha256%3A…" value={galaxyTarget} onChange={(event) => { setGalaxyTarget(event.target.value); setLinkState("idle") }} />
            <Button type="button" className="min-h-11" disabled={linkState === "saving" || !galaxyTarget.trim()} onClick={() => void linkGalaxyObject()}>{linkState === "saving" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <ArrowRight className="mr-2 h-4 w-4" aria-hidden="true" />}{linkState === "saved" ? "Linked" : "Link"}</Button>
          </div>
        </section>
        </div>

        <footer className="shrink-0 border-t border-white/10 bg-[#0d1729] px-5 py-4 shadow-[0_-12px_30px_rgba(0,0,0,0.22)]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p id={saveHelpId} className="max-w-md text-xs text-slate-300">
              {draftChange.changed
                ? `Ready to create a replacement for version ${memory.version}. The current version stays in history.`
                : "Edit the title, content, or organization to create a new immutable HAM version."}
            </p>
            <Button form={editFormId} type="submit" className="min-h-11 shrink-0" disabled={mutationsDisabled || !draft.content.trim() || !draftChange.changed} aria-describedby={saveHelpId}>
              <Split className="mr-2 h-4 w-4" aria-hidden="true" />Save as new version
            </Button>
          </div>
        </footer>
      </section>
    </div>
  )
}
