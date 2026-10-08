import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  chooseReaderRepresentations,
  chooseReaderRepresentationState,
  pageCountForStructure,
  paperReaderSearch,
  parsePaperReaderLocation,
  projectExactPageRegion,
  projectExactTextQuote,
  rectangleToPageRegion,
  shouldAcceptPaperMarkCompletion,
  shouldCommitPaperAnchorCompletion,
  textQuoteAnchorForSelection,
  validateReaderDocumentIdentity,
} from "../lib/paper-reader.js"

const revisionId = "123e4567-e89b-42d3-a456-426614174000"
const representations = [
  { id: "original", kind: "original", media_type: "application/pdf", content_sha256: "a".repeat(64), content: null },
  { id: "structure", kind: "document-structure", media_type: "application/vnd.galaxy.document-structure+json", content_sha256: "b".repeat(64), content: { pages: [{ number: 1 }, { number: 2 }] } },
  { id: "markdown", kind: "markdown", media_type: "text/markdown", content_sha256: "c".repeat(64), content: "# Paper\n\n$E=mc^2$" },
  { id: "text", kind: "text", media_type: "text/plain", content_sha256: "e".repeat(64), content: "A unique exact theorem quote.", page_count: 4 },
]

test("reader chooses separate original, page-aware structure, and Markdown representations", () => {
  const chosen = chooseReaderRepresentations(representations)
  assert.equal(chosen.original.id, "original")
  assert.equal(chosen.structure.id, "structure")
  assert.equal(chosen.markdown.id, "markdown")
  assert.equal(chosen.text.id, "text")
  assert.equal(pageCountForStructure(chosen.structure), 2)
  assert.equal(chooseReaderRepresentations([{ ...representations[1], content: { pages: [] } }]).structure, null)
  assert.equal(chooseReaderRepresentations([
    { ...representations[2], id: "older", created_at: "2026-01-01T00:00:00Z" },
    { ...representations[2], id: "newer", created_at: "2026-02-01T00:00:00Z" },
  ]).markdown.id, "newer")
})

test("reader binds derived representations to the latest primary or declared fallback receipt", () => {
  const older = { ...representations[2], id: "older", created_at: "2026-01-01T00:00:00Z" }
  const newer = { ...representations[2], id: "newer", content_sha256: "d".repeat(64), created_at: "2026-02-01T00:00:00Z" }
  const baseReceipt = {
    id: "primary-1",
    status: "failed",
    fallback_receipt_id: "fallback-1",
    created_at: "2026-02-01T00:00:02Z",
    output_manifest: { representations: [] },
  }
  const fallback = {
    id: "fallback-1",
    status: "fallback",
    fallback_receipt_id: null,
    created_at: "2026-02-01T00:00:01Z",
    output_manifest: { representations: [{ id: "newer", contentSha256: "d".repeat(64) }] },
  }
  const selected = chooseReaderRepresentationState([representations[0], older, newer], [fallback, baseReceipt])
  assert.equal(selected.markdown.id, "newer")
  assert.equal(selected.receipt.id, "fallback-1")
  assert.equal(selected.primaryReceipt.id, "primary-1")
  const failed = chooseReaderRepresentationState([representations[0], older], [{ ...baseReceipt, fallback_receipt_id: null }])
  assert.equal(failed.markdown, null)
  assert.equal(failed.primaryReceipt.id, "primary-1")
})

test("text selections bind globally to an exact flat representation without inventing page correspondence", () => {
  assert.deepEqual(textQuoteAnchorForSelection(representations, "unique exact theorem", 3), {
    representation: representations[3],
    selector: { kind: "text-quote", exact: "unique exact theorem" },
  })
  const markdownOnly = [{
    id: "markdown-only",
    kind: "markdown",
    media_type: "text/markdown",
    content_sha256: "f".repeat(64),
    content: "A unique exact theorem quote.",
  }]
  assert.deepEqual(textQuoteAnchorForSelection(markdownOnly, "unique exact theorem", 3).selector, {
    kind: "text-quote",
    exact: "unique exact theorem",
  })
  assert.throws(
    () => textQuoteAnchorForSelection([{ ...markdownOnly[0], content: "repeat repeat" }], "repeat", 1),
    /unambiguously/,
  )
  assert.throws(() => textQuoteAnchorForSelection(markdownOnly, "missing", 1), /unambiguously/)
})

