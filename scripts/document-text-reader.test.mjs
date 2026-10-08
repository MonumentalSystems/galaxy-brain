import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  ExactTextDocumentError,
  MAX_EXACT_TEXT_DOCUMENT_BYTES,
  exactTextDocumentAnchorSearch,
  exactTextQuoteForSelection,
  exactTextDocumentDescriptor,
  isExactHtmlDocumentDescriptor,
  isExactMarkdownMediaType,
  isExactTextDocumentMediaType,
  loadExactTextDocument,
  selectExactHtmlDerivedState,
  shouldAcceptExactHtmlDerivedCompletion,
  validateExactTextAnchorResponse,
} from "../lib/document-text-reader.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"

const documentId = "10000000-0000-4000-8000-000000000001"
const revisionId = "20000000-0000-4000-8000-000000000002"
const artifactId = "30000000-0000-4000-8000-000000000003"
const representationId = "40000000-0000-4000-8000-000000000004"
const revisionSha256 = "a".repeat(64)

test("exact-text anchor links preserve unrelated navigation and clear conflicting PDF anchors", () => {
  const anchor = `sha256:${"d".repeat(64)}`
  const search = exactTextDocumentAnchorSearch("?view=field&paperAnchor=old&mechanism=vortex", anchor)
  assert.match(search, /view=field/)
  assert.match(search, /mechanism=vortex/)
  assert.match(search, new RegExp(`documentAnchor=${encodeURIComponent(anchor)}`))
  assert.doesNotMatch(search, /paperAnchor/)
  assert.equal(exactTextDocumentAnchorSearch(`${search}&keep=yes`, null), "?view=field&mechanism=vortex&keep=yes")
  assert.throws(() => exactTextDocumentAnchorSearch("?keep=yes", "latest"), ExactTextDocumentError)
})

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

async function digest(bytes) {
  return hash(bytes)
}

function revision(bytes = new TextEncoder().encode("# Exact\n\n$E=mc^2$\n"), mediaType = "text/markdown") {
  const contentSha256 = hash(bytes)
  return {
    schemaId: "gb.document-revision.v1",
    document_id: documentId,
    ref: createGalaxyObjectReference("document", documentId, {
      mode: "pinned",
      revision: `sha256:${revisionSha256}`,
    }),
    revision_id: revisionId,
    version: 1,
    revision_sha256: revisionSha256,
    title: "Exact source",
    display_filename: "exact-source.md",
    created_at: "2026-09-25T12:00:00Z",
    artifact: {
      id: artifactId,
      content_sha256: contentSha256,
      byte_size: bytes.byteLength,
      media_type: mediaType,
    },
    source: { id: "source", kind: "upload", uri: "upload:source", original_filename: "source.md" },
    representations: [{
      id: representationId,
      kind: "original",
      media_type: mediaType,
      content_sha256: contentSha256,
      content_path: `/documents/${revisionId}/representations/${representationId}/content`,
    }],
  }
}

function stream(bytes, splitAt = bytes.byteLength) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, splitAt))
      if (splitAt < bytes.byteLength) controller.enqueue(bytes.subarray(splitAt))
      controller.close()
    },
  })
}

function exactResponse(descriptor, bytes, overrides = {}) {
  const headers = new Headers({
    "content-type": descriptor.mediaType,
    "content-length": String(bytes.byteLength),
    "x-content-sha256": descriptor.contentSha256,
    etag: `"sha256-${descriptor.contentSha256}"`,
    ...overrides.headers,
  })
  return {
    ok: overrides.ok ?? true,
    redirected: overrides.redirected ?? false,
    url: overrides.url ?? "",
    headers,
    body: overrides.body ?? stream(bytes, Math.min(3, bytes.byteLength)),
  }
}

test("exact text descriptors bind one canonical original representation and local URL", () => {
  const value = revision()
  const descriptor = exactTextDocumentDescriptor(value, revisionId)
  assert.equal(descriptor.documentId, documentId)
  assert.equal(descriptor.revisionId, revisionId)
  assert.equal(descriptor.representationId, representationId)
  assert.equal(descriptor.representationRef, `gb:representation:document:${documentId}:${representationId}`)
  assert.equal(descriptor.markdown, true)
  assert.equal(
    descriptor.contentUrl,
    `/api/eln/documents/${revisionId}/representations/${representationId}/content?document_id=${documentId}&revision_sha256=${revisionSha256}`,
  )
  assert.equal(isExactTextDocumentMediaType("text/x-python"), true)
  assert.equal(isExactTextDocumentMediaType("application/json"), true)
  assert.equal(isExactTextDocumentMediaType("application/pdf"), false)
  assert.equal(isExactMarkdownMediaType("text/markdown"), true)
})

