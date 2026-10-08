import assert from "node:assert/strict"
import test from "node:test"

import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import {
  isGraphGatewayProjectionReference,
  isLatestHamMemoryProjectionReference,
  isPinnedChatProjectionReference,
  isPinnedDocumentProjectionReference,
  isPinnedElnObservationProjectionReference,
  isPinnedSurfaceProjectionReference,
  linkedProjectionProviderStatus,
  selectMissingLinkedProjectionReferences,
} from "../lib/linked-document-graph.js"

const sha = (character) => `sha256:${character.repeat(64)}`
const pinned = (kind, id, revision) => createGalaxyObjectReference(kind, id, { mode: "pinned", revision })
const document = pinned("document", "document-1", sha("d"))
const anchor = pinned("document.anchor", sha("a"), sha("b"))
const paperOutsideCatalogPage = pinned("paper", "paper-61", sha("c"))
const memory = createGalaxyObjectReference("ham.memory", "42")
const chat = pinned("chat", "80000000-0000-4000-8000-000000000001", sha("e"))
const surface = pinned("surface", "90000000-0000-4000-8000-000000000001", sha("f"))
const observation = pinned("eln.observation", "123e4567-e89b-42d3-a456-426614174020", sha("1"))

test("requires exact sha256-pinned document selections", () => {
  assert.equal(isPinnedDocumentProjectionReference(document), true)
  assert.equal(isPinnedDocumentProjectionReference(anchor), true)
  assert.equal(isPinnedDocumentProjectionReference(createGalaxyObjectReference("document", "document-1")), false)
  assert.equal(isPinnedDocumentProjectionReference(pinned("document", "document-1", "revision:1")), false)
  assert.equal(isPinnedDocumentProjectionReference(paperOutsideCatalogPage), false)
})

test("accepts only latest canonical positive HAM memory IDs for gateway hydration", () => {
  assert.equal(isLatestHamMemoryProjectionReference(memory), true)
  assert.equal(isGraphGatewayProjectionReference(memory), true)
  assert.equal(isGraphGatewayProjectionReference(document), true)
  assert.equal(isLatestHamMemoryProjectionReference(createGalaxyObjectReference("ham.memory", "9223372036854775807")), true)
  assert.equal(isLatestHamMemoryProjectionReference(createGalaxyObjectReference("ham.memory", "9223372036854775808")), false)
  assert.equal(isLatestHamMemoryProjectionReference(createGalaxyObjectReference("ham.memory", "0")), false)
  assert.equal(isLatestHamMemoryProjectionReference(createGalaxyObjectReference("ham.memory", "0042")), false)
  assert.equal(isLatestHamMemoryProjectionReference(createGalaxyObjectReference("ham.memory", "memory-42")), false)
  assert.equal(isLatestHamMemoryProjectionReference(pinned("ham.memory", "42", "version:3")), false)
})

test("accepts only exact sha256-pinned chats for gateway hydration", () => {
  assert.equal(isPinnedChatProjectionReference(chat), true)
  assert.equal(isGraphGatewayProjectionReference(chat), true)
  assert.equal(isPinnedChatProjectionReference(createGalaxyObjectReference("chat", "80000000-0000-4000-8000-000000000001")), false)
  assert.equal(isPinnedChatProjectionReference(pinned("chat", "80000000-0000-4000-8000-000000000001", "version:3")), false)
  assert.equal(isPinnedChatProjectionReference(document), false)
})

test("accepts only exact sha256-pinned surfaces for promoted gateway hydration", () => {
  assert.equal(isPinnedSurfaceProjectionReference(surface), true)
  assert.equal(isGraphGatewayProjectionReference(surface), true)
  assert.equal(isPinnedSurfaceProjectionReference(createGalaxyObjectReference("surface", "90000000-0000-4000-8000-000000000001")), false)
  assert.equal(isPinnedSurfaceProjectionReference(pinned("surface", "90000000-0000-4000-8000-000000000001", "version:3")), false)
  assert.equal(isPinnedSurfaceProjectionReference(document), false)
})

