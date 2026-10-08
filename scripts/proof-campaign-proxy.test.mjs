import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  createProofCampaignDispatchBody,
  fillMissingProofCampaignSequenceIndexes,
  parseDirectiveSha256,
  parseProofCampaignManifest,
  parseProgramId,
  PROOF_CAMPAIGN_MANIFEST_MAX_BYTES,
  PROOF_CAMPAIGN_UPSTREAM_RESPONSE_MAX_BYTES,
  ProofCampaignContractError,
  readProofCampaignJsonBody,
  readProofCampaignResponseText,
} from "../lib/proof-campaign-contract.js"
import { projectProofCampaignResponseForBrowser } from "../lib/proof-campaign-browser-projection.js"
import {
  evaluateProofCampaignAccess,
  evaluateProofCampaignMutationAuthority,
  resolveProofCampaignProxyConfig,
} from "../lib/proof-campaign-proxy-config.js"
import {
  getProofCampaignProxyRoute,
  PROOF_CAMPAIGN_PROXY_OPERATIONS,
} from "../lib/proof-campaign-proxy-policy.js"

const TENANT_ID = "10000000-0000-4000-8000-000000000001"
const SHA = "a".repeat(64)
const NOW = Date.parse("2026-09-09T12:00:00Z")

test("proof campaign routes are a closed allowlist without directive ingress", () => {
  assert.deepEqual(Object.keys(PROOF_CAMPAIGN_PROXY_OPERATIONS).sort(), [
    "dispatch", "preview", "register", "registration", "status",
  ])
  assert.deepEqual(getProofCampaignProxyRoute("preview", {
    hyadesTenant: "example-tenant",
    programId: "proof-smoke-v1",
  }), {
    method: "POST",
    mutates: false,
    path: "/admin/ham/programs/example-tenant/proof-smoke-v1/preview",
  })
  assert.throws(() => getProofCampaignProxyRoute("directives", {
    hyadesTenant: "example-tenant",
    programId: "proof-smoke-v1",
  }), /not allowed/)
  assert.throws(() => getProofCampaignProxyRoute("toString", {
    hyadesTenant: "example-tenant",
    programId: "proof-smoke-v1",
  }), /not allowed/)
})

test("campaign access is tenant-bound and limited to owners and admins", () => {
  const environment = { PROOF_CAMPAIGN_GALAXY_TENANT_ID: TENANT_ID }
  assert.deepEqual(evaluateProofCampaignAccess({ tenantId: TENANT_ID, role: "admin" }, environment), { allowed: true })
  assert.equal(evaluateProofCampaignAccess({ tenantId: TENANT_ID, role: "member" }, environment).status, 403)
  assert.equal(evaluateProofCampaignAccess({ tenantId: "20000000-0000-4000-8000-000000000002", role: "owner" }, environment).status, 403)
  assert.equal(evaluateProofCampaignAccess({ tenantId: TENANT_ID, role: "owner" }, {}).status, 503)
})

test("campaign mutations require the expected origin and recent authentication", () => {
  const user = { authenticatedAt: "2026-09-09T11:50:00Z" }
  const environment = {
    AUTH_ORIGIN: "https://galaxy.example/",
    PROOF_CAMPAIGN_MAX_SESSION_AGE_MINUTES: "15",
  }
  assert.deepEqual(evaluateProofCampaignMutationAuthority(
    user,
    "https://galaxy.example/api/proof-campaigns/a/register",
    "https://galaxy.example",
    environment,
    NOW,
  ), { allowed: true })
  assert.equal(evaluateProofCampaignMutationAuthority(
    user,
    "https://galaxy.example/api/proof-campaigns/a/register",
    "https://attacker.example",
    environment,
    NOW,
  ).status, 403)
  assert.match(evaluateProofCampaignMutationAuthority(
    { authenticatedAt: "2026-09-09T11:30:00Z" },
    "https://galaxy.example/api/proof-campaigns/a/register",
    "https://galaxy.example",
    environment,
    NOW,
  ).message, /recent authentication/)
})

