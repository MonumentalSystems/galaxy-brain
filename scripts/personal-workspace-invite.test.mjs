import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  canIssuePersonalWorkspaceInvitation,
  canManagePersonalWorkspaceInvitations,
  DEFAULT_TENANT_ID,
  insertPersonalWorkspaceInvitation,
  isInviteToken,
  provisionPersonalWorkspaceInvitation,
} from "../lib/auth-security.js"
import {
  ACCOUNT_BROWSER_STORAGE_PREFIXES,
  clearTenantStorage,
  migrateDefaultTenantStorage,
  tenantScopedStorage,
  tenantStorageKey,
} from "../lib/tenant-browser-storage.js"

test("only a recently authenticated original owner can issue personal workspace invitations", () => {
  const now = Date.parse("2026-09-10T12:00:00Z")
  const owner = {
    tenantId: DEFAULT_TENANT_ID,
    role: "owner",
    authenticatedAt: "2026-09-10T11:50:00Z",
  }
  assert.equal(canManagePersonalWorkspaceInvitations(owner), true)
  assert.equal(canIssuePersonalWorkspaceInvitation(owner, now), true)
  assert.equal(canIssuePersonalWorkspaceInvitation({ ...owner, role: "admin" }, now), false)
  assert.equal(canIssuePersonalWorkspaceInvitation({ ...owner, tenantId: "10000000-0000-4000-8000-000000000002" }, now), false)
  assert.equal(canIssuePersonalWorkspaceInvitation({ ...owner, authenticatedAt: "2026-09-10T11:44:59Z" }, now), false)
})

test("invitation tokens have one exact high-entropy wire shape", () => {
  assert.equal(isInviteToken("a".repeat(43)), true)
  assert.equal(isInviteToken("a".repeat(42)), false)
  assert.equal(isInviteToken("a".repeat(42) + "+"), false)
})

test("issuing an invitation revokes older unused links without storing plaintext tokens", async () => {
  const queries = []
  const client = {
    async query(sql, values = []) {
      queries.push({ sql, values })
      if (sql.includes("SELECT 1 FROM app_users")) return { rowCount: 0, rows: [] }
      if (sql.includes("INSERT INTO app_registration_invitations")) {
        return { rowCount: 1, rows: [{ id: "invite-id", email: values[1] }] }
      }
      return { rowCount: 1, rows: [] }
    },
  }
  const invitation = await insertPersonalWorkspaceInvitation(client, {
    tokenHash: "f".repeat(64),
    email: "friend@example.com",
    name: "Friend",
    issuerTenantId: DEFAULT_TENANT_ID,
    createdByPrincipalId: "owner-principal",
    lifetimeDays: 7,
  })
  assert.equal(invitation.id, "invite-id")
  assert.ok(queries.some(({ sql }) => sql.includes("SET revoked_at = now()")))
  const insert = queries.find(({ sql }) => sql.includes("INSERT INTO app_registration_invitations"))
  assert.equal(insert.values[0], "f".repeat(64))
  assert.equal(insert.values.includes("plaintext-token"), false)
})

