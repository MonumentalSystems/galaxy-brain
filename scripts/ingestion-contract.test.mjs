import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { MultipartTooLargeError, readBoundedMultipartBody } from "../lib/bounded-multipart.js"
import {
  canTransformFilename,
  createMarkdownFallbackResult,
  createPlainTextResult,
  encodeDurableImportMetadata,
  IngestionContractError,
  isPlainTextFilename,
  MAX_TRANSFORM_FILE_BYTES,
} from "../lib/ingestion-contract.js"

const source = {
  filename: "A Scholarly Paper.PDF",
  mediaType: "application/pdf",
  byteSize: 42,
  sha256: "a".repeat(64),
}

test("durable import metadata carries Unicode through a bounded ASCII header", () => {
  const metadata = {
    title: "β winding field",
    filename: "δοκιμή.pdf",
    sourceKind: "upload",
    sourceUri: null,
    arxivId: null,
  }
  const encoded = encodeDurableImportMetadata(metadata)
  assert.match(encoded, /^[A-Za-z0-9_-]+$/)
  assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")), metadata)
})

test("multipart bytes are bounded even without a trustworthy Content-Length", async () => {
  const small = new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from([1, 2]))
      controller.enqueue(Uint8Array.from([3]))
      controller.close()
    },
  })
  assert.deepEqual(await readBoundedMultipartBody(small, 3), Buffer.from([1, 2, 3]))

  let cancelled = false
  const oversized = new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from([1, 2, 3, 4]))
    },
    cancel() { cancelled = true },
  })
  await assert.rejects(readBoundedMultipartBody(oversized, 3), MultipartTooLargeError)
  assert.equal(cancelled, true)
})

test("file transform preserves exact source identity and marks Markdown as flat, unpersisted projection", () => {
  const result = createMarkdownFallbackResult(source, "# A Scholarly Paper\n\n$E=mc^2$")
  assert.equal(result.schemaId, "galaxy.document-transform.v1")
  assert.equal(result.persisted, false)
  assert.deepEqual(result.source, { kind: "file", ...source })
  assert.equal(result.document.structure, null)
  assert.match(result.document.markdown, /\$E=mc\^2\$/)
  assert.deepEqual(result.transform, {
    pluginId: "markitdown",
    capability: "transform",
    representation: "markdown",
    fidelity: "flat",
  })
})

test("only known file types can reach the built-in transform", () => {
  assert.equal(canTransformFilename("paper.PDF"), true)
  assert.equal(canTransformFilename("notes.md"), true)
  assert.equal(canTransformFilename("notes.txt"), true)
  assert.equal(canTransformFilename("run.exe"), false)
  assert.throws(() => createMarkdownFallbackResult({ ...source, filename: "run.exe" }, ""), IngestionContractError)
})

test("Markdown and text files decode locally, retaining source hash and original markup", () => {
  const markdown = "# A field note\n\nThe winding term is $\\omega$.\n"
  const bytes = new TextEncoder().encode(markdown)
  const file = {
    ...source,
    filename: "field-note.md",
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
  const result = createPlainTextResult(file, bytes)
  assert.equal(result.document.markdown, markdown)
  assert.equal(result.document.structure, null)
  assert.equal(result.source.sha256, file.sha256)
  assert.equal(result.persisted, false)
  assert.deepEqual(result.transform, {
    pluginId: "plain-text",
    capability: "transform",
    representation: "markdown",
    fidelity: "verbatim",
  })
  assert.equal(isPlainTextFilename("notes.TXT"), true)
  assert.throws(() => createMarkdownFallbackResult(file, markdown), /local transform/)

  const text = "Plain text with a Unicode symbol: β."
  const textBytes = new TextEncoder().encode(text)
  const textFile = {
    ...file,
    filename: "notes.txt",
    byteSize: textBytes.byteLength,
    sha256: createHash("sha256").update(textBytes).digest("hex"),
  }
  assert.equal(createPlainTextResult(textFile, textBytes).document.markdown, text)
})

test("plain-text transform rejects invalid UTF-8 and mismatched byte lengths", () => {
  const badBytes = Uint8Array.from([0xc3, 0x28])
  const file = {
    ...source,
    filename: "notes.txt",
    byteSize: badBytes.byteLength,
    sha256: createHash("sha256").update(badBytes).digest("hex"),
  }
  assert.throws(() => createPlainTextResult(file, badBytes), /valid UTF-8/)
  assert.throws(() => createPlainTextResult({ ...file, byteSize: 3 }, badBytes), /Invalid plain-text source/)
  assert.throws(() => createPlainTextResult({ ...file, sha256: source.sha256 }, badBytes), /does not match bytes/)
})

test("rejects path-bearing names, invalid hashes, and oversized files", () => {
  for (const filename of ["../paper.pdf", "folder\\paper.pdf", "paper\n.pdf"]) {
    assert.throws(() => createMarkdownFallbackResult({ ...source, filename }, ""), /Invalid file name/)
  }
  assert.throws(() => createMarkdownFallbackResult({ ...source, sha256: "a".repeat(63) }, ""), /SHA-256/)
  assert.throws(
    () => createMarkdownFallbackResult({ ...source, byteSize: MAX_TRANSFORM_FILE_BYTES + 1 }, ""),
    /file size/i,
  )
})

test("rejects parser output that is not a bounded Markdown string", () => {
  assert.throws(() => createMarkdownFallbackResult(source, { text: "not markdown" }), /Markdown projection/)
})
