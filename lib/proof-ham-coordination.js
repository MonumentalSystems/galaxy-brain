import { parseGalaxyObjectReference } from "./galaxy-object-reference.js"
import { projectTaskObject } from "./object-projection-adapters.js"
import { parseProofTaskResourceRef } from "./proof-task-graph.js"

export const PROOF_HAM_COORDINATION_SCHEMA_ID = "gb.proof-ham-coordination.v1"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256 = /^[0-9a-f]{64}$/u
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const MAX_ITEMS = 10_000

function invalid(message) {
  throw new TypeError(`Invalid ${PROOF_HAM_COORDINATION_SCHEMA_ID}: ${message}`)
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`)
  return value
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${label}.${key} is not part of the contract`)
  }
}

function boundedText(value, maximum, label) {
  if (typeof value !== "string") invalid(`${label} must be text`)
  const normalized = value.trim()
  if (!normalized || Array.from(normalized).length > maximum || CONTROL_CHARACTERS.test(normalized)) {
    invalid(`${label} is outside its bounded text contract`)
  }
  return normalized
}

function normalizeScope(value, label) {
  const source = record(value, label)
  exactKeys(source, new Set(["tenantId", "workspaceId"]), label)
  const tenantId = boundedText(source.tenantId, 64, `${label}.tenantId`)
  if (!UUID.test(tenantId)) invalid(`${label}.tenantId must be a UUID`)
  return Object.freeze({
    tenantId: tenantId.toLowerCase(),
    workspaceId: boundedText(source.workspaceId, 512, `${label}.workspaceId`),
  })
}

