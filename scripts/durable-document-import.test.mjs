import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  createDocumentImportIdempotencyKey,
  deriveImportedDocumentReference,
  encodeDurableImportMetadata,
  prepareDurableDocumentImport,
  validateDurableDocumentImport,
} from "../lib/durable-document-import.js"

const ids = {
  document_id: "10000000-0000-4000-8000-000000000001",
  revision_id: "20000000-0000-4000-8000-000000000001",
  artifact_id: "30000000-0000-4000-8000-000000000001",
  source_id: "40000000-0000-4000-8000-000000000001",
}
const revisionSha = "b".repeat(64)
const valid = {
  schemaId: "gb.document.import.v1",
  persisted: true,
  ref: `gb:object:v1:document:${ids.document_id}:pinned:sha256%3A${revisionSha}`,
  ...ids,
  title: "β winding paper",
  display_filename: "beta-winding-paper-bbbbbbbbbbbb.pdf",
  version: 1,
  content_sha256: "a".repeat(64),
  revision_sha256: revisionSha,
  byte_size: 42,
  media_type: "application/pdf",
  source_kind: "upload",
  original_filename: "random-string.pdf",
  source_uri: null,
  ingestion_plan: null,
  replayed: false,
  deduplicatedArtifact: false,
}

function pdfFixture() {
  const beforeXref = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n"
  const xrefOffset = new TextEncoder().encode(beforeXref).byteLength
  return new TextEncoder().encode(`${beforeXref}xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Root 1 0 R /Size 2 >>\nstartxref\n${xrefOffset}\n%%EOF\n`)
}

test("browser-safe import metadata and idempotency keys are bounded and deterministic", async () => {
  const metadata = {
    title: "β winding paper",
    filename: "δοκιμή.pdf",
    sourceKind: "upload",
    sourceUri: null,
    arxivId: null,
  }
  const encoded = encodeDurableImportMetadata(metadata)
  assert.match(encoded, /^[A-Za-z0-9_-]+$/)
  assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")), metadata)
  const bytes = pdfFixture()
  const file = {
    name: metadata.filename,
    type: "application/pdf",
    size: bytes.byteLength,
    async arrayBuffer() {
      return bytes.slice().buffer
    },
  }
  const first = await prepareDurableDocumentImport(file, metadata)
  const replay = await prepareDurableDocumentImport(file, metadata)
  const changedTitle = await prepareDurableDocumentImport(file, { ...metadata, title: "Another paper" })
  assert.equal(first.idempotencyKey, replay.idempotencyKey)
  const legacyMaterial = new TextEncoder().encode(
    `gb.document.import.v1\n${first.contentSha256}\n${first.metadataHeader}`,
  )
  const legacyHash = Buffer.from(await crypto.subtle.digest("SHA-256", legacyMaterial)).toString("hex")
  assert.equal(first.idempotencyKey, `document-import:${legacyHash}`)
  assert.equal(first.mediaType, "application/pdf")
  assert.equal(first.placementOperationId, replay.placementOperationId)
  assert.notEqual(first.idempotencyKey, changedTitle.idempotencyKey)
  assert.match(first.idempotencyKey, /^document-import:[0-9a-f]{64}$/)
  assert.match(first.placementOperationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(
    createDocumentImportIdempotencyKey("a".repeat(64)),
    `document-import:${"a".repeat(64)}`,
  )
  assert.throws(() => createDocumentImportIdempotencyKey("A".repeat(64)), /lowercase SHA-256/)
})

test("a confirmed import yields only its server-authored immutable document reference", () => {
  assert.deepEqual(validateDurableDocumentImport(valid), valid)
  assert.equal(deriveImportedDocumentReference(valid), valid.ref)
  assert.throws(
    () => validateDurableDocumentImport({ ...valid, ref: `gb:object:v1:document:${ids.document_id}:latest` }),
    /pinned reference/,
  )
  assert.throws(() => validateDurableDocumentImport({ ...valid, revision_sha256: "c".repeat(63) }), /revision_sha256/)
  assert.throws(() => validateDurableDocumentImport({ ...valid, persisted: false }), /schema/)
  assert.throws(() => validateDurableDocumentImport({ ...valid, request_sha256: "c".repeat(64) }), /unexpected fields/)
})

test("browser transport sends raw bytes with stable code-owned headers", async () => {
  const [source, proxy] = await Promise.all([
    readFile(new URL("../lib/galaxy-brain-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/eln/[...path]/route.ts", import.meta.url), "utf8"),
  ])
  assert.match(source, /this\.gbFetch\("\/documents\/import"/)
  assert.match(source, /const prepared = await prepareDurableDocumentImport\(file, metadata\)/)
  assert.match(source, /"Content-Type": prepared\.mediaType/)
  assert.match(source, /"Idempotency-Key": prepared\.idempotencyKey/)
  assert.match(source, /"X-GB-Import-Metadata": prepared\.metadataHeader/)
  assert.match(source, /body: prepared\.bytes/)
  assert.doesNotMatch(source, /new FormData\(\)/)
  assert.match(proxy, /"Content-Security-Policy"/)
  assert.match(proxy, /"X-Content-Type-Options"/)
})

test("Atlas import UI keeps durable import and placement as separate announced phases", async () => {
  const [client, dialog] = await Promise.all([
    readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/atlas/document-import-dialog.tsx", import.meta.url), "utf8"),
  ])
  assert.match(client, /setDocumentImportPhase\("importing"\)/)
  assert.match(client, /setDocumentImportPhase\("transforming"\)/)
  assert.match(client, /setDocumentImportPhase\("placing"\)/)
  assert.match(client, /Retry placement without re-uploading/)
  assert.match(client, /placeReference\(imported\.ref, confirmation\.placementOperationId\)/)
  assert.match(client, /error\.status === 415/)
  assert.match(dialog, /exact same file and title/)
  assert.match(dialog, /phase === "idle" \? <a/)
  assert.match(dialog, /aria-live="polite"/)
  assert.match(dialog, /Open exact document revision/)
  assert.match(dialog, /closeBlocked = phase === "importing" \|\| phase === "placing"/)
  assert.match(dialog, /phase === "transforming"[\s\S]*Continue in background/)
})

test("web capture intent is digest-bound only for URL provenance", () => {
  const digest = "c".repeat(64)
  const metadata = {
    title: "Captured theorem",
    filename: "Captured theorem.md",
    sourceKind: "url",
    sourceUri: "https://example.org/theorem",
    arxivId: null,
    captureIntentSha256: digest,
  }
  const encoded = encodeDurableImportMetadata(metadata)
  assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")), metadata)
  assert.throws(
    () => encodeDurableImportMetadata({ ...metadata, sourceKind: "upload", sourceUri: null }),
    /Invalid durable import metadata/,
  )
  assert.throws(
    () => encodeDurableImportMetadata({ ...metadata, captureIntentSha256: "C".repeat(64) }),
    /Invalid durable import metadata/,
  )
})