test("redeeming an invitation creates a separate owner tenant and succeeds only once", async () => {
  let pending = true
  const queries = []
  const client = {
    async query(sql, values = []) {
      queries.push({ sql, values })
      if (sql.includes("SELECT email") && sql.includes("FROM app_registration_invitations")) {
        return pending ? { rowCount: 1, rows: [{ email: "friend@example.com" }] } : { rowCount: 0, rows: [] }
      }
      if (sql.includes("FROM app_registration_invitations") && sql.includes("FOR UPDATE")) {
        return pending
          ? { rowCount: 1, rows: [{ id: "11111111-1111-4111-8111-111111111111", email: "friend@example.com", name: "Friend" }] }
          : { rowCount: 0, rows: [] }
      }
      if (sql.includes("SELECT 1 FROM app_users")) return { rowCount: 0, rows: [] }
      if (sql.includes("INSERT INTO app_tenants")) return { rowCount: 1, rows: [{ id: "friend-tenant" }] }
      if (sql.includes("INSERT INTO app_principals")) return { rowCount: 1, rows: [{ id: "friend-principal" }] }
      if (sql.includes("INSERT INTO app_users")) return { rowCount: 1, rows: [{ id: "friend-user" }] }
      if (sql.includes("UPDATE app_registration_invitations")) {
        pending = false
        return { rowCount: 1, rows: [] }
      }
      return { rowCount: 1, rows: [] }
    },
  }
  const input = {
    tokenHash: "f".repeat(64),
    passwordHash: "unrecoverable-random-password-hash",
    credential: {
      id: "credential-id",
      publicKey: Buffer.from("public-key"),
      counter: 0,
      transports: ["internal"],
      deviceType: "multiDevice",
      backedUp: true,
      label: "Primary passkey",
    },
  }
  assert.deepEqual(await provisionPersonalWorkspaceInvitation(client, input), {
    userId: "friend-user",
    principalId: "friend-principal",
    tenantId: "friend-tenant",
  })
  assert.equal(await provisionPersonalWorkspaceInvitation(client, input), null)
  const tenantInsert = queries.find(({ sql }) => sql.includes("INSERT INTO app_tenants"))
  assert.equal(tenantInsert.values[0], "personal-11111111-1111-4111-8111-111111111111")
  const membershipInsert = queries.find(({ sql }) => sql.includes("INSERT INTO app_tenant_memberships"))
  assert.match(membershipInsert.sql, /'owner'/)
})

test("a verified Nostr identity can provision the invited tenant instead of a passkey", async () => {
  const queries = []
  const client = {
    async query(sql, values = []) {
      queries.push({ sql, values })
      if (sql.includes("SELECT email") && sql.includes("FROM app_registration_invitations")) {
        return { rowCount: 1, rows: [{ email: "friend@example.com" }] }
      }
      if (sql.includes("FROM app_registration_invitations") && sql.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [{ id: "11111111-1111-4111-8111-111111111111", email: "friend@example.com", name: "Friend" }] }
      }
      if (sql.includes("SELECT 1 FROM app_users")) return { rowCount: 0, rows: [] }
      if (sql.includes("INSERT INTO app_tenants")) return { rowCount: 1, rows: [{ id: "friend-tenant" }] }
      if (sql.includes("INSERT INTO app_principals")) return { rowCount: 1, rows: [{ id: "friend-principal" }] }
      if (sql.includes("INSERT INTO app_users")) return { rowCount: 1, rows: [{ id: "friend-user" }] }
      return { rowCount: 1, rows: [] }
    },
  }
  const pubkey = "a".repeat(64)
  const result = await provisionPersonalWorkspaceInvitation(client, {
    tokenHash: "f".repeat(64),
    passwordHash: "unrecoverable-random-password-hash",
    nostrPubkey: pubkey,
    nostrLabel: "Primary Nostr identity",
  })
  assert.equal(result.tenantId, "friend-tenant")
  const nostrInsert = queries.find(({ sql }) => sql.includes("INSERT INTO app_nostr_keys"))
  assert.deepEqual(nostrInsert.values, ["friend-user", pubkey, "Primary Nostr identity"])
  assert.equal(queries.some(({ sql }) => sql.includes("INSERT INTO app_passkeys")), false)
})

test("browser notebook keys are tenant-specific and legacy data moves only to the default tenant", () => {
  const values = new Map([["galaxy-brain-nodes", "owner-data"]])
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
  assert.equal(migrateDefaultTenantStorage(storage, DEFAULT_TENANT_ID, ["galaxy-brain-nodes"]), 1)
  assert.equal(values.get(tenantStorageKey("galaxy-brain-nodes", DEFAULT_TENANT_ID)), "owner-data")
  assert.equal(values.has("galaxy-brain-nodes"), false)

  values.set("galaxy-brain-nodes", "must-not-leak")
  const friendTenant = "22222222-2222-4222-8222-222222222222"
  assert.equal(migrateDefaultTenantStorage(storage, friendTenant, ["galaxy-brain-nodes"]), 0)
  assert.equal(values.has(tenantStorageKey("galaxy-brain-nodes", friendTenant)), false)
  assert.notEqual(
    tenantStorageKey("galaxy-brain-nodes", DEFAULT_TENANT_ID),
    tenantStorageKey("galaxy-brain-nodes", friendTenant),
  )
})

