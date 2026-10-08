import {
  normalizeTaskDetail,
  normalizeTaskEventPage,
  normalizeTaskPage,
} from "./ham-task-adapter.js"
import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "./galaxy-object-reference.js"
import { parseProofTaskResourceRef } from "./proof-task-graph.js"

// HAM resource prefixes are intentionally extensible, so disclosure must be
// an allowlist. Adding a new resource class here is a security decision: its
// entire reference becomes browser-visible after the class-specific check.
const ABSTRACT_RESOURCE_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/
const REPOSITORY_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]{1,100}$/
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isPinnedGalaxyObjectReference(value) {
  const reference = `gb:${value}`
  if (Array.from(reference).length > 500) return false
  const parsed = parseGalaxyObjectReference(reference)
  try {
    return parsed?.format === "canonical"
      && parsed.selector.mode === "pinned"
      && serializeGalaxyObjectReference(parsed) === reference
  } catch {
    return false
  }
}

function isRepositoryDisplayRef(value) {
  const components = value.split("/")
  if (components.length !== 2) return false
  const [owner, repository] = components
  return REPOSITORY_OWNER.test(owner)
    && REPOSITORY_NAME.test(repository)
    && repository !== "."
    && repository !== ".."
}

const PUBLIC_RESOURCE_RULES = new Map([
  ["repo", isRepositoryDisplayRef],
  ["project", (value) => ABSTRACT_RESOURCE_LABEL.test(value)],
  ["service", (value) => ABSTRACT_RESOURCE_LABEL.test(value)],
  ["surface", (value) => ABSTRACT_RESOURCE_LABEL.test(value)],
  ["paper", (value) => CANONICAL_UUID.test(value)],
  ["gb", isPinnedGalaxyObjectReference],
  ["proof-packet", (value) => Boolean(parseProofTaskResourceRef(`proof-packet:${value}`))],
  ["resource-class", (value) => ABSTRACT_RESOURCE_LABEL.test(value)],
  ["compute-class", (value) => ABSTRACT_RESOURCE_LABEL.test(value)],
  ["cost-class", (value) => ABSTRACT_RESOURCE_LABEL.test(value)],
  ["capability-class", (value) => ABSTRACT_RESOURCE_LABEL.test(value)],
])

const CANONICAL_RESOURCE_CLASS = /^[a-z][a-z0-9-]*$/
const SAFE_TASK_OR_RUN_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$/
const SAFE_AGENT_ID = /^[A-Za-z0-9._:-]{1,120}$/
const SAFE_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/
const MAX_TASK_CURSOR_LENGTH = 512

const TASK_STATES = new Set([
  "pending", "claimed", "running", "needs_clarification", "blocked",
  "completed", "cancelled", "failed", "stalled",
])
const TASK_LIFECYCLE_PHASES = new Set([
  "requested", "delivered", "claimed", "running", "waiting", "review", "terminal", "unknown",
])
const EVENT_SUMMARIES = new Map([
  ["posted", "Task requested"],
  ["offered", "Task offered"],
  ["delivery_requested", "Delivery requested"],
  ["delivered", "Task delivered"],
  ["wake_requested", "Agent wake requested"],
  ["wake_acknowledged", "Agent wake acknowledged"],
  ["claimed", "Task claimed"],
  ["reclaimed", "Task reclaimed"],
  ["accepted", "Task accepted"],
  ["run_started", "Run started"],
  ["started", "Work started"],
  ["progress", "Progress reported"],
  ["heartbeat", "Run heartbeat reported"],
  ["blocked", "Task blocked"],
  ["clarification_requested", "Clarification requested"],
  ["waiting_capacity", "Waiting for capacity"],
  ["missing_authority", "Waiting for authority"],
  ["provider_failure", "Provider failure reported"],
  ["awaiting_approval", "Waiting for approval"],
  ["stalled", "Task stalled"],
  ["handoff", "Task handed off"],
  ["review", "Task under review"],
  ["review_requested", "Review requested"],
  ["review_required", "Review required"],
  ["completed", "Task completed"],
  ["cancelled", "Task cancelled"],
  ["failed", "Task failed"],
  ["released", "Task released"],
  ["clarified", "Task clarified"],
  ["declined", "Task declined"],
])
const LIFECYCLE_SUMMARIES = new Map([
  ["requested", "Task requested"],
  ["delivered", "Task delivered"],
  ["claimed", "Task claimed"],
  ["running", "Run in progress"],
  ["waiting", "Task waiting"],
  ["review", "Task under review"],
  ["terminal", "Task finished"],
  ["unknown", "Status unavailable"],
])