test("saved selectors project only onto one exact PDF quote or one exact rectangle", () => {
  const pages = [
    { pageNumber: 1, textContent: "First page." },
    { pageNumber: 2, textContent: "A unique π theorem." },
  ]
  assert.deepEqual(projectExactTextQuote(pages, { kind: "text-quote", exact: "unique π" }), {
    pageNumber: 2,
    quote: "unique π",
    startOffset: 2,
    endOffset: 10,
  })
  assert.equal(projectExactTextQuote([
    ...pages,
    { pageNumber: 3, textContent: "Another unique π occurrence." },
  ], { kind: "text-quote", exact: "unique π" }), null)
  assert.equal(projectExactTextQuote(pages, { kind: "text-quote", exact: "unique π", page: 1 }), null)
  assert.equal(projectExactTextQuote(pages, { kind: "text-quote", exact: "unique π", prefix: "A " }), null)
  assert.equal(projectExactTextQuote(pages, { kind: "text-quote", exact: "unique π", suffix: " theorem." }), null)
  assert.deepEqual(projectExactPageRegion({
    kind: "page-region",
    page: 4,
    coordinateSpace: "normalized-page",
    polygon: [0.1, 0.2, 0.7, 0.2, 0.7, 0.8, 0.1, 0.8],
  }), { pageNumber: 4, x: 0.1, y: 0.2, width: 0.6, height: 0.6000000000000001 })
  assert.equal(projectExactPageRegion({
    kind: "page-region",
    page: 4,
    coordinateSpace: "normalized-page",
    polygon: [0.5, 0.1, 0.9, 0.5, 0.5, 0.9, 0.1, 0.5],
  }), null)
})

test("late mark completions require the current operation, revision, and selection", () => {
  const current = { generation: 3, selectionGeneration: 7, documentRevisionId: revisionId }
  assert.equal(shouldAcceptPaperMarkCompletion(current, current), true)
  assert.equal(shouldAcceptPaperMarkCompletion({ ...current, generation: 2 }, current), false)
  assert.equal(shouldAcceptPaperMarkCompletion({ ...current, selectionGeneration: 6 }, current), false)
  assert.equal(shouldAcceptPaperMarkCompletion({ ...current, documentRevisionId: "223e4567-e89b-42d3-a456-426614174000" }, current), false)
  assert.equal(shouldAcceptPaperMarkCompletion({ ...current, selectionGeneration: 6 }, current, { requireSelection: false }), true)
})

test("deferred anchor completion commits UI only for its activation selection", () => {
  assert.equal(shouldCommitPaperAnchorCompletion(undefined, 9), true)
  assert.equal(shouldCommitPaperAnchorCompletion(9, 9), true)
  assert.equal(shouldCommitPaperAnchorCompletion(9, 10), false)
  assert.equal(shouldCommitPaperAnchorCompletion(-1, -1), false)
})

test("box selections become one-based normalized page-region selectors", () => {
  assert.deepEqual(rectangleToPageRegion(3, { x: 0.1, y: 0.2, width: 0.4, height: 0.25 }), {
    kind: "page-region",
    page: 3,
    coordinateSpace: "normalized-page",
    polygon: [0.1, 0.2, 0.5, 0.2, 0.5, 0.45, 0.1, 0.45],
  })
  assert.throws(() => rectangleToPageRegion(0, { x: 0, y: 0, width: 1, height: 1 }), /one-based/)
  assert.throws(() => rectangleToPageRegion(1, { x: 0.9, y: 0, width: 0.2, height: 1 }), /normalized/)
  assert.throws(() => rectangleToPageRegion(1, { x: 0, y: 0, width: 0, height: 1 }), /non-empty/)
})

