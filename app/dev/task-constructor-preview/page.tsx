import { notFound } from "next/navigation"

import { devPreviewsEnabled } from "@/lib/dev-previews"

import { TaskConstructor } from "@/components/tasks/task-constructor"
import type { TaskSummary } from "@/lib/types/tasks"

const previewTask: TaskSummary = {
  id: "ham-task-constructor-preview",
  projectRef: "galaxy-brain",
  version: 7,
  title: "Map mechanisms across a research corpus",
  goal: "Trace helicity and vortex mechanisms across papers, challenge the proposed equivalences, and synthesize a cited proof map.",
  why: "The useful relationship is often a specific mechanism rather than a whole-document similarity.",
  state: "running",
  lifecyclePhase: "running",
  stage: "Designing evidence branches",
  riskMode: "diagnostic",
  expectedEffects: [],
  resources: [],
  conflicts: [],
  projectionSource: "ham",
}

export default function TaskConstructorPreviewPage() {
  if (!devPreviewsEnabled()) notFound()
  return (
    <main className="research-workbench min-h-screen p-3 sm:p-6">
      <div className="mx-auto max-w-[1800px]">
        <TaskConstructor task={previewTask} mode="preview" />
      </div>
    </main>
  )
}
