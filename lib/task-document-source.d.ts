export type PinnedDocumentAnchorResource = {
  resourceRef: string
  anchorId: string
  revision: string
}

export type TaskDocumentSourceLink = {
  resourceRef: string
  anchorId: string
  href: string
}

export function parsePinnedDocumentAnchorResource(value: unknown): PinnedDocumentAnchorResource | null

export function loadTaskDocumentSources(
  resourceRefs: unknown[],
  options?: {
    fetcher?: typeof fetch
    signal?: AbortSignal
    concurrency?: number
  },
): Promise<TaskDocumentSourceLink[]>
