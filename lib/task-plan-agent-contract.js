import { createHash } from "node:crypto"

import { AgentToolContractError } from "./agent-tools/contracts.js"
import {
  createGalaxyObjectReference,
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "./galaxy-object-reference.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const HAM_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/u
const NODE_KINDS = new Set([
  "context", "research", "transform", "compare", "challenge", "synthesize",
  "branch", "join", "checkpoint", "artifact",
])
const EDGE_KINDS = new Set(["control", "data", "evidence", "branch", "join"])
const CONFIG_KEYS = new Set([
  "instruction", "inputRefs", "outputRefs", "capabilities", "executorProfile",
  "requiresApproval", "artifactType",
])
const RECORD_KEYS = new Set([
  "id", "tenant_id", "ham_task_id", "created_by_principal_id", "title", "schema_version",
  "current_version", "current_content_hash", "current_spec", "provenance",
  "creation_idempotency_key", "creation_request_hash", "created_at", "updated_at",
])

function providerError(message = "Task plan provider returned an invalid response") {
  throw new AgentToolContractError("invalid_provider_response", message, 502)
}

function plainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) providerError(`${label} is invalid`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) providerError(`${label} is invalid`)
  return value
}

function exactKeys(value, allowed, label) {
  if (Object.keys(value).some((key) => !allowed.has(key))) providerError(`${label} has unsupported properties`)
}

function text(value, maximum, label, minimum = 0) {
  if (typeof value !== "string" || value !== value.trim()
    || Array.from(value).length < minimum || Array.from(value).length > maximum
    || /[\ud800-\udfff]/u.test(value)) providerError(`${label} is invalid`)
  return value
}

function taskText(value, maximum, label, minimum = 0) {
  if (typeof value !== "string" || Array.from(value.trim()).length < minimum
    || Array.from(value.trim()).length > maximum || /[\ud800-\udfff]/u.test(value)) {
    providerError(`${label} is invalid`)
  }
  return value
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) providerError(`${label} is invalid`)
  return value
}

function canonicalReference(value, label, { pinned = false } = {}) {
  const parsed = parseGalaxyObjectReference(value)
  if (!parsed || parsed.format !== "canonical" || serializeGalaxyObjectReference(parsed) !== value) {
    providerError(`${label} is invalid`)
  }
  if (pinned && parsed.selector.mode !== "pinned") providerError(`${label} is not pinned`)
  return value
}

function stringArray(value, maximumItems, maximumLength, label, { references = false } = {}) {
  if (!Array.isArray(value) || value.length > maximumItems) providerError(`${label} is invalid`)
  const result = value.map((item, index) => references
    ? canonicalReference(item, `${label}[${index}]`)
    : text(item, maximumLength, `${label}[${index}]`, 1))
  if (new Set(result).size !== result.length) providerError(`${label} contains duplicates`)
  return Object.freeze(result)
}

function taskStringArray(value, label) {
  if (!Array.isArray(value) || value.length > 64) providerError(`${label} is invalid`)
  return Object.freeze(value.map((item, index) => taskText(item, 500, `${label}[${index}]`, 1)))
}

function taskPlanNode(value, index) {
  const label = `task plan node ${index}`
  const source = plainRecord(value, label)
  exactKeys(source, new Set(["id", "kind", "title", "goal", "position", "config"]), label)
  if (!IDENTIFIER.test(source.id) || !NODE_KINDS.has(source.kind)) providerError(`${label} identity is invalid`)
  const position = plainRecord(source.position, `${label}.position`)
  exactKeys(position, new Set(["x", "y"]), `${label}.position`)
  for (const axis of ["x", "y"]) {
    if (typeof position[axis] !== "number" || !Number.isFinite(position[axis]) || Math.abs(position[axis]) > 1_000_000) {
      providerError(`${label}.position is invalid`)
    }
  }
  const configSource = plainRecord(source.config, `${label}.config`)
  exactKeys(configSource, CONFIG_KEYS, `${label}.config`)
  const config = {}
  for (const key of ["instruction", "executorProfile", "artifactType"]) {
    if (Object.hasOwn(configSource, key)) config[key] = taskText(configSource[key], key === "instruction" ? 20_000 : 200, `${label}.config.${key}`)
  }
  for (const key of ["inputRefs", "outputRefs", "capabilities"]) {
    if (Object.hasOwn(configSource, key)) config[key] = taskStringArray(configSource[key], `${label}.config.${key}`)
  }
  if (Object.hasOwn(configSource, "requiresApproval")) {
    if (typeof configSource.requiresApproval !== "boolean") providerError(`${label}.config.requiresApproval is invalid`)
    config.requiresApproval = configSource.requiresApproval
  }
  return Object.freeze({
    id: source.id,
    kind: source.kind,
    title: taskText(source.title, 200, `${label}.title`, 1),
    goal: taskText(source.goal, 4_000, `${label}.goal`),
    position: Object.freeze({ x: position.x, y: position.y }),
    config: Object.freeze(config),
  })
}

