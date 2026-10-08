import { notFound } from "next/navigation"

import { devPreviewsEnabled } from "@/lib/dev-previews"

import { SemanticFieldPreviewClient } from "@/app/dev/semantic-field-preview/semantic-field-preview-client"

export default function SemanticFieldPreviewPage() {
  // This route renders synthetic architecture fixtures. Never expose it from a
  // production build where it could be mistaken for canonical Galaxy data.
  if (!devPreviewsEnabled()) notFound()

  return (
    <main className="research-workbench h-screen p-3">
      <SemanticFieldPreviewClient />
    </main>
  )
}
