import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  HAM_RELATION_OVERLAY_REQUEST_SCHEMA_ID,
  HAM_RELATION_OVERLAY_RESPONSE_SCHEMA_ID,
  parseHamRelationOverlayRequest,
  parseHamRelationOverlayResponse,
} from "../lib/ham-relation-overlay-contract.js"
import { resolveHamRelationOverlay } from "../lib/ham-relation-overlay-proxy.js"
import { projectAuthoritativeHamRelationOverlay } from "../lib/ham-field-relations.js"
import {
  projectAuthorizedHamRelationOverlay,
  selectAuthorizedHamRelationReferences,
} from "../lib/canvas/authorized-canvas-projection.js"

const GALAXY_TENANT = "11111111-1111-4111-8111-111111111111"
const ref = (id) => `gb:object:v1:ham.memory:${id}:latest`
const request = (references = [ref("41"), ref("42")]) => ({
  schemaId: HAM_RELATION_OVERLAY_REQUEST_SCHEMA_ID,
  references,
})
const response = (overrides = {}) => ({
  schemaId: HAM_RELATION_OVERLAY_RESPONSE_SCHEMA_ID,
  provider: { name: "ham", status: "partial", consistency: "follow-latest", truncated: false },
  results: [
    { requestedRef: ref("41"), status: "resolved", version: 2 },
    { requestedRef: ref("42"), status: "resolved", version: 3 },
  ],
  relations: [{
    kind: "typed",
    id: "7",
    sourceRef: ref("41"),
    targetRef: ref("42"),
    relation: "verifies",
    state: "active",
    version: 4,
  }],
  ...overrides,
})

test("overlay request is a strict bounded list of unique canonical latest HAM references", () => {
  assert.deepEqual(parseHamRelationOverlayRequest(request()).references, [ref("41"), ref("42")])
  for (const invalid of [
    request([]),
    request([ref("41"), ref("41")]),
    request(["gb:object:v1:ham.memory:41:pinned:v2"]),
    request(["gb:object:v1:paper:41:latest"]),
    { ...request([ref("41")]), path: "/admin" },
    request(Array.from({ length: 25 }, (_, index) => ref(String(index + 1)))),
  ]) assert.throws(() => parseHamRelationOverlayRequest(invalid), /Invalid gb\.ham-relation-overlay-request/)
})

test("overlay response fails closed on data, unresolved endpoints, inactive rows, and reused IDs", () => {
  assert.equal(parseHamRelationOverlayResponse(response(), request()).relations[0].relation, "verifies")
  const invalid = [
    { ...response(), body: "not allowed" },
    response({ results: [
      { requestedRef: ref("41"), status: "resolved", version: 2 },
      { requestedRef: ref("42"), status: "unavailable" },
    ] }),
    response({ relations: [{ ...response().relations[0], state: "retracted" }] }),
    response({ relations: [
      response().relations[0],
      { ...response().relations[0], targetRef: ref("41"), sourceRef: ref("42"), relation: "cites" },
    ] }),
  ]
  for (const value of invalid) {
    assert.throws(() => parseHamRelationOverlayResponse(value, request()), /Invalid gb\.ham-relation-overlay-response/)
  }
})

test("Field and canvas adapters emit asserted edges without creating or authorizing nodes", () => {
  const value = response()
  const field = projectAuthoritativeHamRelationOverlay(value)
  assert.deepEqual(field.nodes, [])
  assert.equal(field.edges.length, 1)
  assert.equal(field.edges[0].basis, "authored_assertion")
  assert.equal(field.edges[0].relation, "verifies")

  const placements = [
    { id: "p41", authorized: true, availability: "resolved", subjectRef: ref("41") },
    { id: "p42", authorized: true, availability: "resolved", subjectRef: ref("42") },
    { id: "hidden", authorized: false, availability: "unavailable", subjectRef: ref("42") },
  ]
  const relations = projectAuthorizedHamRelationOverlay(placements, value)
  assert.equal(relations.length, 1)
  assert.deepEqual(relations[0], {
    id: "ham-link-7",
    sourcePlacementId: "p41",
    targetPlacementId: "p42",
    relationType: "verifies",
    trustClass: "asserted",
    owner: "HAM",
    provenance: "Authorized live HAM authored relation; follow-latest and partial, with no verification claim implied.",
  })
  assert.deepEqual(projectAuthorizedHamRelationOverlay(placements, { ...value, body: "leak" }), [])

  const structural = response({
    provider: { name: "ham", status: "partial", consistency: "follow-latest", truncated: true },
    relations: [
      { ...response().relations[0], relation: "depends-on" },
      {
        kind: "lifecycle", id: "superseded-by:41:42", sourceRef: ref("41"), targetRef: ref("42"),
        relation: "superseded_by", state: "active", version: 2,
      },
    ],
  })
  assert.deepEqual(
    projectAuthoritativeHamRelationOverlay(structural).edges.map((edge) => edge.relation),
    ["depends_on", "superseded_by"],
  )
  const canvasStructural = projectAuthorizedHamRelationOverlay(placements, structural)
  assert.deepEqual(canvasStructural.map((edge) => edge.relationType), ["depends_on", "superseded_by"])
  assert.ok(canvasStructural.every((edge) => edge.trustClass === "asserted" && edge.provenance.includes("truncated")))
})