function htmlDerivedFixture() {
  const bytes = new TextEncoder().encode("<!doctype html><h1>Exact</h1>")
  const descriptor = exactTextDocumentDescriptor(revision(bytes, "text/html"), revisionId)
  const structureId = "50000000-0000-4000-8000-000000000005"
  const markdownId = "60000000-0000-4000-8000-000000000006"
  const structureHash = "b".repeat(64)
  const markdownHash = "c".repeat(64)
  const original = {
    id: descriptor.representationId,
    kind: "original",
    media_type: "text/html",
    content_sha256: descriptor.contentSha256,
    artifact_id: descriptor.artifactId,
    content: null,
    created_at: "2026-09-28T12:00:00Z",
  }
  const structure = {
    id: structureId,
    kind: "document-structure",
    media_type: "application/vnd.galaxy.document-structure+json",
    content_sha256: structureHash,
    artifact_id: null,
    content: { schemaId: "gb.document-structure.v1", pages: [], blocks: [], readingOrder: [] },
    created_at: "2026-09-28T12:01:00Z",
  }
  const markdown = {
    id: markdownId,
    kind: "markdown",
    media_type: "text/markdown; charset=utf-8",
    content_sha256: markdownHash,
    artifact_id: null,
    content: "# Exact\n\n$E=mc^2$",
    created_at: "2026-09-28T12:01:00Z",
  }
  const receipt = {
    id: "70000000-0000-4000-8000-000000000007",
    plugin_id: "docling",
    plugin_version: "1.0.0",
    engine: "docling",
    engine_version: "api-v1",
    config_sha256: "d".repeat(64),
    input_sha256: descriptor.contentSha256,
    output_representation_id: structureId,
    output_sha256: structureHash,
    status: "success",
    diagnostic_code: null,
    output_manifest: {
      schemaId: "gb.transform-output-manifest.v1",
      representations: [structure, markdown].map((item) => ({
        id: item.id,
        kind: item.kind,
        mediaType: item.media_type,
        contentSha256: item.content_sha256,
      })),
    },
    fallback_receipt_id: null,
    created_at: "2026-09-28T12:01:00Z",
  }
  return { descriptor, original, structure, markdown, receipt }
}

test("HTML derived eligibility is exact and the selector binds source, manifest, output, and receipt", () => {
  const value = htmlDerivedFixture()
  assert.equal(isExactHtmlDocumentDescriptor(value.descriptor), true)
  assert.equal(isExactHtmlDocumentDescriptor({ ...value.descriptor, mediaType: "application/xhtml+xml" }), false)
  const selected = selectExactHtmlDerivedState(
    value.descriptor,
    [value.original, value.structure, value.markdown],
    [value.receipt],
  )
  assert.equal(selected.structure, value.structure)
  assert.equal(selected.markdown, value.markdown)
  assert.equal(selected.primaryReceipt, value.receipt)
  assert.equal(selected.fallbackReceipt, null)

  const corruptions = [
    [{ ...value.receipt, input_sha256: "e".repeat(64) }],
    [{ ...value.receipt, output_sha256: "e".repeat(64) }],
    [{ ...value.receipt, output_representation_id: value.markdown.id }],
    [{ ...value.receipt, status: "unknown" }],
    [{ ...value.receipt, output_manifest: { ...value.receipt.output_manifest, schemaId: "gb.transform-output-manifest.v0" } }],
    [{ ...value.receipt, output_manifest: {
      ...value.receipt.output_manifest,
      representations: [{ ...value.receipt.output_manifest.representations[0], mediaType: "text/plain" }],
    } }],
  ]
  for (const receipts of corruptions) {
    assert.throws(
      () => selectExactHtmlDerivedState(value.descriptor, [value.original, value.structure, value.markdown], receipts),
      /Derived HTML reading state is invalid/,
    )
  }
  assert.throws(
    () => selectExactHtmlDerivedState(
      value.descriptor,
      [{ ...value.original, content_sha256: "e".repeat(64) }, value.structure, value.markdown],
      [value.receipt],
    ),
    /Derived HTML reading state is invalid/,
  )
  assert.throws(
    () => selectExactHtmlDerivedState(value.descriptor, [value.original, value.markdown], []),
    /Derived HTML reading state is invalid/,
  )
})

