import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  AGENT_MUTATION_TOOL_IMPLEMENTATIONS,
  AGENT_READ_TOOL_IMPLEMENTATIONS,
} from "../lib/agent-tools/server.js"
import { hashCanvasSnapshot } from "../lib/canvas/canvas-snapshot.js"
import { canonicalAnchorJson } from "../lib/document-anchor.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import { createGraphWindowRequest } from "../lib/graph-window-contract.js"

const IDENTITY = Object.freeze({
  tenantId: "00000000-0000-4000-8000-000000000001",
  principalId: "00000000-0000-4000-8000-000000000002",
  kind: "agent",
  nostrPubkey: "f".repeat(64),
})
const ENVIRONMENT = Object.freeze({
  GALAXY_API_INTERNAL: "https://galaxy-api.test",
  GALAXY_API_PROXY_TOKEN: "server-only-token",
})
const TASK_PLAN_ID = "00000000-0000-4000-8000-000000000321"
const PARITY_TASK_PROPOSAL_REQUEST_HASH = "sha256:4195dc5e42219ac876dd78c8ddae997c92651a4e29387a343a0511a8ca2f5ccb"

function surfaceSpec(text = "Review this evidence") {
  return {
    schema: "gb.surface.v1",
    catalog: { id: "generous.a2ui", version: "1" },
    surfaceUpdate: {
      surfaceId: "agent-review",
      components: [{ id: "summary", component: { Text: { text } } }],
    },
    bindings: [],
  }
}

function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedJson(value[key])]))
  }
  return value
}

function taskPlanRecord() {
  return {
    id: TASK_PLAN_ID,
    tenant_id: IDENTITY.tenantId,
    ham_task_id: "ham-task-1",
    created_by_principal_id: IDENTITY.principalId,
    title: "Research plan",
    schema_version: "gb.task-plan.v1",
    current_version: 3,
    current_content_hash: "a".repeat(64),
    current_spec: {
      schema: "gb.task-plan.v1",
      task: { kind: "galaxy.ham.task", id: "ham-task-1", version: 7 },
      goal: "Review the evidence.",
      nodes: [
        { id: "research", kind: "research", title: "Research", goal: "Gather evidence.", position: { x: 0, y: 0 }, config: {} },
        { id: "challenge", kind: "challenge", title: "Challenge", goal: "Test assumptions.", position: { x: 300, y: 0 }, config: {} },
      ],
      edges: [],
    },
    provenance: {},
    creation_idempotency_key: "task-plan-create-1",
    creation_request_hash: "b".repeat(64),
    created_at: "2026-09-24T12:00:00Z",
    updated_at: "2026-09-24T12:01:00Z",
  }
}

function proposalFixture(input, pinnedRef) {
  const proposal = {
    schemaId: "gb.task-plan-proposal.v1",
    requestHash: PARITY_TASK_PROPOSAL_REQUEST_HASH,
    scope: "task-local-work",
    effect: "proposal",
    action: input.action,
    base: {
      taskPlanId: input.taskPlanId,
      taskPlanVersion: input.expectedVersion,
      taskPlanContentHash: input.expectedContentHash,
      hamTaskId: input.expectedHamTaskId,
      hamTaskVersion: input.expectedHamTaskVersion,
    },
    sourceJobIds: input.sourceJobIds,
    inputRefs: [pinnedRef],
    operations: [
      {
        op: "node.add",
        node: {
          id: "proposal-compare-1234", kind: "compare", title: input.title, goal: input.goal,
          position: { x: 590, y: 0 }, config: { inputRefs: [pinnedRef] },
        },
      },
      { op: "edge.add", edge: { id: "proposal-edge-1", source: "research", target: "proposal-compare-1234", kind: "evidence" } },
      { op: "edge.add", edge: { id: "proposal-edge-2", source: "challenge", target: "proposal-compare-1234", kind: "evidence" } },
    ],
    summary: "Proposed compare structure with 3 additive operations.",
  }
  return {
    ...proposal,
    proposalHash: `sha256:${createHash("sha256").update(JSON.stringify(sortedJson(proposal))).digest("hex")}`,
  }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function authorizedPaperProjectionResponse(reference) {
  return {
    schemaId: "gb.object-projection-source-response.v3",
    results: [{
      requestedRef: reference,
      status: "resolved",
      resolvedRef: reference,
      provider: "galaxy.paper",
      sourceKind: "paper",
      source: {
        paper: {
          id: "paper-1",
          title: "Authorized evidence",
          abstract: "Evidence available to the current tenant.",
          metadataHash: "a".repeat(64),
        },
        revision: {
          id: "revision-1",
          metadataHash: "a".repeat(64),
          document: null,
        },
      },
    }],
  }
}

function canonicalHash(value) {
  return createHash("sha256").update(canonicalAnchorJson(value)).digest("hex")
}

function anchorFixture() {
  const input = {
    documentRef: createGalaxyObjectReference("document", "00000000-0000-4000-8000-000000000111", {
      mode: "pinned", revision: `sha256:${"a".repeat(64)}`,
    }),
    representation: {
      id: "00000000-0000-4000-8000-000000000222",
      contentSha256: "b".repeat(64),
    },
    selector: { kind: "text-quote", exact: "bounded evidence" },
    idempotencyKey: "anchor-operation-1",
  }
  const selectorSha256 = canonicalHash(input.selector)
  const anchorSha256 = canonicalHash({
    representationId: input.representation.id,
    representationSha256: input.representation.contentSha256,
    selector: input.selector,
  })
  const anchorId = `sha256:${anchorSha256}`
  return {
    input,
    receipt: {
      schemaId: "gb.anchor.create-receipt.v1",
      documentRef: input.documentRef,
      anchorId,
      anchorRef: createGalaxyObjectReference("document.anchor", anchorId, {
        mode: "pinned", revision: `sha256:${input.representation.contentSha256}`,
      }),
      representationId: input.representation.id,
      representationSha256: input.representation.contentSha256,
      selectorSha256,
      anchorSha256,
      requestHash: canonicalHash({
        schemaId: "gb.agent-anchor-create.v1",
        documentRef: input.documentRef,
        representation: input.representation,
        selector: input.selector,
      }),
      replayed: true,
    },
  }
}

function proofFixture(graphKind = "mission") {
  const document = {
    schema_id: "galaxy.proof-dag.v1",
    graph_id: "mission-1",
    graph_kind: graphKind,
    title: "Proof mission",
    targets: [
      { target_id: "foundation", title: "Foundation", natural_language_summary: "Prove the foundation." },
      { target_id: "goal", title: "Goal", natural_language_summary: "Prove the goal." },
    ],
    relations: [{
      relation_id: "foundation-before-goal",
      prerequisite_target_id: "foundation",
      dependent_target_id: "goal",
      relation_type: graphKind === "repository-field" ? "AUTHORED_PREREQUISITE" : "DEPENDS_ON",
    }],
  }
  const bytes = new TextEncoder().encode(JSON.stringify(document))
  return { document, bytes, digest: createHash("sha256").update(bytes).digest("hex") }
}

function proofWorkState({ fixture, workspaceId = "mission-1-work", version = 4, itemVersion = 1,
  status = "claimed", claim = undefined, replayed = false, leaseSeconds = 900 } = {}) {
  const claimedAt = new Date(Date.now() - 60_000).toISOString()
  const expiresAt = new Date(claimedAt).getTime() + (leaseSeconds * 1_000)
  const effectiveClaim = claim === undefined ? {
    claim_id: "00000000-0000-4000-8000-000000000456",
    nostr_pubkey: IDENTITY.nostrPubkey,
    claimed_at: claimedAt,
    expires_at: new Date(expiresAt).toISOString(),
  } : claim
  return {
    schema_id: "galaxy.proof-work-state.v1",
    workspace_id: workspaceId,
    graph_ref: { graph_id: "mission-1", content_sha256: fixture.digest },
    version,
    updated_at: new Date().toISOString(),
    items: [{
      node_id: "foundation",
      version: itemVersion,
      work: {
        status,
        claim: effectiveClaim,
        hyades: null,
        blocker: "",
        task_id: "",
        linked_task_count: 0,
      },
      proof: { status: "open", candidate_sha256: null, verification: null },
      external: {},
    }],
    ...(replayed ? { replayed: true } : {}),
  }
}

test("relations.propose posts only the strict contract and verifies a bounded request-bound receipt", async () => {
  const input = {
    fromRef: createGalaxyObjectReference("document", "paper", { mode: "pinned", revision: `sha256:${"a".repeat(64)}` }),
    toRef: createGalaxyObjectReference("proof.node", "lemma", { mode: "pinned", revision: `sha256:${"b".repeat(64)}` }),
    relation: "corresponds_to", rationale: "Same formal statement.", idempotencyKey: "relation-proposal-1",
  }
  const requestHash = createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(input).sort()))).digest("hex")
  let observed
  const result = await AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.relations.propose"](input, {
    identity: IDENTITY, environment: ENVIRONMENT,
    fetchImpl: async (url, init) => {
      observed = { url: String(url), method: init.method, body: JSON.parse(init.body), headers: init.headers }
      return jsonResponse({
        schemaId: "gb.relation-proposal-receipt.v1",
        proposalId: "00000000-0000-4000-8000-000000000123",
        fromRef: input.fromRef, toRef: input.toRef, relation: input.relation,
        status: "pending", requestHash, replayed: false, createdAt: "2026-09-24T12:00:00Z",
      }, 201)
    },
  })
  assert.equal(observed.url, "https://galaxy-api.test/relation-proposals")
  assert.deepEqual(observed.body, input)
  assert.equal(observed.headers.get("X-GB-Tenant-ID"), IDENTITY.tenantId)
  assert.equal(observed.headers.get("X-GB-Agent-Tool-Gateway"), "v1")
  assert.equal(result.result.status, "pending")
  assert.equal(Object.hasOwn(result.result, "rationale"), false)
})

