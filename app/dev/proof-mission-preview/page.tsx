import { notFound } from "next/navigation"

import { ProofMissionPreviewClient } from "@/app/dev/proof-mission-preview/proof-mission-preview-client"
import { devPreviewsEnabled } from "@/lib/dev-previews"
import { parseProofDag } from "@/lib/proof-task-graph"

const FIXTURE_HASH = "90bc27ea47f1f5703d73ebc3848a6a6ae68f893ea5a896bf872a2b7c17ee1895"

const passiveRepositoryField = parseProofDag({
  schema_id: "galaxy.proof-dag.v1",
  graph_id: "leanproofs-preview-field",
  graph_kind: "repository-field",
  title: "LeanProofs compact source field",
  targets: [
    {
      target_id: "finite-support-core",
      target_kind: "definition",
      title: "Finite support core",
      natural_language_summary: "A reusable finite-support definition bundle.",
      category: "foundations",
      formal_binding: { status: "mapped" },
    },
    {
      target_id: "periodic-flux-lemma",
      target_kind: "theorem",
      title: "Periodic flux lemma",
      natural_language_summary: "Relate periodic transport to the conserved flux form.",
      category: "transport",
      formal_binding: { status: "mapped" },
    },
    {
      target_id: "helicity-invariant",
      target_kind: "theorem",
      title: "Helicity invariant",
      natural_language_summary: "Preserve the helicity quantity under the selected flow.",
      category: "invariants",
      formal_binding: { status: "mapped" },
    },
    {
      target_id: "vortex-interpolation",
      target_kind: "theorem",
      title: "Finite periodic principal-flux interpolation",
      natural_language_summary: "Combine the compact source lemmas into the candidate mission goal.",
      category: "interpolation",
      formal_binding: { status: "mapped" },
    },
  ],
  relations: [
    {
      relation_id: "finite-support-to-flux",
      relation_type: "DEPENDS_ON",
      prerequisite_target_id: "finite-support-core",
      dependent_target_id: "periodic-flux-lemma",
    },
    {
      relation_id: "finite-support-to-helicity",
      relation_type: "DEPENDS_ON",
      prerequisite_target_id: "finite-support-core",
      dependent_target_id: "helicity-invariant",
    },
    {
      relation_id: "flux-to-interpolation",
      relation_type: "DEPENDS_ON",
      prerequisite_target_id: "periodic-flux-lemma",
      dependent_target_id: "vortex-interpolation",
    },
    {
      relation_id: "helicity-to-interpolation",
      relation_type: "DEPENDS_ON",
      prerequisite_target_id: "helicity-invariant",
      dependent_target_id: "vortex-interpolation",
    },
    {
      relation_id: "flux-milestone",
      relation_type: "MILESTONE_OF",
      prerequisite_target_id: "periodic-flux-lemma",
      dependent_target_id: "vortex-interpolation",
    },
  ],
}, FIXTURE_HASH)

export default function ProofMissionPreviewPage() {
  // This route renders a synthetic passive corpus. It must remain behind the
  // shared development-preview gate and must never be treated as proof state.
  if (!devPreviewsEnabled()) notFound()

  return (
    <main className="min-h-screen bg-[#dfe9e0] px-4 py-10 sm:px-8">
      <div className="mx-auto grid max-w-5xl gap-6">
        <header className="max-w-3xl">
          <p className="research-kicker">Galaxy Brain · mission design lab</p>
          <h1 className="research-display mt-2 text-4xl font-semibold text-[#18372b]">
            Shape a mission without waking the field
          </h1>
          <p className="mt-3 text-[#4c6559]">
            Choose one terminal theorem and optional milestones from a passive repository field. Confirmation records intent locally for inspection; it does not register a graph, create a workspace, or activate work.
          </p>
        </header>

        <ProofMissionPreviewClient proofDag={passiveRepositoryField} />
      </div>
    </main>
  )
}
