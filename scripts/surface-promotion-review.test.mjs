import assert from "node:assert/strict"
import test from "node:test"

import {
  normalizeSurfacePromotionResponse,
  surfaceHeadMatchesReview,
  surfacePromotionProvenance,
} from "../lib/surface-promotion.js"

function spec() {
  return {
    schema: "gb.surface.v1",
    catalog: { id: "generous.a2ui", version: "1" },
    surfaceUpdate: {
      surfaceId: "research-board",
      components: [{ id: "root", component: { Title: { text: "Research Board" } } }],
    },
    bindings: [],
  }
}

function reviewed() {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    title: "Research Board",
    status: "draft",
    schema_version: "gb.surface.v1",
    schema_digest: "a".repeat(64),
    catalog_id: "generous.a2ui",
    catalog_version: "1",
    catalog_digest: "b".repeat(64),
    renderer_version: "surface-renderer-v1",
    current_version: 3,
    current_content_hash: "c".repeat(64),
    current_spec: spec(),
    provenance: {
      source: "agent-tool:surface.draft.create",
      evidence_refs: ["gb:document:paper:sha256:abc"],
      actor_ref: `nostr:${"d".repeat(64)}`,
      galaxy: { event: "created", principal_id: "private", principal_kind: "agent" },
      ignored: "not allowlisted",
    },
  }
}

function promoted(overrides = {}) {
  const draft = reviewed()
  return {
    ...draft,
    status: "promoted",
    current_version: 4,
    current_content_hash: "e".repeat(64),
    provenance: {
      ...surfacePromotionProvenance(draft.provenance),
      galaxy: { event: "promoted", principal_id: "private", principal_kind: "human" },
    },
    ...overrides,
  }
}

function promotedRevision(value = promoted()) {
  return {
    surface_id: value.id,
    version: value.current_version,
    title: value.title,
    status: value.status,
    content_hash: value.current_content_hash,
    schema_digest: value.schema_digest,
    catalog_digest: value.catalog_digest,
    renderer_version: value.renderer_version,
    spec: value.current_spec,
    provenance: value.provenance,
  }
}

function reviewedRevision(value = reviewed()) {
  return {
    surface_id: value.id,
    version: value.current_version,
    title: value.title,
    status: value.status,
    content_hash: value.current_content_hash,
    schema_digest: value.schema_digest,
    catalog_digest: value.catalog_digest,
    renderer_version: value.renderer_version,
    spec: value.current_spec,
    provenance: value.provenance,
  }
}

test("promotion preserves allowlisted draft lineage without reusing the server envelope", () => {
  assert.deepEqual(surfacePromotionProvenance(reviewed().provenance), {
    source: "agent-tool:surface.draft.create",
    actor_ref: `nostr:${"d".repeat(64)}`,
    evidence_refs: ["gb:document:paper:sha256:abc"],
  })
})

test("accepts one exact direct promotion receipt", () => {
  const value = promoted({
    schema_digest: "1".repeat(64),
    catalog_digest: "2".repeat(64),
    renderer_version: "surface-renderer-v2",
  })
  const result = normalizeSurfacePromotionResponse(value, reviewedRevision())
  assert.equal(result.surface, value)
  assert.equal(result.currentIsPromotedRevision, true)
})

test("accepts an exact replay only when head and immutable receipt agree", () => {
  const value = promoted({ replayed: true })
  value.replayed_revision = promotedRevision(value)
  assert.equal(normalizeSurfacePromotionResponse(value, reviewedRevision()).currentIsPromotedRevision, true)
  assert.throws(
    () => normalizeSurfacePromotionResponse({
      ...value,
      replayed_revision: { ...value.replayed_revision, content_hash: "f".repeat(64) },
    }, reviewedRevision()),
    /replay does not match/,
  )
})

test("accepts an exact replay receipt after the mutable head advances", () => {
  const original = promoted({ replayed: true })
  original.replayed_revision = promotedRevision(original)
  const advanced = {
    ...original,
    title: "Archived board",
    status: "archived",
    current_version: 7,
    current_content_hash: "f".repeat(64),
    current_spec: spec(),
    provenance: { source: "later-change", galaxy: { event: "archived" } },
  }
  const result = normalizeSurfacePromotionResponse(advanced, reviewedRevision())
  assert.equal(result.replayed, true)
  assert.equal(result.currentIsPromotedRevision, false)
  assert.equal(result.revision.version, 4)
})

test("the mutable head must exactly match the immutable reviewed draft", () => {
  const draft = reviewed()
  const revision = reviewedRevision(draft)
  assert.equal(surfaceHeadMatchesReview(draft, revision), true)
  assert.equal(surfaceHeadMatchesReview({ ...draft, title: "Substituted" }, revision), false)
  assert.equal(surfaceHeadMatchesReview({ ...draft, provenance: { source: "substituted" } }, revision), false)
})

test("rejects provider substitutions and stale or malformed receipts", () => {
  const cases = [
    promoted({ id: "40000000-0000-4000-8000-000000000001" }),
    promoted({ current_version: 5 }),
    promoted({ current_content_hash: "not-a-hash" }),
    promoted({ title: "Substituted" }),
    promoted({ current_spec: { ...spec(), bindings: [{ id: "unexpected" }] } }),
    promoted({ schema_digest: "not-a-digest" }),
    promoted({ provenance: { galaxy: { event: "created" } } }),
    promoted({ provenance: {
      ...promoted().provenance,
      ham_refs: ["unexpected:relation"],
    } }),
  ]
  for (const value of cases) {
    assert.throws(() => normalizeSurfacePromotionResponse(value, reviewedRevision()), /does not match/)
  }
})