test("surface.draft.create posts only a draft definition with server-derived provenance", async () => {
  const surfaceId = "00000000-0000-4000-8000-000000000777"
  const evidenceRef = createGalaxyObjectReference("paper", "paper-1", {
    mode: "pinned", revision: `sha256:${"a".repeat(64)}`,
  })
  const input = {
    title: "Evidence review",
    spec: surfaceSpec(),
    evidenceRefs: [evidenceRef],
    idempotencyKey: "surface-draft-operation-1",
  }
  const observed = []
  const output = await AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.surface.draft.create"](input, {
    identity: IDENTITY,
    environment: ENVIRONMENT,
    fetchImpl: async (url, init) => {
      observed.push({ url: String(url), init, body: JSON.parse(init.body) })
      if (new URL(url).pathname === "/object-projection-sources/resolve") {
        return jsonResponse(authorizedPaperProjectionResponse(evidenceRef))
      }
      return jsonResponse({
        id: surfaceId,
        tenant_id: IDENTITY.tenantId,
        title: input.title,
        status: "draft",
        schema_version: "gb.surface.v1",
        catalog_id: "generous.a2ui",
        catalog_version: "1",
        current_version: 1,
        current_content_hash: "c".repeat(64),
        current_spec: input.spec,
        provenance: {
          source: "agent-tool:surface.draft.create",
          evidence_refs: [evidenceRef],
          actor_ref: `nostr:${IDENTITY.nostrPubkey}`,
          galaxy: { event: "created" },
        },
        creation_idempotency_key: input.idempotencyKey,
        secret_database_field: "must-not-escape",
      }, 201)
    },
  })
  assert.equal(observed.length, 2)
  assert.equal(observed[0].url, "https://galaxy-api.test/object-projection-sources/resolve")
  assert.equal(observed[0].init.headers.get("X-GB-Projection-Gateway"), "v3")
  assert.equal(observed[1].url, "https://galaxy-api.test/surfaces")
  assert.equal(observed[1].init.method, "POST")
  assert.equal(observed[1].init.headers.get("X-GB-Tenant-ID"), IDENTITY.tenantId)
  assert.equal(observed[1].init.headers.get("X-GB-Agent-Tool-Gateway"), "v1")
  assert.deepEqual(observed[1].body, {
    title: input.title,
    spec: input.spec,
    provenance: {
      source: "agent-tool:surface.draft.create",
      evidence_refs: [evidenceRef],
      actor_ref: `nostr:${IDENTITY.nostrPubkey}`,
    },
    idempotency_key: input.idempotencyKey,
  })
  assert.deepEqual(output.result, {
    surfaceRef: createGalaxyObjectReference("surface", surfaceId, {
      mode: "pinned", revision: `sha256:${"c".repeat(64)}`,
    }),
    surfaceId,
    status: "draft",
    version: 1,
    contentHash: `sha256:${"c".repeat(64)}`,
    replayed: false,
    reviewUrl: `/surfaces?surface=${surfaceId}&version=1&hash=${"c".repeat(64)}`,
  })
  assert.equal(JSON.stringify(output).includes("secret_database_field"), false)
})

test("surface.draft.create rejects provider records outside the exact draft request", async () => {
  const surfaceId = "00000000-0000-4000-8000-000000000777"
  const input = {
    title: "Evidence review",
    spec: surfaceSpec(),
    evidenceRefs: [createGalaxyObjectReference("paper", "paper-1", {
      mode: "pinned", revision: `sha256:${"a".repeat(64)}`,
    })],
    idempotencyKey: "surface-draft-operation-1",
  }
  const base = {
    id: surfaceId,
    tenant_id: IDENTITY.tenantId,
    title: input.title,
    status: "draft",
    schema_version: "gb.surface.v1",
    catalog_id: "generous.a2ui",
    catalog_version: "1",
    current_version: 1,
    current_content_hash: "c".repeat(64),
    current_spec: input.spec,
    provenance: {
      source: "agent-tool:surface.draft.create",
      evidence_refs: input.evidenceRefs,
      actor_ref: `nostr:${IDENTITY.nostrPubkey}`,
    },
    creation_idempotency_key: input.idempotencyKey,
  }
  const creationRevision = {
    id: "00000000-0000-4000-8000-000000000778",
    tenant_id: IDENTITY.tenantId,
    surface_id: surfaceId,
    version: 1,
    title: input.title,
    status: "draft",
    content_hash: "c".repeat(64),
    spec: input.spec,
    provenance: base.provenance,
    idempotency_key: input.idempotencyKey,
    request_hash: "e".repeat(64),
  }
  const fetchFor = (response) => async (url) => {
    const parsed = new URL(url)
    if (parsed.pathname === "/object-projection-sources/resolve") {
      return jsonResponse(authorizedPaperProjectionResponse(input.evidenceRefs[0]))
    }
    return jsonResponse(response)
  }
  const replayed = await AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.surface.draft.create"](
    input,
    {
      identity: IDENTITY,
      environment: ENVIRONMENT,
      fetchImpl: fetchFor({
        ...base,
        title: "Later title",
        status: "promoted",
        current_version: 2,
        current_content_hash: "d".repeat(64),
        current_spec: surfaceSpec("Later definition"),
        provenance: { source: "later-update" },
        replayed: true,
        replayed_revision: creationRevision,
      }),
    },
  )
  assert.equal(replayed.result.version, 1)
  assert.equal(replayed.result.contentHash, `sha256:${"c".repeat(64)}`)
  assert.equal(replayed.result.replayed, true)
  assert.equal(
    replayed.result.reviewUrl,
    `/surfaces?surface=${surfaceId}&version=1&hash=${"c".repeat(64)}`,
  )
  for (const response of [
    { ...base, tenant_id: "00000000-0000-4000-8000-000000000999" },
    { ...base, status: "promoted" },
    { ...base, title: "Different draft" },
    { ...base, current_spec: surfaceSpec("Different definition") },
    { ...base, current_spec: surfaceSpec("javascript:alert(1)") },
    { ...base, provenance: { ...base.provenance, evidence_refs: [] } },
    { ...base, creation_idempotency_key: "different-operation" },
    { ...base, current_content_hash: `sha256:${"c".repeat(64)}` },
    { ...base, replayed: false },
  ]) {
    await assert.rejects(() => AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.surface.draft.create"](
      input,
      { identity: IDENTITY, environment: ENVIRONMENT, fetchImpl: fetchFor(response) },
    ), (error) => error.code === "invalid_provider_response" && error.status === 502)
  }
  await assert.rejects(() => AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.surface.draft.create"](
    input,
    {
      identity: IDENTITY,
      environment: ENVIRONMENT,
      fetchImpl: fetchFor({
        ...base,
        replayed: true,
        replayed_revision: {
          ...creationRevision,
          spec: surfaceSpec("Different creation definition"),
        },
      }),
    },
  ), (error) => error.code === "invalid_provider_response" && error.status === 502)
})

