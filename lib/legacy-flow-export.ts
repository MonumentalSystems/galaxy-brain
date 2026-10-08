const EXPORT_SCHEMA = "gb.legacy-flow-export.v1" as const
const MAX_FLOWS = 256
const MAX_NODES_PER_FLOW = 128
const MAX_EDGES_PER_FLOW = 512
const MAX_EXPORT_BYTES = 2 * 1024 * 1024
const FLOW_STORAGE_KEY = "flowiseFlows"
const MAX_IDENTIFIER_LENGTH = 200
const MAX_NODE_TYPE_LENGTH = 128
const MAX_NAME_LENGTH = 200
const MAX_DESCRIPTION_LENGTH = 20_000
const MAX_LABEL_LENGTH = 200
const MAX_PROMPT_LENGTH = 20_000
const MAX_MODEL_LENGTH = 200
const MAX_MEMORY_MODE_LENGTH = 180
const MAX_TAGS = 64
const MAX_TAG_LENGTH = 100
const MAX_COORDINATE = 1_000_000

const SAFE_NODE_DATA_FIELDS: Record<string, Readonly<Record<string, number>>> = {
  promptNode: Object.freeze({ label: MAX_LABEL_LENGTH, content: MAX_PROMPT_LENGTH }),
  aiNode: Object.freeze({ label: MAX_LABEL_LENGTH, model: MAX_MODEL_LENGTH }),
  memoryNode: Object.freeze({ label: MAX_LABEL_LENGTH, type: MAX_MEMORY_MODE_LENGTH }),
}
const DEFAULT_SAFE_NODE_DATA_FIELDS: Readonly<Record<string, number>> = Object.freeze({ label: MAX_LABEL_LENGTH })

export type LegacyFlowExportDiagnostic = {
  level: "warning" | "error"
  code:
    | "invalid-export"
    | "invalid-flow"
    | "invalid-node"
    | "invalid-edge"
    | "duplicate-flow"
    | "duplicate-node"
    | "duplicate-edge"
    | "unknown-edge-node"
    | "flow-limit"
    | "node-limit"
    | "edge-limit"
    | "tag-limit"
    | "export-size"
    | "storage-access"
    | "storage-json"
    | "storage-shape"
    | "omitted-flow-metadata"
    | "omitted-node-data"
    | "omitted-edge-data"
  message: string
  flowId?: string
  nodeId?: string
  edgeId?: string
}

export type LegacyFlowExportNode = {
  id: string
  type: string
  position: { x: number; y: number }
  data: Record<string, string>
}

export type LegacyFlowExportEdge = {
  id: string
  source: string
  target: string
  type?: string
  label?: string
}

export type LegacyFlowExportFlow = {
  id: string
  name: string
  description: string
  nodes: LegacyFlowExportNode[]
  edges: LegacyFlowExportEdge[]
  createdAt: string
  updatedAt: string
  version: number
  isTemplate: boolean
  tags: string[]
}

export type LegacyFlowExportBundle = {
  schema: typeof EXPORT_SCHEMA
  flows: LegacyFlowExportFlow[]
}

export type LegacyFlowExportResult = {
  bundle: LegacyFlowExportBundle | null
  json: string | null
  diagnostics: LegacyFlowExportDiagnostic[]
}

export type LegacyFlowStorageReadResult =
  | { ok: true; state: "missing"; flows: [] }
  | { ok: true; state: "present"; flows: unknown[] }
  | { ok: false; code: "storage-access" | "storage-json" | "storage-shape" | "export-size"; message: string }

class ExportBudget {
  private usedBytes: number
  public exceeded = false

  constructor() {
    this.usedBytes = utf8JsonBytes({ schema: EXPORT_SCHEMA, flows: [] })
  }

