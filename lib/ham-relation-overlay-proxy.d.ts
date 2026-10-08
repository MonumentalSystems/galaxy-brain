import type { RequestIdentity } from "./request-identity"
import type {
  HamRelationOverlayRequest,
  HamRelationOverlayResponse,
} from "./ham-relation-overlay-contract.js"

export class HamRelationOverlayProxyError extends Error {
  readonly status: number
  constructor(message?: string, status?: number)
}

export function resolveHamRelationOverlay(
  input: HamRelationOverlayRequest | unknown,
  identity: Pick<RequestIdentity, "principalId" | "tenantId" | "nostrPubkey">,
  environment?: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
  callerSignal?: AbortSignal,
): Promise<HamRelationOverlayResponse>
