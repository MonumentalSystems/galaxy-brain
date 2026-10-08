import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  HamSearchUpstreamResponseError,
  parseHamSearchRequest,
  projectHamSearchResultsForBrowser,
} from "../lib/ham-search-contract.js"
import {
  evaluateHamSearchTenantAccess,
  resolveHamSearchBearer,
} from "../lib/ham-search-proxy-config.js"
import {
  HamSearchBodyTooLargeError,
  HAM_SEARCH_REQUEST_MAX_BYTES,
  readBoundedHamSearchText,
} from "../lib/ham-search-bounds.js"

const GALAXY_TENANT = "00000000-0000-4000-8000-000000000001"

test("the editable deployment alias wins over a locked empty legacy bearer", () => {
  assert.equal(resolveHamSearchBearer({
    GALAXY_DEPLOY_HAM_API_BEARER_TOKEN: "deployment-alias",
    HAM_API_BEARER_TOKEN: "",
  }), "deployment-alias")
  assert.equal(resolveHamSearchBearer({
    GALAXY_DEPLOY_HAM_API_BEARER_TOKEN: "",
    HAM_API_BEARER_TOKEN: "legacy-bearer",
  }), "legacy-bearer")
  assert.equal(resolveHamSearchBearer({}), null)
})

test("deployment-global HAM search authority is bound to one exact Galaxy tenant", () => {
  assert.deepEqual(evaluateHamSearchTenantAccess({ tenantId: GALAXY_TENANT }, {}), {
    allowed: false,
    status: 503,
    message: "HAM search is not bound to a Galaxy tenant",
  })
  assert.deepEqual(evaluateHamSearchTenantAccess(
    { tenantId: "22222222-2222-4222-8222-222222222222" },
    { HAM_SEARCH_GALAXY_TENANT_ID: GALAXY_TENANT },
  ), {
    allowed: false,
    status: 403,
    message: "HAM search is not authorized for this Galaxy tenant",
  })
  assert.deepEqual(evaluateHamSearchTenantAccess(
    { tenantId: GALAXY_TENANT },
    { HAM_SEARCH_GALAXY_TENANT_ID: GALAXY_TENANT.toUpperCase() },
  ), { allowed: true, tenantId: GALAXY_TENANT })
})

test("search modes map only to modern scoped HAM read endpoints", () => {
  assert.deepEqual(parseHamSearchRequest({ query: "current deployment", topK: 8 }), {
    mode: "search",
    path: "/search",
    body: { query: "current deployment", top_k: 8, include_context: false },
  })
  assert.deepEqual(parseHamSearchRequest({ query: "decision trail", mode: "multihop" }), {
    mode: "multihop",
    path: "/retrieve/multihop/scoped",
    body: { query: "decision trail", top_k: 10, include_context: false, max_hops: 2 },
  })
  assert.deepEqual(parseHamSearchRequest({
    query: "deployed version",
    mode: "temporal",
    asOf: "2026-08-20T12:30:00-04:00",
    temporalMode: "known_at",
  }), {
    mode: "temporal",
    path: "/retrieve/temporal/scoped",
    body: {
      query: "deployed version",
      top_k: 10,
      include_context: false,
      as_of: "2026-08-20T16:30:00.000Z",
      mode: "known_at",
      include_history: true,
    },
  })
})

test("browser search input cannot select upstream paths, scopes, or identity", () => {
  const parsed = parseHamSearchRequest({
    query: "bounded",
    mode: "search",
    path: "/admin/credentials",
    scopes: ["project:other"],
    agent_id: "other-agent",
  })
  assert.equal(parsed.path, "/search")
  assert.doesNotMatch(JSON.stringify(parsed.body), /scopes|agent_id|admin/)
  assert.throws(() => parseHamSearchRequest({ query: "x", mode: "raw" }), /mode is invalid/i)
  assert.throws(() => parseHamSearchRequest({ query: "x", topK: 51 }), /between 1 and 50/)
  assert.throws(() => parseHamSearchRequest({ query: "x", mode: "temporal" }), /anchor is required/i)
  assert.throws(() => parseHamSearchRequest({ query: "x", mode: "temporal", asOf: "never" }), /valid date/i)
})

