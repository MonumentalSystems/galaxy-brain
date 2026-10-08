"use client"

import { Download, FileJson, GitBranch } from "lucide-react"
import { useCallback, useRef, useState } from "react"

import { TaskConstructorDialog } from "@/components/tasks/task-constructor-dialog"
import type { DetachedTaskPlanDraft, TaskConstructorTask } from "@/components/tasks/task-constructor"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { safeLocalStorage } from "@/lib/browser-utils"
import {
  createLegacyFlowExportFromStorage,
  formatLegacyFlowOptionLabel,
  LEGACY_FLOW_EXPORT_FILE_NAME,
  LEGACY_FLOW_EXPORT_MAX_BYTES,
  parseLegacyFlowExport,
  type LegacyFlowExportBundle,
  type LegacyFlowExportDiagnostic,
} from "@/lib/legacy-flow-export"
import {
  migrateLegacyFlowToTaskPlan,
  type LegacyFlowMigrationResult,
} from "@/lib/legacy-flow-task-plan"

type PreviewState = {
  task: TaskConstructorTask
  draft: DetachedTaskPlanDraft
}

export type LegacyFlowPortabilityDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  returnFocus: HTMLElement | null
}

function focusReturnTarget(target: HTMLElement | null, dialog: HTMLElement | null) {
  if (
    !target?.isConnected
    || dialog?.contains(target)
    || target.matches(":disabled, [aria-disabled='true'], [inert], [inert] *")
  ) return
  target.focus({ preventScroll: true })
}

function triggerDownload(contents: string) {
  const objectUrl = URL.createObjectURL(new Blob([contents], { type: "application/json" }))
  const anchor = document.createElement("a")
  anchor.href = objectUrl
  anchor.download = LEGACY_FLOW_EXPORT_FILE_NAME
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(objectUrl)
}

function firstError(diagnostics: LegacyFlowExportDiagnostic[]) {
  return diagnostics.find((diagnostic) => diagnostic.level === "error")?.message || "The legacy flow bundle is invalid."
}

