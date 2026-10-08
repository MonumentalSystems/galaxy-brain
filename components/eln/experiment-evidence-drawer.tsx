"use client"

import { type FormEvent, useState } from "react"
import { Activity, Braces, Database, ExternalLink, FolderArchive, Link2, Plus, Upload, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { ExperimentAttachmentList } from "@/components/eln/experiment-attachment-card"
import { appendEvidenceReference, buildWandbRunUrl, parseManualMetricDraft } from "@/lib/eln-experiment-state"
import type { AddMetricInput, ExperimentAttachmentRef, ExperimentMetric, ExperimentObservationRef } from "@/lib/galaxy-brain-api"
import type { PendingExperimentObservation } from "@/lib/eln-experiment-recovery.js"

const DURABLE_ATTACHMENT_ACCEPT = [
  "application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif", "text/*",
  ".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif",
  ".md", ".markdown", ".mdx", ".txt", ".text",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".java", ".c", ".h",
  ".cc", ".cpp", ".cxx", ".hpp", ".cs", ".go", ".rs", ".rb", ".php", ".swift",
  ".kt", ".kts", ".scala", ".sh", ".bash", ".zsh", ".fish", ".ps1", ".sql",
  ".css", ".scss", ".sass", ".less", ".html", ".htm", ".json", ".jsonl", ".ipynb",
  ".xml", ".csv", ".yaml", ".yml", ".toml",
].join(",")

export interface ExperimentEvidenceDrawerProps {
  configText: string
  configError: string | null
  onConfigTextChange: (value: string) => void
  wandbProject: string
  onWandbProjectChange: (value: string) => void
  wandbRunId: string
  onWandbRunIdChange: (value: string) => void
  localRunPath: string
  onLocalRunPathChange: (value: string) => void
  legacyLinkedPapers: string[]
  attachments: ExperimentAttachmentRef[]
  attachmentRetryTitle: string | null
  onAttachDocument: (file: File | null) => Promise<boolean>
  observations: ExperimentObservationRef[]
  pendingObservation: PendingExperimentObservation | null
  observationBusy: boolean
  observationError: string | null
  observationStatus: string
  observationAuthorityScopeKey: string
  onAddObservation: (body: string | undefined, authorityScopeKey: string) => Promise<boolean>
  onDiscardPendingObservation: () => void
  linkedExperiments: string[]
  onLinkedExperimentsChange: (value: string[]) => void
  metrics: ExperimentMetric[]
  onAddMetric: (metric: AddMetricInput) => Promise<boolean>
  hamNodeId?: string
}

export function ExperimentEvidenceDrawer({
  configText,
  configError,
  onConfigTextChange,
  wandbProject,
  onWandbProjectChange,
  wandbRunId,
  onWandbRunIdChange,
  localRunPath,
  onLocalRunPathChange,
  legacyLinkedPapers,
  attachments,
  attachmentRetryTitle,
  onAttachDocument,
  observations,
  pendingObservation,
  observationBusy,
  observationError,
  observationStatus,
  observationAuthorityScopeKey,
  onAddObservation,
  onDiscardPendingObservation,
  linkedExperiments,
  onLinkedExperimentsChange,
  metrics,
  onAddMetric,
  hamNodeId,
}: ExperimentEvidenceDrawerProps) {
  const evidenceCount = observations.length + attachments.length + legacyLinkedPapers.length + linkedExperiments.length + metrics.length
  const wandbUrl = buildWandbRunUrl(wandbProject, wandbRunId)

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button type="button" size="sm" variant="outline" className="research-control min-h-9 gap-1.5">
          <Database className="h-4 w-4" aria-hidden="true" />
          Evidence
          {evidenceCount > 0 && <Badge variant="secondary" className="ml-1 tabular-nums">{evidenceCount}</Badge>}
        </Button>
      </SheetTrigger>
      <SheetContent className="research-workbench max-h-[100dvh] w-[min(94vw,42rem)] overflow-y-auto border-[var(--research-line)] bg-[hsl(var(--research-panel))] text-foreground sm:max-w-2xl">
        <SheetHeader className="pr-12">
          <SheetTitle className="research-display text-2xl text-foreground">Evidence &amp; run context</SheetTitle>
          <SheetDescription className="text-muted-foreground">
            Attach reproducibility details and references to this experiment. Record edits save with the notebook entry; metrics append immediately.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-7">
          <section aria-labelledby="evidence-config-title" className="space-y-3">
            <div className="flex items-center gap-2">
              <Braces className="h-4 w-4 text-primary" aria-hidden="true" />
              <h3 id="evidence-config-title" className="text-sm font-semibold">Configuration snapshot</h3>
            </div>
            <div className="space-y-2">
              <Label htmlFor="evidence-config-json">JSON object</Label>
              <Textarea
                id="evidence-config-json"
                value={configText}
                onChange={(event) => onConfigTextChange(event.target.value)}
                placeholder={'{\n  "seed": 42,\n  "learning_rate": 0.001\n}'}
                className="research-control min-h-40 resize-y bg-[hsl(var(--research-paper))] font-mono text-xs"
                maxLength={50000}
                aria-invalid={Boolean(configError)}
                aria-describedby={configError ? "evidence-config-error" : "evidence-config-help"}
              />
              {configError ? (
                <p id="evidence-config-error" role="alert" className="text-sm text-destructive">{configError}</p>
              ) : (
                <p id="evidence-config-help" className="text-xs text-muted-foreground">Valid JSON objects become a portable configuration artifact.</p>
              )}
            </div>
          </section>

          <Separator className="bg-border" />

          <fieldset className="space-y-3">
            <legend className="flex items-center gap-2 text-sm font-semibold">
              <Activity className="h-4 w-4 text-primary" aria-hidden="true" />
              Run provenance
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="evidence-wandb-project">W&amp;B project</Label>
                <Input id="evidence-wandb-project" value={wandbProject} onChange={(event) => onWandbProjectChange(event.target.value)} maxLength={300} placeholder="team/project" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="evidence-wandb-run">W&amp;B run ID</Label>
                <Input id="evidence-wandb-run" value={wandbRunId} onChange={(event) => onWandbRunIdChange(event.target.value)} maxLength={300} placeholder="run-id" />
              </div>
            </div>
            {wandbUrl && (
              <a className="inline-flex min-h-11 items-center gap-2 text-sm text-primary underline decoration-primary/40 underline-offset-4" href={wandbUrl} target="_blank" rel="noreferrer">
                Open W&amp;B run <ExternalLink className="h-4 w-4" aria-hidden="true" />
              </a>
            )}
            <div className="space-y-2">
              <Label htmlFor="evidence-local-path">Local run path</Label>
              <Input id="evidence-local-path" value={localRunPath} onChange={(event) => onLocalRunPathChange(event.target.value)} maxLength={2000} placeholder="C:\\research\\runs\\experiment-42" />
              <p className="text-xs text-muted-foreground">Stored as provenance only; Galaxy Brain does not read this path from the browser.</p>
            </div>
          </fieldset>

          <Separator className="bg-border" />

          <ObservationEditor
            key={observationAuthorityScopeKey}
            authorityScopeKey={observationAuthorityScopeKey}
            observations={observations}
            pending={pendingObservation}
            busy={observationBusy}
            error={observationError}
            status={observationStatus}
            onAdd={onAddObservation}
            onDiscard={onDiscardPendingObservation}
          />

          <Separator className="bg-border" />

          <DurableAttachmentEditor
            attachments={attachments}
            retryTitle={attachmentRetryTitle}
            onAttach={onAttachDocument}
          />

          <section aria-labelledby="legacy-paper-references" className="space-y-3">
            <div>
              <h3 id="legacy-paper-references" className="flex items-center gap-2 text-sm font-semibold">
                <Link2 className="h-4 w-4 text-primary" aria-hidden="true" />
                Legacy references
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">Historical links are read-only and are not durable document attachments.</p>
            </div>
            {legacyLinkedPapers.length === 0 ? (
              <p className="rounded-lg border border-dashed border-[var(--research-line)] p-3 text-center text-xs text-muted-foreground">No legacy references.</p>
            ) : (
              <ul className="space-y-2">{legacyLinkedPapers.map((value) => (
                <li key={value} className="truncate rounded-lg border border-[var(--research-line)] bg-[hsl(var(--research-paper)/0.7)] px-3 py-2 text-sm text-foreground" title={value}>{value}</li>
              ))}</ul>
            )}
          </section>

          <EvidenceListEditor
            id="experiment-reference"
            title="Related experiments"
            description="Attach another ELN experiment ID to form a branch or comparison set."
            values={linkedExperiments}
            onChange={onLinkedExperimentsChange}
          />

          <Separator className="bg-border" />

          <ManualMetricForm metrics={metrics} onAddMetric={onAddMetric} />

          {hamNodeId && (
            <div className="rounded-lg border border-[hsl(var(--research-warm)/0.45)] bg-[hsl(var(--research-warm)/0.12)] p-3 text-xs leading-5 text-[hsl(var(--field-warm-strong))]">
              Linked HAM task: <code>{hamNodeId}</code>. This surface saves the ELN record only; HAM publishing is not configured here.
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ObservationEditor({
  authorityScopeKey,
  observations,
  pending,
  busy,
  error,
  status,
  onAdd,
  onDiscard,
}: {
  authorityScopeKey: string
  observations: ExperimentObservationRef[]
  pending: PendingExperimentObservation | null
  busy: boolean
  error: string | null
  status: string
  onAdd: (body: string | undefined, authorityScopeKey: string) => Promise<boolean>
  onDiscard: () => void
}) {
  const [body, setBody] = useState("")
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (await onAdd(pending ? undefined : body, authorityScopeKey)) setBody("")
  }
  return (
    <section aria-labelledby="experiment-observations-title" className="space-y-3">
      <div>
        <h3 id="experiment-observations-title" className="text-sm font-semibold">Observations</h3>
        <p className="mt-1 text-xs text-muted-foreground">Append immutable, timestamped notes. Saved observations cannot be edited or deleted.</p>
      </div>
      <form className="space-y-2" onSubmit={submit} aria-busy={busy}>
        <Label htmlFor="experiment-observation-body">Observation</Label>
        <Textarea
          id="experiment-observation-body"
          value={pending ? pending.request.body : body}
          onChange={(event) => setBody(event.target.value)}
          readOnly={Boolean(pending)}
          maxLength={4000}
          className="research-control min-h-24 resize-y"
          aria-describedby={error ? "experiment-observation-error" : undefined}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="outline" disabled={busy || (!pending && !body.trim())}>
            {pending ? "Retry pending observation" : "Record observation"}
          </Button>
          {pending && <Button type="button" variant="ghost" disabled={busy} onClick={onDiscard}>Discard pending retry</Button>}
        </div>
        {error && <p id="experiment-observation-error" role="alert" className="text-sm text-destructive">{error}</p>}
        <p className="sr-only" role="status" aria-live="polite">{status}</p>
      </form>
      {observations.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--research-line)] p-3 text-center text-xs text-muted-foreground">No observations yet.</p>
      ) : (
        <ol className="space-y-2">
          {observations.map((observation) => (
            <li key={observation.id} className="rounded-lg border border-[var(--research-line)] bg-[hsl(var(--research-paper)/0.7)] p-3">
              <p className="whitespace-pre-wrap text-sm text-foreground">{observation.body}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                <time dateTime={observation.observedAt}>
                  {new Date(observation.observedAt).toLocaleString(undefined, { timeZone: "UTC" })} UTC
                </time>
                {" · immutable v"}{observation.version}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function DurableAttachmentEditor({
  attachments,
  retryTitle,
  onAttach,
}: {
  attachments: ExperimentAttachmentRef[]
  retryTitle: string | null
  onAttach: (file: File | null) => Promise<boolean>
}) {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      if (await onAttach(retryTitle ? null : file)) setFile(null)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-labelledby="durable-attachments-title" className="space-y-3">
      <div>
        <h3 id="durable-attachments-title" className="flex items-center gap-2 text-sm font-semibold">
          <Upload className="h-4 w-4 text-primary" aria-hidden="true" />
          Durable attachments
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">Imports exact original bytes, then binds the pinned document revision to this experiment.</p>
      </div>
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={submit}>
        <Input
          type="file"
          accept={DURABLE_ATTACHMENT_ACCEPT}
          disabled={busy || Boolean(retryTitle)}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          aria-label="Choose durable experiment attachment"
        />
        <Button type="submit" variant="outline" className="min-h-10 shrink-0" disabled={busy || (!file && !retryTitle)}>
          {retryTitle ? "Retry binding" : "Import & attach"}
        </Button>
      </form>
      {retryTitle && <p role="alert" className="text-xs text-[hsl(var(--field-warm-strong))]">{retryTitle} is already imported. Retry binds it without uploading again.</p>}
      <ExperimentAttachmentList attachments={attachments} />
    </section>
  )
}

function EvidenceListEditor({
  id,
  title,
  description,
  values,
  onChange,
}: {
  id: string
  title: string
  description: string
  values: string[]
  onChange: (value: string[]) => void
}) {
  const [draft, setDraft] = useState("")

  const addReference = (event: FormEvent) => {
    event.preventDefault()
    const next = appendEvidenceReference(values, draft)
    if (next === values) return
    onChange(next)
    setDraft("")
  }

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3">
      <div>
        <h3 id={`${id}-title`} className="flex items-center gap-2 text-sm font-semibold">
          <Link2 className="h-4 w-4 text-primary" aria-hidden="true" />
          {title}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={addReference}>
        <Label htmlFor={id} className="sr-only">{title}</Label>
        <Input id={id} value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={2048} placeholder="Paste an ID or URL" />
        <Button type="submit" variant="outline" className="min-h-10 shrink-0" disabled={!draft.trim()}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add
        </Button>
      </form>
      {values.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--research-line)] p-3 text-center text-xs text-muted-foreground">Nothing attached yet.</p>
      ) : (
        <ul className="space-y-2">
          {values.map((value) => (
            <li key={value} className="flex min-w-0 items-center gap-2 rounded-lg border border-[var(--research-line)] bg-[hsl(var(--research-paper)/0.7)] px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={value}>{value}</span>
              <Button type="button" size="icon" variant="ghost" className="h-9 w-9 shrink-0" onClick={() => onChange(values.filter((item) => item !== value))} aria-label={`Remove ${value}`}>
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ManualMetricForm({ metrics, onAddMetric }: { metrics: ExperimentMetric[]; onAddMetric: (metric: AddMetricInput) => Promise<boolean> }) {
  const [name, setName] = useState("")
  const [value, setValue] = useState("")
  const [step, setStep] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const parsed = parseManualMetricDraft({ name, value, step })
    if (!parsed.metric) {
      setError(parsed.error)
      return
    }

    setError(null)
    setSubmitting(true)
    try {
      if (await onAddMetric(parsed.metric)) {
        setName("")
        setValue("")
        setStep("")
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section aria-labelledby="manual-metric-title" className="space-y-3">
      <div>
        <h3 id="manual-metric-title" className="flex items-center gap-2 text-sm font-semibold">
          <FolderArchive className="h-4 w-4 text-primary" aria-hidden="true" />
          Manual metric
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">Append a measured value without replacing the existing metric history.</p>
      </div>
      <form className="grid gap-3 sm:grid-cols-[1fr_8rem_7rem_auto] sm:items-end" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <Label htmlFor="manual-metric-name">Name</Label>
          <Input id="manual-metric-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={200} placeholder="accuracy" disabled={submitting} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="manual-metric-value">Value</Label>
          <Input id="manual-metric-value" inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} placeholder="0.98" disabled={submitting} aria-describedby={error ? "manual-metric-error" : undefined} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="manual-metric-step">Step</Label>
          <Input id="manual-metric-step" inputMode="numeric" value={step} onChange={(event) => setStep(event.target.value)} placeholder="optional" disabled={submitting} />
        </div>
        <Button type="submit" variant="outline" className="min-h-10" disabled={submitting}>Add</Button>
      </form>
      {error && <p id="manual-metric-error" role="alert" className="text-sm text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground" role="status" aria-live="polite">{metrics.length} metric {metrics.length === 1 ? "point" : "points"} stored.</p>
    </section>
  )
}
