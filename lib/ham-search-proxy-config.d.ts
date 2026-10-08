type Environment = Record<string, string | undefined>

type HamSearchTenantAccess =
  | { allowed: true; tenantId: string }
  | { allowed: false; status: number; message: string }

export function resolveHamSearchBearer(environment: Environment): string | null

export function evaluateHamSearchTenantAccess(
  user: { tenantId: string } | null | undefined,
  environment: Environment,
): HamSearchTenantAccess
