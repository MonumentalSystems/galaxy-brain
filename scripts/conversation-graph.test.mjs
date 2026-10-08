import assert from "node:assert/strict"
import test from "node:test"

import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import { createGalaxyObjectProjection } from "../lib/object-projection.js"
import { projectUnifiedGraph } from "../lib/unified-graph.js"

const scope = { tenantId: "10000000-0000-4000-8000-000000000001", workspaceId: "research-main" }
const digest = (value) => value.repeat(64)
const revision = (value) => `sha256:${digest(value)}`
const reference = (kind, id, value) => createGalaxyObjectReference(kind, id, {
  mode: "pinned",
  revision: revision(value),
})

function projection(kind, id, value, title) {
  const ref = reference(kind, id, value)
  return {
    scope,
    projection: createGalaxyObjectProjection({
      schemaId: "gb.object-projection.v1",
      ref,
      kind,
      revision: { policy: "pinned", id: revision(value), contentHash: digest(value) },
      title,
      summary: `${title} summary`,
      mediaType: kind === "chat"
        ? "application/vnd.galaxy.conversation+json"
        : "application/vnd.galaxy.conversation-turn+json",
      representations: [],
      provenance: { provider: "galaxy.conversation", sourceId: id, sourceRevision: revision(value) },
      capabilities: ["open", "branch", "inspect"],
    }),
  }
}

test("conversation mode preserves continues, forks, and joins as typed structure", () => {
  const conversation = projection("chat", "30000000-0000-4000-8000-000000000001", "a", "Conversation")
  const root = projection("turn", "40000000-0000-4000-8000-000000000001", "b", "Root")
  const left = projection("turn", "40000000-0000-4000-8000-000000000002", "c", "Left")
  const right = projection("turn", "40000000-0000-4000-8000-000000000003", "d", "Right")
  const joined = projection("turn", "40000000-0000-4000-8000-000000000004", "e", "Joined")
  const relation = (fromRef, toRef, kind, recordId) => ({
    scope,
    relation: {
      fromRef,
      toRef,
      relation: kind,
      trust: "structure",
      source: { provider: "galaxy.conversation", recordId },
    },
  })
  const input = {
    schemaId: "gb.graph-projection-input.v1",
    scope,
    query: {
      rootRef: null,
      mode: "conversation",
      lens: "explore",
      scale: "task",
      viewport: null,
      filters: {},
      validAt: null,
      knownAt: null,
      cursor: null,
    },
    objects: [conversation, root, left, right, joined],
    external: [],
    links: [],
    relations: [
      relation(conversation.projection.ref, root.projection.ref, "contains", "contains-root"),
      relation(conversation.projection.ref, left.projection.ref, "contains", "contains-left"),
      relation(conversation.projection.ref, right.projection.ref, "contains", "contains-right"),
      relation(conversation.projection.ref, joined.projection.ref, "contains", "contains-joined"),
      relation(root.projection.ref, left.projection.ref, "continues", "edge-continues"),
      relation(root.projection.ref, right.projection.ref, "forks", "edge-forks"),
      relation(left.projection.ref, joined.projection.ref, "joins", "edge-join-left"),
      relation(right.projection.ref, joined.projection.ref, "joins", "edge-join-right"),
    ],
    proofContexts: [],
    providers: [{ scope, provider: "galaxy.conversation", status: "ready", snapshot: revision("a") }],
  }

  const graph = projectUnifiedGraph(input)
  assert.equal(graph.nodes.length, 5)
  assert.deepEqual(
    new Set(graph.edges.map((edge) => edge.relation)),
    new Set(["contains", "continues", "forks", "joins"]),
  )
  assert.ok(graph.edges.filter((edge) => edge.relation === "joins").every((edge) => edge.trust === "structure"))
  assert.equal(graph.aggregates.trust.structure, 8)
})
