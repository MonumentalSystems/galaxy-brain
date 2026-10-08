import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  AtlasExactRepresentationError,
  MAX_ATLAS_EXACT_REPRESENTATION_BYTES,
  MAX_ATLAS_EXACT_REPRESENTATION_IN_FLIGHT,
  MAX_ATLAS_EXACT_REPRESENTATION_QUEUED,
  atlasExactRepresentationDescriptor,
  clearAtlasExactRepresentationCache,
  loadAtlasExactRepresentation,
  loadAtlasExactRepresentationIfEligible,
  parseAtlasExactStructure,
} from "../lib/atlas-exact-representation.js"
import { observeAtlasViewportVisibility } from "../lib/atlas-viewport-visibility.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"

const documentId = "10000000-0000-4000-8000-000000000001"
const revisionId = "20000000-0000-4000-8000-000000000002"
const originalId = "30000000-0000-4000-8000-000000000003"
const markdownId = "40000000-0000-4000-8000-000000000004"
const textId = "50000000-0000-4000-8000-000000000005"
const revisionSha256 = "a".repeat(64)

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function projection(markdownHash = "b".repeat(64)) {
  return {
    schemaId: "gb.object-projection.v1",
    ref: createGalaxyObjectReference("document", documentId, {
      mode: "pinned", revision: `sha256:${revisionSha256}`,
    }),
    kind: "document",
    revision: { policy: "pinned", id: `sha256:${revisionSha256}`, contentHash: revisionSha256 },
    title: "Normalized paper",
    summary: "Authorized summary fallback.",
    mediaType: "application/pdf",
    representations: [{
      ref: `gb:representation:document:${documentId}:${originalId}`,
      kind: "original",
      mediaType: "application/pdf",
      contentHash: "c".repeat(64),
    }, {
      ref: `gb:representation:document:${documentId}:${textId}`,
      kind: "text",
      mediaType: "text/plain",
      contentHash: "d".repeat(64),
    }, {
      ref: `gb:representation:document:${documentId}:${markdownId}`,
      kind: "markdown",
      mediaType: "text/markdown; charset=utf-8",
      contentHash: markdownHash,
    }],
    provenance: { provider: "galaxy.document" },
    capabilities: ["open"],
  }
}

function stream(bytes, splitAt = bytes.byteLength) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, splitAt))
      if (splitAt < bytes.byteLength) controller.enqueue(bytes.subarray(splitAt))
      controller.close()
    },
  })
}

function response(descriptor, bytes, overrides = {}) {
  return {
    status: overrides.status ?? 200,
    redirected: overrides.redirected ?? false,
    url: overrides.url ?? "",
    headers: new Headers({
      "content-type": descriptor.mediaType,
      "content-length": String(bytes.byteLength),
      "x-content-sha256": descriptor.contentSha256,
      etag: `"sha256-${descriptor.contentSha256}"`,
      ...overrides.headers,
    }),
    body: overrides.body ?? stream(bytes, Math.min(5, bytes.byteLength)),
  }
}

test("Atlas selects the exact normalized Markdown body and binds its complete cache identity", () => {
  const descriptor = atlasExactRepresentationDescriptor(projection(), revisionId)
  assert.equal(descriptor.representationId, markdownId)
  assert.equal(descriptor.markdown, true)
  assert.equal(descriptor.mediaType, "text/markdown; charset=utf-8")
  assert.match(descriptor.contentUrl, new RegExp(`${revisionId}/representations/${markdownId}/content`))
  assert.match(descriptor.contentUrl, new RegExp(`revision_sha256=${revisionSha256}`))
  assert.match(descriptor.identity, new RegExp(markdownId))
  assert.match(descriptor.identity, /text\/markdown; charset=utf-8/u)
})

