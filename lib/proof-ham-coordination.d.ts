import type { GalaxyGraphScope, ScopedGalaxyGraphRelation } from "./unified-graph"
import type { TaskSummary } from "./types/tasks"

export const PROOF_HAM_COORDINATION_SCHEMA_ID: "gb.proof-ham-coordination.v1"

export interface ProofHamCoordinationBinding {
  scope?: GalaxyGraphScope
  graphId: string
  nodeId: string
  nodeRef: string
  taskId: string
  linkedTaskCount: number
  resourceRef: string
}

export interface AuthorizedProofHamTask {
  authorized: boolean
  scope: GalaxyGraphScope
  task: TaskSummary
}

export interface ProofHamCoordinationResult {
  schemaId: "gb.proof-ham-coordination.v1"
  relations: ReadonlyArray<ScopedGalaxyGraphRelation>
  diagnostics: {
    unauthorizedTasks: number
    missingTasks: number
    resourceMismatches: number
    linked: number
  }
}

export function joinAuthorizedProofHamCoordination(input: {
  schemaId: "gb.proof-ham-coordination.v1"
  scope: GalaxyGraphScope
  bindings: ReadonlyArray<ProofHamCoordinationBinding>
  tasks: ReadonlyArray<AuthorizedProofHamTask>
} | unknown): ProofHamCoordinationResult
