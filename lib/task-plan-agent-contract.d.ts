export function normalizeTaskPlanSpec(value: unknown): Readonly<Record<string, any>>
export function normalizeTaskPlanProviderRecord(
  value: unknown,
  expectedId: string | null,
  expectedTenantId: string,
): Readonly<Record<string, any>>
export function normalizeTaskPlanProposalProvider(
  value: unknown,
  expected: Readonly<Record<string, any>>,
): Readonly<Record<string, any>>