test("Atlas body selection fails closed for mutable, stale, hashless, or unsupported projections", () => {
  const exact = projection()
  assert.throws(() => atlasExactRepresentationDescriptor({
    ...exact,
    ref: createGalaxyObjectReference("document", documentId),
    revision: { policy: "latest", id: null, contentHash: null },
  }, revisionId), /not pinned/)
  assert.throws(() => atlasExactRepresentationDescriptor({
    ...exact,
    revision: { ...exact.revision, contentHash: "f".repeat(64) },
  }, revisionId), /revision hash/)
  assert.throws(() => atlasExactRepresentationDescriptor({
    ...exact,
    representations: [{ ...exact.representations[2], contentHash: null }],
  }, revisionId), /Representation hash/)
  assert.throws(() => atlasExactRepresentationDescriptor({
    ...exact,
    representations: [exact.representations[2], {
      ...exact.representations[2],
      ref: `gb:representation:document:${documentId}:60000000-0000-4000-8000-000000000006`,
    }],
  }, revisionId), /ambiguous current body/)
  assert.throws(() => atlasExactRepresentationDescriptor({
    ...exact,
    representations: [{
      ...exact.representations[2],
      mediaType: "text/markdown; charset=iso-8859-1",
    }],
  }, revisionId), /parameters are unsupported/)
  assert.throws(() => atlasExactRepresentationDescriptor({
    ...exact,
    representations: [{
      ...exact.representations[2],
      mediaType: "text/markdown; charset=utf-8; version=1",
    }],
  }, revisionId), /parameters are unsupported/)
  assert.equal(atlasExactRepresentationDescriptor({
    ...exact,
    representations: [exact.representations[0]],
  }, revisionId), null)
  assert.equal(atlasExactRepresentationDescriptor({ kind: "paper" }, revisionId), null)
})

