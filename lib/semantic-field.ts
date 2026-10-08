import type { GalaxyNode, GalaxyWorkspace } from "@/lib/galaxy-brain-service"

export const SEMANTIC_SCALES = [
  { id: "corpus", label: "Corpus", zoom: 0.46 },
  { id: "project", label: "Project", zoom: 0.9 },
  { id: "task", label: "Task", zoom: 1.72 },
  { id: "run", label: "Run / chat", zoom: 3.1 },
  { id: "turn", label: "Turn", zoom: 5.4 },
] as const

export type SemanticScale = (typeof SEMANTIC_SCALES)[number]["id"]
export type SemanticLens = "explore" | "verify" | "compose"
export type SemanticEntityKind =
  | "project"
  | "task"
  | "run"
  | "chat"
  | "bundle"
  | "fork"
  | "join"
  | "turn"
  | "claim"
  | "artifact"
  | "paper"
  | "document"
  | "document-anchor"
  | "code-repository"
  | "code-commit"
  | "code-file"
  | "code-symbol"
  | "code-graph"
  | "proof-graph"
  | "proof-node"
  | "memory"

export type SemanticRelationKind =
  | "contains"
  | "continues"
  | "forks"
  | "joins"
  | "supports"
  | "challenges"
  | "references"
  | "coordinated_by"
  | "near"
  | "depends_on"
  | "defines"
  | "imports"
  | "calls"
  | "extends"
  | "implements"
  | "verifies"
  | "related"
  | "cites"
  | "part_of"
  | "derived_from"
  | "context_for"
  | "formalized_by"
  | "defined_in"
  | "documents"
  | "corresponds_to"
  | "supersedes"
  | "superseded_by"
  | "contradicts"
  | "verified_by"
  | "cited_by"
  | "required_by"

export type SemanticRelationBasis =
  | "structural"
  | "ham_candidate"
  | "deterministic_structure"
  | "authored_assertion"
  | "verified_proof"
  | "semantic_candidate"

export interface SemanticAccess {
  audience: "private" | "team" | "shared" | "public"
  inheritedFrom?: string
}

export interface SemanticTime {
  happenedAt: string
  validFrom?: string
  validTo?: string
}

export interface SemanticEntity {
  id: string
  kind: SemanticEntityKind
  title: string
  detail: string
  parentIds: string[]
  descendantCount?: number
  access: SemanticAccess
  time: SemanticTime
  sourceNodeId?: string
  sourceMemoryId?: string
  sourceReference?: string
  sourceKind?: string
  sources?: Array<{ provider: string; recordId?: string; revision?: string }>
  status?: "active" | "complete" | "blocked" | "draft" | "candidate"
}

export interface SemanticRelation {
  id: string
  from: string
  to: string
  kind: SemanticRelationKind
  basis?: SemanticRelationBasis
  source?: { provider: string; recordId?: string; revision?: string }
  sourceRelation?: string
  verification?: { status: "verified"; method: string; evidenceRef: string }
}

export interface SemanticFieldProjection {
  corpusStatementCount: number
  entities: SemanticEntity[]
  relations: SemanticRelation[]
}

export interface SemanticProjectionOptions {
  includeConceptFixtures?: boolean
}

const at = {
  project: "2026-08-25T09:00:00-04:00",
  task: "2026-08-25T10:15:00-04:00",
  research: "2026-08-25T10:42:00-04:00",
  challenge: "2026-08-25T11:08:00-04:00",
  compare: "2026-08-25T11:19:00-04:00",
  synthesis: "2026-08-25T11:36:00-04:00",
}

function entity(
  input: Omit<SemanticEntity, "access" | "time"> & {
    access?: SemanticAccess
    happenedAt?: string
  },
): SemanticEntity {
  return {
    ...input,
    access: input.access ?? { audience: "team", inheritedFrom: "project:galaxy-brain" },
    time: { happenedAt: input.happenedAt ?? at.task },
  }
}

