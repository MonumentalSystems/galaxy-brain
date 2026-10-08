import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "../galaxy-object-reference.js"
import { canonicalAnchorJson } from "../document-anchor.js"
import { createDocumentCorpusSearchRequest } from "../document-corpus-search.js"
import { createGraphWindowRequest } from "../graph-window-contract.js"
import { parseHamSearchRequest } from "../ham-search-contract.js"
import { projectSurface } from "../surface-projection.js"

export const AGENT_TOOL_CALL_SCHEMA_ID = "gb.agent-tool-call.v1"
export const AGENT_TOOL_RESULT_SCHEMA_ID = "gb.agent-tool-result.v1"
export const AGENT_TOOL_ERROR_SCHEMA_ID = "gb.agent-tool-error.v1"
export const MAX_AGENT_TOOL_REQUEST_BYTES = 65_536
export const MAX_AGENT_TOOL_RESPONSE_BYTES = 1_048_576

export const AGENT_READ_TOOL_IDS = Object.freeze([
  "canvas.get",
  "graph.window.get",
  "ham.memory.search",
  "objects.get",
  "objects.representations",
  "objects.search",
  "proof.frontier.get",
  "proof.graph.get",
  "task.plan.get",
  "task.plan.propose",
])

export const AGENT_MUTATION_TOOL_IDS = Object.freeze([
  "anchors.create",
  "canvas.arrange",
  "proof.claim",
  "relations.propose",
  "surface.draft.create",
])

export const AGENT_TOOL_IDS = Object.freeze([
  ...AGENT_READ_TOOL_IDS,
  ...AGENT_MUTATION_TOOL_IDS,
])

const TOOL_SET = new Set(AGENT_TOOL_IDS)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const GRAPH_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u
const WORKSPACE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u
const PROOF_NODE_IDENTIFIER = WORKSPACE_IDENTIFIER
const CANVAS_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const CANVAS_CONTENT_HASH = /^sha256:[0-9a-f]{64}$/u
const IDEMPOTENCY_KEY = /^[!-~]{8,200}$/u
const RELATION_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u
const CURSOR = /^[A-Za-z0-9._:-]{1,512}$/u
const CANVAS_NODE_TYPES = new Set([
  "galaxy.paper", "galaxy.note", "galaxy.document", "galaxy.media",
  "galaxy.eln-record", "galaxy.task", "galaxy.chat", "galaxy.proof", "galaxy.surface",
])
const ARRANGE_COMMAND_TYPES = new Set([
  "item.place", "item.move", "item.resize", "item.reorder", "edge.connect",
])
const RELATIONS = new Set([
  "related", "cites", "part_of", "derived_from", "context_for", "formalized_by",
  "defined_in", "implements", "depends_on", "documents", "corresponds_to",
])
const PINNED_RELATION_KINDS = new Set([
  "document", "document.anchor", "document.mark", "code.repo", "code.commit",
  "code.file", "code.symbol", "code.graph", "chat", "proof.graph", "proof.node",
])
const SHA256_REVISION = /^sha256:[0-9a-f]{64}$/u
const CODE_REVISION = /^git:(?:[0-9a-f]{40}|[0-9a-f]{64});snapshot:sha256:[0-9a-f]{64}$/u
const TASK_PLAN_ACTIONS = new Set(["branch", "join", "compare", "challenge", "synthesize"])
const TASK_PLAN_BRANCH_KINDS = new Set([
  "research", "transform", "compare", "challenge", "synthesize", "checkpoint", "artifact",
])
const TASK_PLAN_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const HAM_TASK_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u
const HAM_SEARCH_MODES = new Set(["search", "multihop", "temporal"])
const HAM_TEMPORAL_MODES = new Set([
  "valid_at", "known_at", "event_before", "event_after", "event_near",
])
const CALL_KEYS = new Set(["schemaId", "tool", "input"])
const PAGINATION_KEYS = new Set(["cursor", "hasMore", "limit"])
const MAX_AGENT_SURFACE_BYTES = 48 * 1024

export class AgentToolContractError extends TypeError {
  constructor(code, message, status = 400) {
    super(message)
    this.name = "AgentToolContractError"
    this.code = code
    this.status = status
  }
}

