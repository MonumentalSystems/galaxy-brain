"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { searchHam, type HamSearchResult } from "@/lib/ham-search-client"
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from "react"
import {
  ArrowRight,
  Clock3,
  Loader2,
  Copy,
  ExternalLink,
  GitFork,
  GitMerge,
  Globe2,
  LocateFixed,
  LockKeyhole,
  Minus,
  Orbit,
  Plus,
  Pin,
  PinOff,
  ScanSearch,
  Search,
  ShieldCheck,
  Telescope,
  Users,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/use-toast"
import { safeNavigator } from "@/lib/browser-utils"
import { searchDocumentCorpus } from "@/lib/galaxy-brain-api"
import { createGalaxyReference, parseGalaxyReference } from "@/lib/galaxy-reference"
import { parseGalaxyObjectReference } from "@/lib/galaxy-object-reference.js"
import type { GalaxyNode, GalaxyWorkspace } from "@/lib/galaxy-brain-service"
import { projectHamFieldNeighborhood } from "@/lib/ham-field-relations.js"
import {
  FIELD_SEARCH_QUERY_MAX,
  FIELD_SEARCH_RESULT_LIMIT,
  projectSemanticFieldSearch,
  type SemanticFieldSearchProjection,
} from "@/lib/semantic-field-search.js"
import {
  createWorkspaceSemanticProjection,
  scaleIndexForZoom,
  SEMANTIC_SCALES,
  type SemanticEntity,
  type SemanticEntityKind,
  type SemanticFieldProjection,
  type SemanticLens,
  type SemanticRelation,
  type SemanticRelationBasis,
} from "@/lib/semantic-field"
import { cn } from "@/lib/utils"

const GRAPH_DEEP_LINK_KINDS = new Set([
  "paper",
  "document",
  "document.anchor",
  "eln.experiment",
  "eln.observation",
  "ham.task",
  "ham.memory",
  "task-plan",
  "task-plan.job",
  "surface",
  "proof.graph",
  "proof.node",
])

interface SemanticFieldProps {
  workspace: GalaxyWorkspace
  nodes: GalaxyNode[]
  onNodeSelect?: (node: GalaxyNode | null) => void
  onNodeOpen?: (node: GalaxyNode) => void
  includeConceptFixtures?: boolean
  federatedProjection?: SemanticFieldProjection
  focusReference?: string
  hrefForReference?: (reference: string) => string
  onReferenceChange?: (reference: string | null) => void
  onCorpusReferenceSelect?: (reference: string) => void
  onHamMemoryOpen?: (memoryId: string) => void
}

interface Point {
  x: number
  y: number
}

interface DraftBranch {
  id: string
  action: "Challenge" | "Compare" | "Synthesize"
  originId: string
  title: string
}

const LEVEL_COPY = [
  {
    eyebrow: "Living corpus",
    title: "Knowledge has a shape before it has a page",
    detail: "5,218,404 statements become density, neighborhoods, and navigable absence.",
  },
  {
    eyebrow: "Project scale",
    title: "Projects become persistent regions of inquiry",
    detail: "Permissions read as boundaries; eras and active work read as motion through the field.",
  },
  {
    eyebrow: "Task scale",
    title: "A task is a bounded inquiry with a visible lineage",
    detail: "Jobs, research, chats, artifacts, challenges, comparisons, and joins share one map.",
  },
  {
    eyebrow: "Run / chat scale",
    title: "Long conversations compress without losing their branch points",
    detail: "Stable passages bundle into packets; forks, joins, goals, and outputs remain addressable.",
  },
  {
    eyebrow: "Turn scale",
    title: "Every turn can resolve into claims, references, and artifacts",
    detail: "The smallest object still carries source, version, access, time, and derivation.",
  },
] as const

const WORKSPACE_LEVEL_COPY = [
  {
    eyebrow: "Living workspace",
    title: "Your knowledge keeps one spatial identity",
    detail: "Start with the real objects in this workspace, then reveal structure as durable relations arrive.",
  },
  {
    eyebrow: "Project scale",
    title: "Working material becomes a navigable region",
    detail: "Documents, conversations, media, and notes remain selected and addressable across projections.",
  },
  {
    eyebrow: "Task scale",
    title: "Bounded inquiries can gather their source material",
    detail: "Task containment is shown only when canonical task relations exist; workspace objects remain visible meanwhile.",
  },
  {
    eyebrow: "Run / chat scale",
    title: "Conversation lineage can resolve without becoming a transcript wall",
    detail: "Runs and chats retain stable references now; durable fork and join geometry can attach to the same objects.",
  },
  {
    eyebrow: "Evidence scale",
    title: "The smallest material stays attributable",
    detail: "Open the source explicitly, or copy a stable reference for a human, an agent, or another view.",
  },
] as const

const BASE_POSITIONS: Record<string, Point> = {
  "task:semantic-field": { x: 800, y: 210 },
  "task:knowledge": { x: 430, y: 520 },
  "task:agent-runs": { x: 680, y: 560 },
  "task:references": { x: 960, y: 560 },
  "task:artifacts": { x: 1200, y: 510 },
  "run:research": { x: 520, y: 335 },
  "chat:design": { x: 800, y: 330 },
  "bundle:premise": { x: 800, y: 470 },
  "fork:challenge": { x: 590, y: 610 },
  "fork:compare": { x: 1010, y: 610 },
  "join:synthesis": { x: 800, y: 755 },
  "claim:containment-lineage": { x: 800, y: 490 },
  "turn:permission": { x: 560, y: 650 },
  "turn:temporal": { x: 1040, y: 650 },
}

const KIND_SCALE: Record<SemanticEntityKind, number> = {
  project: 0,
  task: 1,
  run: 2,
  chat: 2,
  bundle: 3,
  fork: 3,
  join: 3,
  turn: 4,
  claim: 4,
  artifact: 4,
  paper: 4,
  document: 4,
  "document-anchor": 4,
  "code-repository": 1,
  "code-commit": 4,
  "code-file": 4,
  "code-symbol": 4,
  "code-graph": 2,
  "proof-graph": 2,
  "proof-node": 4,
  memory: 4,
}

const KIND_COLOR: Record<SemanticEntityKind, string> = {
  project: "hsl(var(--field-core))",
  task: "hsl(var(--field-warm-strong))",
  run: "hsl(var(--field-cool-strong))",
  chat: "hsl(var(--field-core))",
  bundle: "hsl(var(--field-muted-strong))",
  fork: "hsl(var(--field-alert-strong))",
  join: "hsl(var(--field-cool-strong))",
  turn: "hsl(var(--field-muted-strong))",
  claim: "hsl(var(--field-core))",
  artifact: "hsl(var(--field-warm-strong))",
  paper: "hsl(var(--field-cool-strong))",
  document: "hsl(var(--field-warm-strong))",
  "document-anchor": "hsl(var(--field-alert-strong))",
  "code-repository": "hsl(var(--field-cool-strong))",
  "code-commit": "hsl(var(--field-cool-strong))",
  "code-file": "hsl(var(--field-core))",
  "code-symbol": "hsl(var(--field-core))",
  "code-graph": "hsl(var(--field-cool-strong))",
  "proof-graph": "hsl(var(--field-cool-strong))",
  "proof-node": "hsl(var(--field-cool-strong))",
  memory: "hsl(var(--field-warm-strong))",
}

const RELATION_COLOR: Record<SemanticRelation["kind"], string> = {
  contains: "hsl(var(--field-core))",
  continues: "hsl(var(--field-core))",
  forks: "hsl(var(--field-alert-strong))",
  joins: "hsl(var(--field-cool-strong))",
  supports: "hsl(var(--field-core))",
  challenges: "hsl(var(--field-alert-strong))",
  references: "hsl(var(--field-warm-strong))",
  coordinated_by: "hsl(var(--field-cool-strong))",
  near: "hsl(var(--field-muted-strong))",
  depends_on: "hsl(var(--field-cool-strong))",
  defines: "hsl(var(--field-core))",
  imports: "hsl(var(--field-cool-strong))",
  calls: "hsl(var(--field-core))",
  extends: "hsl(var(--field-cool-strong))",
  implements: "hsl(var(--field-core))",
  verifies: "hsl(var(--field-core))",
  related: "hsl(var(--field-muted-strong))",
  cites: "hsl(var(--field-warm-strong))",
  part_of: "hsl(var(--field-core))",
  derived_from: "hsl(var(--field-cool-strong))",
  context_for: "hsl(var(--field-alert-strong))",
  formalized_by: "hsl(var(--field-warm-strong))",
  defined_in: "hsl(var(--field-core))",
  documents: "hsl(var(--field-alert-strong))",
  corresponds_to: "hsl(var(--field-cool-strong))",
  supersedes: "hsl(var(--field-alert-strong))",
  superseded_by: "hsl(var(--field-alert-strong))",
  contradicts: "hsl(var(--field-alert-strong))",
  verified_by: "hsl(var(--field-core))",
  cited_by: "hsl(var(--field-warm-strong))",
  required_by: "hsl(var(--field-cool-strong))",
}

const RELATION_BASIS_STYLE: Partial<Record<SemanticRelationBasis, { color: string; dash?: string; width: number; label: string }>> = {
  deterministic_structure: { color: "hsl(var(--field-cool-strong))", width: 2, label: "Deterministic structure" },
  authored_assertion: { color: "hsl(var(--field-warm-strong))", dash: "7 5", width: 2.5, label: "Authored assertion" },
  verified_proof: { color: "hsl(var(--field-core))", width: 3.5, label: "Verified proof" },
  semantic_candidate: { color: "hsl(var(--field-muted-strong))", dash: "2 7", width: 2, label: "Semantic candidate" },
  ham_candidate: { color: "hsl(var(--field-muted-strong))", dash: "2 7", width: 2, label: "HAM semantic candidate" },
}

function compact(value: number) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value)
}

