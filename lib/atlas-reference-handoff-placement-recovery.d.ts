export type AtlasReferenceHandoffPlacementRecoveryScope = Readonly<{
  tenantId: string
  principalId: string
}>

export type AtlasReferenceHandoffPlacementRecoveryStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
> & Partial<Pick<Storage, "key" | "length">>

export type AtlasReferenceHandoffPlacementRecovery = Readonly<{
  schemaId: "gb.atlas-reference-handoff-placement-recovery.v2"
  operationId: string
  workspaceId: string
  canvasId: string
  subjectRef: string
  kind: "document" | "chat" | "surface"
  objectId: string
  sourceRevisionId: string | null
  revisionSha256: string
}>

export function atlasReferenceHandoffPlacementRecoveryNamespace(
  scope: AtlasReferenceHandoffPlacementRecoveryScope,
): string

export function writeAtlasReferenceHandoffPlacementRecovery(
  storage: AtlasReferenceHandoffPlacementRecoveryStorage,
  scope: AtlasReferenceHandoffPlacementRecoveryScope,
  value: Omit<AtlasReferenceHandoffPlacementRecovery, "schemaId">,
): AtlasReferenceHandoffPlacementRecovery

export function readAtlasReferenceHandoffPlacementRecovery(
  storage: AtlasReferenceHandoffPlacementRecoveryStorage,
  scope: AtlasReferenceHandoffPlacementRecoveryScope,
  operationId: string,
): AtlasReferenceHandoffPlacementRecovery | null

export function listAtlasReferenceHandoffPlacementRecoveries(
  storage: AtlasReferenceHandoffPlacementRecoveryStorage & Required<Pick<Storage, "key" | "length">>,
  scope: AtlasReferenceHandoffPlacementRecoveryScope,
): readonly AtlasReferenceHandoffPlacementRecovery[]

export function removeAtlasReferenceHandoffPlacementRecovery(
  storage: AtlasReferenceHandoffPlacementRecoveryStorage,
  scope: AtlasReferenceHandoffPlacementRecoveryScope,
  operationId: string,
): void
