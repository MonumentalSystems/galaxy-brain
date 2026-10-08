"use client"

import { type AriaRole, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowUpRight, CircleDot, Download, GitBranch, GitMerge, Layers3, ListTree, Search, ShieldCheck } from "lucide-react"

import { MarkdownRenderer } from "@/components/markdown-renderer"
import {
  deterministicGraphFallback,
  GRAPH_LAYOUT_SCHEMA_ID,
  graphLayoutCacheKey,
  type GraphLayoutRequest,
  type GraphLayoutResult,
  type GraphScale,
} from "@/lib/graph-layout-client.js"
import { exactGenerousSurfaceHref } from "@/lib/generous-surface-open.js"
import { paperTaskConstructorHref } from "@/lib/paper-enhance-handoff.js"
import type {
  GalaxyGraphTrust,
  UnifiedGraphEdge,
  UnifiedGraphNode,
  UnifiedGraphProjection,
} from "@/lib/unified-graph.js"
import { deriveUnifiedGraphView } from "@/lib/unified-graph.js"
import type { TaskSummary } from "@/lib/types/tasks"
import { cn } from "@/lib/utils"

export type { UnifiedGraphProjection } from "@/lib/unified-graph.js"

type UnifiedGraphProps = {
  projection: UnifiedGraphProjection
  className?: string
  initialScale?: GraphScale
  onScaleChange?: (scale: GraphScale) => void
  selectedReference?: string | null
  onSelectedReferenceChange?: (reference: string | null) => void
  focusSelectedReference?: string | null
  onFocusedSelectedReference?: (reference: string) => void
  onOpenReference?: (reference: string) => void
  hrefForReference?: (reference: string) => string
  openReferenceLabel?: string | ((node: UnifiedGraphNode) => string)
  coordinationTasks?: readonly TaskSummary[]
  selectedTurnDetail?: Readonly<{ reference: string; content: string }> | null
  conversationFork?: Readonly<{
    disabledReason: string | null
    onOpen: (reference: string, title: string, trigger: HTMLButtonElement) => void
  }> | null
  conversationJoin?: Readonly<{
    candidates: readonly Readonly<{ reference: string; title: string }>[]
    selectedTipReference: string
    disabledReason: string | null
    onOpen: (
      parentReferences: readonly string[],
      parentLabels: readonly string[],
      trigger: HTMLButtonElement,
    ) => void
  }> | null
  conversationExport?: Readonly<{
    conversationReference: string
    disabledReason: string | null
    state: "idle" | "downloading" | "downloaded" | "error"
    message: string | null
    onDownload: () => void
  }> | null
}

type LinkedHamTask = {
  node: UnifiedGraphNode
  task: TaskSummary
}

const SCALE_ORDER: GraphScale[] = ["corpus", "project", "task", "run", "object", "atomic"]
const EMPTY_COORDINATION_TASKS: readonly TaskSummary[] = []
const SCALE_LABEL: Record<GraphScale, string> = {
  corpus: "Corpus",
  project: "Project",
  task: "Task",
  run: "Run / chat",
  object: "Object",
  atomic: "Atomic",
}
const CONVERSATION_SCALE_LABEL: Record<GraphScale, string> = {
  corpus: "Bundle",
  project: "Branches",
  task: "Turns",
  run: "Thread",
  object: "Detail",
  atomic: "Exact",
}

const GRAPH_COLOR = Object.freeze({
  surface: "hsl(var(--field-surface))",
  panel: "hsl(var(--field-panel))",
  ink: "hsl(var(--field-ink))",
  muted: "hsl(var(--field-muted-strong))",
  core: "hsl(var(--field-core))",
  cool: "hsl(var(--field-cool-strong))",
  warm: "hsl(var(--graph-warm-edge))",
})

const layoutCache = new Map<string, GraphLayoutResult>()

function inferredMinimumScale(node: UnifiedGraphNode): GraphScale {
  if (["corpus", "project", "campaign", "proof.graph", "code.graph"].includes(node.kind)) return "corpus"
  if (["mission", "milestone", "task", "task-plan"].includes(node.kind)) return "project"
  if (["run", "chat", "job", "proof.node"].includes(node.kind)) return "task"
  if (["turn", "claim", "artifact"].includes(node.kind)) return "run"
  if (["document.anchor", "document.mark", "chunk", "equation", "figure", "code.symbol"].includes(node.kind)) return "atomic"
  return "object"
}

function edgeTone(trustClass: GalaxyGraphTrust) {
  switch (trustClass) {
    case "verification": return { color: GRAPH_COLOR.core, width: 2.5, dash: undefined, label: "Verified evidence" }
    case "assertion": return { color: GRAPH_COLOR.cool, width: 1.8, dash: "7 5", label: "Authored assertion" }
    case "candidate": return { color: GRAPH_COLOR.warm, width: 1.4, dash: "2 7", label: "Candidate relation" }
    default: return { color: GRAPH_COLOR.muted, width: 1.7, dash: undefined, label: "Structure" }
  }
}

function edgeVisual(edge: UnifiedGraphEdge) {
  if (edge.relation === "continues") return { color: GRAPH_COLOR.core, width: 2.2, dash: undefined, label: "Continues" }
  if (edge.relation === "forks") return { color: GRAPH_COLOR.cool, width: 2, dash: "8 5", label: "Forks" }
  if (edge.relation === "joins") return { color: GRAPH_COLOR.warm, width: 2.2, dash: "3 4", label: "Joins" }
  if (edge.relation === "contains") return { color: GRAPH_COLOR.muted, width: 1.1, dash: "2 7", label: "Contained turn" }
  return edgeTone(edge.trust)
}

