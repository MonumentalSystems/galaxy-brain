import "server-only"

import type { CurrentUser } from "@/lib/auth"
import { projectProofCampaignResponseForBrowser } from "@/lib/proof-campaign-browser-projection"
import {
  createProofCampaignDispatchBody,
  parseProgramId,
  parseProofCampaignManifest,
  readProofCampaignResponseText,
} from "@/lib/proof-campaign-contract"
import {
  evaluateProofCampaignAccess,
  evaluateProofCampaignMutationAuthority,
  resolveProofCampaignProxyConfig,
} from "@/lib/proof-campaign-proxy-config"
import {
  getProofCampaignProxyRoute,
  PROOF_CAMPAIGN_PROXY_OPERATIONS,
} from "@/lib/proof-campaign-proxy-policy"

export type ProofCampaignOperation = keyof typeof PROOF_CAMPAIGN_PROXY_OPERATIONS

export class ProofCampaignProxyError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
  }
}

export function proofCampaignMutationsEnabled() {
  return process.env.PROOF_CAMPAIGN_MUTATIONS === "enabled"
}

export function proofCampaignControlConfigured() {
  return resolveProofCampaignProxyConfig(process.env) !== null
}

export function assertProofCampaignMutationAuthority(request: Request, user: CurrentUser) {
  const authority = evaluateProofCampaignMutationAuthority(
    user,
    request.url,
    request.headers.get("origin"),
    process.env,
  )
  if (!authority.allowed) {
    throw new ProofCampaignProxyError(
      authority.message || "Proof campaign mutation is not authorized",
      authority.status || 403,
    )
  }
}

export function assertProofCampaignAccess(user: CurrentUser) {
  const access = evaluateProofCampaignAccess(user, process.env)
  if (!access.allowed) {
    throw new ProofCampaignProxyError(
      access.message || "Proof campaign control is not authorized",
      access.status || 403,
    )
  }
}

function getConfig(operation: ProofCampaignOperation, user: CurrentUser) {
  assertProofCampaignAccess(user)
  const config = resolveProofCampaignProxyConfig(process.env)
  if (!config) throw new ProofCampaignProxyError("Proof campaign control is not configured", 503)
  if (PROOF_CAMPAIGN_PROXY_OPERATIONS[operation].mutates && !proofCampaignMutationsEnabled()) {
    throw new ProofCampaignProxyError("Proof campaign mutations are disabled by Galaxy Brain policy", 403)
  }
  return config
}

export async function fetchProofCampaign(
  operation: ProofCampaignOperation,
  options: { user: CurrentUser; programId: string; body?: unknown },
) {
  const programId = parseProgramId(options.programId)
  const config = getConfig(operation, options.user)
  const route = getProofCampaignProxyRoute(operation, {
    programId,
    hyadesTenant: config.hyadesTenant,
  })

  let body = options.body
  if (operation === "preview" || operation === "register") {
    const manifest = parseProofCampaignManifest(options.body)
    if (manifest.program_id !== programId) {
      throw new ProofCampaignProxyError("campaign manifest program_id does not match the route", 400)
    }
    body = manifest
  } else if (operation === "dispatch") {
    try {
      body = createProofCampaignDispatchBody(options.body, programId, config.hamProject)
    } catch (error) {
      throw new ProofCampaignProxyError(error instanceof Error ? error.message : "Dispatch input is invalid", 400)
    }
  }

  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${config.bearerToken}`,
    "Content-Type": "application/json",
    "X-GB-Performed-By": "service:galaxy-brain-proof-control",
    "X-GB-Requester-ID": options.user.id,
    "X-GB-Requester-Type": "human",
  })

  let response: Response
  try {
    response = await fetch(`${config.baseUrl}${route.path}`, {
      method: route.method,
      headers,
      body: route.method === "GET" ? undefined : JSON.stringify(body || {}),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new ProofCampaignProxyError("Hyades proof campaign control is unavailable", 502)
  }

  const responseText = await readProofCampaignResponseText(response)
  let responseBody: unknown = null
  try {
    responseBody = responseText ? JSON.parse(responseText) : null
  } catch {
    responseBody = null
  }
  if (!response.ok) {
    const upstreamMessage = responseBody && typeof responseBody === "object" && "error" in responseBody
      && typeof responseBody.error === "string" && responseBody.error.length <= 500
      ? responseBody.error
      : "Hyades rejected the proof campaign request"
    throw new ProofCampaignProxyError(upstreamMessage, response.status)
  }
  try {
    return projectProofCampaignResponseForBrowser(operation, responseBody)
  } catch {
    throw new ProofCampaignProxyError("Hyades returned an invalid proof campaign response", 502)
  }
}