function taskPlanEdge(value, index) {
  const label = `task plan edge ${index}`
  const source = plainRecord(value, label)
  exactKeys(source, new Set(["id", "source", "target", "kind", "label"]), label)
  if (!IDENTIFIER.test(source.id) || !IDENTIFIER.test(source.source) || !IDENTIFIER.test(source.target)
    || source.source === source.target || !EDGE_KINDS.has(source.kind)) providerError(`${label} is invalid`)
  return Object.freeze({
    id: source.id,
    source: source.source,
    target: source.target,
    kind: source.kind,
    ...(Object.hasOwn(source, "label") ? { label: taskText(source.label, 200, `${label}.label`) } : {}),
  })
}

export function normalizeTaskPlanSpec(value) {
  const source = plainRecord(value, "task plan spec")
  exactKeys(source, new Set(["schema", "task", "goal", "nodes", "edges"]), "task plan spec")
  if (source.schema !== "gb.task-plan.v1") providerError("Task plan schema is invalid")
  const task = plainRecord(source.task, "task plan task")
  exactKeys(task, new Set(["kind", "id", "version"]), "task plan task")
  if (task.kind !== "galaxy.ham.task" || typeof task.id !== "string" || !HAM_TASK_ID.test(task.id)) {
    providerError("Task plan HAM task identity is invalid")
  }
  if (!Array.isArray(source.nodes) || source.nodes.length < 1 || source.nodes.length > 128
    || !Array.isArray(source.edges) || source.edges.length > 512) providerError("Task plan graph is out of bounds")
  const nodes = Object.freeze(source.nodes.map(taskPlanNode))
  const edges = Object.freeze(source.edges.map(taskPlanEdge))
  const nodeIds = new Set(nodes.map((node) => node.id))
  if (nodeIds.size !== nodes.length || edges.some((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target))) {
    providerError("Task plan graph references are invalid")
  }
  if (new Set(edges.map((edge) => edge.id)).size !== edges.length) providerError("Task plan edge identifiers are invalid")
  const outgoing = new Map(nodes.map((node) => [node.id, []]))
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  for (const edge of edges) {
    outgoing.get(edge.source).push(edge.target)
    indegree.set(edge.target, indegree.get(edge.target) + 1)
  }
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  let visited = 0
  while (queue.length) {
    const current = queue.pop()
    visited += 1
    for (const target of outgoing.get(current)) {
      indegree.set(target, indegree.get(target) - 1)
      if (indegree.get(target) === 0) queue.push(target)
    }
  }
  if (visited !== nodes.length) providerError("Task plan graph contains a cycle")
  const normalized = Object.freeze({
    schema: source.schema,
    task: Object.freeze({
      kind: task.kind,
      id: task.id,
      ...(Object.hasOwn(task, "version") ? { version: integer(task.version, "task plan task version") } : {}),
    }),
    goal: taskText(source.goal, 20_000, "task plan goal", 1),
    nodes,
    edges,
  })
  if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > 512_000) providerError("Task plan exceeds the provider bound")
  return normalized
}

export function normalizeTaskPlanProviderRecord(value, expectedId, expectedTenantId) {
  const source = plainRecord(value, "task plan provider record")
  exactKeys(source, RECORD_KEYS, "task plan provider record")
  if ((expectedId !== null && source.id !== expectedId) || !UUID.test(source.id)
    || source.tenant_id !== expectedTenantId || !UUID.test(source.tenant_id)) {
    providerError("Task plan provider identity did not match the request")
  }
  if (typeof source.ham_task_id !== "string" || !HAM_TASK_ID.test(source.ham_task_id)
    || source.schema_version !== "gb.task-plan.v1" || typeof source.current_content_hash !== "string"
    || !SHA256.test(source.current_content_hash)) providerError("Task plan provider metadata is invalid")
  const spec = normalizeTaskPlanSpec(source.current_spec)
  if (spec.task.id !== source.ham_task_id) providerError("Task plan provider HAM task identity is inconsistent")
  const version = integer(source.current_version, "task plan version")
  return Object.freeze({
    objectRef: createGalaxyObjectReference("task-plan", source.id, {
      mode: "pinned", revision: `sha256:${source.current_content_hash}`,
    }),
    taskPlanId: source.id,
    title: text(source.title, 200, "task plan title", 1),
    version,
    contentHash: source.current_content_hash,
    hamTaskId: source.ham_task_id,
    hamTaskVersion: spec.task.version ?? null,
    proposalEligible: Number.isSafeInteger(spec.task.version),
    spec,
  })
}

