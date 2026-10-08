import type { TaskPlanRecord } from "./types/task-plans"
import type { GalaxyGraphQuery, GalaxyGraphScope, UnifiedGraphInput } from "./unified-graph"

export type AuthorizedTaskPlanEnvelope = {
  authorized: boolean
  scope: GalaxyGraphScope
  record: TaskPlanRecord
}

export interface AuthorizedTaskPlanGraphSourceInput {
  schemaId: "gb.authorized-task-plan-graph-source.v1"
  scope: GalaxyGraphScope
  query: GalaxyGraphQuery
  providerStatus: "ready" | "partial" | "unavailable"
  plans: AuthorizedTaskPlanEnvelope[]
  sourceLimit?: number
  priorityRefs?: string[]
}

export interface AuthorizedTaskPlanGraphSourceResult {
  schemaId: "gb.authorized-task-plan-graph-source-result.v1"
  graphInput: UnifiedGraphInput
  sourceContinuation: {
    hasMore: boolean
    omittedPlans: number
    omittedObjects: number
    reasons: string[]
  }
  diagnostics: { unauthorized: number }
}

export const AUTHORIZED_TASK_PLAN_GRAPH_SOURCE_SCHEMA_ID: "gb.authorized-task-plan-graph-source.v1"
export const AUTHORIZED_TASK_PLAN_GRAPH_SOURCE_RESULT_SCHEMA_ID: "gb.authorized-task-plan-graph-source-result.v1"
export function buildAuthorizedTaskPlanGraphSource(input: AuthorizedTaskPlanGraphSourceInput | unknown): AuthorizedTaskPlanGraphSourceResult
