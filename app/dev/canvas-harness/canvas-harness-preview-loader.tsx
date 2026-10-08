"use client"

import dynamic from "next/dynamic"

const CanvasHarnessPreviewClient = dynamic(
  () => import("./canvas-harness-preview-client").then((module) => module.CanvasHarnessPreviewClient),
  {
    ssr: false,
    loading: () => (
      <main className="grid min-h-screen place-items-center bg-[#dfe9e0] px-6 text-center text-[#315f49]">
        <div>
          <p className="research-kicker">Development-only compatibility spike</p>
          <p className="research-display mt-2 text-2xl font-semibold">Loading the client canvas…</p>
        </div>
      </main>
    ),
  },
)

/** canvas-harness hooks do not expose a server snapshot in v0.2.0. */
export function CanvasHarnessPreviewLoader() {
  return <CanvasHarnessPreviewClient />
}
