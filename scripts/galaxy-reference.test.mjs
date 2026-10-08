import assert from "node:assert/strict"
import test from "node:test"

import { createGalaxyReference, galaxyReferenceHref, parseGalaxyReference } from "../lib/galaxy-reference-codec.js"

test("Unicode identifiers round-trip against the decoded 512-character boundary", () => {
  const accented = "é".repeat(100)
  const emojiBoundary = "🌀".repeat(512)

  for (const id of [accented, emojiBoundary]) {
    const reference = createGalaxyReference("node", id)
    assert.deepEqual(parseGalaxyReference(reference), { kind: "node", id })
  }

  assert.throws(() => createGalaxyReference("node", `${emojiBoundary}🌀`), /between 1 and 512/)
})

test("legacy reference links require an explicit destination", () => {
  const reference = createGalaxyReference("entity", "claim-é")
  assert.throws(() => galaxyReferenceHref(reference), /explicit supported destination/)
  const href = galaxyReferenceHref(reference, "/workspace")
  const url = new URL(href, "https://galaxybrain.example")

  assert.equal(url.pathname, "/workspace")
  assert.equal(url.searchParams.has("view"), false)
  assert.equal(url.searchParams.get("ref"), reference)
})