test("surface.draft.create refuses inaccessible evidence before persisting a draft", async () => {
  const evidenceRef = createGalaxyObjectReference("paper", "paper-1", {
    mode: "pinned", revision: `sha256:${"a".repeat(64)}`,
  })
  const seen = []
  await assert.rejects(() => AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.surface.draft.create"]({
    title: "Evidence review",
    spec: surfaceSpec(),
    evidenceRefs: [evidenceRef],
    idempotencyKey: "surface-draft-operation-unavailable",
  }, {
    identity: IDENTITY,
    environment: ENVIRONMENT,
    fetchImpl: async (url) => {
      seen.push(String(url))
      return jsonResponse({
        schemaId: "gb.object-projection-source-response.v3",
        results: [{ requestedRef: evidenceRef, status: "unavailable" }],
      })
    },
  }), (error) => error.code === "not_found" && error.status === 404)
  assert.deepEqual(seen, ["https://galaxy-api.test/object-projection-sources/resolve"])
})

test("relation proposals remain private to the fresh-auth agent gateway", async () => {
  const route = await readFile(new URL("../app/api/eln/[...path]/route.ts", import.meta.url), "utf8")
  assert.match(route, /\["object-projection-sources", "agent-anchor-creations", "relation-proposals"\]\.includes\(path\[0\]\)/)
})

test("objects.get and objects.representations reuse the authorization-filtered projection gateway", async () => {
  const requestedRef = createGalaxyObjectReference("paper", "paper-1")
  const pinnedRef = createGalaxyObjectReference("paper", "paper-1", {
    mode: "pinned", revision: `sha256:${"a".repeat(64)}`,
  })
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) })
    return jsonResponse({
      schemaId: "gb.object-projection-source-response.v3",
      results: [{
        requestedRef,
        status: "resolved",
        resolvedRef: pinnedRef,
        provider: "galaxy.paper",
        sourceKind: "paper",
        source: {
          paper: { id: "paper-1", title: "Paper", abstract: "Evidence", metadataHash: "a".repeat(64) },
          revision: {
            id: "revision-1",
            metadataHash: "a".repeat(64),
            document: {
              ref: createGalaxyObjectReference(
                "document",
                "40000000-0000-4000-8000-000000000001",
                { mode: "pinned", revision: `sha256:${"c".repeat(64)}` },
              ),
              documentId: "40000000-0000-4000-8000-000000000001",
              revisionId: "50000000-0000-4000-8000-000000000001",
              revisionSha256: "c".repeat(64),
              contentSha256: "b".repeat(64),
              mediaType: "application/pdf",
              displayFilename: "paper.pdf",
            },
          },
        },
      }],
    })
  }
  const context = { identity: IDENTITY, environment: ENVIRONMENT, fetchImpl }
  const object = await AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.objects.get"]({ ref: requestedRef }, context)
  assert.equal(object.result.object.ref, pinnedRef)
  assert.equal(object.result.representationCount, 2)
  assert.equal(Object.hasOwn(object.result.object, "representations"), false)

  const representations = await AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.objects.representations"]({
    ref: requestedRef, limit: 1, cursor: null,
  }, context)
  assert.equal(representations.result.representations.length, 1)
  assert.equal(representations.pagination.hasMore, true)
  assert.equal(seen[0].headers.get("X-GB-Tenant-ID"), IDENTITY.tenantId)
  assert.equal(seen[0].headers.get("X-GB-Principal-ID"), IDENTITY.principalId)
  assert.equal(seen[0].headers.get("X-GB-Proxy-Token"), "server-only-token")
  assert.deepEqual(seen[0].body.references, [requestedRef])
})

test("objects.search preserves the exact bounded corpus contract through the identity-bound provider", async () => {
  const documentId = "40000000-0000-4000-8000-000000000001"
  const revisionId = "50000000-0000-4000-8000-000000000001"
  const revisionSha256 = "a".repeat(64)
  const documentRef = createGalaxyObjectReference("document", documentId, {
    mode: "pinned", revision: `sha256:${revisionSha256}`,
  })
  const search = {
    schemaId: "gb.document-corpus-search.v1",
    query: "helicity vortex",
    items: [{
      documentRef,
      documentId,
      documentRevisionId: revisionId,
      revisionSha256,
      title: "Vortex transport",
      displayFilename: "Vortex transport.pdf",
      snippet: "A bounded exact passage about helicity and vortices.",
      matchSource: "content",
      source: {
        manifestId: `sha256:${"b".repeat(64)}`,
        representationId: "60000000-0000-4000-8000-000000000001",
        representationSha256: "c".repeat(64),
        representationKind: "document-structure",
        chunkContentSha256: "d".repeat(64),
        selector: { kind: "json-pointer", pointer: "/blocks/7" },
      },
    }],
    continuation: { hasMore: false },
  }
  const calls = []
  const context = {
    identity: IDENTITY,
    environment: ENVIRONMENT,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), headers: init.headers })
      return jsonResponse(search)
    },
  }

  const output = await AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.objects.search"]({
    query: "helicity vortex", limit: 8,
  }, context)
  assert.deepEqual(output.result, search)
  assert.equal(calls[0].url, "https://galaxy-api.test/documents/search?q=helicity+vortex&limit=8")
  assert.equal(calls[0].headers.get("X-GB-Tenant-ID"), IDENTITY.tenantId)
  assert.equal(calls[0].headers.get("X-GB-Principal-ID"), IDENTITY.principalId)
  assert.equal(calls[0].headers.get("X-GB-Proxy-Token"), "server-only-token")
  assert.equal(calls[0].headers.get("X-GB-Agent-Tool-Gateway"), "v1")

  await assert.rejects(() => AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.objects.search"]({
    query: "different", limit: 8,
  }, context), (error) => error.code === "invalid_provider_response" && error.status === 502)

  await assert.rejects(() => AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.objects.search"]({
    query: "helicity vortex", limit: 8,
  }, {
    ...context,
    fetchImpl: async () => new Response(JSON.stringify(search), {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "65537",
      },
    }),
  }), (error) => error.code === "provider_response_too_large" && error.status === 502)
})

