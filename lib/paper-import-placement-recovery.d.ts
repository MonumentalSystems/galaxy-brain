import type { DurableDocumentImport } from "./durable-document-import.js"

export type PaperImportPlacementRecoveryScope = Readonly<{
  tenantId: string
  principalId: string
}>

export type PaperImportPlacementRecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> &
  Partial<Pick<Storage, "key" | "length">>

export type PaperImportPlacementRecovery = Readonly<{
  schemaId: "gb.paper-import-placement-recovery.v1"
  operationId: string
  workspaceId: string
  canvasId: string
  subjectRef: string
  durableDocument: Readonly<DurableDocumentImport>
  arxiv_id: string
  arxiv_version: number
  title: string
}>

export function paperImportPlacementRecoveryNamespace(scope: PaperImportPlacementRecoveryScope): string

export function writePaperImportPlacementRecovery(
  storage: PaperImportPlacementRecoveryStorage,
  scope: PaperImportPlacementRecoveryScope,
  value: Omit<PaperImportPlacementRecovery, "schemaId">,
): PaperImportPlacementRecovery

export function readPaperImportPlacementRecovery(
  storage: PaperImportPlacementRecoveryStorage,
  scope: PaperImportPlacementRecoveryScope,
  operationId: string,
): PaperImportPlacementRecovery | null

export function listPaperImportPlacementRecoveries(
  storage: PaperImportPlacementRecoveryStorage & Required<Pick<Storage, "key" | "length">>,
  scope: PaperImportPlacementRecoveryScope,
): readonly PaperImportPlacementRecovery[]

export function removePaperImportPlacementRecovery(
  storage: PaperImportPlacementRecoveryStorage,
  scope: PaperImportPlacementRecoveryScope,
  operationId: string,
): void
