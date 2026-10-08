import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { readBoundedResponseText, ResponseBodyTooLargeError } from "../lib/bounded-response.js"
import { mapWithBoundedConcurrency } from "../lib/bounded-work-pool.js"
import {
  assertExactHamTaskBinding,
  assertExactHamTaskAssignment,
  HYADES_PROOF_TASK_BINDINGS_MAX_BYTES,
  HYADES_PROOF_TASK_BINDINGS_MAX_COUNT,
  parseHyadesProofTaskBindings,
  parseHyadesTaskBindingReconcileRequest,
} from "../lib/hyades-proof-task-bindings-contract.js"
import { resolveHyadesProofTaskBindingsUrl } from "../lib/hyades-proof-task-bindings-config.js"
import { requiredElnScopes } from "../lib/eln-scope.js"
import { projectHamTaskDetailForBrowser } from "../lib/ham-task-browser-projection.js"
import { HAM_TASK_DETAIL_RESPONSE_MAX_BYTES } from "../lib/ham-task-contract.js"

const hash = (value) => value.repeat(64)
const graphRef = { graph_id: "program-a", content_sha256: hash("a") }
const hyadesGraphRef = { schema_id: "galaxy.proof-graph-ref.v1", ...graphRef }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}
const canonicalSha256 = (value) => createHash("sha256")
  .update(`${canonicalJson(value)}\n`, "utf8").digest("hex")
const target = {
  packet_id: "packet-a",
  sequence_index: 1,
  action: "preregister",
  rosetta_node_ids: ["rosetta-a"],
  target_root_contract: null,
  proof_packet_resource_key: `proof-packet:sha256:${hash("a")}/program-a/packet-a`,
}
const directive = {
  schema_id: "ham.audit-program-directive.v3",
  program_id: "program-a",
  program_sha256: hash("1"),
  progress_sha256: hash("2"),
  program: {
    schema_id: "ham.audit-program.v3",
    program_id: "program-a",
    galaxy_proof_graph_ref: hyadesGraphRef,
  },
  progress: {},
  decision: "dispatch_frontier",
  targets: [target],
  prerequisites_satisfied: true,
  authority_granted: false,
  side_effects_authorized: false,
  dispatch_state: "recorded",
}
const directiveSha256 = canonicalSha256(directive)
const assignment = {
  schema_id: "ham.audit-program-task-assignment.v3",
  program_id: "program-a",
  program_sha256: hash("1"),
  progress_sha256: hash("2"),
  directive_sha256: directiveSha256,
  dispatch_grant_sha256: hash("3"),
  directive,
  dispatch_grant: {},
  target,
  audit_profile_id: "lean-proof-v1",
  authority_required: true,
  authority_satisfied: true,
  task_start_permitted: true,
  dispatch_state: "recorded",
}
const binding = {
  packet_id: "packet-a",
  task_id: "task-a",
  resource_ref: `proof-packet:sha256:${hash("a")}/program-a/packet-a`,
  assignment_sha256: canonicalSha256(assignment),
  transition_sha256: hash("c"),
  state: "dispatched",
  dispatch_id: "dispatch-a",
  dispatch_sequence: 1,
  directive_sha256: directiveSha256,
}
function projectionPayload(bindings = [binding], updates = {}) {
  const publicProjection = {
    schema_id: "galaxy.hyades-proof-task-bindings.v1",
    program_id: "program-a",
    graph_ref: hyadesGraphRef,
    complete: true,
    bindings,
    ...updates,
  }
  return { ...publicProjection, projection_sha256: canonicalSha256(publicProjection) }
}