function levelForKind(kind: SemanticEntityKind) {
  return KIND_SCALE[kind]
}

function branchTitle(action: DraftBranch["action"], origin: SemanticEntity) {
  if (action === "Challenge") return `Challenge · ${origin.title}`
  if (action === "Compare") return `Compare · alternatives to ${origin.title}`
  return `Synthesize · ${origin.title}`
}

function relationVisible(relation: SemanticRelation, lens: SemanticLens) {
  if (lens === "verify") {
    return relation.basis === "verified_proof" || relation.basis === "authored_assertion"
      || ["supports", "challenges", "contradicts", "references", "forks", "joins", "verifies", "verified_by", "formalized_by", "corresponds_to"].includes(relation.kind)
  }
  if (lens === "compose") {
    return ["forks", "joins", "continues", "supports", "formalized_by", "context_for", "implements", "documents", "supersedes", "superseded_by"].includes(relation.kind)
  }
  return true
}

function relationStyle(relation: SemanticRelation) {
  const basisStyle = relation.basis ? RELATION_BASIS_STYLE[relation.basis] : undefined
  return {
    color: basisStyle?.color ?? RELATION_COLOR[relation.kind],
    width: basisStyle?.width ?? (relation.kind === "supports" || relation.kind === "challenges" ? 3 : 2),
    dash: basisStyle?.dash ?? (relation.kind === "near" ? "2 7" : relation.kind === "references" ? "5 7" : undefined),
    label: basisStyle?.label ?? relation.kind.replaceAll("_", " "),
  }
}

/**
 * How much of itself an entity shows at the current scale.
 *
 * Zoom changes representation, not just size: far out an entity is a compact
 * token you can take in at a glance, mid-range it opens into a block carrying
 * its own summary, and close up it becomes a surface you have entered.
 */
type GlyphDepth = "icon" | "block" | "world"

function glyphDepthFor(entity: SemanticEntity, scaleIndex: number): GlyphDepth {
  // Which band an entity "belongs" to: a project is the subject at Project
  // scale, a task at Task scale, and so on down to turns.
  const homeScale =
    entity.kind === "project" ? 1
      : entity.kind === "task" ? 2
      : entity.kind === "run" || entity.kind === "chat" || entity.kind === "fork" || entity.kind === "join" ? 3
      : 4

  if (scaleIndex < homeScale) return "icon"
  if (scaleIndex > homeScale) return "world"
  return "block"
}

function NodeGlyph({ entity, selected, depth }: { entity: SemanticEntity; selected: boolean; depth: GlyphDepth }) {
  const color = KIND_COLOR[entity.kind]

  // Far out: one compact token. Detail at this distance is noise, and dropping
  // it is what lets a corpus-scale view stay legible.
  if (depth === "icon") {
    return (
      <g>
        <circle r={14} fill="hsl(var(--field-panel))" stroke={color} strokeWidth={selected ? 3 : 1.5} />
        <circle r={5} fill={color} fillOpacity={selected ? 0.95 : 0.6} />
      </g>
    )
  }

  if (entity.kind === "fork") {
    return (
      <g>
        <path d="M 0 -29 L 29 0 L 0 29 L -29 0 Z" fill="hsl(var(--field-panel))" stroke={color} strokeWidth={selected ? 4 : 2} />
        <GitFork x={-10} y={-10} width={20} height={20} color={color} aria-hidden="true" />
      </g>
    )
  }
  if (entity.kind === "join") {
    return (
      <g>
        <circle r="35" fill="hsl(var(--field-panel))" stroke={color} strokeWidth={selected ? 4 : 2} />
        <circle r="27" fill="none" stroke={color} strokeOpacity=".45" />
        <GitMerge x={-11} y={-11} width={22} height={22} color={color} aria-hidden="true" />
      </g>
    )
  }
  if (["chat", "bundle", "turn", "artifact", "paper"].includes(entity.kind)) {
    const width = entity.kind === "bundle" ? 142 : ["turn", "artifact", "paper"].includes(entity.kind) ? 176 : 126
    return (
      <g>
        <rect
          x={-width / 2}
          y={-26}
          width={width}
          height={52}
          rx={entity.kind === "bundle" ? 26 : 14}
          fill="hsl(var(--field-panel))"
          stroke={color}
          strokeWidth={selected ? 3 : 1.5}
        />
        {entity.kind === "bundle" && <path d="M -55 -8 H 55 M -45 0 H 45 M -35 8 H 35" stroke={color} strokeOpacity=".55" />}
      </g>
    )
  }
  // Close up: the entity is a surface you have entered, so it shows its own
  // detail rather than standing for it.
  if (depth === "world") {
    const width = entity.kind === "project" ? 300 : 236
    const height = entity.kind === "project" ? 168 : 132
    const detail = entity.detail.length > 96 ? `${entity.detail.slice(0, 93)}…` : entity.detail
    const words = detail.split(" ")
    const lines: string[] = []
    let line = ""
    for (const word of words) {
      if ((line + word).length > 30) {
        lines.push(line.trim())
        line = ""
      }
      line += `${word} `
    }
    if (line.trim()) lines.push(line.trim())

    return (
      <g>
        <rect
          x={-width / 2}
          y={-height / 2}
          width={width}
          height={height}
          rx={16}
          fill="hsl(var(--field-panel))"
          stroke={color}
          strokeWidth={selected ? 3 : 1.5}
        />
        <line x1={-width / 2 + 16} y1={-height / 2 + 34} x2={width / 2 - 16} y2={-height / 2 + 34} stroke={color} strokeOpacity=".3" />
        {lines.slice(0, 4).map((text, index) => (
          <text
            key={text}
            x={-width / 2 + 16}
            y={-height / 2 + 58 + index * 19}
            fill="hsl(var(--field-muted-strong))"
            fontSize="13"
          >
            {text}
          </text>
        ))}
        {entity.status && (
          <text x={-width / 2 + 16} y={height / 2 - 14} fill={color} fontSize="12" fontWeight={600}>
            {entity.status}
          </text>
        )}
      </g>
    )
  }

  const radius = entity.kind === "project" ? 76 : entity.kind === "task" ? 42 : entity.kind === "claim" ? 27 : 32
  return (
    <g>
      <circle r={radius} fill="hsl(var(--field-panel))" stroke={color} strokeWidth={selected ? 4 : 2} />
      {entity.kind === "project" && <circle r={radius + 13} fill="none" stroke={color} strokeOpacity=".23" strokeDasharray="4 9" />}
      {entity.kind === "task" && <circle r={radius - 9} fill="none" stroke={color} strokeOpacity=".2" />}
    </g>
  )
}

