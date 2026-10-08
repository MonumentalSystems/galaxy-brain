import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  collectHamAdminPages,
  getHamAdminReadRoutes,
  HAM_ADMIN_MUTATIONS,
  isFreshAuthentication,
  isPrincipalExpired,
  parseHamAdminMutation,
} from "../lib/ham-admin-contract.js"
import { evaluateHamAdminAccess } from "../lib/ham-admin-access.js"

const NOW = Date.parse("2026-08-18T12:00:00Z")
const OWNER_PUBKEY = "a".repeat(64)
const AGENT_PUBKEY = "b".repeat(64)

test("admin reads and mutations are a closed Nostr-principal allowlist", () => {
  assert.deepEqual(HAM_ADMIN_MUTATIONS, [
    "createProject",
    "registerCurrentPrincipal",
    "registerAgentPrincipal",
    "createMember",
    "revokePrincipal",
    "revokeMember",
    "createCredential",
    "revokeCredential",
  ])
  assert.deepEqual(getHamAdminReadRoutes(), [
    { key: "identity", path: "/whoami" },
    { key: "projects", path: "/projects?limit=500&offset=0" },
    { key: "principals", path: "/admin/nostr-principals?limit=500&offset=0" },
    { key: "credentials", path: "/admin/credentials" },
  ])
  assert.equal(
    getHamAdminReadRoutes(["c".repeat(32)], 500)[4].path,
    `/admin/projects/${"c".repeat(32)}/members?limit=500&offset=500`,
  )
  assert.throws(() => parseHamAdminMutation({ action: "arbitraryRequest", path: "/memories" }), /not allowed/)
  assert.throws(() => getHamAdminReadRoutes(["../../principals"]), /Project ID is invalid/)
})

test("principal inventory pagination is complete and fails closed when offsets do not advance", async () => {
  const pages = [
    [{ pubkey: "a" }, { pubkey: "b" }],
    [{ pubkey: "c" }],
  ]
  const calls = []
  const rows = await collectHamAdminPages(async (offset, limit) => {
    calls.push({ offset, limit })
    return pages.shift()
  }, "pubkey", { pageSize: 2, maxPages: 3 })
  assert.deepEqual(rows.map((row) => row.pubkey), ["a", "b", "c"])
  assert.deepEqual(calls, [{ offset: 0, limit: 2 }, { offset: 2, limit: 2 }])
  await assert.rejects(
    collectHamAdminPages(async () => [{ pubkey: "same" }], "pubkey", { pageSize: 1, maxPages: 2 }),
    /did not advance/,
  )
})

test("project creation is organizational and carries no role", () => {
  const mutation = parseHamAdminMutation({
    action: "createProject",
    name: "AI Model",
    slug: "ai-model",
    repo: "alextitonis/ai-model",
    description: "Topic organization",
  }, NOW)
  assert.deepEqual(mutation.body, {
    name: "AI Model",
    slug: "ai-model",
    repo: "alextitonis/ai-model",
    description: "Topic organization",
  })
  assert.doesNotMatch(JSON.stringify(mutation), /observer|publisher|executor|task_access/)
})

test("the current human principal comes only from the signed-in Nostr session", () => {
  const mutation = parseHamAdminMutation(
    { action: "registerCurrentPrincipal", pubkey: "f".repeat(64) },
    NOW,
    { currentNostrPubkey: OWNER_PUBKEY },
  )
  assert.deepEqual(mutation, {
    action: "registerCurrentPrincipal",
    method: "POST",
    path: "/admin/nostr-principals",
    body: {
      pubkey: OWNER_PUBKEY,
      label: "Galaxy Brain owner",
    },
  })
  assert.throws(
    () => parseHamAdminMutation({ action: "registerCurrentPrincipal" }, NOW),
    /Signed-in Nostr public key/,
  )
})

test("agent registration accepts only a public key and simple identity metadata", () => {
  const mutation = parseHamAdminMutation({
    action: "registerAgentPrincipal",
    pubkey: AGENT_PUBKEY,
    durationDays: 30,
    label: "Research harness",
  }, NOW)
  assert.deepEqual(mutation, {
    action: "registerAgentPrincipal",
    method: "POST",
    path: "/admin/nostr-principals",
    body: {
      pubkey: AGENT_PUBKEY,
      label: "Research harness",
      expires_at: "2026-09-17T12:00:00.000Z",
    },
  })
  assert.doesNotMatch(JSON.stringify(mutation), /nsec|secret|task_access/)
  assert.throws(
    () => parseHamAdminMutation({
      action: "registerAgentPrincipal",
      pubkey: "agent-name",
      actorType: "service",
      durationDays: 30,
    }, NOW),
    /64 lowercase hexadecimal/,
  )
})

test("project membership associates a pubkey and never grants a task role", () => {
  const projectId = "c".repeat(32)
  const mutation = parseHamAdminMutation({
    action: "createMember",
    projectId,
    pubkey: AGENT_PUBKEY,
    taskAccess: "executor",
  })
  assert.deepEqual(mutation, {
    action: "createMember",
    method: "POST",
    path: `/admin/projects/${projectId}/members`,
    body: { pubkey: AGENT_PUBKEY },
  })
  assert.doesNotMatch(JSON.stringify(mutation), /executor|task_access/)
})

test("principal revocation and membership removal validate exact identifiers", () => {
  const projectId = "c".repeat(32)
  const membershipId = "d".repeat(32)
  assert.deepEqual(parseHamAdminMutation({ action: "revokePrincipal", pubkey: AGENT_PUBKEY }), {
    action: "revokePrincipal",
    method: "DELETE",
    path: `/admin/nostr-principals/${AGENT_PUBKEY}`,
    body: null,
  })
  assert.deepEqual(parseHamAdminMutation({ action: "revokeMember", projectId, membershipId }), {
    action: "revokeMember",
    method: "DELETE",
    path: `/admin/projects/${projectId}/members/${membershipId}`,
    body: null,
  })
  assert.equal(isPrincipalExpired("2026-08-18T12:00:00Z", NOW), true)
  assert.equal(isPrincipalExpired(null, NOW), false)
})

