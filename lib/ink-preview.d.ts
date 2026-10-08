import type { InkPlacementDescriptor } from "./canvas/ink-placement.js"

export function handoffInkPreviewObjectUrl(
  url: string | null,
  options: {
    isCurrent: () => boolean
    publish: (url: string) => void
    revokeObjectUrl: (url: string) => void
  },
): boolean

export function loadInkPreviewObjectUrl(
  descriptor: InkPlacementDescriptor,
  options?: {
    fetcher?: typeof fetch
    signal?: AbortSignal
    isCurrent?: () => boolean
    digestBytes?: (bytes: Uint8Array) => Promise<string>
    createObjectUrl?: (blob: Blob) => string
    revokeObjectUrl?: (url: string) => void
  },
): Promise<string | null>
