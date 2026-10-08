export interface HamReferenceResolutionReference {
  wire: string
  id: string
  resolvable: boolean
  providerKind: "memory" | "task" | null
  resolvedRevision: string | null
}

export interface HamReferenceResolutionRequest {
  tenantId: string
  principalId: string
  references: HamReferenceResolutionReference[]
}

export interface HamReferenceResolutionDecision {
  reference: string
  tenant_id: string
  principal_id: string
  readable: true
  resolved_revision: string | null
  provider: "ham"
}

export function resolveHamReferenceTenant(
  memoryTenant: unknown,
  taskTenant: unknown,
): string | null

export function parseHamReferenceResolutionRequest(
  input: unknown,
  configuredTenant: unknown,
): HamReferenceResolutionRequest

export function createHamReferenceDecision(
  request: HamReferenceResolutionRequest,
  reference: HamReferenceResolutionReference,
): HamReferenceResolutionDecision

export function isExactHamTaskResolution(
  reference: HamReferenceResolutionReference,
  payload: unknown,
): boolean

export function assertHamReferenceProviders(
  request: HamReferenceResolutionRequest,
  providers: {
    memoryTenant?: string
    memoryBaseUrl?: string
    memoryBearer?: string
    taskTenant?: string
    taskConfig?: { baseUrl: string; bearerToken: string } | null
  },
): void
