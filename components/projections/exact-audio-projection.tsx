"use client"

import { Loader2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import {
  ExactAudioDocumentError,
  exactAudioProjectionDescriptor,
  loadExactAudioObjectUrl,
  type ExactAudioObjectUrl,
} from "@/lib/document-audio-reader.js"
import type { GalaxyObjectProjection } from "@/lib/object-projection"

export function ExactAudioProjection({
  projection,
  documentRevisionId,
  fetcher = fetch,
}: {
  projection: GalaxyObjectProjection
  documentRevisionId?: string
  fetcher?: typeof fetch
}) {
  const descriptorState = useMemo(() => {
    try {
      return { descriptor: exactAudioProjectionDescriptor(projection, documentRevisionId ?? ""), error: "" }
    } catch (error) {
      return { descriptor: null, error: error instanceof Error ? error.message : "Audio projection is invalid" }
    }
  }, [documentRevisionId, projection])
  const descriptor = descriptorState.descriptor
  const descriptorIdentity = descriptor
    ? `${descriptor.revisionId}:${descriptor.representationId}:${descriptor.contentSha256}`
    : ""
  const elementRef = useRef<HTMLAudioElement | null>(null)
  const [request, setRequest] = useState<{ identity: string; attempt: number } | null>(null)
  const [loaded, setLoaded] = useState<{ identity: string; audio: ExactAudioObjectUrl } | null>(null)
  const [failure, setFailure] = useState<{ identity: string; message: string } | null>(null)
  const requested = request?.identity === descriptorIdentity
  const activeAudio = loaded?.identity === descriptorIdentity ? loaded.audio : null
  const activeError = failure?.identity === descriptorIdentity ? failure.message : ""

  useEffect(() => {
    if (!descriptor || request?.identity !== descriptorIdentity) return undefined
    const controller = new AbortController()
    let exact: ExactAudioObjectUrl | null = null
    setLoaded(null)
    setFailure(null)
    loadExactAudioObjectUrl(descriptor, { fetcher, signal: controller.signal }).then((value) => {
      exact = value
      if (controller.signal.aborted) value.revoke()
      else setLoaded({ identity: descriptorIdentity, audio: value })
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        setFailure({
          identity: descriptorIdentity,
          message: reason instanceof ExactAudioDocumentError ? reason.message : "Exact audio unavailable",
        })
      }
    })
    return () => {
      controller.abort()
      exact?.revoke()
    }
  }, [descriptor, descriptorIdentity, fetcher, request])

  useEffect(() => {
    if (!activeAudio) return undefined
    const element = elementRef.current
    return () => {
      if (element?.src === activeAudio.url) {
        element.pause()
        element.removeAttribute("src")
        element.load()
      }
      activeAudio.revoke()
    }
  }, [activeAudio])

  const requestLoad = () => {
    if (!descriptorIdentity) return
    setRequest((current) => ({
      identity: descriptorIdentity,
      attempt: current?.identity === descriptorIdentity ? current.attempt + 1 : 1,
    }))
  }

  if (descriptorState.error) return <p className="object-projection__empty" role="alert">{descriptorState.error}</p>
  if (activeError) {
    return (
      <div className="space-y-2" role="alert">
        <p className="object-projection__empty">{activeError}</p>
        <button type="button" className="min-h-11 rounded-md border border-[#6d7a68] px-3 py-2" onClick={requestLoad}>
          Retry audio
        </button>
      </div>
    )
  }
  if (!requested) {
    return (
      <button
        type="button"
        className="min-h-11 rounded-md border border-[#6d7a68] px-3 py-2"
        onClick={requestLoad}
        aria-label={`Load exact audio for ${projection.title}`}
      >
        Load audio
      </button>
    )
  }
  if (!activeAudio) return <p className="inline-flex items-center gap-2" role="status" aria-live="polite"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Verifying exact audio…</p>
  return (
    <div data-slot="object-projection-audio" className="rounded-lg bg-[#eef2e8] p-3">
      <audio ref={elementRef} src={activeAudio.url} controls preload="metadata" className="w-full">
        Your browser does not support WebM/Opus audio playback.
      </audio>
    </div>
  )
}