function nodeTone(node: UnifiedGraphNode) {
  if (node.overlays.proof?.graphKind === "repository-field") return GRAPH_COLOR.core
  if (node.overlays.proof?.workPolicy === "explicit-task-materialization") return GRAPH_COLOR.cool
  if (node.kind.includes("proof")) return GRAPH_COLOR.core
  if (node.kind.includes("task") || node.kind === "run" || node.kind === "chat") return GRAPH_COLOR.cool
  return GRAPH_COLOR.muted
}

function conversationLayers(nodes: readonly UnifiedGraphNode[], edges: readonly UnifiedGraphEdge[]) {
  const turns = new Set(nodes.filter((node) => node.kind === "turn").map((node) => node.id))
  const depth = new Map<string, number>([...turns].map((id) => [id, 1]))
  const incoming = new Map<string, number>([...turns].map((id) => [id, 0]))
  const children = new Map<string, string[]>()
  for (const edge of edges) {
    if (!["continues", "forks", "joins"].includes(edge.relation)
      || !turns.has(edge.from) || !turns.has(edge.to)) continue
    incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1)
    children.set(edge.from, [...(children.get(edge.from) || []), edge.to])
  }
  const queue = [...turns].filter((id) => incoming.get(id) === 0).sort()
  while (queue.length > 0) {
    const id = queue.shift() as string
    for (const child of (children.get(id) || []).sort()) {
      depth.set(child, Math.max(depth.get(child) || 1, (depth.get(id) || 1) + 1))
      const remaining = (incoming.get(child) || 1) - 1
      incoming.set(child, remaining)
      if (remaining === 0) queue.push(child)
    }
    queue.sort()
  }
  return new Map(nodes.map((node) => [
    node.id,
    node.kind === "chat" ? 0 : node.kind === "turn" ? Math.min(12, depth.get(node.id) || 1) : SCALE_ORDER.indexOf(inferredMinimumScale(node)),
  ]))
}

function projectionLayoutRequest(projection: UnifiedGraphProjection, nodes: readonly UnifiedGraphNode[], edges: readonly UnifiedGraphEdge[], scale: GraphScale): GraphLayoutRequest {
  const layers = projection.query.mode === "conversation" ? conversationLayers(nodes, edges) : null
  return {
    schemaId: GRAPH_LAYOUT_SCHEMA_ID,
    projectionHash: projection.projectionHash,
    scale,
    nodes: nodes.map((node) => ({
      id: node.id,
      layer: layers?.get(node.id) ?? SCALE_ORDER.indexOf(inferredMinimumScale(node)),
    })),
    edges: edges.map((edge) => ({ source: edge.from, target: edge.to })),
  }
}

function useGraphLayout(projection: UnifiedGraphProjection, nodes: readonly UnifiedGraphNode[], edges: readonly UnifiedGraphEdge[], scale: GraphScale) {
  const request = useMemo(
    () => projectionLayoutRequest(projection, nodes, edges, scale),
    [edges, nodes, projection, scale],
  )
  const key = graphLayoutCacheKey(projection.projectionHash, scale)
  const [layout, setLayout] = useState<GraphLayoutResult>(() => layoutCache.get(key) || deterministicGraphFallback(request))
  const requestId = useRef(0)

  useEffect(() => {
    const cached = layoutCache.get(key)
    const fallback = cached || deterministicGraphFallback(request)
    setLayout(fallback)
    if (cached || typeof Worker === "undefined" || request.nodes.length === 0) return

    const currentRequestId = ++requestId.current
    const worker = new Worker(new URL("../../workers/unified-graph-layout.worker.ts", import.meta.url), { type: "module" })
    worker.addEventListener("message", (event: MessageEvent<{ requestId: number; ok: boolean; result?: GraphLayoutResult }>) => {
      if (event.data?.requestId !== currentRequestId || !event.data.ok || !event.data.result) return
      layoutCache.set(key, event.data.result)
      setLayout(event.data.result)
    })
    worker.postMessage({ requestId: currentRequestId, request })
    return () => worker.terminate()
  }, [key, request])

  return layout
}

function defaultReferenceHref(reference: string) {
  return `/graph?ref=${encodeURIComponent(reference)}`
}

function provenanceText(node: UnifiedGraphNode) {
  return node.provenance.map((entry) => entry.provider).filter(Boolean).join(", ") || "Projection source"
}

function projectorAvailabilityText(node: UnifiedGraphNode) {
  return node.projector?.diagnostic === "projector_unavailable"
    ? "Projector unavailable"
    : null
}

function graphNodeAccessibleLabel(node: UnifiedGraphNode) {
  return [node.title, node.kind, projectorAvailabilityText(node)].filter(Boolean).join(", ")
}

function projectorInspectorText(node: UnifiedGraphNode) {
  const plugin = node.projector?.plugin
  if (plugin) return `${plugin.displayName} · ${plugin.id}@${plugin.version}`
  return node.projector?.diagnostic === "projector_unavailable"
    ? `Unavailable for ${node.kind}`
    : "Projection metadata unavailable"
}

function providerStatusText(projection: UnifiedGraphProjection) {
  const providers = Array.isArray(projection.provenance.providers)
    ? projection.provenance.providers as Array<{ provider?: unknown; status?: unknown }>
    : []
  return providers.map((entry) => `${String(entry.provider || "provider")}: ${String(entry.status || "unknown")}`).join(" · ") || "Authorized projection"
}