test("all account browser storage is tenant-scoped and clearing preserves other tenants", () => {
  const values = new Map([
    ["flowiseFlows", "legacy-owner-flows"],
    ["unrelated-device-setting", "keep"],
  ])
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size },
  }
  assert.equal(migrateDefaultTenantStorage(
    storage,
    DEFAULT_TENANT_ID,
    [],
    [...ACCOUNT_BROWSER_STORAGE_PREFIXES],
  ), 1)

  const ownerStorage = tenantScopedStorage(storage, DEFAULT_TENANT_ID)
  const friendTenant = "22222222-2222-4222-8222-222222222222"
  const friendStorage = tenantScopedStorage(storage, friendTenant)
  assert.equal(ownerStorage.getItem("flowiseFlows"), "legacy-owner-flows")
  assert.equal(friendStorage.getItem("flowiseFlows"), null)
  ownerStorage.setItem("flowiseApiKeys", "owner-secret")
  friendStorage.setItem("flowiseApiKeys", "friend-secret")
  values.set(`galaxy.paper-task-link-recovery.v2:${friendTenant}:33333333-3333-4333-8333-333333333333:pending`, "friend-recovery")

  assert.equal(clearTenantStorage(storage, DEFAULT_TENANT_ID), 2)
  assert.equal(ownerStorage.getItem("flowiseApiKeys"), null)
  assert.equal(friendStorage.getItem("flowiseApiKeys"), "friend-secret")
  assert.equal(values.get(`galaxy.paper-task-link-recovery.v2:${friendTenant}:33333333-3333-4333-8333-333333333333:pending`), "friend-recovery")
  assert.equal(values.get("unrelated-device-setting"), "keep")

  assert.equal(clearTenantStorage(storage, friendTenant), 2)
  assert.equal(friendStorage.getItem("flowiseApiKeys"), null)
  assert.equal(values.has(`galaxy.paper-task-link-recovery.v2:${friendTenant}:33333333-3333-4333-8333-333333333333:pending`), false)
  assert.equal(values.get("unrelated-device-setting"), "keep")
})

test("invite secrets stay in URL fragments and redemption requests are bounded and same-origin", async () => {
  const issueRoute = await readFile(new URL("../app/api/auth/invitations/route.ts", import.meta.url), "utf8")
  const optionsRoute = await readFile(new URL("../app/api/auth/invitations/passkey/options/route.ts", import.meta.url), "utf8")
  const verifyRoute = await readFile(new URL("../app/api/auth/invitations/passkey/verify/route.ts", import.meta.url), "utf8")
  const nostrOptionsRoute = await readFile(new URL("../app/api/auth/invitations/nostr/options/route.ts", import.meta.url), "utf8")
  const nostrVerifyRoute = await readFile(new URL("../app/api/auth/invitations/nostr/verify/route.ts", import.meta.url), "utf8")
  const invitePage = await readFile(new URL("../components/invite-passkey-form.tsx", import.meta.url), "utf8")
  assert.match(issueRoute, /inviteUrl\.hash/)
  assert.doesNotMatch(issueRoute, /searchParams\.set\(["']token/)
  for (const route of [optionsRoute, verifyRoute, nostrOptionsRoute, nostrVerifyRoute]) {
    assert.match(route, /assertSameAuthOrigin\(request\)/)
    assert.match(route, /readBoundedAuthJson\(request/)
  }
  assert.match(invitePage, /window\.history\.replaceState/)
  assert.match(invitePage, /signNostrAuthEvent/)
  assert.match(nostrVerifyRoute, /verifyEvent\(event\)/)
  assert.match(nostrVerifyRoute, /`nostr-invite:\$\{invitationId\}`/)
})

test("invited tenants cannot delete the original owner's legacy paper recovery state", async () => {
  const paperWorkbench = await readFile(new URL("../components/papers/paper-workbench.tsx", import.meta.url), "utf8")
  assert.match(paperWorkbench, /tenantId\.toLowerCase\(\) === DEFAULT_TENANT_ID/)
  assert.match(paperWorkbench, /removeItem\(LEGACY_TASK_LINK_RECOVERY_KEY\)/)
})