export function SemanticField({ workspace, nodes, onNodeSelect, onNodeOpen, includeConceptFixtures = false, federatedProjection, focusReference, hrefForReference, onReferenceChange, onCorpusReferenceSelect, onHamMemoryOpen }: SemanticFieldProps) {
  const baseProjection = useMemo(
    () => {
      const workspaceProjection = createWorkspaceSemanticProjection(workspace, nodes, { includeConceptFixtures })
      if (!federatedProjection) return workspaceProjection
      const workspaceEntities = workspaceProjection.entities.map((entry) => (
        entry.kind === "project" && entry.parentIds.length === 0
          ? { ...entry, descendantCount: (entry.descendantCount ?? 0) + federatedProjection.corpusStatementCount }
          : entry
      ))
      return {
        corpusStatementCount: workspaceProjection.corpusStatementCount + federatedProjection.corpusStatementCount,
        entities: [...workspaceEntities, ...federatedProjection.entities],
        relations: [...workspaceProjection.relations, ...federatedProjection.relations],
      }
    },
    [federatedProjection, includeConceptFixtures, nodes, workspace],
  )
  const [hamNeighborhood, setHamNeighborhood] = useState<{ workspaceId: string; anchorId: string; results: HamSearchResult[] } | null>(null)
  const [hamNeighborhoodState, setHamNeighborhoodState] = useState<"idle" | "loading" | "ready" | "unavailable">("idle")
  const projection = useMemo(() => {
    if (!hamNeighborhood || hamNeighborhood.workspaceId !== workspace.id || !baseProjection.entities.some((entry) => entry.id === hamNeighborhood.anchorId)) {
      return baseProjection
    }
    const neighborhood = projectHamFieldNeighborhood(hamNeighborhood.anchorId, hamNeighborhood.results)
    return {
      ...baseProjection,
      entities: [...baseProjection.entities, ...neighborhood.entities],
      relations: [...baseProjection.relations, ...neighborhood.relations],
    }
  }, [baseProjection, hamNeighborhood, workspace.id])
  const [zoom, setZoom] = useState<number>(SEMANTIC_SCALES[0].zoom)
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 })
  const [lens, setLens] = useState<SemanticLens>("explore")
  const [showAccess, setShowAccess] = useState(false)
  const [showTime, setShowTime] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dockPinned, setDockPinned] = useState(false)
  const [draftBranches, setDraftBranches] = useState<DraftBranch[]>([])
  const [query, setQuery] = useState("")
  const [searchRefreshVersion, setSearchRefreshVersion] = useState(0)
  const [searchResults, setSearchResults] = useState<SemanticFieldSearchProjection>(() => (
    projectSemanticFieldSearch([], [], [], "")
  ))
  const [searchOpen, setSearchOpen] = useState(false)
  const [corpusSearchBusy, setCorpusSearchBusy] = useState(false)
  const [corpusSearchError, setCorpusSearchError] = useState("")
  const [hamSearchBusy, setHamSearchBusy] = useState(false)
  const [hamSearchError, setHamSearchError] = useState("")
  const [liveMessage, setLiveMessage] = useState("Corpus field ready")
  const dragRef = useRef<{ x: number; y: number; pan: Point } | null>(null)
  const initialReferenceAppliedRef = useRef(false)
  const searchRequestIdRef = useRef(0)
  const searchAbortRef = useRef<AbortController | null>(null)

  const scaleIndex = scaleIndexForZoom(zoom)
