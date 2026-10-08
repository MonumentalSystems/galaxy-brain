import { notFound } from "next/navigation"

import {
  AtlasV2Client,
  type LoadedAtlas,
} from "@/app/atlas-v2/atlas-v2-client"
import { buildAuthorizedCanvasProjection } from "@/lib/canvas/authorized-canvas-projection"
import { mergeCanvasSnapshot } from "@/lib/canvas/canvas-persistence"
import { devPreviewsEnabled } from "@/lib/dev-previews"
import type { TaskSummary } from "@/lib/types/tasks"

const previewTask: TaskSummary = {
  id: "atlas-preview-task",
  projectRef: "galaxy-brain-v2",
  version: 3,
  title: "Trace a mechanism across the research field",
  goal: "Compare vortex and helicity evidence, challenge the working assumption, and synthesize a cited proof map.",
  why: "The useful relation lives at the mechanism level rather than the whole-document level.",
  state: "running",
  lifecyclePhase: "running",
  stage: "Building evidence branches",
  riskMode: "diagnostic",
  expectedEffects: [],
  resources: [{
    id: "atlas-preview-proof",
    resourceRef: "prove2me:atlas-preview-packet",
    resourceClass: "proof-packet",
    mode: "read",
    status: "active",
  }],
  conflicts: [],
  projectionSource: "ham",
}

const previewAuthorizedTask = { ...previewTask, authorized: true as const }

const projection = buildAuthorizedCanvasProjection({
  workspaceNodes: [
    {
      id: "field-note",
      authorized: true,
      type: "note",
      title: "Field note: conserved circulation",
      content: "## Working note\n\nThe candidate invariant is $\\Gamma = \\oint_C u \\cdot d\\ell$.\n\n- compare boundary conditions\n- retain source anchors",
      version: 4,
    },
    {
      id: "simulation-image",
      authorized: true,
      type: "image",
      title: "Vorticity section",
      summary: "An authorized image artifact waiting for region anchors.",
      mediaType: "image/png",
      version: 2,
    },
    {
      id: "corpus-map",
      authorized: true,
      type: "document",
      title: "Mechanism correspondence map",
      content: "# Correspondence map\n\nA portable Markdown representation with citations, equations, and provenance.",
      version: 6,
    },
  ],
  papers: [{
    id: "paper-vortex-helicity",
    authorized: true,
    title: "Topology, helicity, and coherent vortex transport",
    abstract: "A representative paper projection for inspecting semantic scale changes across the Atlas.",
    metadataHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    authors: [{ name: "A. Researcher" }, { name: "B. Scholar" }],
    categories: ["fluid dynamics", "topology"],
  }],
  experiments: [{
    id: "eln-helicity-sweep",
    authorized: true,
    title: "Helicity parameter sweep",
    domain: "Computational fluid dynamics",
    hypothesis: "Transport remains stable across the selected regime.",
    results: "The transition appears near the predicted boundary.",
    interpretation: "The observation is provisional and retains its artifact references.",
    status: "review",
    tags: ["helicity", "vortex"],
    updatedAt: "2026-09-23T12:00:00Z",
  }],
  tasks: [previewAuthorizedTask],
})

const taskPlacement = projection.placements.find((placement) => placement.nodeType === "galaxy.task")

const previewCanvas = {
  canvasId: "00000000-0000-4000-8000-000000000022",
  workspaceId: "atlas-shell-preview",
  slug: "main",
  title: "Living scholarly field atlas",
  isDefault: true,
  projectionMode: "ambient" as const,
  version: 1,
  contentHash: `sha256:${"b".repeat(64)}`,
  content: {
    schemaId: "gb.canvas.snapshot.v1" as const,
    items: [{
      id: "memory-unavailable-preview",
      subjectRef: "gb:object:v1:ham.memory:unavailable-preview:latest",
      nodeType: "galaxy.note",
      x: 860,
      y: 2_040,
      width: 400,
      height: 250,
      angle: 0,
      zIndex: 8,
      displayMode: "card",
      collapsed: false,
      style: {},
    }],
    edges: [],
    removedItemIds: [],
    removedEdgeIds: [],
  },
}

const previewCanvasCatalog = [
  previewCanvas,
  {
    canvasId: "00000000-0000-4000-8000-000000000023",
    workspaceId: "atlas-shell-preview",
    slug: "methods",
    title: "Methods and evidence",
    isDefault: false,
    projectionMode: "ambient" as const,
    version: 3,
    contentHash: `sha256:${"c".repeat(64)}`,
  },
]

const previewAtlas: LoadedAtlas = {
  projection: mergeCanvasSnapshot(projection, previewCanvas.content),
  baseProjection: projection,
  sources: [
    { label: "Workspace", status: "ready", count: 3 },
    { label: "Papers", status: "ready", count: 1 },
    { label: "ELN", status: "ready", count: 1 },
    { label: "Tasks", status: "ready", count: 1 },
    { label: "Surfaces", status: "unavailable", count: 0 },
  ],
  workspaceId: "atlas-shell-preview",
  workspaceName: "Living scholarly field",
  canvases: previewCanvasCatalog,
  canvasCatalogPotentiallyPartial: false,
  durableCanvas: previewCanvas,
  tasks: [previewTask],
  sourceCandidates: projection.placements,
}

export default function AtlasShellPreviewPage() {
  if (!devPreviewsEnabled()) notFound()

  return (
    <AtlasV2Client
      tenantId="atlas-shell-preview"
      principalId="preview-researcher"
      initialAtlas={previewAtlas}
      mode="preview"
      defaultSelectionRef={taskPlacement?.subjectRef}
      headerSlot={<span className="atlas-preview-account">Preview identity</span>}
    />
  )
}
