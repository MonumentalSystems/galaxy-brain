import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { prove2meGraphToProofDag } from "../lib/prove2me-proof-dag.js"
import { parseProofDag } from "../lib/proof-task-graph.js"

/**
 * Shaped after a real GET /api/v1/theorems/:id/graph response: two theorems
 * joined through a sketch node, plus the structural edge Prove2me derives from
 * that sketch. The sketch node is keyed by node_id, not theorem_id.
 */
const graph = {
  root_id: "root-theorem",
  nodes: [
    {
      node_type: "theorem",
      theorem_id: "root-theorem",
      theorem_name: "Demo.root",
      theorem_title: "The root theorem",
      status: "Open",
      natural_language_statement: "The statement being reduced.",
    },
    {
      node_type: "theorem",
      theorem_id: "child-lemma",
      theorem_name: "Demo.child",
      theorem_title: "A supporting lemma",
      status: "Proved",
      natural_language_statement: "The lemma the sketch imports.",
    },
    {
      node_type: "sketch",
      node_id: "sketch-1",
      parent_theorem_id: "root-theorem",
      status: "ACCEPTED",
    },
  ],
  edges: [
    { source: "child-lemma", target: "sketch-1", kind: "sketch" },
    { source: "sketch-1", target: "root-theorem", kind: "sketch" },
    { source: "child-lemma", target: "root-theorem", kind: "structural" },
  ],
}

test("converts a Prove2me graph into a parseable proof DAG", () => {
  const document = prove2meGraphToProofDag(graph)
  const raw = JSON.stringify(document)
  const dag = parseProofDag(document, createHash("sha256").update(raw).digest("hex"))

  assert.equal(dag.graphId, "root-theorem")
  assert.equal(dag.title, "The root theorem")
  assert.equal(dag.graphKind, "repository-field", "remote graphs import passively by default")
  assert.equal(dag.nodes.length, 2, "sketch nodes are not proof targets")
  assert.equal(dag.edges.length, 1)

  const byId = new Map(dag.nodes.map((node) => [node.nodeId, node]))
  assert.equal(byId.get("child-lemma").layer, 0, "the prerequisite sits below")
  assert.equal(byId.get("root-theorem").layer, 1)
  assert.deepEqual(byId.get("root-theorem").prerequisiteNodeIds, ["child-lemma"])
})

test("always imports Prove2me structure as a passive repository field", () => {
  const passive = prove2meGraphToProofDag(graph)

  assert.equal(passive.graph_kind, "repository-field")
  assert.doesNotMatch(JSON.stringify(passive), /mission|claim|workspace/u)
  assert.throws(
    () => prove2meGraphToProofDag(graph, { activateMission: true }),
    /activateMission is no longer supported/u,
  )
  assert.throws(
    () => prove2meGraphToProofDag(graph, { claimEverything: true }),
    /Unsupported Prove2me conversion option claimEverything/u,
  )
})

test("keeps the direction Prove2me already uses", () => {
  const [relation] = prove2meGraphToProofDag(graph).relations
  assert.equal(relation.prerequisite_target_id, "child-lemma")
  assert.equal(relation.dependent_target_id, "root-theorem")
  assert.equal(relation.relation_type, "REDUCES_TO")
})

test("keeps only stable Prove2me IDs and excludes provider status from immutable DAG identity", () => {
  const providerStates = structuredClone(graph)
  providerStates.nodes.find((node) => node.theorem_id === "root-theorem").status = "ACCEPTED"
  const changedProviderStates = structuredClone(providerStates)
  changedProviderStates.nodes.find((node) => node.theorem_id === "root-theorem").status = "Proved"
  changedProviderStates.nodes.find((node) => node.theorem_id === "child-lemma").status = "ACCEPTED"
  const document = prove2meGraphToProofDag(providerStates)
  const changedDocument = prove2meGraphToProofDag(changedProviderStates)
  assert.deepEqual(changedDocument, document, "mutable provider status must not churn immutable DAG bytes")
  const targets = new Map(
    document.targets.map((target) => [target.target_id, target]),
  )
  assert.deepEqual(targets.get("child-lemma").external, {
    prove2me: { theorem_id: "child-lemma" },
  })
  assert.deepEqual(targets.get("root-theorem").external, {
    prove2me: { theorem_id: "root-theorem" },
  })
  for (const target of targets.values()) {
    assert.equal(target.category, "prove2me-theorem")
    assert.equal(Object.hasOwn(target, "formal_binding"), false)
  }
  assert.doesNotMatch(JSON.stringify(document), /Proved|ACCEPTED|mapped|verified|formal_binding|proof_status/u)

  const dag = parseProofDag(document, createHash("sha256").update(JSON.stringify(document)).digest("hex"))
  assert.equal(dag.nodes.every((node) => node.formalBindingStatus === ""), true)
})

test("ignores sketch edges and edges leaving the subtree", () => {
  const document = prove2meGraphToProofDag({
    ...graph,
    edges: [
      ...graph.edges,
      { source: "child-lemma", target: "not-in-this-graph", kind: "structural" },
      { source: "child-lemma", target: "child-lemma", kind: "structural" },
      { source: "child-lemma", target: "root-theorem", kind: "structural" },
    ],
  })
  assert.equal(document.relations.length, 1, "duplicate, self and dangling edges are dropped")
})

test("rejects a graph with no theorem nodes", () => {
  assert.throws(
    () => prove2meGraphToProofDag({ root_id: "x", nodes: [], edges: [] }),
    /no theorem nodes/,
  )
})

test("converts the committed Prove2me sample", async () => {
  const sample = JSON.parse(
    await readFile(new URL("../docs/samples/proof-dag.prove2me.json", import.meta.url), "utf8"),
  )
  const raw = JSON.stringify(sample)
  const dag = parseProofDag(sample, createHash("sha256").update(raw).digest("hex"))
  assert.equal(dag.graphKind, "repository-field")
  assert.equal(dag.nodes.length, 41)
  assert.equal(dag.edges.length, 34)
  assert.ok(dag.nodes.some((node) => node.layer > 0), "the sample is layered")
  assert.equal(dag.nodes.every((node) => node.formalBindingStatus === ""), true)
  assert.equal(sample.targets.every((target) => target.category === "prove2me-theorem"), true)
  assert.equal(sample.targets.every((target) => target.external?.prove2me?.theorem_id === target.target_id), true)
  assert.doesNotMatch(raw, /Proved|ACCEPTED|mapped|verified|formal_binding|proof_status/u)
})
