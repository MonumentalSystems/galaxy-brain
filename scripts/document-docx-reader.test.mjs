import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { DOCX_MEDIA_TYPE, MAX_DOCX_BYTES } from "../lib/docx-document-contract.js"
import { selectExactDerivedDocumentState, shouldAcceptDerivedDocumentCompletion } from "../lib/document-derived-reader.js"
import { exactDocxDocumentDescriptor } from "../lib/document-docx-reader.js"

const ids = {
  document: "10000000-0000-4000-8000-000000000001",
  revision: "20000000-0000-4000-8000-000000000002",
  artifact: "30000000-0000-4000-8000-000000000003",
  original: "40000000-0000-4000-8000-000000000004",
  structure: "50000000-0000-4000-8000-000000000005",
  markdown: "60000000-0000-4000-8000-000000000006",
  primary: "70000000-0000-4000-8000-000000000007",
  fallback: "80000000-0000-4000-8000-000000000008",
}
const contentSha = "a".repeat(64)
const revisionSha = "b".repeat(64)

function revision(overrides = {}) {
  return {
    schemaId: "gb.document-revision.v1",
    document_id: ids.document,
    ref: `gb:object:v1:document:${ids.document}:pinned:sha256%3A${revisionSha}`,
    revision_id: ids.revision,
    version: 1,
    revision_sha256: revisionSha,
    title: "Exact theorem notes",
    display_filename: "exact-theorem-notes-aaaaaaaaaaaa.docx",
    created_at: "2026-09-28T00:00:00Z",
    artifact: { id: ids.artifact, content_sha256: contentSha, byte_size: 4096, media_type: DOCX_MEDIA_TYPE },
    source: { id: "90000000-0000-4000-8000-000000000009", kind: "upload", uri: "", original_filename: "notes.docx" },
    representations: [{
      id: ids.original, kind: "original", media_type: DOCX_MEDIA_TYPE, content_sha256: contentSha,
      content_path: `/documents/${ids.revision}/representations/${ids.original}/content`, created_at: "2026-09-28T00:00:00Z",
    }],
    ...overrides,
  }
}

function derivedFixture() {
  const descriptor = exactDocxDocumentDescriptor(revision(), ids.revision)
  const original = {
    id: ids.original, kind: "original", media_type: DOCX_MEDIA_TYPE, content_sha256: contentSha,
    artifact_id: ids.artifact, content: null, created_at: "2026-09-28T00:00:00Z",
  }
  const structure = {
    id: ids.structure, kind: "document-structure", media_type: "application/vnd.galaxy.document-structure+json",
    content_sha256: "c".repeat(64), artifact_id: null,
    content: { schemaId: "gb.document-structure.v1", pages: [], blocks: [], readingOrder: [] }, created_at: "2026-09-28T00:00:01Z",
  }
  const markdown = {
    id: ids.markdown, kind: "markdown", media_type: "text/markdown; charset=utf-8",
    content_sha256: "d".repeat(64), artifact_id: null, content: "# Exact\n\n$E=mc^2$", created_at: "2026-09-28T00:00:01Z",
  }
  const primary = {
    id: ids.primary, plugin_id: "docling", plugin_version: "1.0.0", engine: "docling", engine_version: "2.130.0",
    config_sha256: "e".repeat(64), input_sha256: contentSha, output_representation_id: ids.structure,
    output_sha256: structure.content_sha256, status: "success", diagnostic_code: null, fallback_receipt_id: null,
    output_manifest: { schemaId: "gb.transform-output-manifest.v1", representations: [structure, markdown].map((item) => ({
      id: item.id, kind: item.kind, mediaType: item.media_type, contentSha256: item.content_sha256,
    })) }, created_at: "2026-09-28T00:00:02Z",
  }
  return { descriptor, original, structure, markdown, primary }
}

test("DOCX descriptor binds the exact original and rejects stale, oversized, and mismatched revisions", () => {
  const descriptor = exactDocxDocumentDescriptor(revision(), ids.revision)
  assert.equal(descriptor.mediaType, DOCX_MEDIA_TYPE)
  assert.equal(descriptor.contentSha256, contentSha)
  assert.match(descriptor.contentUrl, new RegExp(ids.original))
  assert.match(descriptor.contentUrl, new RegExp(`revision_sha256=${revisionSha}`))
  assert.throws(() => exactDocxDocumentDescriptor(revision(), ids.document), /stale/u)
  assert.throws(() => exactDocxDocumentDescriptor(revision({
    artifact: { ...revision().artifact, byte_size: MAX_DOCX_BYTES + 1 },
  }), ids.revision), /limit/u)
  assert.throws(() => exactDocxDocumentDescriptor(revision({ display_filename: "wrong.pdf" }), ids.revision), /filename/u)
  assert.throws(() => exactDocxDocumentDescriptor(revision({
    artifact: { ...revision().artifact, media_type: ` ${DOCX_MEDIA_TYPE.toUpperCase()} ` },
  }), ids.revision), /media type/u)
  assert.throws(() => exactDocxDocumentDescriptor(revision({ representations: [] }), ids.revision), /representations/u)
})

