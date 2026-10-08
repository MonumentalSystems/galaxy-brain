import type { TaskPlanEdge, TaskPlanNode, TaskPlanNodeKind, TaskPlanSpec } from "@/lib/types/task-plans"

const MAX_NODES = 128
const MAX_EDGES = 512
const MAX_JSON_BYTES = 512_000
const MAX_TASK_ID_LENGTH = 200
const MAX_IDENTIFIER_LENGTH = 128
const MAX_EXECUTOR_PROFILE_LENGTH = 200
const LEGACY_MODEL_PROFILE_PREFIX = "legacy-model:"
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

type LegacyFlowNode = {
  id: string
  type: string
  position?: { x?: number; y?: number }
  data: Record<string, unknown>
}

export type LegacyFlowGraph = {
  id: unknown
  name: unknown
  description?: unknown
  nodes: unknown[]
  edges: unknown[]
}

export type LegacyFlowTaskSeed = {
  id: unknown
  version?: unknown
}

export type LegacyFlowMigrationDiagnostic = {
  level: "warning" | "error"
  code:
    | "invalid-flow"
    | "invalid-flow-name"
    | "invalid-flow-description"
    | "invalid-task"
    | "invalid-task-reference"
    | "invalid-task-version"
    | "empty-flow"
    | "node-limit"
    | "edge-limit"
    | "plan-size"
    | "description-too-long"
    | "prompt-too-long"
    | "invalid-prompt-content"
    | "invalid-model-id"
    | "invalid-node-label"
    | "unsupported-memory-mode"
    | "invalid-node"
    | "duplicate-node"
    | "generated-id-collision"
    | "unknown-node-type"
    | "omitted-node-settings"
    | "invalid-edge"
    | "invalid-edge-label"
    | "omitted-edge-settings"
    | "unsupported-edge-semantics"
    | "duplicate-edge"
    | "unknown-edge-node"
    | "self-edge"
    | "cyclic-graph"
  message: string
  nodeId?: string
  edgeId?: string
}

export type LegacyFlowMigrationResult = {
  plan: TaskPlanSpec | null
  diagnostics: LegacyFlowMigrationDiagnostic[]
}

type NodeMapping = {
  kind: TaskPlanNodeKind
  title: string
  goal: string
  capability?: string
  artifactType?: string
}

const NODE_MAPPINGS: Record<string, NodeMapping> = {
  promptNode: {
    kind: "context",
    title: "Prompt context",
    goal: "Preserve the legacy prompt as bounded task context.",
  },
  memoryNode: {
    kind: "context",
    title: "Conversation context",
    goal: "Resolve the conversation context required by the task.",
    capability: "memory.read",
  },
  knowledgeNode: {
    kind: "research",
    title: "Knowledge retrieval",
    goal: "Retrieve relevant evidence from the configured knowledge source.",
    capability: "knowledge.retrieve",
  },
  documentParserNode: {
    kind: "research",
    title: "Document evidence",
    goal: "Parse a document into evidence that later jobs can reference.",
    capability: "document.parse",
  },
  vectorDatabaseNode: {
    kind: "research",
    title: "Vector retrieval",
    goal: "Retrieve evidence from a vector index.",
    capability: "vector.retrieve",
  },
  embeddingNode: {
    kind: "transform",
    title: "Embed content",
    goal: "Transform selected content into an embedding representation.",
    capability: "embedding.create",
  },
  chainNode: {
    kind: "transform",
    title: "Transform",
    goal: "Apply the bounded transformation described by this legacy chain step.",
  },
  aiNode: {
    kind: "transform",
    title: "Model transform",
    goal: "Apply a model through an executor policy selected at run time.",
    capability: "model.invoke",
  },
  mediaProcessorNode: {
    kind: "transform",
    title: "Process media",
    goal: "Transform the selected media into a task-ready representation.",
    capability: "media.process",
  },
  audioInputNode: {
    kind: "context",
    title: "Audio context",
    goal: "Resolve the audio input required by the task.",
    capability: "audio.read",
  },
  transcriptionNode: {
    kind: "transform",
    title: "Transcribe audio",
    goal: "Transform audio evidence into a citable text representation.",
    capability: "audio.transcribe",
  },
  textToSpeechNode: {
    kind: "artifact",
    title: "Audio artifact",
    goal: "Materialize a generated audio artifact from approved text.",
    capability: "audio.synthesize",
    artifactType: "audio/mpeg",
  },
  outputNode: {
    kind: "artifact",
    title: "Output artifact",
    goal: "Materialize the task output as a durable artifact.",
    artifactType: "text/markdown",
  },
}

