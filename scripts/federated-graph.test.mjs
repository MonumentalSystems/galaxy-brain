import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { projectFederatedGraph } from "../lib/federated-graph.js"

const gitRevision = `git:${"a".repeat(40)};snapshot:sha256:${"b".repeat(64)}`
const proofRevision = `sha256:${"c".repeat(64)}`
const pinnedRef = (kind, id, revision) => `gb:object:v1:${kind}:${encodeURIComponent(id)}:pinned:${encodeURIComponent(revision)}`
const latestRef = (kind, id) => `gb:object:v1:${kind}:${encodeURIComponent(id)}:latest`
const lean = pinnedRef("code.symbol", "Monumental.Vortex.theorem", gitRevision)
const proofGraph = pinnedRef("proof.graph", "vortex-proof", proofRevision)
const proofNode = pinnedRef("proof.node", "vortex-proof#goal-7", proofRevision)
const memory = latestRef("ham.memory", "3262")

function chainFixture() {
  return {
    nodes: [
      { ref: lean, title: "Vortex theorem", detail: "Lean theorem", source: { provider: "codebase-memory", revision: gitRevision } },
      { ref: lean, title: "Duplicate title is ignored", source: { provider: "github", recordId: "repo-1", revision: gitRevision } },
      { ref: proofGraph, title: "Vortex proof DAG", source: { provider: "prove2me", revision: proofRevision } },
      { ref: proofNode, title: "Discharge conservation goal", source: { provider: "prove2me", recordId: "goal-7" } },
      { ref: memory, title: "Why the invariant matters", source: { provider: "ham", recordId: "3262" } },
    ],
    edges: [
      { fromRef: proofGraph, toRef: proofNode, relation: "contains", basis: "deterministic_structure", source: { provider: "prove2me", revision: proofRevision } },
      {
        fromRef: lean,
        toRef: proofNode,
        relation: "verifies",
        basis: "verified_proof",
        source: { provider: "prove2me", recordId: "receipt-4" },
        verification: { status: "verified", method: "lean-replay", evidenceRef: "hyades:receipt:4" },
      },
      { fromRef: memory, toRef: lean, relation: "supports", basis: "semantic_candidate", source: { provider: "ham", recordId: "search-3" } },
    ],
    links: [
      {
        id: "link-1",
        from_ref: proofNode,
        to_ref: lean,
        relation: "formalized_by",
        basis: "authored",
        provenance: { source: "manual", source_system: "galaxy" },
      },
      {
        id: "link-2",
        from_ref: memory,
        to_ref: proofNode,
        relation: "context_for",
        basis: "authored",
        provenance: { source: "manual", source_system: "galaxy" },
      },
    ],
  }
}

test("projects a deduplicated Lean → proof DAG/node → HAM memory chain into the Semantic Field contract", () => {
  const projection = projectFederatedGraph(chainFixture())

  assert.equal(projection.entities.length, 4)
  assert.equal(projection.relations.length, 5)
  assert.equal(projection.corpusStatementCount, 4)
  const theorem = projection.entities.find((entity) => entity.sourceReference === lean)
  assert.equal(theorem.kind, "code-symbol")
  assert.equal(theorem.title, "Vortex theorem")
  assert.deepEqual(theorem.sources.map((source) => source.provider), ["codebase-memory", "github"])
  assert.deepEqual(
    new Set(projection.entities.map((entity) => entity.kind)),
    new Set(["code-symbol", "proof-graph", "proof-node", "memory"]),
  )
  assert.ok(projection.relations.every((edge) => projection.entities.some((entity) => entity.id === edge.from)))
  assert.ok(projection.relations.every((edge) => projection.entities.some((entity) => entity.id === edge.to)))
  assert.deepEqual(
    projection.relations.filter((edge) => edge.basis === "authored_assertion").map((edge) => edge.kind).sort(),
    ["context_for", "formalized_by"],
  )
  assert.ok(projection.relations.filter((edge) => edge.basis === "authored_assertion").every((edge) => edge.source.provider === "ledger:galaxy"))
})

