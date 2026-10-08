const MEMORY_ID_PATTERN = /^[1-9][0-9]{0,18}$/
const MAX_INT64 = 9_223_372_036_854_775_807n
const MEMORY_RELATIONS = new Set(["cites", "verifies", "contradicts", "depends-on"])
const RELATION_INVERSES = Object.freeze({
  cites: "cited-by",
  verifies: "verified-by",
  contradicts: "contradicted-by",
  "depends-on": "required-by",
})
const SUPERSEDE_FIELDS = new Set([
  "action",
  "expectedVersion",
  "idempotencyKey",
  "content",
  "title",
  "type",
  "project",
  "repo",
  "task",
  "sequence",
  "scopes",
  "cues",
  "reason",
])
const LINK_FIELDS = new Set(["action", "targetMemoryId", "relation"])
const UNLINK_FIELDS = new Set(["action", "linkId", "expectedVersion", "reason"])

export const HAM_MEMORY_MAX_LINKS = 64
export const HAM_MEMORY_MAX_HYDRATED_NEIGHBORS = 24
export const HAM_MEMORY_REQUEST_MAX_BYTES = 262_144
export const HAM_MEMORY_UPSTREAM_REQUEST_MAX_BYTES = 1_048_576
export const HAM_MEMORY_UPSTREAM_RESPONSE_MAX_BYTES = 1_048_576

export class HamMemoryContractError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

export class HamMemoryUpstreamResponseError extends Error {}

function record(value, label = "Request") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HamMemoryContractError(`${label} must be a JSON object.`)
  }
  return value
}

function assertOnlyKeys(source, allowed) {
  const unknown = Object.keys(source).find((key) => !allowed.has(key))
  if (unknown) throw new HamMemoryContractError(`Unsupported field: ${unknown}.`)
}

function requiredText(value, label, maxLength) {
  if (typeof value !== "string") throw new HamMemoryContractError(`${label} must be text.`)
  const cleaned = value.trim()
  if (!cleaned) throw new HamMemoryContractError(`${label} is required.`)
  if (cleaned.length > maxLength) throw new HamMemoryContractError(`${label} is too long.`)
  return cleaned
}

function optionalText(value, label, maxLength, { nullable = false, trim = true } = {}) {
  if (value === undefined) return undefined
  if (value === null && nullable) return null
  if (typeof value !== "string") throw new HamMemoryContractError(`${label} must be text.`)
  const cleaned = trim ? value.trim() : value
  if (cleaned.length > maxLength) throw new HamMemoryContractError(`${label} is too long.`)
  return cleaned
}

function positiveVersion(value, label = "Expected version") {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new HamMemoryContractError(`${label} must be a positive integer.`)
  }
  return value
}

function optionalStringArray(value, label, { maximum, itemMaximum, lowerCase = false } = {}) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > maximum) {
    throw new HamMemoryContractError(`${label} must contain at most ${maximum} values.`)
  }
  const seen = new Set()
  const result = []
  for (const item of value) {
    const cleaned = requiredText(item, `${label} value`, itemMaximum)
    const normalized = lowerCase ? cleaned.toLowerCase() : cleaned
    const key = normalized.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      result.push(normalized)
    }
  }
  return result
}

function nullableTrimmedText(value) {
  if (typeof value !== "string") return null
  const cleaned = value.trim()
  return cleaned || null
}

