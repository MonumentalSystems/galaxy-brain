"use client"

import { useState } from "react"

import { SemanticField } from "@/components/knowledge/semantic-field"
import { createCodeGraphObjectId, createCodeGraphRevision } from "@/lib/code-graph-provider.js"
import { projectFederatedGraph } from "@/lib/federated-graph.js"
import { createGalaxyObjectReference } from "@/lib/galaxy-object-reference.js"
import { GalaxyLensNav } from "@/components/workspace/galaxy-lens-nav"
import type { GalaxyNode, GalaxyWorkspace } from "@/lib/galaxy-brain-service"

const workspace: GalaxyWorkspace = {
  id: "semantic-field-preview",
  name: "Galaxy Brain",
  description: "Shared epistemic field",
  rootFolderId: "semantic-field-preview-root",
  createdAt: new Date("2026-08-25T09:00:00-04:00"),
  updatedAt: new Date("2026-08-28T12:00:00-04:00"),
}

const nodes: GalaxyNode[] = [
  {
    id: "preview-reference",
    type: "document",
    title: "Semantic zoom architecture",
    content: "Scale-dependent projections preserve containment, lineage, proof relations, time, and access.",
    category: "document",
    parentId: workspace.rootFolderId,
    position: { x: 0, y: 0 },
    size: { width: 300, height: 200 },
    version: 4,
    createdAt: new Date("2026-08-25T09:30:00-04:00"),
    updatedAt: new Date("2026-08-28T12:00:00-04:00"),
  },
]

const gitRevision = createCodeGraphRevision("a".repeat(40), `sha256:${"b".repeat(64)}`)
const proofRevision = `sha256:${"c".repeat(64)}`
const leanRef = createGalaxyObjectReference("code.symbol", createCodeGraphObjectId({
  kind: "symbol",
  repositoryId: "github.com/MonumentalSystems/demo-lean",
  path: "Demo/Main.lean",
  symbol: "Demo.main_theorem",
}), { mode: "pinned", revision: gitRevision })
const proofGraphRef = createGalaxyObjectReference("proof.graph", "vortex-proof", { mode: "pinned", revision: proofRevision })
const proofNodeRef = createGalaxyObjectReference("proof.node", "vortex-proof#goal-7", { mode: "pinned", revision: proofRevision })
const memoryRef = createGalaxyObjectReference("ham.memory", "3262")

const federatedProjection = projectFederatedGraph({
  nodes: [
    { ref: leanRef, title: "Demo.main_theorem", detail: "Lean theorem · Demo/Main.lean", source: { provider: "codebase-memory", revision: gitRevision } },
    { ref: proofGraphRef, title: "Vortex proof DAG", detail: "Galaxy-owned DAG · Prove2Me-compatible decomposition", source: { provider: "galaxy", revision: proofRevision } },
    { ref: proofNodeRef, title: "Discharge conservation goal", detail: "Galaxy proof target · verified Lean replay attached", source: { provider: "galaxy", recordId: "goal-7" } },
    { ref: memoryRef, title: "Why the invariant matters", detail: "HAM memory connected as authored context", source: { provider: "ham", recordId: "3262" } },
  ],
  edges: [
    { fromRef: proofGraphRef, toRef: proofNodeRef, relation: "contains", basis: "deterministic_structure", source: { provider: "galaxy", revision: proofRevision } },
    {
      fromRef: leanRef,
      toRef: proofNodeRef,
      relation: "verifies",
      basis: "verified_proof",
      source: { provider: "lean-replay", recordId: "receipt-4" },
      verification: { status: "verified", method: "lean-replay", evidenceRef: "hyades:receipt:4" },
    },
  ],
  links: [
    { id: "link-1", from_ref: proofNodeRef, to_ref: leanRef, relation: "formalized_by", basis: "authored", provenance: { source: "manual", source_system: "galaxy" } },
    { id: "link-2", from_ref: memoryRef, to_ref: proofNodeRef, relation: "context_for", basis: "authored", provenance: { source: "manual", source_system: "galaxy" } },
  ],
})

export function SemanticFieldPreviewClient() {
  const [openedTitle, setOpenedTitle] = useState("")

  return (
    <>
      <SemanticField
        workspace={workspace}
        nodes={nodes}
        includeConceptFixtures
        federatedProjection={federatedProjection}
        onNodeOpen={(node) => setOpenedTitle(node.title)}
      />
      <GalaxyLensNav />
      <p className="sr-only" role="status" aria-live="polite">
        {openedTitle ? `Opened source material: ${openedTitle}` : ""}
      </p>
    </>
  )
}