test("accepts only a complete graph-bound Hyades projection and exact HAM resource", () => {
  const projectionInput = projectionPayload()
  const projection = parseHyadesProofTaskBindings(projectionInput, graphRef)
  assert.equal(projection.bindings[0].projection_sha256, projectionInput.projection_sha256)
  assert.equal(assertExactHamTaskBinding({
    id: "task-a",
    resources: [{ resourceRef: binding.resource_ref, mode: "observe", redacted: false, status: "active" }],
  }, projection.bindings[0]), "task-a")
  const rawTask = {
    task_id: "task-a",
    project_id: "project-a",
    title: "Packet A",
    goal: "Prove packet A",
    rationale: "Materialized by Hyades",
    activity_mode: "test",
    resources: [{ key: binding.resource_ref, mode: "observe" }],
    audit_contract: assignment,
    audit_contract_sha256: binding.assignment_sha256,
    status: "pending",
    version: 1,
    lease_generation: 0,
    acceptance_criteria: [],
    conflicts: [],
    runs: [],
  }
  assert.equal(assertExactHamTaskBinding(
    projectHamTaskDetailForBrowser(rawTask),
    projection.bindings[0],
  ), "task-a")
  assert.equal(assertExactHamTaskAssignment(rawTask, projection.bindings[0]), binding.assignment_sha256)
  assert.throws(() => assertExactHamTaskBinding({
    id: "task-a",
    resources: [{ resourceRef: binding.resource_ref, mode: "write", redacted: false, status: "active" }],
  }, projection.bindings[0]), /exact active observe/)
  for (const resource of [
    { resourceRef: binding.resource_ref, mode: "observe", status: "active" },
    { resourceRef: binding.resource_ref, mode: "observe", redacted: "false", status: "active" },
    { resourceRef: binding.resource_ref, mode: "observe", redacted: false, status: "pending" },
  ]) {
    assert.throws(() => assertExactHamTaskBinding({ id: "task-a", resources: [resource] }, projection.bindings[0]), /exact active observe/)
  }
  const wrongRaw = projectHamTaskDetailForBrowser({
    ...rawTask,
    resources: [{ key: "proof-packet:sha256:" + hash("f") + "/program-a/packet-a", mode: "observe" }],
  })
  assert.throws(() => assertExactHamTaskBinding(wrongRaw, projection.bindings[0]), /exact active observe/)
  assert.throws(() => parseHyadesProofTaskBindings(
    projectionPayload([binding], { complete: false }), graphRef,
  ), /must be complete/)
  const reused = parseHyadesProofTaskBindings(
    projectionPayload([{ ...binding, state: "reused" }]), graphRef,
  )
  assert.equal(reused.bindings[0].state, "reused")
  assert.throws(() => parseHyadesProofTaskBindings(
    projectionPayload([{ ...binding, state: "pending" }]), graphRef,
  ), /state is invalid/)
  assert.throws(() => parseHyadesProofTaskBindings({
    ...projectionPayload(),
    projection_sha256: hash("f"),
  }, graphRef), /canonical public projection/)
})

test("canonical projection and raw HAM assignment reject provenance drift", () => {
  const projection = parseHyadesProofTaskBindings(projectionPayload(), graphRef)
  for (const mutate of [
    (task) => { task.audit_contract_sha256 = hash("f") },
    (task) => { task.audit_contract.program_id = "other" },
    (task) => { task.audit_contract.target.packet_id = "other" },
    (task) => { task.audit_contract.directive.program.galaxy_proof_graph_ref.content_sha256 = hash("f") },
    (task) => { task.audit_contract.directive_sha256 = hash("f") },
  ]) {
    const task = {
      task_id: "task-a",
      audit_contract: structuredClone(assignment),
      audit_contract_sha256: binding.assignment_sha256,
    }
    mutate(task)
    assert.throws(() => assertExactHamTaskAssignment(task, projection.bindings[0]))
  }
})