function invalid(code, message, status = 400) {
  throw new AgentToolContractError(code, message, status)
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("invalid_request", `${label} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid("invalid_request", `${label} must be a plain object`)
  return value
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid("invalid_request", `${label}.${key} is not part of the contract`)
  }
}

function requiredKeys(value, required, label) {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid("invalid_request", `${label}.${key} is required`)
  }
}

function canonicalReference(value, label) {
  const parsed = parseGalaxyObjectReference(value)
  if (!parsed || parsed.format !== "canonical") invalid("invalid_reference", `${label} must be a canonical Galaxy object reference`)
  const serialized = serializeGalaxyObjectReference(parsed)
  if (serialized !== value) invalid("invalid_reference", `${label} must use canonical serialization`)
  return serialized
}

function pinnedDocumentReference(value, label) {
  const wire = canonicalReference(value, label)
  const parsed = parseGalaxyObjectReference(wire)
  if (parsed.kind !== "document" || parsed.selector.mode !== "pinned"
    || !/^sha256:[0-9a-f]{64}$/u.test(parsed.selector.revision)) {
    invalid("invalid_reference", `${label} must pin one exact document revision`)
  }
  return wire
}

function anchorText(value, maximum, label, { optional = false, allowEmpty = false } = {}) {
  if (optional && value === undefined) return undefined
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)
    || Array.from(value).length > maximum || /[\ud800-\udfff]/u.test(value)) {
    invalid("invalid_request", `${label} is invalid or exceeds ${maximum} characters`)
  }
  return value
}

function anchorPage(value, label) {
  return integer(value, 1, 1_000_000, label)
}

function anchorSelector(value) {
  const source = record(value, "call.input.selector")
  if (source.kind === "page-region") {
    const keys = new Set(["kind", "page", "coordinateSpace", "polygon", "quoteHash"])
    exactKeys(source, keys, "call.input.selector")
    requiredKeys(source, new Set(["kind", "page", "coordinateSpace", "polygon"]), "call.input.selector")
    if (source.coordinateSpace !== "normalized-page") {
      invalid("invalid_request", "call.input.selector.coordinateSpace must be normalized-page")
    }
    if (!Array.isArray(source.polygon) || source.polygon.length < 8
      || source.polygon.length > 128 || source.polygon.length % 2 !== 0) {
      invalid("invalid_request", "call.input.selector.polygon must contain 4 to 64 coordinate pairs")
    }
    const polygon = source.polygon.map((coordinate, index) => {
      const normalized = finiteNumber(coordinate, 0, 1, `call.input.selector.polygon[${index}]`)
      return Math.floor((normalized * 1_000_000) + 0.5) / 1_000_000
    })
    let twiceArea = 0
    for (let index = 0; index < polygon.length; index += 2) {
      const next = (index + 2) % polygon.length
      twiceArea += polygon[index] * polygon[next + 1] - polygon[next] * polygon[index + 1]
    }
    if (Math.abs(twiceArea) <= Number.EPSILON) {
      invalid("invalid_request", "call.input.selector.polygon must enclose a non-zero area")
    }
    const quoteHash = source.quoteHash === undefined
      ? undefined
      : anchorText(source.quoteHash, 64, "call.input.selector.quoteHash")
    if (quoteHash !== undefined && !SHA256.test(quoteHash)) {
      invalid("invalid_request", "call.input.selector.quoteHash must be a lowercase SHA-256 digest")
    }
    return Object.freeze({
      kind: source.kind,
      page: anchorPage(source.page, "call.input.selector.page"),
      coordinateSpace: source.coordinateSpace,
      polygon: Object.freeze(polygon),
      ...(quoteHash === undefined ? {} : { quoteHash }),
    })
  }
  if (source.kind === "text-quote") {
    const keys = new Set(["kind", "exact", "prefix", "suffix", "page"])
    exactKeys(source, keys, "call.input.selector")
    requiredKeys(source, new Set(["kind", "exact"]), "call.input.selector")
    return Object.freeze({
      kind: source.kind,
      exact: anchorText(source.exact, 16_000, "call.input.selector.exact"),
      ...(source.prefix === undefined ? {} : {
        prefix: anchorText(source.prefix, 2_000, "call.input.selector.prefix", { allowEmpty: true }),
      }),
      ...(source.suffix === undefined ? {} : {
        suffix: anchorText(source.suffix, 2_000, "call.input.selector.suffix", { allowEmpty: true }),
      }),
      ...(source.page === undefined ? {} : { page: anchorPage(source.page, "call.input.selector.page") }),
    })
  }
  if (source.kind === "json-pointer") {
    exactKeys(source, new Set(["kind", "pointer"]), "call.input.selector")
    requiredKeys(source, new Set(["kind", "pointer"]), "call.input.selector")
    const pointer = anchorText(source.pointer, 128, "call.input.selector.pointer")
    if (!/^\/blocks\/(0|[1-9]\d*)$/u.test(pointer)) {
      invalid("invalid_request", "call.input.selector.pointer must identify a /blocks/<index> item")
    }
    return Object.freeze({ kind: source.kind, pointer })
  }
  invalid("invalid_request", "call.input.selector.kind is unsupported")
}

function durableRelationReference(value, label) {
  const serialized = canonicalReference(value, label)
  const parsed = parseGalaxyObjectReference(serialized)
  if (PINNED_RELATION_KINDS.has(parsed.kind) && parsed.selector.mode !== "pinned") {
    invalid("invalid_reference", `${label} must pin a durable object revision`)
  }
  if (PINNED_RELATION_KINDS.has(parsed.kind)) {
    const grammar = parsed.kind.startsWith("code.") ? CODE_REVISION : SHA256_REVISION
    if (!grammar.test(parsed.selector.revision)) invalid("invalid_reference", `${label} has an invalid pinned revision`)
  }
  return serialized
}

function pinnedCanonicalReference(value, label) {
  const serialized = canonicalReference(value, label)
  if (parseGalaxyObjectReference(serialized).selector.mode !== "pinned") {
    invalid("invalid_reference", `${label} must pin an exact revision`)
  }
  if (Array.from(serialized).length > 500) {
    invalid("invalid_reference", `${label} exceeds the task-plan reference limit`)
  }
  return serialized
}

function deeplyFreezeJson(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deeplyFreezeJson(child)
  return Object.freeze(value)
}

function surfaceDefinition(value) {
  let detached
  let encoded
  try {
    encoded = JSON.stringify(value)
    detached = JSON.parse(encoded)
  } catch {
    invalid("invalid_request", "call.input.spec must be finite JSON data")
  }
  if (new TextEncoder().encode(encoded).byteLength > MAX_AGENT_SURFACE_BYTES) {
    invalid("invalid_request", "call.input.spec exceeds 48 KiB")
  }
  const spec = record(detached, "call.input.spec")
  exactKeys(spec, new Set(["schema", "catalog", "surfaceUpdate", "bindings"]), "call.input.spec")
  requiredKeys(spec, new Set(["schema", "catalog", "surfaceUpdate", "bindings"]), "call.input.spec")
  if (spec.schema !== "gb.surface.v1") {
    invalid("invalid_request", "call.input.spec.schema must be gb.surface.v1")
  }
  const catalog = record(spec.catalog, "call.input.spec.catalog")
  exactKeys(catalog, new Set(["id", "version"]), "call.input.spec.catalog")
  requiredKeys(catalog, new Set(["id", "version"]), "call.input.spec.catalog")
  if (catalog.id !== "generous.a2ui" || catalog.version !== "1") {
    invalid("invalid_request", "call.input.spec.catalog is not approved")
  }
  const surfaceUpdate = record(spec.surfaceUpdate, "call.input.spec.surfaceUpdate")
  exactKeys(surfaceUpdate, new Set(["surfaceId", "components"]), "call.input.spec.surfaceUpdate")
  const projected = projectSurface(spec)
  if (!projected.ok) {
    invalid("invalid_request", `call.input.spec cannot be rendered safely: ${projected.error}`)
  }
  return deeplyFreezeJson(spec)
}

function surfaceEvidenceReferences(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    invalid("invalid_request", "call.input.evidenceRefs must contain 1-32 pinned canonical references")
  }
  const references = value.map((reference, index) => {
    const wire = canonicalReference(reference, `call.input.evidenceRefs[${index}]`)
    if (parseGalaxyObjectReference(wire).selector.mode !== "pinned") {
      invalid("invalid_reference", `call.input.evidenceRefs[${index}] must pin an exact revision`)
    }
    if (Array.from(wire).length > 500) {
      invalid("invalid_reference", `call.input.evidenceRefs[${index}] exceeds 500 characters`)
    }
    return wire
  })
  if (new Set(references).size !== references.length) {
    invalid("invalid_request", "call.input.evidenceRefs contains duplicates")
  }
  return Object.freeze(references)
}

function integer(value, minimum, maximum, label, fallback) {
  if (value === undefined) {
    if (fallback !== undefined) return fallback
    invalid("invalid_request", `${label} is required`)
  }
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid("invalid_request", `${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function finiteNumber(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid("invalid_request", `${label} must be a finite number between ${minimum} and ${maximum}`)
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    invalid("invalid_request", `${label} must be exactly representable`)
  }
  return Object.is(value, -0) ? 0 : value
}

function boundedText(value, maximum, label, optional = false) {
  if (optional && (value === undefined || value === null || value === "")) return undefined
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum
    || /[\ud800-\udfff]/u.test(value)) {
    invalid("invalid_request", `${label} must be bounded text without lone surrogates`)
  }
  return value
}

function proposalText(value, maximum, label, optional = false) {
  if (optional && (value === undefined || value === null || value === "")) return null
  if (typeof value !== "string" || !value || value !== value.trim()
    || Array.from(value).length > maximum || /[\ud800-\udfff]/u.test(value)) {
    invalid("invalid_request", `${label} must be bounded text without lone surrogates`)
  }
  return value
}

function uniqueTaskPlanIdentifiers(value, minimum, maximum, label) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    invalid("invalid_request", `${label} must contain ${minimum}-${maximum} stable identifiers`)
  }
  const result = value.map((item, index) => {
    if (typeof item !== "string" || !TASK_PLAN_IDENTIFIER.test(item)) {
      invalid("invalid_request", `${label}[${index}] must be a stable identifier`)
    }
    return item
  })
  if (new Set(result).size !== result.length) invalid("invalid_request", `${label} contains duplicates`)
  return Object.freeze(result)
}