test("HTML fallback lineage remains explicit and only its manifested output is selected", () => {
  const value = htmlDerivedFixture()
  const fallbackId = "80000000-0000-4000-8000-000000000008"
  const fallback = {
    ...value.receipt,
    id: fallbackId,
    plugin_id: "markitdown",
    engine: "markitdown",
    output_representation_id: value.markdown.id,
    output_sha256: value.markdown.content_sha256,
    status: "fallback",
    output_manifest: {
      schemaId: "gb.transform-output-manifest.v1",
      representations: [value.receipt.output_manifest.representations[1]],
    },
  }
  const primary = {
    ...value.receipt,
    output_representation_id: null,
    output_sha256: null,
    status: "failed",
    diagnostic_code: "provider-failed",
    output_manifest: {
      schemaId: "gb.transform-output-manifest.v1",
      representations: [],
      fallbackReceiptId: fallbackId,
    },
    fallback_receipt_id: fallbackId,
  }
  const selected = selectExactHtmlDerivedState(
    value.descriptor,
    [value.original, value.markdown],
    [primary, fallback],
  )
  assert.equal(selected.structure, null)
  assert.equal(selected.markdown, value.markdown)
  assert.equal(selected.primaryReceipt, primary)
  assert.equal(selected.fallbackReceipt, fallback)
  assert.equal(selected.receipt, fallback)
  assert.throws(
    () => selectExactHtmlDerivedState(value.descriptor, [value.original, value.markdown], [
      { ...primary, output_manifest: { ...primary.output_manifest, fallbackReceiptId: value.receipt.id } },
      fallback,
    ]),
    /Derived HTML reading state is invalid/,
  )
})

test("HTML derived completion fence rejects revision swaps, late lists, superseded transforms, ignored aborts, and delayed focus", () => {
  const current = { generation: 7, revisionId }
  assert.equal(shouldAcceptExactHtmlDerivedCompletion({ generation: 7, revisionId }, current), true)
  const staleScenarios = {
    "revision A completion after revision B": { generation: 7, revisionId: documentId },
    "initial list completion after transform starts": { generation: 6, revisionId },
    "transform one completion after transform two starts": { generation: 6, revisionId },
    "ignored abort completion": { generation: 5, revisionId },
    "delayed focus callback after a newer operation": { generation: 6, revisionId },
  }
  for (const [name, completion] of Object.entries(staleScenarios)) {
    assert.equal(shouldAcceptExactHtmlDerivedCompletion(completion, current), false, name)
  }
  assert.equal(shouldAcceptExactHtmlDerivedCompletion(null, current), false)
})

test("descriptor rejects stale, noncanonical, mismatched, unsupported, and oversized metadata", () => {
  const value = revision()
  assert.throws(
    () => exactTextDocumentDescriptor(value, "50000000-0000-4000-8000-000000000005"),
    /stale document revision/,
  )
  assert.throws(() => exactTextDocumentDescriptor({ ...value, revision_id: revisionId.replace("20000000", "A0000000") }, revisionId), /identifier is invalid/)
  assert.throws(() => exactTextDocumentDescriptor({ ...value, ref: value.ref.replace("sha256", "latest") }, revisionId), /reference does not match/)
  assert.throws(() => exactTextDocumentDescriptor({
    ...value,
    representations: [{ ...value.representations[0], content_sha256: "b".repeat(64) }],
  }, revisionId), /does not match/)
  assert.throws(() => exactTextDocumentDescriptor({
    ...value,
    representations: [...value.representations, { ...value.representations[0], id: "60000000-0000-4000-8000-000000000006" }],
  }, revisionId), /exactly one original/)
  assert.throws(() => exactTextDocumentDescriptor(revision(new Uint8Array([1]), "image/png"), revisionId), /not supported/)
  assert.throws(() => exactTextDocumentDescriptor({
    ...value,
    artifact: { ...value.artifact, byte_size: MAX_EXACT_TEXT_DOCUMENT_BYTES + 1 },
  }, revisionId), /exceeds/)
  assert.throws(() => exactTextDocumentDescriptor({ ...value, title: "bad\nlabel" }, revisionId), /title is invalid/)
})

