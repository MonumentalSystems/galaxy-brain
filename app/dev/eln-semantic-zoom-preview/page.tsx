import { notFound } from "next/navigation"

import { devPreviewsEnabled } from "@/lib/dev-previews"

import { TaskWorkspaceSurface } from "@/components/workspace/task-workspace-surface"
import type { ResearchRecordDocument } from "@/lib/research-record"

const previewRecord: ResearchRecordDocument = {
  schemaVersion: "gb.research-record.v1",
  id: "vortex-memory-017",
  kind: "eln-research-record",
  title: "Topological persistence in a driven vortex lattice",
  status: "running",
  domain: "fusion",
  tags: ["vortex", "topology", "phase-memory"],
  sections: [
    {
      key: "hypothesis",
      title: "Hypothesis",
      content: "A bounded drive preserves winding memory after the external field relaxes.",
    },
    {
      key: "protocol",
      title: "Protocol",
      content: "Sweep the drive through three plateaus, then compare winding counts with the zero-field control.",
    },
    {
      key: "configuration",
      title: "Configuration",
      content: "{\n  \"lattice\": 96,\n  \"seed\": 42\n}",
    },
    {
      key: "results",
      title: "Results",
      content: "The first two plateaus retain distinct winding populations across five repeats.",
    },
    {
      key: "interpretation",
      title: "Interpretation",
      content: "The response is consistent with a metastable memory branch, not yet an equilibrium selection result.",
    },
    {
      key: "conclusion",
      title: "Conclusion",
      content: "Continue with the no-drive recovery control and attach the raw field snapshots.",
    },
  ],
  references: [
    {
      id: "reference:field-notes",
      kind: "reference",
      title: "Field notes · 2026-09-12",
    },
  ],
  artifacts: [
    {
      id: "artifact:run-017",
      kind: "artifact",
      title: "Run 017 configuration",
      mediaType: "application/json",
    },
  ],
  metrics: [
    {
      id: "metric:1",
      name: "winding_retention",
      value: 0.82,
      step: 120,
      source: "manual",
      timestamp: "2026-09-15T14:22:00Z",
    },
  ],
  linkedRecordIds: ["control-zero-field-004"],
  provenance: {
    source: "galaxy-brain-eln",
    tenantId: "preview-lab",
    principalId: "researcher",
    hamNodeId: "ham:preview:017",
    createdAt: "2026-09-12T10:00:00Z",
    updatedAt: "2026-09-15T14:22:00Z",
  },
}

export default function ElnSemanticZoomPreviewPage() {
  if (!devPreviewsEnabled()) notFound()

  return (
    <main className="research-workbench min-h-screen px-4 py-10 sm:px-8 lg:px-12">
      <div className="mx-auto max-w-[1500px]">
        <header className="mb-5 flex flex-col gap-1 border-b border-[#456c59]/25 pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="research-kicker">Development Design Lab · Synthetic Data</p>
            <h1 className="research-display mt-1 text-3xl font-semibold text-[#18372b]">ELN Semantic Zoom Preview</h1>
          </div>
          <p className="research-prose text-sm italic text-[#61766b]">Atlas → Board → Record → Source</p>
        </header>

        <TaskWorkspaceSurface
          record={previewRecord}
          defaultScale="atlas"
          task={{
            id: previewRecord.provenance.hamNodeId,
            goal: previewRecord.sections[0].content,
            state: "linked",
          }}
        >
          <div className="eln-record-editor space-y-6">
            {previewRecord.sections.map((section) => (
              <section key={section.key} className="space-y-2">
                <label className="text-sm font-semibold" htmlFor={`preview-${section.key}`}>
                  {section.title}
                </label>
                <textarea
                  id={`preview-${section.key}`}
                  className="min-h-28 w-full resize-y"
                  defaultValue={section.content}
                />
              </section>
            ))}
          </div>
        </TaskWorkspaceSurface>
      </div>
    </main>
  )
}
