import { createHash } from "node:crypto"

import { NextRequest, NextResponse } from "next/server"

import {
  captureToIngestPayload,
  CaptureValidationError,
  parseCaptureIdempotencyKey,
  parseCaptureRequest,
} from "@/lib/capture-contract.js"
import { encodeDurableImportMetadata } from "@/lib/durable-document-import.js"
import { getPluginDefinition, pluginBaseUrl } from "@/lib/plugin-registry.js"
import { getRequestIdentity, identityCanAny } from "@/lib/request-identity"
import { executeWebCaptureIngestion } from "@/lib/web-capture-ingestion.js"

const INTERNAL_GALAXY_API = process.env.GALAXY_API_INTERNAL || "http://localhost:8044"
const MAX_BODY_BYTES = 4_194_304
const CAPTURE_SCOPES = ["capture:write", "capture:*"]

class CaptureUpstreamError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = "CaptureUpstreamError"
  }
}

class CaptureBodyTooLargeError extends Error {
  constructor() {
    super("Capture is too large")
    this.name = "CaptureBodyTooLargeError"
  }
}

class CaptureTransformError extends Error {
  readonly retryable: boolean
  readonly code: string

  constructor(status: number) {
    super("Document analysis did not complete")
    this.name = "CaptureTransformError"
    this.retryable = status === 408 || status === 425 || status === 429 || status >= 500
    this.code = this.retryable ? "transform-unavailable" : "transform-rejected"
  }
}

function galaxyHeaders(identity: Awaited<ReturnType<typeof getRequestIdentity>>) {
  if (!identity) throw new CaptureUpstreamError(401, "Unauthorized")
  const proxyToken = process.env.GALAXY_API_PROXY_TOKEN
  if (!proxyToken) throw new CaptureUpstreamError(503, "Galaxy document storage is not configured")
  const headers = new Headers({
    "X-GB-Tenant-ID": identity.tenantId,
    "X-GB-Principal-ID": identity.principalId,
    "X-GB-Principal-Kind": identity.kind,
    "X-GB-Proxy-Token": proxyToken,
  })
  if (identity.nostrPubkey) headers.set("X-GB-Nostr-Pubkey", identity.nostrPubkey)
  return headers
}

async function jsonResponse(response: Response) {
  return response.json().catch(() => null)
}

async function readBoundedBody(request: NextRequest) {
  const declaredLength = request.headers.get("Content-Length")
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) throw new CaptureValidationError("Invalid Content-Length")
    if (Number(declaredLength) > MAX_BODY_BYTES) throw new CaptureBodyTooLargeError()
  }
  if (!request.body) return new Uint8Array()

  const reader = request.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BODY_BYTES) {
        await reader.cancel("Capture body exceeded the configured limit")
        throw new CaptureBodyTooLargeError()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/**
 * Accept exact caller-supplied page bytes. The URL is provenance only: this
 * route never fetches it. Galaxy durability is authoritative; HAM mirroring is
 * optional and happens only after the original has been confirmed.
 */
export async function POST(request: NextRequest) {
  const identity = await getRequestIdentity(request)
  if (!identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!identityCanAny(identity, CAPTURE_SCOPES)) {
    return NextResponse.json({ error: "Missing capture:write scope" }, { status: 403 })
  }

  let capture
  let idempotencyKey
  try {
    const raw = await readBoundedBody(request)
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw)
    capture = parseCaptureRequest(JSON.parse(decoded))
    idempotencyKey = parseCaptureIdempotencyKey(request.headers.get("Idempotency-Key"))
  } catch (error) {
    if (error instanceof CaptureBodyTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 })
    }
    if (error instanceof CaptureValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    return NextResponse.json({ error: "Capture body must be JSON" }, { status: 400 })
  }

  try {
    const result = await executeWebCaptureIngestion({ capture, idempotencyKey }, {
      persistOriginal: async ({ bytes, mediaType, metadata, idempotencyKey: documentKey }) => {
        const headers = galaxyHeaders(identity)
        const exactBody = new Uint8Array(bytes).buffer
        headers.set("Content-Type", mediaType)
        headers.set("Idempotency-Key", documentKey)
        headers.set("X-GB-Import-Metadata", encodeDurableImportMetadata(metadata))
        const upstream = await fetch(new URL("/documents/import", INTERNAL_GALAXY_API), {
          method: "POST",
          headers,
          body: exactBody,
          cache: "no-store",
        })
        const payload = await jsonResponse(upstream)
        if (!upstream.ok) {
          throw new CaptureUpstreamError(
            upstream.status === 409 ? 409 : upstream.status >= 500 ? 503 : 422,
            upstream.status === 409
              ? "Capture idempotency key was reused with different content"
              : upstream.status >= 500
                ? "Galaxy document storage is temporarily unavailable"
                : "Galaxy rejected the captured document",
          )
        }
        // executeIngestionPlan validates this receipt against the resolved full
        // plan. metadata.ingestionPlan is only the three-field request claim,
        // so validating against it here would reject every successful import.
        return payload
      },
      transformDocument: async (revisionId, options) => {
        const headers = galaxyHeaders(identity)
        const scopeHash = createHash("sha256").update(options.scope, "utf8").digest("hex")
        headers.set("Content-Type", "application/json")
        headers.set("Idempotency-Key", `web-capture-transform:${scopeHash}`)
        const upstream = await fetch(
          new URL(`/documents/${encodeURIComponent(revisionId)}/transform`, INTERNAL_GALAXY_API),
          { method: "POST", headers, cache: "no-store" },
        )
        const payload = await jsonResponse(upstream)
        if (!upstream.ok || !payload) throw new CaptureTransformError(upstream.status)
        return payload
      },
      mirrorCapture: async (value) => {
        const ham = getPluginDefinition("ham")
        if (!ham) throw new Error("HAM is not registered")
        const token = ham.tokenEnv ? process.env[ham.tokenEnv] : undefined
        if (ham.tokenEnv && !token) throw new Error("HAM is not configured")
        const headers = new Headers({
          "Content-Type": "application/json",
          "Idempotency-Key": `web-capture:${idempotencyKey}`,
          "X-GB-Tenant-ID": identity.tenantId,
          "X-GB-Principal-ID": identity.principalId,
          "X-GB-Principal-Kind": identity.kind,
        })
        if (token) headers.set("Authorization", `Bearer ${token}`)
        const upstream = await fetch(
          new URL("ingest", `${pluginBaseUrl(ham).replace(/\/+$/u, "")}/`),
          {
            method: "POST",
            headers,
            body: JSON.stringify(captureToIngestPayload(value)),
            cache: "no-store",
          },
        )
        if (!upstream.ok) throw new Error("HAM rejected the mirror")
        return jsonResponse(upstream)
      },
    })
    // Legacy callers expect a string even when they do not submit a capture
    // time. Keep that response shape without feeding a volatile server time
    // into the durable intent digest or HAM mirror idempotency material.
    const response = capture.capturedAt
      ? result
      : { ...result, capturedAt: new Date().toISOString() }
    return NextResponse.json(response, { status: 201 })
  } catch (error) {
    if (error instanceof CaptureUpstreamError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    return NextResponse.json({ error: "Web capture ingestion is unavailable" }, { status: 503 })
  }
}
