import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  buildHamMemorySupersedeChanges,
  buildHamSupersedeUpstreamBody,
  buildHamMemoryView,
  describeHamMemoryEdge,
  findHamMemoryLinkSource,
  HAM_MEMORY_MAX_HYDRATED_NEIGHBORS,
  HAM_MEMORY_MAX_LINKS,
  hamMemoryAdjacentIds,
  normalizeHamMemoryLinks,
  parseHamMemoryId,
  parseHamMemoryMutation,
  projectHamMemoryForBrowser,
} from "../lib/ham-memory-contract.js"
import { refreshCommittedHamMemory } from "../lib/ham-memory-mutation-result.js"

const memory = (id, overrides = {}) => ({
  id,
  content: `Memory ${id}`,
  tier: 1,
  state: "active",
  version: 1,
  metadata: { title: `Title ${id}`, scopes: ["project:galaxy"] },
  cues: [],
  ...overrides,
})

test("memory IDs are canonical bounded positive int64 values", () => {
  assert.equal(parseHamMemoryId("42"), "42")
  assert.equal(parseHamMemoryId(42), "42")
  for (const value of ["0", "-1", "01", "1/links", "9223372036854775808", 1.5, null]) {
    assert.throws(() => parseHamMemoryId(value), /invalid/i)
  }
})

test("supersession accepts only versioned, idempotent, allowlisted edits and organization moves", () => {
  assert.deepEqual(parseHamMemoryMutation({
    action: "supersede",
    expectedVersion: 3,
    idempotencyKey: "galaxy-edit-1",
    project: " Galaxy ",
    repo: null,
    sequence: "cp1",
    scopes: [" Project:Galaxy ", "project:galaxy"],
    cues: ["CP1", " A2 "],
  }), {
    action: "supersede",
    body: {
      expectedVersion: 3,
      idempotencyKey: "galaxy-edit-1",
      project: "Galaxy",
      repo: null,
      sequence: "cp1",
      scopes: ["project:galaxy"],
      cues: ["CP1", "A2"],
    },
  })
  assert.throws(
    () => parseHamMemoryMutation({
      action: "supersede",
      expectedVersion: 1,
      idempotencyKey: "edit",
      metadata: { role: "admin" },
      content: "changed",
    }),
    /Unsupported field: metadata/,
  )
  assert.throws(
    () => parseHamMemoryMutation({ action: "supersede", expectedVersion: 1, content: "changed" }),
    /Idempotency key/,
  )
  assert.throws(
    () => parseHamMemoryMutation({ action: "supersede", expectedVersion: 1, idempotencyKey: "edit" }),
    /change is required/,
  )
})

test("link and unlink actions cannot select paths, identities, or unsupported relations", () => {
  assert.deepEqual(parseHamMemoryMutation({
    action: "link",
    targetMemoryId: "22",
    relation: "cites",
  }), { action: "link", targetMemoryId: "22", relation: "cites" })
  assert.deepEqual(parseHamMemoryMutation({
    action: "unlink",
    linkId: "9",
    expectedVersion: 2,
    reason: "wrong connection",
  }), { action: "unlink", linkId: "9", expectedVersion: 2, reason: "wrong connection" })
  assert.throws(
    () => parseHamMemoryMutation({ action: "link", targetMemoryId: "22", relation: "deletes" }),
    /Relation is invalid/,
  )
  assert.throws(
    () => parseHamMemoryMutation({ action: "unlink", linkId: "9", expectedVersion: 2, sourceMemoryId: "1" }),
    /Unsupported field: sourceMemoryId/,
  )
  assert.throws(() => parseHamMemoryMutation({ action: "delete" }), /Action is invalid/)
})