function comparableScopes(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const scopes = []
  for (const raw of value) {
    if (typeof raw !== "string") continue
    const scope = raw.trim().toLowerCase()
    if (!scope || seen.has(scope)) continue
    seen.add(scope)
    scopes.push(scope)
  }
  return scopes.sort()
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Build the sparse edit asserted by the Galaxy form. Fields omitted here are
 * inherited by HAM during supersession, including authored cues and their
 * provenance. Returning an empty object means the draft is a semantic no-op.
 */
export function buildHamMemorySupersedeChanges(memory, draft) {
  const current = record(memory, "Memory")
  const next = record(draft, "Draft")
  const organization = record(next.organization, "Draft organization")
  const currentOrganization = record(current.organization, "Memory organization")
  const changes = {}

  if (typeof next.content !== "string") throw new HamMemoryContractError("Content must be text.")
  if (next.content !== current.content) changes.content = next.content

  const nextTitle = nullableTrimmedText(next.title)
  const currentTitle = nullableTrimmedText(current.title)
  if (nextTitle !== currentTitle) changes.title = nextTitle

  for (const key of ["project", "repo", "task", "sequence"]) {
    const nextValue = nullableTrimmedText(organization[key])
    const currentValue = nullableTrimmedText(currentOrganization[key])
    if (nextValue !== currentValue) changes[key] = nextValue
  }

  const nextScopes = comparableScopes(organization.scopes)
  const currentScopes = comparableScopes(currentOrganization.scopes)
  if (!sameStringArray(nextScopes, currentScopes)) {
    if (nextScopes.length === 0) {
      throw new HamMemoryContractError("At least one HAM scope is required when changing scopes.")
    }
    changes.scopes = nextScopes
  }

  return changes
}

export function parseHamMemoryId(value, label = "Memory ID") {
  const candidate = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : ""
  if (!MEMORY_ID_PATTERN.test(candidate)) {
    throw new HamMemoryContractError(`${label} is invalid.`)
  }
  try {
    if (BigInt(candidate) > MAX_INT64) throw new Error("out of range")
  } catch {
    throw new HamMemoryContractError(`${label} is invalid.`)
  }
  return candidate
}

export function parseHamMemoryMutation(input) {
  const source = record(input)
  const action = requiredText(source.action, "Action", 40)

  if (action === "supersede") {
    assertOnlyKeys(source, SUPERSEDE_FIELDS)
    const body = {
      expectedVersion: positiveVersion(source.expectedVersion),
      idempotencyKey: requiredText(source.idempotencyKey, "Idempotency key", 200),
    }
    const content = optionalText(source.content, "Content", 200_000, { trim: false })
    if (content !== undefined) {
      if (!content.trim()) throw new HamMemoryContractError("Content is required.")
      body.content = content
    }
    for (const [key, label, maximum] of [
      ["title", "Title", 1_000],
      ["type", "Type", 120],
      ["project", "Project", 120],
      ["repo", "Repository", 500],
      ["task", "Task", 500],
      ["sequence", "Sequence", 200],
    ]) {
      const value = optionalText(source[key], label, maximum, { nullable: true })
      if (value !== undefined) body[key] = value
    }
    const scopes = optionalStringArray(source.scopes, "Scopes", {
      maximum: 32,
      itemMaximum: 200,
      lowerCase: true,
    })
    if (scopes !== undefined) {
      if (scopes.length === 0) throw new HamMemoryContractError("Scopes cannot be empty.")
      body.scopes = scopes
    }
    const cues = optionalStringArray(source.cues, "Cues", {
      maximum: 32,
      itemMaximum: 200,
    })
    if (cues !== undefined) body.cues = cues
    const reason = optionalText(source.reason, "Reason", 2_000, { nullable: true })
    if (reason !== undefined) body.reason = reason

    const changed = ["content", "title", "type", "project", "repo", "task", "sequence", "scopes", "cues"]
      .some((key) => Object.hasOwn(body, key))
    if (!changed) throw new HamMemoryContractError("A memory change is required.")
    return { action, body }
  }

  if (action === "link") {
    assertOnlyKeys(source, LINK_FIELDS)
    const relation = requiredText(source.relation, "Relation", 40)
    if (!MEMORY_RELATIONS.has(relation)) throw new HamMemoryContractError("Relation is invalid.")
    return {
      action,
      targetMemoryId: parseHamMemoryId(source.targetMemoryId, "Target memory ID"),
      relation,
    }
  }

  if (action === "unlink") {
    assertOnlyKeys(source, UNLINK_FIELDS)
    const reason = optionalText(source.reason, "Reason", 2_000, { nullable: true })
    return {
      action,
      linkId: parseHamMemoryId(source.linkId, "Link ID"),
      expectedVersion: positiveVersion(source.expectedVersion),
      ...(reason === undefined ? {} : { reason }),
    }
  }

  throw new HamMemoryContractError("Action is invalid.")
}

export function buildHamSupersedeUpstreamBody(rawMemory, input) {
  if (!rawMemory || typeof rawMemory !== "object" || Array.isArray(rawMemory)) {
    throw new HamMemoryUpstreamResponseError("HAM returned an invalid memory response.")
  }
  const currentContent = typeof rawMemory.content === "string" && rawMemory.content.length <= 200_000
    ? rawMemory.content
    : null
  const currentVersion = Number.isSafeInteger(rawMemory.version) && rawMemory.version >= 1
    ? rawMemory.version
    : null
  if (currentContent === null || currentVersion === null) {
    throw new HamMemoryUpstreamResponseError("HAM returned an invalid memory response.")
  }
  if (currentVersion !== input.expectedVersion) {
    throw new HamMemoryContractError("Memory changed since it was read.", 409)
  }

  const metadata = rawMemory.metadata && typeof rawMemory.metadata === "object" && !Array.isArray(rawMemory.metadata)
    ? { ...rawMemory.metadata }
    : {}
  for (const key of [
    "supersedes_id",
    "superseded_by",
    "superseded_reason",
    "supersede_warnings",
    "retracted_at",
    "retracted_by",
    "retraction_reason",
  ]) {
    delete metadata[key]
  }

  const semanticChange = (() => {
    if (Object.hasOwn(input, "content") && input.content !== currentContent) return true
    for (const key of ["title", "type", "project", "repo", "task", "sequence"]) {
      if (!Object.hasOwn(input, key)) continue
      if (nullableTrimmedText(input[key]) !== nullableTrimmedText(metadata[key])) return true
    }
    if (input.scopes !== undefined) {
      if (!sameStringArray(comparableScopes(input.scopes), comparableScopes(metadata.scopes))) return true
    }
    if (input.cues !== undefined) {
      const currentAuthoredCues = Array.isArray(rawMemory.cues)
        ? rawMemory.cues.flatMap((cue) => {
            if (typeof cue === "string") return [cue.trim()]
            if (!cue || typeof cue !== "object" || Array.isArray(cue) || cue.source !== "agent") return []
            return typeof cue.cue === "string" ? [cue.cue.trim()] : []
          }).filter(Boolean)
        : []
      if (!sameStringArray(input.cues, currentAuthoredCues)) return true
    }
    return false
  })()
  if (!semanticChange) {
    throw new HamMemoryContractError("Replacement memory must contain a real change.")
  }

  const payload = {
    content: input.content ?? currentContent,
    expected_version: input.expectedVersion,
    idempotency_key: input.idempotencyKey,
    metadata,
  }
  for (const key of ["title", "type", "project", "repo", "task", "sequence"]) {
    if (!Object.hasOwn(input, key)) continue
    const value = input[key]
    if (value === null) {
      delete metadata[key]
      payload[key] = ""
    } else {
      payload[key] = value
    }
  }
  if (input.scopes !== undefined) payload.scopes = input.scopes
  if (input.cues !== undefined) payload.cues = input.cues
  if (input.reason !== undefined) payload.reason = input.reason
  return payload
}

function safeText(value, maximum) {
  return typeof value === "string" && value.length <= maximum ? value : undefined
}

function safeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function safeVersion(value) {
  return Number.isSafeInteger(value) && value >= 1 ? value : 1
}

function safeMetadata(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
}

function upstreamMemoryId(value, label = "memory ID") {
  try {
    return parseHamMemoryId(value, label)
  } catch {
    return null
  }
}

export function findHamMemoryLinkSource(rawLinks, viewedMemoryId, linkId) {
  if (!Array.isArray(rawLinks)) {
    throw new HamMemoryUpstreamResponseError("HAM returned an invalid memory-links response.")
  }
  const viewedId = parseHamMemoryId(viewedMemoryId)
  const selectedLinkId = parseHamMemoryId(linkId, "Link ID")
  for (const raw of rawLinks) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const rawLinkId = upstreamMemoryId(raw.id, "Link ID")
    if (rawLinkId !== selectedLinkId) continue
    const sourceId = upstreamMemoryId(raw.source_id, "Source memory ID")
    const targetId = upstreamMemoryId(raw.target_id, "Target memory ID")
    if (sourceId && targetId && (sourceId === viewedId || targetId === viewedId)) return sourceId
  }
  throw new HamMemoryContractError("Memory link was not found.", 404)
}

