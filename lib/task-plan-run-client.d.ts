import type { TaskPlanRecord } from "./types/task-plans"
import type { TaskRunSummary } from "./types/tasks"

export const TASK_PLAN_RUN_RESPONSE_MAX_BYTES: 32768

export type TaskPlanRunPhase =
  | "wake-requested"
  | "accepted"
  | "started"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "rejected"
  | "declined"

export type TaskPlanRunTask = Readonly<{
  id: string
  version?: number
  state?: string
  activeRun?: TaskRunSummary
}>

export type TaskPlanRunReceipt = Readonly<{
  taskId: string
  runId: string
  taskPlanId: string
  taskPlanVersion: number
  taskPlanSpecSha256: string
  state: TaskPlanRunPhase
  replayed: boolean
  taskPlanContentSha256: string
  expectedTaskVersion: number
}>

export type TaskPlanRunStatus = Readonly<{
  runId: string
  taskId: string
  taskPlanId: string
  taskPlanVersion: number
  taskPlanContentSha256: string
  taskPlanSpecSha256: string
  expectedTaskVersion: number
  phase: TaskPlanRunPhase
  blockReason: string | null
  blockedSince: string | null
  lastHeartbeatAt: string | null
  createdAt: string | null
  completedAt: string | null
}>

export class TaskPlanRunClientError extends Error {
  readonly code: string
  readonly status: number | null
  constructor(code: string, message: string, options?: { status?: number | null; cause?: unknown })
}

export function taskPlanRunStartBlocker(input: Readonly<{
  task: TaskPlanRunTask
  taskPlan: TaskPlanRecord | null
  mode?: "live" | "preview"
  loading?: boolean
  saving?: boolean
  dirty?: boolean
  candidatePending?: boolean
  writeBlocked?: boolean
  runPresent?: boolean
}>): string

export function createTaskPlanRunRequest(
  task: TaskPlanRunTask,
  taskPlan: TaskPlanRecord,
  idempotencyKey: string,
): Readonly<{
  path: string
  body: string
  input: Readonly<{
    taskPlanId: string
    expectedPlanVersion: number
    expectedContentHash: string
    expectedTaskVersion: number
  }>
  idempotencyKey: string
}>

type RequestOptions = {
  fetcher?: typeof fetch
  signal?: AbortSignal
}

export function startTaskPlanRun(
  task: TaskPlanRunTask,
  taskPlan: TaskPlanRecord,
  options: RequestOptions & { idempotencyKey: string },
): Promise<TaskPlanRunReceipt>

export function refreshTaskPlanRun(
  taskId: string,
  runId: string,
  options?: RequestOptions,
): Promise<TaskPlanRunStatus>

export function cancelTaskPlanRun(
  taskId: string,
  runId: string,
  options?: RequestOptions,
): Promise<TaskPlanRunStatus>

export function isTaskPlanRunTerminal(phase: string): boolean