function requireScope(value, expected, label) {
  const actual = normalizeScope(value, `${label}.scope`)
  if (actual.tenantId !== expected.tenantId || actual.workspaceId !== expected.workspaceId) {
    invalid(`${label} crosses the tenant or workspace boundary`)
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
}

function normalizeBinding(value, index, scope) {
  const label = `bindings[${index}]`
  const binding = record(value, label)
  exactKeys(binding, new Set([
    "scope", "graphId", "nodeId", "nodeRef", "taskId", "linkedTaskCount", "resourceRef",
  ]), label)
  if (binding.scope !== undefined) requireScope(binding.scope, scope, label)
  const nodeRef = boundedText(binding.nodeRef, 16_384, `${label}.nodeRef`)
  const parsedNode = parseGalaxyObjectReference(nodeRef)
  if (!parsedNode || parsedNode.format !== "canonical" || parsedNode.kind !== "proof.node"
    || parsedNode.selector.mode !== "pinned" || !parsedNode.selector.revision.startsWith("sha256:")
    || !SHA256.test(parsedNode.selector.revision.slice("sha256:".length))) {
    invalid(`${label}.nodeRef must be a pinned proof node reference`)
  }
  const resourceRef = boundedText(binding.resourceRef, 500, `${label}.resourceRef`)
  const parsedResource = parseProofTaskResourceRef(resourceRef)
  if (!parsedResource || parsedResource.contentSha256 === null
    || parsedResource.contentSha256 !== parsedNode.selector.revision.slice("sha256:".length)) {
    invalid(`${label}.resourceRef must be bound to the proof node revision`)
  }
  const nodeId = boundedText(binding.nodeId, 512, `${label}.nodeId`)
  const graphId = boundedText(binding.graphId, 512, `${label}.graphId`)
  if (parsedResource.packetId !== nodeId) invalid(`${label}.resourceRef must name nodeId`)
  if (parsedResource.programId !== graphId) invalid(`${label}.resourceRef must name graphId`)
  if (!Number.isSafeInteger(binding.linkedTaskCount) || binding.linkedTaskCount < 0) {
    invalid(`${label}.linkedTaskCount must be a non-negative safe integer`)
  }
  return Object.freeze({
    graphId,
    nodeId,
    nodeRef,
    taskId: boundedText(binding.taskId, 200, `${label}.taskId`),
    linkedTaskCount: binding.linkedTaskCount,
    resourceRef,
  })
}

function activeResource(task, binding) {
  const resources = Array.isArray(task.resources) ? task.resources : []
  return resources.find((resource) => (
    resource && typeof resource === "object"
    && resource.redacted !== true
    && resource.status === "active"
    && resource.resourceRef === binding.resourceRef
    && parseProofTaskResourceRef(resource.resourceRef)?.contentSha256 !== null
  )) || null
}

/**
 * Derive read-only proof-to-HAM coordination edges from already-authorized
 * browser task projections. A task ID in mutable proof work state is only a
 * lookup hint; the exact active proof-packet resource is the binding proof.
 */
export function joinAuthorizedProofHamCoordination(input) {
  const source = record(input, "input")
  exactKeys(source, new Set(["schemaId", "scope", "bindings", "tasks"]), "input")
  if (source.schemaId !== PROOF_HAM_COORDINATION_SCHEMA_ID) invalid("unsupported schemaId")
  const scope = normalizeScope(source.scope, "scope")
  if (!Array.isArray(source.bindings) || source.bindings.length > MAX_ITEMS) {
    invalid("bindings must be a bounded array")
  }
  if (!Array.isArray(source.tasks) || source.tasks.length > MAX_ITEMS) {
    invalid("tasks must be a bounded array")
  }

  const bindings = source.bindings.map((binding, index) => normalizeBinding(binding, index, scope))
  const tasksById = new Map()
  let unauthorizedTasks = 0
  source.tasks.forEach((value, index) => {
    const label = `tasks[${index}]`
    const item = record(value, label)
    exactKeys(item, new Set(["authorized", "scope", "task"]), label)
    requireScope(item.scope, scope, label)
    if (item.authorized !== true) {
      unauthorizedTasks += 1
      return
    }
    const task = record(item.task, `${label}.task`)
    const taskId = boundedText(task.id, 200, `${label}.task.id`)
    const prior = tasksById.get(taskId)
    if (prior && stableStringify(prior) !== stableStringify(task)) {
      invalid(`${label}.task conflicts with another authorized task ${taskId}`)
    }
    tasksById.set(taskId, task)
  })

  const relationByKey = new Map()
  let missingTasks = 0
  let resourceMismatches = 0
  for (const binding of bindings) {
    const task = tasksById.get(binding.taskId)
    if (!task) {
      missingTasks += 1
      continue
    }
    const resource = activeResource(task, binding)
    if (!resource) {
      resourceMismatches += 1
      continue
    }
    const taskProjection = projectTaskObject(task)
    const parsedTask = parseGalaxyObjectReference(taskProjection.ref)
    if (!parsedTask || parsedTask.format !== "canonical" || parsedTask.kind !== "ham.task"
      || parsedTask.selector.mode !== "latest" || parsedTask.id !== binding.taskId) {
      invalid(`authorized task ${binding.taskId} changed canonical identity`)
    }
    const relation = Object.freeze({
      scope,
      relation: Object.freeze({
        fromRef: binding.nodeRef,
        toRef: taskProjection.ref,
        relation: "coordinated_by",
        trust: "structure",
        source: Object.freeze(Object.fromEntries(Object.entries({
          provider: "galaxy.proof-work",
          recordId: typeof resource.id === "string" && resource.id.trim() ? resource.id.trim() : binding.taskId,
          revision: Number.isSafeInteger(task.version) && task.version > 0 ? `version:${task.version}` : undefined,
          sourceRef: binding.resourceRef,
          resourceMode: typeof resource.mode === "string" ? resource.mode : undefined,
          resourceStatus: typeof resource.status === "string" ? resource.status : undefined,
        }).filter(([, item]) => item !== undefined))),
      }),
    })
    relationByKey.set(`${binding.nodeRef}\u0000${taskProjection.ref}`, relation)
  }

  return Object.freeze({
    schemaId: PROOF_HAM_COORDINATION_SCHEMA_ID,
    relations: Object.freeze([...relationByKey.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, relation]) => relation)),
    diagnostics: Object.freeze({
      unauthorizedTasks,
      missingTasks,
      resourceMismatches,
      linked: relationByKey.size,
    }),
  })
}