test("ham.memory.search uses fixed tenant-bound service authority and bounded canonical results", async () => {
  const calls = []
  const environment = {
    HAM_API_INTERNAL: "https://ham.test/api",
    HAM_API_BEARER_TOKEN: "ham-service-token",
    HAM_SEARCH_GALAXY_TENANT_ID: IDENTITY.tenantId,
  }
  const output = await AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.ham.memory-search"]({
    query: "helicity memory", mode: "multihop", topK: 12, maxHops: 2,
  }, {
    identity: IDENTITY,
    environment,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init, body: JSON.parse(init.body) })
      return jsonResponse({
        items: [{
          id: "17",
          content: "é".repeat(10_000),
          tier: 1,
          score: 0.75,
          hop: 2,
          via_cue: "linked proof",
          timestamp: "2026-09-27T12:00:00Z",
          state: "active",
          version: 4,
          metadata: { title: "Memory 17", type: "note", private: "omitted" },
          ranking: { temporal: { mode: "known_at", recorded_at: "2026-09-27T12:00:00Z", private: "omitted" } },
        }],
      })
    },
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "https://ham.test/api/retrieve/multihop/scoped")
  assert.equal(calls[0].init.method, "POST")
  assert.equal(calls[0].init.redirect, "error")
  assert.equal(calls[0].init.cache, "no-store")
  assert.ok(calls[0].init.signal instanceof AbortSignal)
  assert.equal(calls[0].init.headers.get("Authorization"), "Bearer ham-service-token")
  assert.equal(calls[0].init.headers.get("X-GB-User-ID"), IDENTITY.tenantId)
  assert.equal(calls[0].init.headers.get("X-HAM-Agent-ID"), IDENTITY.nostrPubkey)
  assert.equal(calls[0].init.headers.get("X-HAM-Actor-Type"), "service")
  assert.equal(calls[0].init.headers.get("X-GB-Performed-By"), "service:galaxy-brain-agent-tool")
  assert.deepEqual(calls[0].body, {
    query: "helicity memory", top_k: 12, include_context: false, max_hops: 2,
  })
  assert.equal(output.result.provider, "ham")
  assert.equal(output.result.mode, "multihop")
  assert.equal(output.result.truncated, true)
  assert.equal(output.result.items.length, 1)
  assert.equal(output.result.items[0].ref, "gb:object:v1:ham.memory:17:latest")
  assert.equal(output.result.items[0].contentTruncated, true)
  assert.ok(new TextEncoder().encode(output.result.items[0].content).byteLength <= 16_384)
  assert.deepEqual(output.result.items[0].metadata, { title: "Memory 17", type: "note" })
  assert.deepEqual(output.result.items[0].temporal, {
    mode: "known_at", recorded_at: "2026-09-27T12:00:00Z",
  })
  assert.equal(JSON.stringify(output.result).includes("private"), false)
})

test("ham.memory.search derives fallback actor identity and fails closed on authority or provider drift", async () => {
  const environment = {
    HAM_API_INTERNAL: "https://ham.test",
    HAM_API_BEARER_TOKEN: "ham-service-token",
    HAM_SEARCH_GALAXY_TENANT_ID: IDENTITY.tenantId,
  }
  let actor = null
  const input = { query: "memory", mode: "search", topK: 1 }
  await AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.ham.memory-search"](input, {
    identity: { ...IDENTITY, nostrPubkey: undefined },
    environment,
    fetchImpl: async (_url, init) => {
      actor = init.headers.get("X-HAM-Agent-ID")
      return jsonResponse([{ id: 1, content: "bounded", tier: 0 }])
    },
  })
  assert.equal(actor, `galaxy:${IDENTITY.principalId}`)

  const capped = await AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.ham.memory-search"](input, {
    identity: IDENTITY,
    environment,
    fetchImpl: async () => jsonResponse([
      { id: 1, content: "first", tier: 0 },
      { id: 2, content: "second", tier: 0 },
    ]),
  })
  assert.equal(capped.result.items.length, 1)
  assert.equal(capped.result.items[0].ref, "gb:object:v1:ham.memory:1:latest")
  assert.equal(capped.result.truncated, true)

  for (const identity of [null, {}, { ...IDENTITY, tenantId: null }]) {
    await assert.rejects(() => AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.ham.memory-search"](
      input,
      { identity, environment, fetchImpl: async () => jsonResponse([]) },
    ), (error) => error.code === "forbidden" && error.status === 403
      && !/tenantId|toLowerCase/u.test(error.message))
  }
  await assert.rejects(() => AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.ham.memory-search"](
    input,
    { identity: IDENTITY, environment: { ...environment, HAM_API_INTERNAL: "https://evil.test/?target=ham" } },
  ), (error) => error.code === "provider_unavailable" && error.status === 503)

  const invalidResponses = [
    () => jsonResponse([{ id: "0", content: "invalid identity", tier: 0 }]),
    () => jsonResponse([{ id: 9_007_199_254_740_993, content: "unsafe rounded identity", tier: 0 }]),
    () => jsonResponse([{ id: "9223372036854775808", content: "overflow", tier: 0 }]),
    () => new Response("not json", { headers: { "Content-Type": "text/plain" } }),
    () => new Response(JSON.stringify({ detail: "database password leaked" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    }),
    () => new Response(JSON.stringify([]), {
      headers: { "Content-Type": "application/json", "Content-Length": "32769" },
    }),
  ]
  for (const response of invalidResponses) {
    await assert.rejects(() => AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.ham.memory-search"](
      input,
      { identity: IDENTITY, environment, fetchImpl: async () => response() },
    ), (error) => error.status === 502
      && !/database password|invalid identity|unsafe rounded|overflow/u.test(error.message))
  }
})

test("graph.window.get preserves the strict provider window and server-owned authority boundary", async () => {
  const clusterId = `gwc:${"b".repeat(64)}`
  const memberRef = createGalaxyObjectReference("document", "graph-document", {
    mode: "pinned", revision: `sha256:${"c".repeat(64)}`,
  })
  const input = createGraphWindowRequest({
    viewport: { x: 0, y: 0, width: 1200, height: 800 },
    kinds: ["document"],
    relations: ["related"],
    expandClusterId: clusterId,
  })
  const { schemaId: _schemaId, ...query } = input
  const window = {
    schemaId: "gb.graph-window.v1",
    consistency: "follow-latest",
    query,
    windowHash: "d".repeat(64),
    clusters: [{
      id: clusterId,
      provider: "galaxy.document",
      kind: "document",
      label: "Documents",
      count: 1,
      countStatus: "exact",
      expandable: true,
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    }],
    members: [{
      ref: memberRef,
      clusterId,
      provider: "galaxy.document",
      kind: "document",
      title: "Graph document",
      updatedAt: "2026-09-27T12:00:00Z",
    }],
    edges: [],
    focus: null,
    providers: [
      { provider: "galaxy.document", status: "ready", count: 1 },
      {
        provider: "galaxy.object-links",
        status: "partial",
        reason: "Aggregate relation windows are not emitted by this bounded read model yet",
      },
    ],
    provenance: {
      workspaceId: "tenant-catalog",
      source: "tenant-scoped Galaxy providers",
      memberReferences: "exact-pinned-only",
    },
    continuation: { cursor: "next_page-2", hasMore: true, model: "replace-page" },
  }
  const calls = []
  const context = {
    identity: IDENTITY,
    environment: ENVIRONMENT,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init, body: JSON.parse(init.body) })
      return jsonResponse(window)
    },
  }

  const output = await AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.graph.window.get"](input, context)
  assert.equal(calls.length, 1)
  assert.deepEqual(output.result, { ...window, query: input })
  assert.equal(calls[0].url, "https://galaxy-api.test/graph/window")
  assert.equal(calls[0].init.method, "POST")
  assert.equal(calls[0].init.headers.get("X-GB-Tenant-ID"), IDENTITY.tenantId)
  assert.equal(calls[0].init.headers.get("X-GB-Principal-ID"), IDENTITY.principalId)
  assert.equal(calls[0].init.headers.get("X-GB-Proxy-Token"), "server-only-token")
  assert.equal(calls[0].init.headers.get("X-GB-Graph-Window-Gateway"), "v1")
  assert.deepEqual(calls[0].body, input)
  assert.equal(output.result.providers[1].status, "partial")
  assert.deepEqual(output.result.edges, [])
  assert.equal(output.result.consistency, "follow-latest")
  assert.deepEqual(output.result.continuation, {
    cursor: "next_page-2", hasMore: true, model: "replace-page",
  })

  const invalidWindows = [
    { ...window, query: { ...window.query, scale: "atomic" } },
    { ...window, members: [{ ...window.members[0], ref: createGalaxyObjectReference("document", "mutable") }] },
    { ...window, edges: [{ from: memberRef, to: memberRef }] },
  ]
  for (const invalidWindow of invalidWindows) {
    await assert.rejects(() => AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.graph.window.get"](
      input,
      { ...context, fetchImpl: async () => jsonResponse(invalidWindow) },
    ), (error) => error.code === "invalid_provider_response" && error.status === 502)
  }

  await assert.rejects(() => AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.graph.window.get"](
    input,
    { ...context, fetchImpl: async () => new Response("not json", { headers: { "Content-Type": "text/plain" } }) },
  ), (error) => error.code === "invalid_provider_response" && error.status === 502)
  await assert.rejects(() => AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.graph.window.get"](
    input,
    { ...context, fetchImpl: async () => new Response(null, { status: 404 }) },
  ), (error) => error.code === "not_found" && error.status === 404)
  await assert.rejects(() => AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.graph.window.get"](
    input,
    { ...context, fetchImpl: async () => jsonResponse({ detail: "signed cursor leaked" }, 409) },
  ), (error) => error.code === "invalid_cursor" && error.status === 409
    && /restart the replace-page read/u.test(error.message)
    && !/signed cursor leaked/u.test(error.message))
  const cursorInput = createGraphWindowRequest({
    viewport: input.viewport,
    kinds: input.filters.kinds,
    relations: input.filters.relations,
    expandClusterId: clusterId,
    cursor: "foreign_signed_cursor",
  })
  await assert.rejects(() => AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.graph.window.get"](
    cursorInput,
    { ...context, fetchImpl: async () => jsonResponse({ detail: "foreign principal leaked" }, 422) },
  ), (error) => error.code === "invalid_cursor" && error.status === 409
    && /restart the replace-page read/u.test(error.message)
    && !/foreign principal leaked/u.test(error.message))
  await assert.rejects(() => AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.graph.window.get"](
    input,
    { ...context, fetchImpl: async () => jsonResponse({ detail: "cluster internals leaked" }, 422) },
  ), (error) => error.code === "invalid_request" && error.status === 422
    && /reload the graph window/u.test(error.message)
    && !/cluster internals leaked/u.test(error.message))
  await assert.rejects(() => AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.graph.window.get"](
    input,
    { ...context, fetchImpl: async () => new Response(JSON.stringify(window), {
      headers: { "Content-Type": "application/json", "Content-Length": "1048577" },
    }) },
  ), (error) => error.code === "provider_response_too_large" && error.status === 502)
})

