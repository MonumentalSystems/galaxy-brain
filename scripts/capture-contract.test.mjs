import assert from "node:assert/strict"
import test from "node:test"

import {
  captureIntentSha256,
  captureToDocumentSource,
  captureToIngestPayload,
  CaptureValidationError,
  parseCaptureIdempotencyKey,
  parseCaptureRequest,
} from "../lib/capture-contract.js"

const page = {
  url: "https://example.com/article?ref=feed",
  title: "  An article  ",
  content: "The body of the page.",
  tags: ["research", "research", " reading "],
  capturedAt: "2026-09-27T01:02:03.456Z",
}

test("normalises a captured page", () => {
  const capture = parseCaptureRequest(page)
  assert.equal(capture.title, "An article")
  assert.equal(capture.url, "https://example.com/article?ref=feed")
  assert.equal(capture.format, "text")
  assert.deepEqual(capture.tags, ["research", "reading"], "tags are trimmed and deduplicated")
  assert.equal(capture.capturedAt, "2026-09-27T01:02:03.456Z")
})

test("capture time is caller-stable and intent hashes exclude no meaningful fields", async () => {
  assert.equal(parseCaptureRequest({ ...page, capturedAt: undefined }).capturedAt, null)
  assert.throws(() => parseCaptureRequest({ ...page, capturedAt: "yesterday" }), /ISO timestamp/)
  const first = parseCaptureRequest(page)
  assert.equal(await captureIntentSha256(first), await captureIntentSha256(parseCaptureRequest(page)))
  assert.notEqual(
    await captureIntentSha256(first),
    await captureIntentSha256(parseCaptureRequest({ ...page, note: "a changed note" })),
  )
  assert.notEqual(
    await captureIntentSha256(first),
    await captureIntentSha256(parseCaptureRequest({ ...page, selection: "a changed quote" })),
  )
})

test("preserves exact submitted document text and selects a closed format", () => {
  const content = "  # Exact heading\n\n$E = mc^2$\n"
  const capture = parseCaptureRequest({ ...page, format: "markdown", content })
  const source = captureToDocumentSource(capture)
  assert.equal(new TextDecoder().decode(source.bytes), content)
  assert.equal(source.mediaType, "text/markdown")
  assert.equal(source.filename, "An article.md")

  assert.equal(
    captureToDocumentSource(parseCaptureRequest({ ...page, format: "html", content: "<p>Exact</p>" })).mediaType,
    "text/html",
  )
  assert.throws(() => parseCaptureRequest({ ...page, format: "docx" }), /format must be/)
  assert.throws(() => parseCaptureRequest({ ...page, content: "bad\u0000text" }), /control characters/)
  assert.throws(() => parseCaptureRequest({ ...page, content: "bad\ud800text" }), /Unicode scalar text/)
  assert.doesNotThrow(() => parseCaptureRequest({ ...page, content: "valid \ud83c\udf0c text" }))
})

test("selection-only captures become exact text documents", () => {
  const source = captureToDocumentSource(parseCaptureRequest({
    url: page.url,
    title: "Selected result",
    format: "text",
    selection: "  exact quoted line  ",
  }))
  assert.equal(new TextDecoder().decode(source.bytes), "  exact quoted line  ")
  assert.equal(source.filename, "Selected result.txt")
  assert.equal(new TextDecoder().decode(captureToDocumentSource(parseCaptureRequest({
    url: page.url,
    content: "   ",
    selection: "selected instead of blank page content",
  })).bytes), "selected instead of blank page content")
})

test("requires a bounded replay-safe capture idempotency key", () => {
  assert.equal(parseCaptureIdempotencyKey("clipper:article-001"), "clipper:article-001")
  for (const value of [null, "short", "has a space", "x".repeat(161)]) {
    assert.throws(() => parseCaptureIdempotencyKey(value), CaptureValidationError)
  }
})

test("falls back to the host when a page has no title", () => {
  const capture = parseCaptureRequest({ ...page, title: "   " })
  assert.equal(capture.title, "example.com")
})

test("accepts only http and https", () => {
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "not a url"]) {
    assert.throws(
      () => parseCaptureRequest({ ...page, url }),
      CaptureValidationError,
      `${url} must be rejected`,
    )
  }
})

test("requires something to capture", () => {
  assert.throws(
    () => parseCaptureRequest({ url: page.url, title: "Empty" }),
    /needs content or a selection/,
  )
  // A selection alone is enough — clipping a quote is a normal thing to do.
  assert.ok(parseCaptureRequest({ url: page.url, selection: "One quoted line." }))
})

test("rejects oversized fields rather than silently truncating", () => {
  assert.throws(
    () => parseCaptureRequest({ ...page, title: "x".repeat(401) }),
    /400 characters or fewer/,
  )
  assert.throws(() => parseCaptureRequest({ ...page, tags: new Array(33).fill("t") }), /32 entries/)
})

test("keeps a selection distinct from the surrounding page", () => {
  const payload = captureToIngestPayload(
    parseCaptureRequest({ ...page, selection: "The quoted sentence.", note: "Why this matters." }),
  )
  assert.match(payload.content, /## Note\n\nWhy this matters\./)
  assert.match(payload.content, /## Selected\n\nThe quoted sentence\./)
  assert.match(payload.content, /## Page\n\nThe body of the page\./)
  assert.match(payload.content, /Source: https:\/\/example\.com\/article/)
  assert.equal(payload.metadata.hasSelection, true)
})

test("captures are link nodes carrying their provenance", () => {
  const payload = captureToIngestPayload(parseCaptureRequest(page))
  assert.equal(payload.type, "link", "a capture is not yet a document or a paper")
  assert.equal(payload.metadata.url, page.url)
  assert.equal(payload.metadata.source, "capture")
  assert.deepEqual(payload.cues, ["research", "reading"])
})

test("omits cues entirely when nothing was tagged", () => {
  const payload = captureToIngestPayload(parseCaptureRequest({ ...page, tags: [] }))
  assert.equal(payload.cues, undefined)
})

test("records which part of the page a region came from", () => {
  const capture = parseCaptureRequest({
    ...page,
    selection: "Vortex unbinding above the transition.",
    region: {
      cssSelector: "main > figure:nth-of-type(2)",
      xpath: "/html/body/main/figure[2]",
      tagName: "FIGURE",
      label: "Figure 6",
    },
  })

  assert.equal(capture.region.tagName, "figure", "tag names normalise to lower case")
  assert.equal(capture.region.label, "Figure 6")

  const payload = captureToIngestPayload(capture)
  assert.match(payload.content, /Region: Figure 6/)
  assert.equal(payload.metadata.region.cssSelector, "main > figure:nth-of-type(2)")
  assert.equal(payload.metadata.region.xpath, "/html/body/main/figure[2]")
})

test("falls back to a selector when a region has no label", () => {
  const payload = captureToIngestPayload(
    parseCaptureRequest({ ...page, region: { cssSelector: "#chart" } }),
  )
  assert.match(payload.content, /Region: #chart/)
})

test("a region needs at least one anchor", () => {
  assert.throws(
    () => parseCaptureRequest({ ...page, region: { tagName: "DIV" } }),
    /needs a cssSelector or an xpath/,
  )
  assert.throws(() => parseCaptureRequest({ ...page, region: [] }), /must be an object/)
})

test("captures without a region carry no region metadata", () => {
  const payload = captureToIngestPayload(parseCaptureRequest(page))
  assert.equal(payload.metadata.region, undefined)
  assert.doesNotMatch(payload.content, /Region:/)
})

