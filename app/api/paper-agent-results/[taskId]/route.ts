import { NextRequest, NextResponse } from "next/server"

import { getCurrentUser } from "@/lib/auth"
import { buildHamTaskEventsBody } from "@/lib/ham-task-contract"
import { fetchHamTask, getHamTaskProjectRef, HamTaskProxyError } from "@/lib/ham-task-proxy"
import {
  assertPaperAgentResultCandidateMatch,
  buildPaperAgentResultDecisionEnvelope,
  createPaperAgentResultCandidate,
  paperAgentResultBackendPath,
  parsePaperAgentResultDecisionInput,
  parsePaperAgentResultLocation,
  projectPaperAgentResultReview,
} from "@/lib/paper-agent-result.js"
import type { PaperAgentResultCandidate, PaperAgentResultLocation } from "@/lib/paper-agent-result.js"

const INTERNAL_GALAXY_API = process.env.GALAXY_API_INTERNAL || "http://localhost:8044"
const MAX_BROWSER_DECISION_BYTES = 8_192
const MAX_BACKEND_RESPONSE_BYTES = 262_144
const MAX_EVENT_PAGES = 50
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" }

class BodyTooLarge extends Error {}

type RouteContext = { params: Promise<{ taskId: string }> }
type CurrentUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS })
}

async function readBoundedBody(stream: ReadableStream<Uint8Array> | null, maximum: number) {
  if (!stream) return new Uint8Array()
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maximum) {
        await reader.cancel().catch(() => undefined)
        throw new BodyTooLarge()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function exactArrayBuffer(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

async function boundedJson(response: Response) {
  const bytes = await readBoundedBody(response.body, MAX_BACKEND_RESPONSE_BYTES)
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new Error("Paper agent result provider returned an invalid response")
  }
}

function rawEventPage(value: unknown) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const rawItems = source.items ?? source.events ?? source.results
  return {
    items: Array.isArray(rawItems) ? rawItems : [],
    hasMore: source.has_more === true || source.hasMore === true,
    nextCursor: source.next_cursor ?? source.nextCursor,
  }
}

async function authoritativeCandidate(user: CurrentUser, taskId: string): Promise<PaperAgentResultCandidate> {
  const before = await fetchHamTask("detail", { user, taskId }) as Record<string, unknown>
  const events: unknown[] = []
  let cursor = 0
  for (let pageNumber = 0; pageNumber < MAX_EVENT_PAGES; pageNumber += 1) {
    const raw = await fetchHamTask("events", {
      user,
      body: buildHamTaskEventsBody(getHamTaskProjectRef(), taskId, cursor, 200),
    })
    const page = rawEventPage(raw)
    events.push(...page.items)
    if (!page.hasMore) break
    if (!Number.isSafeInteger(page.nextCursor) || Number(page.nextCursor) <= cursor) {
      throw new Error("HAM returned a non-advancing task event cursor")
    }
    cursor = Number(page.nextCursor)
    if (pageNumber === MAX_EVENT_PAGES - 1) {
      throw new Error("HAM task event history exceeds the bounded result window")
    }
  }
  const after = await fetchHamTask("detail", { user, taskId }) as Record<string, unknown>
  if (before.task_id !== after.task_id || before.version !== after.version || before.status !== after.status) {
    throw new TypeError("Invalid paper agent result: HAM task changed while its result was read")
  }
  return createPaperAgentResultCandidate({ taskId, requesterUserId: user.id, detail: after, events })
}

function backendHeaders(user: CurrentUser) {
  const proxyToken = process.env.GALAXY_API_PROXY_TOKEN
  if (!proxyToken) return null
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-GB-Proxy-Token": proxyToken,
    "X-GB-Tenant-ID": user.tenantId,
    "X-GB-Principal-ID": user.principalId,
    "X-GB-Principal-Kind": "human",
    "X-GB-Human-Session": "v1",
    "X-GB-Paper-Agent-Result-Gateway": "v1",
  })
  if (user.nostrPubkey) headers.set("X-GB-Nostr-Pubkey", user.nostrPubkey)
  return headers
}

