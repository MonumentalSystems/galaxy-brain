"use client"

import { useMemo, useRef, useState } from "react"
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  Handle,
  useStore,
  type Edge,
  type EdgeTypes,
  type Node,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from "reactflow"
import "reactflow/dist/style.css"
import { Check, CircleDot, Clock3, Focus, GitBranch, LockKeyhole, Orbit, Play, ShieldCheck, TriangleAlert, UserRound, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { forceLayoutProofGraph, proofCampaignNodeId, proofGraphNodeId } from "@/lib/proof-force-layout"
import { projectProofTaskGraph, type ProofDag, type ProofTaskGraphNode, type ProofVerification, type ProofWorkState } from "@/lib/proof-task-graph"
import { cn } from "@/lib/utils"

type Graph = {
  programId: string
  nodes: ProofTaskGraphNode[]
  edges: Array<{ id: string; source: string; target: string; relationType?: string }>
}

export type ProofGraphBinding = { proofDag: ProofDag; workState: ProofWorkState }

type NodeData = ProofTaskGraphNode & { programId: string; programTone: string }
type CampaignData = { programId: string; packetCount: number; availableCount: number; programTone: string }

const PROOF_VERIFICATION_METHOD_LABELS: Record<ProofVerification["method"], string> = {
  "hyades-run": "Hyades",
  "lean-replay": "Lean replay",
  "signed-report": "proofs.blah.dev signed",
}

const programTones = ["#4a78c2", "#e2c84f", "#58bda8", "#df7bb2", "#e58f43", "#71bd79"]

const stateMeta: Record<string, { label: string; tone: string; icon: typeof CircleDot }> = {
  reference: { label: "Reference", tone: "#4f7163", icon: Orbit },
  available: { label: "Available", tone: "#2f7455", icon: CircleDot },
  pending: { label: "Published", tone: "#9a6c35", icon: Clock3 },
  claimed: { label: "Claimed", tone: "#65558f", icon: UserRound },
  running: { label: "Running", tone: "#267769", icon: Play },
  attested: { label: "Attested", tone: "#5574a3", icon: CircleDot },
  completed: { label: "Lean verified", tone: "#3d6d48", icon: Check },
  overridden: { label: "Owner override", tone: "#9a6c35", icon: TriangleAlert },
  blocked: { label: "Task blocked", tone: "#9a5d45", icon: TriangleAlert },
  needs_clarification: { label: "Needs clarification", tone: "#9a5d45", icon: TriangleAlert },
  stalled: { label: "Task stalled", tone: "#9a5d45", icon: TriangleAlert },
  failed: { label: "Task failed", tone: "#a2493d", icon: TriangleAlert },
  cancelled: { label: "Task cancelled", tone: "#727b74", icon: TriangleAlert },
  waiting: { label: "Prerequisites", tone: "#718178", icon: LockKeyhole },
}

function zoomTier(zoom: number) {
  if (zoom < 0.32) return "universe"
  if (zoom < 0.56) return "field"
  if (zoom < 0.92) return "packet"
  return "detail"
}

function ProofNode({ data, selected }: NodeProps<NodeData>) {
  const zoom = useStore((state) => state.transform[2])
  const tier = zoomTier(zoom)
  const meta = stateMeta[data.state] || stateMeta.waiting
  const Icon = meta.icon
  const owner = data.workItem?.work.claim?.nostrPubkey

  if (tier === "universe") {
    return (
      <article
        data-slot="proof-task-node"
        data-state={data.state}
        data-zoom-tier={tier}
        data-selected={selected ? "true" : "false"}
        className="grid h-6 w-6 place-items-center rounded-full border-2 border-[#eff6ec] shadow-sm"
        style={{ backgroundColor: data.programTone }}
        aria-label={`${data.title}. ${meta.label}. ${data.coordinationLabel}`}
      >
        <span className="sr-only">{data.title}</span>
        <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-[#577766]" />
        <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-[#577766]" />
      </article>
    )
  }

  return (
    <article
      data-slot="proof-task-node"
      data-state={data.state}
      data-zoom-tier={tier}
      data-selected={selected ? "true" : "false"}
      className={cn(
        "w-72 overflow-hidden rounded-[1.4rem] border bg-[#fbfaf2]/95 text-[#203229] shadow-[0_22px_55px_-34px_rgba(18,46,34,0.85)] transition",
        selected ? "border-[#d5a54c] ring-4 ring-[#d5a54c]/20" : "border-[#416b58]/35",
        tier === "field" && "w-44 rounded-full",
      )}
      style={{ borderLeftColor: meta.tone, borderLeftWidth: 6 }}
      aria-label={`${data.title}. ${meta.label}. ${data.coordinationLabel}`}
    >
      <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border-2 !border-[#f7f3e7] !bg-[#416b58]" />
      <div className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white" style={{ backgroundColor: meta.tone }}>
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="research-smallcaps block text-[10px] text-[#557064]">{meta.label}</span>
            <span className="research-display block truncate text-base font-semibold">{data.title}</span>
          </span>
        </div>
        {tier !== "field" ? (
          <p className="mt-2 line-clamp-2 text-xs leading-5 text-[#5c6a62]">{data.objective}</p>
        ) : null}
        {tier === "detail" ? (
          <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] text-[#526158]">
            <span className="rounded-full bg-[#e0ebe2] px-2 py-0.5">{data.packetId}</span>
            {data.theoremTargets.length ? <span className="rounded-full bg-[#e8e5cf] px-2 py-0.5">{data.theoremTargets.length} targets</span> : null}
            {owner ? <span className="rounded-full bg-[#e8dff0] px-2 py-0.5" title={owner}>{owner.slice(0, 10)}…</span> : null}
            {(data.workItem?.work.linkedTaskCount || 0) > 1 ? <span className="rounded-full bg-[#f3dcd5] px-2 py-0.5">{data.workItem?.work.linkedTaskCount} linked tasks</span> : null}
          </div>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} className="!h-3 !w-3 !border-2 !border-[#f7f3e7] !bg-[#416b58]" />
    </article>
  )
}

function CampaignNode({ data }: NodeProps<CampaignData>) {
  const zoom = useStore((state) => state.transform[2])
  const outer = zoom < 0.25
  return (
    <article
      data-slot="proof-campaign-node"
      className={cn(
        "pointer-events-none rounded-full border border-[#6fa884]/45 bg-[#17392f]/90 px-5 py-3 text-[#f6f3e8] shadow-[0_24px_80px_-36px_rgba(6,27,21,0.9)]",
        outer ? "min-w-72" : "min-w-52 bg-[#f8f5eb]/95 text-[#203229]",
      )}
      style={{ transform: outer ? "scale(3)" : undefined, transformOrigin: "center", borderColor: data.programTone }}
      aria-label={`${data.programId}, ${data.packetCount} proof packets`}
    >
      <p className="research-smallcaps text-[10px] opacity-70">Campaign constellation</p>
      <p className="research-display mt-1 text-xl font-semibold">{data.programId}</p>
      <p className="mt-1 text-xs opacity-70">{data.packetCount} packets · {data.availableCount} available</p>
    </article>
  )
}

const proofNodeTypes: NodeTypes = { proofTask: ProofNode, proofCampaign: CampaignNode }
const proofEdgeTypes: EdgeTypes = {}

function campaignOffset(index: number) {
  if (index === 0) return { x: 0, y: 0 }
  const slot = (index - 1) % 8
  const ring = Math.floor((index - 1) / 8) + 1
  const angle = (slot / 8) * Math.PI * 2
  // Keep neighbouring constellations outside the focused campaign aperture while
  // still allowing an ordinary zoom-out to reveal the wider proof field.
  return { x: Math.cos(angle) * 2_800 * ring, y: Math.sin(angle) * 2_000 * ring }
}

function flowNodes(graph: Graph, graphIndex: number): Node<NodeData | CampaignData>[] {
  const offset = campaignOffset(graphIndex)
  const programTone = programTones[graphIndex % programTones.length]
  const positions = forceLayoutProofGraph(
    graph.nodes.map((node) => ({ id: node.packetId, layer: node.layer })),
    graph.edges,
    { seed: graphIndex + 1 },
  )
  const packetNodes = graph.nodes.map((node) => ({
    id: proofGraphNodeId(graph.programId, node.packetId),
    type: "proofTask",
    position: {
      x: offset.x + (positions[node.packetId]?.x || 0),
      y: offset.y + (positions[node.packetId]?.y || 0),
    },
    width: 288,
    height: 140,
    data: { ...node, programId: graph.programId, programTone },
    draggable: false,
    selectable: true,
    ariaLabel: `${node.title}. ${node.coordinationLabel}`,
  } satisfies Node<NodeData>))
  if (graphIndex === 0 && graph.nodes.length === 0) return packetNodes
  const campaignY = packetNodes.length
    ? packetNodes.reduce((minimum, node) => Math.min(minimum, node.position.y), Number.POSITIVE_INFINITY) - 330
    : offset.y - 330
  return [{
    id: proofCampaignNodeId(graph.programId),
    type: "proofCampaign",
    position: { x: offset.x - 144, y: campaignY },
    width: 288,
    height: 90,
    data: {
      programId: graph.programId,
      packetCount: graph.nodes.length,
      availableCount: graph.nodes.filter((node) => node.state === "available").length,
      programTone,
    },
    draggable: false,
    selectable: false,
    zIndex: -1,
  }, ...packetNodes]
}

function flowEdges(graph: Graph): Edge[] {
  return graph.edges.map((edge) => {
    const nonBlocking = edge.relationType === "MILESTONE_OF" || edge.relationType === "PROMOTED_TO"
    const stroke = edge.relationType === "REDUCES_TO"
      ? "#a97938"
      : edge.relationType === "USES"
        ? "#4a78c2"
        : nonBlocking
          ? "#806797"
          : "#577766"
    return {
      id: `edge:${proofGraphNodeId(graph.programId, edge.id)}`,
      source: proofGraphNodeId(graph.programId, edge.source),
      target: proofGraphNodeId(graph.programId, edge.target),
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      style: { stroke, strokeWidth: nonBlocking ? 1.25 : 2, strokeDasharray: nonBlocking ? "5 5" : undefined },
      ariaLabel: `${edge.relationType || "RELATED"}: ${edge.source} to ${edge.target}`,
    }
  })
}

function DetailValue({ label, value }: { label: string; value: string }) {
  return (
    <div data-slot="proof-detail-value" className="rounded-xl border border-[#456c59]/15 bg-[#f7f3e7]/75 px-3 py-2">
      <dt className="research-smallcaps text-[9px] text-[#68776f]">{label}</dt>
      <dd className="mt-1 break-words text-xs leading-5 text-[#263c31]">{value}</dd>
    </div>
  )
}

function proofReceiptPresentation(outcome: string) {
  if (outcome === "accepted") {
    return { heading: "Accepted verification provenance", summary: "Accepted verification", icon: ShieldCheck }
  }
  if (outcome === "rejected") {
    return { heading: "Rejected proof evidence", summary: "Rejected evidence", icon: TriangleAlert }
  }
  return { heading: "Proof receipt evidence", summary: "Proof evidence", icon: CircleDot }
}

function ProofDetailInspector({
  graph,
  node,
  onClose,
  onSelectNode,
}: {
  graph: Graph
  node: ProofTaskGraphNode
  onClose: () => void
  onSelectNode: (nodeId: string) => void
}) {
  const meta = stateMeta[node.state] || stateMeta.waiting
  const work = node.workItem?.work
  const proof = node.workItem?.proof
  const verification = proof?.verification
  const verificationPresentation = proofReceiptPresentation(verification?.outcome || "")
  const VerificationIcon = verificationPresentation.icon
  const incoming = graph.edges.filter((edge) => edge.target === node.packetId)
  const outgoing = graph.edges.filter((edge) => edge.source === node.packetId)
  const nodeById = new Map(graph.nodes.map((item) => [item.packetId, item]))
  const dependencyButtons = (relations: typeof incoming, direction: "source" | "target") => relations.map((relation) => {
    const relatedId = relation[direction]
    return (
      <button
        key={relation.id}
        type="button"
        onClick={() => onSelectNode(proofGraphNodeId(graph.programId, relatedId))}
        className="min-h-9 rounded-full border border-[#456c59]/25 bg-[#fffdf7] px-3 py-1 text-left text-xs text-[#294b3b] transition hover:border-[#d5a54c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d5a54c]"
      >
        <span className="research-smallcaps mr-1 text-[9px] text-[#748078]">{relation.relationType || "RELATED"}</span>
        {nodeById.get(relatedId)?.title || relatedId}
      </button>
    )
  })

  return (
    <aside
      id="proof-detail-inspector"
      data-slot="proof-detail-inspector"
      data-state="open"
      aria-labelledby="proof-detail-title"
      aria-live="polite"
      className="absolute inset-x-3 bottom-3 z-10 max-h-[58%] overflow-y-auto rounded-[1.5rem] border border-[#456c59]/35 bg-[#fffdf7]/[0.97] p-4 text-[#203229] shadow-[0_28px_80px_-30px_rgba(11,39,28,0.85)] backdrop-blur md:inset-y-3 md:left-auto md:right-3 md:max-h-none md:w-[25rem]"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="research-smallcaps text-[10px]" style={{ color: meta.tone }}>{meta.label} · {node.packetId}</p>
          <h4 id="proof-detail-title" className="research-display mt-1 text-2xl font-semibold leading-tight">{node.title}</h4>
          <p className="mt-2 text-sm leading-6 text-[#526158]">{node.objective}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-[#456c59]/25 bg-[#f7f3e7] text-[#294b3b] hover:border-[#d5a54c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d5a54c]"
          aria-label={`Close details for ${node.title}`}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2">
        <DetailValue label="Coordination" value={node.coordinationLabel} />
        <DetailValue label="Proof status" value={proof?.status || "open"} />
        <DetailValue label="Kind" value={node.targetKind || node.category || "formal target"} />
        <DetailValue label="Formal binding" value={node.formalBindingStatus || "unspecified"} />
      </dl>

      <section className="mt-5" aria-labelledby="proof-dependencies-heading">
        <h5 id="proof-dependencies-heading" className="flex items-center gap-2 font-semibold"><GitBranch className="h-4 w-4" aria-hidden="true" /> Proof relations</h5>
        <div className="mt-2 grid gap-2">
          {incoming.length ? dependencyButtons(incoming, "source") : <p className="text-xs text-[#68776f]">No prerequisites. This is an entry point.</p>}
          {outgoing.length ? dependencyButtons(outgoing, "target") : <p className="text-xs text-[#68776f]">No downstream proof nodes in this graph.</p>}
        </div>
      </section>

      {node.theoremTargets.length ? (
        <section className="mt-5" aria-labelledby="proof-targets-heading">
          <h5 id="proof-targets-heading" className="font-semibold">Formal targets</h5>
          <ul className="mt-2 grid gap-2 text-xs leading-5 text-[#526158]">
            {node.theoremTargets.map((target, index) => <li key={`${node.packetId}-target-${index}`} className="rounded-xl bg-[#edf2e9] px-3 py-2">{target.statement}</li>)}
          </ul>
        </section>
      ) : null}

      {node.mandatoryControls.length ? (
        <section className="mt-5" aria-labelledby="proof-controls-heading">
          <h5 id="proof-controls-heading" className="font-semibold">Acceptance controls</h5>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-[#526158]">
            {node.mandatoryControls.map((control, index) => <li key={`${node.packetId}-control-${index}`}>{control.requirement}</li>)}
          </ul>
        </section>
      ) : null}

      {(work?.taskId || work?.claim || work?.hyades) ? (
        <section className="mt-5" aria-labelledby="proof-work-heading">
          <h5 id="proof-work-heading" className="flex items-center gap-2 font-semibold"><Clock3 className="h-4 w-4" aria-hidden="true" /> Live work</h5>
          <dl className="mt-2 grid gap-2">
            {work.taskId ? <DetailValue label="HAM task" value={`${work.taskId}${work.linkedTaskCount > 1 ? ` · ${work.linkedTaskCount} linked tasks` : ""}`} /> : null}
            {work.claim ? <DetailValue label="Claim lease" value={`${work.claim.nostrPubkey.slice(0, 16)}… · expires ${work.claim.expiresAt}`} /> : null}
            {work.hyades ? <DetailValue label="Hyades run" value={`${work.hyades.runId || "not started"} · ${work.hyades.status || "idle"}`} /> : null}
          </dl>
        </section>
      ) : null}

      {verification ? (
        <section className="mt-5" aria-labelledby="proof-verification-heading">
          <h5 id="proof-verification-heading" className="flex items-center gap-2 font-semibold"><VerificationIcon className="h-4 w-4" aria-hidden="true" /> {verificationPresentation.heading}</h5>
          <dl className="mt-2 grid gap-2">
            <DetailValue label="Outcome" value={verification.outcome} />
            <DetailValue label="Receipt" value={`${verification.method} · ${verification.receiptId}`} />
            <DetailValue label="Source" value={`${verification.sourceCommit} · ${verification.leanToolchain}`} />
            <DetailValue label="Solution binding" value={verification.solutionSha256} />
          </dl>
        </section>
      ) : null}
    </aside>
  )
}

export function ProofTaskGraph({ proofDag, workState, universeGraphs }: ProofGraphBinding & { universeGraphs?: ProofGraphBinding[] }) {
  const graph = useMemo(() => projectProofTaskGraph(proofDag, workState), [proofDag, workState])
  const graphs = useMemo(() => {
    const candidates = universeGraphs?.length
      ? universeGraphs.map((binding) => projectProofTaskGraph(binding.proofDag, binding.workState))
      : [graph]
    return [graph, ...candidates.filter((candidate) => candidate.programId !== graph.programId)]
  }, [graph, universeGraphs])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const layoutNodes = useMemo(() => graphs.flatMap(flowNodes), [graphs])
  const nodes = useMemo(() => layoutNodes.map((node) => ({
    ...node,
    selected: node.id === selectedNodeId,
  })), [layoutNodes, selectedNodeId])
  const edges = useMemo(() => graphs.flatMap(flowEdges), [graphs])
  const instanceRef = useRef<ReactFlowInstance<NodeData | CampaignData> | null>(null)
  const packetCount = graphs.reduce((total, item) => total + item.nodes.length, 0)
  const selectedProof = useMemo(() => {
    if (!selectedNodeId) return null
    const selectedFlowNode = layoutNodes.find((node) => node.id === selectedNodeId && node.type === "proofTask")
    if (!selectedFlowNode) return null
    const selectedData = selectedFlowNode.data as NodeData
    const selectedGraph = graphs.find((candidate) => candidate.programId === selectedData.programId)
    const selected = selectedGraph?.nodes.find((node) => node.packetId === selectedData.packetId)
    return selectedGraph && selected ? { graph: selectedGraph, node: selected } : null
  }, [graphs, layoutNodes, selectedNodeId])

  function fitCampaign() {
    const campaignNodes = nodes.filter((node) => node.type === "proofTask" && (node.data as NodeData).programId === graph.programId)
    void instanceRef.current?.fitView({ nodes: campaignNodes, padding: 0.22, duration: 500 })
  }

  function fitUniverse() {
    void instanceRef.current?.fitView({ nodes, padding: 0.16, duration: 650, maxZoom: 0.24 })
  }

  return (
    <section aria-labelledby="proof-task-graph-heading" className="overflow-hidden rounded-[1.75rem] border border-[#456c59]/30 bg-[#e8efe7]">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-[#456c59]/25 bg-[#f8f5eb] px-4 py-3">
        <div>
          <p className="research-kicker">Proof coordination map</p>
          <h3 id="proof-task-graph-heading" className="research-display mt-1 text-xl font-semibold text-[#1e342a]">{graphs.length > 1 ? "Full proof field" : graph.programId}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {graphs.length > 1 ? (
            <>
              <Button type="button" variant="outline" size="sm" onClick={fitCampaign} className="border-[#456c59]/30 bg-[#fffdf7] text-[#294b3b]">
                <Focus className="h-4 w-4" aria-hidden="true" /> This campaign
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={fitUniverse} className="border-[#456c59]/30 bg-[#fffdf7] text-[#294b3b]">
                <Orbit className="h-4 w-4" aria-hidden="true" /> Full graph
              </Button>
            </>
          ) : null}
          <p className="text-xs text-[#52665b]">Zoom reveals field → campaigns → proofs → verified work detail</p>
        </div>
      </header>
      <div className="relative h-[38rem] min-h-[28rem]" aria-label={`Dependency graph for proof campaign ${graph.programId}`}>
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={proofNodeTypes}
            edgeTypes={proofEdgeTypes}
            onInit={(instance) => {
              instanceRef.current = instance
              window.requestAnimationFrame(() => graphs.length > 1 ? fitCampaign() : void instance.fitView({ padding: 0.2 }))
            }}
            onNodeClick={(_, node) => {
              if (node.type === "proofTask") setSelectedNodeId(node.id)
            }}
            minZoom={0.035}
            maxZoom={1.8}
            onlyRenderVisibleElements
            nodesConnectable={false}
            nodesFocusable
            edgesFocusable={false}
            elementsSelectable
            panOnScroll
            proOptions={{ hideAttribution: true }}
            aria-label="Proof task dependency graph"
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#8ca799" />
            <Controls position="bottom-left" showInteractive={false} />
            <MiniMap
              position="bottom-right"
              nodeColor={(node) => (node.data as NodeData | CampaignData).programTone || "#17392f"}
              maskColor="rgba(235, 241, 231, 0.72)"
              ariaLabel="Proof campaign overview"
            />
          </ReactFlow>
        </ReactFlowProvider>
        {selectedProof ? (
          <ProofDetailInspector
            graph={selectedProof.graph}
            node={selectedProof.node}
            onClose={() => setSelectedNodeId(null)}
            onSelectNode={setSelectedNodeId}
          />
        ) : (
          <p className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-[#456c59]/20 bg-[#fffdf7]/90 px-3 py-1.5 text-xs text-[#52665b] shadow-sm">
            Select a proof to inspect its dependencies and provenance
          </p>
        )}
      </div>
      <details className="border-t border-[#456c59]/25 bg-[#f8f5eb] px-4 py-3 text-sm">
        <summary className="cursor-pointer font-medium text-[#294b3b]">Accessible proof field ({graphs.length} campaign{graphs.length === 1 ? "" : "s"}, {packetCount} packets)</summary>
        {graphs.map((item) => (
          <section key={item.programId} className="mt-3" aria-labelledby={`packet-list-${item.programId}`}>
            <h4 id={`packet-list-${item.programId}`} className="research-display font-semibold text-[#203229]">{item.programId}</h4>
            <ol className="mt-2 grid gap-2 md:grid-cols-2">
              {item.nodes.map((node) => (
                <li key={node.packetId} className="rounded-xl border border-[#456c59]/20 bg-[#fffdf7] p-3">
                  <p className="research-smallcaps text-[10px] text-[#557064]">{stateMeta[node.state]?.label || node.state} · {node.packetId}</p>
                  <button
                    type="button"
                    aria-controls="proof-detail-inspector"
                    aria-expanded={selectedNodeId === proofGraphNodeId(item.programId, node.packetId)}
                    onClick={() => setSelectedNodeId(proofGraphNodeId(item.programId, node.packetId))}
                    className="research-display mt-1 min-h-11 text-left font-semibold text-[#203229] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d5a54c]"
                  >
                    {node.title}
                  </button>
                  <p className="mt-1 text-xs text-[#5c6a62]">Depends on: {node.prerequisitePacketIds.join(", ") || "nothing"}</p>
                  {node.workItem?.work.taskId ? <p className="mt-1 text-xs text-[#5c6a62]">HAM task {node.workItem.work.taskId}</p> : null}
                  {node.workItem?.proof.verification ? (
                    <p className="mt-1 text-xs text-[#5c6a62]">
                      {proofReceiptPresentation(node.workItem.proof.verification.outcome).summary} · {PROOF_VERIFICATION_METHOD_LABELS[node.workItem.proof.verification.method]} receipt {node.workItem.proof.verification.receiptId}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          </section>
        ))}
      </details>
    </section>
  )
}