function projectScopes(value) {
  if (!Array.isArray(value)) return []
  return value.flatMap((scope) => {
    const projected = safeText(scope, 200)?.trim()
    return projected ? [projected] : []
  }).slice(0, 32)
}

function projectCues(value) {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw) => {
    if (typeof raw === "string") {
      const cue = safeText(raw, 200)?.trim()
      return cue ? [{ cue }] : []
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return []
    const cue = safeText(raw.cue, 200)?.trim()
    if (!cue) return []
    const source = safeText(raw.source, 40)
    return [{ cue, ...(source ? { source } : {}) }]
  }).slice(0, 32)
}

export function projectHamMemoryForBrowser(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HamMemoryUpstreamResponseError("HAM returned an invalid memory response.")
  }
  const source = raw
  const id = upstreamMemoryId(source.id)
  const content = safeText(source.content, 200_000)
  if (!id || content === undefined) {
    throw new HamMemoryUpstreamResponseError("HAM returned an invalid memory response.")
  }
  const metadata = safeMetadata(source.metadata)
  const organization = {}
  for (const key of ["project", "repo", "task", "sequence"]) {
    const value = safeText(metadata[key], key === "sequence" ? 200 : 500)
    if (value !== undefined) organization[key] = value
  }
  organization.scopes = projectScopes(metadata.scopes)

  const projected = {
    id,
    content,
    tier: safeNumber(source.tier) ?? 0,
    state: safeText(source.state, 40) ?? "active",
    version: safeVersion(source.version),
    organization,
    cues: projectCues(source.cues),
  }
  for (const [target, value, maximum] of [
    ["title", metadata.title, 1_000],
    ["type", metadata.type, 120],
    ["status", metadata.status, 120],
    ["durability", metadata.durability, 40],
    ["visibility", metadata.visibility, 40],
    ["agentId", metadata.agent_id, 200],
    ["timestamp", source.timestamp, 100],
    ["createdAt", source.created_at, 100],
    ["updatedAt", source.updated_at, 100],
  ]) {
    const valueText = safeText(value, maximum)
    if (valueText !== undefined) projected[target] = valueText
  }
  return projected
}