test("retains rich ledger source and snapshot provenance", () => {
  const fixture = chainFixture()
  fixture.links = [{
    id: "derived-1",
    from_ref: proofNode,
    to_ref: lean,
    relation: "formalized_by",
    basis: "derived",
    provenance: {
      source: "derivation",
      source_system: "prove2me-adapter",
      source_ref: "vortex-proof#goal-7",
      source_snapshot: proofRevision,
      extractor_version: "1.0.0",
      confidence: 1,
    },
  }]

  const edge = projectFederatedGraph(fixture).relations.find((relation) => relation.source.recordId === "derived-1")
  assert.equal(edge.basis, "deterministic_structure")
  assert.deepEqual(edge.source, {
    provider: "ledger:prove2me-adapter",
    recordId: "derived-1",
    revision: proofRevision,
  })

  fixture.links[0].provenance.source_system = "invalid\nprovider"
  const rejected = projectFederatedGraph(fixture)
  assert.equal(rejected.relations.some((relation) => relation.source.recordId === "derived-1"), false)
  assert.ok(rejected.truncation.rejectedEdges > 0)
})

test("preserves trust and provenance while semantic proximity can never render as proof", () => {
  const projection = projectFederatedGraph(chainFixture())
  const semantic = projection.relations.find((edge) => edge.basis === "semantic_candidate")
  const verified = projection.relations.find((edge) => edge.basis === "verified_proof")

  assert.equal(semantic.kind, "near")
  assert.equal(semantic.sourceRelation, "supports")
  assert.deepEqual(semantic.source, { provider: "ham", recordId: "search-3" })
  assert.equal(semantic.verification, undefined)
  assert.equal(verified.kind, "verifies")
  assert.deepEqual(verified.verification, {
    status: "verified",
    method: "lean-replay",
    evidenceRef: "hyades:receipt:4",
  })
})

test("drops unverified proof claims and malformed or unresolved inputs", () => {
  const fixture = chainFixture()
  fixture.edges.push(
    { fromRef: lean, toRef: proofNode, relation: "verifies", basis: "verified_proof", source: { provider: "prove2me" } },
    { fromRef: lean, toRef: pinnedRef("code.symbol", "missing", gitRevision), relation: "depends_on", basis: "deterministic_structure", source: { provider: "codebase-memory" } },
  )
  fixture.nodes.push({ ref: "not-a-reference", title: "bad", source: { provider: "bad" } })

  const projection = projectFederatedGraph(fixture)
  assert.equal(projection.entities.length, 4)
  assert.equal(projection.relations.length, 5)
  assert.equal(projection.truncation.rejectedNodes, 1)
  assert.equal(projection.truncation.rejectedEdges, 2)
})

test("projects saved papers and preserves authoritative HAM relation direction", () => {
  const older = latestRef("ham.memory", "41")
  const newer = latestRef("ham.memory", "42")
  const paper = latestRef("paper", "paper-1")
  const projection = projectFederatedGraph({
    nodes: [
      { ref: older, title: "Earlier claim", source: { provider: "ham", recordId: "41" } },
      { ref: newer, title: "Current claim", source: { provider: "ham", recordId: "42" } },
      { ref: paper, title: "Saved paper", source: { provider: "galaxy", recordId: "paper-1" } },
    ],
    edges: [
      { fromRef: newer, toRef: older, relation: "supersedes", basis: "authored_assertion", source: { provider: "ham", recordId: "edge-7" } },
      { fromRef: older, toRef: newer, relation: "superseded_by", basis: "authored_assertion", source: { provider: "ham", recordId: "edge-8" } },
      { fromRef: newer, toRef: older, relation: "contradicts", basis: "authored_assertion", source: { provider: "ham", recordId: "edge-9" } },
      { fromRef: paper, toRef: newer, relation: "cited_by", basis: "authored_assertion", source: { provider: "ham", recordId: "edge-10" } },
    ],
  })

  assert.equal(projection.entities.find((entity) => entity.sourceReference === paper)?.kind, "paper")
  assert.deepEqual(
    projection.relations.map((edge) => edge.kind).sort(),
    ["cited_by", "contradicts", "superseded_by", "supersedes"],
  )
  const supersedes = projection.relations.find((edge) => edge.kind === "supersedes")
  assert.equal(supersedes.from, projection.entities.find((entity) => entity.sourceReference === newer).id)
  assert.equal(supersedes.to, projection.entities.find((entity) => entity.sourceReference === older).id)
  assert.equal(supersedes.source.provider, "ham")
})

