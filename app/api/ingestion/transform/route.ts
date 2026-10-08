import { createHash } from "node:crypto"

import { NextRequest, NextResponse } from "next/server"

import { MultipartTooLargeError, readBoundedMultipartBody } from "@/lib/bounded-multipart.js"
import {
  createMarkdownFallbackResult,
  createPlainTextResult,
  IngestionContractError,
  isPlainTextFilename,
  MAX_TRANSFORM_FILE_BYTES,
  validateFileSource,
} from "@/lib/ingestion-contract.js"
import { getTransformPluginDefinition, pluginBaseUrl } from "@/lib/plugin-registry.js"
import { getRequestIdentity, identityCanAny } from "@/lib/request-identity"

export const runtime = "nodejs"

const TRANSFORM_SCOPES = ["ingestion:transform", "ingestion:*"]
const MAX_MULTIPART_BYTES = MAX_TRANSFORM_FILE_BYTES + 1_048_576

/**
 * Parse an uploaded file through a registered, server-selected transform.
 * This returns a preview, not a durable object or a HAM memory. Callers must
 * preserve the original bytes when they later create a Galaxy object.
 */
export async function POST(request: NextRequest) {
  const identity = await getRequestIdentity(request)
  if (!identity) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!identityCanAny(identity, TRANSFORM_SCOPES)) {
    return NextResponse.json({ error: "Missing ingestion:transform scope" }, { status: 403 })
  }

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
    return NextResponse.json({ error: "Expected multipart file upload" }, { status: 415 })
  }
  const declaredLength = Number(request.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MULTIPART_BYTES) {
    return NextResponse.json({ error: "Upload is too large" }, { status: 413 })
  }

  // A client can omit or falsify Content-Length. Bound the stream itself
  // before the multipart parser allocates parts in memory.
  let multipartBytes: Buffer
  try {
    multipartBytes = await readBoundedMultipartBody(request.body, MAX_MULTIPART_BYTES)
  } catch (error) {
    if (error instanceof MultipartTooLargeError) {
      return NextResponse.json({ error: "Upload is too large" }, { status: 413 })
    }
    return NextResponse.json({ error: "Invalid multipart upload" }, { status: 400 })
  }

  let file: File
  try {
    const boundedRequest = new Request(request.url, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type")! },
      body: new Uint8Array(multipartBytes),
    })
    const fields = await boundedRequest.formData()
    const files = fields.getAll("file")
    if (files.length !== 1 || !(files[0] instanceof File)) {
      return NextResponse.json({ error: "Provide exactly one file" }, { status: 400 })
    }
    file = files[0]
    if (file.size > MAX_TRANSFORM_FILE_BYTES) {
      return NextResponse.json({ error: "Upload is too large" }, { status: 413 })
    }
  } catch {
    return NextResponse.json({ error: "Invalid multipart upload" }, { status: 400 })
  }

  let source
  let bytes: Buffer
  try {
    bytes = Buffer.from(await file.arrayBuffer())
    source = {
      filename: file.name,
      mediaType: file.type,
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }
    // Validate before sending the file to a parser. The hash is of the exact
    // submitted bytes, never of the parser's Markdown output.
    validateFileSource(source)
  } catch (error) {
    const message = error instanceof IngestionContractError ? error.message : "Invalid file upload"
    const status = file.size > MAX_TRANSFORM_FILE_BYTES ? 413 : 400
    return NextResponse.json({ error: message }, { status })
  }

  if (isPlainTextFilename(source.filename)) {
    if (!getTransformPluginDefinition("plain-text")) {
      return NextResponse.json({ error: "Document transform is unavailable" }, { status: 503 })
    }
    try {
      return NextResponse.json(createPlainTextResult(source, bytes), {
        headers: { "Cache-Control": "no-store" },
      })
    } catch (error) {
      const message = error instanceof IngestionContractError ? error.message : "Invalid plain-text file"
      return NextResponse.json({ error: message }, { status: message.includes("limit") ? 413 : 400 })
    }
  }

  const transform = getTransformPluginDefinition("markitdown")
  if (!transform || transform.transport !== "service") {
    return NextResponse.json({ error: "Document transform is unavailable" }, { status: 503 })
  }
  const token = process.env[transform.tokenEnv]
  if (!token) return NextResponse.json({ error: "Document transform is not configured" }, { status: 503 })

  const form = new FormData()
  form.set("file", file, file.name)
  let upstream: Response
  try {
    upstream = await fetch(
      new URL(transform.endpoint, `${pluginBaseUrl(transform).replace(/\/+$/, "")}/`),
      {
        method: "POST",
        headers: { [transform.tokenHeader]: token },
        body: form,
        cache: "no-store",
        signal: AbortSignal.timeout(120_000),
      },
    )
  } catch {
    return NextResponse.json({ error: "Document transform is unavailable" }, { status: 502 })
  }
  if (!upstream.ok) {
    return NextResponse.json(
      { error: upstream.status === 415 ? "Unsupported file type" : "Document transform failed" },
      { status: upstream.status === 415 ? 415 : 502 },
    )
  }
  try {
    const result = await upstream.json()
    return NextResponse.json(createMarkdownFallbackResult(source, result?.markdown), {
      headers: { "Cache-Control": "no-store" },
    })
  } catch {
    return NextResponse.json({ error: "Document transform returned an invalid result" }, { status: 502 })
  }
}
