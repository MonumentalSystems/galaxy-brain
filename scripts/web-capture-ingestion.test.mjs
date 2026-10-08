import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { parseCaptureRequest } from "../lib/capture-contract.js"
import { resolveIngestionPlanDefinition } from "../lib/plugins/ingestion-plans.js"
import { executeWebCaptureIngestion } from "../lib/web-capture-ingestion.js"

const ids = {
  document_id: "10000000-0000-4000-8000-000000000001",
  revision_id: "20000000-0000-4000-8000-000000000001",
  artifact_id: "30000000-0000-4000-8000-000000000001",
  source_id: "40000000-0000-4000-8000-000000000001",
}

function durableWebDocument(metadata, { replayed = false } = {}) {
  const revisionSha256 = "b".repeat(64)
  return {
    schemaId: "gb.document.import.v1",
    persisted: true,
    ref: `gb:object:v1:document:${ids.document_id}:pinned:sha256%3A${revisionSha256}`,
    ...ids,
    title: metadata.title,
    display_filename: metadata.filename,
    version: 1,
    content_sha256: "a".repeat(64),
    revision_sha256: revisionSha256,
    byte_size: 34,
    media_type: "text/markdown",
    source_kind: "url",
    original_filename: metadata.filename,
    source_uri: metadata.sourceUri,
    ingestion_plan: resolveIngestionPlanDefinition("web.capture-default"),
    replayed,
    deduplicatedArtifact: replayed,
  }
}

function capture(overrides = {}) {
  return parseCaptureRequest({
    url: "https://example.com/research/article",
    title: "A captured proof note",
    format: "markdown",
    content: "  # Exact body\n\n$\\alpha + \\beta$\n",
    selection: "alpha plus beta",
    tags: ["proof"],
    ...overrides,
  })
}

function runningTransform() {
  return {
    schemaId: "gb.document.transform.v1",
    persisted: true,
    document_revision_id: ids.revision_id,
    status: "running",
    replayed: true,
  }
}

test("web capture persists exact caller bytes before bounded analysis and optional HAM mirroring", async () => {
  const calls = []
  const value = capture()
  const result = await executeWebCaptureIngestion({
    capture: value,
    idempotencyKey: "clipper:proof-note-001",
  }, {
    persistOriginal: async (input) => {
      calls.push(["persist", new TextDecoder().decode(input.bytes), input])
      return durableWebDocument(input.metadata)
    },
    transformDocument: async () => {
      calls.push(["transform"])
      throw Object.assign(new Error("Docling is offline"), { code: "transform-unavailable", retryable: true })
    },
    mirrorCapture: async () => {
      calls.push(["mirror"])
      return { id: "ham-memory-1" }
    },
  })

  assert.deepEqual(calls.map(([name]) => name), ["persist", "transform", "mirror"])
  assert.equal(calls[0][1], value.content)
  assert.equal(calls[0][2].mediaType, "text/markdown")
  assert.equal(calls[0][2].filename, "A captured proof note.md")
  assert.equal(calls[0][2].idempotencyKey, "web-capture:clipper:proof-note-001")
  assert.equal(calls[0][2].metadata.sourceKind, "url")
  assert.equal(calls[0][2].metadata.sourceUri, value.url)
  assert.match(calls[0][2].metadata.captureIntentSha256, /^[0-9a-f]{64}$/u)
  assert.deepEqual(calls[0][2].metadata.ingestionPlan, {
    id: "web.capture-default",
    version: "1.0.0",
    contentSha256: "0e541cf2165e72e38baaeadd2617198bfcf064b0990f3fd8fcf927048f1ca6a8",
  })
  assert.equal(result.document.ref, durableWebDocument(calls[0][2].metadata).ref)
  assert.equal(result.ingestion.status, "persisted")
  assert.equal(result.ingestion.derivation.code, "transform-unavailable")
  assert.equal(result.transform, null)
  assert.equal(result.id, "ham-memory-1")
  assert.deepEqual(result.hamMirror, { status: "mirrored", id: "ham-memory-1" })
})

test("web capture returns live transform truth instead of hiding an in-progress derivation", async () => {
  const result = await executeWebCaptureIngestion({
    capture: capture({ capturedAt: "2026-09-27T12:00:00Z" }),
    idempotencyKey: "clipper:proof-note-running",
  }, {
    persistOriginal: async (input) => durableWebDocument(input.metadata),
    transformDocument: async () => runningTransform(),
  })

  assert.equal(result.ingestion.status, "transforming")
  assert.equal(result.ingestion.derivation.status, "running")
  assert.deepEqual(result.transform, runningTransform())
  assert.equal(result.id, null)
  assert.deepEqual(result.hamMirror, { status: "not-configured" })
})

test("HAM failure cannot invalidate a confirmed Galaxy capture", async () => {
  let persisted = false
  const result = await executeWebCaptureIngestion({
    capture: capture(),
    idempotencyKey: "clipper:proof-note-002",
  }, {
    persistOriginal: async (input) => {
      persisted = true
      return durableWebDocument(input.metadata)
    },
    transformDocument: async () => {
      throw Object.assign(new Error("Unavailable"), { code: "transform-unavailable", retryable: true })
    },
    mirrorCapture: async () => {
      throw new Error("HAM offline")
    },
  })
  assert.equal(persisted, true)
  assert.equal(result.document.persisted, true)
  assert.equal(result.hamMirror.status, "unavailable")
  assert.equal(result.id, null)
})

test("capture route uses submitted bytes and never fetches the provenance URL", async () => {
  const route = await readFile(new URL("../app/api/capture/route.ts", import.meta.url), "utf8")
  assert.match(route, /executeWebCaptureIngestion/)
  assert.match(route, /const exactBody = new Uint8Array\(bytes\)\.buffer/)
  assert.match(route, /body: exactBody/)
  assert.match(route, /new URL\("\/documents\/import", INTERNAL_GALAXY_API\)/)
  assert.match(route, /request\.body\.getReader\(\)/)
  assert.match(route, /reader\.cancel\("Capture body exceeded the configured limit"\)/)
  assert.match(route, /new TextDecoder\("utf-8", \{ fatal: true \}\)/)
  assert.doesNotMatch(route, /request\.arrayBuffer\(\)/)
  assert.doesNotMatch(route, /fetch\(capture\.url/)
  assert.match(route, /Galaxy durability is authoritative/)
  assert.match(route, /"X-GB-Tenant-ID": identity\.tenantId/)
  assert.match(route, /"X-GB-Principal-ID": identity\.principalId/)
  assert.match(route, /upstream\.status === 409[\s\S]*Capture idempotency key was reused with different content/)
  assert.match(route, /return payload/)
  assert.doesNotMatch(route, /validateDurableDocumentImport\(payload, \{ ingestionPlan: metadata\.ingestionPlan \}\)/)
  assert.match(route, /capture\.capturedAt[\s\S]*new Date\(\)\.toISOString\(\)/)
  assert.match(route, /if \(!upstream\.ok\) throw new Error\("HAM rejected the mirror"\)/)
})
