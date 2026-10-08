"use client"

import type { Node, NodeId } from "@canvas-harness/core"
import { useCamera, useIsMoving, useNode } from "@canvas-harness/react"
import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react"

import { InkPlacementPreview } from "@/components/atlas/ink-placement-preview"
import { ObjectProjectionHost } from "@/components/projections/object-projection-host"
import type { AtlasSurfaceHydrationResult } from "@/lib/atlas-surface-materialization"
import {
  GALAXY_CANVAS_NODE_TYPES,
  UNAVAILABLE_CANVAS_DISPLAY,
  type GalaxyCanvasDisplay,
  type GalaxyCanvasNodeData,
  type GalaxyCanvasNodeType,
} from "@/lib/canvas/galaxy-canvas-adapter"
import {
  projectCanvasNodeObject,
  resolvedCanvasNodeRepresentation,
} from "@/lib/canvas/canvas-object-projection"
import { authorizeInkPlacementDescriptor } from "@/lib/canvas/ink-placement.js"
import type { GalaxyObjectProjection } from "@/lib/object-projection"
import { parseGalaxyObjectReference } from "@/lib/galaxy-object-reference"
import { observeAtlasViewportVisibility } from "@/lib/atlas-viewport-visibility.js"
import type { GalaxySurfaceSpec } from "@/lib/types/surfaces"

type UnknownRecord = Record<string, unknown>

const PLACEMENT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum
  ) {
    return undefined
  }
  return value
}

function isGalaxyCanvasNodeType(value: unknown): value is GalaxyCanvasNodeType {
  return (
    typeof value === "string" &&
    (GALAXY_CANVAS_NODE_TYPES as readonly string[]).includes(value)
  )
}

function isGalaxySurfaceSpec(value: unknown): value is GalaxySurfaceSpec {
  const candidate = record(value)
  const catalog = record(candidate?.catalog)
  const update = record(candidate?.surfaceUpdate)
  return (
    candidate?.schema === "gb.surface.v1" &&
    catalog?.id === "generous.a2ui" &&
    catalog.version === "1" &&
    Array.isArray(update?.components) &&
    Array.isArray(candidate.bindings)
  )
}

function inkDescriptor(value: unknown, subjectRef: string, projection: GalaxyObjectProjection) {
  try {
    return authorizeInkPlacementDescriptor(value, subjectRef, projection)
  } catch {
    return null
  }
}

function readDisplay(value: unknown): GalaxyCanvasDisplay | null {
  const source = record(value)
  const title = boundedString(source?.title, 240)
  if (!source || !title) return null

  const badges = Array.isArray(source.badges)
    ? source.badges
        .slice(0, 8)
        .map((badge) => boundedString(badge, 80))
        .filter((badge): badge is string => Boolean(badge))
    : []

  const display: GalaxyCanvasDisplay = { title, badges }
  const subtitle = boundedString(source.subtitle, 320)
  const summary = boundedString(source.summary, 2_000)
  const revision = boundedString(source.revision, 160)
  const status = boundedString(source.status, 80)
  const provenance = boundedString(source.provenance, 320)
  const href = boundedString(source.href, 1_024)
  const markdown = boundedString(source.markdown, 12_000)
  const mediaType = boundedString(source.mediaType, 160)

  if (subtitle) display.subtitle = subtitle
  if (summary) display.summary = summary
  if (revision) display.revision = revision
  if (status) display.status = status
  if (provenance) display.provenance = provenance
  if (href?.startsWith("/")) display.href = href
  if (markdown) display.markdown = markdown
  if (mediaType) display.mediaType = mediaType
  if (isGalaxySurfaceSpec(source.surfaceSpec)) display.surfaceSpec = source.surfaceSpec

  return display
}

/**
 * Treat canvas node data as untrusted even after it passed through the
 * projection adapter. canvas-harness does not invoke NodeTypeDef.parse in
 * v0.2.0, so every DOM and canvas renderer narrows the envelope itself.
 */
export function readGalaxyCanvasNodeData(
  node: Pick<Node, "type" | "data">,
): GalaxyCanvasNodeData | null {
  if (!isGalaxyCanvasNodeType(node.type)) return null

  const source = record(node.data)
  const placementId = boundedString(source?.placementId, 128)
  const subjectRef = boundedString(source?.subjectRef, 1_024)
  const parsedSubjectRef = subjectRef ? parseGalaxyObjectReference(subjectRef) : null
  const availability = source?.availability === undefined || source.availability === "resolved"
    ? "resolved"
    : source.availability === "unavailable"
      ? "unavailable"
      : null
  const display = availability === "unavailable"
    ? { ...UNAVAILABLE_CANVAS_DISPLAY, badges: [...(UNAVAILABLE_CANVAS_DISPLAY.badges || [])] }
    : readDisplay(source?.display)
  const placementState = record(source?.placementState)
  const displayMode = boundedString(placementState?.displayMode, 80)
  const collapsed = placementState?.collapsed
  const style = record(placementState?.style)
  if (
    source?.schemaId !== "gb.canvas.node.v1" ||
    !availability ||
    !placementId ||
    !PLACEMENT_IDENTIFIER.test(placementId) ||
    !subjectRef ||
    parsedSubjectRef?.format !== "canonical" ||
    !display ||
    !displayMode ||
    typeof collapsed !== "boolean" ||
    !style
  ) {
    return null
  }

  return {
    schemaId: "gb.canvas.node.v1",
    placementId,
    subjectRef,
    availability,
    display,
    placementState: { displayMode, collapsed, style },
  }
}

