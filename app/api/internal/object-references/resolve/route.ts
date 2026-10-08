import { createHash, timingSafeEqual } from "node:crypto"

import { NextRequest, NextResponse } from "next/server"

import {
  assertHamReferenceProviders,
  createHamReferenceDecision,
  isExactHamTaskResolution,
  parseHamReferenceResolutionRequest,
  resolveHamReferenceTenant,
} from "@/lib/ham-reference-resolver-contract.js"
import type {
  HamReferenceResolutionDecision,
  HamReferenceResolutionReference,
} from "@/lib/ham-reference-resolver-contract.js"
import { resolveHamSearchBearer } from "@/lib/ham-search-proxy-config.js"
import { resolveHamTaskProxyConfig } from "@/lib/ham-task-proxy-config.js"

const MAX_BODY_BYTES = 65_536
const FETCH_CONCURRENCY = 8
const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0", Pragma: "no-cache" }

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS })
}

async function readBoundedText(request: Pick<Request, "headers" | "body">) {
  const declared = Number(request.headers.get("content-length") || 0)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new RangeError("too large")
  if (!request.body) return ""
  const reader = request.body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let total = 0
  let text = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new RangeError("too large")
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function authorized(request: Request) {
  const expected = process.env.GB_OBJECT_REFERENCE_RESOLVER_TOKEN
  const supplied = request.headers.get("authorization")
  if (!expected || !supplied?.startsWith("Bearer ")) return false
  const expectedDigest = createHash("sha256").update(expected).digest()
  const suppliedDigest = createHash("sha256").update(supplied.slice(7)).digest()
  return timingSafeEqual(expectedDigest, suppliedDigest)
}

async function readableMemory(baseUrl: string, bearer: string, tenantId: string, memoryId: string) {
  let response: Response
  try {
    response = await fetch(`${baseUrl}/memories/${memoryId}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${bearer}`,
        "X-GB-User-ID": tenantId,
        "X-HAM-Actor-Type": "service",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    throw new Error("HAM reference provider is unavailable")
  }
  await response.body?.cancel().catch(() => undefined)
  if (response.status === 404) return false
  if (!response.ok) throw new Error("HAM reference provider rejected the resolver credential")
  return true
}

async function readableTask(
  baseUrl: string,
  bearer: string,
  tenantId: string,
  reference: HamReferenceResolutionReference,
) {
  let response: Response
  try {
    response = await fetch(`${baseUrl}/tasks/${encodeURIComponent(reference.id)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${bearer}`,
        "X-GB-User-ID": tenantId,
        "X-HAM-Actor-Type": "service",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    throw new Error("HAM reference provider is unavailable")
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined)
    return false
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error("HAM reference provider rejected the resolver credential")
  }
  let payload: unknown
  try {
    payload = JSON.parse(await readBoundedText(response))
  } catch {
    return false
  }
  return isExactHamTaskResolution(reference, payload)
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return json({ error: "Unauthorized" }, 401)
  const memoryTenant = process.env.HAM_SEARCH_GALAXY_TENANT_ID
  const taskTenant = process.env.HAM_TASK_GALAXY_TENANT_ID
  const configuredTenant = resolveHamReferenceTenant(memoryTenant, taskTenant)
  if (!configuredTenant) {
    return json({ error: "HAM reference resolution is not configured" }, 503)
  }

  try {
    const raw = await readBoundedText(request)
    const parsed = parseHamReferenceResolutionRequest(JSON.parse(raw), configuredTenant)
    const decisions: HamReferenceResolutionDecision[] = []
    const resolvable = parsed.references.filter((reference) => reference.resolvable)
    const memoryBaseUrl = process.env.HAM_API_INTERNAL?.replace(/\/$/, "")
    const memoryBearer = resolveHamSearchBearer(process.env)
    const taskConfig = resolveHamTaskProxyConfig("detail", process.env)
    assertHamReferenceProviders(parsed, {
      memoryTenant,
      memoryBaseUrl,
      memoryBearer: memoryBearer ?? undefined,
      taskTenant,
      taskConfig,
    })
    for (let start = 0; start < resolvable.length; start += FETCH_CONCURRENCY) {
      const batch = resolvable.slice(start, start + FETCH_CONCURRENCY)
      const readable = await Promise.all(batch.map((reference) => (
        reference.providerKind === "memory"
          ? readableMemory(memoryBaseUrl!, memoryBearer!, parsed.tenantId, reference.id)
          : readableTask(
              taskConfig!.baseUrl,
              taskConfig!.bearerToken,
              parsed.tenantId,
              reference,
            )
      )))
      batch.forEach((reference, index) => {
        if (readable[index]) decisions.push(createHamReferenceDecision(parsed, reference))
      })
    }
    return json({ decisions })
  } catch (error) {
    if (error instanceof RangeError) return json({ error: "Resolver request is too large" }, 413)
    if (error instanceof SyntaxError) return json({ error: "Resolver request must be JSON" }, 400)
    if (error instanceof Error && error.message.startsWith("HAM reference provider")) {
      return json({ error: error.message }, 503)
    }
    return json({ error: error instanceof Error ? error.message : "Invalid resolver request" }, 400)
  }
}
