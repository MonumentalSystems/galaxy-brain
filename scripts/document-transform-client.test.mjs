import assert from "node:assert/strict"
import test from "node:test"

import {
  DocumentTransformClientError,
  createDocumentTransformClient,
  retryAfterMilliseconds,
  validateDocumentTransformResponse,
} from "../lib/document-transform-client.js"

const revisionId = "123e4567-e89b-42d3-a456-426614174000"

class MemoryStorage {
  constructor() { this.values = new Map() }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, String(value)) }
  removeItem(key) { this.values.delete(key) }
}

function receipt(overrides = {}) {
  return {
    id: "receipt-1",
    plugin_id: "docling",
    plugin_version: "1.0.0",
    engine: "docling",
    engine_version: "api-v1",
    config_sha256: "a".repeat(64),
    input_sha256: "b".repeat(64),
    output_representation_id: "representation-1",
    output_sha256: "c".repeat(64),
    status: "success",
    diagnostic_code: null,
    output_manifest: {
      schemaId: "gb.transform-output-manifest.v1",
      representations: [{
        id: "representation-1",
        kind: "document-structure",
        mediaType: "application/vnd.galaxy.document-structure+json",
        contentSha256: "c".repeat(64),
      }],
    },
    fallback_receipt_id: null,
    created_at: "2026-09-24T12:00:00Z",
    ...overrides,
  }
}

function finalPayload(overrides = {}) {
  return {
    schemaId: "gb.document.transform.v1",
    persisted: true,
    document_revision_id: revisionId,
    representations: [{
      id: "original-1",
      kind: "original",
      media_type: "application/pdf",
      content_sha256: "b".repeat(64),
      artifact_id: "artifact-1",
      content: null,
      created_at: "2026-09-24T11:00:00Z",
    }, {
      id: "representation-1",
      kind: "document-structure",
      media_type: "application/vnd.galaxy.document-structure+json",
      content_sha256: "c".repeat(64),
      artifact_id: null,
      content: { schemaId: "gb.document-structure.v1", pages: [], blocks: [], readingOrder: [] },
      created_at: "2026-09-24T12:00:00Z",
    }],
    receipt: receipt(),
    fallbackReceipt: null,
    replayed: false,
    ...overrides,
  }
}

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 201,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  })
}

test("transform POST is bodyless and reconciles a running response with the same durable key", async () => {
  const storage = new MemoryStorage()
  const requests = []
  const delays = []
  const responses = [
    jsonResponse({
      schemaId: "gb.document.transform.v1",
      persisted: true,
      document_revision_id: revisionId,
      status: "running",
      replayed: true,
    }, { status: 202, headers: { "Retry-After": "2" } }),
    jsonResponse(finalPayload()),
  ]
  const client = createDocumentTransformClient({
    storage,
    createIdempotencyKey: () => "operation-1",
    fetcher: async (url, init) => {
      requests.push({ url, init })
      return responses.shift()
    },
    delay: async (milliseconds) => { delays.push(milliseconds) },
  })

  const result = await client.transform(revisionId, { scope: "tenant-a:principal-a" })
  assert.equal(result.receipt.id, "receipt-1")
  assert.deepEqual(delays, [2_000])
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, `/api/eln/documents/${revisionId}/transform`)
  assert.equal(requests[0].init.method, "POST")
  assert.equal("body" in requests[0].init, false)
  assert.equal(requests[0].init.headers["Idempotency-Key"], "operation-1")
  assert.equal(requests[1].init.headers["Idempotency-Key"], "operation-1")
  assert.equal(storage.values.size, 0)
})

test("explicit reprocess uses an isolated operation and a server-owned mode header", async () => {
  const storage = new MemoryStorage()
  const requests = []
  let generated = 0
  const client = createDocumentTransformClient({
    storage,
    createIdempotencyKey: () => `operation-reprocess-${++generated}`,
    fetcher: async (_url, init) => {
      requests.push(init)
      return jsonResponse(finalPayload())
    },
  })

  await client.transform(revisionId, { scope: "tenant-a:principal-a" })
  await client.transform(revisionId, { scope: "tenant-a:principal-a", reprocess: true })

  assert.equal(requests[0].headers["X-GB-Transform-Mode"], undefined)
  assert.equal(requests[1].headers["X-GB-Transform-Mode"], "reprocess")
  assert.notEqual(requests[0].headers["Idempotency-Key"], requests[1].headers["Idempotency-Key"])
})

test("ambiguous failures survive reload and terminal completion permits a fresh attempt", async () => {
  const storage = new MemoryStorage()
  const keys = []
  let responseMode = "network"
  let generated = 0
  const options = {
    storage,
    createIdempotencyKey: () => `operation-${++generated}`,
    maxPolls: 0,
    fetcher: async (_url, init) => {
      keys.push(init.headers["Idempotency-Key"])
      if (responseMode === "network") throw new TypeError("connection reset")
      return jsonResponse(finalPayload())
    },
  }
  await assert.rejects(
    createDocumentTransformClient(options).transform(revisionId),
    (error) => error instanceof DocumentTransformClientError && error.code === "network-uncertain" && error.retryable,
  )
  assert.equal(storage.values.size, 1)

  responseMode = "final"
  await createDocumentTransformClient(options).transform(revisionId)
  assert.deepEqual(keys, ["operation-1", "operation-1"])
  assert.equal(storage.values.size, 0)

  await createDocumentTransformClient(options).transform(revisionId)
  assert.deepEqual(keys, ["operation-1", "operation-1", "operation-2"])
})

