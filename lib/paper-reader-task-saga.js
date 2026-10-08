import { createGalaxyObjectReference, parseGalaxyObjectReference } from "./galaxy-object-reference.js"
import { normalizePaperEnhanceReferences } from "./paper-enhance-handoff.js"
import { isDocumentAnchorTextMediaType } from "./document-anchor-media.js"

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,180}$/
const TASK_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA_ID = /^sha256:[0-9a-f]{64}$/

function invalid(message) {
  throw new TypeError(`Invalid paper task operation: ${message}`)
}

function requiredText(value, label, maximum) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    invalid(`${label} is required and must be at most ${maximum} characters`)
  }
  return value.trim()
}

function exactAnchor(request) {
  const anchor = request?.anchor
  const parsed = parseGalaxyObjectReference(anchor?.ref)
  if (
    !anchor || typeof anchor !== "object" || Array.isArray(anchor)
    || parsed?.format !== "canonical"
    || parsed.kind !== "document.anchor"
    || parsed.selector.mode !== "pinned"
    || !SHA_ID.test(parsed.id)
    || !SHA_ID.test(parsed.selector.revision)
    || anchor.id !== parsed.id
    || typeof anchor.document_revision_id !== "string"
    || !UUID.test(anchor.document_revision_id)
  ) invalid("anchor.ref must be an exact pinned document.anchor reference")
  return anchor
}

function taskCheckpoint(value) {
  if (value == null) return null
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("task checkpoint is invalid")
  const id = requiredText(value.id, "task id", 200)
  const title = requiredText(value.title, "task title", 200)
  if (!TASK_ID.test(id)) invalid("task id is invalid")
  if (!Number.isSafeInteger(value.version) || value.version < 1) invalid("task version must be a positive safe integer")
  return { id, title, version: value.version }
}

function linkSourceReference(value, task) {
  if (!task) {
    if (value !== undefined) invalid("linkSourceRef requires a task checkpoint")
    return null
  }
  if (value === undefined) {
    // Recovery records written before canonical task-head normalization did
    // not persist the exact link body. Reconstruct their original version pin
    // so retrying under the same idempotency key remains byte-for-byte stable.
    return createGalaxyObjectReference("ham.task", task.id, {
      mode: "pinned",
      revision: `version:${task.version}`,
    })
  }
  const parsed = parseGalaxyObjectReference(value)
  if (
    parsed?.format !== "canonical"
    || parsed.kind !== "ham.task"
    || parsed.id !== task.id
    || (
      parsed.selector.mode === "pinned"
      && parsed.selector.revision !== `version:${task.version}`
    )
  ) invalid("linkSourceRef does not match the task checkpoint")
  return value
}

function canonicalReaderHref(value, anchor) {
  const source = requiredText(value, "sourceHref", 2_048)
  let parsed
  try {
    parsed = new URL(source, "https://galaxy.invalid")
  } catch {
    invalid("sourceHref is invalid")
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) invalid("sourceHref is invalid")
  const expectedPath = `/documents/${encodeURIComponent(anchor.document_revision_id.toLowerCase())}`
  const isExactTextAnchor = anchor.selector?.kind === "text-quote"
    && anchor.representation_kind === "original"
    && isDocumentAnchorTextMediaType(anchor.representation_media_type)
  if (isExactTextAnchor) {
    if (
      parsed.pathname !== expectedPath
      || parsed.searchParams.size !== 1
      || parsed.searchParams.get("documentAnchor") !== anchor.id
    ) invalid("sourceHref must restore the exact document anchor")
    return `${expectedPath}?${new URLSearchParams({ documentAnchor: anchor.id })}`
  }
  const page = Number(parsed.searchParams.get("paperPage"))
  if (
    parsed.pathname !== expectedPath
    || parsed.searchParams.get("paperView") !== "pdf"
    || parsed.searchParams.get("paperAnchor") !== anchor.id
    || !Number.isSafeInteger(page)
    || page < 1
  ) invalid("sourceHref must restore the exact document anchor")
  const query = new URLSearchParams({
    paperView: "pdf",
    paperPage: String(page),
    paperAnchor: anchor.id,
  })
  return `${expectedPath}?${query}`
}

export function paperTaskSagaKeys(operationKey) {
  if (typeof operationKey !== "string" || !IDEMPOTENCY_KEY.test(operationKey)) {
    invalid("operation idempotency key is invalid")
  }
  return Object.freeze({
    taskIdempotencyKey: `paper-task:${operationKey}`,
    linkIdempotencyKey: `paper-link:${operationKey}`,
  })
}

export function paperAgentLoopKeys(operationKey) {
  if (typeof operationKey !== "string" || !IDEMPOTENCY_KEY.test(operationKey)) {
    invalid("operation idempotency key is invalid")
  }
  return Object.freeze({
    planIdempotencyKey: `paper-agent-plan:${operationKey}`,
    runIdempotencyKey: `paper-agent-run:${operationKey}`,
  })
}