test("media-neutral selector admits only current registered receipt, manifest, hash, and lineage", () => {
  const value = derivedFixture()
  const selected = selectExactDerivedDocumentState(
    value.descriptor, [value.original, value.structure, value.markdown], [value.primary], { label: "DOCX" },
  )
  assert.equal(selected.structure.id, ids.structure)
  assert.equal(selected.markdown.id, ids.markdown)
  for (const receipt of [
    { ...value.primary, plugin_id: "untrusted" },
    { ...value.primary, engine: "other" },
    { ...value.primary, input_sha256: "f".repeat(64) },
    { ...value.primary, output_sha256: "f".repeat(64) },
    { ...value.primary, output_manifest: { ...value.primary.output_manifest, representations: [] } },
  ]) {
    assert.throws(
      () => selectExactDerivedDocumentState(value.descriptor, [value.original, value.structure, value.markdown], [receipt], { label: "DOCX" }),
      /Derived DOCX reading state is invalid/u,
    )
  }
})

test("fallback requires a linked MarkItDown receipt and stale generations cannot commit", () => {
  const value = derivedFixture()
  const fallback = {
    ...value.primary, id: ids.fallback, plugin_id: "markitdown", engine: "markitdown", status: "fallback",
    output_representation_id: ids.markdown, output_sha256: value.markdown.content_sha256,
    fallback_receipt_id: null,
    output_manifest: { schemaId: "gb.transform-output-manifest.v1", representations: [value.primary.output_manifest.representations[1]] },
  }
  const primary = {
    ...value.primary, status: "failed", diagnostic_code: "docling.unavailable", output_representation_id: null,
    output_sha256: null, fallback_receipt_id: ids.fallback,
    output_manifest: { schemaId: "gb.transform-output-manifest.v1", representations: [], fallbackReceiptId: ids.fallback },
  }
  const selected = selectExactDerivedDocumentState(value.descriptor, [value.original, value.markdown], [primary, fallback], { label: "DOCX" })
  assert.equal(selected.fallbackReceipt.id, ids.fallback)
  assert.equal(selected.markdown.id, ids.markdown)
  assert.throws(
    () => selectExactDerivedDocumentState(value.descriptor, [value.original, value.markdown], [primary, { ...fallback, plugin_id: "other" }], { label: "DOCX" }),
    /invalid/u,
  )
  assert.equal(shouldAcceptDerivedDocumentCompletion({ generation: 2, revisionId: ids.revision }, { generation: 2, revisionId: ids.revision }), true)
  assert.equal(shouldAcceptDerivedDocumentCompletion({ generation: 1, revisionId: ids.revision }, { generation: 2, revisionId: ids.revision }), false)
  assert.equal(shouldAcceptDerivedDocumentCompletion({ generation: 2, revisionId: ids.revision }, { generation: 2, revisionId: ids.document }), false)
})

test("DOCX reader is exact-original-first, accessible, and exposes no source-mapped authoring", async () => {
  const [reader, route] = await Promise.all([
    readFile(new URL("../components/documents/exact-docx-document-reader.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/papers/document-reader-route.tsx", import.meta.url), "utf8"),
  ])
  assert.match(route, /isExactDocxMediaType[\s\S]*<ExactDocxDocumentReader/u)
  assert.match(reader, /Download exact original/u)
  assert.match(reader, /images="omit"/u)
  assert.match(reader, /role="status" aria-live="polite" aria-atomic="true"/u)
  assert.match(reader, /role="alert"/u)
  assert.match(reader, /<dd className="min-w-0 break-all">\{receipt\.plugin_id\}<\/dd>/u)
  assert.match(reader, /exact-docx-title" className="research-display mt-2 break-words/u)
  assert.match(reader, /bg-\[hsl\(var\(--research-paper\)\)\][^>]+aria-labelledby="docx-reading-views-title"/u)
  assert.doesNotMatch(reader, /bg-\[#f7f2e6\][^>]+aria-labelledby="docx-reading-views-title"/u)
  assert.match(reader, /controllerRef\.current\?\.abort\(\)/u)
  assert.match(reader, /shouldAcceptDerivedDocumentCompletion/u)
  assert.match(reader, /without source selectors/u)
  assert.doesNotMatch(reader, /createAnchor|createMark|createTask|placeDocumentAnchor|captureSelection/u)
  assert.doesNotMatch(reader, /dangerouslySetInnerHTML|iframe|object|embed/u)
})