test("loader requests and verifies one exact immutable UTF-8 response", async () => {
  const bytes = new TextEncoder().encode("const α = 42\n")
  const descriptor = exactTextDocumentDescriptor(revision(bytes, "text/x-typescript"), revisionId)
  let request
  const content = await loadExactTextDocument(descriptor, {
    fetcher: async (url, init) => {
      request = { url, init }
      return exactResponse(descriptor, bytes)
    },
  })
  assert.equal(content, "const α = 42\n")
  assert.equal(request.url, descriptor.contentUrl)
  assert.equal(request.init.cache, "no-store")
  assert.equal(request.init.redirect, "error")
  assert.equal(request.init.headers.Accept, "text/x-typescript")
})

test("loader fails closed on response identity, media, size, hash, redirect, and UTF-8 errors", async (t) => {
  const bytes = new TextEncoder().encode("exact bytes")
  const descriptor = exactTextDocumentDescriptor(revision(bytes, "text/plain"), revisionId)
  const cases = [
    ["redirect flag", exactResponse(descriptor, bytes, { redirected: true })],
    ["external response URL", exactResponse(descriptor, bytes, { url: "https://example.invalid/content" })],
    ["wrong media", exactResponse(descriptor, bytes, { headers: { "content-type": "text/html" } })],
    ["wrong declared hash", exactResponse(descriptor, bytes, { headers: { "x-content-sha256": "b".repeat(64) } })],
    ["wrong ETag", exactResponse(descriptor, bytes, { headers: { etag: `"sha256-${"c".repeat(64)}"` } })],
    ["wrong declared size", exactResponse(descriptor, bytes, { headers: { "content-length": "999" } })],
    ["wrong bytes", exactResponse(descriptor, new TextEncoder().encode("other bytes"), {
      headers: { "content-length": String(bytes.byteLength) },
    })],
  ]
  for (const [name, response] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        loadExactTextDocument(descriptor, { fetcher: async () => response, origin: "https://galaxy.test" }),
        ExactTextDocumentError,
      )
    })
  }

  const invalid = new Uint8Array([0xc3, 0x28])
  const invalidDescriptor = exactTextDocumentDescriptor(revision(invalid, "text/plain"), revisionId)
  await assert.rejects(
    loadExactTextDocument(invalidDescriptor, { fetcher: async () => exactResponse(invalidDescriptor, invalid) }),
    /not valid UTF-8/,
  )

  const tooLarge = new Uint8Array(MAX_EXACT_TEXT_DOCUMENT_BYTES + 1)
  await assert.rejects(
    loadExactTextDocument(descriptor, {
      fetcher: async () => ({
        ok: true,
        redirected: false,
        url: "",
        headers: new Headers({
          "content-type": descriptor.mediaType,
          "x-content-sha256": descriptor.contentSha256,
          etag: `"sha256-${descriptor.contentSha256}"`,
        }),
        body: stream(tooLarge, MAX_EXACT_TEXT_DOCUMENT_BYTES),
      }),
    }),
    /exceeds the reader limit/,
  )
})

test("exact browser selections must be literal, nonempty, unique source substrings", () => {
  assert.deepEqual(exactTextQuoteForSelection("before exact passage after", "exact passage"), {
    kind: "text-quote",
    exact: "exact passage",
  })
  assert.throws(() => exactTextQuoteForSelection("$E=mc^2$", "E = mc²"), /not a literal passage/)
  assert.throws(() => exactTextQuoteForSelection("repeat repeat", "repeat"), /more than once/)
  assert.throws(() => exactTextQuoteForSelection("aaa", "aa"), /more than once/)
  assert.throws(() => exactTextQuoteForSelection("source", " \n "), /non-empty/)
  assert.throws(() => exactTextQuoteForSelection("source", "missing"), ExactTextDocumentError)
})

