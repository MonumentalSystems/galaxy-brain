import type {
  TaskPlanNodeKind,
  TaskPlanProposal,
  TaskPlanProposalAction,
  TaskPlanRecord,
} from "./types/task-plans"

export const TASK_PLAN_PROPOSAL_TOOL_PATH: "/api/agent-tools/task.plan.propose"
export const MAX_TASK_PLAN_PROPOSAL_REQUEST_BYTES: 65536
export const MAX_TASK_PLAN_PROPOSAL_RESPONSE_BYTES: 70000

export type TaskPlanProposalBranchIntent = Readonly<{
  kind: Exclude<TaskPlanNodeKind, "context" | "branch" | "join">
  title: string
  goal: string
  instruction: string | null
  inputRefs: readonly string[]
}>

export type TaskPlanProposalIntent = Readonly<{
  action: TaskPlanProposalAction
  sourceJobIds: readonly string[]
  title: string
  goal: string
  instruction: string | null
  inputRefs: readonly string[]
  branches: readonly TaskPlanProposalBranchIntent[]
}>

export class TaskPlanProposalClientError extends Error {
  readonly code: string
  readonly status: number | null
  constructor(code: string, message: string, options?: { status?: number | null; cause?: unknown })
}

export function createTaskPlanProposalRequest(
  taskPlan: TaskPlanRecord,
  intent: TaskPlanProposalIntent,
): Readonly<{ call: Readonly<Record<string, unknown>>; body: string }>

export function requestTaskPlanProposal(
  taskPlan: TaskPlanRecord,
  intent: TaskPlanProposalIntent,
  options?: {
    fetcher?: typeof fetch
    signal?: AbortSignal
  },
): Promise<TaskPlanProposal>