const PRESERVED_DATA_KEYS: Record<string, ReadonlySet<string>> = {
  promptNode: new Set(["label", "content"]),
  aiNode: new Set(["label", "model"]),
  memoryNode: new Set(["label", "type"]),
}

const DEFAULT_PRESERVED_DATA_KEYS = new Set(["label"])

const VISUAL_EDGE_KEYS = new Set([
  "animated",
  "ariaLabel",
  "className",
  "deletable",
  "focusable",
  "hidden",
  "interactionWidth",
  "labelBgBorderRadius",
  "labelBgPadding",
  "labelBgStyle",
  "labelShowBg",
  "labelStyle",
  "markerEnd",
  "markerStart",
  "pathOptions",
  "selectable",
  "selected",
  "style",
  "zIndex",
])

const VISUAL_EDGE_TYPES = new Set(["default", "straight", "step", "smoothstep", "simplebezier"])

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function exactString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.trim()
  if (!normalized || Array.from(normalized).length > maximum) return undefined
  return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function ownTableValue<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined
}

function contractString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined
  if (!value.trim() || Array.from(value).length > maximum) return undefined
  return value
}

function exceedsCharacterLimit(value: unknown, maximum: number): boolean {
  return typeof value === "string" && Array.from(value).length > maximum
}

function legacyModelProfile(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value !== value.trim()) return undefined
  const profile = `${LEGACY_MODEL_PROFILE_PREFIX}${value}`
  return Array.from(profile).length <= MAX_EXECUTOR_PROFILE_LENGTH ? profile : undefined
}

export function createLegacyFlowDownloadName(flowName: unknown): string {
  const normalized = exactString(flowName, 200) || "legacy-flow"
  const stem = normalized.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "legacy-flow"
  return `${stem.slice(0, 80)}.task-plan.json`
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

function stableIdentifier(prefix: string, value: string): string {
  const readable = value.replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "") || "item"
  const suffix = stableHash(value)
  const available = MAX_IDENTIFIER_LENGTH - prefix.length - suffix.length - 2
  return `${prefix}-${readable.slice(0, Math.max(1, available))}-${suffix}`
}

function finiteCoordinate(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000
    ? value
    : fallback
}

function hasCycle(nodeIds: string[], edges: TaskPlanEdge[]): boolean {
  const outgoing = new Map(nodeIds.map((id) => [id, [] as string[]]))
  const indegree = new Map(nodeIds.map((id) => [id, 0]))
  for (const edge of edges) {
    outgoing.get(edge.source)?.push(edge.target)
    indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1)
  }
  const queue = nodeIds.filter((id) => indegree.get(id) === 0)
  let visited = 0
  while (queue.length) {
    const id = queue.shift()!
    visited += 1
    for (const target of outgoing.get(id) || []) {
      const next = (indegree.get(target) || 0) - 1
      indegree.set(target, next)
      if (next === 0) queue.push(target)
    }
  }
  return visited !== nodeIds.length
}

