import assert from "node:assert/strict"
import test from "node:test"

import {
  FIELD_SEARCH_QUERY_MAX,
  FIELD_SEARCH_RESULT_LIMIT,
  FIELD_SEARCH_SNIPPET_MAX,
  projectSemanticFieldSearch,
} from "../lib/semantic-field-search.js"

function entity(index, matches = true) {
  return {
    id: `entity-${index}`,
    kind: "artifact",
    title: matches ? `Vortex source ${index}` : `Other source ${index}`,
    detail: "A bounded local record.",
  }
}

test("Field search keeps Galaxy, corpus, and HAM results separate and bounded", () => {
  const entities = Array.from({ length: 12 }, (_, index) => entity(index))
  const hamResults = Array.from({ length: 13 }, (_, index) => ({
    id: `memory-${index}`,
    content: `${"long retrieval passage ".repeat(30)}${index}`,
    tier: 2,
    score: 1 - index / 100,
    metadata: { title: `HAM memory ${index}`, type: "note" },
  }))
  const corpusResults = Array.from({ length: 11 }, (_, index) => ({
    documentRef: `gb:document:document-${index}@sha256:${"a".repeat(64)}`,
    title: `Corpus document ${index}`,
    snippet: `Matched passage ${index}`,
    matchSource: "content",
    source: { representationKind: "markdown" },
  }))

  const projected = projectSemanticFieldSearch(entities, corpusResults, hamResults, "vortex")

  assert.equal(projected.galaxy.total, 12)
  assert.equal(projected.galaxy.items.length, FIELD_SEARCH_RESULT_LIMIT)
  assert.equal(projected.galaxy.items[0], entities[0])
  assert.equal(projected.corpus.total, 11)
  assert.equal(projected.corpus.items.length, FIELD_SEARCH_RESULT_LIMIT)
  assert.equal(projected.corpus.items[0], corpusResults[0])
  assert.equal(projected.ham.total, 13)
  assert.equal(projected.ham.items.length, FIELD_SEARCH_RESULT_LIMIT)
  assert.equal(projected.ham.items[0].id, "memory-0")
  assert.equal(projected.ham.items[0].score, 1)
  assert.ok(projected.ham.items[0].summary.length <= FIELD_SEARCH_SNIPPET_MAX)
})

test("Field search does not invent a shared score or mutate source order", () => {
  const projected = projectSemanticFieldSearch(
    [entity(1), entity(2)],
    [],
    [
      { id: "low", content: "low score", tier: 1, score: 0.1 },
      { id: "high", content: "high score", tier: 1, score: 0.9 },
    ],
    "vortex",
  )

  assert.deepEqual(projected.galaxy.items.map((item) => item.id), ["entity-1", "entity-2"])
  assert.deepEqual(projected.ham.items.map((item) => item.id), ["low", "high"])
  assert.equal("score" in projected.galaxy.items[0], false)
  assert.equal("score" in projected, false)
  assert.equal(FIELD_SEARCH_QUERY_MAX, 500)
})