function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedJson(value[key])]))
  }
  return value
}

function proposalOperation(value, index) {
  const source = plainRecord(value, `proposal operation ${index}`)
  if (source.op === "node.add") {
    exactKeys(source, new Set(["op", "node"]), `proposal operation ${index}`)
    const node = taskPlanNode(source.node, index)
    if (["outputRefs", "capabilities", "executorProfile", "requiresApproval", "artifactType"].some((key) => Object.hasOwn(node.config, key))) {
      providerError("Task plan proposal attempted to add execution or output authority")
    }
    if (node.config.inputRefs?.some((ref) => parseGalaxyObjectReference(ref)?.selector.mode !== "pinned")) {
      providerError("Task plan proposal input reference is not pinned")
    }
    return Object.freeze({ op: source.op, node })
  }
  if (source.op === "edge.add") {
    exactKeys(source, new Set(["op", "edge"]), `proposal operation ${index}`)
    return Object.freeze({ op: source.op, edge: taskPlanEdge(source.edge, index) })
  }
  providerError("Task plan proposal contains a non-additive operation")
}

export function normalizeTaskPlanProposalProvider(value, expected) {
  const source = plainRecord(value, "task plan proposal")
  const keys = new Set([
    "schemaId", "requestHash", "scope", "effect", "action", "base", "sourceJobIds", "inputRefs",
    "operations", "summary", "proposalHash",
  ])
  exactKeys(source, keys, "task plan proposal")
  if (source.schemaId !== "gb.task-plan-proposal.v1" || source.scope !== "task-local-work"
    || source.effect !== "proposal" || source.action !== expected.action) providerError("Task plan proposal identity is invalid")
  const expectedIntent = Object.fromEntries(
    Object.entries(expected).filter(([key]) => key !== "taskPlanId"),
  )
  const expectedRequestHash = `sha256:${createHash("sha256")
    .update(JSON.stringify(sortedJson(expectedIntent))).digest("hex")}`
  if (source.requestHash !== expectedRequestHash) providerError("Task plan proposal request binding is invalid")
  const base = plainRecord(source.base, "task plan proposal base")
  exactKeys(base, new Set([
    "taskPlanId", "taskPlanVersion", "taskPlanContentHash", "hamTaskId", "hamTaskVersion",
  ]), "task plan proposal base")
  if (base.taskPlanId !== expected.taskPlanId || base.taskPlanVersion !== expected.expectedVersion
    || base.taskPlanContentHash !== expected.expectedContentHash || base.hamTaskId !== expected.expectedHamTaskId
    || base.hamTaskVersion !== expected.expectedHamTaskVersion) providerError("Task plan proposal base did not match the request")
  const sourceJobIds = stringArray(source.sourceJobIds, 16, 128, "task plan proposal source jobs")
  if (sourceJobIds.length !== expected.sourceJobIds.length
    || sourceJobIds.some((id, index) => id !== expected.sourceJobIds[index])) providerError("Task plan proposal sources did not match the request")
  const inputRefs = stringArray(source.inputRefs, 64, 500, "task plan proposal input references", { references: true })
  if (inputRefs.some((ref) => parseGalaxyObjectReference(ref)?.selector.mode !== "pinned")) providerError("Task plan proposal input reference is not pinned")
  const expectedRefs = [...new Set([
    ...expected.inputRefs,
    ...expected.branches.flatMap((branch) => branch.inputRefs),
  ])]
  if (inputRefs.length !== expectedRefs.length || inputRefs.some((ref, index) => ref !== expectedRefs[index])) {
    providerError("Task plan proposal input references did not match the request")
  }
  if (!Array.isArray(source.operations) || source.operations.length < 2 || source.operations.length > 34) {
    providerError("Task plan proposal operations are out of bounds")
  }
  const operations = Object.freeze(source.operations.map(proposalOperation))
  if (typeof source.proposalHash !== "string" || !CONTENT_HASH.test(source.proposalHash)) providerError("Task plan proposal hash is invalid")
  const normalized = Object.freeze({
    schemaId: source.schemaId,
    requestHash: source.requestHash,
    scope: source.scope,
    effect: source.effect,
    action: source.action,
    base: Object.freeze({ ...base }),
    sourceJobIds,
    inputRefs,
    operations,
    summary: text(source.summary, 500, "task plan proposal summary", 1),
  })
  const canonical = JSON.stringify(sortedJson(normalized))
  const actualHash = `sha256:${createHash("sha256").update(canonical).digest("hex")}`
  if (source.proposalHash !== actualHash) providerError("Task plan proposal hash verification failed")
  return Object.freeze({ ...normalized, proposalHash: actualHash })
}