const selected = projection.entities.find((entry) => entry.id === selectedId) ?? null
  const selectedObjectReference = parseGalaxyObjectReference(selected?.sourceReference)
  const selectedHasExactGraphLoader = selectedObjectReference?.format === "canonical"
    && GRAPH_DEEP_LINK_KINDS.has(selectedObjectReference.kind)
  const selectedHamMemoryId = selectedObjectReference?.format === "canonical" && selectedObjectReference.kind === "ham.memory"
    ? selectedObjectReference.id
    : null

  useEffect(() => {
    if (includeConceptFixtures || !selected?.sourceNodeId) return
    const title = selected.title.trim()
    if (title.length < 4 || title === "New Note") {
      setHamNeighborhood(null)
      setHamNeighborhoodState("idle")
      return
    }
    let active = true
    const anchorId = selected.id
    setHamNeighborhood(null)
    setHamNeighborhoodState("loading")
    // The existing tenant-bound HAM proxy receives only the selected title.
    // Results are suggestions, never structural or evidential graph edges.
    void searchHam({ query: title.slice(0, 180), mode: "multihop", maxHops: 1, topK: 8 })
      .then((results) => {
        if (!active) return
        setHamNeighborhood({ workspaceId: workspace.id, anchorId, results })
        setHamNeighborhoodState("ready")
      })
      .catch(() => {
        if (!active) return
        setHamNeighborhood(null)
        setHamNeighborhoodState("unavailable")
      })
    return () => { active = false }
  }, [includeConceptFixtures, selected?.id, selected?.sourceNodeId, selected?.title, workspace.id])

  const visibleEntities = useMemo(() => {
    if (scaleIndex === 0) return projection.entities.filter((entry) => entry.kind === "project")
    if (scaleIndex === 1) return projection.entities.filter((entry) => entry.kind === "task" || entry.sourceNodeId || entry.sourceMemoryId || entry.sourceReference)
    if (scaleIndex === 2) {
      return projection.entities.filter((entry) => entry.sourceNodeId || entry.sourceMemoryId || entry.sourceReference || (["task", "run", "chat"].includes(entry.kind) && !entry.id.startsWith("workspace-node:")))
    }
    if (scaleIndex === 3) {
      return projection.entities.filter((entry) => entry.sourceNodeId || entry.sourceMemoryId || entry.sourceReference || ["run", "chat", "bundle", "fork", "join"].includes(entry.kind))
    }
    return projection.entities.filter((entry) => entry.sourceNodeId || entry.sourceMemoryId || entry.sourceReference || ["join", "claim", "turn", "artifact"].includes(entry.kind))
  }, [projection.entities, scaleIndex])

  const positionFor = useCallback((entity: SemanticEntity, index: number): Point => {
    if (entity.kind === "project") return { x: 800, y: 455 }
    const fixed = BASE_POSITIONS[entity.id]
    if (fixed) return fixed
    if (entity.id.startsWith("workspace-node:")) {
      const angle = (Math.PI * 2 * index) / Math.max(1, visibleEntities.length)
      return { x: 800 + Math.cos(angle) * 410, y: 460 + Math.sin(angle) * 270 }
    }
    return { x: 800 + (index % 4 - 1.5) * 250, y: 360 + Math.floor(index / 4) * 180 }
  }, [visibleEntities.length])

  const positions = useMemo(() => {
    const result = new Map(visibleEntities.map((entry, index) => [entry.id, positionFor(entry, index)]))
    const anchor = hamNeighborhood ? result.get(hamNeighborhood.anchorId) : null
    if (anchor) {
      const neighbors = visibleEntities.filter((entry) => entry.sourceMemoryId)
      neighbors.forEach((entry, index) => {
        const angle = (Math.PI * 2 * index) / Math.max(1, neighbors.length)
        result.set(entry.id, { x: anchor.x + Math.cos(angle) * 190, y: anchor.y + Math.sin(angle) * 145 })
      })
    }
    return result
  }, [hamNeighborhood, positionFor, visibleEntities])

  const visibleRelations = projection.relations.filter((relation) => (
    positions.has(relation.from) && positions.has(relation.to) && relationVisible(relation, lens)
  ))

  const goToScale = useCallback((index: number) => {
    const next = SEMANTIC_SCALES[index]
    setZoom(next.zoom)
    setPan({ x: 0, y: 0 })
    setLiveMessage(`Zoomed to ${next.label}`)
  }, [])

  const updateReferenceInLocation = useCallback((entity: SemanticEntity | null) => {
    if (entity?.sourceMemoryId) return // HAM candidates are an ephemeral projection, not deep-link targets.
    const reference = entity
      ? entity.sourceReference ?? (entity.sourceNodeId
        ? createGalaxyReference("node", entity.sourceNodeId)
        : createGalaxyReference("entity", entity.id))
      : null
    if (onReferenceChange) {
      onReferenceChange(reference)
      return
    }
    const url = new URL(window.location.href)
    if (reference) url.searchParams.set("ref", reference)
    else url.searchParams.delete("ref")
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`)
  }, [onReferenceChange])

  const selectEntity = useCallback((entity: SemanticEntity) => {
    setSelectedId(entity.id)
    setLiveMessage(`${entity.kind} selected: ${entity.title}`)
    updateReferenceInLocation(entity)
    if (entity.sourceNodeId) {
      onNodeSelect?.(nodes.find((node) => node.id === entity.sourceNodeId) ?? null)
    } else {
      onNodeSelect?.(null)
    }
  }, [nodes, onNodeSelect, updateReferenceInLocation])

  useEffect(() => {
    if (initialReferenceAppliedRef.current) return
    const rawReference = new URLSearchParams(window.location.search).get("ref")
    if (!rawReference) {
      initialReferenceAppliedRef.current = true
      return
    }
    const objectReference = parseGalaxyObjectReference(rawReference)
    const legacyReference = parseGalaxyReference(rawReference)
    const match = objectReference?.format === "canonical"
      ? projection.entities.find((entry) => entry.sourceReference === rawReference)
      : legacyReference?.kind === "node"
        ? projection.entities.find((entry) => entry.sourceNodeId === legacyReference.id)
        : legacyReference
          ? projection.entities.find((entry) => entry.id === legacyReference.id)
          : undefined
    if (!match) return
    initialReferenceAppliedRef.current = true
    setSelectedId(match.id)
    setZoom(SEMANTIC_SCALES[Math.max(0, levelForKind(match.kind))].zoom)
    setLiveMessage(`${match.kind} selected from reference: ${match.title}`)
    if (match.sourceNodeId) {
      onNodeSelect?.(nodes.find((node) => node.id === match.sourceNodeId) ?? null)
    }
  }, [nodes, onNodeSelect, projection.entities])

  useEffect(() => {
    if (!focusReference) return
    const match = projection.entities.find((entry) => entry.sourceReference === focusReference)
    if (!match || match.id === selectedId) return
    selectEntity(match)
    setZoom(SEMANTIC_SCALES[Math.max(0, levelForKind(match.kind))].zoom)
  }, [focusReference, projection.entities, selectEntity, selectedId])

  const clearSelection = () => {
    setSelectedId(null)
    setHamNeighborhood(null)
    setHamNeighborhoodState("idle")
    onNodeSelect?.(null)
    updateReferenceInLocation(null)
    setLiveMessage("Field selection cleared")
  }

  const copySelection = async (mode: "reference" | "link") => {
    if (!selected) return
    const reference = selected.sourceReference ?? (selected.sourceNodeId
      ? createGalaxyReference("node", selected.sourceNodeId)
      : createGalaxyReference("entity", selected.id))
    if (mode === "link" && (!selected.sourceReference || !selectedHasExactGraphLoader)) return
    const value = mode === "reference"
      ? reference
      : new URL(
          hrefForReference?.(reference) ?? `/graph?ref=${encodeURIComponent(reference)}`,
          window.location.origin,
        ).toString()
    try {
      await safeNavigator().clipboard.writeText(value)
      toast({ title: mode === "reference" ? "Object reference copied" : "Deep link copied", description: value })
    } catch {
      toast({ title: mode === "reference" ? "Object reference" : "Deep link", description: value })
    }
  }

  const descendInto = useCallback((entity: SemanticEntity) => {
    selectEntity(entity)
    goToScale(Math.min(4, Math.max(scaleIndex + 1, levelForKind(entity.kind) + 1)))
  }, [goToScale, scaleIndex, selectEntity])

  const handleWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault()
    const next = Math.max(0.36, Math.min(6.2, zoom * Math.exp(-event.deltaY * 0.0015)))
    setZoom(next)
  }

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { x: event.clientX, y: event.clientY, pan }
  }

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return
    setPan({
      x: dragRef.current.pan.x + event.clientX - dragRef.current.x,
      y: dragRef.current.pan.y + event.clientY - dragRef.current.y,
    })
  }

  const handlePointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    dragRef.current = null
  }

  const handleFieldKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault()
      setZoom((value) => Math.min(6.2, value * 1.22))
    } else if (event.key === "-") {
      event.preventDefault()
      setZoom((value) => Math.max(0.36, value / 1.22))
    } else if (event.key === "0") {
      event.preventDefault()
      goToScale(0)
    }
  }

  const createBranch = (action: DraftBranch["action"]) => {
    if (!selected) return
    const next: DraftBranch = {
      id: `draft:${action.toLowerCase()}:${Date.now()}`,
      action,
      originId: selected.id,
      title: branchTitle(action, selected),
    }
    setDraftBranches((branches) => [...branches, next])
    setLens(action === "Synthesize" ? "compose" : action === "Challenge" ? "verify" : "explore")
    setLiveMessage(`${action} branch drafted from ${selected.title}`)
  }

  /*
    The three providers intentionally remain independent: visible Galaxy
    objects are a local predicate, the corpus is bounded lexical retrieval over
    durable document chunks, and HAM is remote semantic retrieval. Their result
    orders and scores are never fused. A corpus hit is only an exact document
    reference; selecting it asks the owning graph route to hydrate that object.
  */
  useEffect(() => {
    const raw = query.trim()
    searchAbortRef.current?.abort()
    searchAbortRef.current = null
    const requestId = ++searchRequestIdRef.current

    if (!raw) {
      setSearchResults(projectSemanticFieldSearch([], [], [], ""))
      setSearchOpen(false)
      setCorpusSearchBusy(false)
      setCorpusSearchError("")
      setHamSearchBusy(false)
      setHamSearchError("")
      return
    }

    const localResults = projectSemanticFieldSearch(baseProjection.entities, [], [], raw)
    setSearchResults(localResults)
    setSearchOpen(true)
    setCorpusSearchBusy(true)
    setCorpusSearchError("")
    setHamSearchBusy(true)
    setHamSearchError("")
    setLiveMessage(
      `${localResults.galaxy.total} visible Galaxy match${localResults.galaxy.total === 1 ? "" : "es"} for “${raw}”; waiting to search the corpus and HAM`,
    )

    const timer = window.setTimeout(() => {
      const controller = new AbortController()
      searchAbortRef.current = controller

      void searchDocumentCorpus({ query: raw, limit: FIELD_SEARCH_RESULT_LIMIT, signal: controller.signal })
        .then((response) => {
          if (requestId !== searchRequestIdRef.current) return
          setSearchResults((current) => current.query === raw
            ? { ...current, corpus: { total: response.items.length, items: response.items, hasMore: response.continuation.hasMore } }
            : current)
          setLiveMessage(`${response.items.length}${response.continuation.hasMore ? " or more" : ""} Galaxy corpus lexical matches for “${raw}”`)
        })
        .catch((error) => {
          if (requestId !== searchRequestIdRef.current || controller.signal.aborted) return
          setCorpusSearchError(error instanceof Error ? error.message : "Corpus search is unavailable")
          setLiveMessage(`Galaxy corpus search is unavailable for “${raw}”; local Galaxy and HAM results remain available`)
        })
        .finally(() => {
          if (requestId === searchRequestIdRef.current) setCorpusSearchBusy(false)
        })

      void searchHam({ query: raw, topK: FIELD_SEARCH_RESULT_LIMIT }, { signal: controller.signal })
        .then((remote) => {
          if (requestId !== searchRequestIdRef.current) return
          const ham = projectSemanticFieldSearch([], [], remote, raw).ham
          setSearchResults((current) => current.query === raw ? { ...current, ham } : current)
          setLiveMessage(`${ham.total} HAM result${ham.total === 1 ? "" : "s"} for “${raw}”`)
        })
        .catch((error) => {
          if (requestId !== searchRequestIdRef.current || controller.signal.aborted) return
          setHamSearchError(error instanceof Error ? error.message : "HAM search is unavailable")
          setLiveMessage(`HAM search is unavailable for “${raw}”; local Galaxy and corpus results remain available`)
        })
        .finally(() => {
          if (requestId === searchRequestIdRef.current) setHamSearchBusy(false)
        })
    }, 300)

    return () => {
      window.clearTimeout(timer)
      searchAbortRef.current?.abort()
    }
  }, [baseProjection.entities, query, searchRefreshVersion])

  const submitSearch = () => {
    if (!query.trim()) return
    setSearchOpen(true)
    setSearchRefreshVersion((value) => value + 1)
  }

  const dismissSearch = () => {
    searchRequestIdRef.current += 1
    searchAbortRef.current?.abort()
    searchAbortRef.current = null
    setCorpusSearchBusy(false)
    setHamSearchBusy(false)
    setSearchOpen(false)
    setCorpusSearchError("")
    setHamSearchError("")
  }

  const selectCorpusResult = (result: SemanticFieldSearchProjection["corpus"]["items"][number]) => {
    setLiveMessage(`Opening exact document reference: ${result.title}`)
    if (onCorpusReferenceSelect) onCorpusReferenceSelect(result.documentRef)
    else onReferenceChange?.(result.documentRef)
    dismissSearch()
  }

  const copy = (includeConceptFixtures ? LEVEL_COPY : WORKSPACE_LEVEL_COPY)[scaleIndex]
  const visualScale = 1 + (zoom - SEMANTIC_SCALES[scaleIndex].zoom) * 0.08
  const searchBusy = corpusSearchBusy || hamSearchBusy

  return (
    <section
      className="semantic-field research-workbench relative h-full min-h-0 overflow-hidden border-t"
      data-slot="semantic-field"
      data-scale={SEMANTIC_SCALES[scaleIndex].id}
      data-lens={lens}
      aria-label="Galaxy Brain semantic field"
    >
      <header className="semantic-field__chrome absolute inset-x-0 top-0 z-30 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b px-4 py-3 lg:flex lg:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="semantic-field__brand-mark grid h-10 w-10 shrink-0 place-items-center rounded-full border">
            <Orbit className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="semantic-field__title truncate text-base font-semibold">{workspace.name}</p>
            <p className="semantic-field__muted truncate text-xs">Corpus / Project / Task / Run / Turn</p>
          </div>
        </div>

        <form
          className="semantic-field__search order-3 col-span-2 flex min-w-0 flex-1 items-center gap-2 rounded-full border px-3 py-2 lg:order-none lg:col-auto lg:max-w-xl"
          role="search"
          onSubmit={(event) => { event.preventDefault(); submitSearch() }}
        >
          <Search className="semantic-field__muted h-4 w-4 shrink-0" aria-hidden="true" />
          <label className="sr-only" htmlFor="semantic-field-search">Find a task, chat, claim, source, or artifact</label>
          <input
            id="semantic-field-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") dismissSearch() }}
            aria-controls="semantic-field-search-results"
            aria-busy={searchBusy}
            className="semantic-field__ink min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[hsl(var(--field-muted-strong))]"
            placeholder="Find any task, chat, claim, source, or artifact…"
            type="search"
            maxLength={FIELD_SEARCH_QUERY_MAX}
          />
          <button
            type="submit"
            aria-label="Search field"
            className="semantic-field__control grid h-9 w-9 shrink-0 place-items-center rounded-full border-0 transition focus-visible:outline-none"
          >
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          {searchBusy && <Loader2 className="semantic-field__muted h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />}
        </form>

        {searchOpen && (
          <div
            id="semantic-field-search-results"
            className="absolute inset-x-2 top-full w-auto lg:left-1/2 lg:right-auto lg:w-[min(42rem,calc(100vw-2rem))] lg:-translate-x-1/2"
            role="region"
            aria-label={`Search results for ${searchResults.query}`}
            aria-busy={searchBusy}
          >
            <div className="semantic-field__panel mt-2 overflow-hidden rounded-2xl border">
              <div className="semantic-field__divider flex items-center justify-between gap-2 border-b px-3 py-2">
                <p className="semantic-field__eyebrow text-[11px] font-semibold uppercase tracking-[.18em]">
                  Results · {searchResults.galaxy.total + searchResults.corpus.total + searchResults.ham.total}
                </p>
                <button
                  type="button"
                  className="semantic-field__control min-h-9 rounded-md border-0 px-2 py-1 text-xs transition focus-visible:outline-none"
                  onClick={dismissSearch}
                >
                  Dismiss
                </button>
              </div>
              <div className="semantic-field__divider max-h-[min(24rem,calc(100dvh-11rem))] divide-y overflow-y-auto overscroll-contain">
                <section className="semantic-field__search-section" aria-labelledby="galaxy-search-results-heading">
                  <div className="flex items-start justify-between gap-3 px-3 py-2">
                    <div>
                      <h3 id="galaxy-search-results-heading" className="semantic-field__ink text-xs font-semibold">Galaxy · local field</h3>
                      <p className="semantic-field__muted text-[11px]">Local title/content match · unscored</p>
                    </div>
                    <span className="semantic-field__muted text-xs tabular-nums">{searchResults.galaxy.total}</span>
                  </div>
                  {searchResults.galaxy.items.length > 0 ? (
                    <ul className="semantic-field__divider divide-y border-t">
                      {searchResults.galaxy.items.map((entity) => (
                        <li key={entity.id}>
                          <button
                            type="button"
                            className="semantic-field__search-result w-full px-3 py-2.5 text-left transition focus-visible:outline-none"
                            onClick={() => {
                              selectEntity(entity)
                              goToScale(Math.max(0, levelForKind(entity.kind)))
                              dismissSearch()
                            }}
                          >
                            <span className="line-clamp-1 text-sm">{entity.title}</span>
                            <span className="semantic-field__muted mt-0.5 line-clamp-2 block text-xs">{entity.detail}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="semantic-field__divider semantic-field__muted border-t px-3 py-2.5 text-xs">No local Galaxy matches.</p>
                  )}
                  {searchResults.galaxy.total > searchResults.galaxy.items.length && (
                    <p className="semantic-field__divider semantic-field__muted border-t px-3 py-2 text-[11px]">
                      Showing {searchResults.galaxy.items.length} of {searchResults.galaxy.total} local matches.
                    </p>
                  )}
                </section>

                <section className="semantic-field__search-section" aria-labelledby="corpus-search-results-heading" aria-busy={corpusSearchBusy}>
                  <div className="flex items-start justify-between gap-3 px-3 py-2">
                    <div>
                      <h3 id="corpus-search-results-heading" className="semantic-field__core text-xs font-semibold">Galaxy corpus · lexical</h3>
                      <p className="semantic-field__muted text-[11px]">Current durable document revisions · exact references</p>
                    </div>
                    <span className="semantic-field__muted text-xs tabular-nums">
                      {corpusSearchBusy ? "…" : corpusSearchError ? "!" : `${searchResults.corpus.total}${searchResults.corpus.hasMore ? "+" : ""}`}
                    </span>
                  </div>
                  {corpusSearchBusy ? (
                    <p className="semantic-field__divider semantic-field__muted border-t px-3 py-2.5 text-xs" role="status">Searching the Galaxy document corpus…</p>
                  ) : corpusSearchError ? (
                    <p className="semantic-field__divider semantic-field__alert border-t bg-[hsl(var(--field-alert)/.08)] px-3 py-2.5 text-xs" role="status">
                      Corpus search unavailable: {corpusSearchError}
                    </p>
                  ) : searchResults.corpus.items.length > 0 ? (
                    <ul className="semantic-field__divider divide-y border-t">
                      {searchResults.corpus.items.map((result) => (
                        <li key={`${result.documentRef}:${result.source.manifestId}:${result.source.chunkContentSha256 ?? "title"}`}>
                          <button
                            type="button"
                            className="semantic-field__search-result w-full px-3 py-2.5 text-left transition focus-visible:outline-none"
                            onClick={() => selectCorpusResult(result)}
                          >
                            <span className="line-clamp-1 text-sm">{result.title || result.displayFilename}</span>
                            <span className="semantic-field__muted mt-0.5 line-clamp-2 block text-xs">{result.snippet}</span>
                            <span className="semantic-field__core mt-1 block text-[11px]">
                              {result.source.representationKind} · lexical {result.matchSource} match · pinned document revision
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="semantic-field__divider semantic-field__muted border-t px-3 py-2.5 text-xs">No document corpus matches.</p>
                  )}
                  {searchResults.corpus.hasMore && !corpusSearchBusy && !corpusSearchError && (
                    <p className="semantic-field__divider semantic-field__muted border-t px-3 py-2 text-[11px]">
                      Showing the first {searchResults.corpus.items.length} lexical matches. Refine the query to narrow the corpus.
                    </p>
                  )}
                </section>

                <section className="semantic-field__search-section" aria-labelledby="ham-search-results-heading" aria-busy={hamSearchBusy}>
                  <div className="flex items-start justify-between gap-3 px-3 py-2">
                    <div>
                      <h3 id="ham-search-results-heading" className="semantic-field__warm text-xs font-semibold">HAM · durable memory</h3>
                      <p className="semantic-field__muted text-[11px]">HAM retrieval score · not comparable to Galaxy matching</p>
                    </div>
                    <span className="semantic-field__muted text-xs tabular-nums">{hamSearchBusy ? "…" : hamSearchError ? "!" : searchResults.ham.total}</span>
                  </div>
                  {hamSearchBusy ? (
                    <p className="semantic-field__divider semantic-field__muted border-t px-3 py-2.5 text-xs" role="status">Searching HAM…</p>
                  ) : hamSearchError ? (
                    <p className="semantic-field__divider semantic-field__alert border-t bg-[hsl(var(--field-alert)/.08)] px-3 py-2.5 text-xs" role="status">
                      HAM search unavailable: {hamSearchError}
                    </p>
                  ) : searchResults.ham.items.length > 0 ? (
                    <ul className="semantic-field__divider divide-y border-t">
                      {searchResults.ham.items.map((result) => (
                        <li key={result.id}>
                          <button
                            type="button"
                            className="semantic-field__search-result w-full px-3 py-2.5 text-left transition focus-visible:outline-none"
                            onClick={() => {
                              onHamMemoryOpen?.(result.id)
                              dismissSearch()
                            }}
                          >
                            <span className="line-clamp-1 text-sm">{result.title}</span>
                            <span className="semantic-field__muted mt-0.5 line-clamp-2 block text-xs">{result.summary}</span>
                            <span className="semantic-field__warm mt-1 block text-[11px]">
                              {result.score === undefined ? "HAM score unavailable" : `HAM score ${result.score.toFixed(3)}`}
                              {` · tier ${result.tier}`}{result.type ? ` · ${result.type}` : ""}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="semantic-field__divider semantic-field__muted border-t px-3 py-2.5 text-xs">No HAM matches.</p>
                  )}
                </section>
              </div>
            </div>
          </div>
        )}

        <div className="order-2 flex items-center gap-1.5 lg:order-none" role="group" aria-label="Field overlays">
          <FieldToggle pressed={showTime} onPressedChange={setShowTime} label="Temporal overlay">
            <Clock3 className="h-4 w-4" aria-hidden="true" />
          </FieldToggle>
          <FieldToggle pressed={showAccess} onPressedChange={setShowAccess} label="Permission overlay">
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          </FieldToggle>
        </div>
      </header>

      <div className="absolute left-4 top-[7.5rem] z-10 max-w-[min(36rem,calc(100%-2rem))] lg:top-24">
        <div className="semantic-field__eyebrow mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.22em]">
          <span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--field-core))]" />
          {copy.eyebrow}
        </div>
        <h2 className="semantic-field__title text-2xl font-semibold leading-tight sm:text-3xl">{copy.title}</h2>
        <p className="semantic-field__muted mt-2 max-w-2xl text-sm leading-relaxed">{copy.detail}</p>
      </div>

      <div className="absolute right-4 top-[17rem] z-10 flex gap-1.5 sm:top-[15rem] lg:top-24" role="group" aria-label="Knowledge lens">
        <LensButton active={lens === "explore"} label="Explore" onClick={() => setLens("explore")} icon={<Telescope className="h-4 w-4" />} />
        <LensButton active={lens === "verify"} label="Verify" onClick={() => setLens("verify")} icon={<ScanSearch className="h-4 w-4" />} />
        <LensButton active={lens === "compose"} label="Compose" onClick={() => setLens("compose")} icon={<GitMerge className="h-4 w-4" />} />
      </div>

      {federatedProjection && federatedProjection.relations.length > 0 && (
        <div
          className="semantic-field__panel absolute right-4 top-[20.5rem] z-10 grid gap-1.5 rounded-xl border p-2 text-[10px] sm:top-[18.5rem] lg:top-40"
          aria-label="Federated relation trust legend"
        >
          {(Object.entries(RELATION_BASIS_STYLE) as Array<[SemanticRelationBasis, NonNullable<(typeof RELATION_BASIS_STYLE)[SemanticRelationBasis]>]>).filter(([basis]) => basis !== "ham_candidate").map(([basis, style]) => (
            <span key={basis} className="flex items-center gap-2" data-relation-basis={basis}>
              <svg width="28" height="6" aria-hidden="true">
                <line x1="0" x2="28" y1="3" y2="3" stroke={style.color} strokeWidth={style.width} strokeDasharray={style.dash} />
              </svg>
              {style.label}
            </span>
          ))}
        </div>
      )}

      <svg
        className="absolute inset-0 h-full w-full touch-none cursor-grab outline-none focus-visible:[filter:drop-shadow(0_0_4px_hsl(var(--field-core)))] active:cursor-grabbing"
        viewBox="0 0 1600 900"
        role="group"
        aria-label={`Zoomable knowledge field at ${SEMANTIC_SCALES[scaleIndex].label} scale`}
        tabIndex={0}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleFieldKeyDown}
      >
        <defs>
          <radialGradient id="semantic-field-project" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="hsl(var(--field-core))" stopOpacity=".22" />
            <stop offset="60%" stopColor="hsl(var(--field-core))" stopOpacity=".08" />
            <stop offset="100%" stopColor="hsl(var(--field-core))" stopOpacity="0" />
          </radialGradient>
          <filter id="semantic-field-glow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="7" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <marker id="semantic-field-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="hsl(var(--field-muted-strong))" />
          </marker>
        </defs>

        <g opacity=".55" aria-hidden="true">
          {Array.from({ length: 90 }, (_, index) => (
            <circle
              key={index}
              cx={(index * 173) % 1600}
              cy={(index * 97) % 900}
              r={index % 13 === 0 ? 1.6 : .75}
              fill="hsl(var(--field-ink))"
              opacity={.18 + (index % 5) * .08}
            />
          ))}
        </g>

        {showTime && (
          <g aria-label="Temporal axis">
            <path d="M 260 770 C 560 700, 980 800, 1340 700" fill="none" stroke="hsl(var(--field-core))" strokeWidth="2" strokeDasharray="6 10" markerEnd="url(#semantic-field-arrow)" />
            <text x="270" y="802" fill="hsl(var(--field-muted-strong))" fontSize="16">earlier context</text>
            <text x="1250" y="735" fill="hsl(var(--field-core))" fontSize="16">current frontier</text>
          </g>
        )}

        <g transform={`translate(${pan.x} ${pan.y}) scale(${visualScale})`} style={{ transformOrigin: "800px 450px", transition: dragRef.current ? "none" : "transform 260ms ease" }}>
          {scaleIndex === 0 && (
            <g aria-hidden="true">
              <ellipse cx="800" cy="455" rx="430" ry="300" fill="url(#semantic-field-project)" />
              {[0, 1, 2, 3, 4, 5].map((index) => {
                const angle = index * Math.PI / 3
                return <ellipse key={index} cx={800 + Math.cos(angle) * 300} cy={455 + Math.sin(angle) * 205} rx="120" ry="72" fill="hsl(var(--field-cool))" opacity=".06" transform={`rotate(${index * 19} ${800 + Math.cos(angle) * 300} ${455 + Math.sin(angle) * 205})`} />
              })}
            </g>
          )}

          {visibleRelations.map((relation) => {
            const from = positions.get(relation.from)
            const to = positions.get(relation.to)
            if (!from || !to) return null
            const curved = relation.kind === "forks" || relation.kind === "joins"
            const middleY = (from.y + to.y) / 2
            const path = curved
              ? `M ${from.x} ${from.y} C ${from.x} ${middleY}, ${to.x} ${middleY}, ${to.x} ${to.y}`
              : `M ${from.x} ${from.y} L ${to.x} ${to.y}`
            const style = relationStyle(relation)
            return (
              <path
                key={relation.id}
                d={path}
                fill="none"
                stroke={style.color}
                strokeWidth={style.width}
                strokeDasharray={style.dash}
                aria-label={`${style.label}: ${relation.kind}${relation.source ? ` from ${relation.source.provider}` : ""}`}
                data-relation-basis={relation.basis}
                markerEnd={showTime ? "url(#semantic-field-arrow)" : undefined}
              >
                <title>{`${style.label} · ${relation.kind}${relation.source ? ` · ${relation.source.provider}` : ""}`}</title>
              </path>
            )
          })}

          {visibleEntities.map((entity, index) => {
            const point = positions.get(entity.id) ?? positionFor(entity, index)
            const isSelected = entity.id === selectedId
            const glyphDepth = glyphDepthFor(entity, scaleIndex)
            const audienceIcon = entity.access.audience === "public" ? <Globe2 /> : entity.access.audience === "team" || entity.access.audience === "shared" ? <Users /> : <LockKeyhole />
            return (
              <g
                key={entity.id}
                transform={`translate(${point.x} ${point.y})`}
                role="button"
                tabIndex={0}
                aria-label={`${entity.kind}: ${entity.title}. ${entity.detail}`}
                aria-pressed={isSelected}
                className="cursor-pointer outline-none focus-visible:[filter:drop-shadow(0_0_7px_hsl(var(--field-core)))]"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => selectEntity(entity)}
                onDoubleClick={() => descendInto(entity)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    selectEntity(entity)
                  }
                  if (event.key === "ArrowDown") {
                    event.preventDefault()
                    descendInto(entity)
                  }
                }}
              >
                {showAccess && !entity.sourceMemoryId && (
                  <circle
                    r={entity.kind === "project" ? 104 : 56}
                    fill="none"
                    stroke={entity.access.audience === "private" ? "hsl(var(--field-alert-strong))" : "hsl(var(--field-core))"}
                    strokeOpacity=".82"
                    strokeWidth="5"
                    strokeDasharray={entity.access.inheritedFrom ? "3 7" : undefined}
                  />
                )}
                <g filter={isSelected ? "url(#semantic-field-glow)" : undefined}>
                  <NodeGlyph entity={entity} selected={isSelected} depth={glyphDepth} />
                </g>
                {/*
                  The label follows the representation: a token is small enough
                  that its name sits just beneath it, and an entered world puts
                  its title inside the frame rather than below it.
                */}
                <text
                  y={glyphDepth === "icon" ? 28 : glyphDepth === "world" ? (entity.kind === "project" ? -62 : -44) : entity.kind === "project" ? 112 : entity.kind === "task" ? 72 : 55}
                  x={glyphDepth === "world" ? (entity.kind === "project" ? -134 : -102) : 0}
                  textAnchor={glyphDepth === "world" ? "start" : "middle"}
                  fill={isSelected ? "hsl(var(--field-core))" : "hsl(var(--field-ink))"}
                  fontSize={glyphDepth === "icon" ? 13 : entity.kind === "project" ? 24 : 17}
                  fontWeight={isSelected ? 700 : 600}
                >
                  {entity.title.length > (glyphDepth === "icon" ? 18 : 34)
                    ? `${entity.title.slice(0, glyphDepth === "icon" ? 15 : 31)}…`
                    : entity.title}
                </text>
                {entity.descendantCount !== undefined && glyphDepth === "block" && (
                  <text y={entity.kind === "project" ? 139 : entity.kind === "task" ? 94 : 76} textAnchor="middle" fill="hsl(var(--field-muted-strong))" fontSize="14">
                    {compact(entity.descendantCount)} descendants
                  </text>
                )}
                {showAccess && !entity.sourceMemoryId && (
                  <g
                    transform={`translate(${glyphDepth === "icon" ? 12 : glyphDepth === "world" ? (entity.kind === "project" ? 128 : 96) : entity.kind === "project" ? 76 : 40} ${glyphDepth === "icon" ? -14 : glyphDepth === "world" ? (entity.kind === "project" ? -78 : -60) : entity.kind === "project" ? -76 : -42})`}
                    color="hsl(var(--field-core))"
                  >
                    {audienceIcon}
                  </g>
                )}
              </g>
            )
          })}

          {draftBranches.map((branch, index) => {
            if (scaleIndex < 2) return null
            const origin = positions.get(branch.originId) ?? { x: 800, y: 450 }
            const x = origin.x + 170 + index * 28
            const y = origin.y + 100 + index * 78
            const color = branch.action === "Challenge" ? "hsl(var(--field-alert-strong))" : branch.action === "Synthesize" ? "hsl(var(--field-cool-strong))" : "hsl(var(--field-core))"
            return (
              <g key={branch.id} aria-label={`Draft ${branch.action} branch: ${branch.title}`}>
                <path d={`M ${origin.x} ${origin.y} C ${origin.x + 80} ${origin.y}, ${x - 80} ${y}, ${x} ${y}`} fill="none" stroke={color} strokeWidth="2" strokeDasharray="4 6" />
                <circle cx={x} cy={y} r="24" fill="hsl(var(--field-panel))" stroke={color} strokeWidth="2" />
                <text x={x} y={y + 47} textAnchor="middle" fill="hsl(var(--field-ink))" fontSize="14">{branch.action} draft</text>
              </g>
            )
          })}
        </g>
      </svg>

      <div className="absolute bottom-40 left-4 z-20 flex flex-col gap-2">
        <Button size="icon" variant="outline" className="semantic-field__control h-11 w-11" onClick={() => setZoom((value) => Math.min(6.2, value * 1.22))} aria-label="Zoom in">
          <Plus className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="outline" className="semantic-field__control h-11 w-11" onClick={() => setZoom((value) => Math.max(.36, value / 1.22))} aria-label="Zoom out">
          <Minus className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="outline" className="semantic-field__control h-11 w-11" onClick={() => { setPan({ x: 0, y: 0 }); goToScale(scaleIndex) }} aria-label="Recenter field">
          <LocateFixed className="h-4 w-4" />
        </Button>
      </div>

      {selected && (
        <aside
          className={cn(
            "semantic-field__panel absolute right-4 z-20 w-[min(29rem,calc(100%-5.5rem))] rounded-2xl border p-4 md:right-[8.5rem]",
            dockPinned ? "top-40" : "bottom-[9.5rem]",
          )}
          aria-label="Selected object dock"
          data-pinned={dockPinned}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="semantic-field__eyebrow text-[10px] font-semibold uppercase tracking-[.2em]">{selected.sourceMemoryId ? "HAM neighborhood suggestion" : selected.kind}</p>
              <h3 className="semantic-field__title mt-1 truncate text-base font-semibold">{selected.title}</h3>
              <p className="semantic-field__muted mt-1 line-clamp-2 text-xs leading-relaxed">{selected.detail}</p>
              {selected.sources && selected.sources.length > 0 && (
                <p className="semantic-field__muted mt-1 truncate text-[11px]">
                  Sources: {selected.sources.map((source) => source.provider).join(" · ")}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <span className="semantic-field__muted rounded-full border border-[hsl(var(--field-border))] px-2 py-1 text-[10px] uppercase tracking-wide">{selected.status ?? "active"}</span>
              <button
                type="button"
                className="semantic-field__control grid h-10 w-10 place-items-center rounded-lg border-0 focus-visible:outline-none"
                onClick={() => setDockPinned((value) => !value)}
                aria-label={dockPinned ? "Unpin selected object dock" : "Pin selected object dock"}
                aria-pressed={dockPinned}
              >
                {dockPinned ? <PinOff className="h-4 w-4" aria-hidden="true" /> : <Pin className="h-4 w-4" aria-hidden="true" />}
              </button>
              <button
                type="button"
                className="semantic-field__control grid h-10 w-10 place-items-center rounded-lg border-0 focus-visible:outline-none"
                onClick={clearSelection}
                aria-label="Clear selected object"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="semantic-field__reference mt-3 flex min-w-0 items-center gap-1.5 rounded-xl border p-1.5">
            <code className="min-w-0 flex-1 truncate px-2 text-[11px]">
              {selected.sourceReference ?? (selected.sourceNodeId ? createGalaxyReference("node", selected.sourceNodeId) : createGalaxyReference("entity", selected.id))}
            </code>
            <button type="button" className="semantic-field__control grid h-10 w-10 shrink-0 place-items-center rounded-lg border-0 focus-visible:outline-none" onClick={() => void copySelection("reference")} aria-label="Copy stable object reference" title="Copy stable object reference">
              <Copy className="h-4 w-4" aria-hidden="true" />
            </button>
            {selectedHasExactGraphLoader && (
              <button type="button" className="semantic-field__control grid h-10 w-10 shrink-0 place-items-center rounded-lg border-0 focus-visible:outline-none" onClick={() => void copySelection("link")} aria-label="Copy deep link to selected object" title="Copy deep link">
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
          {selected.sourceNodeId && (
            <p className="semantic-field__muted mt-2 text-xs" role="status">
              {hamNeighborhoodState === "loading" ? "Looking for nearby HAM memory…" : hamNeighborhoodState === "ready" ? `${hamNeighborhood?.results.length ?? 0} HAM candidates nearby · dotted edges are suggestions, not evidence` : hamNeighborhoodState === "unavailable" ? "HAM neighborhood unavailable for this workspace" : "HAM neighborhood is not queried for an untitled note"}
            </p>
          )}
          {selected.sourceMemoryId && (
            <p className="semantic-field__muted mt-2 text-xs">This is semantic proximity from HAM retrieval, not an authored Galaxy relation or proof of support.</p>
          )}
          {!selected.sourceMemoryId && (
            <div className="mt-3 grid grid-cols-3 gap-2" role="group" aria-label="Branch from selection">
              {(["Challenge", "Compare", "Synthesize"] as const).map((action) => (
                <button
                  key={action}
                  type="button"
                  onClick={() => createBranch(action)}
                  className="semantic-field__branch-action min-h-11 rounded-xl border px-2 text-xs font-medium transition focus-visible:outline-none"
                >
                  {action}
                </button>
              ))}
            </div>
          )}
          {selected.sourceNodeId && onNodeOpen && (
            <button
              type="button"
              className="semantic-field__primary-action mt-2 min-h-11 w-full rounded-xl border px-3 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--field-core))]"
              onClick={() => {
                const node = nodes.find((entry) => entry.id === selected.sourceNodeId)
                if (node) onNodeOpen(node)
              }}
            >
              Open source material
            </button>
          )}
          {selectedHamMemoryId && onHamMemoryOpen && (
            <button
              type="button"
              className="semantic-field__warm-action mt-2 min-h-11 w-full rounded-xl border px-3 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--field-warm-strong))]"
              onClick={() => onHamMemoryOpen(selectedHamMemoryId)}
            >
              Open canonical HAM memory
            </button>
          )}
        </aside>
      )}

      <footer className="semantic-field__chrome absolute inset-x-0 bottom-[4.75rem] z-20 flex min-h-16 items-center gap-3 border-t px-4 py-2">
        <p className="semantic-field__muted hidden w-36 shrink-0 text-xs xl:block">scroll to zoom · drag to travel</p>
        <div className="flex min-w-0 flex-1 items-center justify-center gap-1" role="group" aria-label="Semantic zoom level">
          {SEMANTIC_SCALES.map((scale, index) => (
            <button
              key={scale.id}
              type="button"
              onClick={() => goToScale(index)}
              aria-pressed={scaleIndex === index}
              className={cn(
                "semantic-field__scale relative min-h-11 min-w-0 flex-1 rounded-xl border border-transparent px-2 text-xs font-medium transition focus-visible:outline-none sm:max-w-36",
              )}
              data-active={scaleIndex === index}
            >
              <span className="semantic-field__scale-indicator absolute inset-x-3 top-1 h-px" />
              <span className="block truncate pt-1">{scale.label}</span>
            </button>
          ))}
        </div>
        <div className="semantic-field__muted hidden w-44 shrink-0 text-right text-[11px] leading-tight lg:block">
          <strong className="semantic-field__ink block">{compact(projection.corpusStatementCount)} addressable objects</strong>
          {includeConceptFixtures
            ? `${compact(9_406 + draftBranches.length)} modeled branches`
            : `${draftBranches.length} branch ${draftBranches.length === 1 ? "draft" : "drafts"}`}
        </div>
      </footer>

      <p className="sr-only" role="status" aria-live="polite">{liveMessage}</p>
      <ul className="sr-only" aria-label={`Objects visible at ${SEMANTIC_SCALES[scaleIndex].label} scale`}>
        {visibleEntities.map((entry) => <li key={entry.id}>{entry.kind}: {entry.title}. {entry.detail}</li>)}
      </ul>
      <ul className="sr-only" aria-label={`Relations visible at ${SEMANTIC_SCALES[scaleIndex].label} scale`}>
        {visibleRelations.map((relation) => {
          const style = relationStyle(relation)
          return <li key={relation.id}>{style.label}: {relation.from} to {relation.to}. Relation type {relation.kind.replaceAll("_", " ")}.</li>
        })}
      </ul>
    </section>
  )
}

function FieldToggle({
  pressed,
  onPressedChange,
  label,
  children,
}: {
  pressed: boolean
  onPressedChange: (pressed: boolean) => void
  label: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        "semantic-field__control grid h-11 w-11 place-items-center rounded-full border transition focus-visible:outline-none",
      )}
      data-active={pressed}
    >
      {children}
    </button>
  )
}

function LensButton({ active, label, onClick, icon }: { active: boolean; label: string; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={`${label} lens`}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "semantic-field__control flex min-h-11 items-center gap-2 rounded-full border px-3 text-xs font-medium transition focus-visible:outline-none",
      )}
      data-active={active}
    >
      {icon}<span className="hidden sm:inline">{label}</span>
    </button>
  )
}