test("projects pinned documents and anchors as first-class Field endpoints", () => {
  const document = pinnedRef("document", "document-1", `sha256:${"d".repeat(64)}`)
  const anchor = pinnedRef("document.anchor", `sha256:${"e".repeat(64)}`, `sha256:${"f".repeat(64)}`)
  const projection = projectFederatedGraph({
    nodes: [
      { ref: document, title: "Vortex notes", source: { provider: "galaxy.document", revision: `sha256:${"d".repeat(64)}` } },
      { ref: anchor, title: "Helicity equation", source: { provider: "galaxy.document", recordId: "anchor-1" } },
    ],
    links: [{
      id: "anchor-source",
      from_ref: anchor,
      to_ref: document,
      relation: "part_of",
      basis: "authored",
      provenance: { source: "paper-reader", source_system: "galaxy" },
    }],
  })

  assert.deepEqual(projection.entities.map((entity) => entity.kind), ["document", "document-anchor"])
  assert.deepEqual(projection.entities.map((entity) => entity.sourceReference), [document, anchor])
  assert.equal(projection.relations.length, 1)
  assert.equal(projection.relations[0].kind, "part_of")
  assert.equal(projection.relations[0].basis, "authored_assertion")
})

test("enforces per-node fanout and total bounds with evidence-first selection", () => {
  const anchor = pinnedRef("proof.node", "anchor", proofRevision)
  const nodes = [{ ref: anchor, title: "Anchor", source: { provider: "prove2me" } }]
  const edges = []
  for (let index = 0; index < 8; index += 1) {
    const candidate = latestRef("ham.memory", String(index + 1))
    nodes.push({ ref: candidate, title: `Memory ${index}`, source: { provider: "ham" } })
    edges.push({ fromRef: anchor, toRef: candidate, relation: "near", basis: "semantic_candidate", source: { provider: "ham", recordId: String(index) } })
  }
  const verifiedNode = pinnedRef("code.symbol", "verified-theorem", gitRevision)
  nodes.push({ ref: verifiedNode, title: "Verified theorem", source: { provider: "codebase-memory" } })
  edges.push({
    fromRef: anchor,
    toRef: verifiedNode,
    relation: "verifies",
    basis: "verified_proof",
    source: { provider: "prove2me" },
    verification: { status: "verified", method: "lean-replay", evidenceRef: "receipt:1" },
  })

  const projection = projectFederatedGraph({ nodes, edges }, { maxNodes: 20, maxEdges: 20, maxFanout: 3 })
  assert.equal(projection.relations.length, 3)
  assert.equal(projection.relations[0].basis, "verified_proof")
  assert.equal(projection.relations.filter((edge) => edge.basis === "semantic_candidate").length, 2)
  assert.equal(projection.truncation.fanoutOmissions, 6)

  const nodeLimited = projectFederatedGraph({ nodes, edges }, { maxNodes: 2, maxEdges: 1, maxFanout: 1 })
  assert.equal(nodeLimited.entities.length, 2)
  assert.ok(nodeLimited.relations.length <= 1)
  assert.equal(nodeLimited.truncation.nodeLimitReached, true)
})

test("the Semantic Field accepts authorized projections and keeps canonical deep links", async () => {
  const field = await readFile(new URL("../components/knowledge/semantic-field.tsx", import.meta.url), "utf8")

  assert.match(field, /federatedProjection\?: SemanticFieldProjection/)
  assert.match(field, /\.\.\.federatedProjection\.entities/)
  assert.match(field, /\.\.\.federatedProjection\.relations/)
  assert.match(field, /entity\.sourceReference \?\? \(entity\.sourceNodeId/)
  assert.match(field, /entry\.sourceReference === rawReference/)
  assert.match(field, /Federated relation trust legend/)
  assert.match(field, /"document"/)
  assert.match(field, /"document\.anchor"/)
  assert.match(field, /data-relation-basis/)
})
