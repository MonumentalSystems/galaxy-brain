"use client"

import { useState } from "react"

import { UnifiedGraph } from "@/components/graph/unified-graph"
import { createGalaxyObjectReference, parseGalaxyObjectReference } from "@/lib/galaxy-object-reference.js"
import { createGalaxyObjectProjection } from "@/lib/object-projection.js"
import { projectUnifiedGraph } from "@/lib/unified-graph.js"

const SCOPE = {
  tenantId: "30000000-0000-4000-8000-000000000001",
  workspaceId: "unified-graph-preview",
}
const PAPER_REVISION = `sha256:${"a".repeat(64)}`
const ANCHOR_REVISION = `sha256:${"b".repeat(64)}`
const PROOF_REVISION = `sha256:${"c".repeat(64)}`
const refs = {
  graph: createGalaxyObjectReference("proof.graph", "prototime", { mode: "pinned", revision: PROOF_REVISION }),
  paper: createGalaxyObjectReference("paper", "vortex-paper", { mode: "pinned", revision: PAPER_REVISION }),
  anchor: createGalaxyObjectReference("document.anchor", "vortex-equation", { mode: "pinned", revision: ANCHOR_REVISION }),
  task: createGalaxyObjectReference("ham.task", "task-vortex"),
  proof: createGalaxyObjectReference("proof.node", "prototime#goal-7", { mode: "pinned", revision: PROOF_REVISION }),
  memory: createGalaxyObjectReference("ham.memory", "3682"),
}

function object(ref: string, kind: string, title: string, summary: string, provider = "galaxy") {
  const parsed = parseGalaxyObjectReference(ref)
  const revision = parsed?.format === "canonical" && parsed.selector.mode === "pinned"
    ? parsed.selector.revision
    : null
  const contentHash = revision?.startsWith("sha256:") ? revision.slice("sha256:".length) : null
  return {
    scope: SCOPE,
    projection: createGalaxyObjectProjection({
      schemaId: "gb.object-projection.v1",
      ref,
      kind,
      revision: { policy: revision ? "pinned" : "latest", id: revision, contentHash },
      title,
      summary,
      representations: [],
      provenance: { provider, sourceId: ref },
      capabilities: ["open", "inspect", "relate"],
    }),
  }
}

const projection = projectUnifiedGraph({
  schemaId: "gb.graph-projection-input.v1",
  scope: SCOPE,
  query: { rootRef: null, mode: "mixed", lens: "explore", scale: "corpus" },
  objects: [
    object(refs.graph, "proof.graph", "Winding proto-time", "Galaxy-owned proof structure; passive in this preview."),
    object(refs.paper, "paper", "Vortex transport paper", "Pinned paper revision with durable representations."),
    object(refs.anchor, "document.anchor", "Helicity balance equation", "Exact page-aware equation region."),
    object(refs.task, "ham.task", "Challenge the transport assumption", "HAM coordination linked to exact source context.", "ham"),
    object(refs.proof, "proof.node", "Discharge conservation goal", "Formal target with proof and work axes kept separate."),
    object(refs.memory, "ham.memory", "Why the invariant matters", "Authorized HAM context; similarity does not imply evidence.", "ham"),
  ],
  relations: [
    { scope: SCOPE, relation: { fromRef: refs.graph, toRef: refs.proof, relation: "contains", trust: "structure", source: { provider: "galaxy-proof-dag" } } },
    { scope: SCOPE, relation: { fromRef: refs.paper, toRef: refs.anchor, relation: "contains", trust: "structure", source: { provider: "galaxy" } } },
    { scope: SCOPE, relation: { fromRef: refs.task, toRef: refs.anchor, relation: "references", trust: "assertion", source: { provider: "galaxy-ledger" } } },
    { scope: SCOPE, relation: { fromRef: refs.proof, toRef: refs.anchor, relation: "formalized_by", trust: "verification", source: { provider: "hyades" }, verification: { status: "verified", method: "lean-replay", evidenceRef: "receipt:preview" } } },
    { scope: SCOPE, relation: { fromRef: refs.memory, toRef: refs.proof, relation: "supports", trust: "candidate", source: { provider: "ham" } } },
  ],
  proofContexts: [{
    scope: SCOPE,
    graphRef: refs.graph,
    graphKind: "repository-field",
    coordinationActive: false,
    nodeRefs: [refs.proof],
    nodeStates: [],
  }],
  providers: [
    { scope: SCOPE, provider: "galaxy", status: "ready", revision: "preview-v1" },
    { scope: SCOPE, provider: "ham", status: "ready" },
  ],
})

export function UnifiedGraphPreview() {
  const [opened, setOpened] = useState("")
  return (
    <>
      <UnifiedGraph projection={projection} onOpenReference={setOpened} />
      <p className="sr-only" role="status" aria-live="polite">{opened ? `Opened ${opened}` : ""}</p>
    </>
  )
}
