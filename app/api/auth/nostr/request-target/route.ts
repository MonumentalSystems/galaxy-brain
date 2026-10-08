import { NextRequest } from "next/server"

import { getAuthOrigin } from "@/lib/auth-config"
import { getCurrentUser } from "@/lib/auth"

const ELN_SIGNABLE_PATH = /^\/api\/eln\/[A-Za-z0-9_~!$&'()*+,;=:@%./?-]{1,2000}$/u
const AGENT_TOOL_SIGNABLE_PATH = /^\/api\/agent-tools\/(?:anchors\.create|canvas\.arrange|proof\.claim|relations\.propose|surface\.draft\.create)$/u
const MCP_SIGNABLE_PATH = "/mcp"
const RECONCILE_PREFIX = "/api/proof-workspaces/"
const RECONCILE_SUFFIX = "/hyades-task-bindings/reconcile"
const ENCODED_WORKSPACE = /^(?:[A-Za-z0-9_.~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2}){1,1536}$/u

function isExactReconcilePath(path: string) {
  if (!path.startsWith(RECONCILE_PREFIX) || !path.endsWith(RECONCILE_SUFFIX)
    || path.includes("?") || path.includes("#")) return false
  const workspace = path.slice(RECONCILE_PREFIX.length, -RECONCILE_SUFFIX.length)
  if (!ENCODED_WORKSPACE.test(workspace) || /%(?:2f|5c)/iu.test(workspace)) return false
  try {
    const decoded = decodeURIComponent(workspace)
    return Array.from(decoded).length <= 512 && decoded !== "." && decoded !== ".."
      && !decoded.includes("/") && !decoded.includes("\\")
  } catch {
    return false
  }
}

function isSignablePath(path: string) {
  const isElnPath = ELN_SIGNABLE_PATH.test(path) && !path.includes("//") && !path.includes("#")
  return isElnPath || AGENT_TOOL_SIGNABLE_PATH.test(path) || path === MCP_SIGNABLE_PATH || isExactReconcilePath(path)
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser()
  if (!user || user.authMethod !== "nostr" || !user.nostrPubkey) {
    return Response.json({ error: "Sign in with Nostr before signing this request." }, { status: 401 })
  }
  const path = request.nextUrl.searchParams.get("path") || ""
  if (!isSignablePath(path)) {
    return Response.json({ error: "The requested signing path is invalid." }, { status: 400 })
  }
  const origin = getAuthOrigin()
  const target = new URL(path, origin)
  if (target.origin !== new URL(origin).origin || !isSignablePath(`${target.pathname}${target.search}`)) {
    return Response.json({ error: "The requested signing path is invalid." }, { status: 400 })
  }
  return Response.json({
    schemaId: "gb.nostr-request-target.v1",
    url: target.toString(),
  }, {
    headers: { "Cache-Control": "private, no-store" },
  })
}
