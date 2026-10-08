import { notFound } from "next/navigation"

import { devPreviewsEnabled } from "@/lib/dev-previews"

import { ProofTaskGraph, type ProofGraphBinding } from "@/components/tasks/proof-task-graph"
import { parseProofDag, parseProofWorkState, type ProofDag, type ProofWorkState } from "@/lib/proof-task-graph"

const GRAPH_HASH = "8ed0eb08bb39435ed4220945ab9e76c348e1475cb802b08e468472d89c09e9cc"
const RECEIPT_HASH = "14e3709fd83a1fc8649b31eec16e6116d70e6f56b9f2b518a91e17fa4b855847"
const SOLUTION_HASH = "8aa173d933692f25f05c423f742d76184ea6ac60c62f17d86cbf97495d8bd90d"
const NOSTR_PUBKEY = "b".repeat(64)
const VERIFIER_PRINCIPAL_ID = "10000000-0000-4000-8000-000000000001"

const packetDefinitions = [
  ["winding-prototime-v1-p01", "Prove the neutral winding proto-clock core", "Verify the frozen universal-cover bookkeeping, affine-origin, conditional-order, orientation, winding, and scalar power-law threshold theorems.", []],
  ["winding-prototime-v1-p02", "Build the null-pair reset-ledger adapter", "Transport the neutral phase-sheet reading into the null-pair torsor and finite reset-event coordinates without importing timestamps into the core.", ["winding-prototime-v1-p01"]],
  ["winding-prototime-v1-p03", "Compose winding and null-pair proto-time", "Compose the accepted neutral clock core and reset adapter into a null-pair proto-time bridge with explicit nonidentification controls.", ["winding-prototime-v1-p01", "winding-prototime-v1-p02"]],
  ["winding-prototime-v1-p04", "Test a collective phase clock domain", "Determine whether a nonzero coherent oscillator order parameter can select a covariant collective phase reading under an explicit dynamical coherence owner.", ["winding-prototime-v1-p01"]],
  ["winding-prototime-v1-p05", "Classify finite multiphase clock selectors", "Classify primitive integral covectors selecting one candidate clock from a finite torus winding lattice.", ["winding-prototime-v1-p01"]],
  ["winding-prototime-v1-p06", "Test characteristic clock foliation", "Test whether a selected nonvanishing clock one-form is compatible with a field equation's characteristics and integrates to local leaves.", ["winding-prototime-v1-p03"]],
] as const

function makeProofDag(graphId: string, title: string, definitions: ReadonlyArray<readonly [string, string, string, readonly string[]]>, hash = GRAPH_HASH): ProofDag {
  return parseProofDag({
    schema_id: "galaxy.proof-dag.v1",
    graph_id: graphId,
    graph_kind: "campaign",
    title,
    targets: definitions.map(([targetId, targetTitle, summary]) => ({
      target_id: targetId,
      target_kind: "formal-target",
      title: targetTitle,
      natural_language_summary: summary,
      formal_binding: { status: "mapped" },
    })),
    relations: definitions.flatMap(([targetId, , , prerequisites]) => prerequisites.map((prerequisiteId) => ({
      relation_id: `${prerequisiteId}->${targetId}`,
      relation_type: "DEPENDS_ON",
      prerequisite_target_id: prerequisiteId,
      dependent_target_id: targetId,
    }))),
  }, hash)
}

function emptyWorkState(proofDag: ProofDag): ProofWorkState {
  return parseProofWorkState({
    schema_id: "galaxy.proof-work-state.v1",
    workspace_id: proofDag.graphId,
    graph_ref: { graph_id: proofDag.graphId, content_sha256: proofDag.contentSha256 },
    version: 1,
    updated_at: "2026-09-13T12:00:00Z",
    items: [],
  }, proofDag)
}