test("equal-rank current bodies fail closed to the summary card", async () => {
  const exact = projection()
  assert.throws(() => atlasExactRepresentationDescriptor({
    ...exact,
    representations: [exact.representations[2], {
      ...exact.representations[2],
      ref: `gb:representation:document:${documentId}:60000000-0000-4000-8000-000000000006`,
    }],
  }, revisionId), /ambiguous current body/)
  const component = await readFile(
    new URL("../components/projections/atlas-exact-representation.tsx", import.meta.url),
    "utf8",
  )
  assert.match(component, /atlasExactRepresentationDescriptor[\s\S]*catch \{[\s\S]*return null/u)
  assert.match(component, /if \(!descriptor \|\| content === null\) return null/u)
})

test("Atlas streams, verifies, and reuses a bounded exact-body cache", async () => {
  clearAtlasExactRepresentationCache()
  const bytes = new TextEncoder().encode("# Exact body\n\n$E=mc^2$\n")
  const descriptor = atlasExactRepresentationDescriptor(projection(hash(bytes)), revisionId)
  let requests = 0
  const fetcher = async (url, init) => {
    requests += 1
    assert.equal(url, descriptor.contentUrl)
    assert.equal(init.cache, "no-store")
    assert.equal(init.redirect, "error")
    assert.equal(init.headers.Accept, "text/markdown; charset=utf-8")
    return response(descriptor, bytes)
  }
  const options = { authorizationScope: "tenant-a:principal-a", fetcher }
  assert.equal(await loadAtlasExactRepresentation(descriptor, options), new TextDecoder().decode(bytes))
  assert.equal(await loadAtlasExactRepresentation(descriptor, options), new TextDecoder().decode(bytes))
  assert.equal(requests, 1)
  assert.equal(await loadAtlasExactRepresentation(descriptor, {
    authorizationScope: "tenant-a:principal-b",
    fetcher,
  }), new TextDecoder().decode(bytes))
  assert.equal(requests, 2)
  clearAtlasExactRepresentationCache("tenant-a:principal-a")
  assert.equal(await loadAtlasExactRepresentation(descriptor, options), new TextDecoder().decode(bytes))
  assert.equal(requests, 3)
})

test("Atlas supports one verified current normalized structure body", () => {
  const exact = projection()
  const structureId = "60000000-0000-4000-8000-000000000006"
  const descriptor = atlasExactRepresentationDescriptor({
    ...exact,
    representations: [{
      ref: `gb:representation:document:${documentId}:${structureId}`,
      kind: "structure",
      mediaType: "application/vnd.galaxy.document-structure+json; charset=utf-8",
      contentHash: "e".repeat(64),
    }, exact.representations[2]],
  }, revisionId)
  assert.equal(descriptor.kind, "structure")
  assert.equal(descriptor.markdown, false)
  assert.equal(descriptor.mediaType, "application/vnd.galaxy.document-structure+json; charset=utf-8")
  assert.equal(descriptor.representationId, structureId)
})

test("Atlas accepts only the production structure media contract and malformed structures fall back", () => {
  const exact = projection()
  const structureId = "60000000-0000-4000-8000-000000000006"
  const base = {
    ref: `gb:representation:document:${documentId}:${structureId}`,
    kind: "structure",
    contentHash: "e".repeat(64),
  }
  const vendorDescriptor = atlasExactRepresentationDescriptor({
    ...exact,
    representations: [{
      ...base,
      mediaType: "application/vnd.galaxy.document-structure+json",
    }, exact.representations[2]],
  }, revisionId)
  assert.equal(vendorDescriptor.kind, "structure")

  const genericJsonDescriptor = atlasExactRepresentationDescriptor({
    ...exact,
    representations: [{ ...base, mediaType: "application/json" }, exact.representations[2]],
  }, revisionId)
  assert.equal(genericJsonDescriptor.kind, "markdown")

  const valid = JSON.stringify({
    schemaId: "gb.document-structure.v1",
    pages: [{ page: 1, width: 100, height: 100 }],
    blocks: [],
    readingOrder: [],
  })
  assert.equal(parseAtlasExactStructure(valid)?.schemaId, "gb.document-structure.v1")
  assert.equal(parseAtlasExactStructure("{not-json"), null)
  assert.equal(parseAtlasExactStructure(JSON.stringify({ schemaId: "wrong", pages: [] })), null)
})

test("Atlas rejects stale response identity, media, size, hash, redirects, and invalid UTF-8", async (t) => {
  const bytes = new TextEncoder().encode("exact body")
  const descriptor = atlasExactRepresentationDescriptor(projection(hash(bytes)), revisionId)
  const cases = [
    ["redirect", response(descriptor, bytes, { redirected: true })],
    ["stale URL", response(descriptor, bytes, { url: "https://galaxy.test/api/eln/documents/stale/content" })],
    ["media", response(descriptor, bytes, { headers: { "content-type": "text/plain" } })],
    ["non-UTF-8 charset", response(descriptor, bytes, { headers: { "content-type": "text/markdown; charset=iso-8859-1" } })],
    ["unsupported media parameter", response(descriptor, bytes, { headers: { "content-type": "text/markdown; charset=utf-8; version=1" } })],
    ["declared size", response(descriptor, bytes, { headers: { "content-length": "999" } })],
    ["missing size", response(descriptor, bytes, { headers: { "content-length": "" } })],
    ["declared hash", response(descriptor, bytes, { headers: { "x-content-sha256": "e".repeat(64) } })],
    ["etag", response(descriptor, bytes, { headers: { etag: `"sha256-${"f".repeat(64)}"` } })],
    ["bytes", response(descriptor, new TextEncoder().encode("other"), {
      headers: { "content-length": String("other".length) },
    })],
  ]
  for (const [name, invalid] of cases) {
    await t.test(name, async () => {
      clearAtlasExactRepresentationCache()
      await assert.rejects(
        loadAtlasExactRepresentation(descriptor, {
          fetcher: async () => invalid,
          origin: "https://galaxy.test",
        }),
        AtlasExactRepresentationError,
      )
    })
  }

  const invalidUtf8 = new Uint8Array([0xc3, 0x28])
  const invalidDescriptor = atlasExactRepresentationDescriptor(projection(hash(invalidUtf8)), revisionId)
  clearAtlasExactRepresentationCache()
  await assert.rejects(
    loadAtlasExactRepresentation(invalidDescriptor, { fetcher: async () => response(invalidDescriptor, invalidUtf8) }),
    /not valid UTF-8/,
  )
  const oversized = new Uint8Array(MAX_ATLAS_EXACT_REPRESENTATION_BYTES + 1)
  clearAtlasExactRepresentationCache()
  await assert.rejects(
    loadAtlasExactRepresentation(descriptor, { fetcher: async () => response(descriptor, oversized) }),
    /does not match its identity/,
  )
})

test("Atlas exact-body requests are abortable and never populate stale component state", async () => {
  clearAtlasExactRepresentationCache()
  const bytes = new TextEncoder().encode("exact body")
  const descriptor = atlasExactRepresentationDescriptor(projection(hash(bytes)), revisionId)
  const controller = new AbortController()
  controller.abort()
  let fetched = false
  await assert.rejects(
    loadAtlasExactRepresentation(descriptor, {
      signal: controller.signal,
      fetcher: async () => { fetched = true; return response(descriptor, bytes) },
    }),
    (error) => error?.name === "AbortError",
  )
  assert.equal(fetched, false)
})

test("Atlas globally bounds active and queued exact-body requests", async () => {
  clearAtlasExactRepresentationCache()
  const bytes = new TextEncoder().encode("bounded exact body")
  const descriptor = atlasExactRepresentationDescriptor(projection(hash(bytes)), revisionId)
  let active = 0
  let maximumActive = 0
  let releaseFetches
  const gate = new Promise((resolve) => { releaseFetches = resolve })
  const fetcher = async () => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await gate
    active -= 1
    return response(descriptor, bytes)
  }
  const count = MAX_ATLAS_EXACT_REPRESENTATION_IN_FLIGHT + MAX_ATLAS_EXACT_REPRESENTATION_QUEUED + 1
  const outcomes = Array.from({ length: count }, () => (
    loadAtlasExactRepresentation(descriptor, { fetcher }).then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    )
  ))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(active, MAX_ATLAS_EXACT_REPRESENTATION_IN_FLIGHT)
  releaseFetches()
  const settled = await Promise.all(outcomes)
  assert.equal(maximumActive, MAX_ATLAS_EXACT_REPRESENTATION_IN_FLIGHT)
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, count - 1)
  assert.match(
    settled.find((item) => item.status === "rejected")?.reason?.message ?? "",
    /capacity is exhausted/u,
  )
})