test("reader deep links restore view, page, and canonical anchor without erasing outer navigation", () => {
  const anchor = `sha256:${"d".repeat(64)}`
  const search = paperReaderSearch("?view=field&mechanism=vortex&documentAnchor=old", { view: "markdown", page: 17, anchorId: anchor })
  assert.match(search, /view=field/)
  assert.match(search, /mechanism=vortex/)
  assert.doesNotMatch(search, /documentAnchor/)
  assert.deepEqual(parsePaperReaderLocation(search), {
    schemaId: "gb.paper-reader-location.v1",
    view: "markdown",
    page: 17,
    anchorId: anchor,
  })
  assert.deepEqual(parsePaperReaderLocation("?paperView=nope&paperPage=-3&paperAnchor=bad"), {
    schemaId: "gb.paper-reader-location.v1",
    view: "pdf",
    page: 1,
    anchorId: null,
  })
  assert.equal(parsePaperReaderLocation("?paperView=structure").view, "structure")
  assert.match(
    paperReaderSearch("?view=field", { view: "structure", page: 1, anchorId: null }),
    /paperView=structure/,
  )
})

test("reader identity is exact and bounded", () => {
  assert.deepEqual(validateReaderDocumentIdentity({ documentRevisionId: revisionId.toUpperCase(), title: "  A paper  " }), {
    documentRevisionId: revisionId,
    title: "A paper",
  })
  assert.throws(() => validateReaderDocumentIdentity({ documentRevisionId: "latest", title: "A paper" }), /UUID/)
  assert.throws(() => validateReaderDocumentIdentity({ documentRevisionId: revisionId, title: "" }), /between 1 and 500/)
  assert.equal(validateReaderDocumentIdentity({ documentRevisionId: "018f6b67-3f5d-7cc9-98a5-a1c3ed9a2d88", title: "UUID v7" }).documentRevisionId, "018f6b67-3f5d-7cc9-98a5-a1c3ed9a2d88")
})