  consumeJson(value: unknown, conservativeSeparatorBytes = 1): boolean {
    const nextBytes = utf8JsonBytes(value) + conservativeSeparatorBytes
    if (this.usedBytes + nextBytes > MAX_EXPORT_BYTES) {
      this.exceeded = true
      return false
    }
    this.usedBytes += nextBytes
    return true
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function utf8JsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function exactString(value: unknown, maximum: number, allowEmpty = false): string | undefined {
  if (typeof value !== "string" || Array.from(value).length > maximum) return undefined
  if (!allowEmpty && !value.trim()) return undefined
  return value
}

function exactDate(value: unknown): string | undefined {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null
  if (!date || !Number.isFinite(date.valueOf())) return undefined
  const canonical = date.toISOString()
  if (typeof value === "string" && value !== canonical) return undefined
  return canonical
}

function finiteCoordinate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE
    ? value
    : undefined
}

function fail(
  diagnostics: LegacyFlowExportDiagnostic[],
  code: LegacyFlowExportDiagnostic["code"],
  message: string,
  context: Pick<LegacyFlowExportDiagnostic, "flowId" | "nodeId" | "edgeId"> = {},
): void {
  diagnostics.push({ level: "error", code, message, ...context })
}

function failExportSize(diagnostics: LegacyFlowExportDiagnostic[]): void {
  if (diagnostics.some((diagnostic) => diagnostic.code === "export-size")) return
  fail(diagnostics, "export-size", "Legacy flow export exceeds the 2 MiB aggregate UTF-8 limit.")
}

function normalizeNode(
  value: unknown,
  flowId: string,
  diagnostics: LegacyFlowExportDiagnostic[],
): LegacyFlowExportNode | null {
  if (!isRecord(value)) {
    fail(diagnostics, "invalid-node", "Every exported node must be an object.", { flowId })
    return null
  }
  const id = exactString(value.id, MAX_IDENTIFIER_LENGTH)
  const type = exactString(value.type, MAX_NODE_TYPE_LENGTH)
  const position = isRecord(value.position) ? value.position : null
  const x = finiteCoordinate(position?.x)
  const y = finiteCoordinate(position?.y)
  if (!id || !type || x === undefined || y === undefined || !isRecord(value.data)) {
    fail(diagnostics, "invalid-node", "Every exported node needs bounded text identity, finite position, and object data.", {
      flowId,
      ...(id ? { nodeId: id } : {}),
    })
    return null
  }

  const safeFields = Object.hasOwn(SAFE_NODE_DATA_FIELDS, type)
    ? SAFE_NODE_DATA_FIELDS[type]
    : DEFAULT_SAFE_NODE_DATA_FIELDS
  const data: Record<string, string> = {}
  for (const key of Object.keys(safeFields).sort(compareStrings)) {
    if (value.data[key] === undefined) continue
    const field = exactString(value.data[key], safeFields[key], true)
    if (field === undefined) {
      fail(diagnostics, "invalid-node", `Node “${id}” has an invalid or oversized ${key} field.`, { flowId, nodeId: id })
      return null
    }
    data[key] = field
  }
  const omittedCount = Object.keys(value.data).filter((key) => !Object.hasOwn(safeFields, key)).length
  if (omittedCount) {
    diagnostics.push({
      level: "warning",
      code: "omitted-node-data",
      message: `Node “${id}” omitted ${omittedCount} non-portable or potentially sensitive data field${omittedCount === 1 ? "" : "s"}.`,
      flowId,
      nodeId: id,
    })
  }
  return { id, type, position: { x, y }, data }
}

function normalizeEdge(
  value: unknown,
  flowId: string,
  diagnostics: LegacyFlowExportDiagnostic[],
): LegacyFlowExportEdge | null {
  if (!isRecord(value)) {
    fail(diagnostics, "invalid-edge", "Every exported edge must be an object.", { flowId })
    return null
  }
  const source = exactString(value.source, MAX_IDENTIFIER_LENGTH)
  const target = exactString(value.target, MAX_IDENTIFIER_LENGTH)
  const id = exactString(value.id, MAX_IDENTIFIER_LENGTH)
  const type = value.type === undefined ? undefined : exactString(value.type, MAX_NODE_TYPE_LENGTH)
  const label = value.label === undefined ? undefined : exactString(value.label, MAX_LABEL_LENGTH)
  if (!id || !source || !target || (value.type !== undefined && !type) || (value.label !== undefined && !label)) {
    fail(diagnostics, "invalid-edge", "Every exported edge needs bounded text identity and endpoints.", {
      flowId,
      ...(id ? { edgeId: id } : {}),
    })
    return null
  }

  const safeKeys = new Set(["id", "source", "target", "type", "label"])
  const omittedCount = Object.keys(value).filter((key) => !safeKeys.has(key)).length
  if (omittedCount) {
    diagnostics.push({
      level: "warning",
      code: "omitted-edge-data",
      message: `Edge “${id}” omitted ${omittedCount} visual, non-portable, or potentially sensitive field${omittedCount === 1 ? "" : "s"}.`,
      flowId,
      edgeId: id,
    })
  }
  return { id, source, target, ...(type ? { type } : {}), ...(label ? { label } : {}) }
}

function normalizeFlow(
  value: unknown,
  diagnostics: LegacyFlowExportDiagnostic[],
  budget: ExportBudget,
): LegacyFlowExportFlow | null {
  if (!isRecord(value)) {
    fail(diagnostics, "invalid-flow", "Every exported flow must be an object.")
    return null
  }
  const id = exactString(value.id, MAX_IDENTIFIER_LENGTH)
  const name = exactString(value.name, MAX_NAME_LENGTH)
  const description = exactString(value.description, MAX_DESCRIPTION_LENGTH, true)
  const createdAt = exactDate(value.createdAt)
  const updatedAt = exactDate(value.updatedAt)
  const version = value.version
  if (!id || !name || description === undefined || !createdAt || !updatedAt
    || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1
    || typeof value.isTemplate !== "boolean" || !Array.isArray(value.tags)
    || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    fail(diagnostics, "invalid-flow", "Every exported flow needs bounded metadata, valid dates, arrays, and a positive version.", {
      ...(id ? { flowId: id } : {}),
    })
    return null
  }
  if (value.nodes.length > MAX_NODES_PER_FLOW) {
    fail(diagnostics, "node-limit", `Flow “${id}” exceeds ${MAX_NODES_PER_FLOW} nodes.`, { flowId: id })
    return null
  }
  if (value.edges.length > MAX_EDGES_PER_FLOW) {
    fail(diagnostics, "edge-limit", `Flow “${id}” exceeds ${MAX_EDGES_PER_FLOW} edges.`, { flowId: id })
    return null
  }
  if (value.tags.length > MAX_TAGS) {
    fail(diagnostics, "tag-limit", `Flow “${id}” exceeds ${MAX_TAGS} tags.`, { flowId: id })
    return null
  }
  const tags = value.tags.map((tag) => exactString(tag, MAX_TAG_LENGTH)).filter((tag): tag is string => !!tag)
  if (tags.length !== value.tags.length) {
    fail(diagnostics, "invalid-flow", `Flow “${id}” contains an invalid or oversized tag.`, { flowId: id })
    return null
  }

  const flow: LegacyFlowExportFlow = {
    id,
    name,
    description,
    nodes: [],
    edges: [],
    createdAt,
    updatedAt,
    version,
    isTemplate: value.isTemplate,
    tags: [...tags].sort(compareStrings),
  }
  if (!budget.consumeJson(flow)) {
    failExportSize(diagnostics)
    return null
  }

  const nodes: LegacyFlowExportNode[] = []
  for (const nodeValue of value.nodes) {
    const node = normalizeNode(nodeValue, id, diagnostics)
    if (!node) continue
    if (!budget.consumeJson(node)) {
      failExportSize(diagnostics)
      return null
    }
    nodes.push(node)
  }
  nodes.sort((left, right) => compareStrings(left.id, right.id))
  const nodeIds = new Set<string>()
  for (const node of nodes) {
    if (nodeIds.has(node.id)) fail(diagnostics, "duplicate-node", `Flow “${id}” repeats node ID “${node.id}”.`, { flowId: id, nodeId: node.id })
    nodeIds.add(node.id)
  }

  const edges: LegacyFlowExportEdge[] = []
  for (const edgeValue of value.edges) {
    const edge = normalizeEdge(edgeValue, id, diagnostics)
    if (!edge) continue
    if (!budget.consumeJson(edge)) {
      failExportSize(diagnostics)
      return null
    }
    edges.push(edge)
  }
  edges.sort((left, right) => compareStrings(`${left.id}\u0000${left.source}\u0000${left.target}`, `${right.id}\u0000${right.source}\u0000${right.target}`))
  const edgeIds = new Set<string>()
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) fail(diagnostics, "duplicate-edge", `Flow “${id}” repeats edge ID “${edge.id}”.`, { flowId: id, edgeId: edge.id })
    edgeIds.add(edge.id)
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      fail(diagnostics, "unknown-edge-node", `Edge “${edge.id}” references a node outside flow “${id}”.`, { flowId: id, edgeId: edge.id })
    }
  }

  const safeFlowKeys = new Set(["id", "name", "description", "nodes", "edges", "createdAt", "updatedAt", "version", "isTemplate", "tags"])
  const omittedCount = Object.keys(value).filter((key) => !safeFlowKeys.has(key)).length
  if (omittedCount) {
    diagnostics.push({
      level: "warning",
      code: "omitted-flow-metadata",
      message: `Flow “${id}” omitted ${omittedCount} sharing, ownership, or non-portable metadata field${omittedCount === 1 ? "" : "s"}.`,
      flowId: id,
    })
  }

  flow.nodes = nodes
  flow.edges = edges
  return flow
}