test("representation cursors are bound to the normalized mutable-head snapshot", async () => {
  const requestedRef = createGalaxyObjectReference("eln.experiment", "experiment-1")
  let updatedAt = "2026-09-24T12:00:00Z"
  const fetchImpl = async () => jsonResponse({
    schemaId: "gb.object-projection-source-response.v3",
    results: [{
      requestedRef,
      status: "resolved",
      resolvedRef: requestedRef,
      provider: "galaxy-brain-eln",
      sourceKind: "eln.experiment",
      source: {
        id: "experiment-1",
        title: "Experiment",
        results: "Observed result",
        interpretation: "Current interpretation",
        updatedAt,
      },
    }],
  })
  const context = { identity: IDENTITY, environment: ENVIRONMENT, fetchImpl }
  const input = { ref: requestedRef, limit: 1, cursor: null }
  const first = await AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.objects.representations"](input, context)
  assert.match(first.pagination.cursor, /^gbr2:[a-f0-9]{64}:1$/u)

  const second = await AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.objects.representations"]({
    ...input,
    cursor: first.pagination.cursor,
  }, context)
  assert.equal(second.result.representations[0].kind, "markdown")

  updatedAt = "2026-09-24T12:01:00Z"
  await assert.rejects(() => AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.objects.representations"]({
    ...input,
    cursor: first.pagination.cursor,
  }, context), (error) => {
    assert.equal(error.code, "invalid_cursor")
    assert.equal(error.status, 409)
    return true
  })
})

test("canvas.get verifies the durable hash and exposes one bounded snapshot page", async () => {
  const canvasId = "00000000-0000-4000-8000-000000000123"
  const content = {
    schemaId: "gb.canvas.snapshot.v1",
    items: [{
      id: "paper-1",
      subjectRef: createGalaxyObjectReference("paper", "paper-1"),
      nodeType: "galaxy.paper",
      x: 0, y: 0, width: 320, height: 220, angle: 0, zIndex: 1,
      displayMode: "card", collapsed: false, style: {},
    }],
    frames: [{
      id: "sources", title: "Sources", x: -40, y: -40,
      width: 720, height: 480, tone: "sage",
    }],
    edges: [], removedItemIds: [], removedEdgeIds: [],
  }
  const contentHash = await hashCanvasSnapshot(content)
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers })
    return jsonResponse({
      canvasId, workspaceId: "workspace-1", slug: "research", title: "Research",
      isDefault: true, version: 4, contentHash, content,
    })
  }
  const output = await AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.canvas.get"]({
    canvasId, cursor: null, limit: 2,
  }, { identity: IDENTITY, environment: ENVIRONMENT, fetchImpl })
  assert.equal(output.result.canvas.version, 4)
  assert.deepEqual(output.result.snapshotPage.entries.map((entry) => entry.entryType), ["frame", "item"])
  assert.equal(Object.hasOwn(output.result.snapshotPage.entries[0].frame, "subjectRef"), false)
  assert.equal(output.pagination.hasMore, false)
  assert.equal(calls[0].url, `https://galaxy-api.test/canvases/${canvasId}`)
  assert.equal(calls[0].headers.get("X-GB-Tenant-ID"), IDENTITY.tenantId)
})

test("canvas.arrange forwards one optimistic presentation-only batch and returns its bound receipt", async () => {
  const canvasId = "00000000-0000-4000-8000-000000000123"
  const mutationId = "00000000-0000-4000-8000-000000000456"
  const contentHash = `sha256:${"b".repeat(64)}`
  const requestHash = "a1f52c3c7f7e99ae3a3c2cb3a08bf3e3520fbbbdd931886575c937a01dc19cdf"
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) })
    return jsonResponse({
      schemaId: "gb.canvas.mutation-receipt.v1",
      canvasId, version: 5, contentHash, mutationId, requestHash, replayed: true,
    })
  }
  const output = await AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.canvas.arrange"]({
    canvasId,
    expectedVersion: 4,
    expectedContentHash: `sha256:${"a".repeat(64)}`,
    idempotencyKey: "arrange-operation-1",
    commands: [{ type: "item.move", itemId: "paper-1", position: { x: 40, y: 50 } }],
  }, { identity: IDENTITY, environment: ENVIRONMENT, fetchImpl })
  assert.deepEqual(output.result, {
    canvasId, version: 5, contentHash, mutationId, replayed: true, appliedCommandCount: 1,
  })
  assert.equal(calls[0].url, `https://galaxy-api.test/canvases/${canvasId}/mutations?response=receipt`)
  assert.equal(calls[0].init.method, "POST")
  assert.equal(calls[0].init.headers.get("X-GB-Tenant-ID"), IDENTITY.tenantId)
  assert.equal(calls[0].init.headers.get("X-GB-Principal-ID"), IDENTITY.principalId)
  assert.equal(calls[0].body.expectedVersion, 4)
  assert.deepEqual(calls[0].body.commands, [
    { type: "item.move", itemId: "paper-1", position: { x: 40, y: 50 } },
  ])
})

test("anchors.create forwards one exact request and returns only its bound receipt", async () => {
  const { input, receipt } = anchorFixture()
  const calls = []
  const output = await AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.anchors.create"](
    input,
    {
      identity: IDENTITY,
      environment: ENVIRONMENT,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init, body: JSON.parse(init.body) })
        return jsonResponse(receipt, 201)
      },
    },
  )
  assert.deepEqual(output.result, receipt)
  assert.equal(calls[0].url, "https://galaxy-api.test/agent-anchor-creations")
  assert.equal(calls[0].init.method, "POST")
  assert.equal(calls[0].init.headers.get("X-GB-Agent-Tool-Gateway"), "v1")
  assert.equal(calls[0].init.headers.get("X-GB-Tenant-ID"), IDENTITY.tenantId)
  assert.equal(calls[0].init.headers.get("X-GB-Principal-ID"), IDENTITY.principalId)
  assert.equal(calls[0].init.headers.get("X-GB-Nostr-Pubkey"), IDENTITY.nostrPubkey)
  assert.deepEqual(calls[0].body, input)
  assert.equal(Object.hasOwn(output.result, "documentRevisionId"), false)
})

