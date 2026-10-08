import { createGalaxyObjectReference, parseGalaxyObjectReference, serializeGalaxyObjectReference } from "./galaxy-object-reference.js"
import { createGalaxyObjectProjection } from "./object-projection.js"

export const AUTHORIZED_TASK_PLAN_GRAPH_SOURCE_SCHEMA_ID = "gb.authorized-task-plan-graph-source.v1"
export const AUTHORIZED_TASK_PLAN_GRAPH_SOURCE_RESULT_SCHEMA_ID = "gb.authorized-task-plan-graph-source-result.v1"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const HAM_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const NODE_KINDS = new Set([
  "context", "research", "transform", "compare", "challenge", "synthesize",
  "branch", "join", "checkpoint", "artifact",
])
const EDGE_KINDS = new Set(["control", "data", "evidence", "branch", "join"])
const PROVIDER_STATUSES = new Set(["ready", "partial", "unavailable"])
const INPUT_KEYS = new Set(["schemaId", "scope", "query", "providerStatus", "plans", "sourceLimit", "priorityRefs"])
const ENVELOPE_KEYS = new Set(["authorized", "scope", "record"])
const SCOPE_KEYS = new Set(["tenantId", "workspaceId"])
const MAX_PLANS = 200
const MAX_SOURCE_OBJECTS = 512