export function normalizePaperTaskOperation(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) invalid("request is required")
  if (request.schemaId !== "gb.paper-task-request.v1") invalid("schemaId is unsupported")
  const anchor = exactAnchor(request)
  const keys = paperTaskSagaKeys(request.idempotencyKey)
  const taskIdempotencyKey = request.taskIdempotencyKey ?? keys.taskIdempotencyKey
  const linkIdempotencyKey = request.linkIdempotencyKey ?? keys.linkIdempotencyKey
  if (taskIdempotencyKey !== keys.taskIdempotencyKey || linkIdempotencyKey !== keys.linkIdempotencyKey) {
    invalid("derived idempotency keys do not match the operation")
  }
  const task = taskCheckpoint(request.task)
  const linkSourceRef = linkSourceReference(request.linkSourceRef, task)
  const resourceRefs = normalizePaperEnhanceReferences(anchor.ref, request.resourceRefs ?? [])
  const executionMode = request.executionMode ?? "review"
  if (!new Set(["review", "run"]).has(executionMode)) invalid("executionMode is unsupported")
  return {
    ...request,
    schemaId: "gb.paper-task-request.v1",
    idempotencyKey: request.idempotencyKey,
    taskIdempotencyKey,
    linkIdempotencyKey,
    requestedAt: requiredText(request.requestedAt, "requestedAt", 64),
    title: requiredText(request.title, "title", 200),
    goal: requiredText(request.goal, "goal", 4_000),
    sourceHref: canonicalReaderHref(request.sourceHref, anchor),
    anchor,
    resourceRefs,
    executionMode,
    task,
    ...(linkSourceRef ? { linkSourceRef } : {}),
    stage: task ? "task-created" : "requested",
  }
}

export function paperAgentLoopTask(operation) {
  const normalized = normalizePaperTaskOperation(operation)
  if (normalized.executionMode !== "run") invalid("executionMode must be run")
  if (!normalized.task) invalid("a task checkpoint is required before starting an agent loop")
  return Object.freeze({
    id: normalized.task.id,
    version: normalized.task.version,
    title: normalized.task.title,
    goal: normalized.goal,
    state: "pending",
    resources: normalized.resourceRefs.map((resourceRef, index) => ({
      id: `paper-resource-${index + 1}`,
      resourceRef,
      redacted: false,
      mode: "read",
      status: "active",
    })),
  })
}

export function paperTaskInput(operation) {
  const normalized = normalizePaperTaskOperation(operation)
  return {
    title: normalized.title,
    goal: normalized.goal,
    why: "This task was created from an exact immutable Galaxy document coordinate.",
    acceptanceCriteria: [
      "Use the pinned document anchor as the source boundary",
      "Return findings with traceable evidence",
    ],
    riskMode: "diagnostic",
    resourceKeys: [...normalized.resourceRefs],
    resourceMode: "read",
  }
}

export function latestHamTaskReference(task) {
  const normalized = taskCheckpoint(task)
  return createGalaxyObjectReference("ham.task", normalized.id)
}

export function createdHamTaskEvidenceReference(task) {
  const normalized = taskCheckpoint(task)
  return createGalaxyObjectReference("ham.task", normalized.id, {
    mode: "pinned",
    revision: `version:${normalized.version}`,
  })
}

/**
 * Durable two-step saga. The recovery record is written before HAM is called,
 * then checkpointed with HAM's exact id/version before the Galaxy link write.
 * A reload after link failure therefore resumes at the link and cannot post a
 * second task. Stable task idempotency also protects a failed checkpoint write.
 */
export async function runPaperTaskSaga(request, ports) {
  if (!ports || typeof ports !== "object" || Array.isArray(ports)) invalid("ports are required")
  for (const name of ["createTask", "createLink", "writeRecovery", "clearRecovery"]) {
    if (typeof ports[name] !== "function") invalid(`${name} port is required`)
  }
  let operation = normalizePaperTaskOperation(request)
  await ports.writeRecovery(operation)
  if (!operation.task) {
    const created = taskCheckpoint(await ports.createTask(
      paperTaskInput(operation),
      operation.taskIdempotencyKey,
    ))
    operation = {
      ...operation,
      task: created,
      linkSourceRef: createdHamTaskEvidenceReference(created),
      stage: "task-created",
    }
    await ports.writeRecovery(operation)
  }
  const taskRef = latestHamTaskReference(operation.task)
  const createdTaskRef = operation.linkSourceRef
  const link = await ports.createLink({
    anchorRef: operation.anchor.ref,
    taskRef,
    createdTaskRef,
    idempotencyKey: operation.linkIdempotencyKey,
    sourceHref: operation.sourceHref,
  })
  await ports.clearRecovery(operation)
  return { operation, link, taskRef, createdTaskRef }
}
