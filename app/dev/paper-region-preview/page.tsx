import { notFound } from "next/navigation"

import { devPreviewsEnabled } from "@/lib/dev-previews"

import { PaperRegionPreview } from "@/components/papers/paper-region-preview"

export default async function PaperRegionPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ mechanism?: string }>
}) {
  if (!devPreviewsEnabled()) notFound()
  const { mechanism } = await searchParams
  return <PaperRegionPreview initialMechanism={mechanism} />
}