test("campaign config has a dedicated server-only operator credential", () => {
  assert.equal(resolveProofCampaignProxyConfig({
    HAM_ADMIN_API_BEARER_TOKEN: "broad-secret",
    HYADES_PROGRAM_CONTROL_API_INTERNAL: "https://hyades.internal",
    HYADES_PROGRAM_TENANT: "example-tenant",
    HYADES_PROGRAM_HAM_PROJECT: "lean-proof-sandbox",
  }), null)
  assert.deepEqual(resolveProofCampaignProxyConfig({
    HYADES_PROGRAM_CONTROL_API_INTERNAL: "https://hyades.internal/",
    HYADES_PROGRAM_OPERATOR_BEARER_TOKEN: "proof-operator",
    HYADES_PROGRAM_TENANT: "example-tenant",
    HYADES_PROGRAM_HAM_PROJECT: "lean-proof-sandbox",
  }), {
    baseUrl: "https://hyades.internal",
    bearerToken: "proof-operator",
    hyadesTenant: "example-tenant",
    hamProject: "lean-proof-sandbox",
  })
})

test("manifest boundary admits only v3 objects and exact route-safe IDs", () => {
  const manifest = { schema_id: "ham.audit-program.v3", program_id: "proof-smoke-v1", packets: [{}] }
  assert.equal(parseProofCampaignManifest(manifest), manifest)
  assert.equal(parseProofCampaignManifest({ ...manifest, program_id: "winding:prototime" }).program_id, "winding:prototime")
  assert.equal(parseProgramId("winding:prototime"), "winding:prototime")
  assert.throws(() => parseProofCampaignManifest({ ...manifest, schema_id: "ham.audit-program.v2" }), /v3/)
  assert.throws(() => parseProofCampaignManifest({ ...manifest, program_id: "proof/smoke" }), /program_id/)
  assert.throws(
    () => parseProofCampaignManifest({ ...manifest, packets: [{ objective: "x".repeat(PROOF_CAMPAIGN_MANIFEST_MAX_BYTES) }] }),
    (error) => error instanceof ProofCampaignContractError && error.status === 413,
  )
})

test("the campaign form supplies missing one-based packet display indexes without rewriting explicit values", () => {
  const manifest = {
    schema_id: "ham.audit-program.v3",
    program_id: "proof-smoke-v1",
    packets: [
      { packet_id: "P01", title: "First" },
      { packet_id: "P02", title: "Second", sequence_index: 2 },
    ],
  }
  const normalized = fillMissingProofCampaignSequenceIndexes(manifest)
  assert.notEqual(normalized, manifest)
  assert.deepEqual(normalized.packets.map((packet) => packet.sequence_index), [1, 2])
  assert.equal(Object.hasOwn(manifest.packets[0], "sequence_index"), false)
  assert.equal(fillMissingProofCampaignSequenceIndexes(normalized), normalized)
})

test("campaign request JSON is rejected precisely before oversized bodies are fully buffered", async () => {
  assert.deepEqual(await readProofCampaignJsonBody(new Request("https://galaxy.example/api", {
    method: "POST",
    body: '{"schema_id":"ham.audit-program.v3"}',
  })), { schema_id: "ham.audit-program.v3" })
  await assert.rejects(
    readProofCampaignJsonBody(new Request("https://galaxy.example/api", { method: "POST", body: "{" })),
    (error) => error instanceof ProofCampaignContractError && error.status === 400,
  )
  await assert.rejects(
    readProofCampaignJsonBody(new Request("https://galaxy.example/api", {
      method: "POST",
      headers: { "Content-Length": String(PROOF_CAMPAIGN_MANIFEST_MAX_BYTES + 1) },
      body: "{}",
    })),
    (error) => error instanceof ProofCampaignContractError && error.status === 413,
  )
  await assert.rejects(
    readProofCampaignJsonBody(new Request("https://galaxy.example/api", {
      method: "POST",
      body: `{"value":"${"x".repeat(PROOF_CAMPAIGN_MANIFEST_MAX_BYTES)}"}`,
    })),
    (error) => error instanceof ProofCampaignContractError && error.status === 413,
  )
})

