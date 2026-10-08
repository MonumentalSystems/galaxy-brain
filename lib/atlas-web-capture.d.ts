import type { DurableDocumentImport } from "./durable-document-import.js"

export type AtlasWebCaptureInput = Readonly<{
  url: string
  title: string
  format: "html" | "markdown" | "text"
  content: string
}>

export type AtlasWebCaptureIntent = Readonly<{
  schemaId: "gb.atlas-web-capture-intent.v1"
  capture: Readonly<AtlasWebCaptureInput & {
    selection: ""
    tags: readonly []
    note: ""
    region: null
    source: "atlas"
    capturedAt: string
  }>
  idempotencyKey: string
}>

export class AtlasWebCaptureError extends Error {
  readonly code: string
  readonly ambiguous: boolean
}

export function atlasWebCaptureRegistered(): boolean
export function claimAtlasWebCaptureFlight(
  ownerRef: { current: number | null },
  generationRef: { current: number },
): number | null
export function releaseAtlasWebCaptureFlight(
  ownerRef: { current: number | null },
  generation: number,
): void
export function prepareAtlasWebCaptureIntent(
  input: AtlasWebCaptureInput,
  options?: Readonly<{ randomUUID?: () => string; now?: () => Date }>,
): AtlasWebCaptureIntent
export function captureAtlasWebContent(
  intent: AtlasWebCaptureIntent,
  options?: Readonly<{ fetcher?: typeof fetch; signal?: AbortSignal }>,
): Promise<Readonly<DurableDocumentImport>>

export type AtlasWebCaptureRecoveryScope = Readonly<{ tenantId: string; principalId: string }>
export type AtlasWebCapturePlacementRecovery = Readonly<{
  schemaId: "gb.atlas-web-capture-placement-recovery.v1"
  operationId: string
  workspaceId: string
  canvasId: string
  subjectRef: string
  durableDocument: Readonly<DurableDocumentImport>
  captureUrl: string
  title: string
  format: "html" | "markdown" | "text"
}>
export type AtlasWebCaptureRecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> & Partial<Pick<Storage, "key" | "length">>

export function createAtlasWebCapturePlacementRecovery(
  value: Omit<AtlasWebCapturePlacementRecovery, "schemaId">,
): AtlasWebCapturePlacementRecovery
export function atlasWebCapturePlacementRecoveryNamespace(scope: AtlasWebCaptureRecoveryScope): string
export function writeAtlasWebCapturePlacementRecovery(
  storage: AtlasWebCaptureRecoveryStorage,
  scope: AtlasWebCaptureRecoveryScope,
  value: Omit<AtlasWebCapturePlacementRecovery, "schemaId">,
): AtlasWebCapturePlacementRecovery
export function listAtlasWebCapturePlacementRecoveries(
  storage: AtlasWebCaptureRecoveryStorage & Required<Pick<Storage, "key" | "length">>,
  scope: AtlasWebCaptureRecoveryScope,
): readonly AtlasWebCapturePlacementRecovery[]
export function removeAtlasWebCapturePlacementRecovery(
  storage: AtlasWebCaptureRecoveryStorage,
  scope: AtlasWebCaptureRecoveryScope,
  operationId: string,
): void
