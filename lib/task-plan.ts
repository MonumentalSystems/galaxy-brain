import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "@/lib/galaxy-object-reference.js"
import type {
  TaskPlanEdge,
  TaskPlanNode,
  TaskPlanNodeKind,
  TaskPlanProposal,
  TaskPlanRecord,
  TaskPlanSpec,
} from "@/lib/types/task-plans"

type TaskPlanSeed = {
  id: string
  title: string
  goal: string
  version?: number
  resources?: readonly {
    resourceRef: string
    redacted?: boolean
    mode: "observe" | "read" | "write" | "exclusive"
    status: string
  }[]
}

const TASK_PLAN_TITLE_LIMIT = 200
const TASK_PLAN_TITLE_SUFFIX = " · plan"
const TASK_PLAN_EDGE_LIMIT = 512
const TASK_PLAN_EDGE_LABEL_LIMIT = 200
const TASK_PLAN_NODE_LIMIT = 128
const TASK_PLAN_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TASK_PLAN_PROPOSAL_HASH = /^sha256:[0-9a-f]{64}$/
const TASK_PLAN_PROPOSAL_ACTIONS = new Set(["branch", "join", "compare", "challenge", "synthesize"])
const TASK_PLAN_PROPOSAL_LIMIT = 64
const TASK_PLAN_SIZE_LIMIT = 512_000
const TASK_PLAN_PROPOSAL_KEYS = new Set([
  "schemaId", "requestHash", "scope", "effect", "action", "base", "sourceJobIds", "inputRefs",
  "operations", "summary", "proposalHash",
])
const TASK_PLAN_PROPOSAL_BASE_KEYS = new Set([
  "taskPlanId", "taskPlanVersion", "taskPlanContentHash", "hamTaskId", "hamTaskVersion",
])
const PROPOSAL_AUTHORITY_KEYS = [
  "outputRefs",
  "capabilities",
  "executorProfile",
  "requiresApproval",
  "artifactType",
] as const

export const TASK_PLAN_EDGE_KINDS = ["control", "data", "evidence", "branch", "join"] as const

export type TaskPlanEdgeInput = {
  source: string
  target: string
  kind: TaskPlanEdge["kind"]
  label?: string
}

export type TaskConstructorCloseDecision = "close" | "confirm" | "wait"

export type TaskPlanProposalPreview = Readonly<{
  proposalHash: string
  spec: TaskPlanSpec
  addedNodeIds: readonly string[]
  addedEdgeIds: readonly string[]
}>

const DEFAULT_NODE_COPY: Record<TaskPlanNodeKind, { title: string; goal: string }> = {
  context: { title: "Context", goal: "Gather the references, artifacts, and task constraints that bound the work." },
  research: { title: "Research", goal: "Collect relevant evidence and preserve source provenance." },
  transform: { title: "Transform", goal: "Convert the selected material into the representation this task needs." },
  compare: { title: "Compare", goal: "Weigh competing explanations against shared criteria." },
  challenge: { title: "Challenge", goal: "Look for disconfirming evidence and hidden assumptions." },
  synthesize: { title: "Synthesize", goal: "Combine findings and surface useful fusions without erasing disagreement." },
  branch: { title: "Branch", goal: "Fork independent lines of work from the same bounded context." },
  join: { title: "Join", goal: "Wait for the selected branches and reunite their evidence." },
  checkpoint: { title: "Review", goal: "Pause for a human decision before consequential execution." },
  artifact: { title: "Artifact", goal: "Materialize a durable, cited output attached to the task." },
}

function planNode(
  id: string,
  kind: TaskPlanNodeKind,
  x: number,
  y: number,
  inputRefs: readonly string[] = [],
): TaskPlanNode {
  const copy = DEFAULT_NODE_COPY[kind]
  return {
    id,
    kind,
    title: copy.title,
    goal: copy.goal,
    position: { x, y },
    config: {
      ...(inputRefs.length ? { inputRefs: [...inputRefs] } : {}),
      ...(kind === "checkpoint" ? { requiresApproval: true } : {}),
      ...(kind === "artifact" ? { artifactType: "text/markdown" } : {}),
    },
  }
}

