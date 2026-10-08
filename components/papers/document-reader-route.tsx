"use client"

import Link from "next/link"
import { ArrowLeft, Loader2 } from "lucide-react"
import { useSearchParams } from "next/navigation"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"

import { AtlasReferenceHandoffLink } from "@/components/atlas/atlas-reference-handoff-link"
import { ExactTextDocumentReader } from "@/components/documents/exact-text-document-reader"
import { ExactImageDocumentReader } from "@/components/documents/exact-image-document-reader"
import { ExactAudioDocumentReader } from "@/components/documents/exact-audio-document-reader"
import { ExactDocxDocumentReader } from "@/components/documents/exact-docx-document-reader"
import { DurablePaperReader } from "@/components/papers/durable-paper-reader"
import {
  documentReaderRequestIdentity,
  shouldAcceptDocumentReaderCompletion,
} from "@/lib/document-reader-request.js"
import { isExactTextDocumentMediaType } from "@/lib/document-text-reader.js"
import { isExactRasterImageMediaType } from "@/lib/document-image-reader.js"
import { isExactAudioOriginalMediaType } from "@/lib/document-audio-reader.js"
import { isExactDocxMediaType } from "@/lib/document-docx-reader.js"
import {
  createDurablePaperTaskAction,
  createGalaxyPaperReaderActionPort,
  createGalaxyPaperReaderDataPort,
  loadDurableDocumentRevision,
  type DurableDocumentRevision,
} from "@/lib/paper-reader-client"

function ExactDocumentReaderSurface({
  revision,
  children,
}: {
  revision: DurableDocumentRevision
  children: ReactNode
}) {
  return (
    <>
      <div className="research-workbench bg-[hsl(var(--research-paper))] px-3 pt-3 text-[hsl(var(--research-ink))] sm:px-5 sm:pt-5">
        <div className="mx-auto flex max-w-[1680px] justify-end">
          <AtlasReferenceHandoffLink
            subjectRef={revision.ref}
            expectedDocumentId={revision.document_id}
            expectedDocumentRevisionId={revision.revision_id}
            expectedRevisionSha256={revision.revision_sha256}
          />
        </div>
      </div>
      {children}
    </>
  )
}

export function DocumentReaderRoute({
  documentRevisionId,
  tenantId,
  principalId,
}: {
  documentRevisionId: string
  tenantId: string
  principalId: string
}) {
  const requestIdentityKey = documentReaderRequestIdentity({ documentRevisionId, tenantId, principalId })
  return (
    <DocumentReaderRequest
      key={requestIdentityKey}
      requestIdentityKey={requestIdentityKey}
      documentRevisionId={documentRevisionId}
      tenantId={tenantId}
      principalId={principalId}
    />
  )
}