test("Hyades response bodies are capped before they are fully buffered", async () => {
  assert.equal(await readProofCampaignResponseText(new Response('{"ok":true}')), '{"ok":true}')
  await assert.rejects(
    readProofCampaignResponseText(new Response("{}", {
      headers: { "Content-Length": String(PROOF_CAMPAIGN_UPSTREAM_RESPONSE_MAX_BYTES + 1) },
    })),
    (error) => error instanceof ProofCampaignContractError && error.status === 502,
  )
  await assert.rejects(
    readProofCampaignResponseText(new Response("x".repeat(PROOF_CAMPAIGN_UPSTREAM_RESPONSE_MAX_BYTES + 1))),
    (error) => error instanceof ProofCampaignContractError && error.status === 502,
  )
})

test("proof campaign responses expose only the browser contract", () => {
  const registration = {
    registrationId: "private-registration-id",
    programId: "proof-smoke-v1",
    programSha256: SHA,
    progressSha256: "b".repeat(64),
    directiveSha256: "c".repeat(64),
    source: "private-service-principal",
    registeredAt: "2026-09-09T12:00:00Z",
    readyPacketIds: ["packet-a"],
    immutable: true,
    authorityGranted: false,
    sideEffectsAuthorized: false,
  }
  const dispatch = {
    dispatchId: "program-dispatch:current",
    programId: "proof-smoke-v1",
    directiveSha256: "c".repeat(64),
    grantSha256: "d".repeat(64),
    project: "private-ham-project",
    grantorRef: "private-service-principal",
    authorizedAt: "2026-09-09T12:01:00Z",
    state: "partial",
    tasks: [{
      packetId: "packet-a",
      action: "prove",
      assignmentSha256: "e".repeat(64),
      idempotencyKey: "private-idempotency-key",
      state: "failed",
      error: "private downstream detail",
    }],
  }
  const projected = projectProofCampaignResponseForBrowser("status", {
    tenant: "private-hyades-tenant",
    programId: "proof-smoke-v1",
    currentDirectiveSha256: "c".repeat(64),
    currentProgramSha256: SHA,
    currentProgressSha256: "b".repeat(64),
    currentDecision: "dispatch_frontier",
    receiptCount: 100,
    receipts: [{ source: "private-history" }],
    currentTargets: [{ packetId: "packet-a", action: "prove", rosettaNodeIds: ["private-node"] }],
    dispatches: [{ ...dispatch, directiveSha256: "f".repeat(64) }, dispatch],
    registration,
  })
  assert.deepEqual(projected, {
    programId: "proof-smoke-v1",
    currentDirectiveSha256: "c".repeat(64),
    currentDecision: "dispatch_frontier",
    currentTargets: [{ packetId: "packet-a", action: "prove" }],
    dispatches: [{
      dispatchId: "program-dispatch:current",
      directiveSha256: "c".repeat(64),
      state: "partial",
      tasks: [{ packetId: "packet-a", state: "failed" }],
    }],
    registration: {
      programId: "proof-smoke-v1",
      programSha256: SHA,
      progressSha256: "b".repeat(64),
      directiveSha256: "c".repeat(64),
      registeredAt: "2026-09-09T12:00:00Z",
      readyPacketIds: ["packet-a"],
      immutable: true,
      authorityGranted: false,
      sideEffectsAuthorized: false,
    },
  })
  const serialized = JSON.stringify(projected)
  assert.doesNotMatch(serialized, /private|grantSha256|idempotencyKey|assignmentSha256|receipts/)
  assert.doesNotMatch(
    JSON.stringify(projectProofCampaignResponseForBrowser("dispatch", { receipt: dispatch })),
    /private|project|grant|idempotency|assignment|error/i,
  )
  assert.doesNotMatch(
    JSON.stringify(projectProofCampaignResponseForBrowser("register", { receipt: registration })),
    /private|registrationId|source/,
  )
  assert.equal(projectProofCampaignResponseForBrowser("status", {
    programId: "winding:prototime",
    currentDecision: "wait",
    currentTargets: [],
    dispatches: [],
  }).programId, "winding:prototime")

  assert.deepEqual(projectProofCampaignResponseForBrowser("preview", {
    preview: {
      schemaId: "private-upstream-schema",
      programId: "proof-smoke-v1",
      programSha256: SHA,
      progressSha256: "b".repeat(64),
      directiveSha256: "c".repeat(64),
      readyPacketIds: ["packet-a"],
      authorityGranted: false,
      sideEffectsAuthorized: false,
      directive: {
        decision: "dispatch_frontier",
        targets: [{ packet_id: "packet-a", action: "prove", private: "secret" }],
        private: "secret",
      },
      private: "secret",
    },
  }), {
    preview: {
      programId: "proof-smoke-v1",
      programSha256: SHA,
      progressSha256: "b".repeat(64),
      directiveSha256: "c".repeat(64),
      readyPacketIds: ["packet-a"],
      authorityGranted: false,
      sideEffectsAuthorized: false,
      directive: { decision: "dispatch_frontier", targets: [{ packetId: "packet-a", action: "prove" }] },
    },
  })
})

