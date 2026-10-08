import type { CanvasStore } from "@canvas-harness/core"

export const BLOCKED_CANVAS_STORE_METHODS: readonly (keyof CanvasStore)[]
export function asReadOnlyCanvasStore(store: CanvasStore): CanvasStore
export function asPlacementCanvasStore(store: CanvasStore): CanvasStore
