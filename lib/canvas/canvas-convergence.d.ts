import type { CanvasChangeEvent } from "./canvas-snapshot.js"

export const CANVAS_CHANGE_POLL_TIMEOUT_MS: 10000

export function isTerminalCanvasPollError(error: unknown): boolean

export function createCanvasChangePoller(options: {
  request: (signal: AbortSignal) => Promise<CanvasChangeEvent | null>
  onEvent: (event: CanvasChangeEvent | null) => "continue" | "stop"
  onTerminalError: (error: unknown) => void
  initialDelayMs?: number
  timeoutMs?: number
}): {
  start(): void
  setVisible(visible: boolean): void
  stop(): void
}
