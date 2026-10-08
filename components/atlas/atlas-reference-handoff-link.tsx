"use client"

import Link from "next/link"
import { PanelsTopLeft } from "lucide-react"
import { useEffect, useState } from "react"

import {
  hydrateAtlasObjectReferences,
  type AtlasObjectHydrationResult,
} from "@/lib/atlas-object-hydration"
import {
  atlasReferenceHandoffHref,
  authorizeAtlasReferenceHandoff,
  inspectAtlasReferenceHandoff,
} from "@/lib/atlas-reference-handoff.js"
import { cn } from "@/lib/utils"

export type AtlasReferenceHandoffLinkProps = {
  subjectRef: string
  expectedDocumentId?: string
  expectedDocumentRevisionId?: string
  expectedRevisionSha256?: string
  /** Reuse an authorization result already resolved by the containing surface. */
  resolution?: AtlasObjectHydrationResult | null
  className?: string
}

type HydratedResolution = {
  subjectRef: string
  result: AtlasObjectHydrationResult | null
}

export function AtlasReferenceHandoffLink({
  subjectRef,
  expectedDocumentId,
  expectedDocumentRevisionId,
  expectedRevisionSha256,
  resolution,
  className,
}: AtlasReferenceHandoffLinkProps) {
  const [hydrated, setHydrated] = useState<HydratedResolution | null>(null)

  useEffect(() => {
    if (resolution !== undefined) return undefined
    const inspected = inspectAtlasReferenceHandoff(subjectRef)
    if (
      !inspected.ok
      || inspected.kind !== "document"
      || (expectedDocumentId !== undefined && inspected.objectId !== expectedDocumentId)
      || (expectedRevisionSha256 !== undefined && inspected.revisionSha256 !== expectedRevisionSha256)
    ) {
      setHydrated(null)
      return undefined
    }

    const controller = new AbortController()
    let active = true
    setHydrated(null)
    void hydrateAtlasObjectReferences([subjectRef], { signal: controller.signal }).then((batch) => {
      if (!active || controller.signal.aborted) return
      setHydrated({
        subjectRef,
        result: batch.byReference[subjectRef] ?? null,
      })
    }).catch(() => {
      if (active && !controller.signal.aborted) setHydrated(null)
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [expectedDocumentId, expectedRevisionSha256, resolution, subjectRef])

  const currentResolution = resolution !== undefined
    ? resolution
    : hydrated?.subjectRef === subjectRef
      ? hydrated.result
      : null
  const authorization = authorizeAtlasReferenceHandoff(subjectRef, currentResolution, {
    kind: "document",
    ...(expectedDocumentId === undefined ? {} : { objectId: expectedDocumentId }),
    ...(expectedDocumentRevisionId === undefined
      ? {}
      : { sourceRevisionId: expectedDocumentRevisionId }),
    ...(expectedRevisionSha256 === undefined
      ? {}
      : { revisionSha256: expectedRevisionSha256 }),
  })
  if (!authorization.ok) return null

  return (
    <Link
      href={atlasReferenceHandoffHref(authorization.subjectRef)}
      className={cn(
        "inline-flex min-h-11 items-center gap-1.5 rounded-md border border-current/20 px-3 text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current",
        className,
      )}
    >
      <PanelsTopLeft className="h-4 w-4" aria-hidden="true" />
      Place document in Atlas
    </Link>
  )
}
