export type TaskRiskMode = "diagnostic" | "test" | "production" | "unspecified"

export type TaskResourceMode = "observe" | "read" | "write" | "exclusive"

export type TaskLifecyclePhase =
  | "requested"
  | "delivered"
  | "claimed"
  | "running"
  | "waiting"
  | "review"
  | "terminal"
  | "unknown"

export type TaskOwner = {
  principalId: string
  label: string
}

export type TaskRunSummary = {
  id: string
  status: string
  stage?: string
  heartbeatAt?: string
}

export type TaskResourceClaim = {
  id: string
  resourceRef: string
  resourceType?: string
  resourceClass?: string
  redacted?: boolean
  mode: TaskResourceMode
  status: string
  runId?: string
}

export type TaskConflict = {
  id: string
  kind: string
  summary: string
  relatedTaskId?: string
  resourceRef?: string
}

export type TaskSummary = {
  id: string
  projectRef?: string
  version?: number
  title: string
  goal: string
  why: string
  state: string
  lifecyclePhase: TaskLifecyclePhase
  stage: string
  riskMode: TaskRiskMode
  expectedEffects: string[]
  requestedByAgent?: string
  owner?: TaskOwner
  activeRun?: TaskRunSummary
  resources: TaskResourceClaim[]
  conflicts: TaskConflict[]
  createdAt?: string
  updatedAt?: string
  lastAuthoritativeEvent?: {
    type: string
    summary: string
    occurredAt?: string
  }
  projectionSource: "ham"
}

export type TaskDetail = TaskSummary & {
  nonGoals: string[]
  acceptanceCriteria: string[]
  sourceRefs: string[]
  requesterRef?: string
}

export type TaskEvent = {
  id: string
  sequence?: number
  type: string
  occurredAt?: string
  actorRef?: string
  runId?: string
  summary: string
  evidenceRefs: string[]
}

export type TaskPage = {
  tasks: TaskSummary[]
  cursor?: string
  nextCursor?: string
  truncated?: boolean
}

export type TaskEventPage = {
  events: TaskEvent[]
  cursor?: number
  nextCursor?: number
  hasMore: boolean
}

export type CreateTaskInput = {
  title: string
  goal: string
  why: string
  acceptanceCriteria: string[]
  riskMode: Exclude<TaskRiskMode, "unspecified">
  resourceKeys: string[]
  resourceMode: TaskResourceMode
}
