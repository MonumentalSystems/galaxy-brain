import assert from "node:assert/strict"
import test from "node:test"

import { projectAuthoritativeHamMemoryView, projectHamFieldNeighborhood } from "../lib/ham-field-relations.js"

test("HAM retrieval produces bounded provisional neighbors, never proof or structural edges", () => {
  const projection = projectHamFieldNeighborhood("workspace-node:paper-1", [
    { id: 42, content: "Vortex notes", metadata: { title: "Vortex notes" } },
    { id: 42, content: "duplicate" },
    { id: "not-an-id", content: "malformed" },
    ...Array.from({ length: 20 }, (_, index) => ({ id: index + 100, content: `Memory ${index}` })),
  ])

  assert.equal(projection.entities.length, 8)
  assert.equal(projection.relations.length, 8)
  assert.equal(projection.entities[0].sourceReference, "gb:object:v1:ham.memory:42:latest")
  assert.equal(projection.entities[0].kind, "memory")
  assert.equal(projection.entities[0].sourceMemoryId, "42")
  assert.equal(projection.entities[0].status, "candidate")
  assert.ok(projection.relations.every((edge) => edge.kind === "near" && edge.basis === "ham_candidate"))
  assert.ok(projection.relations.every((edge) => edge.from === "workspace-node:paper-1"))
})

test("invalid input fails closed and never makes a HAM hit an authored edge", () => {
  assert.deepEqual(projectHamFieldNeighborhood("", [{ id: 1, content: "x" }]), { entities: [], relations: [] })
  assert.deepEqual(projectHamFieldNeighborhood("node", null), { entities: [], relations: [] })
  assert.deepEqual(projectHamFieldNeighborhood("node", [{ id: "-1" }, { id: "1:2" }]), { entities: [], relations: [] })
})

test("authoritative HAM views preserve stored directions while inverse labels stay presentation-only", () => {
  const projection = projectAuthoritativeHamMemoryView({
    memory: { id: "42", title: "Current claim", content: "Current", version: 3 },
    edges: [
      {
        kind: "typed", id: "7", relation: "cites", effectiveRelation: "cited-by",
        direction: "incoming", sourceId: "41", targetId: "42", adjacentId: "41",
        state: "active", version: 2,
        adjacent: { id: "41", title: "Earlier source", state: "active", version: 1, snippet: "Earlier" },
      },
      {
        kind: "lifecycle", id: "supersedes:42:40", relation: "supersedes", effectiveRelation: "supersedes",
        direction: "outgoing", sourceId: "42", targetId: "40", adjacentId: "40",
        state: "active", version: 1,
        adjacent: { id: "40", title: "Old claim", state: "superseded", version: 1, snippet: "Old" },
      },
    ],
  })

  assert.equal(projection.nodes.length, 3)
  assert.deepEqual(projection.edges.map((edge) => edge.relation), ["cites", "supersedes"])
  assert.equal(projection.edges[0].fromRef, "gb:object:v1:ham.memory:41:latest")
  assert.equal(projection.edges[0].toRef, "gb:object:v1:ham.memory:42:latest")
  assert.equal(projection.edges[0].basis, "authored_assertion")
  assert.equal("effectiveRelation" in projection.edges[0], false)
})