test("search results expose useful memory fields without arbitrary metadata", () => {
  assert.deepEqual(projectHamSearchResultsForBrowser({ items: [{
    id: 42,
    content: "The staging deployment uses SHA abc.",
    tier: 1,
    score: 0.91,
    state: "active",
    version: 3,
    timestamp: "2026-08-20T12:00:00Z",
    metadata: {
      title: "Staging deployment",
      type: "decision",
      secret: "must-not-cross",
      resource_key: "/private/host/path",
    },
    ranking: {
      temporal: {
        mode: "valid_at",
        valid_from: "2026-08-20T12:00:00Z",
        valid_to: null,
        rotor: { private_diagnostic: true },
      },
    },
  }] }), [{
    id: "42",
    content: "The staging deployment uses SHA abc.",
    tier: 1,
    score: 0.91,
    hop: undefined,
    via_cue: undefined,
    timestamp: "2026-08-20T12:00:00Z",
    state: "active",
    version: 3,
    metadata: { title: "Staging deployment", type: "note" },
    temporal: { mode: "valid_at", valid_from: "2026-08-20T12:00:00Z" },
  }])
  assert.equal(projectHamSearchResultsForBrowser([{
    id: 43,
    content: "A document-shaped result.",
    tier: 1,
    score: 0.8,
    metadata: { type: " Document " },
  }])[0].metadata.type, "document")
  assert.equal(projectHamSearchResultsForBrowser([{
    id: 44,
    content: "An unknown semantic type.",
    tier: 1,
    score: 0.7,
    metadata: { type: "decision" },
  }])[0].metadata.type, "note")
  assert.throws(
    () => projectHamSearchResultsForBrowser({ results: [] }),
    HamSearchUpstreamResponseError,
  )
})

test("browser search projection bounds an unexpectedly long upstream result list", () => {
  const projected = projectHamSearchResultsForBrowser(Array.from({ length: 75 }, (_, index) => ({
    id: `memory-${index}`,
    content: `Memory ${index}`,
    tier: 1,
    score: index / 100,
  })))

  assert.equal(projected.length, 50)
  assert.equal(projected[0].id, "memory-0")
  assert.equal(projected.at(-1).id, "memory-49")
})

test("search bodies are rejected and cancelled before buffering past 32 KiB", async () => {
  assert.equal(HAM_SEARCH_REQUEST_MAX_BYTES, 32_768)
  assert.equal(await readBoundedHamSearchText(
    new Request("https://galaxy.test/api/ham/search", {
      method: "POST",
      body: JSON.stringify({ query: "bounded" }),
    }),
    HAM_SEARCH_REQUEST_MAX_BYTES,
  ), JSON.stringify({ query: "bounded" }))

  let cancelled = false
  const oversized = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(20_000))
      controller.enqueue(new Uint8Array(20_000))
    },
    cancel() {
      cancelled = true
    },
  }))
  await assert.rejects(
    () => readBoundedHamSearchText(oversized, HAM_SEARCH_REQUEST_MAX_BYTES),
    HamSearchBodyTooLargeError,
  )
  assert.equal(cancelled, true)
})

test("the Galaxy Brain BFF authenticates, binds identity, and keeps HAM authority server-side", async () => {
  const [route, proxy, client, modal, explorer, env] = await Promise.all([
    readFile(new URL("../app/api/ham/search/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ham-search-proxy.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ham-search-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/ham-search-modal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/galaxy-explorer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ])
  assert.match(route, /getCurrentUser\(\)/)
  assert.match(route, /assertHamSearchOrigin\(request\)/)
  assert.match(route, /HAM_SEARCH_REQUEST_MAX_BYTES/)
  assert.doesNotMatch(route, /request\.text\(\)/)
  assert.match(route, /no-store, max-age=0/)
  assert.doesNotMatch(route, /HAM_API_BEARER_TOKEN/)
  assert.doesNotMatch(proxy, /process\.env\.HAM_API_BEARER_TOKEN/)
  assert.match(proxy, /resolveHamSearchBearer/)
  assert.match(proxy, /evaluateHamSearchTenantAccess\(user, process\.env\)/)
  assert.match(proxy, /"X-GB-User-ID": config\.tenantId/)
  assert.doesNotMatch(proxy, /"X-GB-User-ID": user\.id/)
  assert.match(route, /HamSearchUpstreamResponseError/)
  assert.match(route, /return response\(\{ error: error\.message \}, 502\)/)
  assert.match(proxy, /AbortSignal\.timeout\(20_000\)/)
  assert.match(proxy, /HAM_SEARCH_RESPONSE_MAX_BYTES/)
  assert.doesNotMatch(proxy, /response\.text\(\)/)
  assert.doesNotMatch(client, /HAM_API_BEARER_TOKEN|X-GB-User-ID/)
  assert.match(client, /fetch\("\/api\/ham\/search"/)
  assert.match(modal, /mode === "temporal"/)
  assert.match(modal, /temporalMode/)
  assert.doesNotMatch(modal, /\/api\/plugins\/ham/)
  assert.doesNotMatch(explorer, /\/api\/plugins\/ham/)
  assert.match(env, /HAM_API_BEARER_TOKEN=/)
  assert.match(env, /HAM_SEARCH_GALAXY_TENANT_ID=/)
  assert.doesNotMatch(env, /NEXT_PUBLIC_HAM_API/)
})
