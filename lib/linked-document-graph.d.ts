export type LinkedProjectionProviderStatus = "ready" | "partial" | "unavailable" | null

export const LINKED_PROJECTION_LIMIT: 64
export function isPinnedDocumentProjectionReference(value: unknown): boolean
export function isPinnedChatProjectionReference(value: unknown): boolean
export function isPinnedSurfaceProjectionReference(value: unknown): boolean
export function isPinnedElnObservationProjectionReference(value: unknown): boolean
export function isLatestHamMemoryProjectionReference(value: unknown): boolean
export function isGraphGatewayProjectionReference(value: unknown): boolean
export function selectMissingLinkedProjectionReferences(
  links: readonly unknown[],
  authorizedReferences: Iterable<string>,
  limit?: number,
): { readonly references: readonly string[]; readonly total: number; readonly capped: boolean }
export function linkedProjectionProviderStatus(
  attemptedReferences: Iterable<string>,
  resolvedReferences: Iterable<string>,
  capped?: boolean,
): LinkedProjectionProviderStatus
