import { NextRequest, NextResponse } from "next/server"

import { proxyRelationProposalReview } from "@/lib/server/relation-proposal-review-gateway"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

type RouteContext = { params: Promise<{ proposalId: string }> }

export async function POST(request: NextRequest, context: RouteContext) {
  const { proposalId } = await context.params
  if (!UUID.test(proposalId)) {
    return NextResponse.json({ error: "Invalid relation proposal identifier" }, { status: 422 })
  }
  return proxyRelationProposalReview(
    request,
    `/relation-proposals/${encodeURIComponent(proposalId)}/decisions`,
    "POST",
  )
}
