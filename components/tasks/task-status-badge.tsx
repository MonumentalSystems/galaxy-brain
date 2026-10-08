import { AlertTriangle, CheckCircle2, CircleDot, Clock3, PlayCircle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { taskBucket } from "@/lib/ham-task-adapter"
import type { TaskLifecyclePhase } from "@/lib/types/tasks"

export type TaskStatusBadgeProps = {
  state: string
  lifecyclePhase: TaskLifecyclePhase
}
export function TaskStatusBadge({ state, lifecyclePhase }: TaskStatusBadgeProps) {
  const bucket = taskBucket(state)
  const label = (lifecyclePhase === "unknown" ? state : lifecyclePhase).replaceAll("_", " ").replaceAll("-", " ")
  const Icon = lifecyclePhase === "running"
    ? PlayCircle
    : lifecyclePhase === "waiting"
      ? AlertTriangle
      : lifecyclePhase === "terminal" || lifecyclePhase === "review"
        ? CheckCircle2
        : lifecyclePhase === "requested" || lifecyclePhase === "delivered" || lifecyclePhase === "claimed"
          ? CircleDot
          : Clock3

  return (
    <Badge
      variant={bucket === "needs-attention" || ["failed", "cancelled"].includes(state) ? "destructive" : "secondary"}
      className="gap-1.5 capitalize"
      title={`Canonical HAM state: ${state}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </Badge>
  )
}