export function LegacyFlowPortabilityDialog({
  open,
  onOpenChange,
  returnFocus,
}: LegacyFlowPortabilityDialogProps) {
  const [bundle, setBundle] = useState<LegacyFlowExportBundle | null>(null)
  const [fileName, setFileName] = useState("")
  const [selectedFlowId, setSelectedFlowId] = useState("")
  const [taskId, setTaskId] = useState("")
  const [taskVersion, setTaskVersion] = useState("")
  const [importDiagnostics, setImportDiagnostics] = useState<LegacyFlowExportDiagnostic[]>([])
  const [migration, setMigration] = useState<LegacyFlowMigrationResult | null>(null)
  const [importError, setImportError] = useState("")
  const [exportStatus, setExportStatus] = useState("")
  const [reading, setReading] = useState(false)
  const [previewState, setPreviewState] = useState<PreviewState | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const readGenerationRef = useRef(0)

  const clearMigration = useCallback(() => {
    setMigration(null)
    setImportError("")
  }, [])

  const downloadLocalFlows = useCallback(() => {
    const result = createLegacyFlowExportFromStorage(safeLocalStorage())
    if (!result.bundle || !result.json) {
      setExportStatus("")
      setImportError(firstError(result.diagnostics))
      return
    }
    triggerDownload(result.json)
    const warningCount = result.diagnostics.filter((diagnostic) => diagnostic.level === "warning").length
    setImportError("")
    setExportStatus(
      `${result.bundle.flows.length} local flow${result.bundle.flows.length === 1 ? "" : "s"} downloaded in a bounded portable bundle${warningCount ? ` with ${warningCount} omission warning${warningCount === 1 ? "" : "s"}` : ""}. Browser storage was not changed.`,
    )
  }, [])

  const loadFile = useCallback(async (file: File | null) => {
    const generation = ++readGenerationRef.current
    setReading(false)
    setBundle(null)
    setFileName(file?.name || "")
    setSelectedFlowId("")
    setImportDiagnostics([])
    setMigration(null)
    setImportError("")
    setExportStatus("")
    if (!file) return
    if (file.size > LEGACY_FLOW_EXPORT_MAX_BYTES) {
      setImportError("Choose a gb.legacy-flow-export.v1 file no larger than 2 MiB.")
      if (fileInputRef.current) fileInputRef.current.value = ""
      return
    }
    setReading(true)
    try {
      const json = await file.text()
      if (generation !== readGenerationRef.current) return
      const result = parseLegacyFlowExport(json)
      setImportDiagnostics(result.diagnostics)
      if (!result.bundle) {
        setImportError(firstError(result.diagnostics))
        return
      }
      setBundle(result.bundle)
      setSelectedFlowId(result.bundle.flows[0]?.id || "")
    } catch {
      if (generation === readGenerationRef.current) {
        setImportError("Galaxy Brain could not read this local file. Choose the export again.")
      }
    } finally {
      if (generation === readGenerationRef.current) setReading(false)
    }
  }, [])

  const buildPreview = useCallback(() => {
    const flow = bundle?.flows.find((candidate) => candidate.id === selectedFlowId)
    if (!flow) {
      setMigration(null)
      setImportError("Select one imported flow before building a preview.")
      return
    }
    const normalizedTaskId = taskId.trim()
    const normalizedVersion = taskVersion.trim()
    const result = migrateLegacyFlowToTaskPlan(flow, {
      id: normalizedTaskId,
      ...(normalizedVersion ? { version: Number(normalizedVersion) } : {}),
    })
    setMigration(result)
    setImportError(result.plan ? "" : result.diagnostics.find((diagnostic) => diagnostic.level === "error")?.message || "The flow could not be converted.")
  }, [bundle, selectedFlowId, taskId, taskVersion])

  const openDetachedPreview = useCallback(() => {
    const flow = bundle?.flows.find((candidate) => candidate.id === selectedFlowId)
    if (!flow || !migration?.plan) return
    const version = taskVersion.trim() ? Number(taskVersion) : undefined
    const task: TaskConstructorTask = {
      id: taskId.trim(),
      title: flow.name,
      goal: migration.plan.goal,
      projectRef: "Legacy flow portability",
      ...(version ? { version } : {}),
    }
    setPreviewState({
      task,
      draft: {
        id: `legacy-flow:${flow.id}:${task.id}:${version || "latest"}`,
        title: flow.name,
        spec: migration.plan,
      },
    })
    onOpenChange(false)
    window.requestAnimationFrame(() => setPreviewOpen(true))
  }, [bundle, migration, onOpenChange, selectedFlowId, taskId, taskVersion])

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          ref={contentRef}
          className="max-h-[min(92dvh,900px)] overflow-y-auto sm:max-w-3xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            focusReturnTarget(returnFocus, contentRef.current)
          }}
        >
          <DialogHeader>
            <DialogTitle>Legacy flow portability</DialogTitle>
            <DialogDescription>
              Download the safe browser-local export or inspect one local <code>gb.legacy-flow-export.v1</code> file in a detached Task Constructor preview. Nothing is uploaded, executed, dispatched, persisted, or removed.
            </DialogDescription>
          </DialogHeader>

          <section className="space-y-3 rounded-xl border border-[#456c59]/25 bg-[#f8f5eb] p-4" aria-labelledby="legacy-flow-export-title">
            <div>
              <h3 id="legacy-flow-export-title" className="research-display text-lg font-semibold text-[#1e342a]">1. Preserve local flows</h3>
              <p className="mt-1 text-sm text-[#5c6a62]">Credentials, collaboration metadata, arbitrary node data, and logs stay excluded. Existing browser keys are never rewritten or cleared.</p>
            </div>
            <Button type="button" variant="outline" onClick={downloadLocalFlows}>
              <Download aria-hidden="true" /> Download bounded export
            </Button>
            {exportStatus ? <p role="status" aria-live="polite" className="text-sm text-[#315746]">{exportStatus}</p> : null}
          </section>

          <section className="space-y-4 rounded-xl border border-[#456c59]/25 bg-[#f8f5eb] p-4" aria-labelledby="legacy-flow-import-title">
            <div>
              <h3 id="legacy-flow-import-title" className="research-display text-lg font-semibold text-[#1e342a]">2. Inspect a local export</h3>
              <p className="mt-1 text-sm text-[#5c6a62]">The file remains in this browser tab and is validated before any flow can be selected.</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="legacy-flow-export-file">Legacy flow export file</Label>
              <Input
                ref={fileInputRef}
                id="legacy-flow-export-file"
                type="file"
                accept=".json,application/json"
                aria-describedby="legacy-flow-file-help"
                disabled={reading}
                onChange={(event) => { void loadFile(event.target.files?.[0] || null) }}
              />
              <p id="legacy-flow-file-help" className="text-xs text-[#5c6a62]">Maximum 2 MiB UTF-8 JSON. Only schema <code>gb.legacy-flow-export.v1</code> is accepted.</p>
              {reading ? <p role="status" aria-live="polite" className="text-sm text-[#315746]">Reading and validating the local file…</p> : null}
              {bundle ? <p role="status" aria-live="polite" className="text-sm text-[#315746]">Validated {fileName}: {bundle.flows.length} portable flow{bundle.flows.length === 1 ? "" : "s"}.</p> : null}
            </div>

            {bundle?.flows.length ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2 sm:col-span-2">
                  <Label htmlFor="legacy-flow-selection">Flow to inspect</Label>
                  <select
                    id="legacy-flow-selection"
                    className="min-h-11 rounded-md border border-[#456c59]/30 bg-[#fffdf7] px-3 text-sm text-[#1f3028] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#244e3c]"
                    value={selectedFlowId}
                    onChange={(event) => {
                      setSelectedFlowId(event.target.value)
                      clearMigration()
                    }}
                  >
                    {bundle.flows.map((flow) => (
                      <option key={flow.id} value={flow.id}>{formatLegacyFlowOptionLabel(flow)}</option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="legacy-flow-task-id">Existing HAM task ID</Label>
                  <Input
                    id="legacy-flow-task-id"
                    value={taskId}
                    maxLength={200}
                    aria-describedby="legacy-flow-task-help"
                    onChange={(event) => {
                      setTaskId(event.target.value)
                      clearMigration()
                    }}
                  />
                  <p id="legacy-flow-task-help" className="text-xs text-[#5c6a62]">Required. This only labels the detached preview; it does not create, load, or change a HAM task.</p>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="legacy-flow-task-version">Task version (optional)</Label>
                  <Input
                    id="legacy-flow-task-version"
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    value={taskVersion}
                    onChange={(event) => {
                      setTaskVersion(event.target.value)
                      clearMigration()
                    }}
                  />
                </div>
              </div>
            ) : null}

            {importDiagnostics.length ? (
              <ul aria-label="Import diagnostics" className="space-y-1 text-sm text-[#68491f]">
                {importDiagnostics.map((diagnostic, index) => (
                  <li key={`${diagnostic.code}-${diagnostic.flowId || diagnostic.nodeId || diagnostic.edgeId || index}`}>
                    Import {diagnostic.level}: {diagnostic.message}
                  </li>
                ))}
              </ul>
            ) : null}

            {migration ? (
              <div className="space-y-2 rounded-lg border border-[#456c59]/25 bg-[#fffdf7] p-3">
                <p role="status" aria-live="polite" className="text-sm font-medium text-[#315746]">
                  {migration.plan
                    ? `Preview ready: ${migration.plan.nodes.length} jobs and ${migration.plan.edges.length} edges. Review every warning before opening it.`
                    : "No preview was produced. Resolve every conversion error first."}
                </p>
                {migration.diagnostics.length ? (
                  <ul aria-label="Conversion diagnostics" className="space-y-1 text-sm">
                    {migration.diagnostics.map((diagnostic, index) => (
                      <li
                        key={`${diagnostic.code}-${diagnostic.nodeId || diagnostic.edgeId || index}`}
                        className={diagnostic.level === "error" ? "text-[#7f3e2d]" : "text-[#68491f]"}
                      >
                        {diagnostic.level === "error" ? "Error" : "Review"}: {diagnostic.message}
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-sm text-[#5c6a62]">No conversion warnings.</p>}
              </div>
            ) : null}
          </section>

          {importError ? <p role="alert" className="rounded-xl border border-[#a45e48]/40 bg-[#f7dfd6] px-3 py-2 text-sm text-[#7f3e2d]">{importError}</p> : null}

          <DialogFooter className="gap-2 sm:gap-2">
            {bundle?.flows.length ? (
              <Button type="button" variant="outline" onClick={buildPreview}>
                <FileJson aria-hidden="true" /> Validate conversion
              </Button>
            ) : null}
            {migration?.plan ? (
              <Button type="button" onClick={openDetachedPreview}>
                <GitBranch aria-hidden="true" /> Open detached preview
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TaskConstructorDialog
        task={previewState?.task || null}
        initialDraft={previewState?.draft || null}
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        returnFocus={returnFocus}
        mode="preview"
      />
    </>
  )
}
