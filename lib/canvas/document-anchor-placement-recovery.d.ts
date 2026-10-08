export type DocumentAnchorPlacementRecoveryScope = {
  tenantId: string
  principalId: string
  documentRevisionId: string
  anchorId: `sha256:${string}`
}

export type DocumentAnchorPlacementRecoveryStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>

export type PendingDocumentAnchorPlacementRecovery = Readonly<{
  schemaId: "gb.document-anchor-placement-recovery.v1"
  state: "pending"
  canvasId: string
  generation: number
  operationId: string
}>

export type ConfirmedDocumentAnchorPlacementRecovery = Readonly<{
  schemaId: "gb.document-anchor-placement-recovery.v1"
  state: "confirmed"
  canvasId: string
  generation: number
  operationId: string
  placementId: string
}>

export type DocumentAnchorPlacementRecovery =
  | PendingDocumentAnchorPlacementRecovery
  | ConfirmedDocumentAnchorPlacementRecovery

export function documentAnchorPlacementRecoveryKey(
  scope: DocumentAnchorPlacementRecoveryScope,
): string

export function deriveDocumentAnchorPlacementOperationId(
  scope: DocumentAnchorPlacementRecoveryScope,
  canvasId: string,
  generation: number,
): Promise<string>

export function readDocumentAnchorPlacementRecovery(
  storage: DocumentAnchorPlacementRecoveryStorage,
  scope: DocumentAnchorPlacementRecoveryScope,
): Promise<DocumentAnchorPlacementRecovery | null>

export function ensureDocumentAnchorPlacementRecovery(
  storage: DocumentAnchorPlacementRecoveryStorage,
  scope: DocumentAnchorPlacementRecoveryScope,
  canvasId: string,
): Promise<DocumentAnchorPlacementRecovery>

export function confirmDocumentAnchorPlacementRecovery(
  storage: DocumentAnchorPlacementRecoveryStorage,
  scope: DocumentAnchorPlacementRecoveryScope,
  canvasId: string,
  operationId: string,
  placementId: string,
): Promise<ConfirmedDocumentAnchorPlacementRecovery>

export function advanceDocumentAnchorPlacementRecovery(
  storage: DocumentAnchorPlacementRecoveryStorage,
  scope: DocumentAnchorPlacementRecoveryScope,
  canvasId: string,
  operationId: string,
): Promise<PendingDocumentAnchorPlacementRecovery>

export function runRecoverableDocumentAnchorPlacement<Result extends { placementId: string }>(options: {
  storage: DocumentAnchorPlacementRecoveryStorage
  scope: DocumentAnchorPlacementRecoveryScope
  resolveCanvasId: () => Promise<string>
  place: (operationId: string, canvasId: string) => Promise<Result>
}): Promise<Readonly<{
  recovery: ConfirmedDocumentAnchorPlacementRecovery
  result: Result
  recovered: boolean
}>>