export function authorizedPinnedTaskResourceRefs(resources: TaskPlanSeed["resources"]): string[] {
  if (!Array.isArray(resources)) return []
  const references: string[] = []
  for (const resource of resources) {
    if (
      resource?.redacted !== false
      || resource.status !== "active"
      || !["observe", "read"].includes(resource.mode)
      || typeof resource.resourceRef !== "string"
      || Array.from(resource.resourceRef).length > 500
    ) continue
    const parsed = parseGalaxyObjectReference(resource.resourceRef)
    let canonical = ""
    try {
      canonical = parsed ? serializeGalaxyObjectReference(parsed) : ""
    } catch {
      canonical = ""
    }
    if (!parsed || parsed.format !== "canonical" || parsed.selector.mode !== "pinned"
      || canonical !== resource.resourceRef || references.includes(canonical)) continue
    references.push(canonical)
    if (references.length === 8) break
  }
  return references
}

function planEdge(source: string, target: string, kind: TaskPlanEdge["kind"] = "control"): TaskPlanEdge {
  return { id: `${source}-${target}`, source, target, kind }
}

export function createStarterTaskPlan(task: TaskPlanSeed): TaskPlanSpec {
  const inputRefs = authorizedPinnedTaskResourceRefs(task.resources)
  return {
    schema: "gb.task-plan.v1",
    task: {
      kind: "galaxy.ham.task",
      id: task.id,
      ...(task.version ? { version: task.version } : {}),
    },
    goal: task.goal,
    nodes: [
      planNode("context", "context", 40, 210, inputRefs),
      planNode("research", "research", 330, 210),
      planNode("branch", "branch", 620, 210),
      planNode("compare", "compare", 900, 80),
      planNode("challenge", "challenge", 900, 340),
      planNode("join", "join", 1190, 210),
      planNode("synthesize", "synthesize", 1480, 210),
      planNode("checkpoint", "checkpoint", 1770, 210),
      planNode("artifact", "artifact", 2060, 210),
    ],
    edges: [
      planEdge("context", "research", "evidence"),
      planEdge("research", "branch", "control"),
      planEdge("branch", "compare", "branch"),
      planEdge("branch", "challenge", "branch"),
      planEdge("compare", "join", "join"),
      planEdge("challenge", "join", "join"),
      planEdge("join", "synthesize", "control"),
      planEdge("synthesize", "checkpoint", "control"),
      planEdge("checkpoint", "artifact", "control"),
    ],
  }
}

export function createTaskPlanNode(kind: TaskPlanNodeKind, index: number): TaskPlanNode {
  const suffix = crypto.randomUUID().slice(0, 8)
  return planNode(`${kind}-${suffix}`, kind, 120 + (index % 4) * 290, 100 + Math.floor(index / 4) * 220)
}

export function createTaskPlanTitle(taskTitle: string): string {
  const availableCharacters = TASK_PLAN_TITLE_LIMIT - Array.from(TASK_PLAN_TITLE_SUFFIX).length
  const boundedTaskTitle = Array.from(taskTitle).slice(0, availableCharacters).join("").trimEnd()
  return `${boundedTaskTitle}${TASK_PLAN_TITLE_SUFFIX}`
}

function wouldCreateTaskPlanCycle(spec: TaskPlanSpec, source: string, target: string): boolean {
  const outgoing = new Map<string, string[]>()
  for (const edge of spec.edges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) || []), edge.target])
  }
  const stack = [target]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === source) return true
    if (seen.has(current)) continue
    seen.add(current)
    stack.push(...(outgoing.get(current) || []))
  }
  return false
}

function copyTaskPlanNode(node: TaskPlanNode): TaskPlanNode {
  return {
    ...node,
    position: { ...node.position },
    config: {
      ...node.config,
      ...(node.config.inputRefs ? { inputRefs: [...node.config.inputRefs] } : {}),
      ...(node.config.outputRefs ? { outputRefs: [...node.config.outputRefs] } : {}),
      ...(node.config.capabilities ? { capabilities: [...node.config.capabilities] } : {}),
    },
  }
}