test("25 visible HAM references report client-scope truncation independently of provider truncation", async () => {
  const placements = Array.from({ length: 25 }, (_, index) => ({
    id: `p${index + 41}`,
    authorized: true,
    availability: "resolved",
    subjectRef: ref(String(index + 41)),
  }))
  const selection = selectAuthorizedHamRelationReferences(placements)
  assert.equal(selection.eligibleCount, 25)
  assert.equal(selection.references.length, 24)
  assert.equal(selection.clientTruncated, true)

  const [relation] = projectAuthorizedHamRelationOverlay(placements, response())
  assert.match(relation.provenance, /client-truncated to 24 of 25 eligible references/)
  assert.doesNotMatch(relation.provenance, /provider-truncated/)

  const client = await readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8")
  assert.match(client, /client-truncated to \$\{HAM_RELATION_OVERLAY_MAX_REFERENCES\} of \$\{hamRelationRequest\.eligibleCount\}/)
  assert.match(client, /provider\.truncated \? ", provider-truncated"/)
})

test("BFF fetches only fixed exact endpoints and returns body-free active relations among resolved requested refs", async () => {
  const calls = []
  const bodies = new Map([
    ["/v1/memories/41", { id: 41, version: 2, content: "SECRET BODY", supersedes_id: 40, superseded_by_id: 42 }],
    ["/v1/memories/42", { id: 42, version: 3, content: "ANOTHER SECRET" }],
    ["/v1/memories/41/links", [
      { id: 7, source_id: 41, target_id: 42, relation: "verifies", state: "active", version: 4, effective_relation: "verified-by" },
      { id: 8, source_id: 41, target_id: 42, relation: "cites", state: "retracted", version: 2 },
      { id: 9, source_id: 41, target_id: 42, relation: "cites", version: 2 },
      { id: 10, source_id: 41, target_id: 999, relation: "cites", state: "active", version: 1 },
      { id: "9999999999999999999", source_id: 41, target_id: 42, relation: "cites", state: "active", version: 1 },
    ]],
    ["/v1/memories/42/links", [
      { id: 7, source_id: 41, target_id: 42, relation: "verifies", state: "active", version: 4 },
    ]],
  ])
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    const body = bodies.get(new URL(url).pathname)
    return body === undefined
      ? new Response(null, { status: 404 })
      : Response.json(body)
  }
  const overlay = await resolveHamRelationOverlay(
    request(),
    { tenantId: GALAXY_TENANT, principalId: "principal-1" },
    {
      HAM_API_INTERNAL: "https://ham.internal.example/v1",
      GALAXY_DEPLOY_HAM_API_BEARER_TOKEN: "deploy-owned",
      HAM_SEARCH_GALAXY_TENANT_ID: GALAXY_TENANT,
    },
    fetchImpl,
  )

  assert.deepEqual(calls.map((call) => new URL(call.url).pathname).sort(), [
    "/v1/memories/41", "/v1/memories/41/links", "/v1/memories/42", "/v1/memories/42/links",
  ])
  assert.ok(calls.every((call) => call.init.redirect === "error" && call.init.cache === "no-store"))
  assert.ok(calls.every((call) => call.init.headers.get("Authorization") === "Bearer deploy-owned"))
  assert.equal(overlay.provider.status, "partial")
  assert.equal(overlay.provider.consistency, "follow-latest")
  assert.deepEqual(overlay.relations.map(({ kind, id, sourceRef, targetRef, relation }) => ({
    kind, id, sourceRef, targetRef, relation,
  })).sort((left, right) => left.id.localeCompare(right.id)), [
    { kind: "typed", id: "7", sourceRef: ref("41"), targetRef: ref("42"), relation: "verifies" },
    { kind: "lifecycle", id: "superseded-by:41:42", sourceRef: ref("41"), targetRef: ref("42"), relation: "superseded_by" },
  ].sort((left, right) => left.id.localeCompare(right.id)))
  const serialized = JSON.stringify(overlay)
  assert.doesNotMatch(serialized, /SECRET|content|effective_relation|999|40/)
})