test("anchors.create rejects unbound, oversized, or secret-bearing provider responses", async () => {
  const { input, receipt } = anchorFixture()
  for (const changed of [
    { ...receipt, requestHash: "f".repeat(64) },
    { ...receipt, anchorSha256: "f".repeat(64) },
    { ...receipt, documentRevisionId: "00000000-0000-4000-8000-000000000999" },
  ]) {
    await assert.rejects(() => AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.anchors.create"](
      input,
      { identity: IDENTITY, environment: ENVIRONMENT, fetchImpl: async () => jsonResponse(changed, 201) },
    ), /invalid receipt|does not match/u)
  }
  await assert.rejects(() => AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.anchors.create"](
    input,
    {
      identity: IDENTITY, environment: ENVIRONMENT,
      fetchImpl: async () => jsonResponse({ ...receipt, padding: "x".repeat(9_000) }, 201),
    },
  ), (error) => error.code === "provider_response_too_large")
  await assert.rejects(() => AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.anchors.create"](
    input,
    {
      identity: IDENTITY, environment: ENVIRONMENT,
      fetchImpl: async () => jsonResponse({
        detail: { code: "idempotency_key_reused", secret: "database-state" },
      }, 409),
    },
  ), (error) => {
    assert.equal(error.code, "idempotency_key_reused")
    assert.equal(error.status, 409)
    assert.doesNotMatch(error.message, /secret|database-state/u)
    return true
  })
})

test("canvas.arrange safely distinguishes stale state from idempotency-key reuse", async () => {
  const canvasId = "00000000-0000-4000-8000-000000000123"
  const input = {
    canvasId, expectedVersion: 4, expectedContentHash: `sha256:${"a".repeat(64)}`,
    idempotencyKey: "arrange-operation-1",
    commands: [{ type: "item.move", itemId: "paper-1", position: { x: 40, y: 50 } }],
  }
  for (const [providerCode, expectedCode] of [
    ["stale_canvas", "stale_canvas"],
    ["idempotency_key_reused", "idempotency_key_reused"],
    ["unknown", "conflict"],
  ]) {
    await assert.rejects(() => AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.canvas.arrange"](
      input,
      {
        identity: IDENTITY, environment: ENVIRONMENT,
        fetchImpl: async () => jsonResponse({ detail: { code: providerCode, secret: "backend-state" } }, 409),
      },
    ), (error) => {
      assert.equal(error.code, expectedCode)
      assert.equal(error.status, 409)
      assert.doesNotMatch(error.message, /secret|backend-state/u)
      return true
    })
  }
})

test("task.plan.get exposes one tenant-bound validated saved plan", async () => {
  const calls = []
  const output = await AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.task.plan.get"]({
    taskPlanId: TASK_PLAN_ID, hamTaskId: null,
  }, {
    identity: IDENTITY,
    environment: ENVIRONMENT,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return jsonResponse(taskPlanRecord())
    },
  })
  assert.equal(output.result.taskPlan.taskPlanId, TASK_PLAN_ID)
  assert.equal(output.result.taskPlan.hamTaskVersion, 7)
  assert.equal(output.result.taskPlan.proposalEligible, true)
  assert.equal(output.result.taskPlan.spec.nodes.length, 2)
  assert.match(output.result.taskPlan.objectRef, /:task-plan:.*:pinned:sha256%3A/u)
  assert.equal(calls[0].url, `https://galaxy-api.test/task-plans/${TASK_PLAN_ID}`)
  assert.equal(calls[0].init.headers.get("X-GB-Tenant-ID"), IDENTITY.tenantId)

  const byHamTask = await AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.task.plan.get"]({
    taskPlanId: null, hamTaskId: "ham-task-1",
  }, {
    identity: IDENTITY,
    environment: ENVIRONMENT,
    fetchImpl: async (url) => {
      assert.equal(String(url), "https://galaxy-api.test/task-plans?ham_task_id=ham-task-1&limit=1")
      return jsonResponse([taskPlanRecord()])
    },
  })
  assert.equal(byHamTask.result.taskPlan.taskPlanId, TASK_PLAN_ID)
})

test("task.plan.propose sends a pure exact-base intent and verifies the proposal hash", async () => {
  const pinnedRef = createGalaxyObjectReference("paper", "paper-1", {
    mode: "pinned", revision: `sha256:${"c".repeat(64)}`,
  })
  const input = {
    taskPlanId: TASK_PLAN_ID,
    expectedVersion: 3,
    expectedContentHash: "a".repeat(64),
    expectedHamTaskId: "ham-task-1",
    expectedHamTaskVersion: 7,
    action: "compare",
    sourceJobIds: ["research", "challenge"],
    title: "Compare",
    goal: "Compare the evidence.",
    instruction: null,
    inputRefs: [pinnedRef],
    branches: [],
  }
  const calls = []
  const output = await AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.task.plan.propose"](input, {
    identity: IDENTITY,
    environment: ENVIRONMENT,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init, body: JSON.parse(init.body) })
      return jsonResponse(proposalFixture(input, pinnedRef))
    },
  })
  assert.equal(output.result.proposal.effect, "proposal")
  assert.equal(output.result.proposal.requestHash, PARITY_TASK_PROPOSAL_REQUEST_HASH)
  assert.equal(output.result.proposal.operations.length, 3)
  assert.equal(calls[0].url, `https://galaxy-api.test/task-plans/${TASK_PLAN_ID}/proposals`)
  assert.equal(calls[0].init.method, "POST")
  assert.equal(calls[0].init.headers.get("X-GB-Agent-Tool-Gateway"), "v1")
  assert.equal(Object.hasOwn(calls[0].body, "taskPlanId"), false)
  assert.equal(calls[0].body.expectedVersion, 3)

  const corrupted = proposalFixture(input, pinnedRef)
  corrupted.summary = "Provider changed the result after hashing."
  await assert.rejects(() => AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.task.plan.propose"](
    input,
    { identity: IDENTITY, environment: ENVIRONMENT, fetchImpl: async () => jsonResponse(corrupted) },
  ), (error) => error.code === "invalid_provider_response" && /hash verification/u.test(error.message))
})

test("task.plan.propose redacts provider conflicts and rejected references", async () => {
  const input = {
    taskPlanId: TASK_PLAN_ID,
    expectedVersion: 3,
    expectedContentHash: "a".repeat(64),
    expectedHamTaskId: "ham-task-1",
    expectedHamTaskVersion: 7,
    action: "challenge",
    sourceJobIds: ["research"],
    title: "Challenge",
    goal: "Challenge the premise.",
    instruction: null,
    inputRefs: [],
    branches: [],
  }
  for (const [status, payload, code] of [
    [409, { detail: { code: "stale_task_plan", secret: "database-state" } }, "stale_task_plan"],
    [404, { detail: "private-reference-name" }, "not_found"],
    [422, { detail: { code: "invalid_task_plan_proposal", secret: "backend-shape" } }, "invalid_task_plan_proposal"],
  ]) {
    await assert.rejects(() => AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.task.plan.propose"](
      input,
      { identity: IDENTITY, environment: ENVIRONMENT, fetchImpl: async () => jsonResponse(payload, status) },
    ), (error) => {
      assert.equal(error.code, code)
      assert.doesNotMatch(error.message, /secret|database|private-reference|backend/u)
      return true
    })
  }
})

