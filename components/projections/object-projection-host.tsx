"use client"

import { useId, useMemo, type ComponentPropsWithoutRef, type ReactNode } from "react"

import { InlineMathText } from "@/components/inline-math-text"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { AtlasExactRepresentation } from "@/components/projections/atlas-exact-representation"
import { ExactImageProjection } from "@/components/projections/exact-image-projection"
import { ExactAudioProjection } from "@/components/projections/exact-audio-projection"
import { SurfaceRenderer } from "@/components/surfaces/surface-renderer"
import { createGalaxyObjectProjection } from "@/lib/object-projection"
import {
  projectionForContext,
  type ObjectProjectionContext,
} from "@/lib/object-projector-registry"
import type {
  GalaxyObjectProjection,
  GalaxyRepresentationRef,
} from "@/lib/object-projection"
import { getSurfaceRenderer } from "@/lib/surface-renderer-registry"
import type { GalaxySurfaceSpec } from "@/lib/types/surfaces"
import { cn } from "@/lib/utils"

export type ResolvedProjectionRepresentation = {
  ref: string
  mediaType: string
  contentHash?: string | null
  content: string
}

export type ObjectProjectionHostProps = Omit<ComponentPropsWithoutRef<"article">, "children"> & {
  projection: GalaxyObjectProjection
  /** Authorized exact revision UUID returned beside a durable document projection. */
  documentRevisionId?: string
  context?: ObjectProjectionContext
  zoom?: number
  moving?: boolean
  /** Transient, already-authorized body for a representation named by projection.representations. */
  resolvedRepresentation?: ResolvedProjectionRepresentation
  /** Transient, validated surface definition. It is not persisted by this host. */
  surfaceSpec?: GalaxySurfaceSpec
  /** Transient renderer-owned preview for an exact named representation. */
  representationPreview?: ReactNode
  /** Allow this mounted, viewport-qualified host to stream immutable rich bytes. */
  streamExactRepresentation?: boolean
  /** Tenant/principal-bound cache namespace owned by the active Atlas client. */
  exactRepresentationAuthorizationScope?: string
  actions?: ReactNode
}

function matchingRepresentation(
  projection: GalaxyObjectProjection,
  resolved?: ResolvedProjectionRepresentation,
): GalaxyRepresentationRef | null {
  if (!resolved) return null
  return projection.representations.find((item) => (
    item.ref === resolved.ref
    && item.mediaType === resolved.mediaType
    && (item.contentHash === null || item.contentHash === resolved.contentHash)
  )) ?? null
}

