import { notFound } from "next/navigation"

import { UnifiedGraphPreview } from "./unified-graph-preview"
import { devPreviewsEnabled } from "@/lib/dev-previews"

export default function UnifiedGraphPreviewPage() {
  if (!devPreviewsEnabled()) notFound()
  return (
    <main className="research-workbench min-h-screen p-3 sm:p-6">
      <UnifiedGraphPreview />
    </main>
  )
}
