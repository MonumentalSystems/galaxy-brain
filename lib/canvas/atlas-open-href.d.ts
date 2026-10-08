import type { GalaxyCanvasNodeData } from "./galaxy-canvas-adapter.js"

export type AtlasOpenHrefHydration = {
  status: string
  requestedRef?: string
  resolvedRef?: string
  documentRevisionId?: string
  handles?: ReadonlyArray<{ href: string }>
}

export type AtlasOpenAction = Readonly<{
  href: string
  label: "Open document" | "Open conversation tree" | "Open canonical view"
}>

export function openHrefForAtlasNode(
  data: GalaxyCanvasNodeData,
  hydration?: AtlasOpenHrefHydration,
): string | undefined

export function openActionForAtlasNode(
  data: GalaxyCanvasNodeData,
  hydration?: AtlasOpenHrefHydration,
): AtlasOpenAction | undefined