test("bounded polling returns resumable running state and retains its operation", async () => {
  const storage = new MemoryStorage()
  let calls = 0
  const client = createDocumentTransformClient({
    storage,
    maxPolls: 1,
    createIdempotencyKey: () => "operation-running",
    delay: async () => {},
    fetcher: async () => {
      calls += 1
      return jsonResponse({
        schemaId: "gb.document.transform.v1",
        persisted: true,
        document_revision_id: revisionId,
        status: "running",
        replayed: true,
      }, { status: 202, headers: { "Retry-After": "999" } })
    },
  })
  const result = await client.transform(revisionId)
  assert.equal(calls, 2)
  assert.equal(result.status, "running")
  assert.equal(result.pollingExhausted, true)
  assert.equal(result.retryAfterMs, 30_000)
  assert.equal(storage.values.size, 1)
})

test("abort does not discard a possibly-running operation", async () => {
  const storage = new MemoryStorage()
  const controller = new AbortController()
  const client = createDocumentTransformClient({
    storage,
    createIdempotencyKey: () => "operation-aborted",
    fetcher: async () => jsonResponse({
      schemaId: "gb.document.transform.v1",
      persisted: true,
      document_revision_id: revisionId,
      status: "running",
      replayed: true,
    }, { status: 202 }),
    delay: async (_milliseconds, signal) => {
      controller.abort()
      throw signal.reason
    },
  })
  await assert.rejects(client.transform(revisionId, { signal: controller.signal }), /aborted|AbortError/i)
  assert.equal(storage.values.size, 1)
})

test("safe HTTP diagnostics never surface raw backend detail", async () => {
  const storage = new MemoryStorage()
  const client = createDocumentTransformClient({
    storage,
    createIdempotencyKey: () => "operation-denied",
    fetcher: async () => jsonResponse({ detail: "postgres password=super-secret" }, { status: 403 }),
  })
  await assert.rejects(client.transform(revisionId), (error) => {
    assert.equal(error.code, "not-authorized")
    assert.doesNotMatch(error.message, /postgres|password|secret/i)
    return true
  })
  assert.equal(storage.values.size, 0)
})

test("persisted terminal failure envelopes are authoritative even on non-2xx responses", async () => {
  const storage = new MemoryStorage()
  storage.setItem("sentinel", "unrelated")
  const failed = finalPayload({
    representations: [finalPayload().representations[0]],
    receipt: receipt({
      output_representation_id: null,
      output_sha256: null,
      status: "failed",
      diagnostic_code: "docling.not_configured",
      output_manifest: {
        schemaId: "gb.transform-output-manifest.v1",
        representations: [],
      },
    }),
    error: "Document transform did not produce a representation",
  })
  const client = createDocumentTransformClient({
    storage,
    createIdempotencyKey: () => "operation-failed",
    fetcher: async () => jsonResponse(failed, { status: 503 }),
  })
  const result = await client.transform(revisionId)
  assert.equal(result.receipt.status, "failed")
  assert.equal(result.receipt.diagnostic_code, "docling.not_configured")
  assert.equal(storage.values.size, 1)
  assert.equal(storage.getItem("sentinel"), "unrelated")
})

test("retryable HTTP and malformed success remain reconcilable", async () => {
  for (const response of [
    jsonResponse({ detail: "internal topology" }, { status: 503 }),
    jsonResponse({ schemaId: "wrong" }),
  ]) {
    const storage = new MemoryStorage()
    const client = createDocumentTransformClient({
      storage,
      createIdempotencyKey: () => "operation-uncertain",
      fetcher: async () => response,
    })
    await assert.rejects(client.transform(revisionId), (error) => error.retryable === true)
    assert.equal(storage.values.size, 1)
  }
})

test("response validator rejects wrong revisions and incoherent receipts", () => {
  assert.equal(validateDocumentTransformResponse(finalPayload(), revisionId).receipt.status, "success")
  assert.throws(
    () => validateDocumentTransformResponse(finalPayload({ document_revision_id: "018f6b67-3f5d-7cc9-98a5-a1c3ed9a2d88" }), revisionId),
    /invalid document transform response/i,
  )
  assert.throws(
    () => validateDocumentTransformResponse(finalPayload({ receipt: receipt({ status: "complete" }) }), revisionId),
    /invalid document transform response/i,
  )
  assert.throws(
    () => validateDocumentTransformResponse(finalPayload({
      receipt: receipt({ output_representation_id: "missing" }),
    }), revisionId),
    /invalid document transform response/i,
  )
  assert.throws(
    () => validateDocumentTransformResponse(finalPayload({
      representations: [...finalPayload().representations, finalPayload().representations[1]],
    }), revisionId),
    /invalid document transform response/i,
  )
})

test("idempotency keys match the server's printable ASCII contract", async () => {
  for (const key of ["short", "contains space", "unicode-λ"]) {
    const client = createDocumentTransformClient({
      storage: new MemoryStorage(),
      createIdempotencyKey: () => key,
      fetcher: async () => { throw new Error("must not fetch") },
    })
    await assert.rejects(client.transform(revisionId), /retry identity/)
  }
})

test("Retry-After parsing supports seconds and HTTP dates within fixed bounds", () => {
  assert.equal(retryAfterMilliseconds("0"), 250)
  assert.equal(retryAfterMilliseconds("2.5"), 2_500)
  assert.equal(retryAfterMilliseconds("999"), 30_000)
  assert.equal(retryAfterMilliseconds("not-a-date"), 5_000)
  assert.equal(retryAfterMilliseconds("Thu, 01 Jan 2026 00:00:02 GMT", Date.parse("2026-01-01T00:00:00Z")), 2_000)
})
