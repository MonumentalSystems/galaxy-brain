import type { CanvasRecord } from "../types/canvas"

export const ATLAS_CANVAS_CATALOG_LIMIT: 50
export const DEFAULT_ATLAS_WORKSPACE_ID: "default-workspace"

export function selectAtlasWorkspaceId(
  activeCanvas: Pick<CanvasRecord, "workspaceId"> | null,
  tenantCanvases: readonly Pick<CanvasRecord, "workspaceId" | "isDefault">[],
  browserWorkspaces: readonly Readonly<{ id: string }>[],
): string

export function normalizeAtlasCanvasCatalog(
  records: readonly CanvasRecord[],
  options: {
    workspaceId: string
    activeCanvas?: CanvasRecord | null
    requestedCanvasId?: string | null
  },
): Readonly<{
  canvases: readonly CanvasRecord[]
  potentiallyPartial: boolean
}>

export function findAtlasCanvasSwitchTarget(
  canvases: readonly CanvasRecord[],
  workspaceId: string,
  activeCanvasId: string | null,
  targetCanvasId: string,
): CanvasRecord | null

export function atlasCanvasSwitchHasPendingWork(state: Readonly<Record<string, boolean>>): boolean
