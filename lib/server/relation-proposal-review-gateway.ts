import "server-only"

import { NextResponse } from "next/server"

import { getCurrentUser } from "@/lib/auth"

const INTERNAL_GALAXY_API = process.env.GALAXY_API_INTERNAL || "http://localhost:8044"
const MAX_DECISION_BYTES = 8_192
const MAX_RESPONSE_BYTES = 262_144

class BodyTooLarge extends Error {}

async function readBoundedBody(request: { body: ReadableStream<Uint8Array> | null }, limit: number) {
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > limit) {
        await reader.cancel().catch(() => undefined)
        throw new BodyTooLarge()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function exactArrayBuffer(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

async function readBoundedResponse(response: Response) {
  const bytes = await readBoundedBody(response, MAX_RESPONSE_BYTES)
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new Error("Relation review provider returned an invalid response")
  }
}

function safeUpstreamError(status: number, body: unknown) {
  if (status === 409 && body && typeof body === "object") {
    const detail = (body as { detail?: unknown }).detail
    if (detail && typeof detail === "object") {
      const code = (detail as { code?: unknown }).code
      if (code === "idempotency_key_reused" || code === "stale_relation_proposal") {
        return { error: "Relation proposal changed before this decision was saved", code }
      }
    }
  }
  if (status === 404) return { error: "Relation proposal was not found or is no longer readable" }
  if (status === 422) return { error: "Relation proposal decision was invalid" }
  if (status === 403) return { error: "Relation proposals require human review" }
  return { error: "Relation review is unavailable" }
}

export async function proxyRelationProposalReview(
  request: Request,
  upstreamPath: string,
  method: "GET" | "POST",
) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const proxyToken = process.env.GALAXY_API_PROXY_TOKEN
  if (!proxyToken) {
    return NextResponse.json({ error: "Relation review is unavailable" }, { status: 503 })
  }

  let body: Uint8Array | undefined
  if (method === "POST") {
    const declaredLength = Number(request.headers.get("Content-Length") || 0)
    if (Number.isFinite(declaredLength) && declaredLength > MAX_DECISION_BYTES) {
      return NextResponse.json({ error: "Relation proposal decision exceeds 8 KiB" }, { status: 413 })
    }
    try {
      body = await readBoundedBody(request, MAX_DECISION_BYTES)
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        return NextResponse.json({ error: "Relation proposal decision exceeds 8 KiB" }, { status: 413 })
      }
      return NextResponse.json({ error: "Unable to read relation proposal decision" }, { status: 400 })
    }
  }

  const headers = new Headers({
    "Content-Type": "application/json",
    "X-GB-Proxy-Token": proxyToken,
    "X-GB-Tenant-ID": user.tenantId,
    "X-GB-Principal-ID": user.principalId,
    "X-GB-Principal-Kind": "human",
    "X-GB-Relation-Review-Gateway": "v1",
  })
  if (user.nostrPubkey) headers.set("X-GB-Nostr-Pubkey", user.nostrPubkey)

  try {
    const upstream = await fetch(new URL(upstreamPath, INTERNAL_GALAXY_API), {
      method,
      headers,
      body: body ? exactArrayBuffer(body) : undefined,
      cache: "no-store",
    })
    const responseBody = await readBoundedResponse(upstream)
    const responseHeaders = {
      "Cache-Control": "private, no-store, max-age=0",
      Pragma: "no-cache",
    }
    if (!upstream.ok) {
      return NextResponse.json(safeUpstreamError(upstream.status, responseBody), {
        status: upstream.status,
        headers: responseHeaders,
      })
    }
    return NextResponse.json(responseBody, { status: upstream.status, headers: responseHeaders })
  } catch {
    return NextResponse.json({ error: "Relation review is unavailable" }, {
      status: 503,
      headers: { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" },
    })
  }
}
