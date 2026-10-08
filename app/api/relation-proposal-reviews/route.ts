import type { NextRequest } from "next/server"

import { proxyRelationProposalReview } from "@/lib/server/relation-proposal-review-gateway"

export async function GET(request: NextRequest) {
  const cursor = request.nextUrl.searchParams.get("cursor")
  if (cursor && (!/^[A-Za-z0-9_.-]{1,512}$/u.test(cursor))) {
    return Response.json({ error: "Invalid relation review cursor" }, { status: 422 })
  }
  // Every stored proposal passed the 8 KiB normalized proposal contract, so a
  // 20-item review page plus receipt fields retains response-cap margin.
  const query = new URLSearchParams({ limit: "20" })
  if (cursor) query.set("cursor", cursor)
  return proxyRelationProposalReview(request, `/relation-proposals?${query}`, "GET")
}