function nodeConfig(node: LegacyFlowNode, mapping: NodeMapping): TaskPlanNode["config"] {
  const promptInstruction = node.type === "promptNode" ? contractString(node.data?.content, 20_000) : undefined
  const memoryMode = node.type === "memoryNode" ? exactString(node.data?.type, 180) : undefined
  const instruction = promptInstruction || (memoryMode ? `Use legacy memory mode: ${memoryMode}.` : undefined)
  const executorProfile = node.type === "aiNode" ? legacyModelProfile(node.data?.model) : undefined
  return {
    ...(instruction ? { instruction } : {}),
    ...(mapping.capability ? { capabilities: [mapping.capability] } : {}),
    ...(executorProfile ? { executorProfile } : {}),
    ...(mapping.artifactType ? { artifactType: mapping.artifactType } : {}),
  }
}

export function migrateLegacyFlowToTaskPlan(
  flowValue: unknown,
  taskValue: unknown,
): LegacyFlowMigrationResult {
  const diagnostics: LegacyFlowMigrationDiagnostic[] = []
  if (!isRecord(flowValue)) {
    diagnostics.push({ level: "error", code: "invalid-flow", message: "The imported flow must be a JSON object." })
  }
  if (!isRecord(taskValue)) {
    diagnostics.push({ level: "error", code: "invalid-task", message: "The task reference must be a JSON object." })
  }
  if (!isRecord(flowValue) || !isRecord(taskValue)) return { plan: null, diagnostics }

  const flow = flowValue
  const task = taskValue
  if (typeof flow.id !== "string" || !flow.id.trim()) {
    diagnostics.push({ level: "error", code: "invalid-flow", message: "The imported flow must contain a non-empty text ID." })
  }

  const flowName = exactString(flow.name, 200)
  if (!flowName) {
    diagnostics.push({
      level: "error",
      code: "invalid-flow-name",
      message: "The imported flow name must be non-empty text of at most 200 characters.",
    })
  }

  let description: string | undefined
  if (flow.description !== undefined) {
    if (typeof flow.description !== "string") {
      diagnostics.push({
        level: "error",
        code: "invalid-flow-description",
        message: "The imported flow description must be text when provided.",
      })
    } else if (exceedsCharacterLimit(flow.description, 20_000)) {
      diagnostics.push({
        level: "error",
        code: "description-too-long",
        message: "The legacy flow description exceeds the 20,000-character task goal limit; shorten or split it before migration.",
      })
    } else if (flow.description.trim()) {
      description = flow.description
    }
  }

  const taskId = typeof task.id === "string" ? task.id : ""
  if (taskId.length > MAX_TASK_ID_LENGTH || !TASK_ID_PATTERN.test(taskId)) {
    diagnostics.push({
      level: "error",
      code: "invalid-task-reference",
      message: "Enter a HAM task ID using letters, numbers, dots, underscores, colons, or hyphens (maximum 200 characters).",
    })
  }
  const taskVersion = task.version
  if (taskVersion !== undefined && (
    typeof taskVersion !== "number"
    || !Number.isSafeInteger(taskVersion)
    || taskVersion < 1
  )) {
    diagnostics.push({
      level: "error",
      code: "invalid-task-version",
      message: "Task version must be a positive whole number when provided.",
    })
  }
  const rawNodes = Array.isArray(flow.nodes) ? flow.nodes : []
  const rawEdges = Array.isArray(flow.edges) ? flow.edges : []
  if (!Array.isArray(flow.nodes)) {
    diagnostics.push({ level: "error", code: "invalid-flow", message: "The imported flow nodes field must be an array." })
  } else if (rawNodes.length === 0) {
    diagnostics.push({ level: "error", code: "empty-flow", message: "The legacy flow has no nodes to migrate." })
  } else if (rawNodes.length > MAX_NODES) {
    diagnostics.push({ level: "error", code: "node-limit", message: `Task plans accept at most ${MAX_NODES} jobs.` })
  }
  if (!Array.isArray(flow.edges)) {
    diagnostics.push({ level: "error", code: "invalid-flow", message: "The imported flow edges field must be an array." })
  } else if (rawEdges.length > MAX_EDGES) {
    diagnostics.push({ level: "error", code: "edge-limit", message: `Task plans accept at most ${MAX_EDGES} edges.` })
  }

  const originalNodeIds = new Set<string>()
  const generatedNodeIds = new Map<string, string>()
  const mappedIds = new Map<string, string>()
  const nodes: TaskPlanNode[] = []
  const sortedNodes = [...rawNodes].sort((left, right) => compareStrings(
    String(isRecord(left) ? left.id : ""),
    String(isRecord(right) ? right.id : ""),
  ))

  for (const [index, nodeValue] of sortedNodes.entries()) {
    if (!isRecord(nodeValue)) {
      diagnostics.push({ level: "error", code: "invalid-node", message: `Legacy node ${index + 1} has no stable ID.` })
      continue
    }
    if (typeof nodeValue.id !== "string" || !nodeValue.id.trim()) {
      diagnostics.push({ level: "error", code: "invalid-node", message: `Legacy node ${index + 1} has no stable ID.` })
      continue
    }
    if (typeof nodeValue.type !== "string" || !nodeValue.type.trim()) {
      diagnostics.push({ level: "error", code: "invalid-node", nodeId: nodeValue.id, message: `Node “${nodeValue.id}” has no valid type.` })
      continue
    }
    if (nodeValue.data !== undefined && !isRecord(nodeValue.data)) {
      diagnostics.push({ level: "error", code: "invalid-node", nodeId: nodeValue.id, message: `Node “${nodeValue.id}” data must be a JSON object.` })
      continue
    }
    const node: LegacyFlowNode = {
      id: nodeValue.id,
      type: nodeValue.type,
      position: isRecord(nodeValue.position) ? nodeValue.position : undefined,
      data: isRecord(nodeValue.data) ? nodeValue.data : {},
    }
    if (originalNodeIds.has(node.id)) {
      diagnostics.push({ level: "error", code: "duplicate-node", nodeId: node.id, message: `Legacy node ID “${node.id}” is duplicated.` })
      continue
    }
    originalNodeIds.add(node.id)
    const mapping = ownTableValue(NODE_MAPPINGS, node.type)
    if (!mapping) {
      diagnostics.push({
        level: "error",
        code: "unknown-node-type",
        nodeId: node.id,
        message: `Node “${node.id}” uses unsupported type “${node.type || "missing"}”; conversion stopped so it is not silently dropped.`,
      })
      continue
    }
    let invalidSemanticValue = false
    if (node.data.label !== undefined && !exactString(node.data.label, 200)) {
      diagnostics.push({
        level: "error",
        code: "invalid-node-label",
        nodeId: node.id,
        message: `Node “${node.id}” label must be non-empty text of at most 200 characters when provided.`,
      })
      invalidSemanticValue = true
    }
    if (node.type === "promptNode" && node.data.content !== undefined) {
      if (typeof node.data.content !== "string" || !node.data.content.trim()) {
        diagnostics.push({
          level: "error",
          code: "invalid-prompt-content",
          nodeId: node.id,
          message: `Node “${node.id}” prompt content must be non-empty text when provided.`,
        })
        invalidSemanticValue = true
      } else if (exceedsCharacterLimit(node.data.content, 20_000)) {
        diagnostics.push({
          level: "error",
          code: "prompt-too-long",
          nodeId: node.id,
          message: `Node “${node.id}” contains a prompt above the 20,000-character instruction limit; shorten or split it before migration.`,
        })
        invalidSemanticValue = true
      }
    }
    if (node.type === "aiNode" && node.data.model !== undefined && !legacyModelProfile(node.data.model)) {
      diagnostics.push({
        level: "error",
        code: "invalid-model-id",
        nodeId: node.id,
        message: `Node “${node.id}” model ID must be non-empty text without surrounding whitespace and must fit the 200-character executor-profile limit after namespacing.`,
      })
      invalidSemanticValue = true
    }
    if (node.type === "memoryNode" && node.data.type !== undefined && !exactString(node.data.type, 180)) {
      diagnostics.push({
        level: "error",
        code: "unsupported-memory-mode",
        nodeId: node.id,
        message: `Node “${node.id}” has a memory mode that cannot be represented safely; use a non-empty text value of at most 180 characters.`,
      })
      invalidSemanticValue = true
    }
    if (invalidSemanticValue) continue

    const id = stableIdentifier("legacy", node.id)
    const collidingNodeId = generatedNodeIds.get(id)
    if (collidingNodeId) {
      diagnostics.push({
        level: "error",
        code: "generated-id-collision",
        nodeId: node.id,
        message: `Nodes “${collidingNodeId}” and “${node.id}” produce the same task-plan ID; rename one before migration.`,
      })
      continue
    }
    generatedNodeIds.set(id, node.id)
    mappedIds.set(node.id, id)
    const title = exactString(node.data.label, 200) || mapping.title
    nodes.push({
      id,
      kind: mapping.kind,
      title,
      goal: mapping.goal,
      position: {
        x: finiteCoordinate(node.position?.x, 80 + (index % 4) * 300),
        y: finiteCoordinate(node.position?.y, 80 + Math.floor(index / 4) * 210),
      },
      config: nodeConfig(node, mapping),
    })

    const preservedKeys = ownTableValue(PRESERVED_DATA_KEYS, node.type) || DEFAULT_PRESERVED_DATA_KEYS
    const omittedKeys = Object.keys(node.data || {}).filter((key) => !preservedKeys.has(key)).sort(compareStrings)
    if (omittedKeys.length) {
      diagnostics.push({
        level: "warning",
        code: "omitted-node-settings",
        nodeId: node.id,
        message: `Node “${node.id}” has legacy settings that need manual review: ${omittedKeys.join(", ")}.`,
      })
    }
  }

  const originalEdgeIds = new Set<string>()
  const generatedEdgeIds = new Map<string, string>()
  const edges: TaskPlanEdge[] = []
  const sortedEdges = [...rawEdges].sort((left, right) => {
    const leftKey = isRecord(left)
      ? `${String(left.source)}\u0000${String(left.target)}\u0000${String(left.id || "")}\u0000${typeof left.label === "string" ? left.label : ""}`
      : ""
    const rightKey = isRecord(right)
      ? `${String(right.source)}\u0000${String(right.target)}\u0000${String(right.id || "")}\u0000${typeof right.label === "string" ? right.label : ""}`
      : ""
    return compareStrings(leftKey, rightKey)
  })

  for (const [index, edge] of sortedEdges.entries()) {
    if (!isRecord(edge) || typeof edge.source !== "string" || !edge.source.trim() || typeof edge.target !== "string" || !edge.target.trim()) {
      diagnostics.push({ level: "error", code: "invalid-edge", message: `Legacy edge ${index + 1} has invalid endpoints.` })
      continue
    }
    if (edge.id !== undefined && (typeof edge.id !== "string" || !edge.id.trim())) {
      diagnostics.push({ level: "error", code: "invalid-edge", message: `Legacy edge ${index + 1} has an invalid ID.` })
      continue
    }
    const originalId = typeof edge.id === "string" ? edge.id : `${edge.source}-${edge.target}-${index}`
    if (originalEdgeIds.has(originalId)) {
      diagnostics.push({ level: "error", code: "duplicate-edge", edgeId: originalId, message: `Legacy edge ID “${originalId}” is duplicated.` })
      continue
    }
    originalEdgeIds.add(originalId)
    let invalidEdgeSettings = false
    const label = edge.label === undefined ? undefined : exactString(edge.label, 200)
    if (edge.label !== undefined && !label) {
      diagnostics.push({
        level: "error",
        code: "invalid-edge-label",
        edgeId: originalId,
        message: `Edge “${originalId}” label must be non-empty text of at most 200 characters when provided.`,
      })
      invalidEdgeSettings = true
    }

    const omittedVisualSettings = Object.keys(edge).filter((key) => VISUAL_EDGE_KEYS.has(key)).sort(compareStrings)
    if (edge.type !== undefined) {
      if (typeof edge.type !== "string" || !VISUAL_EDGE_TYPES.has(edge.type)) {
        diagnostics.push({
          level: "error",
          code: "unsupported-edge-semantics",
          edgeId: originalId,
          message: `Edge “${originalId}” uses unsupported type semantics; convert it to an explicit task-plan branch, join, or checkpoint.`,
        })
        invalidEdgeSettings = true
      } else {
        omittedVisualSettings.push("type")
      }
    }
    if (edge.data !== undefined) {
      diagnostics.push({
        level: "error",
        code: "unsupported-edge-semantics",
        edgeId: originalId,
        message: `Edge “${originalId}” contains data or conditional semantics that cannot be represented as an unconditional task-plan edge.`,
      })
      invalidEdgeSettings = true
    }
    const knownKeys = new Set(["id", "source", "target", "label", "type", "data", ...VISUAL_EDGE_KEYS])
    const unsupportedKeys = Object.keys(edge).filter((key) => !knownKeys.has(key)).sort(compareStrings)
    if (unsupportedKeys.length) {
      diagnostics.push({
        level: "error",
        code: "unsupported-edge-semantics",
        edgeId: originalId,
        message: `Edge “${originalId}” has unsupported settings that may affect routing: ${unsupportedKeys.join(", ")}.`,
      })
      invalidEdgeSettings = true
    }
    if (omittedVisualSettings.length) {
      diagnostics.push({
        level: "warning",
        code: "omitted-edge-settings",
        edgeId: originalId,
        message: `Edge “${originalId}” visual settings are not part of the task-plan contract: ${omittedVisualSettings.sort(compareStrings).join(", ")}.`,
      })
    }
    if (invalidEdgeSettings) continue

    const source = mappedIds.get(edge.source)
    const target = mappedIds.get(edge.target)
    if (!source || !target) {
      diagnostics.push({
        level: "error",
        code: "unknown-edge-node",
        edgeId: originalId,
        message: `Edge “${originalId}” references a node that cannot be migrated.`,
      })
      continue
    }
    if (source === target) {
      diagnostics.push({ level: "error", code: "self-edge", edgeId: originalId, message: `Edge “${originalId}” connects a job to itself.` })
      continue
    }
    const id = stableIdentifier("edge", originalId)
    const collidingEdgeId = generatedEdgeIds.get(id)
    if (collidingEdgeId) {
      diagnostics.push({
        level: "error",
        code: "generated-id-collision",
        edgeId: originalId,
        message: `Edges “${collidingEdgeId}” and “${originalId}” produce the same task-plan ID; rename one before migration.`,
      })
      continue
    }
    generatedEdgeIds.set(id, originalId)
    edges.push({
      id,
      source,
      target,
      kind: "data",
      ...(label ? { label } : {}),
    })
  }

  if (!diagnostics.some((item) => item.level === "error") && hasCycle(nodes.map((node) => node.id), edges)) {
    diagnostics.push({
      level: "error",
      code: "cyclic-graph",
      message: "The legacy graph contains a cycle. Add an explicit bounded loop policy or remove the cycle before migration.",
    })
  }

  if (diagnostics.some((item) => item.level === "error")) return { plan: null, diagnostics }

  const plan: TaskPlanSpec = {
    schema: "gb.task-plan.v1",
    task: {
      kind: "galaxy.ham.task",
      id: taskId,
      ...(typeof taskVersion === "number" ? { version: taskVersion } : {}),
    },
    goal: description || `Migrate “${flowName}” into an explicit, versioned task plan.`,
    nodes,
    edges,
  }
  if (new TextEncoder().encode(JSON.stringify(plan)).byteLength > MAX_JSON_BYTES) {
    diagnostics.push({
      level: "error",
      code: "plan-size",
      message: `The migrated task plan exceeds the canonical ${MAX_JSON_BYTES.toLocaleString()}-byte UTF-8 limit. Split the legacy flow before migration.`,
    })
    return { plan: null, diagnostics }
  }
  return { plan, diagnostics }
}
