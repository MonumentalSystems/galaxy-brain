"use client"

import Link from "next/link"
import { ExternalLink, Loader2 } from "lucide-react"
import { useEffect, useState } from "react"

import { AtlasReferenceHandoffLink } from "@/components/atlas/atlas-reference-handoff-link"
import { ObjectProjectionHost } from "@/components/projections/object-projection-host"
import {
  hydrateAtlasObjectReferences,
  type AtlasObjectHydrationBatch,
  type AtlasObjectHydrationResult,
} from "@/lib/atlas-object-hydration"
import type { ExperimentAttachmentRef } from "@/lib/galaxy-brain-api"
import { getObjectProjector } from "@/lib/object-projector-registry"

export function ExperimentAttachmentList({ attachments }: { attachments: ExperimentAttachmentRef[] }) {
  const referenceIdentity = attachments.map((attachment) => attachment.ref).join("\0")
  const [resolution, setResolution] = useState<{
    identity: string
    batch: AtlasObjectHydrationBatch | null
    failed: boolean
  } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setResolution(null)
    const references = referenceIdentity ? referenceIdentity.split("\0") : []
    hydrateAtlasObjectReferences(references, { signal: controller.signal }).then((batch) => {
      if (active && !controller.signal.aborted) {
        setResolution({ identity: referenceIdentity, batch, failed: false })
      }
    }).catch(() => {
      if (active && !controller.signal.aborted) {
        setResolution({ identity: referenceIdentity, batch: null, failed: true })
      }
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [referenceIdentity])

  const currentResolution = resolution?.identity === referenceIdentity ? resolution : null
  const currentBatch = currentResolution?.batch ?? null
  return (
    <ul className="space-y-2">
      {attachments.map((attachment) => (
        <li key={attachment.attachmentId} className="space-y-1.5">
          <ExperimentAttachmentCard
            attachment={attachment}
            result={currentBatch?.byReference[attachment.ref] ?? null}
            failed={currentResolution?.failed ?? false}
          />
          <p className="truncate font-mono text-[11px] text-muted-foreground" title={attachment.ref}>
            revision {attachment.revisionSha256} · content {attachment.contentSha256}
          </p>
        </li>
      ))}
    </ul>
  )
}

function ExperimentAttachmentCard({
  attachment,
  result,
  failed,
}: {
  attachment: ExperimentAttachmentRef
  result: AtlasObjectHydrationResult | null
  failed: boolean
}) {
  const current = result?.requestedRef === attachment.ref ? result : null
  if (failed) {
    return <UnavailableAttachment title={attachment.title} />
  }
  if (!current) {
    return (
      <article className="object-projection" aria-busy="true" aria-label={`Loading ${attachment.title}`}>
        <div className="object-projection__body">
          <p className="object-projection__summary inline-flex items-center gap-2" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Resolving exact document…
          </p>
        </div>
      </article>
    )
  }

  if (current.status !== "resolved") {
    return <UnavailableAttachment title={attachment.title} />
  }

  const projector = getObjectProjector(current.projection)
  const registeredDocumentProjector = projector.pluginId === "documents"
  const openHandle = registeredDocumentProjector
    ? current.handles.find((handle) => handle.rel === "open" && handle.method === "GET")
    : undefined

  return (
    <ObjectProjectionHost
      projection={current.projection}
      context="list"
      zoom={1.5}
      actions={registeredDocumentProjector ? (
        <div className="flex flex-wrap items-center gap-3">
          {openHandle ? (
            <Link className="inline-flex items-center gap-1 text-xs underline underline-offset-4" href={openHandle.href}>
              Open exact document <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          ) : null}
          <AtlasReferenceHandoffLink
            subjectRef={attachment.ref}
            expectedDocumentRevisionId={attachment.documentRevisionId}
            expectedRevisionSha256={attachment.revisionSha256}
            resolution={current}
            className="border-0 px-0 text-xs"
          />
        </div>
      ) : undefined}
      className="bg-[hsl(var(--research-panel)/0.72)]"
    />
  )
}

function UnavailableAttachment({ title }: { title: string }) {
  return (
    <article className="object-projection" data-slot="unavailable-object-projection">
      <header className="object-projection__header">
        <div className="object-projection__identity">
          <span className="object-projection__kind">Content locked</span>
        </div>
        <h4 className="object-projection__title">{title}</h4>
      </header>
      <div className="object-projection__body">
        <p className="object-projection__summary">
          This pinned attachment remains recorded, but its registered document projection is unavailable.
        </p>
      </div>
      <footer className="object-projection__footer">
        <span className="object-projection__provider">No object content cached</span>
      </footer>
    </article>
  )
}