function DocumentReaderRequest({
  requestIdentityKey,
  documentRevisionId,
  tenantId,
  principalId,
}: {
  requestIdentityKey: string
  documentRevisionId: string
  tenantId: string
  principalId: string
}) {
  const searchParams = useSearchParams()
  const initialDocumentAnchorId = searchParams.get("documentAnchor") ?? undefined
  const generationRef = useRef(0)
  const [revision, setRevision] = useState<DurableDocumentRevision | null>(null)
  const [error, setError] = useState("")
  const dataPort = useMemo(() => createGalaxyPaperReaderDataPort(fetch), [])
  const createTask = useMemo(
    () => createDurablePaperTaskAction({ tenantId, principalId, documentRevisionId }),
    [documentRevisionId, principalId, tenantId],
  )
  const paperActionPort = useMemo(() => createGalaxyPaperReaderActionPort(
    fetch,
    createTask,
    {
      scope: { tenantId, principalId, documentRevisionId },
      storage: () => window.localStorage,
    },
  ), [createTask, documentRevisionId, principalId, tenantId])

  useEffect(() => {
    const controller = new AbortController()
    const requestGeneration = generationRef.current + 1
    generationRef.current = requestGeneration
    let active = true
    setRevision(null)
    setError("")
    loadDurableDocumentRevision(documentRevisionId, controller.signal).then((nextRevision) => {
      if (!shouldAcceptDocumentReaderCompletion(
        {
          active,
          aborted: controller.signal.aborted,
          generation: requestGeneration,
          identityKey: requestIdentityKey,
        },
        { generation: generationRef.current, identityKey: requestIdentityKey },
      )) return
      setRevision(nextRevision)
    }).catch((reason) => {
      if (!shouldAcceptDocumentReaderCompletion(
        {
          active,
          aborted: controller.signal.aborted,
          generation: requestGeneration,
          identityKey: requestIdentityKey,
        },
        { generation: generationRef.current, identityKey: requestIdentityKey },
      )) return
      setError(reason instanceof Error ? reason.message : "The exact document revision could not be loaded.")
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [documentRevisionId, requestIdentityKey])

  if (error) {
    return (
      <main className="research-workbench grid min-h-[70vh] place-items-center bg-[hsl(var(--research-paper))] px-6 text-[hsl(var(--research-ink))]">
        <section className="max-w-xl rounded-2xl border border-[color:var(--research-line)] bg-[hsl(var(--research-panel))] p-8 shadow-sm" role="alert">
          <p className="research-kicker">Exact document revision unavailable</p>
          <h1 className="research-display mt-2 text-2xl font-semibold">The reader could not restore this source.</h1>
          <p className="research-muted mt-3 text-sm">{error}</p>
          <Link href="/papers" className="mt-5 inline-flex min-h-11 items-center text-sm text-[hsl(var(--research-accent))] underline-offset-4 hover:underline">
            <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />Back to papers
          </Link>
        </section>
      </main>
    )
  }
  if (!revision) {
    return (
      <main className="research-workbench grid min-h-[70vh] place-items-center bg-[hsl(var(--research-paper))] text-[hsl(var(--research-ink))]" aria-busy="true">
        <p className="inline-flex items-center gap-2"><Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />Loading exact document revision…</p>
      </main>
    )
  }
  if (revision.artifact.media_type !== "application/pdf") {
    if (isExactDocxMediaType(revision.artifact.media_type)) {
      return (
        <ExactDocumentReaderSurface revision={revision}>
          <ExactDocxDocumentReader
            revision={revision}
            tenantId={tenantId}
            principalId={principalId}
            dataPort={dataPort}
          />
        </ExactDocumentReaderSurface>
      )
    }
    if (isExactRasterImageMediaType(revision.artifact.media_type)) {
      return (
        <ExactDocumentReaderSurface revision={revision}>
          <ExactImageDocumentReader revision={revision} />
        </ExactDocumentReaderSurface>
      )
    }
    if (isExactAudioOriginalMediaType(revision.artifact.media_type)) {
      return (
        <ExactDocumentReaderSurface revision={revision}>
          <ExactAudioDocumentReader revision={revision} />
        </ExactDocumentReaderSurface>
      )
    }
    if (isExactTextDocumentMediaType(revision.artifact.media_type)) {
      return (
        <ExactDocumentReaderSurface revision={revision}>
          <ExactTextDocumentReader
            revision={revision}
            tenantId={tenantId}
            principalId={principalId}
            dataPort={dataPort}
            actionPort={paperActionPort}
            initialAnchorId={initialDocumentAnchorId}
          />
        </ExactDocumentReaderSurface>
      )
    }
    return (
      <ExactDocumentReaderSurface revision={revision}>
        <main className="research-workbench grid min-h-[70vh] place-items-center bg-[hsl(var(--research-paper))] px-6 text-[hsl(var(--research-ink))]">
          <section className="max-w-xl rounded-2xl border border-[color:var(--research-line)] bg-[hsl(var(--research-panel))] p-8 shadow-sm" role="alert">
            <p className="research-kicker">Unsupported exact representation</p>
            <h1 className="research-display mt-2 text-2xl font-semibold">This document needs a registered detail renderer.</h1>
            <p className="research-muted mt-3 text-sm">The immutable original is preserved, but Galaxy will not send it through the PDF or text reader.</p>
            <Link href="/workspace" className="mt-5 inline-flex min-h-11 items-center text-sm text-[hsl(var(--research-accent))] underline-offset-4 hover:underline">
              <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />Back to Atlas
            </Link>
          </section>
        </main>
      </ExactDocumentReaderSurface>
    )
  }
  return (
    <ExactDocumentReaderSurface revision={revision}>
      <DurablePaperReader
        documentRevisionId={revision.revision_id}
        title={revision.title}
        tenantId={tenantId}
        principalId={principalId}
        actionPort={paperActionPort}
      />
    </ExactDocumentReaderSurface>
  )
}
