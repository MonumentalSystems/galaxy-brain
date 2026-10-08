export const TASK_PLAN_NODE_KINDS = [
  "context",
  "research",
  "transform",
  "compare",
  "challenge",
  "synthesize",
  "branch",
  "join",
  "checkpoint",
  "artifact",
] as const

export type TaskPlanNodeKind = (typeof TASK_PLAN_NODE_KINDS)[number]
export type TaskPlanEdgeKind = "control" | "data" | "evidence" | "branch" | "join"

export type TaskPlanNodeConfig = {
  instruction?: string
  inputRefs?: string[]
  outputRefs?: string[]
  capabilities?: string[]
  executorProfile?: string
  requiresApproval?: boolean
  artifactType?: string
}

export type TaskPlanNode = {
  id: string
  kind: TaskPlanNodeKind
  title: string
  goal: string
  position: { x: number; y: number }
  config: TaskPlanNodeConfig
}

export type TaskPlanEdge = {
  id: string
  source: string
  target: string
  kind: TaskPlanEdgeKind
  label?: string
}

export type TaskPlanSpec = {
  schema: "gb.task-plan.v1"
  task: {
    kind: "galaxy.ham.task"
    id: string
    version?: number
  }
  goal: string
  nodes: TaskPlanNode[]
  edges: TaskPlanEdge[]
}

export type TaskPlanRecord = {
  id: string
  tenant_id: string
  ham_task_id: string
  created_by_principal_id: string
  title: string
  schema_version: "gb.task-plan.v1"
  current_version: number
  current_content_hash: string
  current_spec: TaskPlanSpec
  provenance: Record<string, unknown>
  created_at: string
  updated_at: string
  replayed?: boolean
}

export type TaskPlanRevision = {
  id: string
  tenant_id: string
  task_plan_id: string
  version: number
  title: string
  schema_version: "gb.task-plan.v1"
  content_hash: string
  spec: TaskPlanSpec
  provenance: Record<string, unknown>
  created_by_principal_id: string
  created_at: string
}

export type TaskPlanProposalAction = "branch" | "join" | "compare" | "challenge" | "synthesize"

export type TaskPlanProposalBase = Readonly<{
  taskPlanId: string
  taskPlanVersion: number
  taskPlanContentHash: string
  hamTaskId: string
  hamTaskVersion: number
}>

export type TaskPlanProposalOperation =
  | Readonly<{ op: "node.add"; node: TaskPlanNode }>
  | Readonly<{ op: "edge.add"; edge: TaskPlanEdge }>

export type TaskPlanProposal = Readonly<{
  schemaId: "gb.task-plan-proposal.v1"
  requestHash: string
  scope: "task-local-work"
  effect: "proposal"
  action: TaskPlanProposalAction
  base: TaskPlanProposalBase
  sourceJobIds: readonly string[]
  inputRefs: readonly string[]
  operations: readonly TaskPlanProposalOperation[]
  summary: string
  proposalHash: string
}>

export type TaskPlanProposalDecision = Readonly<{
  proposalHash: string
  outcome: "dismissed" | "applied"
}>