test("program and packet identifiers match Hyades colon grammar and 120-character bound", () => {
  const programId = `p:${"a".repeat(118)}`
  const packetId = `q:${"b".repeat(118)}`
  const ref = { graph_id: programId, content_sha256: hash("a") }
  const raw = {
    ...binding,
    packet_id: packetId,
    resource_ref: `proof-packet:sha256:${hash("a")}/${programId}/${packetId}`,
  }
  const publicProjection = {
    schema_id: "galaxy.hyades-proof-task-bindings.v1",
    program_id: programId,
    graph_ref: { schema_id: "galaxy.proof-graph-ref.v1", ...ref },
    complete: true,
    bindings: [raw],
  }
  assert.equal(parseHyadesProofTaskBindings({
    ...publicProjection,
    projection_sha256: canonicalSha256(publicProjection),
  }, ref).bindings[0].packet_id, packetId)
  assert.throws(() => parseHyadesProofTaskBindings({
    ...publicProjection,
    program_id: `${programId}x`,
    projection_sha256: canonicalSha256({ ...publicProjection, program_id: `${programId}x` }),
  }, { ...ref, graph_id: `${programId}x` }), /graph_id is invalid|program_id is invalid/)
})

test("projection count and streamed response bytes match the Hyades producer contract", async () => {
  assert.equal(HYADES_PROOF_TASK_BINDINGS_MAX_COUNT, 1_000)
  assert.equal(HYADES_PROOF_TASK_BINDINGS_MAX_BYTES, 524_288)
  assert.equal(HAM_TASK_DETAIL_RESPONSE_MAX_BYTES, 2_097_152)
  const tooMany = Array.from({ length: HYADES_PROOF_TASK_BINDINGS_MAX_COUNT + 1 }, (_, index) => ({
    ...binding,
    packet_id: `packet-${index}`,
    task_id: `task-${index}`,
    resource_ref: `proof-packet:sha256:${hash("a")}/program-a/packet-${index}`,
  }))
  assert.throws(
    () => parseHyadesProofTaskBindings(projectionPayload(tooMany), graphRef),
    /bounded array/,
  )

  const exact = new Uint8Array(HYADES_PROOF_TASK_BINDINGS_MAX_BYTES).fill(97)
  assert.equal(
    (await readBoundedResponseText(
      new Response(new ReadableStream({ start(controller) { controller.enqueue(exact); controller.close() } })),
      HYADES_PROOF_TASK_BINDINGS_MAX_BYTES,
    )).length,
    HYADES_PROOF_TASK_BINDINGS_MAX_BYTES,
  )

  let cancelled = false
  const overstream = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(exact)
      controller.enqueue(Uint8Array.of(98))
    },
    cancel() { cancelled = true },
  }))
  await assert.rejects(
    readBoundedResponseText(overstream, HYADES_PROOF_TASK_BINDINGS_MAX_BYTES),
    ResponseBodyTooLargeError,
  )
  assert.equal(cancelled, true)
})

test("bounded corroboration preserves input order with a small fixed worker ceiling", async () => {
  const values = Array.from({ length: 12 }, (_, index) => index)
  let active = 0
  let maximumActive = 0
  const results = await mapWithBoundedConcurrency(values, 3, async (value) => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolve) => setTimeout(resolve, (value % 4) + 1))
    active -= 1
    return `verified-${value}`
  })
  assert.equal(maximumActive, 3)
  assert.deepEqual(results, values.map((value) => `verified-${value}`))

  let observedAbort = false
  await assert.rejects(mapWithBoundedConcurrency([0, 1, 2], 2, async (value, _index, signal) => {
    if (value === 0) {
      await Promise.resolve()
      throw new Error("corroboration failed")
    }
    await new Promise((resolve) => {
      if (signal.aborted) {
        observedAbort = true
        resolve()
        return
      }
      signal.addEventListener("abort", () => {
        observedAbort = true
        resolve()
      }, { once: true })
    })
  }), /corroboration failed/)
  assert.equal(observedAbort, true)
})

test("browser request cannot select program, task, tenant, or upstream destination", () => {
  const request = parseHyadesTaskBindingReconcileRequest({
    schema_id: "gb.hyades-proof-task-binding-reconcile.v1",
    graph_ref: graphRef,
    expected_workspace_version: 4,
    idempotency_key: "reconcile-1234",
  })
  assert.equal(request.expected_workspace_version, 4)
  for (const forbidden of ["program_id", "task_id", "tenant_id", "url"]) {
    assert.throws(() => parseHyadesTaskBindingReconcileRequest({ ...request, [forbidden]: "caller" }), /unknown field/)
  }
})

