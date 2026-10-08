import { NextRequest, NextResponse } from "next/server"

import { revokeApiKey } from "@/lib/api-keys"
import { getCurrentUser } from "@/lib/auth"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type RouteContext = {
  params: Promise<{ tokenId: string }>
}

/** Revoking is session-only for the same reason minting is. */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { tokenId } = await context.params
  if (!UUID.test(tokenId)) {
    return NextResponse.json({ error: "Invalid key id" }, { status: 400 })
  }

  // Scoped to the caller's own principal, so one person cannot revoke another's.
  const revoked = await revokeApiKey(user.principalId, tokenId)
  if (!revoked) return NextResponse.json({ error: "Key not found" }, { status: 404 })

  return new NextResponse(null, { status: 204 })
}