test("exact anchor acknowledgements remain bound to the requested original selection", async () => {
  const bytes = new TextEncoder().encode("before exact passage after")
  const descriptor = exactTextDocumentDescriptor(revision(bytes, "text/plain"), revisionId)
  const selector = exactTextQuoteForSelection("before exact passage after", "exact passage")
  const selectorSha256 = hash(new TextEncoder().encode(JSON.stringify({ exact: selector.exact, kind: "text-quote" })))
  const anchorSha256 = hash(new TextEncoder().encode(JSON.stringify({
    representationId: descriptor.representationId,
    representationSha256: descriptor.contentSha256,
    selector: { exact: selector.exact, kind: "text-quote" },
  })))
  const value = {
    schemaId: "gb.anchor.v1",
    id: `sha256:${anchorSha256}`,
    ref: createGalaxyObjectReference("document.anchor", `sha256:${anchorSha256}`, {
      mode: "pinned",
      revision: `sha256:${descriptor.contentSha256}`,
    }),
    document_ref: descriptor.documentRef,
    document_id: descriptor.documentId,
    document_revision_id: descriptor.revisionId,
    document_revision_sha256: descriptor.revisionSha256,
    title: descriptor.title,
    display_filename: descriptor.displayFilename,
    representation_id: descriptor.representationId,
    representation_kind: "original",
    representation_media_type: descriptor.mediaType,
    representation_sha256: descriptor.contentSha256,
    selector,
    selector_kind: "text-quote",
    selector_sha256: selectorSha256,
    anchor_sha256: anchorSha256,
    source: { id: "source-1", kind: "upload", uri: null },
    created_at: "2026-09-26T12:00:00Z",
  }
  assert.equal(await validateExactTextAnchorResponse(value, descriptor, selector, { digest }), value)
  await assert.rejects(
    validateExactTextAnchorResponse({ ...value, representation_id: artifactId }, descriptor, selector, { digest }),
    /does not match/,
  )
  await assert.rejects(
    validateExactTextAnchorResponse({ ...value, selector: { ...selector, exact: "other" } }, descriptor, selector, { digest }),
    /changed the selected passage/,
  )
  for (const malformed of [null, {}, { kind: "text-quote" }, { kind: "page-region", exact: "exact passage" }]) {
    await assert.rejects(
      validateExactTextAnchorResponse(value, descriptor, malformed, { digest }),
      ExactTextDocumentError,
    )
  }
})