function proofOverlayLabels(node: UnifiedGraphNode) {
  const proof = node.overlays.proof
  if (!proof) return []
  return [
    `${proof.graphKind} proof graph`,
    proof.workPolicy === "passive" ? "Browse only" : "Explicit task materialization",
  ]
}

function linkedHamTaskForProof(
  projection: UnifiedGraphProjection,
  proofNode: UnifiedGraphNode | null,
  tasksById: ReadonlyMap<string, TaskSummary>,
): LinkedHamTask | null {
  const taskId = proofNode?.overlays.proof?.nodeState?.taskId
  if (!proofNode || proofNode.kind !== "proof.node" || !taskId) return null
  const coordination = projection.edges.find((edge) => (
    edge.from === proofNode.id && edge.relation === "coordinated_by"
      && projection.nodes.some((node) => (
        node.id === edge.to
          && node.kind === "ham.task"
          && node.projection.provenance.sourceId === taskId
      ))
  ))
  if (!coordination) return null
  const taskNode = projection.nodes.find((node) => node.id === coordination.to)
  if (taskNode?.kind !== "ham.task" || taskNode.projection.provenance.sourceId !== taskId) return null
  const task = tasksById.get(taskId)
  if (!task || task.id !== taskId) return null
  return { node: taskNode, task }
}

function activeRunText(task: TaskSummary) {
  if (!task.activeRun) return "No active run"
  return [task.activeRun.id, task.activeRun.status, task.activeRun.stage].filter(Boolean).join(" · ")
}

function exactTaskConstructorHref(task: TaskSummary) {
  const version = task.version
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) return null
  try {
    return paperTaskConstructorHref({ id: task.id, version })
  } catch {
    return null
  }
}

function radiusForRepresentation(node: UnifiedGraphNode) {
  if (node.representation === "glyph") return 11
  if (node.representation === "label") return 18
  if (node.representation === "detail") return 34
  if (node.representation === "placeholder") return 14
  return 25
}

function representationHasLabel(node: UnifiedGraphNode) {
  return node.representation !== "glyph" && node.representation !== "placeholder"
}

