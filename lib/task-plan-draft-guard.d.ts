export type TaskPlanDraftToken = Readonly<{
  context: string
  generation: number
}>

export type TaskPlanDraftGuard = Readonly<{
  enter(context: string): TaskPlanDraftToken
  edit(context: string): TaskPlanDraftToken
  capture(context: string): TaskPlanDraftToken
  isCurrent(token: TaskPlanDraftToken): boolean
  isContextCurrent(token: TaskPlanDraftToken): boolean
}>

export function createTaskPlanDraftGuard(initialContext: string): TaskPlanDraftGuard

export type TaskPlanLatestRequestGuard = Readonly<{
  begin(): number
  isLatest(candidate: unknown): boolean
}>

export function createTaskPlanLatestRequestGuard(): TaskPlanLatestRequestGuard
