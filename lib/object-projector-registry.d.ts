import type { GalaxyObjectProjection } from "./object-projection"
import type { GalaxyPluginRegistry } from "./plugins/registry.js"

export type SemanticZoomLevelId = "far" | "medium" | "near" | "detail"
export type ObjectProjectionContext = "list" | "graph" | "canvas" | "detail"

export interface SemanticZoomLevel {
  id: SemanticZoomLevelId
  minimumZoom: number
  representation: "glyph" | "label" | "card" | "detail"
}

export interface ObjectProjectorDefinition {
  id: "paper" | "image" | "audio" | "document" | "document-anchor" | "markdown" | "media" | "eln" | "task" | "proof" | "ham-memory" | "surface" | "unknown"
  label: string
  kinds: readonly string[]
  mediaFamilies: readonly string[]
  levels: readonly SemanticZoomLevel[]
  motion: typeof PROJECTOR_MOTION_POLICY
  tokenScope: "living-field"
  pluginId: string | null
  plugin: Readonly<{
    id: string
    displayName: string
    version: string
  }> | null
  implementationId: string | null
  diagnostic: "projector_unavailable" | null
}

export interface SelectedObjectRepresentation {
  projection: GalaxyObjectProjection
  projector: ObjectProjectorDefinition
  level: SemanticZoomLevel
  representation: "glyph" | "label" | "card" | "detail" | "placeholder"
  placeholder: boolean
}

export const SEMANTIC_ZOOM_LEVELS: readonly SemanticZoomLevel[]
export const PROJECTOR_MOTION_POLICY: Readonly<{
  placeholderAboveLevel: "medium"
  settleDelayMs: 120
  placeholderRepresentation: "placeholder"
}>
export const BUILTIN_OBJECT_PROJECTORS: readonly ObjectProjectorDefinition[]
export function semanticZoomLevelFor(zoom: number): SemanticZoomLevel
export function getObjectProjector(
  projection: GalaxyObjectProjection | unknown,
  registry?: GalaxyPluginRegistry,
): ObjectProjectorDefinition
export function selectObjectRepresentation(
  projection: GalaxyObjectProjection | unknown,
  zoom: number,
  moving?: boolean,
  registry?: GalaxyPluginRegistry,
): SelectedObjectRepresentation
export function projectionForContext(
  projection: GalaxyObjectProjection | unknown,
  context: ObjectProjectionContext,
  zoom: number,
  moving?: boolean,
  registry?: GalaxyPluginRegistry,
): SelectedObjectRepresentation & { context: ObjectProjectionContext }