function parseResourceRef(resourceRef) {
  if (typeof resourceRef !== "string") return null
  const separator = resourceRef.indexOf(":")
  if (separator <= 0) return null
  const kind = resourceRef.slice(0, separator)
  if (!CANONICAL_RESOURCE_CLASS.test(kind)) return null
  return { kind, value: resourceRef.slice(separator + 1) }
}

function disclosedResource(claim) {
  const parsed = parseResourceRef(claim.resourceRef)
  if (!parsed) return null
  const { kind, value } = parsed
  const rule = PUBLIC_RESOURCE_RULES.get(kind)
  if (rule?.(value)) {
    return { resourceRef: `${kind}:${value}`, resourceClass: kind }
  }
  return null
}

function redactedResourceType(resourceRef) {
  const kind = parseResourceRef(resourceRef)?.kind || ""
  if (["machine", "host", "node", "silo", "gpu", "device"].includes(kind)) return "compute"
  if (["path", "volume", "workspace", "container", "pod", "namespace"].includes(kind)) return "storage or runtime"
  if (["address", "endpoint", "ip", "network", "socket", "cluster"].includes(kind)) return "infrastructure"
  return "resource"
}

function projectResource(claim, index) {
  const disclosed = disclosedResource(claim)
  const status = ["active", "released", "pending"].includes(claim.status) ? claim.status : "unknown"
  if (disclosed) {
    return {
      id: `resource-${index}`,
      resourceRef: disclosed.resourceRef,
      resourceClass: disclosed.resourceClass,
      redacted: false,
      mode: claim.mode,
      status,
    }
  }
  return {
    id: `resource-${index}`,
    resourceRef: "restricted",
    resourceType: redactedResourceType(claim.resourceRef),
    resourceClass: "restricted",
    redacted: true,
    mode: claim.mode,
    status,
  }
}

function projectConflict(conflict, index) {
  const disclosed = conflict.resourceRef ? disclosedResource(conflict) : null
  const kind = ["blocking", "warning", "resource-overlap"].includes(conflict.kind)
    ? conflict.kind
    : "resource-overlap"
  const relatedTaskId = safeTaskOrRunId(conflict.relatedTaskId)
  if (!disclosed) {
    return {
      id: `conflict-${index}`,
      kind,
      summary: "A restricted resource overlaps with this task.",
      relatedTaskId,
    }
  }
  const target = relatedTaskId ? ` with task ${relatedTaskId}` : ""
  return {
    id: `conflict-${index}`,
    kind,
    summary: `${kind} conflict${target} on ${disclosed.resourceRef}.`,
    relatedTaskId,
    resourceRef: disclosed.resourceRef,
  }
}

function safeTaskOrRunId(value) {
  return typeof value === "string" && SAFE_TASK_OR_RUN_ID.test(value) ? value : undefined
}

function safeAgentId(value) {
  return typeof value === "string" && SAFE_AGENT_ID.test(value) ? value : undefined
}

function safeTimestamp(value) {
  if (typeof value !== "string") return undefined
  const match = SAFE_TIMESTAMP.exec(value)
  if (!match) return undefined
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHourText, offsetMinuteText] = match
  const year = Number.parseInt(yearText, 10)
  const month = Number.parseInt(monthText, 10)
  const day = Number.parseInt(dayText, 10)
  const hour = Number.parseInt(hourText, 10)
  const minute = Number.parseInt(minuteText, 10)
  const second = Number.parseInt(secondText, 10)
  const offsetHour = offsetHourText === undefined ? 0 : Number.parseInt(offsetHourText, 10)
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number.parseInt(offsetMinuteText, 10)
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (
    year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] ||
    hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
  ) return undefined
  return value
}

function safeCursor(value) {
  if (typeof value !== "string" || value.length > MAX_TASK_CURSOR_LENGTH) return undefined
  const separator = value.indexOf("|")
  if (separator <= 0 || separator !== value.lastIndexOf("|")) return undefined
  const timestamp = value.slice(0, separator)
  const taskId = value.slice(separator + 1)
  return timestamp[10] === "T" && safeTimestamp(timestamp) && safeTaskOrRunId(taskId) ? value : undefined
}

function safeBoundedText(value, fallback, maximumLength) {
  return typeof value === "string" && value.length <= maximumLength ? value : fallback
}

function projectEventCategory(type) {
  const summary = typeof type === "string" ? EVENT_SUMMARIES.get(type) : undefined
  return summary ? { type, summary } : { type: "event", summary: "Task event" }
}