test("document detail keeps PDFs in the paper reader and renders exact text safely", async () => {
  const [route, reader, helper, client] = await Promise.all([
    readFile(new URL("../components/papers/document-reader-route.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/documents/exact-text-document-reader.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/document-text-reader.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/paper-reader-client.ts", import.meta.url), "utf8"),
  ])
  assert.match(route, /revision\.artifact\.media_type !== "application\/pdf"/)
  assert.match(route, /<ExactTextDocumentReader[\s\S]*revision=\{revision\}[\s\S]*dataPort=\{dataPort\}[\s\S]*actionPort=\{paperActionPort\}/)
  assert.match(route, /<DurablePaperReader/)
  assert.match(route, /This document needs a registered detail renderer/)
  assert.match(reader, /<MarkdownRenderer content=\{activeContent\} images="omit"/)
  assert.match(reader, /<pre[\s\S]*tabIndex=\{0\}[\s\S]*><code>\{activeContent\}<\/code><\/pre>/)
  assert.match(reader, /role="alert"/)
  assert.match(reader, /role="status"[\s\S]*aria-live="polite"/)
  assert.match(reader, /exactTextQuoteForSelection\(activeContent, browserSelection\.toString\(\)\)/)
  assert.match(reader, /dataPort\.createAnchor\(descriptor\.revisionId, descriptor\.representationId, selector\)/)
  assert.match(reader, /validateExactTextAnchorResponse\(response, descriptor, selector\)/)
  assert.match(reader, /actionPort\.createMark/)
  assert.match(reader, /actionPort\.retryMark/)
  assert.match(reader, /actionPort\.listMarkRecoveries\(\)/)
  assert.match(reader, /<DocumentMarkPanel anchor=\{preparedAnchor\?\.anchor \?\? null\}/)
  assert.match(reader, /body: intent === "clip" \? "" : frozenNote/)
  assert.match(reader, /noteEditGeneration\.current \+= 1/)
  assert.match(reader, /ensureAnchor\(operation\.selectionGeneration\)/)
  assert.match(reader, /shouldAcceptPaperMarkCompletion/)
  assert.match(reader, /shouldCommitPaperAnchorCompletion/)
  assert.match(reader, /currentPreparedAnchor\?\.anchor\.id === initialAnchorId[\s\S]*currentPreparedAnchor\.anchor\.representation_sha256 === descriptor\.contentSha256/)
  assert.match(reader, /preparedAnchorRef\.current = \{ exact: selector\.exact, anchor \}[\s\S]*setPreparedAnchor\(\{ exact: selector\.exact, anchor \}\)[\s\S]*replaceDocumentAnchor\(anchor\.id\)/)
  assert.match(reader, /ref=\{markStatusRef\}[\s\S]*tabIndex=\{-1\}[\s\S]*aria-live="polite"/)
  assert.match(reader, /aria-labelledby="pending-exact-text-marks"[\s\S]*role="region"[\s\S]*aria-live="polite"/)
  assert.match(reader, /exactTextDocumentAnchorSearch\(window\.location\.search, anchorId\)/)
  assert.match(reader, /`\$\{window\.location\.pathname\}\$\{search\}\$\{window\.location\.hash\}`/)
  assert.match(reader, /actionPort\.createTask/)
  assert.match(reader, /placeDocumentAnchorRecoverably/)
  assert.match(reader, /paperTaskRecoveryKey/)
  assert.match(reader, /readPaperTaskRecoveries/)
  assert.match(reader, /Retry same request/)
  assert.match(reader, /dataPort\.getAnchor\(descriptor\.revisionId, initialAnchorId, controller\.signal\)/)
  assert.match(reader, /Exact source passage restored from its durable deep link/)
  const restoreEffect = reader.slice(reader.indexOf("dataPort.getAnchor"), reader.indexOf("const captureSelection"))
  assert.match(restoreEffect, /controller\.signal\.aborted[\s\S]*shouldCommitPaperAnchorCompletion\(expectedSelectionGeneration, selectionGeneration\.current\)/)
  assert.doesNotMatch(restoreEffect, /replaceDocumentAnchor\(null\)/)
  assert.match(reader, /isExactHtmlDocumentDescriptor/)
  assert.match(reader, /selectExactHtmlDerivedState/)
  assert.match(reader, /<TabsTrigger value="source"[\s\S]*>Source<\/TabsTrigger>/)
  assert.match(reader, /<TabsTrigger[\s\S]*value="structure"[\s\S]*>Structured text<\/TabsTrigger>/)
  assert.match(reader, /<TabsTrigger[\s\S]*value="markdown"[\s\S]*>Markdown \+ math<\/TabsTrigger>/)
  assert.match(reader, /<DocumentStructureReader structure=\{htmlStructure\.content as GalaxyDocumentStructure\}/)
  assert.match(reader, /<MarkdownRenderer content=\{htmlMarkdown\.content as string\} images="omit"/)
  assert.match(reader, /sourceViewSelected && sourceVerified[\s\S]*aria-labelledby="exact-text-actions-title"/)
  assert.match(reader, /const sourceDocument = \([\s\S]*<DocumentMarkPanel/)
  assert.match(reader, /const htmlTabsActive = htmlDerivedEligible && sourceVerified/)
  assert.match(reader, /\{htmlTabsActive \? \([\s\S]*<Tabs[\s\S]*<TabsTrigger value="source"[\s\S]*<TabsContent value="source" className="m-0">\{sourceDocument\}<\/TabsContent>/)
  assert.match(reader, /\) : \(\s*<>\{sourceActions\}\{sourceDocument\}<\/>\s*\)\}/)
  assert.match(reader, /Read-only derived structure/)
  assert.match(reader, /Read-only derived Markdown and math/)
  assert.match(reader, /htmlTransformController\.current\?\.abort\(\)[\s\S]*htmlDerivedRequestGeneration\.current = generation/)
  assert.match(reader, /shouldAcceptExactHtmlDerivedCompletion[\s\S]*htmlDerivedRevision\.current/)
  assert.match(reader, /setContentRevisionId\(descriptor\.revisionId\)/)
  const transformStart = reader.indexOf("async function transformHtmlDocument")
  const transformFlow = reader.slice(transformStart, reader.indexOf("if (!descriptor)", transformStart))
  assert.doesNotMatch(transformFlow, /requestAnimationFrame|activeElement|\.focus\(/)
  assert.doesNotMatch(reader, /htmlDerivedViewTrigger/)
  const invalidDerivedViewEffect = reader.slice(
    reader.indexOf('if ((htmlView === "structure"'),
    reader.indexOf('useEffect(() => {', reader.indexOf('if ((htmlView === "structure"') + 1),
  )
  assert.match(invalidDerivedViewEffect, /setHtmlView\("source"\)/)
  assert.doesNotMatch(invalidDerivedViewEffect, /setSelection|setMarkNote|setTask|replaceDocumentAnchor|history\./)
  assert.doesNotMatch(reader, /dangerouslySetInnerHTML/)
  assert.doesNotMatch(reader, /\/api\/eln/)
  assert.doesNotMatch(helper, /method:\s*["']POST["']/)
  assert.doesNotMatch(helper, /https?:\/\//)
  assert.match(client, /revision\.revision_id !== documentRevisionId\.toLowerCase\(\)/)
})
