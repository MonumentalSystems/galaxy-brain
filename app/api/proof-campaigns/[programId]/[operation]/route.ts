import { NextResponse } from "next/server"

import { getCurrentUser } from "@/lib/auth"
import {
  ProofCampaignContractError,
  readProofCampaignJsonBody,
} from "@/lib/proof-campaign-contract"
import {
  assertProofCampaignMutationAuthority,
  fetchProofCampaign,
  type ProofCampaignOperation,
  ProofCampaignProxyError,
} from "@/lib/proof-campaign-proxy"
import { PROOF_CAMPAIGN_PROXY_OPERATIONS } from "@/lib/proof-campaign-proxy-policy"

type RouteContext = {
  params: Promise<{ programId: string; operation: string }>
}

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

function errorResponse(error: unknown) {
  if (error instanceof ProofCampaignProxyError) return response({ error: error.message }, error.status)
  if (error instanceof ProofCampaignContractError) return response({ error: error.message }, error.status)
  return response({ error: "Unexpected proof campaign proxy error" }, 500)
}

function operationFrom(value: string): ProofCampaignOperation | null {
  return Object.hasOwn(PROOF_CAMPAIGN_PROXY_OPERATIONS, value) ? value as ProofCampaignOperation : null
}

async function handle(request: Request, context: RouteContext) {
  const user = await getCurrentUser()
  if (!user) return response({ error: "Unauthorized" }, 401)
  const { programId, operation: operationName } = await context.params
  const operation = operationFrom(operationName)
  if (!operation) return response({ error: "Proof campaign operation is not allowed" }, 404)
  const policy = PROOF_CAMPAIGN_PROXY_OPERATIONS[operation]
  if (request.method !== policy.method) return response({ error: "Method not allowed" }, 405)

  try {
    if (policy.mutates) assertProofCampaignMutationAuthority(request, user)
    const body = policy.method === "GET" ? undefined : await readProofCampaignJsonBody(request)
    return response(await fetchProofCampaign(operation, { user, programId, body }))
  } catch (error) {
    return errorResponse(error)
  }
}

export async function GET(request: Request, context: RouteContext) {
  return handle(request, context)
}

export async function POST(request: Request, context: RouteContext) {
  return handle(request, context)
}
