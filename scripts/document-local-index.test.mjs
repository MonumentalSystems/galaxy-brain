import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  DOCUMENT_LOCAL_INDEX_STATUS_SCHEMA,
  parseDocumentLocalIndexStatus,
} from "../lib/document-local-index.js"
import { validateDocumentTransformResponse } from "../lib/document-transform-client.js"

const revisionId = "123e4567-e89b-42d3-a456-426614174000"
const representationId = "223e4567-e89b-42d3-a456-426614174000"

function readyStatus(overrides = {}) {
  const sourceOverrides = overrides.source ?? {}
  const statusOverrides = { ...overrides }
  delete statusOverrides.source
  return {
    schemaId: DOCUMENT_LOCAL_INDEX_STATUS_SCHEMA,
    status: "ready",
    chunk_count: 0,
    chunks_sha256: "d".repeat(64),
    ...statusOverrides,
    source: {
      manifest_id: `sha256:${"e".repeat(64)}`,
      representation_id: representationId,
      representation_sha256: "c".repeat(64),
      representation_kind: "document-structure",
      chunker: "galaxy.document-structure-blocks",
      chunker_version: "1",
      chunker_config_sha256: "f".repeat(64),
      ...sourceOverrides,
    },
  }
}

function transformPayload(localIndex) {
  const original = {
    id: "original-1",
    kind: "original",
    media_type: "application/pdf",
    content_sha256: "b".repeat(64),
    artifact_id: "artifact-1",
    content: null,
    created_at: "2026-09-24T11:00:00Z",
  }
  const structure = {
    id: representationId,
    kind: "document-structure",
    media_type: "application/vnd.galaxy.document-structure+json",
    content_sha256: "c".repeat(64),
    artifact_id: null,
    content: { schemaId: "gb.document-structure.v1", pages: [], blocks: [], readingOrder: [] },
    created_at: "2026-09-24T12:00:00Z",
  }
  return {
    schemaId: "gb.document.transform.v1",
    persisted: true,
    document_revision_id: revisionId,
    representations: [original, structure],
    ...(localIndex === undefined ? {} : { local_index: localIndex }),
    receipt: {
      id: "receipt-1",
      plugin_id: "docling",
      plugin_version: "1.0.0",
      engine: "docling",
      engine_version: "api-v1",
      config_sha256: "a".repeat(64),
      input_sha256: original.content_sha256,
      output_representation_id: structure.id,
      output_sha256: structure.content_sha256,
      status: "success",
      diagnostic_code: null,
      output_manifest: {
        schemaId: "gb.transform-output-manifest.v1",
        representations: [{
          id: structure.id,
          kind: structure.kind,
          mediaType: structure.media_type,
          contentSha256: structure.content_sha256,
        }],
      },
      fallback_receipt_id: null,
      created_at: "2026-09-24T12:00:00Z",
    },
    fallbackReceipt: null,
    replayed: false,
  }
}

test("old backends omit local-index status without inventing not-built state", () => {
  assert.equal(parseDocumentLocalIndexStatus(undefined), undefined)
  assert.equal(validateDocumentTransformResponse(transformPayload(), revisionId).local_index, undefined)
})

test("explicit not-built and ready manifests preserve truthful zero and positive counts", () => {
  assert.deepEqual(parseDocumentLocalIndexStatus({
    schemaId: DOCUMENT_LOCAL_INDEX_STATUS_SCHEMA,
    status: "not-built",
  }), {
    schemaId: DOCUMENT_LOCAL_INDEX_STATUS_SCHEMA,
    status: "not-built",
  })

  for (const count of [0, 42]) {
    const parsed = parseDocumentLocalIndexStatus(readyStatus({ chunk_count: count }))
    assert.equal(parsed.status, "ready")
    assert.equal(parsed.chunk_count, count)
    assert.equal(parsed.source.representation_id, representationId)
    assert.equal(parsed.source.representation_kind, "document-structure")
  }
})

test("local-index status rejects malformed, extra, and body-bearing objects", () => {
  const valid = readyStatus()
  const invalid = [
    null,
    [],
    { schemaId: "wrong", status: "not-built" },
    { schemaId: DOCUMENT_LOCAL_INDEX_STATUS_SCHEMA, status: "not-built", chunk_count: 0 },
    { ...valid, status: "building" },
    { ...valid, chunk_count: -1 },
    { ...valid, chunk_count: 100_001 },
    { ...valid, chunk_count: 1.5 },
    { ...valid, chunks_sha256: "not-a-digest" },
    { ...valid, source: { ...valid.source, representation_id: "latest" } },
    { ...valid, source: { ...valid.source, representation_kind: "original" } },
    { ...valid, unexpected: true },
    { ...valid, chunks: [] },
    { ...valid, text_content: "private chunk body" },
    { ...valid, textContent: "private chunk body" },
    { ...valid, source: { ...valid.source, text_content: "private chunk body" } },
  ]
  for (const value of invalid) {
    assert.throws(() => parseDocumentLocalIndexStatus(value), /local index/i)
  }
})

test("terminal transform validation carries only the bounded local-index summary", () => {
  const localIndex = readyStatus({ chunk_count: 7 })
  const result = validateDocumentTransformResponse(transformPayload(localIndex), revisionId)
  assert.deepEqual(result.local_index, localIndex)
  assert.equal(Object.hasOwn(result.local_index, "chunks"), false)
  assert.equal(Object.hasOwn(result.local_index, "text_content"), false)
  assert.equal(Object.hasOwn(result.local_index, "textContent"), false)
})

test("reader suppresses unknown status and uses exact local-only copy without broader claims", async () => {
  const [reader, client] = await Promise.all([
    readFile(new URL("../components/papers/durable-paper-reader.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/paper-reader-client.ts", import.meta.url), "utf8"),
  ])
  const start = reader.indexOf("{localIndex ? (")
  const end = reader.indexOf(") : null}", start)
  assert.ok(start >= 0 && end > start, "reader must suppress an absent optional status")
  const statusUi = reader.slice(start, end + ") : null}".length)

  assert.match(statusUi, /"Local index not built"/)
  assert.match(statusUi, /localIndex\.chunk_count\.toLocaleString\(\).*local chunks/)
  assert.match(statusUi, /localIndex\.source\.representation_kind/)
  assert.doesNotMatch(statusUi, /\b(?:HAM|RAG|search)\b/iu)
  assert.doesNotMatch(statusUi, /(?:text_content|textContent|output_manifest|chunks_sha256)/u)

  assert.match(client, /localIndex: parseDocumentLocalIndexStatus\(payload\.local_index\)/)
  assert.match(reader, /setLocalIndex\(result\.local_index\)/)
})