async function readBackendDecision(
  user: CurrentUser,
  location: PaperAgentResultLocation,
  candidate: PaperAgentResultCandidate,
) {
  const headers = backendHeaders(user)
  if (!headers) throw new Error("Paper agent result review is not configured")
  const url = new URL(paperAgentResultBackendPath(location, candidate.taskId), INTERNAL_GALAXY_API)
  url.search = new URLSearchParams({
    task_version: String(candidate.taskVersion),
    event_id: candidate.eventId,
    result_sha256: candidate.resultHash,
  }).toString()
  const response = await fetch(url, { method: "GET", headers, cache: "no-store" })
  const body = await boundedJson(response)
  if (!response.ok) throw new Error("Paper agent result review is unavailable")
  return body
}

function contractError(error: unknown) {
  if (error instanceof HamTaskProxyError) return json({ error: error.message }, error.status)
  const message = error instanceof Error ? error.message : ""
  if (message.includes("requester does not match")) {
    return json({ error: "Only the human who created this Enhance task may review its result" }, 403)
  }
  if (message.includes("not completed") || message.includes("no completion event") || message.includes("changed while")) {
    return json({ error: "The HAM task does not have a stable completed result yet" }, 409)
  }
  if (error instanceof TypeError && message.startsWith("Invalid paper agent result:")) {
    return json({ error: message }, 422)
  }
  return json({ error: "Paper agent result review is unavailable" }, 503)
}

export async function GET(request: NextRequest, context: RouteContext) {
  const user = await getCurrentUser()
  if (!user) return json({ error: "Unauthorized" }, 401)
  try {
    const { taskId } = await context.params
    const location = parsePaperAgentResultLocation({
      documentRevisionId: request.nextUrl.searchParams.get("documentRevisionId"),
      anchorId: request.nextUrl.searchParams.get("anchorId"),
    })
    const candidate = await authoritativeCandidate(user, taskId)
    const backendReview = await readBackendDecision(user, location, candidate)
    return json(projectPaperAgentResultReview(candidate, backendReview))
  } catch (error) {
    return contractError(error)
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const user = await getCurrentUser()
  if (!user) return json({ error: "Unauthorized" }, 401)
  const declared = Number(request.headers.get("Content-Length") || 0)
  if (Number.isFinite(declared) && declared > MAX_BROWSER_DECISION_BYTES) {
    return json({ error: "Paper agent result decision exceeds 8 KiB" }, 413)
  }
  try {
    const bytes = await readBoundedBody(request.body, MAX_BROWSER_DECISION_BYTES)
    const input = parsePaperAgentResultDecisionInput(JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ))
    const { taskId } = await context.params
    const candidate = await authoritativeCandidate(user, taskId)
    assertPaperAgentResultCandidateMatch(input, candidate)
    const headers = backendHeaders(user)
    if (!headers) return json({ error: "Paper agent result review is not configured" }, 503)
    const upstream = await fetch(
      new URL(paperAgentResultBackendPath(input, taskId), INTERNAL_GALAXY_API),
      {
        method: "POST",
        headers,
        body: JSON.stringify(buildPaperAgentResultDecisionEnvelope(input, candidate)),
        cache: "no-store",
      },
    )
    const responseBody = await boundedJson(upstream)
    if (!upstream.ok) {
      const status = [403, 404, 409, 422].includes(upstream.status) ? upstream.status : 503
      return json({ error: status === 409
        ? "The paper agent result changed before the decision was saved"
        : "Paper agent result decision was not saved" }, status)
    }
    return json(projectPaperAgentResultReview(candidate, responseBody), upstream.status)
  } catch (error) {
    if (error instanceof BodyTooLarge) return json({ error: "Paper agent result decision exceeds 8 KiB" }, 413)
    if (error instanceof SyntaxError || error instanceof DOMException) {
      return json({ error: "Paper agent result decision must be UTF-8 JSON" }, 400)
    }
    return contractError(error)
  }
}