export function ObjectProjectionHost({
  projection,
  documentRevisionId,
  context = "detail",
  zoom = 3,
  moving = false,
  resolvedRepresentation,
  surfaceSpec,
  representationPreview,
  streamExactRepresentation = true,
  exactRepresentationAuthorizationScope,
  actions,
  className,
  ...articleProps
}: ObjectProjectionHostProps) {
  const titleId = useId()
  /*
    Memoised because this builds a fresh projection object every call, and
    consumers key their work on it. Dragging changes `moving` on every pointer
    move, so an unmemoised call handed the exact-image loader a new object each
    frame: its effect refired, its cleanup revoked the object URL, and a
    decoded image was discarded and refetched continuously while the card moved.

    Zoom and motion only select which representation to show, so they belong in
    the dependencies; the projection's own identity is what must stay stable.
  */
  const selected = useMemo(
    () => projectionForContext(projection, context, zoom, moving),
    [context, moving, projection, zoom],
  )
  /*
    Motion and zoom choose a representation; they do not change the object
    being represented. Each call rebuilds the projection though, so consumers
    that key work on it — the exact-image loader above all — saw a new object
    on every pointer move: its effect refired, its cleanup revoked the object
    URL, and a decoded image was discarded and refetched for the length of a
    drag. Deriving it from the input alone keeps it steady while the chosen
    representation changes around it.
  */
  const stableProjection = useMemo(() => createGalaxyObjectProjection(projection), [projection])
  const bodyRepresentation = matchingRepresentation(selected.projection, resolvedRepresentation)
  const showBody = selected.level.id === "near" || selected.level.id === "detail"
  const showDetail = selected.level.id === "detail"
  const surfaceRenderer = showDetail && selected.projector.id === "surface" && surfaceSpec
    ? getSurfaceRenderer(surfaceSpec)
    : null

  return (
    <article
      {...articleProps}
      data-slot="object-projection"
      data-projector={selected.projector.id}
      data-projector-plugin={selected.projector.pluginId ?? undefined}
      data-projector-version={selected.projector.plugin?.version ?? undefined}
      data-projector-diagnostic={selected.projector.diagnostic ?? undefined}
      data-context={context}
      data-zoom-level={selected.level.id}
      data-motion={moving ? "moving" : "settled"}
      aria-labelledby={titleId}
      aria-busy={selected.placeholder || undefined}
      className={cn("object-projection", className)}
    >
      <header data-slot="object-projection-header" className="object-projection__header">
        <div className="object-projection__identity">
          <span className="object-projection__kind">
            {selected.projector.diagnostic === "projector_unavailable"
              ? "Projector unavailable"
              : selected.projector.label}
          </span>
          <span className="object-projection__revision">
            {selected.projection.revision.id ?? selected.projection.revision.policy}
          </span>
        </div>
        <h2 id={titleId} className="object-projection__title">
          <InlineMathText>{selected.projection.title}</InlineMathText>
        </h2>
        <p className="object-projection__projector">
          <span>Projector</span>
          {selected.projector.plugin ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="object-projection__projector-name">
                {selected.projector.plugin.displayName}
              </span>
              <span className="object-projection__projector-id">
                {selected.projector.plugin.id}@{selected.projector.plugin.version}
              </span>
            </>
          ) : (
            <>
              <span aria-hidden="true">·</span>
              <span>unavailable</span>
            </>
          )}
        </p>
      </header>

      {selected.placeholder ? (
        <div data-slot="object-projection-placeholder" className="object-projection__placeholder">
          <span className="sr-only">Representation simplified while the view is moving.</span>
        </div>
      ) : showBody ? (
        <div data-slot="object-projection-body" className="object-projection__body">
          {selected.projector.diagnostic === "projector_unavailable" ? (
            <div className="object-projection__diagnostic">
              <strong>Projector unavailable</strong>
              <p>
                No registered code-owned projector handles <code>{selected.projection.kind}</code>;
                identity and authorized source metadata remain available.
              </p>
            </div>
          ) : null}
          {streamExactRepresentation && selected.projector.id === "image" ? (
            <ExactImageProjection
              projection={stableProjection}
              documentRevisionId={documentRevisionId}
            />
          ) : null}
          {selected.projector.id === "audio" && !showDetail && selected.projection.audioOriginal ? (
            <p data-slot="object-projection-audio-metadata" className="object-projection__media">
              {selected.projection.audioOriginal.container.toUpperCase()} · {selected.projection.audioOriginal.codec.toUpperCase()}
              {" · "}{selected.projection.audioOriginal.channels === 1 ? "Mono" : "Stereo"}
              {" · "}{selected.projection.audioOriginal.byteSize} bytes
            </p>
          ) : null}
          {streamExactRepresentation && showDetail && selected.projector.id === "audio" ? (
            <ExactAudioProjection
              projection={stableProjection}
              documentRevisionId={documentRevisionId}
            />
          ) : null}
          {selected.projector.diagnostic === null && representationPreview ? (
            <div data-slot="object-projection-representation" className="object-projection__representation">
              {representationPreview}
            </div>
          ) : null}
          {streamExactRepresentation && selected.projector.id === "document"
            && documentRevisionId && exactRepresentationAuthorizationScope ? (
            <AtlasExactRepresentation
              projection={stableProjection}
              documentRevisionId={documentRevisionId}
              authorizationScope={exactRepresentationAuthorizationScope}
              eligible
              detail={showDetail}
            />
          ) : null}
          {showDetail && selected.projector.id === "markdown" && bodyRepresentation && resolvedRepresentation ? (
            <MarkdownRenderer
              content={resolvedRepresentation.content}
              images="omit"
              className="research-markdown object-projection__markdown"
            />
          ) : null}
          {surfaceRenderer?.implementationId === "builtin.surface-renderer.generous-a2ui" && surfaceSpec ? (
            <div className="object-projection__surface">
              <SurfaceRenderer spec={surfaceSpec} />
            </div>
          ) : null}
          {selected.projection.summary ? (
            <p className={cn(
              "object-projection__summary",
              showDetail && bodyRepresentation && "object-projection__summary--secondary",
            )}>
              {selected.projection.summary}
            </p>
          ) : null}
          {showDetail && selected.projector.id === "media" ? (
            <p className="object-projection__media">
              {selected.projection.mediaType ?? "Media"} · open the authorized representation to inspect it.
            </p>
          ) : null}
          {!selected.projection.summary && !bodyRepresentation
            && selected.projector.id !== "surface"
            && (!streamExactRepresentation
              || (selected.projector.id !== "image" && selected.projector.id !== "audio")) ? (
            <p className="object-projection__empty">No preview is available for this authorized projection.</p>
          ) : null}
        </div>
      ) : null}

      <footer data-slot="object-projection-footer" className="object-projection__footer">
        <span className="object-projection__source">
          <span className="object-projection__source-label">Source</span>
          <span className="object-projection__provider">{selected.projection.provenance.provider}</span>
        </span>
        <span className="object-projection__ref" title={selected.projection.ref}>
          {selected.projection.ref}
        </span>
        {actions ? <div className="object-projection__actions">{actions}</div> : null}
      </footer>
    </article>
  )
}
