"use client"

import { useEffect, useRef, useState } from "react"

import type { InkPlacementDescriptor } from "@/lib/canvas/ink-placement.js"
import { handoffInkPreviewObjectUrl, loadInkPreviewObjectUrl } from "@/lib/ink-preview.js"
import { cn } from "@/lib/utils"

export function InkPlacementPreview({
  descriptor: input,
  label,
  className,
}: {
  descriptor: InkPlacementDescriptor
  label: string
  className?: string
}) {
  const [state, setState] = useState<{ url: string } | { error: true } | null>(null)
  const generationRef = useRef(0)
  const { schemaId, documentId, revisionSha256, documentRevisionId, representationId, contentSha256 } = input

  useEffect(() => {
    const generation = generationRef.current + 1
    generationRef.current = generation
    const controller = new AbortController()
    let objectUrl: string | null = null
    const isCurrent = () => generationRef.current === generation && !controller.signal.aborted
    setState(null)
    void loadInkPreviewObjectUrl({
      schemaId,
      documentId,
      revisionSha256,
      documentRevisionId,
      representationId,
      contentSha256,
    }, {
      signal: controller.signal,
      isCurrent,
    }).then((url) => {
      handoffInkPreviewObjectUrl(url, {
        isCurrent,
        revokeObjectUrl: (lateUrl) => URL.revokeObjectURL(lateUrl),
        publish: (currentUrl) => {
          objectUrl = currentUrl
          setState({ url: currentUrl })
        },
      })
    }).catch(() => {
      if (isCurrent()) setState({ error: true })
    })
    return () => {
      generationRef.current += 1
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [contentSha256, documentId, documentRevisionId, representationId, revisionSha256, schemaId])

  if (!state) {
    return <div className={cn("animate-pulse rounded-lg bg-[#d8c8a6]/30", className)} aria-label="Loading exact ink preview" />
  }
  if ("error" in state) {
    return (
      <div className={cn("grid place-items-center rounded-lg border border-dashed border-[#355f49]/25 bg-[#fffdf7] p-3 text-xs text-[#61766b]", className)}>
        Exact ink preview unavailable
      </div>
    )
  }
  // The source is a verified, short-lived Blob URL; Next Image cannot optimize this authenticated payload.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={state.url} alt={label} className={cn("rounded-lg bg-[#fffdf7] object-contain", className)} />
}