test("principal mutations require a recent authentication", () => {
  assert.equal(isFreshAuthentication("2026-08-18T11:50:00Z", NOW, 15), true)
  assert.equal(isFreshAuthentication("2026-08-18T11:44:59Z", NOW, 15), false)
  assert.equal(isFreshAuthentication("invalid", NOW, 15), false)
})

test("HAM administration is bound to one exact Nostr-authenticated Galaxy owner", () => {
  const environment = {
    HAM_ADMIN_GALAXY_TENANT_ID: "00000000-0000-4000-8000-000000000001",
    HAM_ADMIN_GALAXY_PRINCIPAL_ID: "00000000-0000-4000-8000-000000000002",
    HAM_ADMIN_OWNER_NOSTR_PUBKEY: OWNER_PUBKEY,
  }
  const owner = {
    tenantId: environment.HAM_ADMIN_GALAXY_TENANT_ID,
    principalId: environment.HAM_ADMIN_GALAXY_PRINCIPAL_ID,
    principalKind: "human",
    role: "owner",
    authMethod: "nostr",
    nostrPubkey: OWNER_PUBKEY,
  }
  assert.equal(evaluateHamAdminAccess(owner, environment).allowed, true)
  for (const denied of [
    { ...owner, role: "member" },
    { ...owner, tenantId: "00000000-0000-4000-8000-000000000003" },
    { ...owner, principalId: "00000000-0000-4000-8000-000000000004" },
    { ...owner, authMethod: "passkey" },
    { ...owner, nostrPubkey: "f".repeat(64) },
  ]) {
    assert.equal(evaluateHamAdminAccess(denied, environment).allowed, false)
  }
  assert.equal(evaluateHamAdminAccess(owner, {}).status, 503)
})

test("the owner BFF keeps bootstrap authority server-side and passes trusted Nostr context", async () => {
  const [route, proxy, auth, env, compose] = await Promise.all([
    readFile(new URL("../app/api/admin/ham/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ham-admin-proxy.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../docker-compose.yml", import.meta.url), "utf8"),
  ])
  assert.match(route, /currentNostrPubkey: user.nostrPubkey/)
  assert.match(route, /assertSameOrigin\(request\)/)
  assert.match(proxy, /HAM_ADMIN_API_BEARER_TOKEN/)
  assert.match(proxy, /galaxyIdentity/)
  assert.match(proxy, /MEMBER_FETCH_CONCURRENCY = 6/)
  assert.doesNotMatch(route, /HAM_ADMIN_API_BEARER_TOKEN/)
  assert.match(auth, /authMethod/)
  assert.match(auth, /nostrPubkey/)
  assert.match(env, /^HAM_ADMIN_OWNER_NOSTR_PUBKEY=$/m)
  assert.match(compose, /HAM_ADMIN_OWNER_NOSTR_PUBKEY: \$\{HAM_ADMIN_OWNER_NOSTR_PUBKEY:-\}/)
  assert.doesNotMatch(env, /NEXT_PUBLIC_HAM_ADMIN/)
})

test("the owner UI is Nostr-first and describes project membership as organization", async () => {
  const [page, authForm, alternative] = await Promise.all([
    readFile(new URL("../components/ham-admin-settings.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/auth-form.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/alternative-sign-in.tsx", import.meta.url), "utf8"),
  ])
  assert.match(page, /Register current key in HAM/)
  assert.match(page, /Never paste an nsec here/)
  assert.match(page, /organization only/)
  assert.doesNotMatch(page, /taskAccess|observer|publisher|executor|One-time credential/)
  assert.ok(authForm.indexOf("<AlternativeSignIn") < authForm.indexOf("<form action="))
  assert.ok(alternative.indexOf("onClick={signInWithNostr}") < alternative.indexOf("onClick={signInWithPasskey}"))
  assert.doesNotMatch(page, /localStorage|sessionStorage|document.cookie/)
})

test("a minted credential needs only an identity", () => {
  const mutation = parseHamAdminMutation({
    action: "createCredential",
    agentId: "galaxy-brain-bff",
  })

  assert.equal(mutation.method, "POST")
  assert.equal(mutation.path, "/admin/credentials")
  assert.deepEqual(mutation.body, {
    agent_id: "galaxy-brain-bff",
    actor_type: "service",
  })
})

test("credential inputs are validated before they reach HAM", () => {
  const base = { action: "createCredential", agentId: "agent" }
  assert.throws(() => parseHamAdminMutation({ ...base, agentId: "Bad Agent" }), /Agent ID/)
})

test("revoking a credential targets it by identifier", () => {
  const mutation = parseHamAdminMutation({
    action: "revokeCredential",
    credentialId: "b3f1c2d45e6a4b7c8d9e0f1a2b3c4d5e",
  })
  assert.equal(mutation.method, "DELETE")
  assert.equal(mutation.path, "/admin/credentials/b3f1c2d45e6a4b7c8d9e0f1a2b3c4d5e")
  assert.throws(() => parseHamAdminMutation({ action: "revokeCredential", credentialId: "cred-123" }), /invalid/)
})

test("the admin page reads the credential inventory", () => {
  const routes = getHamAdminReadRoutes()
  assert.ok(
    routes.some((route) => route.key === "credentials" && route.path === "/admin/credentials"),
    "credentials must be listed so a key can be revoked after it is minted",
  )
})

