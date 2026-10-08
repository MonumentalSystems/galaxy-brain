export function mergeExperimentUpdate(current, updated) {
  if (!updated) return current

  // Attachment bindings are immutable and append-only for the lifetime of an
  // experiment. A PATCH response can have been assembled before a concurrent
  // attachment request completed, then arrive after the newer receipt. Merge
  // whole descriptors by their canonical attachment identity so that an
  // unrelated, delayed save cannot erase evidence that is already visible.
  const attachments = []
  const attachmentIds = new Set()
  for (const attachment of [
    ...(Array.isArray(current?.attachment_refs) ? current.attachment_refs : []),
    ...(Array.isArray(updated.attachment_refs) ? updated.attachment_refs : []),
  ]) {
    if (attachmentIds.has(attachment.attachmentId)) continue
    attachmentIds.add(attachment.attachmentId)
    attachments.push(attachment)
  }

  const observations = []
  const observationIds = new Set()
  for (const observation of [
    ...(Array.isArray(current?.observation_refs) ? current.observation_refs : []),
    ...(Array.isArray(updated.observation_refs) ? updated.observation_refs : []),
  ]) {
    if (observationIds.has(observation.id)) continue
    observationIds.add(observation.id)
    observations.push(observation)
  }

  return {
    ...updated,
    attachment_refs: attachments,
    attachment_count: Math.max(
      attachments.length,
      Number.isSafeInteger(current?.attachment_count) ? current.attachment_count : 0,
      Number.isSafeInteger(updated.attachment_count) ? updated.attachment_count : 0,
    ),
    observation_refs: observations,
    observation_count: Math.max(
      observations.length,
      Number.isSafeInteger(current?.observation_count) ? current.observation_count : 0,
      Number.isSafeInteger(updated.observation_count) ? updated.observation_count : 0,
    ),
    metrics: Array.isArray(updated.metrics)
      ? updated.metrics
      : Array.isArray(current?.metrics)
        ? current.metrics
        : [],
  }
}

export function classifyExperimentLoadError(error) {
  return error && typeof error === "object" && error.status === 404
    ? "not-found"
    : "error"
}

export function describeExperimentLoadError(error) {
  const status = error && typeof error === "object" ? error.status : undefined
  if (status === 401) return "Your session has expired. Sign in again to open this experiment."
  if (status === 403) return "You do not have permission to open this experiment."
  if (status === 410) return "This pending observation was recorded before its experiment was deleted. Discard the pending retry to clear it."
  if (status === 503) return "The lab notebook service is temporarily unavailable."
  if (typeof status === "number" && status >= 500) {
    return "The lab notebook service could not complete the request. Try again in a moment."
  }
  if (error instanceof TypeError) return "Galaxy Brain could not reach the lab notebook service."
  return "The lab notebook service could not load this experiment."
}

export function mergeExperimentMetrics(current, metrics) {
  if (!current) return current
  return { ...current, metrics: Array.isArray(metrics) ? metrics : current.metrics ?? [] }
}

export function appendExperimentMetric(current, metric, timestamp) {
  if (!current) return current
  return {
    ...current,
    metrics: [
      ...(current.metrics ?? []),
      {
        ...metric,
        experiment_id: current.id,
        source: metric.source ?? "manual",
        timestamp,
      },
    ],
  }
}

export function parseConfigSnapshot(input) {
  const trimmed = input.trim()
  if (!trimmed) return { value: {}, error: null }

  try {
    const value = JSON.parse(trimmed)
    if (!value || Array.isArray(value) || typeof value !== "object") {
      return { value: null, error: "Configuration must be a JSON object." }
    }
    return { value, error: null }
  } catch (error) {
    const detail = error instanceof SyntaxError ? error.message : "Invalid JSON"
    return { value: null, error: `Configuration is not valid JSON: ${detail}` }
  }
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (!value || typeof value !== "object") return value

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonValue(value[key])]),
  )
}

