import { createHash } from "node:crypto"

const SHA256 = /^[0-9a-f]{64}$/u
const COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u
const STATES = new Set(["dispatched", "reused"])
export const HYADES_PROOF_TASK_BINDINGS_MAX_COUNT = 1_000
export const HYADES_PROOF_TASK_BINDINGS_MAX_BYTES = 524_288

function invalid(message) { throw new Error(message) }
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`)
  return value
}
function exact(value, keys, label) {
  const unknown = Object.keys(value).filter((key) => !keys.has(key))
  if (unknown.length) invalid(`${label} contains unknown field ${unknown[0]}`)
}
function text(value, maximum, label, pattern) {
  if (typeof value !== "string" || !value || value.length > maximum || (pattern && !pattern.test(value))) {
    invalid(`${label} is invalid`)
  }
  return value
}
function digest(value, label) { return text(value, 64, label, SHA256) }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) invalid("canonical JSON contains an unsupported value")
  return encoded
}
function canonicalSha256(value) {
  return createHash("sha256").update(`${canonicalJson(value)}\n`, "utf8").digest("hex")
}
function ordinal(left, right) { return left < right ? -1 : left > right ? 1 : 0 }
function graphRef(value, label = "graph_ref", requireSchema = false) {
  const source = object(value, label)
  exact(source, new Set(requireSchema
    ? ["schema_id", "graph_id", "content_sha256"]
    : ["graph_id", "content_sha256"]), label)
  if (requireSchema && source.schema_id !== "galaxy.proof-graph-ref.v1") {
    invalid(`${label}.schema_id is unsupported`)
  }
  return Object.freeze({
    ...(requireSchema ? { schema_id: source.schema_id } : {}),
    graph_id: text(source.graph_id, 120, `${label}.graph_id`, COMPONENT),
    content_sha256: digest(source.content_sha256, `${label}.content_sha256`),
  })
}

export function parseHyadesTaskBindingReconcileRequest(value) {
  const source = object(value, "request")
  exact(source, new Set(["schema_id", "graph_ref", "expected_workspace_version", "idempotency_key"]), "request")
  if (source.schema_id !== "gb.hyades-proof-task-binding-reconcile.v1") invalid("request.schema_id is unsupported")
  if (!Number.isSafeInteger(source.expected_workspace_version) || source.expected_workspace_version < 1) {
    invalid("request.expected_workspace_version is invalid")
  }
  const idempotencyKey = text(source.idempotency_key, 200, "request.idempotency_key")
  if (idempotencyKey.length < 8) invalid("request.idempotency_key is invalid")
  return Object.freeze({
    schema_id: source.schema_id,
    graph_ref: graphRef(source.graph_ref),
    expected_workspace_version: source.expected_workspace_version,
    idempotency_key: idempotencyKey,
  })
}

export function parseHyadesProofTaskBindings(value, expectedGraphRef) {
  const source = object(value, "Hyades response")
  exact(source, new Set([
    "schema_id", "program_id", "graph_ref", "projection_sha256", "complete", "bindings",
  ]), "Hyades response")
  if (source.schema_id !== "galaxy.hyades-proof-task-bindings.v1") invalid("Hyades response schema_id is unsupported")
  if (source.complete !== true) invalid("Hyades task binding projection must be complete")
  const expected = graphRef(expectedGraphRef, "expected graph_ref")
  const actual = graphRef(source.graph_ref, "Hyades response.graph_ref", true)
  const programId = text(source.program_id, 120, "Hyades response.program_id", COMPONENT)
  if (programId !== expected.graph_id || actual.graph_id !== expected.graph_id
    || actual.content_sha256 !== expected.content_sha256) {
    invalid("Hyades task binding projection is bound to a different graph")
  }
  if (!Array.isArray(source.bindings)
    || source.bindings.length > HYADES_PROOF_TASK_BINDINGS_MAX_COUNT) {
    invalid("Hyades response.bindings must be a bounded array")
  }
  const projectionSha256 = digest(source.projection_sha256, "Hyades response.projection_sha256")
  const bindings = source.bindings.map((value, index) => {
    const label = `Hyades response.bindings[${index}]`
    const binding = object(value, label)
    exact(binding, new Set([
      "packet_id", "task_id", "resource_ref", "assignment_sha256", "transition_sha256",
      "state", "dispatch_id", "dispatch_sequence", "directive_sha256",
    ]), label)
    if (!Number.isSafeInteger(binding.dispatch_sequence) || binding.dispatch_sequence < 1) {
      invalid(`${label}.dispatch_sequence is invalid`)
    }
    const packetId = text(binding.packet_id, 120, `${label}.packet_id`, COMPONENT)
    const expectedResource = `proof-packet:sha256:${expected.content_sha256}/${programId}/${packetId}`
    if (binding.resource_ref !== expectedResource) invalid(`${label}.resource_ref is not exact`)
    const state = text(binding.state, 80, `${label}.state`)
    if (!STATES.has(state)) invalid(`${label}.state is invalid`)
    return Object.freeze({
      program_id: programId,
      packet_id: packetId,
      task_id: text(binding.task_id, 512, `${label}.task_id`, IDENTIFIER),
      resource_ref: expectedResource,
      assignment_sha256: digest(binding.assignment_sha256, `${label}.assignment_sha256`),
      transition_sha256: digest(binding.transition_sha256, `${label}.transition_sha256`),
      state,
      dispatch_id: text(binding.dispatch_id, 512, `${label}.dispatch_id`, IDENTIFIER),
      dispatch_sequence: binding.dispatch_sequence,
      directive_sha256: digest(binding.directive_sha256, `${label}.directive_sha256`),
      projection_sha256: projectionSha256,
    })
  })
  if (new Set(bindings.map((binding) => binding.packet_id)).size !== bindings.length) {
    invalid("Hyades response.bindings contains duplicate packet_id values")
  }
  if (new Set(bindings.map((binding) => binding.task_id)).size !== bindings.length) {
    invalid("Hyades response.bindings contains duplicate task_id values")
  }
  bindings.sort((left, right) => ordinal(left.packet_id, right.packet_id)
    || left.dispatch_sequence - right.dispatch_sequence)
  const publicProjection = {
    schema_id: source.schema_id,
    program_id: programId,
    graph_ref: actual,
    complete: true,
    bindings: bindings.map(({ program_id, projection_sha256, ...binding }) => binding),
  }
  if (canonicalSha256(publicProjection) !== projectionSha256) {
    invalid("Hyades response.projection_sha256 does not match its canonical public projection")
  }
  return Object.freeze({
    schema_id: source.schema_id,
    program_id: programId,
    graph_ref: actual,
    projection_sha256: projectionSha256,
    complete: true,
    bindings: Object.freeze(bindings),
  })
}

function strictGraphRef(value, binding) {
  const reference = graphRef(value, "HAM assignment directive graph_ref", true)
  if (reference.graph_id !== binding.program_id
    || binding.resource_ref !== `proof-packet:sha256:${reference.content_sha256}/${binding.program_id}/${binding.packet_id}`) {
    invalid("HAM assignment graph reference does not match the exact proof resource")
  }
  return reference
}

/** Corroborate the raw HAM assignment. Browser-safe resource projection remains a separate check. */
export function assertExactHamTaskAssignment(value, binding) {
  const task = object(value, "raw HAM task")
  if (task.task_id !== binding.task_id) invalid("HAM returned a different raw task")
  const assignmentSha = digest(task.audit_contract_sha256, "HAM task.audit_contract_sha256")
  if (assignmentSha !== binding.assignment_sha256) invalid("HAM assignment digest does not match Hyades")
  const assignment = object(task.audit_contract, "HAM task.audit_contract")
  exact(assignment, new Set([
    "schema_id", "program_id", "program_sha256", "progress_sha256", "directive_sha256",
    "dispatch_grant_sha256", "directive", "dispatch_grant", "target", "audit_profile_id",
    "authority_required", "authority_satisfied", "task_start_permitted", "dispatch_state",
  ]), "HAM task.audit_contract")
  if (assignment.schema_id !== "ham.audit-program-task-assignment.v3"
    || assignment.program_id !== binding.program_id
    || assignment.directive_sha256 !== binding.directive_sha256
    || assignment.authority_required !== true || assignment.authority_satisfied !== true
    || assignment.task_start_permitted !== true || assignment.dispatch_state !== "recorded") {
    invalid("HAM task assignment is not the exact authorized program assignment")
  }
  if (canonicalSha256(assignment) !== assignmentSha) invalid("HAM assignment digest is not canonical")

  const target = object(assignment.target, "HAM task.audit_contract.target")
  exact(target, new Set([
    "packet_id", "sequence_index", "action", "rosetta_node_ids",
    "target_root_contract", "proof_packet_resource_key",
  ]), "HAM task.audit_contract.target")
  if (target.packet_id !== binding.packet_id
    || target.proof_packet_resource_key !== binding.resource_ref) {
    invalid("HAM assignment target does not match the Hyades binding")
  }
  const directive = object(assignment.directive, "HAM task.audit_contract.directive")
  exact(directive, new Set([
    "schema_id", "program_id", "program_sha256", "progress_sha256", "program", "progress",
    "decision", "targets", "prerequisites_satisfied", "authority_granted",
    "side_effects_authorized", "dispatch_state",
  ]), "HAM task.audit_contract.directive")
  if (directive.schema_id !== "ham.audit-program-directive.v3"
    || directive.program_id !== binding.program_id
    || directive.decision !== "dispatch_frontier"
    || canonicalSha256(directive) !== binding.directive_sha256) {
    invalid("HAM assignment directive does not match Hyades")
  }
  const program = object(directive.program, "HAM task.audit_contract.directive.program")
  if (program.schema_id !== "ham.audit-program.v3" || program.program_id !== binding.program_id) {
    invalid("HAM assignment program does not match Hyades")
  }
  strictGraphRef(program.galaxy_proof_graph_ref, binding)
  if (!Array.isArray(directive.targets)
    || !directive.targets.some((candidate) => canonicalJson(candidate) === canonicalJson(target))) {
    invalid("HAM assignment target is not present in its directive")
  }
  return assignmentSha
}

export function assertExactHamTaskBinding(value, binding) {
  const task = object(value, "HAM task")
  const taskId = text(task.id, 512, "HAM task.id", IDENTIFIER)
  if (taskId !== binding.task_id) invalid("HAM returned a different task")
  if (!Array.isArray(task.resources) || task.resources.length !== 1) {
    invalid("HAM task must expose exactly one active proof resource")
  }
  const resource = object(task.resources[0], "HAM task.resources[0]")
  if (resource.resourceRef !== binding.resource_ref || resource.mode !== "observe"
    || resource.redacted !== false || resource.status !== "active") {
    invalid("HAM task does not expose the exact active observe proof resource")
  }
  return taskId
}