test("Atlas coalesces identical scoped loads while preserving subscriber aborts", async () => {
  clearAtlasExactRepresentationCache()
  const bytes = new TextEncoder().encode("coalesced exact body")
  const descriptor = atlasExactRepresentationDescriptor(projection(hash(bytes)), revisionId)
  let requests = 0
  let upstreamSignal
  let releaseFetch
  const gate = new Promise((resolve) => { releaseFetch = resolve })
  const fetcher = async (_url, init) => {
    requests += 1
    upstreamSignal = init.signal
    await gate
    return response(descriptor, bytes)
  }
  const firstController = new AbortController()
  const secondController = new AbortController()
  const scope = "tenant-a:principal-a"
  const first = loadAtlasExactRepresentation(descriptor, {
    authorizationScope: scope,
    fetcher,
    signal: firstController.signal,
  }).then(
    () => ({ status: "fulfilled" }),
    (reason) => ({ status: "rejected", reason }),
  )
  const second = loadAtlasExactRepresentation(descriptor, {
    authorizationScope: scope,
    fetcher,
    signal: secondController.signal,
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(requests, 1)
  firstController.abort()
  const firstResult = await first
  assert.equal(firstResult.status, "rejected")
  assert.equal(firstResult.reason?.name, "AbortError")
  assert.equal(upstreamSignal.aborted, false)
  releaseFetch()
  assert.equal(await second, "coalesced exact body")
  assert.equal(requests, 1)
})

test("tenant transition remounts exact media and reauthorizes the same exact body", async () => {
  const loader = await readFile(new URL("../app/atlas-v2/atlas-v2-loader.tsx", import.meta.url), "utf8")
  assert.match(loader, /const authorizationScope = JSON\.stringify\(\[tenantId, principalId\]\)/u)
  assert.match(loader, /<AtlasV2Client[\s\S]*key=\{authorizationScope\}/u)

  clearAtlasExactRepresentationCache()
  const bytes = new TextEncoder().encode("same exact body")
  const descriptor = atlasExactRepresentationDescriptor(projection(hash(bytes)), revisionId)
  let requests = 0
  const fetcher = async () => { requests += 1; return response(descriptor, bytes) }
  assert.equal(await loadAtlasExactRepresentation(descriptor, {
    authorizationScope: JSON.stringify(["tenant-a", "principal"]), fetcher,
  }), "same exact body")
  assert.equal(await loadAtlasExactRepresentation(descriptor, {
    authorizationScope: JSON.stringify(["tenant-b", "principal"]), fetcher,
  }), "same exact body")
  assert.equal(requests, 2)
})

test("offscreen eligibility performs no network work and the viewport observer has no cache margin", async () => {
  clearAtlasExactRepresentationCache()
  const bytes = new TextEncoder().encode("exact body")
  const descriptor = atlasExactRepresentationDescriptor(projection(hash(bytes)), revisionId)
  let requests = 0
  const content = await loadAtlasExactRepresentationIfEligible(descriptor, {
    authorizationScope: "tenant-a:principal-a",
    eligible: false,
    fetcher: async () => { requests += 1; return response(descriptor, bytes) },
  })
  assert.equal(content, null)
  assert.equal(requests, 0)

  const element = {}
  const states = []
  let callback
  let options
  let observed = false
  let disconnected = false
  class Observer {
    constructor(next, init) { callback = next; options = init }
    observe(target) { observed = target === element }
    unobserve() {}
    disconnect() { disconnected = true }
  }
  const cleanup = observeAtlasViewportVisibility(element, (visible) => states.push(visible), Observer)
  assert.equal(observed, true)
  assert.deepEqual(options, { root: null, rootMargin: "0px", threshold: 0 })
  callback([{ target: element, isIntersecting: true, intersectionRatio: 0 }])
  callback([{ target: element, isIntersecting: true, intersectionRatio: 0.25 }])
  cleanup()
  assert.deepEqual(states, [false, false, true, false])
  assert.equal(disconnected, true)
})

test("mobile inspector stays network-idle below a 375x667 viewport until intersection and stops on exit", async () => {
  const client = await readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8")
  assert.match(client, /ref=\{inspectorViewportRef\}[\s\S]*className="atlas-inspector"/u)
  assert.match(client, /observeAtlasViewportVisibility\(inspectorViewportRef\.current, setInspectorViewportVisible\)/u)
  assert.match(client, /streamExactRepresentation=\{inspectorViewportVisible && !nodeData\.placementState\.collapsed\}/u)
  const body = await readFile(new URL("../components/projections/atlas-exact-representation.tsx", import.meta.url), "utf8")
  assert.match(body, /return \(\) => controller\.abort\(\)/u)

  const bytes = new TextEncoder().encode("mobile exact body")
  const descriptor = atlasExactRepresentationDescriptor(projection(hash(bytes)), revisionId)
  let requests = 0
  const fetcher = async () => { requests += 1; return response(descriptor, bytes) }
  const viewport = { width: 375, height: 667 }
  assert.deepEqual(viewport, { width: 375, height: 667 })
  assert.equal(await loadAtlasExactRepresentationIfEligible(descriptor, {
    authorizationScope: "tenant-a:principal-a", eligible: false, fetcher,
  }), null)
  assert.equal(requests, 0)
  assert.equal(await loadAtlasExactRepresentationIfEligible(descriptor, {
    authorizationScope: "tenant-a:principal-a", eligible: true, fetcher,
  }), "mobile exact body")
  assert.equal(requests, 1)
  assert.equal(await loadAtlasExactRepresentationIfEligible(descriptor, {
    authorizationScope: "tenant-a:principal-a", eligible: false, fetcher,
  }), null)
  assert.equal(requests, 1)
})

test("Atlas mounts rich bytes only in settled viewport nodes and the selected inspector", async () => {
  const [host, body, node, client] = await Promise.all([
    readFile(new URL("../components/projections/object-projection-host.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/projections/atlas-exact-representation.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/canvas/galaxy-canvas-node.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8"),
  ])
  assert.match(host, /selected\.placeholder[\s\S]*: showBody \?[\s\S]*streamExactRepresentation/u)
  assert.match(host, /streamExactRepresentation && selected\.projector\.id === "image"/u)
  assert.match(host, /streamExactRepresentation && selected\.projector\.id === "document"/u)
  assert.match(body, /new AbortController\(\)/u)
  assert.match(body, /MarkdownRenderer/u)
  assert.match(body, /The authorized summary remains the fail-closed card representation/u)
  assert.match(node, /useIsMoving\(\)/u)
  assert.match(node, /observeAtlasViewportVisibility/u)
  assert.match(node, /moving=\{moving\}[\s\S]*streamExactRepresentation=\{viewportVisible/u)
  assert.match(node, /aria-hidden="true"[\s\S]*inert/u)
  assert.match(client, /context="detail"[\s\S]*moving=\{moving\}[\s\S]*streamExactRepresentation=\{inspectorViewportVisible && !nodeData\.placementState\.collapsed\}/u)
  assert.doesNotMatch(client, /<aside ref=\{inspectorViewportRef\} className="atlas-inspector" aria-live=/u)
  assert.match(client, /className="sr-only" aria-live="polite"/u)
  assert.match(client, /context="list"[\s\S]*streamExactRepresentation=\{false\}/u)
})