export function createLegacyFlowExport(flowsValue: unknown): LegacyFlowExportResult {
  const diagnostics: LegacyFlowExportDiagnostic[] = []
  if (!Array.isArray(flowsValue)) {
    fail(diagnostics, "invalid-export", "Legacy flow export requires an array of browser-local flows.")
    return { bundle: null, json: null, diagnostics }
  }
  if (flowsValue.length > MAX_FLOWS) {
    fail(diagnostics, "flow-limit", `Legacy flow export accepts at most ${MAX_FLOWS} flows at once.`)
    return { bundle: null, json: null, diagnostics }
  }

  const budget = new ExportBudget()
  const flows: LegacyFlowExportFlow[] = []
  for (const flowValue of flowsValue) {
    const flow = normalizeFlow(flowValue, diagnostics, budget)
    if (budget.exceeded) break
    if (flow) flows.push(flow)
  }
  flows.sort((left, right) => compareStrings(left.id, right.id))
  const flowIds = new Set<string>()
  for (const flow of flows) {
    if (flowIds.has(flow.id)) fail(diagnostics, "duplicate-flow", `Flow ID “${flow.id}” appears more than once.`, { flowId: flow.id })
    flowIds.add(flow.id)
  }
  if (diagnostics.some((diagnostic) => diagnostic.level === "error")) {
    return { bundle: null, json: null, diagnostics }
  }

  const bundle: LegacyFlowExportBundle = { schema: EXPORT_SCHEMA, flows }
  const json = JSON.stringify(bundle)
  if (new TextEncoder().encode(json).byteLength > MAX_EXPORT_BYTES) {
    failExportSize(diagnostics)
    return { bundle: null, json: null, diagnostics }
  }
  return { bundle, json, diagnostics }
}

