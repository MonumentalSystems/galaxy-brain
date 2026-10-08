import { NextRequest, NextResponse } from "next/server"

import { getCurrentUser } from "@/lib/auth"
import { parseHamAdminMutation } from "@/lib/ham-admin-contract.js"
import {
  assertSameOrigin,
  fetchHamAdminOverview,
  HamAdminProxyError,
  mutateHamAdmin,
} from "@/lib/ham-admin-proxy"

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
}

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS })
}

function errorResponse(error: unknown) {
  if (error instanceof HamAdminProxyError) {
    return response(error.body || { error: error.message }, error.status)
  }
  if (error instanceof Error) return response({ error: error.message }, 400)
  return response({ error: "Unexpected HAM administration error" }, 500)
}

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return response({ error: "Unauthorized" }, 401)
  try {
    return response(await fetchHamAdminOverview(user))
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return response({ error: "Unauthorized" }, 401)
  try {
    assertSameOrigin(request)
    const raw = await request.text()
    if (Buffer.byteLength(raw, "utf8") > 16_384) {
      return response({ error: "Admin request is too large" }, 413)
    }
    const mutation = parseHamAdminMutation(JSON.parse(raw), Date.now(), {
      currentNostrPubkey: user.nostrPubkey,
    }) as {
      action: string
      method: "POST" | "DELETE"
      path: string
      body: unknown
    }
    const result = await mutateHamAdmin(user, mutation)
    return response(result, mutation.action.startsWith("create") ? 201 : 200)
  } catch (error) {
    return errorResponse(error)
  }
}