function pinnedReferences(value, label) {
  if (!Array.isArray(value) || value.length > 64) {
    invalid("invalid_request", `${label} must contain at most 64 references`)
  }
  const result = value.map((item, index) => pinnedCanonicalReference(item, `${label}[${index}]`))
  if (new Set(result).size !== result.length) invalid("invalid_request", `${label} contains duplicates`)
  return Object.freeze(result)
}

function taskPlanBranch(value, index) {
  const label = `call.input.branches[${index}]`
  const source = record(value, label)
  const allowed = new Set(["kind", "title", "goal", "instruction", "inputRefs"])
  exactKeys(source, allowed, label)
  requiredKeys(source, new Set(["kind", "title", "goal"]), label)
  if (!TASK_PLAN_BRANCH_KINDS.has(source.kind)) invalid("invalid_request", `${label}.kind is not approved`)
  return Object.freeze({
    kind: source.kind,
    title: proposalText(source.title, 200, `${label}.title`),
    goal: proposalText(source.goal, 4_000, `${label}.goal`),
    instruction: proposalText(source.instruction, 20_000, `${label}.instruction`, true),
    inputRefs: pinnedReferences(source.inputRefs || [], `${label}.inputRefs`),
  })
}

function assertAggregateProposalReferenceBound(inputRefs, branches) {
  const references = new Set(inputRefs)
  for (const branch of branches) {
    for (const reference of branch.inputRefs) references.add(reference)
  }
  if (references.size > 64) {
    invalid("invalid_request", "call.input must contain at most 64 distinct input references")
  }
}

function canvasIdentifier(value, label) {
  if (typeof value !== "string" || !CANVAS_IDENTIFIER.test(value)) {
    invalid("invalid_request", `${label} must be a stable canvas identifier`)
  }
  return value
}

