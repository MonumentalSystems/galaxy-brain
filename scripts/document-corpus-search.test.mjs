import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  DOCUMENT_CORPUS_SEARCH_MAX_RESPONSE_BYTES,
  createDocumentCorpusSearchRequest,
  parseDocumentCorpusSearchResponse,
  readDocumentCorpusSearchResponse,
} from "../lib/document-corpus-search.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"

const documentId = "123e4567-e89b-42d3-a456-426614174000"
const revisionId = "223e4567-e89b-42d3-a456-426614174000"
const representationId = "323e4567-e89b-42d3-a456-426614174000"
const revisionSha256 = "a".repeat(64)
const documentRef = createGalaxyObjectReference("document", documentId, {
  mode: "pinned",
  revision: `sha256:${revisionSha256}`,
})

function item(overrides = {}) {
  const sourceOverrides = overrides.source ?? {}
  const itemOverrides = { ...overrides }
  delete itemOverrides.source
  return {
    documentRef,
    documentId,
    documentRevisionId: revisionId,
    revisionSha256,
    title: "Vortex transport",
    displayFilename: "Vortex transport.pdf",
    snippet: "A bounded local passage about helicity and vortices.",
    matchSource: "content",
    ...itemOverrides,
    source: {
      manifestId: `sha256:${"b".repeat(64)}`,
      representationId,
      representationSha256: "c".repeat(64),
      representationKind: "document-structure",
      chunkContentSha256: "d".repeat(64),
      selector: { kind: "json-pointer", pointer: "/blocks/7" },
      ...sourceOverrides,
    },
  }
}

function response(request, items = [item()]) {
  return {
    schemaId: "gb.document-corpus-search.v1",
    query: request.query,
    items,
    continuation: { hasMore: false },
  }
}

test("normalizes one bounded UTF-8 query and a 1-20 result limit", () => {
  assert.deepEqual(createDocumentCorpusSearchRequest({ query: "  helicity  " }), {
    query: "helicity",
    limit: 8,
  })
  assert.deepEqual(createDocumentCorpusSearchRequest({ query: "é".repeat(500), limit: 20 }), {
    query: "é".repeat(500),
    limit: 20,
  })
  for (const value of [
    { query: "" },
    { query: "\u0000" },
    { query: "x".repeat(501) },
    { query: "\ud800" },
    { query: "valid", limit: 0 },
    { query: "valid", limit: 21 },
    { query: "valid", limit: 1.5 },
    { query: "valid", tenantId: documentId },
  ]) assert.throws(() => createDocumentCorpusSearchRequest(value), /document-corpus-search/)
})

test("accepts only exact pinned document results with bounded match provenance", () => {
  const request = createDocumentCorpusSearchRequest({ query: "vortex", limit: 2 })
  const parsed = parseDocumentCorpusSearchResponse(response(request), request)
  assert.equal(parsed.items[0].documentRef, documentRef)
  assert.equal(parsed.items[0].source.selector.pointer, "/blocks/7")
  assert.equal(Object.isFrozen(parsed.items[0].source), true)
  assert.equal(Object.hasOwn(parsed.items[0], "chunkId"), false)
  assert.equal(Object.hasOwn(parsed.items[0], "textContent"), false)
  assert.equal(Object.hasOwn(parsed.items[0], "mediaType"), false)
})

test("rejects title matches and requires exact chunk provenance", () => {
  const request = createDocumentCorpusSearchRequest({ query: "title" })
  const titleItem = item({
    matchSource: "title",
    source: { chunkContentSha256: null, selector: null },
  })
  assert.throws(
    () => parseDocumentCorpusSearchResponse(response(request, [titleItem]), request),
    /matchSource is unsupported/,
  )
  assert.throws(
    () => parseDocumentCorpusSearchResponse(response(request, [item({
      source: { chunkContentSha256: null, selector: null },
    })]), request),
    /chunkContentSha256/,
  )
})

test("rejects latest, mismatched, duplicate, unbounded, and body-bearing results", () => {
  const request = createDocumentCorpusSearchRequest({ query: "vortex", limit: 2 })
  const invalid = []

  const latest = response(request)
  latest.items[0].documentRef = createGalaxyObjectReference("document", documentId)
  invalid.push(latest)

  const mismatchedRevision = response(request)
  mismatchedRevision.items[0].revisionSha256 = "e".repeat(64)
  invalid.push(mismatchedRevision)

  invalid.push(response(request, [item(), item()]))

  const tooMany = response(request, [item(), { ...item(), documentId: "423e4567-e89b-42d3-a456-426614174000" }])
  tooMany.items.push(item())
  invalid.push(tooMany)

  const body = response(request)
  body.items[0].source.textContent = "private full chunk body"
  invalid.push(body)

  const oversizedSnippet = response(request)
  oversizedSnippet.items[0].snippet = "x".repeat(321)
  invalid.push(oversizedSnippet)

  const chunkReference = response(request)
  chunkReference.items[0].chunkId = `sha256:${"f".repeat(64)}`
  invalid.push(chunkReference)

  const wrongQuery = response(request)
  wrongQuery.query = "different"
  invalid.push(wrongQuery)

  for (const value of invalid) {
    assert.throws(() => parseDocumentCorpusSearchResponse(value, request), /document-corpus-search/)
  }
})

test("proxy exposes only exact authenticated GET search and rewrites a bounded q/limit pair", async () => {
  const [proxy, client] = await Promise.all([
    readFile(new URL("../app/api/eln/[...path]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/galaxy-brain-api.ts", import.meta.url), "utf8"),
  ])
  assert.match(proxy, /path\.length === 2 && path\[1\] === "search" && request\.method === "GET"/)
  assert.match(proxy, /queryKeys\.some\(\(key\) => !\["q", "limit"\]\.includes\(key\)\)/)
  assert.match(proxy, /createDocumentCorpusSearchRequest/)
  assert.match(proxy, /q: documentCorpusSearchRequest\.query/)
  assert.match(proxy, /headers\.set\("X-GB-Tenant-ID", identity\.tenantId\)/)
  assert.doesNotMatch(client, /searchDocumentCorpus[\s\S]{0,700}(?:tenantId|endpoint|authorization|Authorization)/)
  assert.match(client, /readDocumentCorpusSearchResponse\(response, request\)/)
  assert.equal(DOCUMENT_CORPUS_SEARCH_MAX_RESPONSE_BYTES, 65_536)
})

test("HTTP parsing enforces the 64 KiB response bound before accepting JSON", async () => {
  const request = createDocumentCorpusSearchRequest({ query: "vortex" })
  const valid = response(request)
  const parsed = await readDocumentCorpusSearchResponse(new Response(JSON.stringify(valid), {
    headers: { "Content-Type": "application/json" },
  }), request)
  assert.equal(parsed.items.length, 1)

  await assert.rejects(
    readDocumentCorpusSearchResponse(new Response("x".repeat(65_537), {
      headers: { "Content-Type": "application/json" },
    }), request),
    /byte bound/,
  )
  await assert.rejects(
    readDocumentCorpusSearchResponse(new Response(JSON.stringify(valid), {
      headers: { "Content-Type": "text/plain" },
    }), request),
    /media type/,
  )
})
