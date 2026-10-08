import { NextRequest, NextResponse } from "next/server"

import {
  getPluginDefinition,
  isSafePluginPath,
  pluginBaseUrl,
  pluginScopes,
} from "@/lib/plugin-registry.js"
import { getRequestIdentity, identityCanAny } from "@/lib/request-identity"

const MAX_BODY_BYTES = 8_388_608

type RouteContext = {
  params: Promise<{ plugin: string; path: string[] }>
}

/**
 * Forwards a request to one of the services named in the plugin registry.
 *
 * The upstream credential belongs to the deployment, so the caller is
 * authorised here and the proxied call carries the deployment's own token
 * alongside the caller's identity in the X-GB-* headers, the same envelope the
 * ELN proxy sends.
 */
async function proxyPluginRequest(request: NextRequest, context: RouteContext) {
  const identity = await getRequestIdentity(request)
  if (!identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { plugin: pluginId, path } = await context.params
  const plugin = getPluginDefinition(pluginId)
  if (!plugin) return NextResponse.json({ error: "Unknown plugin" }, { status: 404 })

  if (!identityCanAny(identity, pluginScopes(plugin.id))) {
    return NextResponse.json({ error: `Missing plugin:${plugin.id} scope` }, { status: 403 })
  }
  if (!plugin.methods.includes(request.method)) {
    return NextResponse.json({ error: "Method not allowed for this plugin" }, { status: 405 })
  }
  if (!isSafePluginPath(path)) {
    return NextResponse.json({ error: "Invalid plugin path" }, { status: 400 })
  }

  const token = plugin.tokenEnv ? process.env[plugin.tokenEnv] : undefined
  if (plugin.tokenEnv && !token) {
    return NextResponse.json({ error: `${plugin.displayName} is not configured` }, { status: 503 })
  }

  let body: ArrayBuffer | undefined
  if (!["GET", "HEAD"].includes(request.method)) {
    const raw = await request.arrayBuffer()
    if (raw.byteLength > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Request body is too large" }, { status: 413 })
    }
    body = raw
  }

  const upstreamUrl = new URL(
    `${path.map(encodeURIComponent).join("/")}`,
    `${pluginBaseUrl(plugin).replace(/\/+$/, "")}/`,
  )
  upstreamUrl.search = request.nextUrl.search

  const headers = new Headers()
  const contentType = request.headers.get("Content-Type")
  if (contentType) headers.set("Content-Type", contentType)
  if (token) headers.set("Authorization", `Bearer ${token}`)
  headers.set("X-GB-Tenant-ID", identity.tenantId)
  headers.set("X-GB-Principal-ID", identity.principalId)
  headers.set("X-GB-Principal-Kind", identity.kind)
  if (identity.nostrPubkey) headers.set("X-GB-Nostr-Pubkey", identity.nostrPubkey)

  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    body,
    cache: "no-store",
  })

  const responseHeaders = new Headers()
  responseHeaders.set("Content-Type", upstream.headers.get("Content-Type") || "application/json")
  for (const name of ["Content-Disposition", "Content-Length", "Cache-Control", "ETag", "Link"]) {
    const value = upstream.headers.get(name)
    if (value) responseHeaders.set(name, value)
  }

  return new NextResponse(upstream.body, { status: upstream.status, headers: responseHeaders })
}

export async function GET(request: NextRequest, context: RouteContext) {
  return proxyPluginRequest(request, context)
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxyPluginRequest(request, context)
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return proxyPluginRequest(request, context)
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxyPluginRequest(request, context)
}