test("server-owned Hyades base derives a separate exact graph route", () => {
  const environment = { HYADES_PROOF_TASK_BINDINGS_API_INTERNAL: "https://hyades.internal/control" }
  const first = resolveHyadesProofTaskBindingsUrl(environment, graphRef)
  const second = resolveHyadesProofTaskBindingsUrl(environment, {
    graph_id: "program-b",
    content_sha256: hash("b"),
  })
  assert.equal(first?.toString(), `https://hyades.internal/control/ham/proof-task-bindings/program-a?content_sha256=${hash("a")}`)
  assert.equal(second?.toString(), `https://hyades.internal/control/ham/proof-task-bindings/program-b?content_sha256=${hash("b")}`)
  assert.equal(resolveHyadesProofTaskBindingsUrl({
    HYADES_PROOF_TASK_BINDINGS_API_INTERNAL: "https://hyades.internal/?target=caller",
  }, graphRef), null)
})

test("coordination binding is not exposed by the generic ELN proxy", async () => {
  const source = await readFile(new URL("../app/api/eln/[...path]/route.ts", import.meta.url), "utf8")
  assert.doesNotMatch(source, /coordination-task-bindings/)
  const server = await readFile(new URL("../services/galaxy-brain-api/server.py", import.meta.url), "utf8")
  assert.match(server, /"coordination\.task\.bind"/)
  assert.match(server, /generic transitions cannot establish proof truth/)
  assert.match(server, /generic transitions cannot establish coordination bindings/)
  assert.equal(
    requiredElnScopes("POST", ["proof-workspaces", "workspace-a", "transitions"], "coordination.task.bind").primary,
    "proof-work:invalid-transition",
  )
  const reconcile = await readFile(
    new URL("../app/api/proof-workspaces/[workspaceId]/hyades-task-bindings/reconcile/route.ts", import.meta.url),
    "utf8",
  )
  assert.match(reconcile, /readBoundedRequestBody/)
  assert.match(reconcile, /mapWithBoundedConcurrency/)
  assert.match(reconcile, /HAM_TASK_CORROBORATION_CONCURRENCY = 8/)
  assert.match(reconcile, /coordination-task-bindings\/bulk/)
  assert.match(reconcile, /assertExactHamTaskAssignment\(rawTask, binding\)/)
  assert.doesNotMatch(reconcile, /bindOne|MAX_DRIFT_RETRIES/)
  const hyadesClient = await readFile(
    new URL("../lib/hyades-proof-task-bindings-client.ts", import.meta.url), "utf8",
  )
  assert.match(hyadesClient, /readBoundedResponseText\(response, HYADES_PROOF_TASK_BINDINGS_MAX_BYTES\)/)
  const hamTaskProxy = await readFile(new URL("../lib/ham-task-proxy.ts", import.meta.url), "utf8")
  assert.match(hamTaskProxy, /readBoundedResponseText\(response, HAM_TASK_DETAIL_RESPONSE_MAX_BYTES\)/)
})

test("migration guards append-only coordination bindings from changing proof truth", async () => {
  const sql = await readFile(new URL("../db/migrations/032_proof_coordination_task_bindings.sql", import.meta.url), "utf8")
  assert.match(sql, /coordination\.task\.bind/)
  assert.match(sql, /work,status/)
  assert.match(sql, /work,claim/)
  assert.match(sql, /work,hyades/)
  assert.match(sql, /work,blocker/)
  assert.match(sql, /'\{proof\}'/)
  assert.match(sql, /dispatch_sequence must increase/)
})

test("registry exposes an explicit action and GET/render never calls reconcile", async () => {
  const source = await readFile(new URL("../components/graph/proof-graph-registry-panel.tsx", import.meta.url), "utf8")
  assert.match(source, /"Refresh Hyades tasks"/)
  assert.match(source, /method: "POST"/)
  assert.doesNotMatch(source, /useEffect\([\s\S]{0,500}hyades-task-bindings\/reconcile/)
})
