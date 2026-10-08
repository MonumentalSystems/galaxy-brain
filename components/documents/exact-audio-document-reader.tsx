"use client"

import { AudioLines, Loader2, ShieldCheck } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import {
  ExactAudioDocumentError,
  exactAudioDocumentDescriptor,
  loadExactAudioObjectUrl,
  type ExactAudioObjectUrl,
} from "@/lib/document-audio-reader.js"
import type { DurableDocumentRevision } from "@/lib/paper-reader-client"

export function ExactAudioDocumentReader({
  revision,
  fetcher = fetch,
}: {
  revision: DurableDocumentRevision
  fetcher?: typeof fetch
}) {
  const descriptorState = useMemo(() => {
    try {
      return { descriptor: exactAudioDocumentDescriptor(revision, revision.revision_id), error: "" }
    } catch (error) {
      return {
        descriptor: null,
        error: error instanceof Error ? error.message : "The exact audio metadata could not be verified.",
      }
    }
  }, [revision])
  const descriptor = descriptorState.descriptor
  const audioElementRef = useRef<HTMLAudioElement | null>(null)
  const [audio, setAudio] = useState<ExactAudioObjectUrl | null>(null)
  const [loadError, setLoadError] = useState("")

  useEffect(() => {
    if (!descriptor) return undefined
    const controller = new AbortController()
    let loaded: ExactAudioObjectUrl | null = null
    setAudio(null)
    setLoadError("")
    loadExactAudioObjectUrl(descriptor, { fetcher, signal: controller.signal }).then((value) => {
      loaded = value
      if (controller.signal.aborted) value.revoke()
      else setAudio(value)
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setLoadError(error instanceof ExactAudioDocumentError
        ? error.message : "The exact audio representation could not be opened.")
    })
    return () => {
      controller.abort()
      loaded?.revoke()
    }
  }, [descriptor, fetcher])

  useEffect(() => {
    if (!audio) return undefined
    const element = audioElementRef.current
    return () => {
      if (element?.src === audio.url) {
        element.pause()
        element.removeAttribute("src")
        element.load()
      }
      audio.revoke()
    }
  }, [audio])

  if (!descriptor) return <AudioFailure message={descriptorState.error} />
  return (
    <main className="research-workbench min-h-[calc(100vh-5rem)] bg-[hsl(var(--research-paper))] p-3 pb-24 text-[hsl(var(--research-ink))] sm:p-5 sm:pb-24">
      <article className="mx-auto max-w-4xl overflow-hidden rounded-2xl border border-[color:var(--research-line)] bg-[hsl(var(--research-panel))] shadow-sm" aria-labelledby="exact-audio-title">
        <header className="border-b border-[color:var(--research-line)] px-4 py-4 sm:px-7 sm:py-6">
          <p className="research-kicker flex items-center gap-2"><AudioLines aria-hidden="true" className="h-4 w-4" />Exact immutable audio</p>
          <h1 id="exact-audio-title" className="research-display mt-2 text-2xl font-semibold sm:text-3xl">{descriptor.title}</h1>
          <p className="research-muted mt-2 break-all font-mono text-xs">{descriptor.displayFilename}</p>
          <p className="research-muted mt-3 text-xs">
            WebM · Opus · {descriptor.audioOriginal.channels === 1 ? "mono" : "stereo"} · {descriptor.byteSize.toLocaleString()} bytes
          </p>
        </header>
        {loadError ? (
          <AudioFailure message={loadError} embedded />
        ) : audio === null ? (
          <section className="grid min-h-48 place-items-center p-8" aria-busy="true" role="status" aria-live="polite">
            <p className="inline-flex items-center gap-2"><Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" />Verifying exact audio bytes…</p>
          </section>
        ) : (
          <section className="grid min-h-48 place-items-center bg-[#eef2e8] p-6 sm:p-10" aria-label="Exact WebM Opus audio">
            <audio ref={audioElementRef} src={audio.url} controls preload="metadata" className="w-full max-w-2xl">
              Your browser does not support WebM/Opus audio playback.
            </audio>
          </section>
        )}
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[color:var(--research-line)] px-4 py-3 text-xs text-[hsl(var(--research-muted))] sm:px-7">
          <span className="inline-flex items-center gap-1.5"><ShieldCheck aria-hidden="true" className="h-4 w-4" />Identity, response headers, byte count, and SHA-256 verified before playback</span>
          <span className="max-w-full truncate font-mono" title={descriptor.documentRef}>{descriptor.documentRef}</span>
        </footer>
      </article>
    </main>
  )
}

function AudioFailure({ message, embedded = false }: { message: string; embedded?: boolean }) {
  const content = (
    <section className="m-4 max-w-xl rounded-xl border border-[#b66238]/35 bg-[#fff5ed] p-5 text-[#7f321f] sm:m-7" role="alert">
      <h1 className="research-display text-xl font-semibold">The exact audio could not be verified</h1>
      <p className="mt-2 text-sm">{message}</p>
      <p className="mt-2 text-xs">No unverified, redirected, or stale audio was exposed to the player.</p>
    </section>
  )
  return embedded ? content : (
    <main className="research-workbench grid min-h-[70vh] place-items-center bg-[hsl(var(--research-paper))] px-6 text-[hsl(var(--research-ink))]">
      {content}
    </main>
  )
}
