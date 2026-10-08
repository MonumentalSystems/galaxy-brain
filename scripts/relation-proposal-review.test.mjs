import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  parseRelationProposalDecisionReceipt,
  parseRelationProposalReviewPage,
  RelationProposalReviewError,
} from "../lib/relation-proposal-review-client.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import { dispatchAtlasCommand, listAtlasCommands } from "../lib/plugins/atlas-commands.js"

const proposalId = "50000000-0000-4000-8000-000000000001"
const fromRef = "gb:object:v1:paper:paper-1:pinned:rev%3A1"
const toRef = `gb:object:v1:proof.node:graph%23lemma:pinned:sha256%3A${"b".repeat(64)}`

function item(overrides = {}) {
  return {
    schemaId: "gb.relation-proposal-review-item.v1",
    proposalId,
    fromRef,
    toRef,
    relation: "corresponds_to",
    rationale: "Same formal statement.",
    source: "agent-tool",
    currentVersion: 1,
    status: "pending",
    acceptEligible: true,
    createdAt: "2026-09-26T12:00:00+00:00",
    ...overrides,
  }
}

test("review page preserves exact endpoints and legacy reject-only proposals", () => {
  const nextCursor = "cGF5bG9hZA.c2lnbmF0dXJl"
  const page = parseRelationProposalReviewPage({
    schemaId: "gb.relation-proposal-review-page.v1",
    items: [item(), item({
      proposalId: "50000000-0000-4000-8000-000000000002",
      fromRef: "gb:object:v1:paper:legacy:latest",
      acceptEligible: false,
    })],
    bounded: true,
    nextCursor,
  })
  assert.equal(page.items.length, 2)
  assert.equal(page.items[1].acceptEligible, false)
  assert.equal(page.nextCursor, nextCursor)
  assert.throws(() => parseRelationProposalReviewPage({
    ...page,
    items: [item({ acceptEligible: false })],
  }), RelationProposalReviewError)
})

test("decision receipts cannot imply proof and bind the exact reviewed tuple", () => {
  const proposal = item()
  const receipt = parseRelationProposalDecisionReceipt({
    schemaId: "gb.relation-proposal-decision-receipt.v1",
    proposalId,
    fromRef,
    toRef,
    relation: "corresponds_to",
    decision: "accepted",
    currentVersion: 2,
    objectLinkId: "60000000-0000-4000-8000-000000000001",
    replayed: false,
    decidedAt: "2026-09-26T12:01:00+00:00",
  }, proposal)
  assert.equal(receipt.decision, "accepted")
  assert.equal("verification" in receipt, false)
  assert.throws(() => parseRelationProposalDecisionReceipt({ ...receipt, proofStatus: "verified" }, proposal))
})

test("twenty max-bound conforming proposals remain beneath the gateway response cap", () => {
  const astralIdentifier = "😀".repeat(95)
  const astralRevision = "🧬".repeat(64)
  const sampleFromRef = createGalaxyObjectReference("paper", `${astralIdentifier}A`, {
    mode: "pinned", revision: astralRevision,
  })
  const sampleToRef = createGalaxyObjectReference("proof.node", `${astralIdentifier}I`, {
    mode: "pinned", revision: astralRevision,
  })
  let rationale = "\\".repeat(4096)
  while (new TextEncoder().encode(JSON.stringify({
    fromRef: sampleFromRef,
    toRef: sampleToRef,
    relation: "corresponds_to",
    rationale,
    idempotencyKey: "relation-proposal-max-bound",
  })).byteLength > 8_192) rationale = rationale.slice(0, -1)
  assert.ok(rationale.length > 1_000)
  const items = Array.from({ length: 20 }, (_, index) => item({
    proposalId: `50000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    fromRef: createGalaxyObjectReference("paper", `${astralIdentifier}${String.fromCharCode(65 + (index % 20))}`, {
      mode: "pinned", revision: astralRevision,
    }),
    toRef: createGalaxyObjectReference("proof.node", `${astralIdentifier}${String.fromCharCode(97 + (index % 20))}`, {
      mode: "pinned", revision: astralRevision,
    }),
    rationale,
  }))
  const page = {
    schemaId: "gb.relation-proposal-review-page.v1",
    items,
    bounded: false,
    nextCursor: null,
  }
  assert.ok(new TextEncoder().encode(JSON.stringify(page)).byteLength < 262_144)
  assert.equal(parseRelationProposalReviewPage(page).items.length, 20)
  assert.throws(() => parseRelationProposalReviewPage({ ...page, items: [...items, items[0]] }))
})

test("Atlas exposes relation review as a human-only command effect", () => {
  const hidden = listAtlasCommands({ canReviewRelations: false })
    .find((command) => command.id === "relations.review.open")
  const available = listAtlasCommands({ canReviewRelations: true })
    .find((command) => command.id === "relations.review.open")
  assert.equal(hidden?.enabled, false)
  assert.equal(available?.enabled, true)
  assert.deepEqual(dispatchAtlasCommand("relations.review.open", {}), {
    ok: true,
    effect: { kind: "open-relation-proposal-review" },
  })
  assert.equal(dispatchAtlasCommand("relations.review.open", { proposal: "x" }).ok, false)
})

test("review transport stays outside the generic ELN proxy and requires a browser session gateway", async () => {
  const [collection, decision, gateway, generic, component] = await Promise.all([
    readFile(new URL("../app/api/relation-proposal-reviews/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/relation-proposal-reviews/[proposalId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/relation-proposal-review-gateway.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/eln/[...path]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/atlas/relation-proposal-review-dialog.tsx", import.meta.url), "utf8"),
  ])
  assert.match(collection, /limit:\s*"20"/u)
  assert.match(collection, /cursor/u)
  assert.match(decision, /UUID/u)
  assert.match(gateway, /getCurrentUser\(\)/u)
  assert.doesNotMatch(gateway, /getRequestIdentity/u)
  assert.match(gateway, /X-GB-Relation-Review-Gateway":\s*"v1"/u)
  assert.match(gateway, /MAX_DECISION_BYTES = 8_192/u)
  assert.match(gateway, /MAX_RESPONSE_BYTES = 262_144/u)
  assert.match(generic, /"relation-proposals"/u)
  assert.match(generic, /Invalid ELN path/u)
  assert.match(component, /Exact reference/u)
  assert.match(component, /acceptEligible/u)
  assert.match(component, /stale_relation_proposal/u)
  assert.match(component, /Acceptance never upgrades a claim, proof, or verification state/u)
})
