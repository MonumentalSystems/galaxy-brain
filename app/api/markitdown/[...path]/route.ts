import { NextRequest, NextResponse } from "next/server"

import { getCurrentUser } from "@/lib/auth"

const INTERNAL_MARKITDOWN_API =
  process.env.MARKITDOWN_API_INTERNAL || "http://localhost:8043"

type RouteContext = {
  params: Promise<{ path: string[] }>
}

async function proxyMarkItDownRequest(request: NextRequest, context: RouteContext) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const proxyToken = process.env.MARKITDOWN_PROXY_TOKEN
  if (!proxyToken) {
    return NextResponse.json({ error: "Document conversion is not configured" }, { status: 503 })
  }

  const { path } = await context.params
  const upstreamUrl = new URL(`/${path.join("/")}`, INTERNAL_MARKITDOWN_API)
  const headers = new Headers()
  const contentType = request.headers.get("Content-Type")
  if (contentType) headers.set("Content-Type", contentType)
  headers.set("X-GB-Proxy-Token", proxyToken)

  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
    cache: "no-store",
  })

  return new NextResponse(await upstream.arrayBuffer(), {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") || "application/json",
    },
  })
}

export async function GET(request: NextRequest, context: RouteContext) {
  return proxyMarkItDownRequest(request, context)
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxyMarkItDownRequest(request, context)
}