test("BFF preserves unavailable coverage and truncation truth", async () => {
  const oversizedLinks = Array.from({ length: 65 }, (_, index) => ({
    id: index + 1,
    source_id: 41,
    target_id: 42,
    relation: "cites",
    state: "active",
    version: 1,
  }))
  const overlay = await resolveHamRelationOverlay(
    request(),
    { tenantId: GALAXY_TENANT, principalId: "principal-1" },
    {
      HAM_API_INTERNAL: "https://ham.internal.example",
      HAM_API_BEARER_TOKEN: "legacy-server-only",
      HAM_SEARCH_GALAXY_TENANT_ID: GALAXY_TENANT,
    },
    async (url) => {
      const path = new URL(url).pathname
      if (path === "/memories/41") return Response.json({ id: 41, version: 1 })
      if (path === "/memories/41/links") return Response.json(oversizedLinks)
      return new Response(null, { status: 404 })
    },
  )
  assert.deepEqual(overlay.results, [
    { requestedRef: ref("41"), status: "resolved", version: 1 },
    { requestedRef: ref("42"), status: "unavailable" },
  ])
  assert.equal(overlay.provider.truncated, true)
  assert.deepEqual(overlay.relations, [])
})

test("BFF caps provider concurrency and treats redirect, oversize, and cancellation as unavailable", async () => {
  const references = Array.from({ length: 8 }, (_, index) => ref(String(index + 1)))
  let active = 0
  let maximum = 0
  const concurrent = await resolveHamRelationOverlay(
    request(references),
    { tenantId: GALAXY_TENANT, principalId: "principal-1" },
    {
      HAM_API_INTERNAL: "https://ham.internal.example",
      GALAXY_DEPLOY_HAM_API_BEARER_TOKEN: "server-only",
      HAM_SEARCH_GALAXY_TENANT_ID: GALAXY_TENANT,
    },
    async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return new Response(null, { status: 404 })
    },
  )
  assert.equal(maximum, 6)
  assert.equal(concurrent.provider.status, "unavailable")

  let call = 0
  const unavailable = await resolveHamRelationOverlay(
    request(),
    { tenantId: GALAXY_TENANT, principalId: "principal-1" },
    {
      HAM_API_INTERNAL: "https://ham.internal.example",
      GALAXY_DEPLOY_HAM_API_BEARER_TOKEN: "server-only",
      HAM_SEARCH_GALAXY_TENANT_ID: GALAXY_TENANT,
    },
    async (_url, init) => {
      call += 1
      if (call === 1) return new Response(null, { status: 302, headers: { Location: "https://other.example" } })
      if (call === 2) return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json", "Content-Length": "1048577" },
      })
      if (init.signal.aborted) throw new DOMException("aborted", "AbortError")
      return new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } })
    },
  )
  assert.equal(unavailable.provider.status, "unavailable")
  assert.ok(unavailable.results.every((result) => result.status === "unavailable"))
  assert.deepEqual(unavailable.relations, [])

  let cancelledCalls = 0
  const cancelled = await resolveHamRelationOverlay(
    request(),
    { tenantId: GALAXY_TENANT, principalId: "principal-1" },
    {
      HAM_API_INTERNAL: "https://ham.internal.example",
      GALAXY_DEPLOY_HAM_API_BEARER_TOKEN: "server-only",
      HAM_SEARCH_GALAXY_TENANT_ID: GALAXY_TENANT,
    },
    async () => {
      cancelledCalls += 1
      return Response.json({})
    },
    AbortSignal.abort(),
  )
  assert.equal(cancelledCalls, 0)
  assert.equal(cancelled.provider.status, "unavailable")
})

test("Atlas integration keeps HAM relations transient, post-hydration, and invalidates on either committed outcome", async () => {
  const [client, browser] = await Promise.all([
    readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/atlas/atlas-ham-memory-browser.tsx", import.meta.url), "utf8"),
  ])
  assert.match(client, /mergeCanvasSnapshot\([\s\S]*projectAuthorizedHamRelationOverlay/)
  assert.doesNotMatch(client, /mergeCanvasSnapshot\([^)]*hamRelationOverlay/)
  assert.match(client, /hydrationState\.key !== hydrationKey[\s\S]*requestHamRelationOverlay\(hamRelationRequest\.references/)
  assert.match(client, /onMutationCommitted=\{\(\) => setReload/)
  assert.match(browser, /if \(result\.status === "committed"\)[\s\S]*else \{[\s\S]*onMutationCommitted\?\.\(result\)/)
  assert.match(client, /Authorized relations[\s\S]*relation\.trustClass[\s\S]*relation\.provenance/)
})