function projectHamMemorySummary(raw) {
  if (!raw) return null
  try {
    const memory = projectHamMemoryForBrowser(raw)
    return {
      id: memory.id,
      title: memory.title,
      type: memory.type,
      state: memory.state,
      version: memory.version,
      snippet: memory.content.slice(0, 280),
    }
  } catch {
    return null
  }
}

export function normalizeHamMemoryLinks(rawLinks, viewedMemoryId) {
  if (!Array.isArray(rawLinks)) {
    throw new HamMemoryUpstreamResponseError("HAM returned an invalid memory-links response.")
  }
  const viewedId = parseHamMemoryId(viewedMemoryId)
  const projected = []
  const seen = new Set()
  for (const raw of rawLinks) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const id = upstreamMemoryId(raw.id, "link ID")
    const sourceId = upstreamMemoryId(raw.source_id, "source memory ID")
    const targetId = upstreamMemoryId(raw.target_id, "target memory ID")
    const relation = safeText(raw.relation, 40)
    if (!id || !sourceId || !targetId || !relation || !MEMORY_RELATIONS.has(relation) || seen.has(id)) continue
    let direction
    let effectiveRelation
    let adjacentId
    if (sourceId === viewedId) {
      direction = "outgoing"
      effectiveRelation = relation
      adjacentId = targetId
    } else if (targetId === viewedId) {
      direction = "incoming"
      effectiveRelation = RELATION_INVERSES[relation]
      adjacentId = sourceId
    } else {
      continue
    }
    seen.add(id)
    projected.push({
      kind: "typed",
      id,
      relation,
      effectiveRelation,
      direction,
      sourceId,
      targetId,
      adjacentId,
      state: safeText(raw.state, 40) ?? "active",
      version: safeVersion(raw.version),
      ...(safeText(raw.created_at, 100) ? { createdAt: raw.created_at } : {}),
    })
  }
  return {
    edges: projected.slice(0, HAM_MEMORY_MAX_LINKS),
    truncated: projected.length > HAM_MEMORY_MAX_LINKS,
  }
}