test("accepts and expands only exact immutable ELN observation revisions", () => {
  const latest = createGalaxyObjectReference("eln.observation", "123e4567-e89b-42d3-a456-426614174020")
  const versionPinned = pinned("eln.observation", "123e4567-e89b-42d3-a456-426614174020", "version:1")
  assert.equal(isPinnedElnObservationProjectionReference(observation), true)
  assert.equal(isGraphGatewayProjectionReference(observation), true)
  assert.equal(isPinnedElnObservationProjectionReference(latest), false)
  assert.equal(isPinnedElnObservationProjectionReference(versionPinned), false)

  const plan = selectMissingLinkedProjectionReferences([{
    from_ref: document,
    to_ref: observation,
    relation: "has_evidence",
  }, {
    from_ref: memory,
    to_ref: latest,
    relation: "related",
  }], [document, memory])
  assert.deepEqual(plan, {
    references: [observation],
    total: 1,
    capped: false,
  })
})

test("finds a pinned paper endpoint linked from a selected document outside the catalog page", () => {
  const plan = selectMissingLinkedProjectionReferences([{
    from_ref: document,
    to_ref: paperOutsideCatalogPage,
    relation: "corresponds_to",
  }], [document])

  assert.deepEqual(plan, {
    references: [paperOutsideCatalogPage],
    total: 1,
    capped: false,
  })
})

test("discovers independently resolvable HAM memory and immutable document endpoints", () => {
  const otherMemory = createGalaxyObjectReference("ham.memory", "43")
  const plan = selectMissingLinkedProjectionReferences([{
    from_ref: memory,
    to_ref: document,
    relation: "context_for",
  }, {
    from_ref: memory,
    to_ref: otherMemory,
    relation: "supports",
  }], [memory])

  assert.deepEqual(plan, {
    references: [document, otherMemory],
    total: 2,
    capped: false,
  })
})

test("discovers an exact pinned chat endpoint without widening mutable conversations", () => {
  const plan = selectMissingLinkedProjectionReferences([{
    from_ref: document,
    to_ref: chat,
    relation: "context_for",
  }, {
    from_ref: memory,
    to_ref: createGalaxyObjectReference("chat", "80000000-0000-4000-8000-000000000002"),
    relation: "related",
  }], [document, memory])

  assert.deepEqual(plan, {
    references: [chat],
    total: 1,
    capped: false,
  })
})

test("discovers an exact pinned promoted surface endpoint without widening mutable surface heads", () => {
  const plan = selectMissingLinkedProjectionReferences([{
    from_ref: document,
    to_ref: surface,
    relation: "context_for",
  }, {
    from_ref: memory,
    to_ref: createGalaxyObjectReference("surface", "90000000-0000-4000-8000-000000000002"),
    relation: "related",
  }], [document, memory])

  assert.deepEqual(plan, {
    references: [surface],
    total: 1,
    capped: false,
  })
})

test("reports denied and capped endpoint hydration without claiming completeness", () => {
  assert.equal(linkedProjectionProviderStatus([paperOutsideCatalogPage], [], false), "unavailable")
  assert.equal(linkedProjectionProviderStatus([paperOutsideCatalogPage, anchor], [paperOutsideCatalogPage], false), "partial")
  assert.equal(linkedProjectionProviderStatus([paperOutsideCatalogPage], [paperOutsideCatalogPage], true), "partial")
  assert.equal(linkedProjectionProviderStatus([paperOutsideCatalogPage], [paperOutsideCatalogPage], false), "ready")
})

test("caps linked gateway expansion without claiming completeness", () => {
  const links = Array.from({ length: 65 }, (_, index) => ({
    from_ref: memory,
    to_ref: createGalaxyObjectReference("ham.memory", String(index + 100)),
    relation: "related",
  }))
  const plan = selectMissingLinkedProjectionReferences(links, [memory])
  assert.equal(plan.references.length, 64)
  assert.equal(plan.total, 65)
  assert.equal(plan.capped, true)
})
