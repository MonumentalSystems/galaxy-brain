import type { CanvasEnvelope } from "../types/canvas"

export const ATLAS_CANVAS_CREATE_RECOVERY_SCHEMA: "gb.atlas-canvas-create-recovery.v2"

export class AtlasCanvasCreateRecoveryError extends TypeError {}

export type AtlasCanvasCreateScope = Readonly<{
  tenantId: string
  principalId: string
  workspaceId: string
}>

export type AtlasCanvasCreateOperation = Readonly<{
  schemaId: typeof ATLAS_CANVAS_CREATE_RECOVERY_SCHEMA
  state: "pending"
  operationId: string
  tenantId: string
  principalId: string
  workspaceId: string
  title: string
  slug: string
  makeDefault: false
  projectionMode: "curated"
  idempotencyKey: string
}>

export type AtlasCanvasCreateStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export function atlasCanvasCreateRecoveryKey(scope: AtlasCanvasCreateScope): string
export function prepareAtlasCanvasCreateOperation(input: {
  tenantId: string
  principalId: string
  workspaceId: string
  title: string
  slug: string
  operationId?: string
}): AtlasCanvasCreateOperation
export function readPendingAtlasCanvasCreate(
  storage: AtlasCanvasCreateStorage,
  scope: AtlasCanvasCreateScope,
): AtlasCanvasCreateOperation | null
export function writePendingAtlasCanvasCreate(
  storage: AtlasCanvasCreateStorage,
  scope: AtlasCanvasCreateScope,
  operation: AtlasCanvasCreateOperation,
): AtlasCanvasCreateOperation
export function requirePendingAtlasCanvasCreate(
  storage: AtlasCanvasCreateStorage,
  scope: AtlasCanvasCreateScope,
  operation: AtlasCanvasCreateOperation,
): AtlasCanvasCreateOperation
export function removePendingAtlasCanvasCreate(
  storage: AtlasCanvasCreateStorage,
  scope: AtlasCanvasCreateScope,
  operationId: string,
): boolean
export function discardAtlasCanvasCreateRecovery(
  storage: AtlasCanvasCreateStorage,
  scope: AtlasCanvasCreateScope,
): true
export function confirmAtlasCanvasCreateResponse(
  value: unknown,
  operation: AtlasCanvasCreateOperation,
): Promise<CanvasEnvelope>