export function parseLegacyFlowExport(json: unknown): LegacyFlowExportResult {
  const diagnostics: LegacyFlowExportDiagnostic[] = []
  if (typeof json !== "string" || json.length > MAX_EXPORT_BYTES
    || new TextEncoder().encode(json).byteLength > MAX_EXPORT_BYTES) {
    fail(diagnostics, "export-size", "Legacy flow export must be text no larger than 2 MiB UTF-8.")
    return { bundle: null, json: null, diagnostics }
  }
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    fail(diagnostics, "invalid-export", "Legacy flow export is not valid JSON.")
    return { bundle: null, json: null, diagnostics }
  }
  if (!isRecord(value) || value.schema !== EXPORT_SCHEMA || !Array.isArray(value.flows)) {
    fail(diagnostics, "invalid-export", `Legacy flow export must use schema ${EXPORT_SCHEMA}.`)
    return { bundle: null, json: null, diagnostics }
  }
  return createLegacyFlowExport(value.flows)
}

export function formatLegacyFlowOptionLabel(flow: LegacyFlowExportFlow): string {
  return `${flow.name} · v${flow.version} · ${flow.id}`
}

export function readLegacyFlowStorage(storage: Pick<Storage, "getItem">): LegacyFlowStorageReadResult {
  let raw: string | null
  try {
    raw = storage.getItem(FLOW_STORAGE_KEY)
  } catch {
    return { ok: false, code: "storage-access", message: "The browser refused access to saved local flows." }
  }
  if (raw === null) return { ok: true, state: "missing", flows: [] }
  if (raw.length > MAX_EXPORT_BYTES) {
    return { ok: false, code: "export-size", message: "Saved local flow data exceeds the 2 MiB export limit." }
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ok: false, code: "storage-json", message: "Saved local flow data is malformed JSON." }
  }
  if (!Array.isArray(value)) {
    return { ok: false, code: "storage-shape", message: "Saved local flow data has an unsupported top-level shape." }
  }
  return { ok: true, state: "present", flows: value }
}

export function createLegacyFlowExportFromStorage(storage: Pick<Storage, "getItem">): LegacyFlowExportResult {
  const stored = readLegacyFlowStorage(storage)
  if (stored.ok) return createLegacyFlowExport(stored.flows)
  return {
    bundle: null,
    json: null,
    diagnostics: [{ level: "error", code: stored.code, message: stored.message }],
  }
}

export const LEGACY_FLOW_EXPORT_SCHEMA = EXPORT_SCHEMA
export const LEGACY_FLOW_EXPORT_FILE_NAME = "galaxy-legacy-flows.flow-export.json"
export const LEGACY_FLOW_EXPORT_MAX_BYTES = MAX_EXPORT_BYTES
export const LEGACY_FLOW_STORAGE_KEY = FLOW_STORAGE_KEY