test("durable reader binds actions to gb.anchor.v1 and leaves mark and task persistence behind ports", async () => {
  const [reader, client, viewer, markdown, structureReader, markPanel] = await Promise.all([
    readFile(new URL("../components/papers/durable-paper-reader.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/paper-reader-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/pdf-viewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/markdown-renderer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/papers/document-structure-reader.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/documents/document-mark-panel.tsx", import.meta.url), "utf8"),
  ])
  assert.match(reader, /selectedRepresentations\.structure\.id/)
  assert.match(reader, /dataPort\.createAnchor/)
  assert.match(reader, /actionPort\?\.createMark/)
  assert.match(reader, /actionPort\?\.retryMark/)
  assert.match(reader, /actionPort\.listMarkRecoveries\(\)/)
  assert.match(reader, /shouldAcceptPaperMarkCompletion/)
  assert.match(reader, /const frozenBody = note\.trim\(\)[\s\S]*const frozenNoteEditGeneration = noteEditGeneration\.current[\s\S]*await ensureAnchor\(operation\.selectionGeneration\)[\s\S]*body: frozenBody/)
  assert.equal(reader.match(/if \(!shouldCommitPaperAnchorCompletion\(expectedSelectionGeneration, selectionGeneration\.current\)\) return anchor/g)?.length, 2)
  assert.match(reader, /const anchor = await ensureAnchor\(draft\?\.expectedSelectionGeneration\)[\s\S]*if \(!shouldCommitPaperAnchorCompletion\(draft\?\.expectedSelectionGeneration, selectionGeneration\.current\)\) return[\s\S]*window\.localStorage\.setItem\(recoveryKey/)
  assert.match(reader, /const hasFreshEnhanceSelection = !selectedAnchor && Boolean\(draft \|\| draftQuote\)/)
  assert.match(reader, /enabled: intent === "explain" \|\| intent === "challenge"/)
  assert.match(reader, /disabled=\{!canAct \|\| busy\}[\s\S]*onClick=\{\(\) => setEnhanceOpen/)
  assert.match(reader, /function dispatchEnhancement\(executionMode: "review" \| "run"\)[\s\S]*if \(!canAct \|\| !enhanceAvailability\.enabled\) return[\s\S]*resourceRefs = enhanceIntent === "explain" \|\| enhanceIntent === "challenge"[\s\S]*\? undefined[\s\S]*expectedSelectionGeneration: selectionGeneration\.current[\s\S]*executionMode/)
  assert.match(reader, /onClick=\{\(\) => dispatchEnhancement\("review"\)\}[\s\S]*Create reviewable task/)
  assert.match(reader, /onClick=\{\(\) => dispatchEnhancement\("run"\)\}[\s\S]*Create \+ start agent/)
  assert.match(client, /const startsAgentLoop = normalizedRequest\.executionMode === "run"/)
  assert.match(client, /paperAgentLoopKeys\(result\.operation\.idempotencyKey\)[\s\S]*createStarterTaskPlan\(task\)[\s\S]*runStarter\(task, plan/)
  assert.match(client, /clearRecovery\(\) \{[\s\S]*if \(!startsAgentLoop\) storage\(\)\.removeItem\(recoveryKey\)/)
  assert.match(reader, /if \(noteEditGeneration\.current === frozenNoteEditGeneration\) setNote\(""\)/)
  assert.match(reader, /onChange=\{\(event\) => \{[\s\S]*noteEditGeneration\.current \+= 1[\s\S]*setNote\(event\.target\.value\)/)
  assert.equal(reader.match(/if \(isMountedMarkOperationScope\(operation\)\) refreshMarkRecoveries\(\)/g)?.length, 2)
  assert.match(reader, /mountedMarkScope\.current === operation\.scopeKey/)
  assert.match(reader, /ref=\{markStatusRef\}[\s\S]*tabIndex=\{-1\}[\s\S]*aria-live="polite"/)
  assert.match(reader, /aria-labelledby="pending-paper-marks"[\s\S]*role="region"[\s\S]*aria-live="polite"[\s\S]*aria-atomic="false"/)
  assert.match(reader, /requestAnimationFrame\(\(\) => \{[\s\S]*markStatusRef\.current\?\.focus\(\)/)
  assert.match(reader, /exactTextHighlights=\{markTextHighlights\}/)
  assert.match(reader, /projectExactPageRegion\(anchor\.selector\)/)
  assert.match(reader, /actionPort\?\.createTask/)
  assert.match(reader, /onTextSelection=\{\(selection\) => chooseText\(selection\)\}/)
  assert.match(reader, /textQuoteAnchorForSelection\(quoteRepresentations, selection\.quote, selection\.pageNumber\)/)
  assert.doesNotMatch(reader, /textQuoteAnchorForSelection\(representations, selection\.quote/)
  assert.match(reader, /window\.localStorage\.setItem\(recoveryKey/)
  assert.match(reader, /sourceHref: sourceHrefFor\(anchor\)/)
  assert.match(reader, /<MarkdownRenderer[\s\S]*images="embedded"/)
  assert.match(reader, /Retry structure extraction/)
  assert.match(reader, /reprocess: Boolean\(selectedRepresentations\.markdown && !selectedRepresentations\.structure\)/)
  assert.match(reader, /<DocumentStructureReader/)
  assert.match(reader, /<DocumentMarkPanel anchor=\{selectedAnchor\}/)
  assert.match(reader, /Task backlinks/)
  assert.match(reader, /dataPort\.transformDocument/)
  assert.match(reader, /dataPort\.loadRepresentationState/)
  assert.match(reader, /<TabsList/)
  assert.match(reader, /<TabsTrigger[\s\S]*value="structure"/)
  assert.match(reader, /role="status"[\s\S]*aria-live="polite"/)
  assert.match(reader, /markdownIsFallback = selectedRepresentationState\.receipt\?\.status === "fallback"/)
  assert.doesNotMatch(reader, /markdownIsFallback = Boolean\(selectedRepresentations\.markdown/)
  assert.doesNotMatch(reader, /output_manifest/)
  assert.match(client, /documents\/\$\{encodeURIComponent\(documentRevisionId\)\}\/representations\/\$\{encodeURIComponent\(representation\.id\)\}\/content/)
  assert.match(client, /loadRepresentationState/)
  assert.match(client, /createDocumentTransformClient/)
  assert.match(client, /gb\.paper-task-request\.v1/)
  assert.match(client, /createDocumentMarkRecoverably/)
  assert.match(client, /prepareDocumentMarkCreateIntent/)
  assert.match(client, /readDocumentMarkRecoveries/)
  assert.match(client, /semanticRole: request\.intent === "clip" \? "evidence" : "note"/)
  assert.doesNotMatch(client, /idempotency_key: crypto\.randomUUID\(\)/)
  assert.match(viewer, /page\?: number/)
  assert.match(viewer, /projectExactTextQuote\(extractedText, highlight\.selector\)/)
  assert.match(viewer, /onPageChange\?\.\(bounded\)/)
  assert.match(markdown, /skipHtml/)
  assert.match(structureReader, /projectDocumentStructure/)
  assert.match(structureReader, /DISCLOSURE_STEP = 100/)
  assert.match(structureReader, /\.slice\(start, start \+ DISCLOSURE_STEP\)/)
  assert.doesNotMatch(structureReader, /visibleCount/)
  assert.match(structureReader, /images="omit"/)
  assert.match(markPanel, /dataPort\.listMarks\(anchor, controller\.signal\)/)
  assert.match(markPanel, /anchor\.document_revision_id}:\$\{anchor\.id}:\$\{anchor\.ref}/)
  assert.match(markPanel, /resultState\?\.anchorKey === anchorKey \? resultState\.value : null/)
  assert.match(markPanel, /errorState\?\.anchorKey === anchorKey \? errorState\.message : ""/)
  assert.match(markPanel, /request\.current\.anchorKey !== anchorKey/)
  assert.match(markPanel, /setResultState\(\{ anchorKey, value: next \}\)/)
  assert.match(markPanel, /const DISCLOSURE_STEP = 20/)
  assert.match(markPanel, /result\?\.marks\.slice\(0, visibleCount\)/)
  assert.match(markPanel, /visibleMarks\.map\(\(mark\)/)
  assert.doesNotMatch(markPanel, /result\.marks\.map\(/)
  assert.match(markPanel, /Show more marks \(\{visibleMarks\.length\.toLocaleString\(\)\} of \{result\.marks\.length\.toLocaleString\(\)\}\)/)
  assert.match(markPanel, /setVisibleCount\(DISCLOSURE_STEP\)/)
  assert.match(markPanel, /<MarkdownRenderer content=\{mark\.body_markdown\} images="omit"/)
  assert.match(markPanel, /Legacy ink mark · read-only/)
  assert.match(markPanel, /The server returned its 1,000-mark limit\. Additional marks may exist\./)
})

test("authenticated exact-revision route installs the durable task saga", async () => {
  const [page, route, client] = await Promise.all([
    readFile(new URL("../app/documents/[revisionId]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/papers/document-reader-route.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/paper-reader-client.ts", import.meta.url), "utf8"),
  ])
  assert.match(page, /await requireUser\(\)/)
  assert.match(page, /<DocumentReaderRoute/)
  assert.match(route, /loadDurableDocumentRevision\(documentRevisionId, controller\.signal\)/)
  assert.match(route, /createDurablePaperTaskAction\(\{ tenantId, principalId, documentRevisionId \}\)/)
  assert.match(route, /scope: \{ tenantId, principalId, documentRevisionId \}/)
  assert.match(route, /storage: \(\) => window\.localStorage/)
  assert.match(route, /actionPort=\{paperActionPort\}/)
  assert.match(client, /runPaperTaskSaga\(normalizedRequest/)
  assert.match(client, /relation: "context_for"/)
  assert.match(client, /href: paperTaskConstructorHrefFromLink\(link\)/)
})