test("dispatch injects the server-bound project and requires exact confirmation", () => {
  assert.deepEqual(createProofCampaignDispatchBody({
    expectedDirectiveSha256: SHA,
    confirmProgramId: "proof-smoke-v1",
    project: "attacker-project",
    explicitAuthority: false,
  }, "proof-smoke-v1", "lean-proof-sandbox"), {
    expectedDirectiveSha256: SHA,
    project: "lean-proof-sandbox",
    explicitAuthority: true,
  })
  assert.equal(parseDirectiveSha256(SHA), SHA)
  assert.throws(() => createProofCampaignDispatchBody({
    expectedDirectiveSha256: SHA,
    confirmProgramId: "another-program",
  }, "proof-smoke-v1", "lean-proof-sandbox"), /exactly match/)
})

test("the launcher only materializes through exact-directive Hyades dispatch", async () => {
  const launcher = await readFile(new URL("../components/tasks/proof-campaign-launcher.tsx", import.meta.url), "utf8")
  const retiredRoute = await readFile(new URL("../app/api/proof-tasks/route.ts", import.meta.url), "utf8")
  assert.match(launcher, /dispatchProofCampaign\(programId, currentDirectiveSha256\)/)
  assert.match(launcher, /authoritative HAM v3 compiler and Hyades controller path/)
  assert.doesNotMatch(launcher, /createProofTask|publishReadyTasks|\/api\/proof-tasks/)
  assert.match(retiredRoute, /status: 410/)
  assert.doesNotMatch(retiredRoute, /fetchHamTask|\/tasks/)
})

test("the browser never receives the operator token or downstream project selector", async () => {
  const client = await readFile(new URL("../lib/proof-campaign-client.ts", import.meta.url), "utf8")
  const launcher = await readFile(new URL("../components/tasks/proof-campaign-launcher.tsx", import.meta.url), "utf8")
  const route = await readFile(new URL("../app/api/proof-campaigns/[programId]/[operation]/route.ts", import.meta.url), "utf8")
  const proxy = await readFile(new URL("../lib/proof-campaign-proxy.ts", import.meta.url), "utf8")
  const browserText = `${client}\n${launcher}`
  assert.doesNotMatch(browserText, /OPERATOR_BEARER_TOKEN|HYADES_PROGRAM_HAM_PROJECT|Authorization:/)
  assert.doesNotMatch(client, /explicitAuthority/)
  assert.match(route, /if \(policy\.mutates\) assertProofCampaignMutationAuthority\(request, user\)/)
  assert.doesNotMatch(route, /request\.json\(\)/)
  assert.match(launcher, /receipt\.state === "dispatched"/)
  assert.match(launcher, /Latest dispatch receipt:/)
  assert.match(launcher, /requestId !== previewRequestId\.current/)
  assert.match(launcher, /current === "load"/)
  assert.match(launcher, /disabled=\{Boolean\(busy\)\}/)
  assert.match(proxy, /readProofCampaignResponseText\(response\)/)
  assert.match(proxy, /projectProofCampaignResponseForBrowser\(operation, responseBody\)/)
  assert.doesNotMatch(proxy, /return responseBody/)
})