export function configSnapshotsEqual(left, right) {
  return JSON.stringify(sortJsonValue(left ?? {})) === JSON.stringify(sortJsonValue(right ?? {}))
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function rebaseSubmittedExperimentField(submitted, current, server) {
  const unchanged = Array.isArray(submitted)
    ? Array.isArray(current) && arraysEqual(current, submitted)
    : current === submitted
  return unchanged ? server : current
}

export function experimentSaveCompletionState(draftGeneration, acknowledgedGeneration, outstandingRequests) {
  if (outstandingRequests > 0) return "saving"
  return acknowledgedGeneration === draftGeneration ? "saved" : "idle"
}

export function shouldQueueExperimentSave(outstandingRequests) {
  return outstandingRequests > 0
}

export function shouldScheduleQueuedExperimentSave(queuedGeneration, completedGeneration) {
  return queuedGeneration !== null && queuedGeneration > completedGeneration
}

export function isExperimentSaveRequestActive(
  mounted,
  requestEpoch,
  activeEpoch,
  requestExperimentId,
  activeExperimentId,
) {
  return mounted && requestEpoch === activeEpoch && requestExperimentId === activeExperimentId
}

export function pendingExperimentObservationForScope(selection, authorityScopeKey) {
  return selection?.scopeKey === authorityScopeKey ? selection.operation : null
}

export function loadedExperimentForScope(selection, authorityScopeKey) {
  return selection?.scopeKey === authorityScopeKey ? selection.experiment : null
}

export function observationExperimentForSubmission(selection, authorityScopeKey, composerScopeKey) {
  if (composerScopeKey !== authorityScopeKey) return null
  return loadedExperimentForScope(selection, authorityScopeKey)
}

export function canonicalizeExperimentTags(input) {
  const tags = typeof input === "string" ? input.split(",") : input
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))]
}

export function formatExperimentTags(tags) {
  return canonicalizeExperimentTags(tags).join(", ")
}

export function buildExperimentUpdatePatch(current, draft) {
  const patch = {}
  const requiredTextFields = [
    "title",
    "status",
    "domain",
    "hypothesis",
    "protocol",
    "results",
    "interpretation",
    "conclusion",
  ]
  for (const field of requiredTextFields) {
    if (draft[field] !== current[field]) patch[field] = draft[field]
  }

  for (const field of ["wandb_run_id", "wandb_project", "local_run_path"]) {
    if ((draft[field] ?? "") !== (current[field] ?? "")) patch[field] = draft[field] ?? ""
  }

  if (!configSnapshotsEqual(draft.config_snapshot, current.config_snapshot)) {
    patch.config_snapshot = draft.config_snapshot
  }
  if (!arraysEqual(draft.tags ?? [], current.tags ?? [])) patch.tags = draft.tags ?? []
  if (!arraysEqual(draft.linked_experiments ?? [], current.linked_experiments ?? [])) {
    patch.linked_experiments = draft.linked_experiments ?? []
  }
  return patch
}

export function buildWandbRunUrl(project, runId) {
  const normalizedRunId = runId.trim()
  if (!normalizedRunId) return null
  const normalizedProject = project.trim()
  const projectPath = normalizedProject
    ? `${normalizedProject.split("/").filter(Boolean).map(encodeURIComponent).join("/")}/`
    : ""
  return `https://wandb.ai/${projectPath}runs/${encodeURIComponent(normalizedRunId)}`
}

export function appendEvidenceReference(current, input) {
  const value = input.trim()
  if (!value) return current
  if (value.length > 2048) return current
  return current.includes(value) ? current : [...current, value]
}

export function parseManualMetricDraft({ name, value, step }) {
  const metricName = name.trim()
  if (!metricName) return { metric: null, error: "Metric name is required." }
  if (metricName.length > 200) return { metric: null, error: "Metric name must be 200 characters or fewer." }
  if (!value.trim()) return { metric: null, error: "Metric value is required." }

  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) return { metric: null, error: "Metric value must be a finite number." }

  const trimmedStep = step.trim()
  const numericStep = trimmedStep ? Number(trimmedStep) : undefined
  if (numericStep !== undefined && (!Number.isInteger(numericStep) || numericStep < 0)) {
    return { metric: null, error: "Metric step must be a non-negative integer." }
  }

  return {
    metric: {
      name: metricName,
      value: numericValue,
      ...(numericStep === undefined ? {} : { step: numericStep }),
      source: "manual",
    },
    error: null,
  }
}