function lifecycleIds(rawMemory) {
  const metadata = safeMetadata(rawMemory.metadata)
  return {
    supersedesId: upstreamMemoryId(rawMemory.supersedes_id ?? metadata.supersedes_id),
    supersededById: upstreamMemoryId(rawMemory.superseded_by_id ?? metadata.superseded_by),
  }
}

export function buildHamMemoryView(rawMemory, rawLinks, adjacentMemories = new Map()) {
  const memory = projectHamMemoryForBrowser(rawMemory)
  const normalized = normalizeHamMemoryLinks(rawLinks, memory.id)
  const adjacentById = adjacentMemories instanceof Map
    ? adjacentMemories
    : new Map(Object.entries(adjacentMemories || {}))
  const edges = normalized.edges.map((edge) => ({
    ...edge,
    adjacent: projectHamMemorySummary(adjacentById.get(edge.adjacentId)),
  }))
  const { supersedesId, supersededById } = lifecycleIds(rawMemory)

  if (supersedesId && supersedesId !== memory.id) {
    edges.push({
      kind: "lifecycle",
      id: `supersedes:${memory.id}:${supersedesId}`,
      relation: "supersedes",
      effectiveRelation: "supersedes",
      direction: "outgoing",
      sourceId: memory.id,
      targetId: supersedesId,
      adjacentId: supersedesId,
      state: "active",
      version: 1,
      adjacent: projectHamMemorySummary(adjacentById.get(supersedesId)),
    })
  }
  if (supersededById && supersededById !== memory.id) {
    edges.push({
      kind: "lifecycle",
      id: `superseded-by:${memory.id}:${supersededById}`,
      relation: "superseded_by",
      effectiveRelation: "superseded_by",
      direction: "outgoing",
      sourceId: memory.id,
      targetId: supersededById,
      adjacentId: supersededById,
      state: "active",
      version: 1,
      adjacent: projectHamMemorySummary(adjacentById.get(supersededById)),
    })
  }

  return { memory, edges, truncated: normalized.truncated }
}

export function describeHamMemoryEdge(edge, currentMemoryId) {
  if (!edge || typeof edge !== "object" || Array.isArray(edge)) {
    throw new HamMemoryContractError("Memory edge is invalid.")
  }
  const currentId = parseHamMemoryId(currentMemoryId)
  const other = parseHamMemoryId(edge.adjacentId, "Adjacent memory ID")
  const outbound = edge.sourceId === currentId

  if (edge.relation === "supersedes") {
    return outbound
      ? { label: "This newer memory supersedes", other, tone: "stored new → old" }
      : { label: "This older memory is superseded by", other, tone: "stored new → old" }
  }
  if (edge.relation === "superseded_by") {
    return outbound
      ? { label: "This older memory is superseded by", other, tone: "stored old → new" }
      : { label: "This newer memory supersedes", other, tone: "stored old → new" }
  }
  return {
    label: outbound
      ? `This memory ${String(edge.relation).replaceAll(/[-_]/g, " ")}`
      : `This memory is ${String(edge.effectiveRelation).replaceAll(/[-_]/g, " ")}`,
    other,
    tone: outbound ? "source → target" : "source ← target",
  }
}

export function hamMemoryAdjacentIds(rawMemory, rawLinks) {
  const memory = projectHamMemoryForBrowser(rawMemory)
  const normalized = normalizeHamMemoryLinks(rawLinks, memory.id)
  const lifecycle = lifecycleIds(rawMemory)
  return [...new Set([
    ...normalized.edges.map((edge) => edge.adjacentId),
    lifecycle.supersedesId,
    lifecycle.supersededById,
  ].filter((id) => id && id !== memory.id))].slice(0, HAM_MEMORY_MAX_HYDRATED_NEIGHBORS)
}

export const HAM_MEMORY_RELATIONS = Object.freeze([...MEMORY_RELATIONS])