function relation(from: string, to: string, kind: SemanticRelationKind): SemanticRelation {
  return { id: `${kind}:${from}:${to}`, from, to, kind }
}

function nodeKind(node: GalaxyNode): SemanticEntityKind {
  if (node.type === "ai-chat") return "chat"
  if (node.type === "ai-workflow") return "run"
  if (["document", "image", "audio", "video", "3d", "code", "jupyter"].includes(node.type)) return "artifact"
  return "turn"
}

function taskForNode(node: GalaxyNode) {
  if (node.category === "ai") return "task:agent-runs"
  if (node.category === "document") return "task:references"
  if (node.category === "media" || node.category === "speech") return "task:artifacts"
  return "task:knowledge"
}

export function createWorkspaceSemanticProjection(
  workspace: GalaxyWorkspace,
  nodes: GalaxyNode[],
  options: SemanticProjectionOptions = {},
): SemanticFieldProjection {
  const includeConceptFixtures = options.includeConceptFixtures === true
  const projectId = `project:${workspace.id}`
  const rootTaskId = "task:semantic-field"
  const entities: SemanticEntity[] = [
    entity({
      id: projectId,
      kind: "project",
      title: workspace.name,
      detail: workspace.description ?? "Versioned knowledge, work, and inquiry",
      parentIds: [],
      descendantCount: includeConceptFixtures ? 5_218_404 : nodes.length,
      happenedAt: includeConceptFixtures ? at.project : workspace.updatedAt.toISOString(),
      access: { audience: includeConceptFixtures ? "team" : "private" },
      status: "active",
    }),
    ...(includeConceptFixtures ? [entity({
      id: rootTaskId,
      kind: "task",
      title: "Generative UI control plane",
      detail: "Replace component sprawl with scale-dependent projections",
      parentIds: [projectId],
      descendantCount: 184,
      status: "active",
    }),
    entity({
      id: "task:knowledge",
      kind: "task",
      title: "Knowledge model",
      detail: "Claims, statements, references, and proof relations",
      parentIds: [projectId],
      descendantCount: Math.max(42, nodes.filter((node) => node.category === "knowledge").length),
      status: "active",
    }),
    entity({
      id: "task:agent-runs",
      kind: "task",
      title: "Agent runs",
      detail: "Goals, chats, tool traces, forks, and outcomes",
      parentIds: [projectId],
      descendantCount: Math.max(27, nodes.filter((node) => node.category === "ai").length),
      status: "active",
    }),
    entity({
      id: "task:references",
      kind: "task",
      title: "Reference corpus",
      detail: "Addressable sources and excerpted evidence",
      parentIds: [projectId],
      descendantCount: Math.max(120_842, nodes.filter((node) => node.category === "document").length),
      status: "active",
    }),
    entity({
      id: "task:artifacts",
      kind: "task",
      title: "Artifact fabric",
      detail: "Multimedia, outputs, versions, and derivations",
      parentIds: [projectId],
      descendantCount: Math.max(8_204, nodes.filter((node) => ["media", "speech"].includes(node.category)).length),
      status: "active",
    }),
    entity({
      id: "run:research",
      kind: "run",
      title: "Research run 04",
      detail: "21 sources · 84 extracted claims · 6 proof gaps",
      parentIds: [rootTaskId],
      descendantCount: 126,
      happenedAt: at.research,
      status: "complete",
    }),
    entity({
      id: "chat:design",
      kind: "chat",
      title: "Semantic zoom design",
      detail: "Conversation lineage · 47 turns",
      parentIds: [rootTaskId, "run:research"],
      descendantCount: 47,
      happenedAt: at.research,
      status: "active",
    }),
    entity({
      id: "bundle:premise",
      kind: "bundle",
      title: "Original premise",
      detail: "12 turns bundled · goal and constraints preserved",
      parentIds: ["chat:design"],
      descendantCount: 12,
      happenedAt: at.research,
      status: "complete",
    }),
    entity({
      id: "fork:challenge",
      kind: "fork",
      title: "Challenge the dashboard assumption",
      detail: "9 turns · strongest objection: a dashboard has no global identity",
      parentIds: ["bundle:premise"],
      descendantCount: 9,
      happenedAt: at.challenge,
      status: "complete",
    }),
    entity({
      id: "fork:compare",
      kind: "fork",
      title: "Compare spatial grammars",
      detail: "11 turns · canvas, graph, timeline, and semantic field",
      parentIds: ["bundle:premise"],
      descendantCount: 11,
      happenedAt: at.compare,
      status: "complete",
    }),
    entity({
      id: "join:synthesis",
      kind: "join",
      title: "Multiscale epistemic field",
      detail: "Joined findings without flattening their assumptions",
      parentIds: ["fork:challenge", "fork:compare"],
      descendantCount: 15,
      happenedAt: at.synthesis,
      status: "active",
    }),
    entity({
      id: "claim:containment-lineage",
      kind: "claim",
      title: "Containment and lineage must remain distinct",
      detail: "Projects contain tasks; runs and chats form a fork-and-join graph",
      parentIds: ["join:synthesis"],
      happenedAt: at.synthesis,
      status: "active",
    }),
    entity({
      id: "turn:permission",
      kind: "turn",
      title: "Permissions should inherit until a branch narrows them",
      detail: "Access is rendered as a scale-sensitive envelope, not a settings page",
      parentIds: ["join:synthesis"],
      happenedAt: at.synthesis,
      access: { audience: "shared", inheritedFrom: projectId },
      status: "active",
    }),
    entity({
      id: "turn:temporal",
      kind: "turn",
      title: "Time changes meaning across scales",
      detail: "Project eras, task phases, run order, and per-turn validity share one axis",
      parentIds: ["join:synthesis"],
      happenedAt: at.synthesis,
      status: "active",
    })] : []),
  ]

  const relations: SemanticRelation[] = [
    ...(includeConceptFixtures ? [relation(projectId, rootTaskId, "contains"),
    relation(projectId, "task:knowledge", "contains"),
    relation(projectId, "task:agent-runs", "contains"),
    relation(projectId, "task:references", "contains"),
    relation(projectId, "task:artifacts", "contains"),
    relation(rootTaskId, "run:research", "contains"),
    relation(rootTaskId, "chat:design", "contains"),
    relation("run:research", "chat:design", "continues"),
    relation("chat:design", "bundle:premise", "continues"),
    relation("bundle:premise", "fork:challenge", "forks"),
    relation("bundle:premise", "fork:compare", "forks"),
    relation("fork:challenge", "join:synthesis", "joins"),
    relation("fork:compare", "join:synthesis", "joins"),
    relation("join:synthesis", "claim:containment-lineage", "supports"),
    relation("join:synthesis", "turn:permission", "references"),
    relation("join:synthesis", "turn:temporal", "references"),
    relation("fork:challenge", "claim:containment-lineage", "supports"),
    relation("fork:compare", "claim:containment-lineage", "supports")] : []),
  ]

  nodes.slice(0, 18).forEach((node, index) => {
    const parentId = includeConceptFixtures ? taskForNode(node) : projectId
    const id = `workspace-node:${node.id}`
    entities.push(entity({
      id,
      kind: nodeKind(node),
      title: node.title,
      detail: node.content.trim().replace(/\s+/g, " ").slice(0, 140) || node.type,
      parentIds: [parentId],
      sourceNodeId: node.id,
      happenedAt: node.updatedAt.toISOString(),
      access: { audience: includeConceptFixtures ? "team" : "private" },
      status: "active",
    }))
    relations.push(relation(parentId, id, includeConceptFixtures && index % 3 === 0 ? "references" : "contains"))
  })

  return { corpusStatementCount: includeConceptFixtures ? 5_218_404 : nodes.length, entities, relations }
}

export function scaleIndexForZoom(zoom: number) {
  if (zoom < 0.7) return 0
  if (zoom < 1.3) return 1
  if (zoom < 2.45) return 2
  if (zoom < 4.2) return 3
  return 4
}