function jsonValue(value, label, depth = 0) {
  if (depth > 8) invalid("invalid_request", `${label} is too deeply nested`)
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "string") {
    if (value.length > 2_000 || /[\ud800-\udfff]/u.test(value)) {
      invalid("invalid_request", `${label} contains invalid text`)
    }
    return value
  }
  if (typeof value === "number") return finiteNumber(value, -10_000_000, 10_000_000, label)
  if (Array.isArray(value)) {
    if (value.length > 32) invalid("invalid_request", `${label} contains too many values`)
    return Object.freeze(value.map((entry, index) => jsonValue(entry, `${label}[${index}]`, depth + 1)))
  }
  const source = record(value, label)
  if (Object.keys(source).length > 32) invalid("invalid_request", `${label} contains too many properties`)
  return Object.freeze(Object.fromEntries(Object.keys(source).sort().map((key) => {
    boundedText(key, 80, `${label} key`)
    return [key, jsonValue(source[key], `${label}.${key}`, depth + 1)]
  })))
}

function canvasPosition(value, label) {
  const source = record(value, label)
  exactKeys(source, new Set(["x", "y"]), label)
  requiredKeys(source, new Set(["x", "y"]), label)
  return Object.freeze({
    x: finiteNumber(source.x, -10_000_000, 10_000_000, `${label}.x`),
    y: finiteNumber(source.y, -10_000_000, 10_000_000, `${label}.y`),
  })
}

function canvasSize(value, label) {
  const source = record(value, label)
  exactKeys(source, new Set(["width", "height"]), label)
  requiredKeys(source, new Set(["width", "height"]), label)
  return Object.freeze({
    width: finiteNumber(source.width, 80, 2_400, `${label}.width`),
    height: finiteNumber(source.height, 80, 2_400, `${label}.height`),
  })
}

function canvasItem(value, label) {
  const source = record(value, label)
  const keys = new Set([
    "id", "subjectRef", "nodeType", "x", "y", "width", "height", "angle",
    "zIndex", "displayMode", "collapsed", "style",
  ])
  exactKeys(source, keys, label)
  requiredKeys(source, keys, label)
  if (!CANVAS_NODE_TYPES.has(source.nodeType)) {
    invalid("invalid_request", `${label}.nodeType is not registered`)
  }
  if (typeof source.collapsed !== "boolean") {
    invalid("invalid_request", `${label}.collapsed must be boolean`)
  }
  const subjectRef = canonicalReference(source.subjectRef, `${label}.subjectRef`)
  if (source.nodeType === "galaxy.chat") {
    const parsed = parseGalaxyObjectReference(subjectRef)
    if (
      parsed.kind !== "chat"
      || parsed.selector.mode !== "pinned"
      || !SHA256_REVISION.test(parsed.selector.revision)
    ) {
      invalid("invalid_reference", `${label}.subjectRef must pin one exact conversation revision`)
    }
  }
  return Object.freeze({
    id: canvasIdentifier(source.id, `${label}.id`),
    subjectRef,
    nodeType: source.nodeType,
    x: finiteNumber(source.x, -10_000_000, 10_000_000, `${label}.x`),
    y: finiteNumber(source.y, -10_000_000, 10_000_000, `${label}.y`),
    width: finiteNumber(source.width, 80, 2_400, `${label}.width`),
    height: finiteNumber(source.height, 80, 2_400, `${label}.height`),
    angle: finiteNumber(source.angle, -360, 360, `${label}.angle`),
    zIndex: integer(source.zIndex, -1_000_000, 1_000_000, `${label}.zIndex`),
    displayMode: boundedText(source.displayMode, 80, `${label}.displayMode`),
    collapsed: source.collapsed,
    style: jsonValue(record(source.style, `${label}.style`), `${label}.style`),
  })
}

function canvasEdge(value, label) {
  const source = record(value, label)
  const allowed = new Set(["id", "sourceItemId", "targetItemId", "edgeKind", "label", "style"])
  exactKeys(source, allowed, label)
  requiredKeys(source, new Set(["id", "sourceItemId", "targetItemId", "edgeKind", "style"]), label)
  const sourceItemId = canvasIdentifier(source.sourceItemId, `${label}.sourceItemId`)
  const targetItemId = canvasIdentifier(source.targetItemId, `${label}.targetItemId`)
  if (sourceItemId === targetItemId) invalid("invalid_request", `${label} cannot connect an item to itself`)
  const edgeLabel = boundedText(source.label, 240, `${label}.label`, true)
  return Object.freeze({
    id: canvasIdentifier(source.id, `${label}.id`),
    sourceItemId,
    targetItemId,
    edgeKind: boundedText(source.edgeKind, 80, `${label}.edgeKind`),
    ...(edgeLabel === undefined ? {} : { label: edgeLabel }),
    style: jsonValue(record(source.style, `${label}.style`), `${label}.style`),
  })
}

