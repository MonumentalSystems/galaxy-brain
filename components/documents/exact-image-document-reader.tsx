"use client"

import { ImageIcon, Loader2, ShieldCheck } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import {
  ExactImageDocumentError,
  exactImageDocumentDescriptor,
  loadExactImageObjectUrl,
  type ExactImageDocumentDescriptor,
  type ExactImageObjectUrl,
} from "@/lib/document-image-reader.js"
import type { DurableDocumentRevision } from "@/lib/paper-reader-client"

export function ExactImageDocumentReader({
  revision,
  fetcher = fetch,
}: {
  revision: DurableDocumentRevision
  fetcher?: typeof fetch
}) {
  const descriptorState = useMemo<{ descriptor: ExactImageDocumentDescriptor | null; error: string }>(() => {
    try {
      return { descriptor: exactImageDocumentDescriptor(revision, revision.revision_id), error: "" }
    } catch (error) {
      return {
        descriptor: null,
        error: error instanceof Error ? error.message : "The exact image metadata could not be verified.",
      }
    }
  }, [revision])
  const descriptor = descriptorState.descriptor
  const [image, setImage] = useState<ExactImageObjectUrl | null>(null)
  const [loadError, setLoadError] = useState("")

  useEffect(() => {
    if (!descriptor) return undefined
    const controller = new AbortController()
    let loaded: ExactImageObjectUrl | null = null
    setImage(null)
    setLoadError("")
    loadExactImageObjectUrl(descriptor, { fetcher, signal: controller.signal }).then((value) => {
      loaded = value
      if (controller.signal.aborted) value.revoke()
      else setImage(value)
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setLoadError(error instanceof ExactImageDocumentError
        ? error.message
        : "The exact image representation could not be opened.")
    })
    return () => {
      controller.abort()
      loaded?.revoke()
    }
  }, [descriptor, fetcher])

  if (!descriptor) {
    return <ImageFailure message={descriptorState.error} />
  }
  return (
    <main className="research-workbench min-h-[calc(100vh-5rem)] bg-[hsl(var(--research-paper))] p-3 pb-24 text-[hsl(var(--research-ink))] sm:p-5 sm:pb-24">
      <article className="mx-auto max-w-6xl overflow-hidden rounded-2xl border border-[color:var(--research-line)] bg-[hsl(var(--research-panel))] shadow-sm" aria-labelledby="exact-image-title">
        <header className="border-b border-[color:var(--research-line)] px-4 py-4 sm:px-7 sm:py-6">
          <p className="research-kicker flex items-center gap-2"><ImageIcon aria-hidden="true" className="h-4 w-4" />Exact immutable image</p>
          <h1 id="exact-image-title" className="research-display mt-2 text-2xl font-semibold sm:text-3xl">{descriptor.title}</h1>
          <p className="research-muted mt-2 break-all font-mono text-xs">{descriptor.displayFilename}</p>
          <p className="research-muted mt-3 text-xs">
            {descriptor.rasterImage.width} × {descriptor.rasterImage.height} · {descriptor.mediaType}
          </p>
        </header>
        {loadError ? (
          <ImageFailure message={loadError} embedded />
        ) : image === null ? (
          <section className="grid min-h-72 place-items-center p-8" aria-busy="true" role="status" aria-live="polite">
            <p className="inline-flex items-center gap-2"><Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" />Verifying exact image bytes…</p>
          </section>
        ) : (
          <section className="grid min-h-72 place-items-center bg-[#111714] p-3 sm:p-7" aria-label="Exact raster image">
            {/* eslint-disable-next-line @next/next/no-img-element -- verified Blob URLs are intentionally not optimizer-routed */}
            <img
              src={image.url}
              alt={descriptor.title}
              width={descriptor.rasterImage.width}
              height={descriptor.rasterImage.height}
              className="max-h-[75vh] max-w-full object-contain"
            />
          </section>
        )}
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[color:var(--research-line)] px-4 py-3 text-xs text-[hsl(var(--research-muted))] sm:px-7">
          <span className="inline-flex items-center gap-1.5"><ShieldCheck aria-hidden="true" className="h-4 w-4" />Hash, response headers, decoder, and dimensions verified</span>
          <span className="max-w-full truncate font-mono" title={descriptor.documentRef}>{descriptor.documentRef}</span>
        </footer>
      </article>
    </main>
  )
}

function ImageFailure({ message, embedded = false }: { message: string; embedded?: boolean }) {
  const content = (
    <section className="m-4 max-w-xl rounded-xl border border-[#b66238]/35 bg-[#fff5ed] p-5 text-[#7f321f] sm:m-7" role="alert">
      <h1 className="research-display text-xl font-semibold">The exact image could not be verified</h1>
      <p className="mt-2 text-sm">{message}</p>
      <p className="mt-2 text-xs">No alternate, remote, or stale image was displayed.</p>
    </section>
  )
  return embedded ? content : (
    <main className="research-workbench grid min-h-[70vh] place-items-center bg-[hsl(var(--research-paper))] px-6 text-[hsl(var(--research-ink))]">
      {content}
    </main>
  )
}