function copyTaskPlanSpec(spec: TaskPlanSpec): TaskPlanSpec {
  return {
    ...spec,
    task: { ...spec.task },
    nodes: spec.nodes.map(copyTaskPlanNode),
    edges: spec.edges.map((edge) => ({ ...edge })),
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === null || Object.getPrototypeOf(prototype) === null
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.size && keys.every((key) => expected.has(key))
}

function hasUnpairedSurrogate(value: string): boolean {
  return /[\ud800-\udfff]/u.test(value)
}

function canonicalPinnedProposalReferences(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > TASK_PLAN_PROPOSAL_LIMIT) {
    throw new Error(`${label} may contain at most ${TASK_PLAN_PROPOSAL_LIMIT} references.`)
  }
  const result: string[] = []
  for (const reference of value) {
    if (typeof reference !== "string" || Array.from(reference).length > 500 || hasUnpairedSurrogate(reference)) {
      throw new Error(`${label} contains an invalid reference.`)
    }
    const parsed = parseGalaxyObjectReference(reference)
    let canonical = ""
    try {
      canonical = parsed ? serializeGalaxyObjectReference(parsed) : ""
    } catch {
      canonical = ""
    }
    if (!parsed || parsed.format !== "canonical" || parsed.selector.mode !== "pinned" || canonical !== reference) {
      throw new Error(`${label} must contain only canonical pinned references.`)
    }
    if (result.includes(reference)) throw new Error(`${label} contains a duplicate reference.`)
    result.push(reference)
  }
  return result
}

function assertProposalNode(value: unknown): TaskPlanNode {
  if (!isPlainRecord(value) || !hasExactKeys(value, new Set(["id", "kind", "title", "goal", "position", "config"]))) {
    throw new Error("The proposal contains an invalid job payload.")
  }
  const node = value as TaskPlanNode
  if (typeof node.id !== "string" || !TASK_PLAN_IDENTIFIER.test(node.id)
    || typeof node.kind !== "string" || !Object.hasOwn(DEFAULT_NODE_COPY, node.kind)) {
    throw new Error("The proposal contains an invalid job identity.")
  }
  if (typeof node.title !== "string" || typeof node.goal !== "string"
    || hasUnpairedSurrogate(node.title) || hasUnpairedSurrogate(node.goal)
    || node.title !== node.title.trim() || node.goal !== node.goal.trim()
    || Array.from(node.title).length < 1 || Array.from(node.title).length > 200
    || Array.from(node.goal).length < 1 || Array.from(node.goal).length > 4_000) {
    throw new Error("The proposal contains invalid job text.")
  }
  if (!isPlainRecord(node.position) || !hasExactKeys(node.position, new Set(["x", "y"]))) {
    throw new Error("The proposal contains an invalid job position.")
  }
  if (!Number.isInteger(node.position.x) || !Number.isInteger(node.position.y)
    || Math.abs(node.position.x) > 1_000_000 || Math.abs(node.position.y) > 1_000_000) {
    throw new Error("The proposal contains an invalid job position.")
  }
  if (!isPlainRecord(node.config)) throw new Error("The proposal contains an invalid job configuration.")
  if (PROPOSAL_AUTHORITY_KEYS.some((key) => Object.hasOwn(node.config, key))) {
    throw new Error("A task-plan proposal cannot add execution or output authority.")
  }
  if (Object.keys(node.config).some((key) => key !== "instruction" && key !== "inputRefs")) {
    throw new Error("The proposal contains an unsupported job configuration.")
  }
  if (Object.hasOwn(node.config, "instruction")) {
    if (typeof node.config.instruction !== "string"
      || node.config.instruction !== node.config.instruction.trim()
      || hasUnpairedSurrogate(node.config.instruction)
      || Array.from(node.config.instruction).length < 1
      || Array.from(node.config.instruction).length > 20_000) {
      throw new Error("The proposal contains an invalid job instruction.")
    }
  }
  if (Object.hasOwn(node.config, "inputRefs")) {
    const inputRefs = canonicalPinnedProposalReferences(node.config.inputRefs, "Proposal job input references")
    if (inputRefs.length === 0) throw new Error("Proposal job input references cannot be empty when present.")
  }
  return node
}