function arrangeCommand(value, index) {
  const label = `call.input.commands[${index}]`
  const source = record(value, label)
  if (!ARRANGE_COMMAND_TYPES.has(source.type)) {
    invalid("invalid_request", `${label}.type is not an allowed arrangement command`)
  }
  if (source.type === "item.place") {
    exactKeys(source, new Set(["type", "item"]), label)
    requiredKeys(source, new Set(["type", "item"]), label)
    return Object.freeze({ type: source.type, item: canvasItem(source.item, `${label}.item`) })
  }
  if (source.type === "item.move") {
    exactKeys(source, new Set(["type", "itemId", "position"]), label)
    requiredKeys(source, new Set(["type", "itemId", "position"]), label)
    return Object.freeze({
      type: source.type,
      itemId: canvasIdentifier(source.itemId, `${label}.itemId`),
      position: canvasPosition(source.position, `${label}.position`),
    })
  }
  if (source.type === "item.resize") {
    exactKeys(source, new Set(["type", "itemId", "size"]), label)
    requiredKeys(source, new Set(["type", "itemId", "size"]), label)
    return Object.freeze({
      type: source.type,
      itemId: canvasIdentifier(source.itemId, `${label}.itemId`),
      size: canvasSize(source.size, `${label}.size`),
    })
  }
  if (source.type === "item.reorder") {
    exactKeys(source, new Set(["type", "itemId", "zIndex"]), label)
    requiredKeys(source, new Set(["type", "itemId", "zIndex"]), label)
    return Object.freeze({
      type: source.type,
      itemId: canvasIdentifier(source.itemId, `${label}.itemId`),
      zIndex: integer(source.zIndex, -1_000_000, 1_000_000, `${label}.zIndex`),
    })
  }
  exactKeys(source, new Set(["type", "edge"]), label)
  requiredKeys(source, new Set(["type", "edge"]), label)
  return Object.freeze({ type: source.type, edge: canvasEdge(source.edge, `${label}.edge`) })
}

function cursor(value, label) {
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string" || !CURSOR.test(value)) invalid("invalid_cursor", `${label} is invalid`)
  return value
}

function graphRef(value, label) {
  const source = record(value, label)
  exactKeys(source, new Set(["graphId", "contentSha256"]), label)
  requiredKeys(source, new Set(["graphId", "contentSha256"]), label)
  if (typeof source.graphId !== "string" || !GRAPH_IDENTIFIER.test(source.graphId)) {
    invalid("invalid_graph_ref", `${label}.graphId is invalid`)
  }
  if (typeof source.contentSha256 !== "string" || !SHA256.test(source.contentSha256)) {
    invalid("invalid_graph_ref", `${label}.contentSha256 must be a lowercase SHA-256 digest`)
  }
  return Object.freeze({ graphId: source.graphId, contentSha256: source.contentSha256 })
}