function invalid(message) {
  throw new TypeError(`Invalid ${AUTHORIZED_TASK_PLAN_GRAPH_SOURCE_SCHEMA_ID}: ${message}`)
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`)
  return value
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`${label}.${key} is not part of the contract`)
}

function text(value, maximum, label, minimum = 1) {
  if (typeof value !== "string" || value !== value.trim()
    || Array.from(value).length < minimum || Array.from(value).length > maximum
    || CONTROL_CHARACTERS.test(value) || /[\ud800-\udfff]/u.test(value)) invalid(`${label} is invalid`)
  return value
}

function taskPlanString(value, maximum, label, minimum = 0) {
  if (typeof value !== "string") invalid(`${label} is invalid`)
  const length = Array.from(value.trim()).length
  if (length < minimum || length > maximum) invalid(`${label} is invalid`)
  return value
}

function displayText(value, maximum, fallback = "") {
  const normalized = value.replace(/[\s\u0000-\u001f\u007f-\u009f]+/gu, " ").trim()
  const bounded = Array.from(normalized).slice(0, maximum).join("")
  return bounded || fallback
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) invalid(`${label} must be a positive integer`)
  return value
}

function normalizeScope(value, label) {
  const source = record(value, label)
  exactKeys(source, SCOPE_KEYS, label)
  const tenantId = text(source.tenantId, 64, `${label}.tenantId`).toLowerCase()
  if (!UUID.test(tenantId)) invalid(`${label}.tenantId must be a UUID`)
  return Object.freeze({ tenantId, workspaceId: text(source.workspaceId, 512, `${label}.workspaceId`) })
}

function requireScope(value, expected, label) {
  const actual = normalizeScope(value, `${label}.scope`)
  if (actual.tenantId !== expected.tenantId || actual.workspaceId !== expected.workspaceId) {
    invalid(`${label} crosses the tenant or workspace boundary`)
  }
}

function canonicalPriorityReferences(value) {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > 64) invalid("priorityRefs must be a bounded array")
  const seen = new Set()
  return Object.freeze(value.map((candidate, index) => {
    const parsed = parseGalaxyObjectReference(candidate)
    if (!parsed || parsed.format !== "canonical") invalid(`priorityRefs[${index}] must be canonical`)
    const reference = serializeGalaxyObjectReference(parsed)
    if (reference !== candidate || !["ham.task", "task-plan", "task-plan.job"].includes(parsed.kind)) {
      invalid(`priorityRefs[${index}] is unsupported`)
    }
    if (seen.has(reference)) invalid("priorityRefs contains duplicates")
    seen.add(reference)
    return reference
  }))
}

function normalizePlanRecord(value, scope, index) {
  const source = record(value, `plans[${index}].record`)
  const planId = text(source.id, 36, `plans[${index}].record.id`).toLowerCase()
  const tenantId = text(source.tenant_id, 64, `plans[${index}].record.tenant_id`).toLowerCase()
  if (!UUID.test(planId) || !UUID.test(tenantId) || tenantId !== scope.tenantId) {
    invalid(`plans[${index}].record identity is outside the authorized tenant`)
  }
  const hamTaskId = text(source.ham_task_id, 200, `plans[${index}].record.ham_task_id`)
  if (!HAM_TASK_ID.test(hamTaskId)) invalid(`plans[${index}].record.ham_task_id is invalid`)
  const title = displayText(
    taskPlanString(source.title, 200, `plans[${index}].record.title`, 1),
    200,
    "Saved Task Plan",
  )
  if (source.schema_version !== "gb.task-plan.v1") invalid(`plans[${index}].record.schema_version is unsupported`)
  const version = positiveInteger(source.current_version, `plans[${index}].record.current_version`)
  const contentHash = text(source.current_content_hash, 64, `plans[${index}].record.current_content_hash`).toLowerCase()
  if (!SHA256.test(contentHash)) invalid(`plans[${index}].record.current_content_hash must be SHA-256`)
  const spec = record(source.current_spec, `plans[${index}].record.current_spec`)
  exactKeys(spec, new Set(["schema", "task", "goal", "nodes", "edges"]), `plans[${index}].record.current_spec`)
  if (spec.schema !== "gb.task-plan.v1") invalid(`plans[${index}].record.current_spec.schema is unsupported`)
  const task = record(spec.task, `plans[${index}].record.current_spec.task`)
  exactKeys(task, new Set(["kind", "id", "version"]), `plans[${index}].record.current_spec.task`)
  if (task.kind !== "galaxy.ham.task" || task.id !== hamTaskId || !HAM_TASK_ID.test(task.id)) {
    invalid(`plans[${index}].record task identity is inconsistent`)
  }
  const taskVersion = task.version === undefined ? null : positiveInteger(task.version, `plans[${index}].record task version`)
  const goal = displayText(
    taskPlanString(spec.goal, 20_000, `plans[${index}].record.current_spec.goal`, 1),
    4_000,
    "Saved task plan",
  )
  if (!Array.isArray(spec.nodes) || spec.nodes.length < 1 || spec.nodes.length > 128) {
    invalid(`plans[${index}].record nodes are out of bounds`)
  }
  if (!Array.isArray(spec.edges) || spec.edges.length > 512) invalid(`plans[${index}].record edges are out of bounds`)
  const nodeIds = new Set()
  const nodes = Object.freeze(spec.nodes.map((candidate, nodeIndex) => {
    const node = record(candidate, `plans[${index}].record.nodes[${nodeIndex}]`)
    exactKeys(node, new Set(["id", "kind", "title", "goal", "position", "config"]), `plans[${index}].record.nodes[${nodeIndex}]`)
    if (!IDENTIFIER.test(node.id) || nodeIds.has(node.id) || !NODE_KINDS.has(node.kind)) {
      invalid(`plans[${index}].record node identity is invalid`)
    }
    nodeIds.add(node.id)
    const position = record(node.position, `plans[${index}].record.nodes[${nodeIndex}].position`)
    exactKeys(position, new Set(["x", "y"]), `plans[${index}].record.nodes[${nodeIndex}].position`)
    if (![position.x, position.y].every((axis) => typeof axis === "number" && Number.isFinite(axis) && Math.abs(axis) <= 1_000_000)) {
      invalid(`plans[${index}].record node position is invalid`)
    }
    record(node.config, `plans[${index}].record.nodes[${nodeIndex}].config`)
    return Object.freeze({
      id: node.id,
      kind: node.kind,
      title: displayText(
        taskPlanString(node.title, 200, `plans[${index}].record.nodes[${nodeIndex}].title`, 1),
        200,
        "Task Plan job",
      ),
      goal: displayText(
        taskPlanString(node.goal, 4_000, `plans[${index}].record.nodes[${nodeIndex}].goal`),
        4_000,
      ),
    })
  }))
  const edgeIds = new Set()
  const edges = Object.freeze(spec.edges.map((candidate, edgeIndex) => {
    const edge = record(candidate, `plans[${index}].record.edges[${edgeIndex}]`)
    exactKeys(edge, new Set(["id", "source", "target", "kind", "label"]), `plans[${index}].record.edges[${edgeIndex}]`)
    if (!IDENTIFIER.test(edge.id) || edgeIds.has(edge.id) || !IDENTIFIER.test(edge.source) || !IDENTIFIER.test(edge.target)
      || edge.source === edge.target || !EDGE_KINDS.has(edge.kind) || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      invalid(`plans[${index}].record edge is invalid`)
    }
    edgeIds.add(edge.id)
    return Object.freeze({ id: edge.id, source: edge.source, target: edge.target, kind: edge.kind })
  }))
  const outgoing = new Map(nodes.map((node) => [node.id, []]))
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  edges.forEach((edge) => {
    outgoing.get(edge.source).push(edge.target)
    indegree.set(edge.target, indegree.get(edge.target) + 1)
  })
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
  if (visited !== nodes.length) invalid(`plans[${index}].record graph contains a cycle`)
  const updatedAt = text(source.updated_at, 64, `plans[${index}].record.updated_at`)
  const updatedEpoch = Date.parse(updatedAt)
  if (!Number.isFinite(updatedEpoch)) invalid(`plans[${index}].record.updated_at is invalid`)
  const revision = `sha256:${contentHash}`
  const planRef = createGalaxyObjectReference("task-plan", planId, { mode: "pinned", revision })
  const taskRef = createGalaxyObjectReference("ham.task", hamTaskId)
  const jobRefs = new Map(nodes.map((node) => [node.id, createGalaxyObjectReference(
    "task-plan.job",
    `${planId}/${node.id}`,
    { mode: "pinned", revision },
  )]))
  return Object.freeze({
    planId, title, version, contentHash, revision, planRef, taskRef, taskVersion,
    goal, nodes, edges, jobRefs, updatedAt, updatedEpoch,
  })
}

function projection(ref, kind, title, summary, sourceId, version, contentHash, statement) {
  return createGalaxyObjectProjection({
    schemaId: "gb.object-projection.v1",
    ref,
    kind,
    revision: { policy: "pinned", id: `sha256:${contentHash}`, contentHash },
    title,
    ...(summary ? { summary } : {}),
    mediaType: kind === "task-plan"
      ? "application/vnd.galaxy.task-plan+json"
      : "application/vnd.galaxy.task-plan.job+json",
    representations: [],
    provenance: {
      provider: "galaxy.task-plan",
      sourceId,
      sourceRevision: `version:${version};sha256:${contentHash}`,
      statement,
    },
    capabilities: ["open", "inspect", "relate", "branch"],
  })
}

function relation(scope, fromRef, toRef, relationKind, plan, recordId, resourceMode) {
  return Object.freeze({
    scope,
    relation: Object.freeze({
      fromRef,
      toRef,
      relation: relationKind,
      trust: "structure",
      source: Object.freeze({
        provider: "galaxy.task-plan",
        recordId,
        revision: plan.revision,
        sourceRef: plan.planRef,
        resourceMode,
      }),
    }),
  })
}

function planMatchesPriority(plan, priorityRefs) {
  if (priorityRefs.has(plan.planRef) || priorityRefs.has(plan.taskRef)) return true
  for (const ref of plan.jobRefs.values()) if (priorityRefs.has(ref)) return true
  return false
}

export function buildAuthorizedTaskPlanGraphSource(input) {
  const source = record(input, "input")
  exactKeys(source, INPUT_KEYS, "input")
  if (source.schemaId !== AUTHORIZED_TASK_PLAN_GRAPH_SOURCE_SCHEMA_ID) invalid("unsupported schemaId")
  const scope = normalizeScope(source.scope, "scope")
  const providerStatus = text(source.providerStatus, 40, "providerStatus")
  if (!PROVIDER_STATUSES.has(providerStatus)) invalid("providerStatus is unsupported")
  const sourceLimit = source.sourceLimit === undefined ? 256 : positiveInteger(source.sourceLimit, "sourceLimit")
  if (sourceLimit < 2 || sourceLimit > MAX_SOURCE_OBJECTS) invalid(`sourceLimit must be between 2 and ${MAX_SOURCE_OBJECTS}`)
  const priorityRefs = canonicalPriorityReferences(source.priorityRefs)
  if (!Array.isArray(source.plans) || source.plans.length > MAX_PLANS) invalid("plans must be a bounded array")
  let unauthorized = 0
  const normalized = []
  source.plans.forEach((value, index) => {
    const envelope = record(value, `plans[${index}]`)
    exactKeys(envelope, ENVELOPE_KEYS, `plans[${index}]`)
    requireScope(envelope.scope, scope, `plans[${index}]`)
    if (envelope.authorized !== true) {
      unauthorized += 1
      return
    }
    normalized.push(normalizePlanRecord(envelope.record, scope, index))
  })
  const byPlanId = new Set()
  normalized.forEach((plan) => {
    if (byPlanId.has(plan.planId)) invalid(`plans contains duplicate ${plan.planId}`)
    byPlanId.add(plan.planId)
  })
  const prioritySet = new Set(priorityRefs)
  normalized.sort((left, right) => (
    Number(planMatchesPriority(right, prioritySet)) - Number(planMatchesPriority(left, prioritySet))
    || right.updatedEpoch - left.updatedEpoch
    || left.planRef.localeCompare(right.planRef)
  ))
  const included = []
  let usedObjects = 0
  let omittedPlans = 0
  let omittedObjects = 0
  normalized.forEach((plan) => {
    const required = 1 + plan.nodes.length
    if (usedObjects + required > sourceLimit) {
      omittedPlans += 1
      omittedObjects += required
      return
    }
    included.push(plan)
    usedObjects += required
  })
  const objects = []
  const relations = []
  included.forEach((plan) => {
    objects.push(Object.freeze({
      scope,
      projection: projection(
        plan.planRef, "task-plan", plan.title, plan.goal, plan.planId,
        plan.version, plan.contentHash, "Authorized immutable saved task-plan revision.",
      ),
    }))
    relations.push(relation(scope, plan.taskRef, plan.planRef, "contains", plan, `task-plan:${plan.planId}`, "task-plan"))
    plan.nodes.forEach((node) => {
      const jobRef = plan.jobRefs.get(node.id)
      objects.push(Object.freeze({
        scope,
        projection: projection(
          jobRef, "task-plan.job", node.title,
          displayText(`${node.kind}: ${node.goal || "No job goal supplied."}`, 4_000, node.kind),
          `${plan.planId}/${node.id}`, plan.version, plan.contentHash,
          `Authorized task-local ${node.kind} job from an immutable saved plan.`,
        ),
      }))
      relations.push(relation(scope, plan.planRef, jobRef, "contains", plan, `job:${node.id}`, node.kind))
    })
    plan.edges.forEach((edge) => {
      const sourceRef = plan.jobRefs.get(edge.source)
      const targetRef = plan.jobRefs.get(edge.target)
      if (["control", "data", "evidence"].includes(edge.kind)) {
        relations.push(relation(scope, targetRef, sourceRef, "depends_on", plan, edge.id, edge.kind))
      } else if (edge.kind === "branch") {
        relations.push(relation(scope, sourceRef, targetRef, "forks", plan, edge.id, edge.kind))
      } else {
        relations.push(relation(scope, sourceRef, targetRef, "joins", plan, edge.id, edge.kind))
      }
    })
  })
  const hasMore = omittedPlans > 0
  const effectiveStatus = providerStatus === "unavailable"
    ? "unavailable"
    : providerStatus === "partial" || hasMore ? "partial" : "ready"
  return Object.freeze({
    schemaId: AUTHORIZED_TASK_PLAN_GRAPH_SOURCE_RESULT_SCHEMA_ID,
    graphInput: Object.freeze({
      schemaId: "gb.graph-projection-input.v1",
      scope,
      query: source.query,
      objects: Object.freeze(objects),
      relations: Object.freeze(relations),
      providers: Object.freeze([Object.freeze({
        scope,
        provider: "galaxy.task-plan",
        status: effectiveStatus,
        revision: `included:${included.length};objects:${usedObjects};limit:${sourceLimit}`,
      })]),
    }),
    sourceContinuation: Object.freeze({
      hasMore,
      omittedPlans,
      omittedObjects,
      reasons: Object.freeze(hasMore ? ["source-limit"] : []),
    }),
    diagnostics: Object.freeze({ unauthorized }),
  })
}
