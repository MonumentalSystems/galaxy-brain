export interface ProofGraphRef { schema_id?: "galaxy.proof-graph-ref.v1"; graph_id: string; content_sha256: string }
export const HYADES_PROOF_TASK_BINDINGS_MAX_COUNT: 1000
export const HYADES_PROOF_TASK_BINDINGS_MAX_BYTES: 524288
export interface HyadesTaskBinding {
  program_id: string; packet_id: string; task_id: string; resource_ref: string
  assignment_sha256: string; transition_sha256: string; state: string
  dispatch_id: string; dispatch_sequence: number; directive_sha256: string
  projection_sha256: string
}
export function parseHyadesTaskBindingReconcileRequest(value: unknown): Readonly<{
  schema_id: "gb.hyades-proof-task-binding-reconcile.v1"
  graph_ref: Readonly<ProofGraphRef>
  expected_workspace_version: number
  idempotency_key: string
}>
export function parseHyadesProofTaskBindings(value: unknown, expectedGraphRef: unknown): Readonly<{
  schema_id: "galaxy.hyades-proof-task-bindings.v1"
  program_id: string
  graph_ref: Readonly<ProofGraphRef>
  projection_sha256: string
  complete: true
  bindings: readonly Readonly<HyadesTaskBinding>[]
}>
export function assertExactHamTaskBinding(value: unknown, binding: HyadesTaskBinding): string
export function assertExactHamTaskAssignment(value: unknown, binding: HyadesTaskBinding): string