test("canvas.arrange rejects malformed or oversized mutation receipts", async () => {
  const canvasId = "00000000-0000-4000-8000-000000000123"
  const input = {
    canvasId, expectedVersion: 4, expectedContentHash: `sha256:${"a".repeat(64)}`,
    idempotencyKey: "arrange-operation-1",
    commands: [{ type: "item.move", itemId: "paper-1", position: { x: 40, y: 50 } }],
  }
  await assert.rejects(() => AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.canvas.arrange"](
    input,
    {
      identity: IDENTITY, environment: ENVIRONMENT,
      fetchImpl: async () => jsonResponse({
        schemaId: "gb.canvas.mutation-receipt.v1",
        canvasId, version: 5, contentHash: `sha256:${"b".repeat(64)}`,
        mutationId: "00000000-0000-4000-8000-000000000456",
        requestHash: "a1f52c3c7f7e99ae3a3c2cb3a08bf3e3520fbbbdd931886575c937a01dc19cdf",
        replayed: false,
        content: "forbidden-full-snapshot",
      }),
    },
  ), /invalid mutation receipt/u)

  for (const receipt of [
    {
      schemaId: "gb.canvas.mutation-receipt.v1",
      canvasId, version: 999, contentHash: `sha256:${"b".repeat(64)}`,
      mutationId: "00000000-0000-4000-8000-000000000456",
      requestHash: "a1f52c3c7f7e99ae3a3c2cb3a08bf3e3520fbbbdd931886575c937a01dc19cdf",
      replayed: false,
    },
    {
      schemaId: "gb.canvas.mutation-receipt.v1",
      canvasId, version: 5, contentHash: `sha256:${"b".repeat(64)}`,
      mutationId: "00000000-0000-4000-8000-000000000456",
      requestHash: "f".repeat(64), replayed: false,
    },
  ]) {
    await assert.rejects(() => AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.canvas.arrange"](
      input,
      { identity: IDENTITY, environment: ENVIRONMENT, fetchImpl: async () => jsonResponse(receipt) },
    ), /mutation receipt/u)
  }

  await assert.rejects(() => AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.canvas.arrange"](
    input,
    {
      identity: IDENTITY, environment: ENVIRONMENT,
      fetchImpl: async () => jsonResponse({ padding: "x".repeat(5_000) }),
    },
  ), (error) => error.code === "provider_response_too_large")
})

test("canvas.arrange preflights every placed reference before mutating", async () => {
  const canvasId = "00000000-0000-4000-8000-000000000123"
  const requestedRef = createGalaxyObjectReference("paper", "not-readable")
  let calls = 0
  await assert.rejects(() => AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.canvas.arrange"]({
    canvasId, expectedVersion: 4, expectedContentHash: `sha256:${"a".repeat(64)}`,
    idempotencyKey: "arrange-operation-1",
    commands: [{ type: "item.place", item: { subjectRef: requestedRef } }],
  }, {
    identity: IDENTITY,
    environment: ENVIRONMENT,
    fetchImpl: async (_url, init) => {
      calls += 1
      assert.equal(init.method, "POST")
      assert.deepEqual(JSON.parse(init.body).references, [requestedRef])
      return jsonResponse({
        schemaId: "gb.object-projection-source-response.v3",
        results: [{ requestedRef, status: "unavailable" }],
      })
    },
  }), (error) => {
    assert.equal(error.code, "not_found")
    assert.equal(error.status, 404)
    return true
  })
  assert.equal(calls, 1)
})

test("passive repository fields never read a workspace or expose a claimable frontier", async () => {
  const fixture = proofFixture("repository-field")
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return new Response(fixture.bytes, { status: 200, headers: { "Content-Type": "application/json" } })
  }
  const output = await AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.proof.frontier.get"]({
    graphRef: { graphId: "mission-1", contentSha256: fixture.digest },
    workspaceId: "should-not-be-read",
    cursor: null,
    limit: 50,
  }, { identity: IDENTITY, environment: ENVIRONMENT, fetchImpl })
  assert.equal(calls, 1)
  assert.equal(output.result.graphKind, "repository-field")
  assert.equal(output.result.coordinationActive, false)
  assert.equal(output.result.claimable, false)
  assert.deepEqual(output.result.items, [])
})

test("active frontier is exact-hash bound and returns only derived available nodes", async () => {
  const fixture = proofFixture("mission")
  const workspaceId = "mission-1-work"
  const fetchImpl = async (url) => {
    const parsed = new URL(url)
    if (parsed.pathname === `/proof-graphs/${fixture.digest}`) {
      return new Response(fixture.bytes, { status: 200, headers: { "Content-Type": "application/json" } })
    }
    assert.equal(parsed.pathname, `/proof-workspaces/${workspaceId}`)
    assert.equal(parsed.searchParams.get("graph_id"), "mission-1")
    assert.equal(parsed.searchParams.get("content_sha256"), fixture.digest)
    return jsonResponse({
      schema_id: "galaxy.proof-work-state.v1",
      workspace_id: workspaceId,
      graph_ref: { graph_id: "mission-1", content_sha256: fixture.digest },
      version: 3,
      updated_at: "2026-09-24T12:00:00Z",
      items: [],
    })
  }
  const output = await AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.proof.frontier.get"]({
    graphRef: { graphId: "mission-1", contentSha256: fixture.digest },
    workspaceId,
    cursor: null,
    limit: 50,
  }, { identity: IDENTITY, environment: ENVIRONMENT, fetchImpl })
  assert.equal(output.result.coordinationActive, true)
  assert.equal(output.result.claimable, true)
  assert.deepEqual(output.result.items.map((item) => item.nodeId), ["foundation"])
  assert.equal(output.result.items[0].state, "available")
})

test("proof.claim hash-verifies the mission and posts one exact Nostr-attributed lease transition", async () => {
  const fixture = proofFixture("mission")
  const input = {
    graphRef: { graphId: "mission-1", contentSha256: fixture.digest },
    workspaceId: "mission-1-work",
    nodeId: "foundation",
    expectedVersion: 3,
    expectedItemVersion: 0,
    action: "acquire",
    leaseSeconds: 900,
    idempotencyKey: "claim-foundation-1",
  }
  const observed = []
  const output = await AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.proof.claim"](input, {
    identity: IDENTITY,
    environment: ENVIRONMENT,
    fetchImpl: async (url, init) => {
      observed.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null })
      if (init.method === "GET") {
        return new Response(fixture.bytes, { status: 200, headers: { "Content-Type": "application/json" } })
      }
      return jsonResponse(proofWorkState({ fixture }))
    },
  })
  assert.equal(observed.length, 2)
  assert.equal(observed[0].url, `https://galaxy-api.test/proof-graphs/${fixture.digest}`)
  assert.equal(observed[1].url, "https://galaxy-api.test/proof-workspaces/mission-1-work/transitions")
  assert.equal(observed[1].init.method, "POST")
  assert.equal(observed[1].init.headers.get("X-GB-Nostr-Pubkey"), IDENTITY.nostrPubkey)
  assert.equal(observed[1].init.headers.get("X-GB-Agent-Tool-Gateway"), "v1")
  assert.deepEqual(observed[1].body, {
    graph_ref: { graph_id: "mission-1", content_sha256: fixture.digest },
    node_id: "foundation",
    expected_version: 3,
    expected_item_version: 0,
    transition: { type: "claim.acquire", payload: { lease_seconds: 900 } },
    idempotency_key: "claim-foundation-1",
  })
  assert.deepEqual(output.result, {
    schemaId: "gb.proof-claim-current-state.v1",
    graphRef: input.graphRef,
    workspaceId: "mission-1-work",
    nodeId: "foundation",
    action: "acquire",
    workspaceVersion: 4,
    itemVersion: 1,
    workStatus: "claimed",
    claim: {
      claimId: "00000000-0000-4000-8000-000000000456",
      claimedAt: output.result.claim.claimedAt,
      expiresAt: output.result.claim.expiresAt,
      ownedByCaller: true,
    },
    replayed: false,
  })
  assert.equal(Object.hasOwn(output.result.claim, "nostrPubkey"), false)
})

