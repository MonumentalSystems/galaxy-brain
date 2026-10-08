import { createHash } from "node:crypto"

import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "./galaxy-object-reference.js"

export const HAM_TASK_STATUSES = Object.freeze([
  "pending", "claimed", "running", "needs_clarification", "blocked",
  "completed", "cancelled", "failed", "stalled",
])

// HAM permits a 1 MiB canonical program directive. The detail envelope also
// carries the assignment wrapper and bounded task metadata.
export const HAM_TASK_DETAIL_RESPONSE_MAX_BYTES = 2_097_152
export const HAM_TASK_EVENTS_RESPONSE_MAX_BYTES = 4_194_304

export function buildHamTaskCreateBody({
  title,
  goal,
  rationale,
  activityMode,
  requesterRef,
  idempotencyKey,
  resources,
  acceptanceCriteria = /** @type {string[]} */ ([]),
}) {
  return {
    title,
    goal,
    rationale,
    activity_mode: activityMode,
    acceptance_criteria: acceptanceCriteria,
    resources,
    requester_ref: requesterRef,
    idempotency_key: idempotencyKey,
  }
}

export function namespaceHamTaskIdempotencyKey(userId, clientKey) {
  if (typeof userId !== "string" || !userId.trim()) throw new Error("userId is required")
  if (typeof clientKey !== "string" || !clientKey.trim() || clientKey.length > 200) {
    throw new Error("Idempotency-Key must contain 1 to 200 characters")
  }
  const digest = createHash("sha256")
    .update(userId)
    .update("\0")
    .update(clientKey)
    .digest("hex")
  return `galaxy-brain:${digest}`
}

export function parseHamTaskActivityMode(value) {
  const mode = String(value)
  if (!["diagnostic", "test", "production"].includes(mode)) {
    throw new Error("Activity mode is invalid.")
  }
  return mode
}

export function parseHamTaskExpectedVersion(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Expected task version must be a positive safe integer.")
  }
  return value
}

export function parseHamTaskAcceptanceCriteria(raw) {
  const criteria = Array.isArray(raw)
    ? raw.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean)
    : []
  if (criteria.length > 50 || Buffer.byteLength(JSON.stringify(criteria), "utf8") > 8_000) {
    throw new Error("Acceptance criteria exceed the allowed size.")
  }
  return criteria
}

const RESOURCE_KEY_PATTERN = /^[A-Za-z0-9._:/\\-]+$/
const RESOURCE_MODES = new Set(["observe", "read", "write", "exclusive"])

function isCanonicalGalaxyObjectResource(key) {
  const parsed = parseGalaxyObjectReference(key)
  return parsed?.format === "canonical" && serializeGalaxyObjectReference(parsed) === key
}

export function parseHamTaskResources(rawKeys, mode) {
  if (!RESOURCE_MODES.has(mode)) throw new Error("Resource access mode is invalid.")
  const lines = Array.isArray(rawKeys) ? rawKeys : String(rawKeys || "").split(/\r?\n/)
  const keys = lines.map((item) => String(item).trim()).filter(Boolean)
  if (keys.length > 50) throw new Error("A task can declare at most 50 affected resources.")
  const seen = new Set()
  return keys.map((key) => {
    if (
      key.length > 500
      || (!RESOURCE_KEY_PATTERN.test(key) && !isCanonicalGalaxyObjectResource(key))
    ) {
      throw new Error(`Invalid resource key: ${key}. Use letters, numbers, dot, underscore, colon, slash, backslash, or hyphen.`)
    }
    const folded = key.toLowerCase()
    if (seen.has(folded)) throw new Error(`Duplicate resource key: ${key}.`)
    seen.add(folded)
    return { key, mode }
  })
}

export function parseHumanTaskResources(rawKeys, mode) {
  const resources = parseHamTaskResources(rawKeys, mode)
  const reserved = resources.find(({ key }) => key.toLowerCase().startsWith("proof-packet:"))
  if (reserved) {
    throw new Error("The proof-packet resource namespace is reserved for exact-directive Hyades dispatch.")
  }
  return resources
}

export function buildHamTaskPageBody(project, cursor, limit) {
  return { project, statuses: [...HAM_TASK_STATUSES], cursor, limit }
}

export function buildHamTaskEventsBody(project, taskId, afterEventId = 0, limit) {
  return {
    project,
    task_id: taskId,
    after_event_id: afterEventId,
    limit,
  }
}
