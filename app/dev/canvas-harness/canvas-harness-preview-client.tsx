"use client"

import {
  asClientId,
  asEdgeId,
  asNodeId,
  createCanvasStore,
  type CanvasStore,
  type Edge,
  type FrameStats,
  type Node,
  type NodeId,
  type Renderer,
} from "@canvas-harness/core"
import {
  Canvas,
  CanvasProvider,
  Minimap,
  useCamera,
  useCanvasStore,
  useSelection,
} from "@canvas-harness/react"
import { BookOpen, Gauge, Grid3X3, Minus, Plus, RotateCcw } from "lucide-react"
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react"

import { Button } from "@/components/ui/button"
import { GalaxyCanvasNodeView } from "@/components/canvas/galaxy-canvas-node"
import { projectGalaxyCanvas, type GalaxyCanvasNodeData, type GalaxyCanvasRelationData } from "@/lib/canvas/galaxy-canvas-adapter"
import { canvasHarnessPreviewProjection } from "@/lib/canvas/galaxy-canvas-fixtures"
import { GALAXY_CANVAS_NODE_DEFINITIONS } from "@/lib/canvas/galaxy-canvas-node-types"
import { asReadOnlyCanvasStore } from "@/lib/canvas/read-only-canvas-store"

type FixtureMode = "research" | "density"

type RuntimeMetrics = {
  projectionMs: number
  ingestionMs: number
}

type RuntimeState = {
  store: CanvasStore
  metrics: RuntimeMetrics
}

function restoreRequestedSelection(store: CanvasStore) {
  const parameters = new URLSearchParams(window.location.search)
  const requestedPlacement = parameters.get("placement")
  const requestedReference = parameters.get("ref")
  const selected = store.getAllNodes().find((node) => {
    const data = node.data as Partial<GalaxyCanvasNodeData> | undefined
    if (data?.schemaId !== "gb.canvas.node.v1") return false
    if (requestedPlacement) return data.placementId === requestedPlacement
    return Boolean(requestedReference && data.subjectRef === requestedReference)
  })
  if (selected) store.setSelection([selected.id])
}

function createResearchRuntime(): RuntimeState {
  const projectionStart = performance.now()
  const projection = projectGalaxyCanvas(canvasHarnessPreviewProjection)
  const projectionMs = performance.now() - projectionStart
  const store = createCanvasStore({
    clientId: asClientId("galaxy-phase0-research"),
    nodeTypes: [...GALAXY_CANVAS_NODE_DEFINITIONS],
  })
  const ingestionStart = performance.now()
  store.batch(() => {
    for (const node of projection.nodes) store.addNode(node)
    for (const edge of projection.edges) store.addEdge(edge)
  })
  store.setCamera({ x: -120, y: -90, z: 0.72 })
  restoreRequestedSelection(store)
  return {
    store: asReadOnlyCanvasStore(store),
    metrics: { projectionMs, ingestionMs: performance.now() - ingestionStart },
  }
}

function createDensityRuntime(): RuntimeState {
  const projectionStart = performance.now()
  const nodes: Node[] = []
  const edges: Edge[] = []
  const columns = 50
  const count = 2_000
  for (let index = 0; index < count; index += 1) {
    const column = index % columns
    const row = Math.floor(index / columns)
    const id = asNodeId(`density:${index}`)
    nodes.push({
      id,
      type: "rect",
      x: column * 92,
      y: row * 68,
      w: 72,
      h: 48,
      angle: 0,
      z: index,
      groups: [],
      locked: true,
      style: {
        backgroundColor: index % 7 === 0 ? "#d6e6dc" : "#eef2ed",
        strokeColor: "#769184",
        strokeWidth: 1,
        autoFit: false,
      },
    })
    if (index > 0) {
      const previous = index - 1
      edges.push({
        id: asEdgeId(`density-edge:${index}`),
        source: { nodeId: asNodeId(`density:${previous}`), localOffset: { x: 36, y: 24 } },
        target: { nodeId: id, localOffset: { x: 36, y: 24 } },
        pathStyle: "straight",
        z: -1,
        groups: [],
        locked: true,
        style: { strokeColor: "#9aaca2", strokeWidth: 1 },
      })
    }
  }
  const projectionMs = performance.now() - projectionStart
  const store = createCanvasStore({
    clientId: asClientId("galaxy-phase0-density"),
    nodeTypes: [...GALAXY_CANVAS_NODE_DEFINITIONS],
  })
  const ingestionStart = performance.now()
  store.batch(() => {
    for (const node of nodes) store.addNode(node)
    for (const edge of edges) store.addEdge(edge)
  })
  store.setCamera({ x: -180, y: -120, z: 0.22 })
  return {
    store: asReadOnlyCanvasStore(store),
    metrics: { projectionMs, ingestionMs: performance.now() - ingestionStart },
  }
}

