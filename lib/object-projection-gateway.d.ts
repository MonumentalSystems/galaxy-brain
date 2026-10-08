import type { RequestIdentity } from "./request-identity"

export class ObjectProjectionGatewayError extends Error {}

export function resolveObjectProjectionSources(
  references: readonly string[],
  identity: RequestIdentity,
  environment?: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch,
): Promise<{
  schemaId: "gb.object-projection-source-response.v3"
  results: readonly Record<string, unknown>[]
}>