test("proof.claim maps release separately and rejects passive graphs before mutation", async () => {
  const mission = proofFixture("mission")
  const release = {
    graphRef: { graphId: "mission-1", contentSha256: mission.digest },
    workspaceId: "mission-1-work", nodeId: "foundation",
    expectedVersion: 4, expectedItemVersion: 1,
    action: "release", idempotencyKey: "release-foundation-1",
  }
  let postedBody
  const output = await AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.proof.claim"](release, {
    identity: IDENTITY, environment: ENVIRONMENT,
    fetchImpl: async (_url, init) => {
      if (init.method === "GET") {
        return new Response(mission.bytes, { status: 200, headers: { "Content-Type": "application/json" } })
      }
      postedBody = JSON.parse(init.body)
      return jsonResponse(proofWorkState({
        fixture: mission, version: 5, itemVersion: 2, status: "idle", claim: null,
      }))
    },
  })
  assert.deepEqual(postedBody.transition, { type: "claim.release", payload: {} })
  assert.equal(output.result.claim, null)
  assert.equal(output.result.workStatus, "idle")

  const passive = proofFixture("repository-field")
  let calls = 0
  await assert.rejects(() => AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.proof.claim"]({
    ...release,
    graphRef: { graphId: "mission-1", contentSha256: passive.digest },
  }, {
    identity: IDENTITY, environment: ENVIRONMENT,
    fetchImpl: async () => {
      calls += 1
      return new Response(passive.bytes, { status: 200, headers: { "Content-Type": "application/json" } })
    },
  }), (error) => error.code === "inactive_proof_graph" && error.status === 409)
  assert.equal(calls, 1)
})

test("proof.claim does not misreport a superseded idempotent replay", async () => {
  const fixture = proofFixture("mission")
  await assert.rejects(() => AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.proof.claim"]({
    graphRef: { graphId: "mission-1", contentSha256: fixture.digest },
    workspaceId: "mission-1-work", nodeId: "foundation",
    expectedVersion: 3, expectedItemVersion: 0,
    action: "acquire", leaseSeconds: 900, idempotencyKey: "claim-foundation-1",
  }, {
    identity: IDENTITY, environment: ENVIRONMENT,
    fetchImpl: async (_url, init) => init.method === "GET"
      ? new Response(fixture.bytes, { status: 200, headers: { "Content-Type": "application/json" } })
      : jsonResponse(proofWorkState({
          fixture, version: 6, itemVersion: 2, status: "idle", claim: null, replayed: true,
        })),
  }), (error) => error.code === "replay_superseded" && error.status === 409)
})

test("proof.claim rejects a provider claim attributed to another identity", async () => {
  const fixture = proofFixture("mission")
  await assert.rejects(() => AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.proof.claim"]({
    graphRef: { graphId: "mission-1", contentSha256: fixture.digest },
    workspaceId: "mission-1-work", nodeId: "foundation",
    expectedVersion: 3, expectedItemVersion: 0,
    action: "acquire", leaseSeconds: 900, idempotencyKey: "claim-foundation-1",
  }, {
    identity: IDENTITY, environment: ENVIRONMENT,
    fetchImpl: async (_url, init) => init.method === "GET"
      ? new Response(fixture.bytes, { status: 200, headers: { "Content-Type": "application/json" } })
      : jsonResponse(proofWorkState({
          fixture,
          claim: {
            claim_id: "00000000-0000-4000-8000-000000000456",
            nostr_pubkey: "e".repeat(64),
            claimed_at: new Date(Date.now() - 60_000).toISOString(),
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
        })),
  }), (error) => error.code === "invalid_provider_response" && error.status === 502)
})

test("proof.claim binds acquire results to the exact requested lease duration", async () => {
  const fixture = proofFixture("mission")
  const claimedAt = new Date(Date.now() - 60_000)
  await assert.rejects(() => AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.proof.claim"]({
    graphRef: { graphId: "mission-1", contentSha256: fixture.digest },
    workspaceId: "mission-1-work", nodeId: "foundation",
    expectedVersion: 3, expectedItemVersion: 0,
    action: "acquire", leaseSeconds: 900, idempotencyKey: "claim-foundation-1",
  }, {
    identity: IDENTITY, environment: ENVIRONMENT,
    fetchImpl: async (_url, init) => init.method === "GET"
      ? new Response(fixture.bytes, { status: 200, headers: { "Content-Type": "application/json" } })
      : jsonResponse(proofWorkState({
          fixture,
          claim: {
            claim_id: "00000000-0000-4000-8000-000000000456",
            nostr_pubkey: IDENTITY.nostrPubkey,
            claimed_at: claimedAt.toISOString(),
            expires_at: new Date(claimedAt.getTime() + 901_000).toISOString(),
          },
        })),
  }), (error) => error.code === "invalid_provider_response" && error.status === 502)
})

test("proof.claim rejects impossible release poststates", async () => {
  const fixture = proofFixture("mission")
  await assert.rejects(() => AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.proof.claim"]({
    graphRef: { graphId: "mission-1", contentSha256: fixture.digest },
    workspaceId: "mission-1-work", nodeId: "foundation",
    expectedVersion: 4, expectedItemVersion: 1,
    action: "release", idempotencyKey: "release-foundation-1",
  }, {
    identity: IDENTITY, environment: ENVIRONMENT,
    fetchImpl: async (_url, init) => init.method === "GET"
      ? new Response(fixture.bytes, { status: 200, headers: { "Content-Type": "application/json" } })
      : jsonResponse({
          ...proofWorkState({ fixture, version: 5, itemVersion: 2, status: "idle", claim: null }),
          items: [{
            node_id: "foundation", version: 2,
            work: {
              status: "running", claim: null, blocker: "", task_id: "", linked_task_count: 0,
              hyades: { workflow_id: "proof-workflow-v1", run_id: "run-1", status: "running" },
            },
            proof: { status: "open", candidate_sha256: null, verification: null },
            external: {},
          }],
        }),
  }), (error) => error.code === "invalid_provider_response" && error.status === 502)
})

test("proof.claim rejects a missing Nostr actor before provider access", async () => {
  const fixture = proofFixture("mission")
  let calls = 0
  await assert.rejects(() => AGENT_MUTATION_TOOL_IMPLEMENTATIONS["builtin.proof.claim"]({
    graphRef: { graphId: "mission-1", contentSha256: fixture.digest },
    workspaceId: "mission-1-work", nodeId: "foundation",
    expectedVersion: 3, expectedItemVersion: 0,
    action: "acquire", leaseSeconds: 900, idempotencyKey: "claim-foundation-1",
  }, {
    identity: { ...IDENTITY, nostrPubkey: null },
    environment: ENVIRONMENT,
    fetchImpl: async () => {
      calls += 1
      return jsonResponse({})
    },
  }), (error) => error.code === "forbidden" && error.status === 403)
  assert.equal(calls, 0)
})

test("proof.graph.get pages the immutable structure without reading work state", async () => {
  const fixture = proofFixture("mission")
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return new Response(fixture.bytes, { status: 200, headers: { "Content-Type": "application/json" } })
  }
  const output = await AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.proof.graph.get"]({
    graphRef: { graphId: "mission-1", contentSha256: fixture.digest },
    cursor: null,
    limit: 10,
  }, { identity: IDENTITY, environment: ENVIRONMENT, fetchImpl })
  assert.equal(calls, 1)
  assert.equal(output.result.graphKind, "mission")
  assert.equal(output.result.graphInput.proofContexts[0].coordinationActive, false)
  assert.equal(output.result.graphInput.proofContexts[0].nodeStates.length, 0)

  await assert.rejects(() => AGENT_READ_TOOL_IMPLEMENTATIONS["builtin.proof.graph.get"]({
    graphRef: { graphId: "mission-1", contentSha256: fixture.digest },
    cursor: `pgs1:${"0".repeat(32)}:0:0`,
    limit: 10,
  }, { identity: IDENTITY, environment: ENVIRONMENT, fetchImpl }), (error) => {
    assert.equal(error.code, "invalid_cursor")
    assert.equal(error.status, 409)
    return true
  })
})

test("the route derives identity server-side and exposes POST only", async () => {
  const source = await readFile(new URL("../app/api/agent-tools/[tool]/route.ts", import.meta.url), "utf8")
  assert.match(source, /getRequestIdentity\(request, rawBody\)/)
  assert.match(source, /getVerifiedNostrRequestIdentity\(request, rawBody\)/)
  assert.match(source, /isAgentMutationTool\(tool\)/)
  assert.match(source, /dispatchAgentToolGateway\(input, identity, tool\)/)
  assert.doesNotMatch(source, /request\.headers\.get\(["']X-GB-(?:Tenant|Principal)/)
  assert.doesNotMatch(source, /export async function (?:GET|PATCH|PUT|DELETE)/)
})
