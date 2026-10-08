"use client"

import { Loader2 } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import {
  ExactImageDocumentError,
  exactImageProjectionDescriptor,
  loadExactImageObjectUrl,
  type ExactImageObjectUrl,
} from "@/lib/document-image-reader.js"
import type { GalaxyObjectProjection } from "@/lib/object-projection"

export function ExactImageProjection({
  projection,
  documentRevisionId,
  fetcher = fetch,
}: {
  projection: GalaxyObjectProjection
  documentRevisionId?: string
  fetcher?: typeof fetch
}) {
  const state = useMemo(() => {
    try {
      return { descriptor: exactImageProjectionDescriptor(projection, documentRevisionId ?? ""), error: "" }
    } catch (error) {
      return { descriptor: null, error: error instanceof Error ? error.message : "Image projection is invalid" }
    }
  }, [documentRevisionId, projection])
  const descriptorKey = state.descriptor
    ? `${state.descriptor.revisionId}:${state.descriptor.representationId}:${state.descriptor.contentSha256}`
    : ""
  const [loadState, setLoadState] = useState<{
    key: string
    image: ExactImageObjectUrl | null
    error: string
  }>({ key: "", image: null, error: "" })
  const activeLoad = loadState.key === descriptorKey ? loadState : null

  useEffect(() => {
    if (!state.descriptor) return undefined
    const descriptor = state.descriptor
    const key = descriptorKey
    const controller = new AbortController()
    let loaded: ExactImageObjectUrl | null = null
    setLoadState({ key, image: null, error: "" })
    loadExactImageObjectUrl(descriptor, { fetcher, signal: controller.signal }).then((value) => {
      loaded = value
      if (controller.signal.aborted) value.revoke()
      else setLoadState({ key, image: value, error: "" })
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        setLoadState({
          key,
          image: null,
          error: reason instanceof ExactImageDocumentError ? reason.message : "Exact image unavailable",
        })
      }
    })
    return () => {
      controller.abort()
      loaded?.revoke()
    }
  }, [descriptorKey, fetcher, state.descriptor])

  if (state.error || activeLoad?.error) {
    return <p className="object-projection__empty" role="alert">{state.error || activeLoad?.error}</p>
  }
  if (!activeLoad?.image) {
    return <p className="inline-flex items-center gap-2" role="status" aria-live="polite"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Verifying exact image…</p>
  }
  return (
    <div data-slot="object-projection-image" className="grid place-items-center overflow-hidden rounded-lg bg-[#111714]">
      {/* eslint-disable-next-line @next/next/no-img-element -- exact verified Blob URL must not leave the origin */}
      <img
        src={activeLoad.image.url}
        alt={projection.title}
        width={state.descriptor?.rasterImage.width}
        height={state.descriptor?.rasterImage.height}
        className="max-h-[28rem] max-w-full object-contain"
      />
    </div>
  )
}