function assertProposalEdge(value: unknown): TaskPlanEdge {
  if (!isPlainRecord(value) || !hasExactKeys(value, new Set(["id", "source", "target", "kind"]))) {
    throw new Error("The proposal contains an invalid connection payload.")
  }
  const edge = value as TaskPlanEdge
  if (typeof edge.id !== "string" || !TASK_PLAN_IDENTIFIER.test(edge.id)
    || typeof edge.source !== "string" || !TASK_PLAN_IDENTIFIER.test(edge.source)
    || typeof edge.target !== "string" || !TASK_PLAN_IDENTIFIER.test(edge.target)
    || !(TASK_PLAN_EDGE_KINDS as readonly string[]).includes(edge.kind)) {
    throw new Error("The proposal contains an invalid connection payload.")
  }
  return edge
}

function assertProposalOperationParity(proposal: TaskPlanProposal) {
  const primary = proposal.operations[0]
  if (primary?.op !== "node.add" || primary.node.kind !== proposal.action) {
    throw new Error("The proposal operations do not match the requested action.")
  }
  const incomingKind: Record<TaskPlanProposal["action"], TaskPlanEdge["kind"]> = {
    branch: "control",
    join: "join",
    compare: "evidence",
    challenge: "evidence",
    synthesize: "data",
  }
  let operationIndex = 1
  for (const sourceJobId of proposal.sourceJobIds) {
    const operation = proposal.operations[operationIndex]
    if (operation?.op !== "edge.add" || operation.edge.source !== sourceJobId
      || operation.edge.target !== primary.node.id || operation.edge.kind !== incomingKind[proposal.action]
      || operation.edge.label !== undefined) {
      throw new Error("The proposal source connections do not match its declared source jobs.")
    }
    operationIndex += 1
  }
  if (proposal.action !== "branch") {
    if (operationIndex !== proposal.operations.length) {
      throw new Error("The proposal operations do not match the requested action.")
    }
    return
  }
  const branchArmKinds = new Set<TaskPlanNodeKind>([
    "research", "transform", "compare", "challenge", "synthesize", "checkpoint", "artifact",
  ])
  const armCount = (proposal.operations.length - operationIndex) / 2
  if (!Number.isInteger(armCount) || armCount < 2 || armCount > 8) {
    throw new Error("The branch proposal must contain two to eight branch arms.")
  }
  for (let arm = 0; arm < armCount; arm += 1) {
    const nodeOperation = proposal.operations[operationIndex]
    const edgeOperation = proposal.operations[operationIndex + 1]
    if (nodeOperation?.op !== "node.add" || !branchArmKinds.has(nodeOperation.node.kind)
      || edgeOperation?.op !== "edge.add" || edgeOperation.edge.source !== primary.node.id
      || edgeOperation.edge.target !== nodeOperation.node.id || edgeOperation.edge.kind !== "branch"
      || edgeOperation.edge.label !== undefined) {
      throw new Error("The branch proposal operations do not match its branch arms.")
    }
    operationIndex += 2
  }
}

