import { NextRequest, NextResponse } from "next/server"

import { getCurrentUser } from "@/lib/auth"
import {
  HamSearchUpstreamResponseError,
  parseHamSearchRequest,
  projectHamSearchResultsForBrowser,
} from "@/lib/ham-search-contract.js"
import {
  assertHamSearchOrigin,
  fetchHamSearch,
  HamSearchProxyError,
} from "@/lib/ham-search-proxy"
import {
  HamSearchBodyTooLargeError,
  HAM_SEARCH_REQUEST_MAX_BYTES,
  readBoundedHamSearchText,
} from "@/lib/ham-search-bounds.js"

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
}

function response(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS })
}

function errorResponse(error: unknown) {
  if (error instanceof HamSearchProxyError) {
    return response({ error: error.message, ...(error.detail ? { detail: error.detail } : {}) }, error.status)
  }
  if (error instanceof HamSearchUpstreamResponseError) {
    return response({ error: error.message }, 502)
  }
  if (error instanceof HamSearchBodyTooLargeError) {
    return response({ error: error.message }, 413)
  }
  if (error instanceof Error) return response({ error: error.message }, 400)
  return response({ error: "Unexpected HAM search error" }, 500)
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return response({ error: "Unauthorized" }, 401)

  try {
    assertHamSearchOrigin(request)
    const raw = await readBoundedHamSearchText(
      request,
      HAM_SEARCH_REQUEST_MAX_BYTES,
      "Search request is too large",
    )
    const parsed = parseHamSearchRequest(JSON.parse(raw))
    const upstream = await fetchHamSearch(user, parsed)
    return response(projectHamSearchResultsForBrowser(upstream))
  } catch (error) {
    return errorResponse(error)
  }
}
