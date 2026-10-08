import assert from "node:assert/strict"
import test from "node:test"

import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import {
  isExactPinnedProofGraphReference,
  planProofCorpusScaleNavigation,
  proofGraphReturnHref,
} from "../lib/graph-semantic-navigation.js"

const HASH = "a".repeat(64)
const GRAPH_REF = createGalaxyObjectReference(
  "proof.graph",
  "winding-prototime/mission:one",
  { mode: "pinned", revision: `sha256:${HASH}` },
)

test("hands an exact proof campaign to the bounded corpus without stale loaders", () => {
  const plan = planProofCorpusScaleNavigation(
    `/graph?mode=proof&lens=verify&scale=task&proofGraph=${HASH}&proofWorkspace=mission-one&proofRegistry=open&ref=${encodeURIComponent(GRAPH_REF)}&keep=1#map`,
    "corpus",
    GRAPH_REF,
  )

  assert.equal(plan.kind, "route")
  const url = new URL(plan.href, "https://galaxy.example")
  assert.equal(url.pathname, "/graph")
  assert.equal(url.hash, "#map")
  assert.equal(url.searchParams.get("mode"), "mixed")
  assert.equal(url.searchParams.get("lens"), "explore")
  assert.equal(url.searchParams.get("scale"), "corpus")
  assert.equal(url.searchParams.get("focus"), GRAPH_REF)
  assert.equal(url.searchParams.get("corpusWindow"), "1")
  assert.equal(url.searchParams.get("keep"), "1")
  for (const stale of ["ref", "proofGraph", "proofWorkspace", "proofRegistry", "conversation", "codeSnapshot"]) {
    assert.equal(url.searchParams.has(stale), false)
  }
})

test("nearer scales stay local and malformed or mutable proof identities never route", () => {
  assert.deepEqual(
    planProofCorpusScaleNavigation("/graph", "project", GRAPH_REF),
    { kind: "local", scale: "project" },
  )
  const latest = createGalaxyObjectReference("proof.graph", "winding-prototime", { mode: "latest" })
  assert.equal(isExactPinnedProofGraphReference(latest), false)
  assert.deepEqual(
    planProofCorpusScaleNavigation("/graph", "corpus", latest),
    { kind: "local", scale: "corpus" },
  )
  assert.equal(isExactPinnedProofGraphReference("gb:object:v1:proof.graph:broken:pinned:sha256%3Anope"), false)
  assert.throws(
    () => planProofCorpusScaleNavigation("/graph", "planet", GRAPH_REF),
    /requestedScale is unsupported/u,
  )
})

test("the corpus context returns to the same exact proof graph at project scale", () => {
  const href = proofGraphReturnHref(
    `/graph?mode=mixed&lens=explore&scale=corpus&focus=${encodeURIComponent(GRAPH_REF)}&proofGraph=${HASH}`,
    GRAPH_REF,
  )
  assert.ok(href)
  const url = new URL(href, "https://galaxy.example")
  assert.equal(url.searchParams.get("mode"), "proof")
  assert.equal(url.searchParams.get("lens"), "explore")
  assert.equal(url.searchParams.get("scale"), "project")
  assert.equal(url.searchParams.get("ref"), GRAPH_REF)
  assert.equal(url.searchParams.has("focus"), false)
  assert.equal(url.searchParams.has("proofGraph"), false)
  assert.equal(url.searchParams.has("corpusWindow"), false)
  assert.equal(proofGraphReturnHref("/graph", "gb:object:v1:proof.graph:x:latest"), null)
})