/** Read-only, presentation-only DOM overlay for a projected Galaxy object. */
export function GalaxyCanvasNodeView({
  id,
  hydrationByReference,
  exactRepresentationAuthorizationScope,
}: {
  id: NodeId
  exactRepresentationAuthorizationScope?: string
  hydrationByReference?: Readonly<Record<
    string,
    AtlasSurfaceHydrationResult | { readonly status: "loading" }
  >>
}) {
  const node = useNode(id)
  const camera = useCamera()
  const harnessMoving = useIsMoving()
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [viewportVisible, setViewportVisible] = useState(false)
  const [settledCamera, setSettledCamera] = useState<{
    x: number
    y: number
    z: number
  } | null>(null)
  const moving = harnessMoving || !settledCamera
    || settledCamera.x !== camera.x
    || settledCamera.y !== camera.y
    || settledCamera.z !== camera.z
  const data = node ? readGalaxyCanvasNodeData(node) : null
  const hydration = data ? hydrationByReference?.[data.subjectRef] : undefined
  useEffect(() => {
    const next = { x: camera.x, y: camera.y, z: camera.z }
    const timeout = window.setTimeout(() => setSettledCamera(next), 120)
    return () => window.clearTimeout(timeout)
  }, [camera.x, camera.y, camera.z])
  useEffect(() => {
    if (!viewportRef.current) return undefined
    return observeAtlasViewportVisibility(viewportRef.current, setViewportVisible)
  }, [hydration?.status])
  if (!node || !data || !isGalaxyCanvasNodeType(node.type)) {
    return (
      <article
        aria-hidden="true"
        className="pointer-events-none h-full w-full overflow-hidden rounded-xl border border-destructive/30 bg-background/95 p-4 text-sm text-destructive shadow-sm"
      >
        Unavailable canvas item
      </article>
    )
  }

  if (hydration?.status === "resolved") {
    const ink = inkDescriptor(data.placementState.style, data.subjectRef, hydration.projection)
    return (
      <div ref={viewportRef} className="h-full w-full">
        <ObjectProjectionHost
          projection={hydration.projection}
          documentRevisionId={hydration.documentRevisionId}
          surfaceSpec={hydration.surfaceSpec}
          context="canvas"
          zoom={data.placementState.collapsed ? 0 : camera.z}
          moving={moving}
          streamExactRepresentation={viewportVisible && !data.placementState.collapsed}
          exactRepresentationAuthorizationScope={exactRepresentationAuthorizationScope}
          representationPreview={viewportVisible && !moving && !data.placementState.collapsed && ink ? (
            <InkPlacementPreview
              descriptor={ink}
              label={`${hydration.projection.title} ink drawing`}
              className="h-full min-h-24 w-full"
            />
          ) : undefined}
          aria-hidden="true"
          inert
          className="pointer-events-none h-full w-full select-none"
          data-canvas-node-type={node.type}
          data-canvas-display-mode={data.placementState.displayMode}
          data-canvas-collapsed={data.placementState.collapsed ? "true" : "false"}
        />
      </div>
    )
  }

  if (hydration || data.availability === "unavailable") {
    return <UnavailableCanvasObject aria-hidden="true" className="pointer-events-none h-full w-full select-none" />
  }

  const projection = projectCanvasNodeObject(node.type, data)
  const resolvedRepresentation = resolvedCanvasNodeRepresentation(node.type, data)
  return (
    <ObjectProjectionHost
      projection={projection}
      context="canvas"
      zoom={data.placementState.collapsed ? 0 : camera.z}
      resolvedRepresentation={resolvedRepresentation}
      surfaceSpec={data.display.surfaceSpec}
      aria-hidden="true"
      className="pointer-events-none h-full w-full select-none"
      data-canvas-node-type={node.type}
      data-canvas-display-mode={data.placementState.displayMode}
      data-canvas-collapsed={data.placementState.collapsed ? "true" : "false"}
    />
  )
}
export function UnavailableCanvasObject({
  className = "",
  ...articleProps
}: ComponentPropsWithoutRef<"article">) {
  return (
    <article
      {...articleProps}
      data-slot="unavailable-canvas-object"
      className={`object-projection ${className}`.trim()}
    >
      <header className="object-projection__header">
        <div className="object-projection__identity">
          <span className="object-projection__kind">Content locked</span>
        </div>
        <h2 className="object-projection__title">Preview unavailable</h2>
      </header>
      <div className="object-projection__body">
        <p className="object-projection__summary">
          The durable placement remains on this canvas while its object cannot be resolved.
        </p>
      </div>
      <footer className="object-projection__footer">
        <span className="object-projection__provider">No object content cached</span>
      </footer>
    </article>
  )
}
