"use client"

import { useState } from "react"
import { Download, GitBranch } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { LegacyFlowGraph, LegacyFlowMigrationResult } from "@/lib/legacy-flow-task-plan"
import { createLegacyFlowDownloadName, migrateLegacyFlowToTaskPlan } from "@/lib/legacy-flow-task-plan"

export type FlowTaskPlanMigrationProps = {
  flow: LegacyFlowGraph
}

export function FlowTaskPlanMigration({ flow }: FlowTaskPlanMigrationProps) {
  const [open, setOpen] = useState(false)
  const [taskId, setTaskId] = useState("")
  const [taskVersion, setTaskVersion] = useState("")
  const [result, setResult] = useState<LegacyFlowMigrationResult | null>(null)

  const preview = () => {
    setResult(migrateLegacyFlowToTaskPlan(flow, {
      id: taskId,
      ...(taskVersion.trim() ? { version: Number(taskVersion) } : {}),
    }))
  }

  const download = () => {
    if (!result?.plan) return
    const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(result.plan, null, 2)], { type: "application/json" }))
    const anchor = document.createElement("a")
    anchor.href = objectUrl
    anchor.download = createLegacyFlowDownloadName(flow.name)
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(objectUrl)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) setResult(null)
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <GitBranch aria-hidden="true" />
          Preview task plan
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Migrate legacy flow</DialogTitle>
          <DialogDescription>
            Convert this browser-local draft into a provider-neutral <code>gb.task-plan.v1</code> preview. This does not save or execute anything.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="migration-task-id">HAM task ID</Label>
            <Input
              id="migration-task-id"
              value={taskId}
              maxLength={200}
              onChange={(event) => {
                setTaskId(event.target.value)
                setResult(null)
              }}
              aria-describedby="migration-task-help"
              placeholder="ham-task-id"
            />
            <p id="migration-task-help" className="text-xs text-muted-foreground">
              Required. The resulting plan remains bounded by this existing task; migration never creates a task or grants authority.
            </p>
          </div>
          <div className="grid max-w-48 gap-2">
            <Label htmlFor="migration-task-version">Task version (optional)</Label>
            <Input
              id="migration-task-version"
              inputMode="numeric"
              min={1}
              step={1}
              type="number"
              value={taskVersion}
              onChange={(event) => {
                setTaskVersion(event.target.value)
                setResult(null)
              }}
            />
          </div>

          {result ? (
            <section aria-labelledby="migration-result-title" className="space-y-3 rounded-lg border bg-muted/30 p-4">
              <div>
                <h3 id="migration-result-title" className="font-medium">
                  {result.plan ? "Task-plan preview ready" : "Migration needs attention"}
                </h3>
                <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
                  {result.plan
                    ? `${result.plan.nodes.length} jobs and ${result.plan.edges.length} edges mapped; review warnings before import.`
                    : "No task plan was produced. Fix every error so legacy behavior is not silently lost."}
                </p>
              </div>

              {result.diagnostics.length ? (
                <ul className="space-y-2 text-sm">
                  {result.diagnostics.map((diagnostic, index) => (
                    <li
                      key={`${diagnostic.code}-${diagnostic.nodeId || diagnostic.edgeId || index}`}
                      className={diagnostic.level === "error" ? "text-destructive" : "text-amber-800 dark:text-amber-300"}
                      role={diagnostic.level === "error" ? "alert" : undefined}
                    >
                      <span className="font-medium">{diagnostic.level === "error" ? "Error" : "Review"}:</span>{" "}
                      {diagnostic.message}
                    </li>
                  ))}
                </ul>
              ) : null}

              {result.plan ? (
                <details>
                  <summary className="cursor-pointer py-1 text-sm font-medium">Inspect generated JSON</summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-background p-3 text-xs">
                    {JSON.stringify(result.plan, null, 2)}
                  </pre>
                </details>
              ) : null}
            </section>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          {result?.plan ? (
            <Button type="button" variant="outline" onClick={download}>
              <Download aria-hidden="true" />
              Download JSON
            </Button>
          ) : null}
          <Button type="button" onClick={preview}>Build preview</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