function parseInput(tool, value) {
  const input = record(value, "call.input")
  if (tool === "anchors.create") {
    const keys = new Set(["documentRef", "representation", "selector", "idempotencyKey"])
    exactKeys(input, keys, "call.input")
    requiredKeys(input, keys, "call.input")
    const representation = record(input.representation, "call.input.representation")
    exactKeys(representation, new Set(["id", "contentSha256"]), "call.input.representation")
    requiredKeys(representation, new Set(["id", "contentSha256"]), "call.input.representation")
    if (typeof representation.id !== "string" || !UUID.test(representation.id)) {
      invalid("invalid_request", "call.input.representation.id must be a canonical UUID")
    }
    if (typeof representation.contentSha256 !== "string" || !SHA256.test(representation.contentSha256)) {
      invalid("invalid_request", "call.input.representation.contentSha256 must be a lowercase SHA-256 digest")
    }
    if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      invalid("invalid_request", "call.input.idempotencyKey must be 8-200 printable ASCII characters")
    }
    const selector = anchorSelector(input.selector)
    if (new TextEncoder().encode(canonicalAnchorJson(selector)).byteLength > 32_768) {
      invalid("invalid_request", "call.input.selector exceeds 32768 UTF-8 bytes")
    }
    return Object.freeze({
      documentRef: pinnedDocumentReference(input.documentRef, "call.input.documentRef"),
      representation: Object.freeze({
        id: representation.id.toLowerCase(),
        contentSha256: representation.contentSha256,
      }),
      selector,
      idempotencyKey: input.idempotencyKey,
    })
  }
  if (tool === "canvas.arrange") {
    const keys = new Set([
      "canvasId", "expectedVersion", "expectedContentHash", "idempotencyKey", "commands",
    ])
    exactKeys(input, keys, "call.input")
    requiredKeys(input, keys, "call.input")
    if (typeof input.canvasId !== "string" || !UUID.test(input.canvasId)) {
      invalid("invalid_canvas_id", "call.input.canvasId must be a canonical UUID")
    }
    if (!CANVAS_CONTENT_HASH.test(input.expectedContentHash)) {
      invalid("invalid_request", "call.input.expectedContentHash must be a canonical canvas hash")
    }
    if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      invalid("invalid_request", "call.input.idempotencyKey must be 8-200 printable ASCII characters")
    }
    if (!Array.isArray(input.commands) || input.commands.length < 1 || input.commands.length > 32) {
      invalid("invalid_request", "call.input.commands must contain 1 to 32 arrangement commands")
    }
    return Object.freeze({
      canvasId: input.canvasId.toLowerCase(),
      expectedVersion: integer(
        input.expectedVersion, 1, Number.MAX_SAFE_INTEGER, "call.input.expectedVersion",
      ),
      expectedContentHash: input.expectedContentHash,
      idempotencyKey: input.idempotencyKey,
      commands: Object.freeze(input.commands.map(arrangeCommand)),
    })
  }
  if (tool === "relations.propose") {
    const keys = new Set(["fromRef", "toRef", "relation", "rationale", "idempotencyKey"])
    exactKeys(input, keys, "call.input")
    requiredKeys(input, keys, "call.input")
    const fromRef = durableRelationReference(input.fromRef, "call.input.fromRef")
    const toRef = durableRelationReference(input.toRef, "call.input.toRef")
    if (fromRef === toRef) invalid("invalid_request", "call.input endpoints must be distinct")
    if (!RELATIONS.has(input.relation)) invalid("invalid_request", "call.input.relation is not supported")
    const rationale = boundedText(input.rationale, 4_096, "call.input.rationale")
    if (new TextEncoder().encode(rationale).byteLength > 4_096) {
      invalid("invalid_request", "call.input.rationale exceeds 4 KiB")
    }
    if (typeof input.idempotencyKey !== "string" || !RELATION_IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      invalid("invalid_request", "call.input.idempotencyKey must be 8-200 letters, digits, dots, underscores, colons, or hyphens")
    }
    const normalized = { fromRef, toRef, relation: input.relation, rationale, idempotencyKey: input.idempotencyKey }
    if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > 8_192) {
      invalid("invalid_request", "call.input relation proposal exceeds 8 KiB")
    }
    return Object.freeze(normalized)
  }
  if (tool === "surface.draft.create") {
    const keys = new Set(["title", "spec", "evidenceRefs", "idempotencyKey"])
    exactKeys(input, keys, "call.input")
    requiredKeys(input, keys, "call.input")
    const title = proposalText(input.title, 200, "call.input.title")
    if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      invalid("invalid_request", "call.input.idempotencyKey must be 8-200 printable ASCII characters")
    }
    return Object.freeze({
      title,
      spec: surfaceDefinition(input.spec),
      evidenceRefs: surfaceEvidenceReferences(input.evidenceRefs),
      idempotencyKey: input.idempotencyKey,
    })
  }
  if (tool === "ham.memory.search") {
    if (Object.hasOwn(input, "mode")
      && (typeof input.mode !== "string" || !HAM_SEARCH_MODES.has(input.mode))) {
      invalid("invalid_request", "call.input.mode is invalid")
    }
    const mode = Object.hasOwn(input, "mode") ? input.mode : "search"
    const keys = mode === "search"
      ? new Set(["query", "mode", "topK"])
      : mode === "multihop"
        ? new Set(["query", "mode", "topK", "maxHops"])
        : mode === "temporal"
          ? new Set(["query", "mode", "topK", "asOf", "temporalMode", "includeHistory"])
          : new Set(["query", "mode", "topK"])
    exactKeys(input, keys, "call.input")
    requiredKeys(input, new Set(["query"]), "call.input")
    if (Object.hasOwn(input, "topK")
      && (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 50)) {
      invalid("invalid_request", "call.input.topK must be an integer between 1 and 50")
    }
    if (mode === "multihop" && Object.hasOwn(input, "maxHops")
      && (!Number.isInteger(input.maxHops) || input.maxHops < 0 || input.maxHops > 2)) {
      invalid("invalid_request", "call.input.maxHops must be an integer between 0 and 2")
    }
    if (mode === "temporal") {
      if (typeof input.asOf !== "string" || !input.asOf.trim()
        || !Number.isFinite(Date.parse(input.asOf))) {
        invalid("invalid_request", "call.input.asOf must be a valid timestamp string")
      }
      if (Object.hasOwn(input, "temporalMode")
        && (typeof input.temporalMode !== "string"
          || !HAM_TEMPORAL_MODES.has(input.temporalMode))) {
        invalid("invalid_request", "call.input.temporalMode is invalid")
      }
      if (Object.hasOwn(input, "includeHistory") && typeof input.includeHistory !== "boolean") {
        invalid("invalid_request", "call.input.includeHistory must be a boolean")
      }
    }
    let parsed
    try {
      parsed = parseHamSearchRequest(input)
    } catch {
      invalid("invalid_request", "call.input must be a valid bounded HAM memory search request")
    }
    const normalized = {
      query: parsed.body.query,
      mode: parsed.mode,
      topK: parsed.body.top_k,
    }
    if (parsed.mode === "multihop") normalized.maxHops = parsed.body.max_hops
    if (parsed.mode === "temporal") {
      normalized.asOf = parsed.body.as_of
      normalized.temporalMode = parsed.body.mode
      normalized.includeHistory = parsed.body.include_history
    }
    return Object.freeze(normalized)
  }
  if (tool === "objects.get") {
    exactKeys(input, new Set(["ref"]), "call.input")
    requiredKeys(input, new Set(["ref"]), "call.input")
    return Object.freeze({ ref: canonicalReference(input.ref, "call.input.ref") })
  }
  if (tool === "graph.window.get") {
    exactKeys(input, new Set([
      "rootRef", "viewport", "kinds", "relations", "expandClusterId", "cursor",
    ]), "call.input")
    try {
      return createGraphWindowRequest({
        rootRef: input.rootRef,
        viewport: input.viewport,
        kinds: input.kinds,
        relations: input.relations,
        expandClusterId: input.expandClusterId,
        cursor: input.cursor,
      })
    } catch {
      invalid("invalid_request", "call.input must be a valid bounded graph window request")
    }
  }
  if (tool === "objects.representations") {
    exactKeys(input, new Set(["ref", "cursor", "limit"]), "call.input")
    requiredKeys(input, new Set(["ref"]), "call.input")
    return Object.freeze({
      ref: canonicalReference(input.ref, "call.input.ref"),
      cursor: cursor(input.cursor, "call.input.cursor"),
      limit: integer(input.limit, 1, 32, "call.input.limit", 16),
    })
  }
  if (tool === "objects.search") {
    try {
      return createDocumentCorpusSearchRequest(input)
    } catch {
      invalid("invalid_request", "call.input must be a valid bounded document corpus search")
    }
  }
  if (tool === "canvas.get") {
    exactKeys(input, new Set(["canvasId", "cursor", "limit"]), "call.input")
    requiredKeys(input, new Set(["canvasId"]), "call.input")
    if (typeof input.canvasId !== "string" || !UUID.test(input.canvasId)) {
      invalid("invalid_canvas_id", "call.input.canvasId must be a canonical UUID")
    }
    return Object.freeze({
      canvasId: input.canvasId.toLowerCase(),
      cursor: cursor(input.cursor, "call.input.cursor"),
      limit: integer(input.limit, 1, 200, "call.input.limit", 100),
    })
  }
  if (tool === "task.plan.get") {
    exactKeys(input, new Set(["taskPlanId", "hamTaskId"]), "call.input")
    const hasPlanId = Object.hasOwn(input, "taskPlanId")
    const hasHamTaskId = Object.hasOwn(input, "hamTaskId")
    if (hasPlanId === hasHamTaskId) {
      invalid("invalid_request", "call.input must select exactly one taskPlanId or hamTaskId")
    }
    if (hasPlanId && (typeof input.taskPlanId !== "string" || !UUID.test(input.taskPlanId))) {
      invalid("invalid_task_plan_id", "call.input.taskPlanId must be a canonical UUID")
    }
    if (hasHamTaskId && (typeof input.hamTaskId !== "string" || !HAM_TASK_IDENTIFIER.test(input.hamTaskId))) {
      invalid("invalid_request", "call.input.hamTaskId is invalid")
    }
    return Object.freeze({
      taskPlanId: hasPlanId ? input.taskPlanId.toLowerCase() : null,
      hamTaskId: hasHamTaskId ? input.hamTaskId : null,
    })
  }
  if (tool === "task.plan.propose") {
    const allowed = new Set([
      "taskPlanId", "expectedVersion", "expectedContentHash", "expectedHamTaskId",
      "expectedHamTaskVersion", "action", "sourceJobIds", "title", "goal", "instruction",
      "inputRefs", "branches",
    ])
    exactKeys(input, allowed, "call.input")
    requiredKeys(input, new Set([
      "taskPlanId", "expectedVersion", "expectedContentHash", "expectedHamTaskId",
      "expectedHamTaskVersion", "action", "sourceJobIds", "title", "goal",
    ]), "call.input")
    if (typeof input.taskPlanId !== "string" || !UUID.test(input.taskPlanId)) {
      invalid("invalid_task_plan_id", "call.input.taskPlanId must be a canonical UUID")
    }
    if (typeof input.expectedContentHash !== "string" || !SHA256.test(input.expectedContentHash)) {
      invalid("invalid_request", "call.input.expectedContentHash must be a lowercase SHA-256 digest")
    }
    if (typeof input.expectedHamTaskId !== "string" || !HAM_TASK_IDENTIFIER.test(input.expectedHamTaskId)) {
      invalid("invalid_request", "call.input.expectedHamTaskId is invalid")
    }
    if (!TASK_PLAN_ACTIONS.has(input.action)) invalid("invalid_request", "call.input.action is not approved")
    const sourceJobIds = uniqueTaskPlanIdentifiers(input.sourceJobIds, 1, 16, "call.input.sourceJobIds")
    if (input.action === "branch" && sourceJobIds.length !== 1) {
      invalid("invalid_request", "branch proposals require exactly one source job")
    }
    if (["join", "compare", "synthesize"].includes(input.action) && sourceJobIds.length < 2) {
      invalid("invalid_request", `${input.action} proposals require at least two source jobs`)
    }
    const branches = input.branches || []
    if (!Array.isArray(branches) || (input.action === "branch" ? branches.length < 2 || branches.length > 8 : branches.length !== 0)) {
      invalid("invalid_request", input.action === "branch"
        ? "branch proposals require 2-8 branch jobs"
        : "only branch proposals may contain branch jobs")
    }
    const inputRefs = pinnedReferences(input.inputRefs || [], "call.input.inputRefs")
    const normalizedBranches = Object.freeze(branches.map(taskPlanBranch))
    assertAggregateProposalReferenceBound(inputRefs, normalizedBranches)
    return Object.freeze({
      taskPlanId: input.taskPlanId.toLowerCase(),
      expectedVersion: integer(input.expectedVersion, 1, Number.MAX_SAFE_INTEGER, "call.input.expectedVersion"),
      expectedContentHash: input.expectedContentHash,
      expectedHamTaskId: input.expectedHamTaskId,
      expectedHamTaskVersion: integer(
        input.expectedHamTaskVersion, 1, Number.MAX_SAFE_INTEGER, "call.input.expectedHamTaskVersion",
      ),
      action: input.action,
      sourceJobIds,
      title: proposalText(input.title, 200, "call.input.title"),
      goal: proposalText(input.goal, 4_000, "call.input.goal"),
      instruction: proposalText(input.instruction, 20_000, "call.input.instruction", true),
      inputRefs,
      branches: normalizedBranches,
    })
  }
  if (tool === "proof.graph.get") {
    exactKeys(input, new Set(["graphRef", "cursor", "limit"]), "call.input")
    requiredKeys(input, new Set(["graphRef"]), "call.input")
    return Object.freeze({
      graphRef: graphRef(input.graphRef, "call.input.graphRef"),
      cursor: cursor(input.cursor, "call.input.cursor"),
      // A structural page reserves one slot for the graph object and must fit
      // both endpoints of at least one relation to guarantee cursor progress.
      limit: integer(input.limit, 3, 200, "call.input.limit", 100),
    })
  }
  if (tool === "proof.frontier.get") {
    exactKeys(input, new Set(["graphRef", "workspaceId", "cursor", "limit"]), "call.input")
    requiredKeys(input, new Set(["graphRef", "workspaceId"]), "call.input")
    if (typeof input.workspaceId !== "string" || !WORKSPACE_IDENTIFIER.test(input.workspaceId)) {
      invalid("invalid_workspace_id", "call.input.workspaceId is invalid")
    }
    return Object.freeze({
      graphRef: graphRef(input.graphRef, "call.input.graphRef"),
      workspaceId: input.workspaceId,
      cursor: cursor(input.cursor, "call.input.cursor"),
      limit: integer(input.limit, 1, 200, "call.input.limit", 100),
    })
  }
  if (tool === "proof.claim") {
    const keys = new Set([
      "graphRef", "workspaceId", "nodeId", "expectedVersion", "expectedItemVersion",
      "action", "leaseSeconds", "idempotencyKey",
    ])
    exactKeys(input, keys, "call.input")
    requiredKeys(input, new Set([
      "graphRef", "workspaceId", "nodeId", "expectedVersion", "expectedItemVersion",
      "action", "idempotencyKey",
    ]), "call.input")
    if (typeof input.workspaceId !== "string" || !WORKSPACE_IDENTIFIER.test(input.workspaceId)) {
      invalid("invalid_workspace_id", "call.input.workspaceId is invalid")
    }
    if (typeof input.nodeId !== "string" || !PROOF_NODE_IDENTIFIER.test(input.nodeId)) {
      invalid("invalid_request", "call.input.nodeId is invalid")
    }
    if (!["acquire", "release"].includes(input.action)) {
      invalid("invalid_request", "call.input.action must be acquire or release")
    }
    if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      invalid("invalid_request", "call.input.idempotencyKey must be 8-200 printable ASCII characters")
    }
    if (input.action === "acquire" && input.leaseSeconds === undefined) {
      invalid("invalid_request", "call.input.leaseSeconds is required for acquire")
    }
    if (input.action === "release" && input.leaseSeconds !== undefined) {
      invalid("invalid_request", "call.input.leaseSeconds is not allowed for release")
    }
    return Object.freeze({
      graphRef: graphRef(input.graphRef, "call.input.graphRef"),
      workspaceId: input.workspaceId,
      nodeId: input.nodeId,
      expectedVersion: integer(
        input.expectedVersion, 1, Number.MAX_SAFE_INTEGER, "call.input.expectedVersion",
      ),
      expectedItemVersion: integer(
        input.expectedItemVersion, 0, Number.MAX_SAFE_INTEGER, "call.input.expectedItemVersion",
      ),
      action: input.action,
      ...(input.action === "acquire" ? {
        leaseSeconds: integer(input.leaseSeconds, 60, 86_400, "call.input.leaseSeconds"),
      } : {}),
      idempotencyKey: input.idempotencyKey,
    })
  }
  invalid("unknown_tool", "Agent tool is not registered", 404)
}