test("supersession preserves opaque metadata server-side but starts fresh lifecycle lineage", () => {
  const input = parseHamMemoryMutation({
    action: "supersede",
    expectedVersion: 3,
    idempotencyKey: "edit-3",
    repo: null,
    sequence: "A2",
  })
  assert.equal(input.action, "supersede")
  const payload = buildHamSupersedeUpstreamBody({
    id: 7,
    content: "Original content",
    version: 3,
    metadata: {
      private_extension: { retained: true },
      repo: "old/repo",
      supersedes_id: 6,
      superseded_by: 8,
      superseded_reason: "old",
      supersede_warnings: ["old"],
      retracted_by: "old-agent",
      retraction_reason: "old",
    },
  }, input.body)
  assert.equal(payload.content, "Original content")
  assert.equal(payload.repo, "")
  assert.equal(payload.sequence, "A2")
  assert.deepEqual(payload.metadata, { private_extension: { retained: true } })
  assert.throws(
    () => buildHamSupersedeUpstreamBody({ content: "new", version: 4 }, input.body),
    (error) => error.status === 409,
  )
})

test("Galaxy supersession sends only real changes and lets HAM inherit cue provenance", () => {
  const current = projectHamMemoryForBrowser(memory(7, {
    content: "Original content",
    version: 3,
    metadata: {
      title: "CP1",
      project: "galaxy",
      scopes: ["shared", "project:galaxy"],
    },
    cues: [{ cue: "CP1", source: "agent" }, { cue: "legacy", source: "legacy-unknown" }],
  }))
  const unchanged = {
    title: " CP1 ",
    content: "Original content",
    organization: {
      ...current.organization,
      scopes: ["project:galaxy", "SHARED"],
    },
  }
  assert.deepEqual(buildHamMemorySupersedeChanges(current, unchanged), {})

  const changes = buildHamMemorySupersedeChanges(current, {
    ...unchanged,
    content: "Replacement content",
  })
  assert.deepEqual(changes, { content: "Replacement content" })
  assert.equal("cues" in changes, false)

  const parsed = parseHamMemoryMutation({
    action: "supersede",
    expectedVersion: 3,
    idempotencyKey: "edit-with-inherited-cues",
    ...changes,
  })
  assert.equal(parsed.action, "supersede")
  const payload = buildHamSupersedeUpstreamBody({
    id: 7,
    content: "Original content",
    version: 3,
    metadata: { title: "CP1", project: "galaxy", scopes: ["shared", "project:galaxy"] },
    cues: [{ cue: "CP1", source: "agent" }, { cue: "legacy", source: "legacy-unknown" }],
  }, parsed.body)
  assert.equal(payload.content, "Replacement content")
  assert.equal("cues" in payload, false)
  assert.equal("title" in payload, false)
  assert.equal("project" in payload, false)
})

test("server-side supersession rejects semantic no-op replacements", () => {
  const input = parseHamMemoryMutation({
    action: "supersede",
    expectedVersion: 3,
    idempotencyKey: "no-op-edit",
    content: "Original content",
    title: "CP1",
    scopes: ["shared"],
  })
  assert.equal(input.action, "supersede")
  assert.throws(() => buildHamSupersedeUpstreamBody({
    id: 7,
    content: "Original content",
    version: 3,
    metadata: { title: "CP1", scopes: ["shared"] },
    cues: [{ cue: "CP1", source: "agent" }],
  }, input.body), /real change/i)
})

test("legacy unscoped memories can be edited without inventing a scope change", () => {
  const current = projectHamMemoryForBrowser(memory(8, {
    content: "Legacy content",
    metadata: { title: "Legacy memory" },
  }))
  assert.deepEqual(buildHamMemorySupersedeChanges(current, {
    title: "Legacy memory",
    content: "Updated legacy content",
    organization: current.organization,
  }), { content: "Updated legacy content" })
})

test("incoming unlink derives the canonical source from the current HAM edge", () => {
  const links = [{ id: 9, source_id: 18, target_id: 22, relation: "cites" }]
  assert.equal(findHamMemoryLinkSource(links, "22", "9"), "18")
  assert.equal(findHamMemoryLinkSource(links, "18", "9"), "18")
  assert.throws(() => findHamMemoryLinkSource(links, "24", "9"), (error) => error.status === 404)
  assert.throws(() => findHamMemoryLinkSource(links, "22", "10"), (error) => error.status === 404)
})