const proofDag = makeProofDag("winding-prototime-v1", "Winding proto-time", packetDefinitions)
const workState = parseProofWorkState({
  schema_id: "galaxy.proof-work-state.v1",
  workspace_id: "winding-prototime-v1",
  graph_ref: { graph_id: proofDag.graphId, content_sha256: proofDag.contentSha256 },
  version: 1,
  updated_at: "2026-09-13T12:00:00Z",
  items: [
    {
      node_id: "winding-prototime-v1-p01",
      version: 3,
      work: { status: "closed", claim: null, hyades: { workflow_id: "proof-workflow-v1", run_id: "run-p01", status: "completed" }, blocker: null, task_id: "ham-p01", linked_task_count: 1 },
      proof: {
        status: "verified",
        candidate_sha256: SOLUTION_HASH,
        verification: {
          method: "hyades-run",
          authority: {
            principal_id: VERIFIER_PRINCIPAL_ID,
            nostr_pubkey: NOSTR_PUBKEY,
            principal_kind: "agent",
          },
          receipt_id: "receipt-p01",
          receipt_sha256: RECEIPT_HASH,
          outcome: "accepted",
          solution_sha256: SOLUTION_HASH,
          source_commit: "943394fca50273759c1d977938fffd58924004fd",
          lean_toolchain: "leanprover/lean4:v4.30.0",
          mathlib_revision: "95a9a85a904221c248d27b378420f7e1812375b1",
          sorry_free: true,
          verified_at: "2026-09-13T11:00:00Z",
          hyades: { workflow_id: "proof-workflow-v1", run_id: "run-p01", status: "completed" },
        },
      },
      external: { prove2me: { theorem_id: null, status: null }, rosetta: { node_id: "winding-prototime-v1-p01", status: "registered" } },
    },
    {
      node_id: "winding-prototime-v1-p02",
      version: 2,
      work: { status: "claimed", claim: { claim_id: "claim-p02", nostr_pubkey: NOSTR_PUBKEY, claimed_at: "2026-09-13T11:30:00Z", expires_at: "2026-09-13T13:30:00Z" }, hyades: null, blocker: null, task_id: "ham-p02", linked_task_count: 1 },
      proof: { status: "open", candidate_sha256: null, verification: null },
      external: { prove2me: { theorem_id: null, status: null }, rosetta: { node_id: "winding-prototime-v1-p02", status: "registered" } },
    },
    {
      node_id: "winding-prototime-v1-p04",
      version: 4,
      work: { status: "running", claim: null, hyades: { workflow_id: "proof-workflow-v1", run_id: "run-p04", status: "running" }, blocker: null, task_id: "ham-p04", linked_task_count: 1 },
      proof: { status: "candidate", candidate_sha256: SOLUTION_HASH, verification: null },
      external: { prove2me: { theorem_id: null, status: null }, rosetta: { node_id: "winding-prototime-v1-p04", status: "registered" } },
    },
  ],
}, proofDag)

function compactSourceBinding(graphId: string, label: string, count: number, seed: string): ProofGraphBinding {
  const definitions = Array.from({ length: count }, (_, index) => {
    const nodeId = `concept-${String(index + 1).padStart(3, "0")}`
    const prerequisites = index === 0 ? [] : [`concept-${String(Math.floor((index - 1) / 2) + 1).padStart(3, "0")}`]
    return [nodeId, `${label} ${index + 1}`, `Inspect the addressable ${label.toLowerCase()} dependency and preserve its exact provenance.`, prerequisites] as const
  })
  const hash = seed.repeat(64).slice(0, 64)
  const compactDag = makeProofDag(graphId, graphId, definitions, hash)
  return { proofDag: compactDag, workState: emptyWorkState(compactDag) }
}

const proofField: ProofGraphBinding[] = [
  { proofDag, workState },
  compactSourceBinding("leanproofs-kernel", "Kernel concept", 54, "1"),
  compactSourceBinding("bridge-candidates", "Bridge candidate", 30, "2"),
  compactSourceBinding("rosetta-proof-campaigns", "Campaign concept", 22, "3"),
  compactSourceBinding("boundary-search", "Boundary concept", 18, "4"),
]

export default function ProofDagPreviewPage() {
  // This route renders synthetic architecture fixtures. Never expose it from a
  // production build where it could be mistaken for canonical proof state.
  if (!devPreviewsEnabled()) notFound()

  return (
    <main className="min-h-screen bg-[#dfe9e0] px-4 py-10 sm:px-8">
      <div className="mx-auto max-w-[1500px]">
        <header className="mb-6 max-w-3xl">
          <p className="research-kicker">Galaxy Brain · coordination primitive</p>
          <h1 className="research-display mt-2 text-4xl font-semibold text-[#18372b]">Proof work as a living field</h1>
          <p className="mt-3 text-[#4c6559]">
            Galaxy owns the immutable proof DAG and interoperates with Prove2Me through stable remote IDs. A separate hash-bound work overlay carries signed claim leases and accepted verifier receipts; Hyades and other approved Lean replay agents can verify, while owner overrides remain visibly distinct.
          </p>
          <p className="mt-2 text-xs text-[#61766b]">
            Focus fixture: <code>MonumentalSystems/LeanProofs@943394f</code> · winding-prototime-v1 · structure and work remain separate
          </p>
        </header>
        <ProofTaskGraph proofDag={proofDag} workState={workState} universeGraphs={proofField} />
      </div>
    </main>
  )
}