export function UnifiedGraph({
  projection,
  className,
  initialScale,
  onScaleChange,
  selectedReference,
  onSelectedReferenceChange,
  focusSelectedReference = null,
  onFocusedSelectedReference,
  onOpenReference,
  hrefForReference = defaultReferenceHref,
  openReferenceLabel = "Open exact reference",
  coordinationTasks = EMPTY_COORDINATION_TASKS,
  selectedTurnDetail = null,
  conversationFork = null,
  conversationJoin = null,
  conversationExport = null,
}: UnifiedGraphProps) {
  const semanticScale = initialScale || projection.query.scale
  const [scale, setScale] = useState<GraphScale>(semanticScale)
  const [internalSelectedReference, setInternalSelectedReference] = useState<string | null>(selectedReference ?? null)
  const [selectedSyntheticId, setSelectedSyntheticId] = useState<string | null>(null)
  const [showList, setShowList] = useState(false)
  const [filter, setFilter] = useState("")
  const joinSelectionKey = `${projection.projectionHash}\u0000${conversationJoin?.selectedTipReference ?? ""}`
  const [joinSelection, setJoinSelection] = useState<Readonly<{
    key: string
    references: readonly string[]
  }>>({ key: joinSelectionKey, references: [] })
  const additionalJoinTipReferences = joinSelection.key === joinSelectionKey
    ? joinSelection.references
    : []
  const inspectorHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const selectedRef = selectedReference === undefined ? internalSelectedReference : selectedReference
  const conversationMode = projection.query.mode === "conversation"

  useEffect(() => {
    setScale((current) => current === semanticScale ? current : semanticScale)
  }, [semanticScale])

  useEffect(() => {
    if (selectedReference !== undefined) setInternalSelectedReference(selectedReference)
  }, [selectedReference])

  const selectScale = useCallback((nextScale: GraphScale) => {
    setScale(nextScale)
    onScaleChange?.(nextScale)
  }, [onScaleChange])

  const selectNode = useCallback((node: UnifiedGraphNode) => {
    if (node.ref) {
      if (selectedReference === undefined) setInternalSelectedReference(node.ref)
      onSelectedReferenceChange?.(node.ref)
      setSelectedSyntheticId(null)
    } else {
      setSelectedSyntheticId(node.id)
    }
  }, [onSelectedReferenceChange, selectedReference])

  const normalizedFilter = filter.trim().toLocaleLowerCase()
  const scaledProjection = useMemo(() => deriveUnifiedGraphView({
    ...projection,
    query: { ...projection.query, scale },
  }), [projection, scale])
  const semanticNodes = useMemo(() => (
    conversationMode && scale === "corpus"
      ? scaledProjection.nodes.filter((node) => node.kind === "chat")
      : scaledProjection.nodes
  ), [conversationMode, scale, scaledProjection.nodes])
  const visibleNodes = useMemo(() => semanticNodes.filter((node) => (
    !normalizedFilter || `${node.title} ${node.summary || ""} ${node.kind}`.toLocaleLowerCase().includes(normalizedFilter)
  )), [normalizedFilter, semanticNodes])
  const scaleEdges = useMemo(() => scaledProjection.edges.filter((edge) => (
    !conversationMode || scale === "corpus" || edge.relation !== "contains"
  )), [conversationMode, scale, scaledProjection.edges])
  const semanticIds = useMemo(() => new Set(semanticNodes.map((node) => node.id)), [semanticNodes])
  const semanticEdges = useMemo(() => scaleEdges.filter((edge) => (
    semanticIds.has(edge.from) && semanticIds.has(edge.to)
  )), [scaleEdges, semanticIds])
  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes])
  const visibleEdges = useMemo(() => semanticEdges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to)), [semanticEdges, visibleIds])
  // Layout the complete semantic-scale projection. Text filtering is a view
  // concern and must not mutate or poison the projection-hash layout cache.
  const layout = useGraphLayout(projection, semanticNodes, semanticEdges, scale)
  const selected = scaledProjection.nodes.find((node) => node.ref === selectedRef || node.id === selectedSyntheticId) || null
  const hiddenSelection = Boolean(selected && !visibleIds.has(selected.id))
  const coordinationTasksById = useMemo(
    () => new Map(coordinationTasks.map((task) => [task.id, task])),
    [coordinationTasks],
  )
  const linkedHamTask = useMemo(
    () => linkedHamTaskForProof(scaledProjection, selected, coordinationTasksById),
    [coordinationTasksById, scaledProjection, selected],
  )
  const linkedTaskConstructorHref = linkedHamTask
    ? exactTaskConstructorHref(linkedHamTask.task)
    : null
  const scaleLabels = conversationMode ? CONVERSATION_SCALE_LABEL : SCALE_LABEL
  const selectedRelations = useMemo(() => selected ? scaledProjection.edges.filter((edge) => (
    edge.from === selected.id || edge.to === selected.id
  )) : [], [scaledProjection.edges, selected])
  const exactTurnContent = selected?.kind === "turn" && selected.ref
    && selectedTurnDetail?.reference === selected.ref
    ? selectedTurnDetail.content
    : null

  useEffect(() => {
    if (!focusSelectedReference || selected?.ref !== focusSelectedReference) return
    const heading = inspectorHeadingRef.current
    if (!heading) return
    heading.focus()
    onFocusedSelectedReference?.(focusSelectedReference)
  }, [focusSelectedReference, onFocusedSelectedReference, selected?.ref])
  const showExactTurnContent = conversationMode && selected?.kind === "turn"
    && (scale === "object" || scale === "atomic")
  const selectedJoinTip = conversationJoin?.candidates.find((candidate) => (
    candidate.reference === conversationJoin.selectedTipReference
  )) ?? null
  const showConversationJoin = Boolean(
    conversationMode
      && selected?.kind === "turn"
      && selected.ref
      && selected.ref === conversationJoin?.selectedTipReference
      && selectedJoinTip,
  )
  const availableJoinTips = conversationJoin?.candidates.filter((candidate) => (
    candidate.reference !== conversationJoin.selectedTipReference
  )) ?? []
  const selectedAdditionalJoinTips = availableJoinTips.filter((candidate) => (
    additionalJoinTipReferences.includes(candidate.reference)
  ))
  const selectedJoinTipCount = selectedJoinTip ? selectedAdditionalJoinTips.length + 1 : 0
  const joinSelectionIsFull = selectedJoinTipCount >= 8

  const toggleAdditionalJoinTip = useCallback((reference: string, checked: boolean) => {
    setJoinSelection((current) => {
      const currentReferences = current.key === joinSelectionKey ? current.references : []
      if (!checked) return {
        key: joinSelectionKey,
        references: currentReferences.filter((candidateReference) => candidateReference !== reference),
      }
      if (currentReferences.includes(reference) || currentReferences.length >= 7) {
        return { key: joinSelectionKey, references: currentReferences }
      }
      return { key: joinSelectionKey, references: [...currentReferences, reference] }
    })
  }, [joinSelectionKey])

  const bounds = useMemo(() => {
    const points = visibleNodes.map((node) => layout.positions[node.id]).filter(Boolean)
    if (points.length === 0) return { x: -500, y: -340, width: 1_000, height: 680 }
    const xs = points.map((point) => point.x)
    const ys = points.map((point) => point.y)
    const minimumX = Math.min(...xs) - 120
    const minimumY = Math.min(...ys) - 100
    return {
      x: minimumX,
      y: minimumY,
      width: Math.max(900, Math.max(...xs) - minimumX + 120),
      height: Math.max(620, Math.max(...ys) - minimumY + 100),
    }
  }, [layout.positions, visibleNodes])

  const openSelected = useCallback((reference: string) => {
    if (onOpenReference) onOpenReference(reference)
  }, [onOpenReference])
  const exactGenerousSurfaceDestination = selected
    ? exactGenerousSurfaceHref(selected)
    : null

  return (
    <section
      data-slot="unified-graph"
      data-scale={scale}
      className={cn("graph-surface relative overflow-hidden rounded-[1.75rem] border", className)}
      aria-labelledby="unified-graph-title"
    >
      <header className="graph-surface__header flex flex-wrap items-center justify-between gap-4 border-b px-5 py-4">
        <div>
          <p className="research-kicker">{conversationMode ? "Immutable conversation atlas" : `Living graph · ${projection.query.mode || "mixed"}`}</p>
          <h2 id="unified-graph-title" tabIndex={-1} data-conversation-graph-focus-fallback className="research-display mt-1 text-2xl font-semibold">{conversationMode ? "Conversation tree" : "Semantic field"}</h2>
          <p className="graph-surface__muted mt-1 text-xs">{visibleNodes.length} visible objects · {visibleEdges.length} relations · {layout.mode} layout</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative">
            <span className="sr-only">Filter visible graph objects</span>
            <Search className="graph-surface__muted pointer-events-none absolute left-3 top-3.5 h-4 w-4" aria-hidden="true" />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              className="graph-surface__control h-11 w-52 rounded-full border pl-9 pr-3 text-sm outline-none"
              placeholder="Find in this view"
            />
          </label>
          <button
            type="button"
            onClick={() => setShowList((current) => !current)}
            aria-pressed={showList}
            className="graph-surface__control inline-flex h-11 items-center gap-2 rounded-full border px-3 text-sm font-medium focus-visible:outline-none"
          >
            <ListTree className="h-4 w-4" aria-hidden="true" /> {showList ? "Map" : "List"}
          </button>
        </div>
        <nav className="flex w-full gap-1 overflow-x-auto" aria-label="Semantic graph scale">
          {SCALE_ORDER.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={scale === item}
              onClick={() => selectScale(item)}
              className={cn(
                "graph-surface__focus min-h-11 shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none motion-reduce:transition-none",
                scale === item ? "graph-surface__active-scale" : "graph-surface__muted hover:bg-[hsl(var(--field-core-soft))] hover:text-[hsl(var(--field-ink))]",
              )}
            >
              {scaleLabels[item]}
            </button>
          ))}
        </nav>
      </header>

      <div className="grid min-h-[39rem] lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="graph-surface__field relative min-h-[34rem] overflow-hidden">
          {showList ? (
            <AccessibleGraphList nodes={visibleNodes} edges={visibleEdges} selected={selected} onSelect={selectNode} />
          ) : (
            <svg
              className="h-full min-h-[34rem] w-full"
              viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`}
              role={"graphics-document document" as AriaRole}
              aria-roledescription="interactive graph"
              aria-labelledby="unified-graph-map-title unified-graph-map-description"
            >
              <title id="unified-graph-map-title">{`${conversationMode ? "Conversation tree" : "Semantic graph map"} at ${scaleLabels[scale]} scale`}</title>
              <desc id="unified-graph-map-description">Use Tab to focus objects, Enter to inspect exact immutable details, or switch to the accessible list.</desc>
              <g aria-label="Relations">
                {visibleEdges.map((edge) => {
                  const from = layout.positions[edge.from]
                  const to = layout.positions[edge.to]
                  if (!from || !to) return null
                  const tone = edgeVisual(edge)
                  return (
                    <path
                      key={edge.id}
                      d={`M ${from.x} ${from.y} L ${to.x} ${to.y}`}
                      fill="none"
                      stroke={tone.color}
                      strokeWidth={tone.width}
                      strokeDasharray={tone.dash}
                      opacity="0.72"
                      data-trust-class={edge.trust}
                    >
                      <title>{`${tone.label}: ${edge.relation}`}</title>
                    </path>
                  )
                })}
              </g>
              <g aria-label="Objects">
                {visibleNodes.map((node) => {
                  const point = layout.positions[node.id]
                  if (!point) return null
                  const active = selected?.id === node.id
                  const radius = radiusForRepresentation(node)
                  return (
                    <g
                      key={node.id}
                      transform={`translate(${point.x} ${point.y})`}
                      role="button"
                      tabIndex={0}
                      aria-label={graphNodeAccessibleLabel(node)}
                      aria-pressed={active}
                      onClick={() => selectNode(node)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault()
                          selectNode(node)
                        }
                      }}
                      className="graph-surface__node cursor-pointer outline-none"
                      data-kind={node.kind}
                    >
                      <circle r={radius + (active ? 5 : 0)} fill={active ? GRAPH_COLOR.panel : GRAPH_COLOR.surface} stroke={nodeTone(node)} strokeWidth={active ? 4 : 2.5} />
                      <circle r="4" fill={nodeTone(node)} />
                      {representationHasLabel(node) ? (
                        <text y={radius + 19} textAnchor="middle" fill={GRAPH_COLOR.ink} fontSize="13" fontWeight="600">
                          {node.title.length > 34 ? `${node.title.slice(0, 32)}…` : node.title}
                        </text>
                      ) : null}
                    </g>
                  )
                })}
              </g>
            </svg>
          )}
          {projection.continuation?.hasMore ? (
            <p className="graph-surface__warning absolute bottom-3 left-3 rounded-full border px-3 py-1.5 text-xs" role="status">
              Partial field · more objects are available
            </p>
          ) : null}
        </div>

        <aside className="graph-surface__aside border-t p-5 lg:border-l lg:border-t-0" aria-label="Graph inspector">
          {selected ? (
            <div data-slot="graph-inspector" data-selection-hidden={hiddenSelection || undefined}>
              <p className="research-kicker">{selected.kind}</p>
              <h3 ref={inspectorHeadingRef} tabIndex={-1} className="research-display mt-2 text-2xl font-semibold leading-tight">{selected.title}</h3>
              {conversationMode && selected.kind === "turn" ? (
                showExactTurnContent ? (
                  exactTurnContent ? (
                    <div data-slot="conversation-turn-detail">
                      <MarkdownRenderer
                        content={exactTurnContent}
                        images="omit"
                        className="graph-surface__muted mt-3 max-h-80 overflow-auto text-sm leading-6"
                      />
                    </div>
                  ) : (
                    <p className="graph-surface__warning mt-3 rounded-xl border px-3 py-2 text-sm leading-6">Exact turn content is unavailable in this bounded snapshot.</p>
                  )
                ) : (
                  <p className="graph-surface__muted mt-3 text-sm leading-6">Zoom to Detail or Exact to inspect this immutable turn.</p>
                )
              ) : (
                <p className="graph-surface__muted mt-3 text-sm leading-6">{selected.summary || "No summary is included in this bounded projection."}</p>
              )}
              {hiddenSelection ? (
                <p className="graph-surface__warning mt-3 rounded-xl border px-3 py-2 text-xs">
                  This selection is retained but hidden by the current filter.
                </p>
              ) : null}
              <dl className="mt-5 space-y-3 text-xs">
                <div><dt className="graph-surface__muted font-semibold uppercase tracking-[0.12em]">Identity</dt><dd className="mt-1 break-all font-mono">{selected.ref || selected.id}</dd></div>
                <div><dt className="graph-surface__muted font-semibold uppercase tracking-[0.12em]">Source provenance</dt><dd className="mt-1 break-words">{provenanceText(selected)}</dd></div>
                <div><dt className="graph-surface__muted font-semibold uppercase tracking-[0.12em]">Projector</dt><dd className="mt-1 break-words">{projectorInspectorText(selected)}</dd></div>
                {selected.projection.revision.id ? <div><dt className="graph-surface__muted font-semibold uppercase tracking-[0.12em]">Revision</dt><dd className="mt-1 break-all font-mono">{selected.projection.revision.id}</dd></div> : null}
              </dl>
              {selected.projector?.diagnostic === "projector_unavailable" ? (
                <p className="graph-surface__warning mt-4 rounded-xl border px-3 py-2 text-xs leading-5">
                  No registered code-owned projector handles this object kind. Exact identity and authorized source provenance remain available.
                </p>
              ) : null}
              {conversationMode && selectedRelations.length > 0 ? (
                <section className="graph-surface__panel mt-5 rounded-2xl border p-4" aria-labelledby="conversation-lineage-title">
                  <h4 id="conversation-lineage-title" className="graph-surface__muted text-xs font-semibold uppercase tracking-[0.14em]">Conversation lineage</h4>
                  <ul className="mt-3 space-y-2 text-xs">
                    {selectedRelations.map((edge) => {
                      const outgoing = edge.from === selected.id
                      const other = scaledProjection.nodes.find((node) => node.id === (outgoing ? edge.to : edge.from))
                      return (
                        <li key={edge.id} className="flex items-start gap-2">
                          <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: edgeVisual(edge).color }} aria-hidden="true" />
                          <span><strong>{outgoing ? edge.relation : `from ${edge.relation}`}</strong> {other?.title || "bounded object"}</span>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              ) : null}
              {conversationMode && selected.kind === "turn" && selected.ref && conversationFork ? (
                <div className="mt-5">
                  <button
                    type="button"
                    disabled={!exactTurnContent || Boolean(conversationFork.disabledReason)}
                    aria-describedby="conversation-fork-availability"
                    onClick={(event) => conversationFork.onOpen(
                      selected.ref as string,
                      selected.title,
                      event.currentTarget,
                    )}
                    className="graph-surface__focus inline-flex min-h-11 items-center gap-2 rounded-full border border-[hsl(var(--field-cool-strong))] px-4 py-2 text-sm font-semibold text-[hsl(var(--field-cool-strong))] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <GitBranch className="h-4 w-4" aria-hidden="true" /> Fork from this turn
                  </button>
                  <p id="conversation-fork-availability" className="graph-surface__muted mt-2 text-xs leading-5">
                    {!exactTurnContent
                      ? "Forking requires this exact turn's loaded content."
                      : conversationFork.disabledReason ?? "Creates one durable conversation branch from this exact immutable turn."}
                  </p>
                </div>
              ) : null}
              {showConversationJoin && conversationJoin && selectedJoinTip ? (
                <fieldset className="graph-surface__panel mt-5 rounded-2xl border p-4">
                  <legend className="research-display px-1 text-base font-semibold">Join conversation tips</legend>
                  <p id="conversation-join-help" className="graph-surface__muted mt-1 text-xs leading-5">
                    Keep this selected tip and explicitly choose one to seven other branch tips. Nothing is selected automatically.
                  </p>
                  <label className="mt-3 flex min-h-11 items-center gap-3 text-sm font-medium">
                    <input type="checkbox" checked disabled aria-label={`Selected tip: ${selectedJoinTip.title}, exact reference ${selectedJoinTip.reference}`} />
                    <span className="min-w-0">
                      <span className="block">{selectedJoinTip.title} <span className="graph-surface__muted">(selected tip)</span></span>
                      <code className="graph-surface__muted block truncate text-[0.68rem] font-normal">{selectedJoinTip.reference}</code>
                    </span>
                  </label>
                  <div className="mt-1 space-y-1">
                    {availableJoinTips.map((candidate) => {
                      const checked = additionalJoinTipReferences.includes(candidate.reference)
                      return (
                        <label key={candidate.reference} className="flex min-h-11 items-center gap-3 text-sm">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!checked && joinSelectionIsFull}
                            aria-label={`Include tip: ${candidate.title}, exact reference ${candidate.reference}`}
                            onChange={(event) => toggleAdditionalJoinTip(candidate.reference, event.currentTarget.checked)}
                          />
                          <span className="min-w-0">
                            <span className="block">{candidate.title}</span>
                            <code className="graph-surface__muted block truncate text-[0.68rem]">{candidate.reference}</code>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                  <button
                    type="button"
                    disabled={selectedJoinTipCount < 2 || Boolean(conversationJoin.disabledReason)}
                    aria-describedby="conversation-join-help conversation-join-status"
                    onClick={(event) => conversationJoin.onOpen(
                      [selectedJoinTip.reference, ...selectedAdditionalJoinTips.map((candidate) => candidate.reference)],
                      [selectedJoinTip.title, ...selectedAdditionalJoinTips.map((candidate) => candidate.title)],
                      event.currentTarget,
                    )}
                    className="graph-surface__focus mt-3 inline-flex min-h-11 items-center gap-2 rounded-full border border-[hsl(var(--field-warm))] px-4 py-2 text-sm font-semibold text-[hsl(var(--field-ink))] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <GitMerge className="h-4 w-4" aria-hidden="true" /> Join selected tips
                  </button>
                  <p id="conversation-join-status" className="graph-surface__muted mt-2 text-xs leading-5" role="status" aria-live="polite">
                    {conversationJoin.disabledReason
                      ?? (selectedJoinTipCount < 2
                        ? "Select at least one other eligible tip to continue."
                        : `${selectedJoinTipCount} of 8 tips selected.`)}
                  </p>
                </fieldset>
              ) : null}
              {conversationMode && selected.kind === "chat" && selected.ref
                && conversationExport?.conversationReference === selected.ref ? (
                <div className="mt-5">
                  <button
                    type="button"
                    disabled={Boolean(conversationExport.disabledReason) || conversationExport.state === "downloading"}
                    aria-describedby="conversation-export-availability"
                    onClick={conversationExport.onDownload}
                    className="graph-surface__focus inline-flex min-h-11 items-center gap-2 rounded-full border border-[hsl(var(--field-core))] px-4 py-2 text-sm font-semibold text-[hsl(var(--field-core))] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Download className="h-4 w-4" aria-hidden="true" />
                    {conversationExport.state === "downloading" ? "Preparing exact Markdown…" : "Download exact Markdown"}
                  </button>
                  <p id="conversation-export-availability" className="graph-surface__muted mt-2 text-xs leading-5" role="status" aria-live="polite">
                    {conversationExport.message
                      ?? conversationExport.disabledReason
                      ?? "Exports this immutable conversation revision. System and tool bodies, artifacts, provenance, runs, logs, and live state remain excluded."}
                  </p>
                </div>
              ) : null}
              {proofOverlayLabels(selected).length ? (
                <ul className="mt-5 flex flex-wrap gap-2" aria-label="Read-only state overlays">
                  {proofOverlayLabels(selected).map((label) => (
                    <li key={label} className="graph-surface__badge rounded-full border px-2.5 py-1 text-[11px]">
                      {label}
                    </li>
                  ))}
                </ul>
              ) : null}
              {selected.kind === "proof.node" ? (
                <div className="mt-5 space-y-4">
                  <section className="graph-surface__coordination rounded-2xl border p-4" aria-labelledby="ham-coordination-title">
                    <h4 id="ham-coordination-title" className="graph-surface__cool text-xs font-semibold uppercase tracking-[0.14em]">HAM coordination</h4>
                    <p className="graph-surface__muted mt-3 text-xs leading-5">Agents claim this work through HAM. This graph is a read-only coordination view.</p>
                    {linkedHamTask ? (
                      <div className="graph-surface__panel mt-4 rounded-xl border p-3" data-slot="linked-ham-task">
                        <p className="font-semibold">{linkedHamTask.task.title}</p>
                        <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-1">
                          <div><dt className="graph-surface__muted font-semibold">Primary linked HAM task ID</dt><dd className="break-all font-mono">{linkedHamTask.task.id}</dd></div>
                          <div><dt className="graph-surface__muted font-semibold">Linked HAM task count</dt><dd>{selected.overlays.proof?.nodeState?.linkedTaskCount ?? 1}</dd></div>
                          <div><dt className="graph-surface__muted font-semibold">State</dt><dd>{linkedHamTask.task.state}</dd></div>
                          <div><dt className="graph-surface__muted font-semibold">Stage</dt><dd>{linkedHamTask.task.stage}</dd></div>
                          <div><dt className="graph-surface__muted font-semibold">Owner</dt><dd>{linkedHamTask.task.owner?.label || "Unclaimed"}</dd></div>
                          <div><dt className="graph-surface__muted font-semibold">Active run</dt><dd className="break-all">{activeRunText(linkedHamTask.task)}</dd></div>
                          <div><dt className="graph-surface__muted font-semibold">Version</dt><dd>{linkedHamTask.task.version ? `v${linkedHamTask.task.version}` : "Unavailable"}</dd></div>
                        </dl>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => selectNode(linkedHamTask.node)}
                            className="graph-surface__control min-h-11 rounded-full border px-3 py-1.5 text-xs font-semibold focus-visible:outline-none"
                          >
                            Select linked HAM task
                          </button>
                          {linkedTaskConstructorHref ? (
                            <a
                              href={linkedTaskConstructorHref}
                              className="graph-surface__focus inline-flex min-h-11 items-center gap-1.5 rounded-full bg-[hsl(var(--field-cool-strong))] px-3 py-1.5 text-xs font-semibold text-[hsl(var(--field-surface))] focus-visible:outline-none"
                            >
                              Open Task Constructor <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                            </a>
                          ) : null}
                        </div>
                      </div>
                    ) : (
                      <p className="graph-surface__panel graph-surface__muted mt-4 rounded-xl border px-3 py-2 text-xs">Linked HAM task not loaded.</p>
                    )}
                  </section>
                  <section className="graph-surface__verification rounded-2xl border p-4" aria-labelledby="lean-verification-title">
                    <h4 id="lean-verification-title" className="graph-surface__core text-xs font-semibold uppercase tracking-[0.14em]">Lean verification</h4>
                    <p className="mt-2 text-sm font-semibold">
                      {selected.overlays.proof?.nodeState?.verification
                        ? `Verified independently by ${selected.overlays.proof.nodeState.verification.method}`
                        : `Proof status: ${selected.overlays.proof?.nodeState?.proofStatus || "open"}`}
                    </p>
                    <p className="graph-surface__muted mt-2 text-xs leading-5">HAM task completion does not verify this Lean proof.</p>
                  </section>
                </div>
              ) : null}
              {exactGenerousSurfaceDestination ? (
                <a
                  href={exactGenerousSurfaceDestination}
                  className="graph-surface__focus mt-6 inline-flex min-h-11 items-center gap-2 rounded-full bg-[hsl(var(--field-ink))] px-4 py-2 text-sm font-semibold text-[hsl(var(--field-surface))] focus-visible:outline-none"
                >
                  Open exact Generous surface <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                </a>
              ) : selected.kind === "surface" ? (
                <p className="graph-surface__warning mt-6 rounded-xl border px-3 py-2 text-xs" role="status">
                  This surface does not expose a valid exact Generous viewer destination.
                </p>
              ) : selected.ref ? (
                <a
                  href={hrefForReference(selected.ref)}
                  onClick={(event) => {
                    if (!onOpenReference) return
                    event.preventDefault()
                    openSelected(selected.ref as string)
                  }}
                  className="graph-surface__focus mt-6 inline-flex min-h-11 items-center gap-2 rounded-full bg-[hsl(var(--field-ink))] px-4 py-2 text-sm font-semibold text-[hsl(var(--field-surface))] focus-visible:outline-none"
                >
                  {typeof openReferenceLabel === "function" ? openReferenceLabel(selected) : openReferenceLabel} <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                </a>
              ) : null}
            </div>
          ) : (
            <div className="graph-surface__muted flex h-full flex-col items-center justify-center text-center">
              <CircleDot className="h-8 w-8" aria-hidden="true" />
              <h3 className="research-display mt-3 text-xl font-semibold text-[hsl(var(--field-ink))]">Select an object</h3>
              <p className="mt-2 text-sm">Inspect identity, provenance, revision, and read-only overlays.</p>
            </div>
          )}
          <div className="mt-8 border-t border-[hsl(var(--field-border))] pt-4">
            <p className="flex items-center gap-2 text-xs font-semibold"><ShieldCheck className="h-4 w-4" aria-hidden="true" /> Projection, not authority</p>
            <p className="graph-surface__muted mt-2 text-xs leading-5">This view cannot grant execution, verification, publication, or claim authority.</p>
          </div>
        </aside>
      </div>

      <footer className="graph-surface__footer graph-surface__muted flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3 text-xs">
        <span className="inline-flex items-center gap-2"><Layers3 className="h-4 w-4" aria-hidden="true" /> {providerStatusText(projection)}</span>
        <span className="inline-flex items-center gap-2"><GitBranch className="h-4 w-4" aria-hidden="true" /> Trust classes remain distinct</span>
      </footer>
      <p className="sr-only" role="status" aria-live="polite">{selected ? `Selected ${selected.title}` : `${visibleNodes.length} graph objects visible`}</p>
    </section>
  )
}

function AccessibleGraphList({
  nodes,
  edges,
  selected,
  onSelect,
}: {
  nodes: UnifiedGraphNode[]
  edges: UnifiedGraphEdge[]
  selected: UnifiedGraphNode | null
  onSelect: (node: UnifiedGraphNode) => void
}) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return (
    <div className="h-full overflow-auto p-5" data-slot="graph-accessible-list">
      <ul className="grid gap-2 sm:grid-cols-2" aria-label="Visible graph objects">
        {nodes.map((node) => (
          <li key={node.id}>
            <button
              type="button"
              aria-pressed={selected?.id === node.id}
              onClick={() => onSelect(node)}
              className={cn(
                "graph-surface__card w-full rounded-2xl border p-4 text-left focus-visible:outline-none",
                selected?.id === node.id ? "shadow-[0_0_0_2px_hsl(var(--field-core)/.18)]" : "",
              )}
            >
              <span className="graph-surface__muted text-[10px] font-semibold uppercase tracking-[0.16em]">{node.kind}</span>
              <span className="research-display mt-1 block text-lg font-semibold">{node.title}</span>
              {node.summary ? <span className="graph-surface__muted mt-1 line-clamp-2 block text-xs leading-5">{node.summary}</span> : null}
              {projectorAvailabilityText(node) ? (
                <span className="graph-surface__warning mt-3 block rounded-lg border px-2.5 py-1.5 text-xs font-semibold">
                  Projector unavailable
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      <details className="graph-surface__panel mt-5 rounded-2xl border p-4">
        <summary className="graph-surface__focus cursor-pointer rounded-sm font-semibold">Readable relation summary ({edges.length})</summary>
        <ul className="mt-3 space-y-2 text-sm">
          {edges.map((edge) => (
            <li key={edge.id}>
              <span className="font-medium">{byId.get(edge.from)?.title || edge.from}</span>
              {" "}<span className="graph-surface__muted">{edge.relation}</span>{" "}
              <span className="font-medium">{byId.get(edge.to)?.title || edge.to}</span>
              <span className="graph-surface__muted ml-2 text-[10px] uppercase tracking-wide">{edge.trust}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}