test("durable mutation acknowledgement survives a failed optional refresh", async () => {
  const view = { memory: { id: "22" }, edges: [], truncated: false }
  assert.deepEqual(
    await refreshCommittedHamMemory("link", "22", async () => view),
    { status: "committed", action: "link", memoryId: "22", view },
  )
  for (const action of ["supersede", "link", "unlink"]) {
    assert.deepEqual(
      await refreshCommittedHamMemory(action, "22", async () => {
        throw new Error("neighborhood unavailable")
      }),
      { status: "committed-refresh-failed", action, memoryId: "22", view: null },
    )
  }
})

test("browser memory projection exposes organization and cues without opaque metadata", () => {
  const projected = projectHamMemoryForBrowser(memory(42, {
    content: "A current proof observation",
    version: 4,
    metadata: {
      title: "CP1",
      type: "decision",
      project: "galaxy",
      repo: "MonumentalSystems/GalaxyBrain",
      task: "proof-review",
      sequence: "cp1",
      scopes: ["project:galaxy"],
      status: "current",
      durability: "durable",
      visibility: "shared",
      agent_id: "example-agent",
      secret: "must-not-cross",
      arbitrary_private_blob: { hidden: true },
    },
    cues: [{ cue: "CP1", source: "agent" }, { cue: "legacy", source: "legacy-unknown" }],
  }))
  assert.equal(projected.title, "CP1")
  assert.equal(projected.organization.project, "galaxy")
  assert.deepEqual(projected.organization.scopes, ["project:galaxy"])
  assert.deepEqual(projected.cues, [
    { cue: "CP1", source: "agent" },
    { cue: "legacy", source: "legacy-unknown" },
  ])
  assert.doesNotMatch(JSON.stringify(projected), /secret|arbitrary_private_blob|hidden/)
})

test("old and HAM main #136 link responses normalize to the same directional model", () => {
  const oldResponse = {
    id: 9,
    source_id: 18,
    target_id: 22,
    relation: "cites",
    state: "active",
    version: 1,
  }
  const modernResponse = {
    ...oldResponse,
    effective_relation: "cited-by",
    direction: "incoming",
    adjacent_id: 18,
  }
  const oldProjected = normalizeHamMemoryLinks([oldResponse], "22")
  const modernProjected = normalizeHamMemoryLinks([modernResponse], "22")
  assert.deepEqual(modernProjected, oldProjected)
  assert.deepEqual(oldProjected.edges[0], {
    kind: "typed",
    id: "9",
    relation: "cites",
    effectiveRelation: "cited-by",
    direction: "incoming",
    sourceId: "18",
    targetId: "22",
    adjacentId: "18",
    state: "active",
    version: 1,
  })

  modernResponse.direction = "outgoing"
  modernResponse.effective_relation = "cites"
  modernResponse.adjacent_id = 22
  assert.deepEqual(normalizeHamMemoryLinks([modernResponse], "22"), oldProjected)
})

test("the exact view projects typed and both lifecycle edge semantics explicitly", () => {
  const raw = memory(22, {
    version: 2,
    supersedes_id: 20,
    superseded_by_id: 24,
    metadata: { title: "Middle version", scopes: ["shared"], secret: "hidden" },
  })
  const links = [{
    id: 9,
    source_id: 18,
    target_id: 22,
    relation: "verifies",
    state: "active",
    version: 2,
  }]
  const adjacent = new Map([
    ["18", memory(18)],
    ["20", memory(20)],
    ["24", memory(24)],
  ])
  const view = buildHamMemoryView(raw, links, adjacent)
  assert.equal(view.edges.length, 3)
  assert.deepEqual(view.edges.map((edge) => [
    edge.kind,
    edge.effectiveRelation,
    edge.direction,
    edge.sourceId,
    edge.targetId,
    edge.adjacentId,
  ]), [
    ["typed", "verified-by", "incoming", "18", "22", "18"],
    ["lifecycle", "supersedes", "outgoing", "22", "20", "20"],
    ["lifecycle", "superseded_by", "outgoing", "22", "24", "24"],
  ])
  assert.equal(view.edges[2].adjacent.title, "Title 24")
  assert.deepEqual(describeHamMemoryEdge(view.edges[1], "22"), {
    label: "This newer memory supersedes",
    other: "20",
    tone: "stored new → old",
  })
  assert.deepEqual(describeHamMemoryEdge(view.edges[2], "22"), {
    label: "This older memory is superseded by",
    other: "24",
    tone: "stored old → new",
  })
  assert.doesNotMatch(JSON.stringify(view), /hidden/)
})