function SelectionInspector() {
  const selection = useSelection()
  const [selectedId] = selection

  return <SelectionInspectorContent selectedId={selectedId} />
}

function SelectionInspectorContent({ selectedId }: { selectedId?: Node["id"] | Edge["id"] }) {
  const store = useCanvasStore()
  const node = selectedId ? store.getNode(selectedId as Node["id"]) : undefined
  const edge = selectedId && !node ? store.getEdge(selectedId as Edge["id"]) : undefined
  const nodeData = node?.data as GalaxyCanvasNodeData | undefined
  const edgeData = edge?.data as GalaxyCanvasRelationData | undefined

  useEffect(() => {
    const url = new URL(window.location.href)
    if (nodeData?.schemaId === "gb.canvas.node.v1") {
      url.searchParams.set("placement", nodeData.placementId)
      url.searchParams.set("ref", nodeData.subjectRef)
    } else {
      url.searchParams.delete("placement")
      url.searchParams.delete("ref")
    }
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`)
  }, [nodeData?.placementId, nodeData?.schemaId, nodeData?.subjectRef])

  if (nodeData?.schemaId === "gb.canvas.node.v1") {
    return (
      <aside className="border-t border-[#315f49]/20 bg-[#fbfaf5] p-4 lg:border-l lg:border-t-0" aria-live="polite">
        <p className="research-kicker">Selected placement</p>
        <h2 className="research-display mt-2 text-xl font-semibold text-[#18372b]">{nodeData.display.title}</h2>
        <p className="mt-2 break-all font-mono text-[11px] text-[#61766b]">{nodeData.subjectRef}</p>
        <dl className="mt-4 space-y-2 text-sm text-[#3d554a]">
          <div><dt className="font-semibold">Placement</dt><dd>{nodeData.placementId}</dd></div>
          <div><dt className="font-semibold">Type</dt><dd>{node?.type}</dd></div>
          <div><dt className="font-semibold">Revision</dt><dd>{nodeData.display.revision || "latest"}</dd></div>
          <div><dt className="font-semibold">Provenance</dt><dd>{nodeData.display.provenance || "Synthetic Phase 0 fixture"}</dd></div>
        </dl>
        {nodeData.display.href ? (
          <Button asChild className="mt-5 w-full bg-[#315f49] text-white hover:bg-[#284e3c]">
            <a href={nodeData.display.href}>Open existing view</a>
          </Button>
        ) : null}
      </aside>
    )
  }

  if (edgeData?.schemaId === "gb.canvas.relation.v1") {
    return (
      <aside className="border-t border-[#315f49]/20 bg-[#fbfaf5] p-4 lg:border-l lg:border-t-0" aria-live="polite">
        <p className="research-kicker">Selected relation</p>
        <h2 className="research-display mt-2 text-xl font-semibold text-[#18372b]">{edge?.content || "Relation"}</h2>
        <dl className="mt-4 space-y-2 text-sm text-[#3d554a]">
          <div><dt className="font-semibold">Trust class</dt><dd>{edgeData.trustClass}</dd></div>
          <div><dt className="font-semibold">Owner</dt><dd>{edgeData.owner}</dd></div>
          <div><dt className="font-semibold">Provenance</dt><dd>{edgeData.provenance || "Not supplied"}</dd></div>
        </dl>
      </aside>
    )
  }

  return (
    <aside className="border-t border-[#315f49]/20 bg-[#fbfaf5] p-4 lg:border-l lg:border-t-0">
      <p className="research-kicker">Canvas context</p>
      <h2 className="research-display mt-2 text-xl font-semibold text-[#18372b]">Select a placement</h2>
      <p className="mt-3 text-sm leading-6 text-[#61766b]">
        Selection changes only local canvas context. Canonical resource content and authorization remain outside the renderer.
      </p>
    </aside>
  )
}

function Diagnostics({ renderer, metrics }: { renderer: Renderer | null; metrics: RuntimeMetrics }) {
  const camera = useCamera()
  const selection = useSelection()
  const store = useCanvasStore()
  const [frameStats, setFrameStats] = useState<FrameStats>({ lastMs: 0, avgMs: 0, frames: 0, fps: 0 })
  const [drawCount, setDrawCount] = useState(0)
  const [overlayCount, setOverlayCount] = useState(0)

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!renderer) return
      setFrameStats(renderer.stats())
      setDrawCount(renderer.lastDrawCount())
      setOverlayCount(renderer.getOverlaySet().length)
    }, 500)
    return () => window.clearInterval(timer)
  }, [renderer])

  return (
    <div className="pointer-events-none absolute left-3 top-3 z-20 rounded-xl border border-white/80 bg-[#fffef9]/95 px-3 py-2 font-mono text-[11px] leading-5 text-[#315f49] shadow-sm backdrop-blur">
      <p className="flex items-center gap-1 font-semibold"><Gauge className="h-3.5 w-3.5" /> Phase 0 diagnostics</p>
      <p>{store.getNodeCount()} nodes · {store.getEdgeCount()} edges · {overlayCount} live DOM</p>
      <p>{frameStats.fps} fps · {frameStats.avgMs.toFixed(2)} ms avg · {drawCount} drawn</p>
      <p>zoom {camera.z.toFixed(2)} · selected {selection.length}</p>
      <p>project {metrics.projectionMs.toFixed(2)} ms · ingest {metrics.ingestionMs.toFixed(2)} ms</p>
    </div>
  )
}

function CanvasWorkspace({ mode }: { mode: FixtureMode }) {
  const runtime = useMemo(() => mode === "research" ? createResearchRuntime() : createDensityRuntime(), [mode])
  const [renderer, setRenderer] = useState<Renderer | null>(null)
  const renderCustomNode = useCallback((id: NodeId) => <GalaxyCanvasNodeView id={id} />, [])

  const changeZoom = useCallback((delta: number) => {
    const camera = runtime.store.getCamera()
    runtime.store.setCamera({ z: Math.max(0.08, Math.min(4, camera.z + delta)) })
  }, [runtime.store])

  const resetCamera = useCallback(() => {
    runtime.store.setCamera(mode === "research"
      ? { x: -120, y: -90, z: 0.72 }
      : { x: -180, y: -120, z: 0.22 })
  }, [mode, runtime.store])

  const blockMutationKeys = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const command = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (event.key === "Delete" || event.key === "Backspace" || (command && ["v", "x", "z", "y"].includes(key))) {
      event.preventDefault()
      event.stopPropagation()
    }
  }, [])

  const blockFileDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
  }, [])

  return (
    <CanvasProvider store={runtime.store}>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div
          className="relative min-h-[680px] overflow-hidden bg-[#eef2ed]"
          onDragOverCapture={blockFileDrop}
          onDropCapture={blockFileDrop}
          onKeyDownCapture={blockMutationKeys}
        >
          <Canvas
            tool="select"
            background={{ color: "#eef2ed", pattern: "dots", gap: 24, patternColor: "#9db0a6" }}
            selectionColor="#b06f2f"
            maxDpr={1.5}
            onRenderer={setRenderer}
            renderCustomNodeView={renderCustomNode}
          />
          <Diagnostics renderer={renderer} metrics={runtime.metrics} />
          <div className="absolute bottom-4 left-4 z-20 flex gap-1 rounded-xl border border-white/80 bg-[#fffef9]/95 p-1 shadow-sm">
            <Button type="button" variant="ghost" size="icon" aria-label="Zoom out" onClick={() => changeZoom(-0.15)}><Minus /></Button>
            <Button type="button" variant="ghost" size="icon" aria-label="Reset camera" onClick={resetCamera}><RotateCcw /></Button>
            <Button type="button" variant="ghost" size="icon" aria-label="Zoom in" onClick={() => changeZoom(0.15)}><Plus /></Button>
          </div>
          <Minimap
            width={190}
            height={130}
            position="bottom-right"
            viewportColor="#b06f2f"
            backgroundColor="#fffef9"
            borderColor="#b9c7bf"
          />
        </div>
        <SelectionInspector />
      </div>
    </CanvasProvider>
  )
}

export function CanvasHarnessPreviewClient() {
  const [mode, setMode] = useState<FixtureMode>("research")

  return (
    <main className="research-workbench flex min-h-screen flex-col bg-[#dfe9e0] px-3 py-4 sm:px-5">
      <header className="mx-auto mb-3 flex w-full max-w-[1800px] flex-wrap items-end justify-between gap-4 rounded-2xl border border-[#315f49]/20 bg-[#fffef9]/90 px-5 py-4 shadow-sm">
        <div className="max-w-3xl">
          <p className="research-kicker">Development-only compatibility spike</p>
          <h1 className="research-display mt-1 text-3xl font-semibold text-[#18372b]">Galaxy atlas on canvas-harness</h1>
          <p className="mt-2 text-sm leading-6 text-[#61766b]">
            Authorized synthetic projections only. Placements are read-only; camera and selection remain local.
          </p>
        </div>
        <div className="flex rounded-xl border border-[#315f49]/20 bg-[#eef2ed] p-1" aria-label="Performance fixture">
          <Button type="button" variant={mode === "research" ? "default" : "ghost"} size="sm" onClick={() => setMode("research")}>
            <BookOpen className="h-4 w-4" /> Research fixture
          </Button>
          <Button type="button" variant={mode === "density" ? "default" : "ghost"} size="sm" onClick={() => setMode("density")}>
            <Grid3X3 className="h-4 w-4" /> Primitive density
          </Button>
        </div>
      </header>
      <section className="mx-auto flex min-h-[760px] w-full max-w-[1800px] flex-1 overflow-hidden rounded-2xl border border-[#315f49]/20 bg-white shadow-sm">
        <CanvasWorkspace key={mode} mode={mode} />
      </section>
    </main>
  )
}
