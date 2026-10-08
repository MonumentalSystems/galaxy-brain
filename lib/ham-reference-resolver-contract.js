import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "./galaxy-object-reference.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MEMORY_ID = /^[1-9][0-9]{0,15}$/
const TASK_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$/
const MAX_REFERENCES = 128

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`)
  }
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains unsupported fields.`)
  }
  return value
}

function uuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error(`${label} must be a UUID.`)
  }
  return value.toLowerCase()
}

/**
 * Validate the server-to-server batch resolver envelope. Unsupported canonical
 * provider kinds remain in the request but receive no decision; that is the
 * protocol's fail-closed denial signal.
 */
export function parseHamReferenceResolutionRequest(input, configuredTenant) {
  const source = exactObject(
    input,
    ["schema", "references", "tenant_id", "principal_id", "operation"],
    "Resolver request",
  )
  if (source.schema !== "gb.referent-resolution-batch.v1" || source.operation !== "read") {
    throw new Error("Resolver schema or operation is invalid.")
  }
  const tenantId = uuid(source.tenant_id, "Tenant")
  const principalId = uuid(source.principal_id, "Principal")
  const expectedTenant = uuid(configuredTenant, "Configured tenant")
  if (tenantId !== expectedTenant) throw new Error("Resolver tenant is not authorized.")
  if (!Array.isArray(source.references) || source.references.length < 1 || source.references.length > MAX_REFERENCES) {
    throw new Error(`Resolver references must contain between 1 and ${MAX_REFERENCES} items.`)
  }

  const seen = new Set()
  const references = source.references.map((wire, index) => {
    const parsed = parseGalaxyObjectReference(wire)
    if (!parsed || parsed.format !== "canonical" || serializeGalaxyObjectReference(parsed) !== wire) {
      throw new Error(`Reference ${index + 1} is not canonical.`)
    }
    if (seen.has(wire)) throw new Error("Resolver references must be unique.")
    seen.add(wire)
    const memory = parsed.kind === "ham.memory"
      && parsed.selector.mode === "latest"
      && MEMORY_ID.test(parsed.id)
    const task = parsed.kind === "ham.task"
      && parsed.selector.mode === "latest"
      && TASK_ID.test(parsed.id)
    return {
      wire,
      id: parsed.id,
      resolvable: memory || task,
      providerKind: memory ? "memory" : task ? "task" : null,
      resolvedRevision: null,
    }
  })

  return { tenantId, principalId, references }
}

export function createHamReferenceDecision(request, reference) {
  if (!reference?.resolvable) throw new Error("Only readable HAM references receive decisions.")
  return {
    reference: reference.wire,
    tenant_id: request.tenantId,
    principal_id: request.principalId,
    readable: true,
    resolved_revision: reference.resolvedRevision,
    provider: "ham",
  }
}

export function resolveHamReferenceTenant(memoryTenant, taskTenant) {
  const memory = typeof memoryTenant === "string" && UUID.test(memoryTenant)
    ? memoryTenant.toLowerCase()
    : null
  const task = typeof taskTenant === "string" && UUID.test(taskTenant)
    ? taskTenant.toLowerCase()
    : null
  if ((memoryTenant && !memory) || (taskTenant && !task) || (memory && task && memory !== task)) return null
  return memory || task
}

/**
 * Check the minimum authoritative fields returned by HAM's exact task route.
 * No aliases are accepted here: a latest reference remains bound to the exact
 * task id while the returned positive version proves this is a task detail.
 * Historical versions are deliberately unsupported until HAM exposes an exact
 * historical read endpoint.
 */
export function isExactHamTaskResolution(reference, payload) {
  if (reference?.providerKind !== "task" || !reference.resolvable) return false
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false
  return payload.task_id === reference.id
    && Number.isSafeInteger(payload.version)
    && payload.version > 0
}

export function assertHamReferenceProviders(request, providers) {
  if (!request || !Array.isArray(request.references) || !providers || typeof providers !== "object") {
    throw new Error("HAM reference provider is unavailable")
  }
  const needsMemory = request.references.some((reference) => reference.resolvable && reference.providerKind === "memory")
  const needsTask = request.references.some((reference) => reference.resolvable && reference.providerKind === "task")
  if (
    (needsMemory && (!providers.memoryTenant || !providers.memoryBaseUrl || !providers.memoryBearer))
    || (needsTask && (
      typeof providers.taskTenant !== "string"
      || providers.taskTenant.toLowerCase() !== request.tenantId
      || !providers.taskConfig?.baseUrl
      || !providers.taskConfig?.bearerToken
    ))
  ) throw new Error("HAM reference provider is unavailable")
}
