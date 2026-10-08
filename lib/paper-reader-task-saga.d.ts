import type { CreateTaskInput, TaskDetail } from "./types/tasks"

export type PaperTaskCheckpoint = Pick<TaskDetail, "id" | "title"> & { version: number }

export type PaperTaskSagaOperation = {
  schemaId: "gb.paper-task-request.v1"
  idempotencyKey: string
  taskIdempotencyKey?: string
  linkIdempotencyKey?: string
  requestedAt: string
  anchor: { ref: string; [key: string]: unknown }
  resourceRefs?: readonly string[]
  title: string
  goal: string
  sourceHref: string
  executionMode?: "review" | "run"
  task?: PaperTaskCheckpoint | null
  linkSourceRef?: string
  stage?: "requested" | "task-created"
  [key: string]: unknown
}

export function paperTaskSagaKeys(operationKey: string): {
  readonly taskIdempotencyKey: string
  readonly linkIdempotencyKey: string
}
export function paperAgentLoopKeys(operationKey: string): {
  readonly planIdempotencyKey: string
  readonly runIdempotencyKey: string
}
export function normalizePaperTaskOperation(request: unknown): PaperTaskSagaOperation
export function paperTaskInput(operation: unknown): CreateTaskInput
export function paperAgentLoopTask(operation: unknown): {
  readonly id: string
  readonly version: number
  readonly title: string
  readonly goal: string
  readonly state: "pending"
  readonly resources: readonly {
    readonly id: string
    readonly resourceRef: string
    readonly redacted: false
    readonly mode: "read"
    readonly status: "active"
  }[]
}
export function latestHamTaskReference(task: unknown): string
export function createdHamTaskEvidenceReference(task: unknown): string
export function runPaperTaskSaga(
  request: unknown,
  ports: {
    createTask(input: CreateTaskInput, idempotencyKey: string): Promise<PaperTaskCheckpoint>
    createLink(input: { anchorRef: string; taskRef: string; createdTaskRef: string; idempotencyKey: string; sourceHref: string }): Promise<unknown>
    writeRecovery(operation: PaperTaskSagaOperation): void | Promise<void>
    clearRecovery(operation: PaperTaskSagaOperation): void | Promise<void>
  },
): Promise<{ operation: PaperTaskSagaOperation; link: unknown; taskRef: string; createdTaskRef: string }>