function buildTaskPlanProposalPreview(
  record: TaskPlanRecord,
  proposal: TaskPlanProposal,
): Omit<TaskPlanProposalPreview, "proposalHash"> {
  if (!isPlainRecord(proposal) || !hasExactKeys(proposal, TASK_PLAN_PROPOSAL_KEYS)
    || proposal.schemaId !== "gb.task-plan-proposal.v1" || proposal.scope !== "task-local-work"
    || proposal.effect !== "proposal" || !TASK_PLAN_PROPOSAL_ACTIONS.has(proposal.action)
    || !TASK_PLAN_PROPOSAL_HASH.test(proposal.requestHash) || !TASK_PLAN_PROPOSAL_HASH.test(proposal.proposalHash)) {
    throw new Error("The task-plan proposal is invalid.")
  }
  if (!isPlainRecord(proposal.base) || !hasExactKeys(proposal.base, TASK_PLAN_PROPOSAL_BASE_KEYS)
    || proposal.base.taskPlanId !== record.id
    || proposal.base.taskPlanVersion !== record.current_version
    || proposal.base.taskPlanContentHash !== record.current_content_hash
    || proposal.base.hamTaskId !== record.ham_task_id
    || proposal.base.hamTaskId !== record.current_spec.task.id
    || proposal.base.hamTaskVersion !== record.current_spec.task.version) {
    throw new Error("This proposal targets a different or stale saved task-plan revision.")
  }
  if (typeof proposal.summary !== "string" || proposal.summary !== proposal.summary.trim()
    || Array.from(proposal.summary).length < 1 || Array.from(proposal.summary).length > 500
    || hasUnpairedSurrogate(proposal.summary)
    || proposal.summary !== `Proposed ${proposal.action} structure with ${proposal.operations.length} additive operations.`) {
    throw new Error("The task-plan proposal summary is invalid.")
  }
  const baseNodeIds = new Set(record.current_spec.nodes.map((node) => node.id))
  if (!Array.isArray(proposal.sourceJobIds) || proposal.sourceJobIds.length < 1 || proposal.sourceJobIds.length > 16
    || new Set(proposal.sourceJobIds).size !== proposal.sourceJobIds.length
    || proposal.sourceJobIds.some((id) => typeof id !== "string" || !TASK_PLAN_IDENTIFIER.test(id))
    || proposal.sourceJobIds.some((id) => !baseNodeIds.has(id))) {
    throw new Error("The proposal sources do not match the saved task plan.")
  }
  if ((proposal.action === "branch" && proposal.sourceJobIds.length !== 1)
    || (["join", "compare", "synthesize"].includes(proposal.action) && proposal.sourceJobIds.length < 2)) {
    throw new Error("The proposal sources do not match its action.")
  }
  const proposalInputRefs = canonicalPinnedProposalReferences(proposal.inputRefs, "Proposal input references")
  if (!Array.isArray(proposal.operations) || proposal.operations.length < 2 || proposal.operations.length > 34) {
    throw new Error("The proposal contains an invalid number of operations.")
  }

  let spec = copyTaskPlanSpec(record.current_spec)
  const addedNodeIds: string[] = []
  const addedEdgeIds: string[] = []
  const operationInputRefs: string[] = []
  for (const operation of proposal.operations) {
    if (!isPlainRecord(operation)) throw new Error("The proposal contains an invalid operation.")
    if (operation.op === "node.add" && hasExactKeys(operation, new Set(["op", "node"]))) {
      const node = assertProposalNode(operation.node)
      if (spec.nodes.length >= TASK_PLAN_NODE_LIMIT) {
        throw new Error(`A task plan may contain at most ${TASK_PLAN_NODE_LIMIT} jobs.`)
      }
      if (spec.nodes.some((existing) => existing.id === node.id)) {
        throw new Error("The proposal contains a colliding job identifier.")
      }
      for (const reference of node.config.inputRefs || []) {
        if (!operationInputRefs.includes(reference)) operationInputRefs.push(reference)
        if (operationInputRefs.length > TASK_PLAN_PROPOSAL_LIMIT) {
          throw new Error(`A task-plan proposal may contain at most ${TASK_PLAN_PROPOSAL_LIMIT} distinct input references.`)
        }
      }
      spec = { ...spec, nodes: [...spec.nodes, copyTaskPlanNode(node)] }
      addedNodeIds.push(node.id)
      continue
    }
    if (operation.op === "edge.add" && hasExactKeys(operation, new Set(["op", "edge"]))) {
      const edge = assertProposalEdge(operation.edge)
      spec = appendTaskPlanEdge(spec, edge, () => edge.id)
      addedEdgeIds.push(edge.id)
      continue
    }
    throw new Error("Task-plan proposals may contain only additive operations.")
  }
  if (addedNodeIds.length === 0) {
    throw new Error("The proposal must add at least one job.")
  }
  assertProposalOperationParity(proposal)
  if (operationInputRefs.length !== proposalInputRefs.length
    || operationInputRefs.some((reference, index) => reference !== proposalInputRefs[index])) {
    throw new Error("The proposal input references do not match its additive operations.")
  }
  if (new TextEncoder().encode(JSON.stringify(spec)).byteLength > TASK_PLAN_SIZE_LIMIT) {
    throw new Error("The proposed task plan exceeds the 512 KiB plan limit.")
  }
  return { spec, addedNodeIds, addedEdgeIds }
}

