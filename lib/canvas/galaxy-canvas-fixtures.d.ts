import type { GalaxyCanvasProjection } from "./galaxy-canvas-adapter"

/** Synthetic, already-authorized research projection for the development route. */
export function buildResearchCanvasFixture(): GalaxyCanvasProjection

export const canvasHarnessPreviewProjection: GalaxyCanvasProjection

/** Deterministic minimal projection used to measure primitive/LOD throughput. */
export function buildPrimitiveCanvasFixture(count?: number): GalaxyCanvasProjection
