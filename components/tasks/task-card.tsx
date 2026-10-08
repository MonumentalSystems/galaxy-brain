import { AlertTriangle, Bot, Box, CircleDot, Clock3, FolderGit2, Network, Send, ShieldAlert } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { TaskStatusBadge } from "@/components/tasks/task-status-badge"
import { formatTaskFreshness } from "@/lib/ham-task-adapter"
import type { TaskSummary } from "@/lib/types/tasks"

export type TaskCardProps = {
  task: TaskSummary
  localConflicts?: string[]
  onOpen: (task: TaskSummary, trigger: HTMLButtonElement) => void
  onConstruct: (task: TaskSummary, trigger: HTMLButtonElement) => void
}

function riskLabel(riskMode: TaskSummary["riskMode"]) {
  return riskMode === "unspecified" ? "Risk mode not recorded" : `${riskMode} activity`
}

export function TaskCard({ task, localConflicts = [], onOpen, onConstruct }: TaskCardProps) {
  const allConflicts = [...task.conflicts.map((conflict) => conflict.summary), ...localConflicts]
  const updatedAt = task.activeRun?.heartbeatAt || task.updatedAt || task.createdAt

  return (
    <article className="h-full">
      <Card className="flex h-full flex-col border-white/70 bg-white/80 shadow-sm dark:border-white/10 dark:bg-cosmic-950/65">
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <TaskStatusBadge state={task.state} lifecyclePhase={task.lifecyclePhase} />
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
              {riskLabel(task.riskMode)}
            </span>
          </div>
          <CardTitle className="text-lg leading-snug">{task.title}</CardTitle>
        </CardHeader>
        <CardContent className="flex-1 space-y-4 text-sm">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Goal</p>
            <p className="mt-1 line-clamp-3">{task.goal}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Why</p>
            <p className="mt-1 line-clamp-2 text-muted-foreground">{task.why}</p>
          </div>
          <dl className="space-y-2 text-xs">
            <div className="flex gap-2">
              <dt className="inline-flex min-w-20 items-center gap-1 text-muted-foreground">
                <FolderGit2 className="h-3.5 w-3.5" aria-hidden="true" /> Project
              </dt>
              <dd>{task.projectRef || "Not reported"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="inline-flex min-w-20 items-center gap-1 text-muted-foreground">
                <Send className="h-3.5 w-3.5" aria-hidden="true" /> Requested
              </dt>
              <dd>{task.requestedByAgent || "Human or service requester"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="inline-flex min-w-20 items-center gap-1 text-muted-foreground">
                <Bot className="h-3.5 w-3.5" aria-hidden="true" /> Claimant
              </dt>
              <dd>{task.owner?.label || "Unclaimed"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="inline-flex min-w-20 items-center gap-1 text-muted-foreground">
                <CircleDot className="h-3.5 w-3.5" aria-hidden="true" /> Stage
              </dt>
              <dd>{task.stage}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="inline-flex min-w-20 items-center gap-1 text-muted-foreground">
                <Clock3 className="h-3.5 w-3.5" aria-hidden="true" /> Freshness
              </dt>
              <dd>{formatTaskFreshness(updatedAt)}</dd>
            </div>
          </dl>
          {task.resources.length > 0 ? (
            <div>
              <p className="mb-1.5 inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Box className="h-3.5 w-3.5" aria-hidden="true" /> Resources
              </p>
              <ul className="flex flex-wrap gap-1.5" aria-label="Active resource claims">
                {task.resources.slice(0, 4).map((claim) => (
                  <li key={claim.id} className="rounded-full border bg-background/70 px-2 py-1 text-[11px]">
                    {claim.mode}: {claim.redacted ? `${claim.resourceType || claim.resourceClass || "resource"} (details restricted)` : claim.resourceRef}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {allConflicts.length > 0 ? (
            <div className="rounded-lg border border-amber-400/60 bg-amber-50 p-2.5 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
              <p className="flex items-center gap-1.5 font-medium">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" /> Potential conflict
              </p>
              <p className="mt-1 text-xs">{allConflicts[0]}</p>
            </div>
          ) : null}
        </CardContent>
        <CardFooter className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={(event) => onOpen(task, event.currentTarget)}
            aria-label={`Open task details for ${task.title}`}
          >
            Details
          </Button>
          <Button
            type="button"
            className="w-full bg-[#315f49] text-white hover:bg-[#284e3c]"
            onClick={(event) => onConstruct(task, event.currentTarget)}
            aria-label={`Construct a versioned plan for ${task.title}`}
          >
            <Network className="h-4 w-4" aria-hidden="true" />
            Construct
          </Button>
        </CardFooter>
      </Card>
    </article>
  )
}