export function parseAgentToolCall(value, expectedTool) {
  const call = record(value, "call")
  exactKeys(call, CALL_KEYS, "call")
  requiredKeys(call, CALL_KEYS, "call")
  if (call.schemaId !== AGENT_TOOL_CALL_SCHEMA_ID) invalid("unsupported_schema", `call.schemaId must be ${AGENT_TOOL_CALL_SCHEMA_ID}`)
  if (typeof call.tool !== "string" || !TOOL_SET.has(call.tool)) invalid("unknown_tool", "Agent tool is not registered", 404)
  if (expectedTool !== undefined && call.tool !== expectedTool) invalid("tool_mismatch", "Route tool and call.tool must match")
  return Object.freeze({
    schemaId: AGENT_TOOL_CALL_SCHEMA_ID,
    tool: call.tool,
    input: parseInput(call.tool, call.input),
  })
}

function normalizePagination(value) {
  if (value === undefined || value === null) return undefined
  const pagination = record(value, "pagination")
  exactKeys(pagination, PAGINATION_KEYS, "pagination")
  requiredKeys(pagination, PAGINATION_KEYS, "pagination")
  if (pagination.cursor !== null && (typeof pagination.cursor !== "string" || !CURSOR.test(pagination.cursor))) {
    invalid("invalid_result", "pagination.cursor is invalid", 500)
  }
  if (typeof pagination.hasMore !== "boolean" || pagination.hasMore !== (pagination.cursor !== null)) {
    invalid("invalid_result", "pagination state is inconsistent", 500)
  }
  if (!Number.isSafeInteger(pagination.limit) || pagination.limit < 1 || pagination.limit > 200) {
    invalid("invalid_result", "pagination.limit is invalid", 500)
  }
  return Object.freeze({ cursor: pagination.cursor, hasMore: pagination.hasMore, limit: pagination.limit })
}

export function createAgentToolResult(tool, result, pagination) {
  if (!TOOL_SET.has(tool)) invalid("unknown_tool", "Agent tool is not registered", 404)
  record(result, "result")
  const normalizedPagination = normalizePagination(pagination)
  return Object.freeze({
    schemaId: AGENT_TOOL_RESULT_SCHEMA_ID,
    tool,
    result,
    ...(normalizedPagination ? { pagination: normalizedPagination } : {}),
  })
}

export function serializeAgentToolResult(value) {
  const serialized = JSON.stringify(value)
  if (new TextEncoder().encode(serialized).byteLength > MAX_AGENT_TOOL_RESPONSE_BYTES) {
    invalid("result_too_large", "Agent tool result exceeds 1 MiB", 502)
  }
  return serialized
}

export function createAgentToolError(error) {
  const contract = error instanceof AgentToolContractError
    ? error
    : new AgentToolContractError("tool_unavailable", "Agent tool is unavailable", 503)
  return Object.freeze({
    status: contract.status,
    body: Object.freeze({
      schemaId: AGENT_TOOL_ERROR_SCHEMA_ID,
      error: Object.freeze({ code: contract.code, message: contract.message }),
    }),
  })
}
