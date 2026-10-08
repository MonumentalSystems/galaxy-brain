import assert from "node:assert/strict"
import test from "node:test"

import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import { normalizeObjectLinkPage } from "../lib/object-link-client.js"

const paper = createGalaxyObjectReference("paper", "paper-1")
const document = createGalaxyObjectReference("document", "document-1", {
  mode: "pinned",
  revision: `sha256:${"d".repeat(64)}`,
})

test("keeps valid object links and omits malformed rows before strict graph assembly", () => {
  const result = normalizeObjectLinkPage([{
    id: "link-1",
    from_ref: paper,
    to_ref: document,
    relation: "corresponds_to",
    basis: "imported",
    provenance: { source: "paper-document-bridge", confidence: 1 },
  }, {
    id: "link-bad-ref",
    from_ref: "not-a-reference",
    to_ref: document,
    relation: "corresponds_to",
    basis: "imported",
    provenance: { source: "paper-document-bridge" },
  }, {
    id: "link-bad-provenance",
    from_ref: paper,
    to_ref: document,
    relation: "corresponds_to",
    basis: "imported",
    provenance: { source: "paper-document-bridge", hidden: true },
  }])

  assert.equal(result.total, 3)
  assert.equal(result.invalid, 2)
  assert.deepEqual(result.links.map((link) => link.id), ["link-1"])
})
