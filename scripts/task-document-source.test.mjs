import assert from "node:assert/strict"
import test from "node:test"

import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import {
  loadTaskDocumentSources,
  parsePinnedDocumentAnchorResource,
} from "../lib/task-document-source.js"

function anchorRef(marker) {
  return createGalaxyObjectReference(
    "document.anchor",
    `sha256:${marker.repeat(64)}`,
    { mode: "pinned", revision: `sha256:${marker.repeat(64)}` },
  )
}

const REVISION_ID = "123e4567-e89b-42d3-a456-426614174000"
const FIRST = anchorRef("a")
const SECOND = anchorRef("b")

test("task source parsing accepts only exact pinned canonical document anchors", () => {
  const parsed = parsePinnedDocumentAnchorResource(FIRST)
  assert.equal(parsed.anchorId, `sha256:${"a".repeat(64)}`)
  assert.equal(parsed.resourceRef, FIRST)
  assert.equal(parsePinnedDocumentAnchorResource(FIRST.replace("%3A", "%3a")), null)
  assert.equal(parsePinnedDocumentAnchorResource("gb:object:v1:document.anchor:example:latest"), null)
  assert.equal(parsePinnedDocumentAnchorResource(
    createGalaxyObjectReference("document", "example", { mode: "pinned", revision: "v1" }),
  ), null)
  assert.equal(parsePinnedDocumentAnchorResource("not-a-reference"), null)
})

test("authorized exact anchors produce reader links with de-duplicated bounded fetches", async () => {
  const byId = new Map([FIRST, SECOND].map((ref) => {
    const parsed = parsePinnedDocumentAnchorResource(ref)
    return [parsed.anchorId, ref]
  }))
  let active = 0
  let maximumActive = 0
  const calls = []
  const fetcher = async (url) => {
    calls.push(url)
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    const id = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1))
    return new Response(JSON.stringify({
      schemaId: "gb.anchor.v1",
      id,
      ref: byId.get(id),
      document_revision_id: REVISION_ID.toUpperCase(),
      selector: id.endsWith("a".repeat(64)) ? { kind: "page-region", page: 7 } : { kind: "json-pointer" },
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  }

  const links = await loadTaskDocumentSources([FIRST, FIRST, SECOND, "not-a-reference"], {
    fetcher,
    concurrency: 1,
  })
  assert.equal(calls.length, 2)
  assert.equal(maximumActive, 1)
  assert.deepEqual(links.map((link) => link.href), [
    `/documents/${REVISION_ID}?paperView=pdf&paperPage=7&paperAnchor=sha256%3A${"a".repeat(64)}`,
    `/documents/${REVISION_ID}?paperView=pdf&paperPage=1&paperAnchor=sha256%3A${"b".repeat(64)}`,
  ])
})

test("authorization failures and identity mismatches leave plain resources unlinked", async () => {
  const forbidden = await loadTaskDocumentSources([FIRST], {
    fetcher: async () => new Response(null, { status: 403 }),
  })
  const missing = await loadTaskDocumentSources([FIRST], {
    fetcher: async () => new Response(null, { status: 404 }),
  })
  const mismatch = await loadTaskDocumentSources([FIRST], {
    fetcher: async () => new Response(JSON.stringify({
      schemaId: "gb.anchor.v1",
      id: `sha256:${"a".repeat(64)}`,
      ref: SECOND,
      document_revision_id: REVISION_ID,
      selector: { kind: "page-region", page: 2 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  })
  assert.deepEqual(forbidden, [])
  assert.deepEqual(missing, [])
  assert.deepEqual(mismatch, [])
})