function canonicalJson(value: unknown): string {
  function normalize(next: unknown): unknown {
    if (next === null || typeof next === "string" || typeof next === "boolean") return next
    if (typeof next === "number") {
      if (!Number.isFinite(next)) throw new Error("The task-plan proposal is not finite JSON data.")
      return next
    }
    if (Array.isArray(next)) return next.map(normalize)
    if (!isPlainRecord(next)) throw new Error("The task-plan proposal is not finite JSON data.")
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(next).sort()) {
      const item = next[key]
      if (item === undefined) throw new Error("The task-plan proposal is not finite JSON data.")
      result[key] = normalize(item)
    }
    return result
  }
  return JSON.stringify(normalize(value))
}

async function proposalContentHash(proposal: TaskPlanProposal): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("This browser cannot verify task-plan proposal integrity.")
  }
  const { proposalHash: _proposalHash, ...content } = proposal
  const bytes = new TextEncoder().encode(canonicalJson(content))
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  const hexadecimal = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `sha256:${hexadecimal}`
}

export async function previewTaskPlanProposal(
  record: TaskPlanRecord,
  proposal: TaskPlanProposal,
): Promise<TaskPlanProposalPreview> {
  const declaredHash = proposal.proposalHash
  const preview = buildTaskPlanProposalPreview(record, proposal)
  if (await proposalContentHash(proposal) !== declaredHash) {
    throw new Error("The task-plan proposal content does not match its proposal hash.")
  }
  return { ...preview, proposalHash: declaredHash }
}

export function appendTaskPlanEdge(
  spec: TaskPlanSpec,
  input: TaskPlanEdgeInput,
  createId: () => string = () => `edge-${crypto.randomUUID()}`,
): TaskPlanSpec {
  if (spec.edges.length >= TASK_PLAN_EDGE_LIMIT) {
    throw new Error(`A task plan may contain at most ${TASK_PLAN_EDGE_LIMIT} connections.`)
  }
  const nodeIds = new Set(spec.nodes.map((node) => node.id))
  if (!nodeIds.has(input.source) || !nodeIds.has(input.target)) {
    throw new Error("Choose two jobs that still exist in this task plan.")
  }
  if (input.source === input.target) {
    throw new Error("A job cannot connect to itself.")
  }
  if (!(TASK_PLAN_EDGE_KINDS as readonly string[]).includes(input.kind)) {
    throw new Error("Choose an approved connection kind.")
  }
  if (wouldCreateTaskPlanCycle(spec, input.source, input.target)) {
    throw new Error("That connection would create a cycle. Use explicit branch and join jobs in an acyclic plan.")
  }

  const label = input.label?.trim() || ""
  if (Array.from(label).length > TASK_PLAN_EDGE_LABEL_LIMIT) {
    throw new Error(`Connection labels may contain at most ${TASK_PLAN_EDGE_LABEL_LIMIT} characters.`)
  }
  const id = createId()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) || spec.edges.some((edge) => edge.id === id)) {
    throw new Error("A unique connection identifier could not be created. Try again.")
  }
  const edge: TaskPlanEdge = {
    id,
    source: input.source,
    target: input.target,
    kind: input.kind,
    ...(label ? { label } : {}),
  }
  return { ...spec, edges: [...spec.edges, edge] }
}

export function getTaskConstructorCloseDecision({
  dirty,
  saving,
  candidatePending = false,
  runMutating = false,
}: {
  dirty: boolean
  saving: boolean
  candidatePending?: boolean
  runMutating?: boolean
}): TaskConstructorCloseDecision {
  if (saving || runMutating) return "wait"
  if (dirty || candidatePending) return "confirm"
  return "close"
}

export function removeTaskPlanNodes(
  spec: TaskPlanSpec,
  removedIds: ReadonlySet<string>,
): TaskPlanSpec | null {
  const removedNodeCount = spec.nodes.reduce(
    (count, node) => count + (removedIds.has(node.id) ? 1 : 0),
    0,
  )
  if (removedNodeCount === 0) return spec
  if (removedNodeCount >= spec.nodes.length) return null
  return {
    ...spec,
    nodes: spec.nodes.filter((node) => !removedIds.has(node.id)),
    edges: spec.edges.filter((edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target)),
  }
}
