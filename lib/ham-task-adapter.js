/** @typedef {import("./types/tasks").TaskSummary} TaskSummary */
/** @typedef {import("./types/tasks").TaskDetail} TaskDetail */
/** @typedef {import("./types/tasks").TaskEvent} TaskEvent */

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback
}

function identifier(value, fallback = "") {
  return typeof value === "string" ? value : fallback
}

function integer(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function positiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function list(value) {
  return Array.isArray(value) ? value : []
}

function first(...values) {
  return values.find((value) => value !== undefined && value !== null)
}

const TASK_LIFECYCLE_PHASES = new Set([
  "requested", "delivered", "claimed", "running", "waiting", "review", "terminal", "unknown",
])

function stringList(value) {
  return list(value)
    .filter((item) => typeof item === "string")
    .filter(Boolean)
}

function normalizeOwner(raw) {
  if (typeof raw === "string" && raw.trim()) {
    return { principalId: raw.trim(), label: raw.trim() }
  }
  const source = record(raw)
  const principalId = text(first(source.principal_id, source.principalId, source.id))
  if (!principalId) return undefined
  return {
    principalId,
    label: text(first(source.label, source.display_name, source.displayName), principalId),
  }
}

function normalizeRun(raw) {
  const source = record(raw)
  const id = text(first(source.id, source.run_id, source.runId))
  if (!id) return undefined
  return {
    id,
    status: text(first(source.status, source.state), "unknown"),
    stage: text(first(source.intent, source.stage, source.current_stage, source.currentStage, source.status)) || undefined,
    heartbeatAt: text(
      first(source.last_progress_at, source.lastProgressAt, source.updated_at, source.updatedAt),
    ) || undefined,
  }
}

export function taskLifecyclePhase(state, eventType = "") {
  const normalizedState = text(state, "unknown").toLowerCase().replaceAll("-", "_")
  const normalizedEvent = text(eventType).toLowerCase().replaceAll("-", "_")
  if (["completed", "cancelled", "failed", "done"].includes(normalizedState)) return "terminal"
  if (["blocked", "needs_clarification", "stalled", "awaiting_approval", "needs_input"].includes(normalizedState)) return "waiting"
  if (normalizedState === "running") return "running"
  if (["claimed", "accepted"].includes(normalizedState)) return "claimed"
  if (["handoff", "review", "review_requested", "review_required"].includes(normalizedEvent)) return "review"
  if (["run_started", "started", "progress", "heartbeat"].includes(normalizedEvent)) return "running"
  if (["claimed", "reclaimed", "accepted"].includes(normalizedEvent)) return "claimed"
  if ([
    "blocked", "clarification_requested", "waiting_capacity", "missing_authority",
    "provider_failure", "awaiting_approval", "stalled",
  ].includes(normalizedEvent)) return "waiting"
  if (["delivered", "delivery_requested", "wake_requested", "wake_acknowledged"].includes(normalizedEvent)) return "delivered"
  if (["pending", "posted", "declined", "released", "clarified", "offered"].includes(normalizedState) ||
      ["posted", "declined", "released", "clarified", "offered"].includes(normalizedEvent)) return "requested"
  return "unknown"
}

function normalizeResources(raw) {
  return list(raw).map((item, index) => {
    const source = record(item)
    const mode = text(first(source.mode, source.access_mode, source.accessMode), "read")
    return {
      id: text(source.id, `resource-${index}`),
      resourceRef: text(first(source.resource_ref, source.resourceRef, source.ref, source.key), "unknown-resource"),
      resourceType: text(first(source.resource_type, source.resourceType, source.type)) || undefined,
      resourceClass: text(first(source.resource_class, source.resourceClass)) || undefined,
      redacted: source.redacted === true,
      mode: ["observe", "read", "write", "exclusive"].includes(mode) ? mode : "read",
      status: text(source.status, "active"),
      runId: text(first(source.run_id, source.runId)) || undefined,
    }
  })
}

function normalizeConflicts(raw) {
  return list(raw).map((item, index) => {
    const source = record(item)
    const relatedTaskId = text(first(source.related_task_id, source.relatedTaskId, source.task_id)) || undefined
    const resourceRef = text(first(source.resource_ref, source.resourceRef, source.resource_key)) || undefined
    const relatedTitle = text(source.title, relatedTaskId || "another task")
    const requestedMode = text(source.requested_mode)
    const activeMode = text(source.active_mode)
    const fallbackSummary = resourceRef
      ? `${text(source.severity, "Potential")} ${requestedMode || "resource"} conflict with ${relatedTitle} (${activeMode || "active"} on ${resourceRef})`
      : `Potential work conflict with ${relatedTitle}`
    return {
      id: text(source.id, `conflict-${index}`),
      kind: text(first(source.kind, source.severity), "resource-overlap"),
      summary: text(first(source.summary, source.message), fallbackSummary),
      relatedTaskId,
      resourceRef,
    }
  })
}

/** @returns {TaskSummary} */
export function normalizeTask(raw) {
  const source = record(raw)
  const objective = record(source.objective)
  const lifecycle = record(source.lifecycle)
  const projection = record(first(source.current_projection, source.currentProjection))
  const latestEvent = record(first(source.latest_event, source.latestEvent, projection.latest_event))
  const activeRun = normalizeRun(
    first(source.run, source.current_run, source.currentRun, source.active_run, source.activeRun, projection.active_run, projection.activeRun),
  )
  const owner = normalizeOwner(
    first(source.claimed_by_agent, source.claimedByAgent, source.owner, source.claimed_by, source.claimedBy, projection.owner),
  )
  const rationale = text(first(source.why, source.rationale, source.request_reason, projection.why), "No rationale recorded")
  const rationaleMode = /^Activity mode:\s*(diagnostic|test|production)\s*\n+/i.exec(rationale)
  const riskMode = text(
    first(
      source.activity_mode,
      source.activityMode,
      source.risk_mode,
      source.riskMode,
      projection.activity_mode,
      projection.activityMode,
      projection.risk_mode,
      projection.riskMode,
      rationaleMode?.[1],
    ),
    "unspecified",
  ).toLowerCase()
  const state = text(first(source.state, source.status, lifecycle.state), "unknown")
  const eventType = text(first(latestEvent.type, latestEvent.event_type, latestEvent.eventType))
  const eventSummary = text(first(latestEvent.summary, latestEvent.message, eventType), "Task event")
  const reportedLifecyclePhase = text(first(source.lifecyclePhase, source.lifecycle_phase))
  const lifecyclePhase = TASK_LIFECYCLE_PHASES.has(reportedLifecyclePhase)
    ? reportedLifecyclePhase
    : taskLifecyclePhase(state, eventType)

  return {
    id: identifier(first(source.id, source.task_id, source.taskId)),
    projectRef: text(first(source.project_ref, source.projectRef, source.project, source.project_id)) || undefined,
    version: positiveInteger(first(source.version, source.revision)),
    title: text(source.title, "Untitled task"),
    goal: text(first(source.goal, source.objective_statement, objective.statement, projection.goal), "No goal recorded"),
    why: rationaleMode ? rationale.slice(rationaleMode[0].length).trim() : rationale,
    state,
    lifecyclePhase,
    stage: text(
      first(latestEvent.summary, latestEvent.event_type, source.stage, source.phase, lifecycle.phase, projection.stage),
      activeRun?.stage || "Not started",
    ),
    riskMode: ["diagnostic", "test", "production"].includes(riskMode) ? riskMode : "unspecified",
    expectedEffects: stringList(first(source.expected_effects, source.expectedEffects, projection.expected_effects)),
    requestedByAgent: text(first(source.requested_by_agent, source.requestedByAgent)) || undefined,
    owner,
    activeRun,
    resources: normalizeResources(first(source.resource_claims, source.resourceClaims, source.resources, projection.resource_claims)),
    conflicts: normalizeConflicts(first(source.conflicts, projection.conflicts)),
    createdAt: text(first(source.created_at, source.createdAt)) || undefined,
    updatedAt: text(
      first(latestEvent.occurred_at, latestEvent.occurredAt, source.updated_at, source.updatedAt, projection.updated_at),
    ) || undefined,
    lastAuthoritativeEvent: eventType ? {
      type: eventType,
      summary: eventSummary,
      occurredAt: text(first(latestEvent.occurred_at, latestEvent.occurredAt)) || undefined,
    } : undefined,
    projectionSource: "ham",
  }
}

/** @returns {TaskDetail} */
export function normalizeTaskDetail(raw) {
  const source = record(raw)
  const objective = record(source.objective)
  return {
    ...normalizeTask(source),
    nonGoals: stringList(first(source.non_goals, source.nonGoals, objective.nonGoals, objective.non_goals)),
    acceptanceCriteria: stringList(first(source.acceptance_criteria, source.acceptanceCriteria)),
    sourceRefs: stringList(first(source.source_refs, source.sourceRefs)),
    requesterRef: text(first(source.requester_ref, source.requesterRef)) || undefined,
  }
}

export function normalizeTaskPage(raw) {
  const source = record(raw)
  const items = Array.isArray(raw) ? raw : first(source.items, source.tasks, source.results, [])
  return {
    tasks: list(items).map(normalizeTask),
    cursor: text(first(source.cursor, source.current_cursor, source.currentCursor)) || undefined,
    nextCursor: text(first(source.next_cursor, source.nextCursor)) || undefined,
  }
}

/** @returns {TaskEvent} */
export function normalizeTaskEvent(raw) {
  const source = record(raw)
  const rawId = first(source.id, source.event_id, source.eventId)
  return {
    id: typeof rawId === "string" ? rawId : integer(rawId),
    sequence: integer(first(source.sequence, source.event_id, source.eventId)),
    type: text(first(source.type, source.event_type, source.eventType), "event"),
    occurredAt: text(first(source.occurred_at, source.occurredAt, source.created_at, source.createdAt)) || undefined,
    actorRef: text(
      first(source.actor_agent_id, source.actorAgentId, source.actor_ref, source.actorRef),
    ) || undefined,
    runId: text(first(source.run_id, source.runId)) || undefined,
    summary: text(first(source.summary, source.message), "Task event"),
    // Evidence is intentionally not normalized into the first browser slice.
    // A later evidence surface needs its own canonical reference contract.
    evidenceRefs: [],
  }
}

export function normalizeTaskEventPage(raw) {
  const source = record(raw)
  const items = Array.isArray(raw) ? raw : first(source.items, source.events, source.results, [])
  const hasMore = first(source.has_more, source.hasMore)
  return {
    events: list(items).map(normalizeTaskEvent),
    cursor: integer(first(source.cursor, source.current_cursor, source.currentCursor)),
    nextCursor: integer(first(source.next_cursor, source.nextCursor)),
    hasMore: typeof hasMore === "boolean" ? hasMore : false,
  }
}

export function taskBucket(state) {
  const normalized = text(state, "unknown").toLowerCase().replaceAll("-", "_")
  if (["claimed", "accepted", "running", "verifying"].includes(normalized)) return "active"
  if (
    normalized.startsWith("blocked") ||
    ["needs_input", "needs_clarification", "declined", "awaiting_approval", "failed", "stalled"].includes(normalized)
  ) return "needs-attention"
  if (["review", "review_required", "completed", "done", "cancelled"].includes(normalized)) return "review-done"
  return "available"
}

export function findLocalResourceConflicts(tasks) {
  const conflicts = new Map()
  const active = tasks.filter((task) => taskBucket(task.state) === "active")
  const claimsByResource = new Map()
  for (const task of active) {
    // Redacted resource labels intentionally collapse distinct private topology.
    // HAM may return a canonical conflict summary, but the browser must never
    // infer an overlap from two identical redaction placeholders.
    for (const claim of task.resources.filter((item) => item.status !== "released" && !item.redacted)) {
      if (!claimsByResource.has(claim.resourceRef)) claimsByResource.set(claim.resourceRef, [])
      claimsByResource.get(claim.resourceRef).push({ task, claim })
    }
  }
  for (const [resourceRef, claims] of claimsByResource) {
    if (claims.length < 2) continue
    const risky = claims.some(({ claim }) => ["write", "exclusive"].includes(claim.mode))
    if (!risky) continue
    for (const { task } of claims) {
      const related = claims.filter((item) => item.task.id !== task.id).map((item) => item.task.title)
      conflicts.set(task.id, [
        ...(conflicts.get(task.id) || []),
        `${resourceRef} overlaps with ${related.join(", ")}`,
      ])
    }
  }
  return conflicts
}

export function mergeTaskPages(current, incoming) {
  const byId = new Map(current.map((task) => [task.id, task]))
  for (const task of incoming) {
    if (!byId.has(task.id)) byId.set(task.id, task)
  }
  return Array.from(byId.values()).sort((a, b) => {
    const left = a.updatedAt || a.createdAt || ""
    const right = b.updatedAt || b.createdAt || ""
    return right.localeCompare(left) || a.title.localeCompare(b.title)
  })
}

export function formatTaskFreshness(value, now = Date.now()) {
  if (!value) return "No activity timestamp"
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return "Invalid activity timestamp"
  const elapsedMinutes = Math.max(0, Math.floor((now - timestamp) / 60_000))
  if (elapsedMinutes < 1) return "Updated just now"
  if (elapsedMinutes < 60) return `Updated ${elapsedMinutes} minute${elapsedMinutes === 1 ? "" : "s"} ago`
  const hours = Math.floor(elapsedMinutes / 60)
  if (hours < 48) return `Updated ${hours} hour${hours === 1 ? "" : "s"} ago`
  const days = Math.floor(hours / 24)
  return `Updated ${days} day${days === 1 ? "" : "s"} ago`
}
