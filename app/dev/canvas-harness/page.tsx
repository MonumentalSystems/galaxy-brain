import { notFound } from "next/navigation"

import { CanvasHarnessPreviewLoader } from "./canvas-harness-preview-loader"
import { devPreviewsEnabled } from "@/lib/dev-previews"

export default function CanvasHarnessPreviewPage() {
  if (!devPreviewsEnabled()) notFound()

  return <CanvasHarnessPreviewLoader />
}