function projectOwner(owner) {
  const principalId = safeAgentId(owner?.principalId)
  return principalId ? { principalId, label: principalId } : undefined
}

function projectActiveRun(run) {
  const id = safeTaskOrRunId(run?.id)
  if (!id) return undefined
  const status = TASK_STATES.has(run.status) ? run.status : "unknown"
  return {
    id,
    status,
    stage: LIFECYCLE_SUMMARIES.get(status === "running" ? "running" : "unknown"),
    heartbeatAt: safeTimestamp(run.heartbeatAt),
  }
}

function projectLastEvent(event) {
  if (!event) return undefined
  const category = projectEventCategory(event.type)
  return {
    ...category,
    occurredAt: safeTimestamp(event.occurredAt),
  }
}

function projectTask(task) {
  const id = safeTaskOrRunId(task.id)
  if (!id) return undefined
  const state = TASK_STATES.has(task.state) ? task.state : "unknown"
  const lifecyclePhase = TASK_LIFECYCLE_PHASES.has(task.lifecyclePhase)
    ? task.lifecyclePhase
    : "unknown"
  const lastAuthoritativeEvent = projectLastEvent(task.lastAuthoritativeEvent)
  const owner = projectOwner(task.owner)
  const activeRun = projectActiveRun(task.activeRun)
  const version = Number.isSafeInteger(task.version) && task.version > 0 ? task.version : undefined
  return {
    id,
    projectRef: ABSTRACT_RESOURCE_LABEL.test(task.projectRef || "") ? task.projectRef : undefined,
    ...(version === undefined ? {} : { version }),
    title: safeBoundedText(task.title, "Untitled task", 200),
    goal: safeBoundedText(task.goal, "No goal recorded", 4_000),
    why: safeBoundedText(task.why, "No rationale recorded", 4_000),
    state,
    lifecyclePhase,
    stage: lastAuthoritativeEvent?.summary || LIFECYCLE_SUMMARIES.get(lifecyclePhase) || "Status unavailable",
    riskMode: ["diagnostic", "test", "production"].includes(task.riskMode) ? task.riskMode : "unspecified",
    expectedEffects: task.expectedEffects.filter((value) => typeof value === "string").slice(0, 50),
    requestedByAgent: safeAgentId(task.requestedByAgent),
    owner,
    activeRun,
    resources: task.resources.map(projectResource),
    conflicts: task.conflicts.map(projectConflict),
    createdAt: safeTimestamp(task.createdAt),
    updatedAt: safeTimestamp(task.updatedAt),
    lastAuthoritativeEvent,
    projectionSource: "ham",
  }
}

export function projectHamTaskPageForBrowser(raw) {
  const page = normalizeTaskPage(raw)
  const tasks = []
  const seenIds = new Set()
  for (const task of page.tasks) {
    const projected = projectTask(task)
    if (!projected || seenIds.has(projected.id)) continue
    seenIds.add(projected.id)
    tasks.push(projected)
  }
  return {
    cursor: safeCursor(page.cursor),
    nextCursor: safeCursor(page.nextCursor),
    tasks,
  }
}

export function projectHamTaskDetailForBrowser(raw) {
  const detail = normalizeTaskDetail(raw)
  const projected = projectTask(detail)
  if (!projected) return undefined
  return {
    ...projected,
    nonGoals: detail.nonGoals.filter((value) => typeof value === "string").slice(0, 50),
    acceptanceCriteria: detail.acceptanceCriteria.filter((value) => typeof value === "string").slice(0, 50),
    // Raw source/evidence references are omitted until HAM exposes a canonical
    // display-safe reference schema that this boundary can validate exactly.
    sourceRefs: [],
  }
}

export function projectHamTaskEventPageForBrowser(raw) {
  const page = normalizeTaskEventPage(raw)
  const events = []
  const seenIds = new Set()
  for (const event of page.events) {
    const id = typeof event.id === "number"
      ? Number.isSafeInteger(event.id) && event.id > 0 ? `event-${event.id}` : undefined
      : safeTaskOrRunId(event.id)
    if (!id || seenIds.has(id)) continue
    seenIds.add(id)
    const category = projectEventCategory(event.type)
    events.push({
      id,
      sequence: Number.isSafeInteger(event.sequence) && event.sequence >= 0 ? event.sequence : undefined,
      ...category,
      occurredAt: safeTimestamp(event.occurredAt),
      actorRef: safeAgentId(event.actorRef),
      runId: safeTaskOrRunId(event.runId),
      evidenceRefs: [],
    })
  }
  return {
    cursor: page.cursor,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    events,
  }
}
