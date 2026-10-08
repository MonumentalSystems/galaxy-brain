"use client"

import { useEffect, useMemo, useState } from "react"

import { MarkdownRenderer } from "@/components/markdown-renderer"
import { DocumentStructureReader } from "@/components/papers/document-structure-reader"
import {
  atlasExactRepresentationDescriptor,
  loadAtlasExactRepresentationIfEligible,
  parseAtlasExactStructure,
} from "@/lib/atlas-exact-representation.js"
import type { GalaxyObjectProjection } from "@/lib/object-projection"
import { cn } from "@/lib/utils"

export function AtlasExactRepresentation({
  projection,
  documentRevisionId,
  authorizationScope,
  eligible,
  detail,
  fetcher = fetch,
}: {
  projection: GalaxyObjectProjection
  documentRevisionId: string
  authorizationScope: string
  eligible: boolean
  detail: boolean
  fetcher?: typeof fetch
}) {
  const descriptor = useMemo(() => {
    try {
      return atlasExactRepresentationDescriptor(projection, documentRevisionId)
    } catch {
      return null
    }
  }, [documentRevisionId, projection])
  const [loaded, setLoaded] = useState<{
    authorizationScope: string
    identity: string
    content: string
  } | null>(null)

  useEffect(() => {
    if (!descriptor) return undefined
    const controller = new AbortController()
    loadAtlasExactRepresentationIfEligible(descriptor, {
      authorizationScope,
      eligible,
      fetcher,
      signal: controller.signal,
    }).then((content) => {
      if (!controller.signal.aborted && content !== null) {
        setLoaded({ authorizationScope, identity: descriptor.identity, content })
      }
    }).catch(() => {
      // The authorized summary remains the fail-closed card representation.
    })
    return () => controller.abort()
  }, [authorizationScope, descriptor, eligible, fetcher])

  const content = eligible && loaded?.authorizationScope === authorizationScope
    && loaded.identity === descriptor?.identity ? loaded.content : null
  if (!descriptor || content === null) return null
  if (descriptor.kind === "structure") {
    const structure = parseAtlasExactStructure(content)
    if (!structure) return null
    return (
      <div
        data-slot="atlas-exact-representation"
        data-representation-ref={descriptor.representationRef}
        className={cn(!detail && "max-h-40 overflow-hidden")}
      >
        <DocumentStructureReader structure={structure} className="p-0" />
      </div>
    )
  }
  if (descriptor.markdown) {
    return (
      <div
        data-slot="atlas-exact-representation"
        data-representation-ref={descriptor.representationRef}
        className={cn(!detail && "max-h-40 overflow-hidden")}
      >
        <MarkdownRenderer
          content={content}
          images="omit"
          className="research-markdown object-projection__markdown"
        />
      </div>
    )
  }
  return (
    <pre
      data-slot="atlas-exact-representation"
      data-representation-ref={descriptor.representationRef}
      className={cn(
        "overflow-auto whitespace-pre-wrap rounded-lg border border-[color:var(--research-line)] bg-[#fffdf7] p-3 font-mono text-xs leading-5 text-[#1e2a24]",
        detail ? "max-h-[32rem]" : "max-h-40",
      )}
      tabIndex={detail ? 0 : -1}
    ><code>{content}</code></pre>
  )
}