test("link projection and neighbor hydration are bounded deterministically", () => {
  const links = Array.from({ length: HAM_MEMORY_MAX_LINKS + 8 }, (_, index) => ({
    id: index + 1,
    source_id: 1,
    target_id: index + 2,
    relation: "depends-on",
    state: "active",
    version: 1,
  }))
  const normalized = normalizeHamMemoryLinks(links, "1")
  assert.equal(normalized.edges.length, HAM_MEMORY_MAX_LINKS)
  assert.equal(normalized.truncated, true)
  const neighbors = hamMemoryAdjacentIds(memory(1), links)
  assert.equal(neighbors.length, HAM_MEMORY_MAX_HYDRATED_NEIGHBORS)
  assert.deepEqual(neighbors.slice(0, 3), ["2", "3", "4"])
})

test("the BFF is bounded and reuses the authenticated server-side HAM connection", async () => {
  const [route, proxy, contract, client, environment, readme] = await Promise.all([
    readFile(new URL("../app/api/ham/memories/[memoryId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ham-memory-proxy.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ham-memory-contract.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/ham-memory-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
  ])
  assert.match(route, /getCurrentUser\(\)/)
  assert.doesNotMatch(route, /authMethod|signNostrAuthEvent|Sign in with Nostr/)
  assert.match(route, /assertHamMemoryMutationOrigin\(request\)/)
  assert.match(route, /HAM_MEMORY_REQUEST_MAX_BYTES/)
  assert.match(route, /Content-Type must be application\/json/)
  assert.match(route, /no-store, max-age=0/)
  assert.doesNotMatch(route, /HAM_MEMORY_WRITE_BEARER_TOKEN|HAM_API_BEARER_TOKEN/)

  assert.match(proxy, /evaluateHamSearchTenantAccess\(user, process\.env\)/)
  assert.match(proxy, /resolveHamSearchBearer\(process\.env\)/)
  assert.match(proxy, /actorId: user\.nostrPubkey \|\| `galaxy:\$\{user\.principalId\}`/)
  assert.match(proxy, /"X-HAM-Agent-ID": config\.actorId/)
  assert.doesNotMatch(proxy, /HAM_MEMORY_WRITE_BEARER_TOKEN|HAM_MEMORY_MUTATIONS/)
  assert.match(proxy, /AbortSignal\.timeout\(10_000\)/)
  assert.match(proxy, /HAM_MEMORY_UPSTREAM_RESPONSE_MAX_BYTES/)
  assert.match(proxy, /HAM_MEMORY_UPSTREAM_REQUEST_MAX_BYTES/)
  assert.match(proxy, /Promise\.allSettled/)
  assert.match(proxy, /result\.reason\.status === 404/)
  assert.match(proxy, /findHamMemoryLinkSource\(rawLinks, id, mutation\.linkId\)/)
  assert.match(proxy, /refreshCommittedHamMemory/)
  assert.match(contract, /"superseded_reason"/)
  assert.doesNotMatch(proxy, /method:\s*"DELETE"|\/retract`,\s*\{\s*expected_version.*memory/i)

  assert.doesNotMatch(client, /HAM_MEMORY_WRITE_BEARER_TOKEN|HAM_API_BEARER_TOKEN|X-GB-User-ID/)
  assert.match(client, /export function getHamMemory/)
  assert.match(client, /export function supersedeHamMemory/)
  assert.match(client, /export function linkHamMemories/)
  assert.match(client, /export function unlinkHamMemories/)
  assert.doesNotMatch(environment, /HAM_MEMORY_MUTATIONS|HAM_MEMORY_WRITE_BEARER_TOKEN/)
  assert.match(readme, /HAM memory workspace/)
  assert.match(readme, /Interactive changes reuse the authenticated Galaxy session/)
})
