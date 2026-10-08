import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  consumeChallengeByPurposePrefixRow,
  consumeChallengeRow,
  hashOpaqueToken,
  insertInitialOwner,
  insertReplacementResetToken,
  invalidateResetCredentials,
  isNostrTimestampFresh,
  isWebAuthnRpIdAllowed,
  updatePasskeyCounter,
} from "../lib/auth-security.js"

test("opaque auth tokens use deterministic SHA-256 instead of password hashing", () => {
  const token = "a-random-256-bit-token"
  assert.equal(hashOpaqueToken(token), createHash("sha256").update(token).digest("hex"))
  assert.equal(hashOpaqueToken(token).length, 64)
})

test("issuing a replacement reset link removes all older links", async () => {
  const queries = []
  const client = {
    async query(sql, values = []) {
      queries.push({ sql, values })
      if (sql.includes("SELECT 1 FROM app_password_reset_tokens")) return { rowCount: 0, rows: [] }
      return { rowCount: 1, rows: [] }
    },
  }
  assert.equal(
    await insertReplacementResetToken(client, {
      userId: "owner-id",
      tokenHash: "new-hash",
      lifetimeMinutes: 30,
      throttleSeconds: 60,
    }),
    true,
  )
  const deletion = queries.find((query) => query.sql.startsWith("DELETE FROM app_password_reset_tokens"))
  assert.deepEqual(deletion.values, ["owner-id"])
  assert.equal(deletion.sql.includes("token_hash"), false)
})

test("successful reset revokes every link and every existing session", async () => {
  const queries = []
  const client = {
    async query(sql, values) {
      queries.push({ sql, values })
      return { rowCount: 2, rows: [] }
    },
  }
  await invalidateResetCredentials(client, "owner-id")
  assert.match(queries[0].sql, /WHERE user_id = \$1 AND used_at IS NULL/)
  assert.match(queries[1].sql, /DELETE FROM app_sessions WHERE user_id = \$1/)
})

test("a challenge can be consumed only once", async () => {
  let available = true
  const client = {
    async query() {
      if (!available) return { rowCount: 0, rows: [] }
      available = false
      return { rowCount: 1, rows: [{ token_hash: "hash" }] }
    },
  }
  assert.equal(await consumeChallengeRow(client, "hash", "nostr-login", null), true)
  assert.equal(await consumeChallengeRow(client, "hash", "nostr-login", null), false)
})

test("a prefixed challenge returns its bound user and purpose exactly once", async () => {
  let available = true
  const client = {
    async query(sql, values) {
      assert.match(sql, /purpose LIKE \$2 \|\| '%'/)
      assert.deepEqual(values, ["hash", "generous-connect:"])
      if (!available) return { rowCount: 0, rows: [] }
      available = false
      return {
        rowCount: 1,
        rows: [{ userId: "user-id", purpose: `generous-connect:${"a".repeat(36)}:${"b".repeat(64)}` }],
      }
    },
  }
  assert.deepEqual(
    await consumeChallengeByPurposePrefixRow(client, "hash", "generous-connect:"),
    { userId: "user-id", purpose: `generous-connect:${"a".repeat(36)}:${"b".repeat(64)}` },
  )
  assert.equal(await consumeChallengeByPurposePrefixRow(client, "hash", "generous-connect:"), null)
})

test("concurrent initial-owner registration produces one owner", async () => {
  let owner = null
  let transactionTail = Promise.resolve()
  async function transaction(candidate) {
    const previous = transactionTail
    let release
    transactionTail = new Promise((resolve) => (release = resolve))
    await previous
    const client = {
      async query(sql) {
        if (sql.includes("COUNT(*)")) return { rows: [{ count: owner ? 1 : 0 }], rowCount: 1 }
        if (sql.includes("FROM app_tenants")) {
          return { rows: [{ id: "tenant-id" }], rowCount: 1 }
        }
        if (sql.startsWith("INSERT INTO app_principals")) {
          return { rows: [{ id: `${candidate}-principal` }], rowCount: 1 }
        }
        if (sql.startsWith("INSERT INTO app_users")) {
          owner = candidate
          return { rows: [{ id: candidate }], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      },
    }
    try {
      return await insertInitialOwner(client, {
        email: `${candidate}@example.com`,
        name: candidate,
        passwordHash: "hash",
      })
    } finally {
      release()
    }
  }
  const results = await Promise.all([transaction("first"), transaction("second")])
  assert.deepEqual(results, [{
    userId: "first",
    principalId: "first-principal",
    tenantId: "tenant-id",
  }, null])
  assert.equal(owner, "first")
})

test("passkey counter update is compare-and-swap monotonic", async () => {
  let counter = 4
  const client = {
    async query(_sql, [nextCounter, _id, previousCounter]) {
      if (counter !== previousCounter || nextCounter < counter) return { rowCount: 0, rows: [] }
      counter = nextCounter
      return { rowCount: 1, rows: [] }
    },
  }
  const results = await Promise.all([
    updatePasskeyCounter(client, "key-id", 4, 5),
    updatePasskeyCounter(client, "key-id", 4, 5),
  ])
  assert.equal(results.filter(Boolean).length, 1)
  assert.equal(counter, 5)
  assert.equal(await updatePasskeyCounter(client, "key-id", 5, 3), false)
})

test("WebAuthn RP ID must match the origin host or a parent domain", () => {
  assert.equal(isWebAuthnRpIdAllowed("https://galaxybrain.info", "galaxybrain.info"), true)
  assert.equal(isWebAuthnRpIdAllowed("https://app.galaxybrain.info", "galaxybrain.info"), true)
  assert.equal(isWebAuthnRpIdAllowed("https://galaxybrain.info", "example.com"), false)
  assert.equal(isWebAuthnRpIdAllowed("https://galaxybrain.info", "galaxybrain.info:443"), false)
})

test("Nostr timestamps reject stale and future events", () => {
  const now = 1_800_000_000
  assert.equal(isNostrTimestampFresh(now - 120, now), true)
  assert.equal(isNostrTimestampFresh(now + 30, now), true)
  assert.equal(isNostrTimestampFresh(now - 121, now), false)
  assert.equal(isNostrTimestampFresh(now + 31, now), false)
})

test("main Docker CI supplies the mandatory auth environment", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")
  assert.match(workflow, /github\.event_name == 'pull_request'/)
  assert.match(workflow, /AUTH_ORIGIN: http:\/\/localhost:39001/)
  assert.match(workflow, /WEBAUTHN_RP_ID: localhost/)
})

test("Node 26 Docker builds install the pinned pnpm without Corepack", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8")
  assert.match(dockerfile, /npm install --global pnpm@10\.33\.2/)
  assert.doesNotMatch(dockerfile, /corepack/)
})

test("production builds do not fetch Google Fonts", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8")
  assert.doesNotMatch(layout, /next\/font\/google/)
})

test("agents register public keys and authenticate with replay-safe NIP-98 proofs", async () => {
  const [agentRoute, agentDeleteRoute, requestIdentity, nostrHttpAuth] = await Promise.all([
    readFile(new URL("../app/api/agents/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/agents/[pubkey]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/request-identity.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/nostr-http-auth.ts", import.meta.url), "utf8"),
  ])
  assert.doesNotMatch(agentRoute, /ALLOWED_SCOPES|requestedScopes/)
  assert.match(agentRoute, /nostr_pubkey, scopes/)
  assert.match(agentRoute, /\["\*"\]/)
  assert.match(agentRoute, /authMethod !== "nostr"/)
  assert.doesNotMatch(agentRoute, /randomBytes|app_api_tokens|gbk_/)
  assert.match(agentDeleteRoute, /a\.nostr_pubkey = \$1/)
  assert.match(nostrHttpAuth, /event\.kind === NOSTR_HTTP_KIND/)
  assert.match(nostrHttpAuth, /exactTag\(event, "u"\) === expectedUrl/)
  assert.match(nostrHttpAuth, /exactTag\(event, "method"\)/)
  assert.match(nostrHttpAuth, /payloadTags\.length === 1/)
  assert.match(nostrHttpAuth, /verifyEvent\(event\)/)
  assert.match(requestIdentity, /ON CONFLICT \(event_id\) DO NOTHING/)
  assert.match(requestIdentity, /getVerifiedNostrRequestIdentity/)
  assert.match(requestIdentity, /app_nostr_request_events/)
  assert.match(requestIdentity, /user\.nostrPubkey !== event\.pubkey/)
  assert.match(requestIdentity, /scopes: \["\*"\]/)
  assert.match(requestIdentity, /return true/)
  assert.match(nostrHttpAuth, /boundedBody === undefined/)
  // Agents must still prove themselves per request rather than hold a bearer
  // secret: API keys resolve to the human who minted them (lib/api-keys.ts),
  // and nothing here may turn a key into an agent principal.
  assert.doesNotMatch(requestIdentity, /gbk_|app_api_tokens/)
  assert.doesNotMatch(requestIdentity, /kind: "agent"[\s\S]{0,200}isApiKey/)
})

test("passkey invitation redemption records a passkey-authenticated session", async () => {
  const route = await readFile(
    new URL("../app/api/auth/invitations/passkey/verify/route.ts", import.meta.url),
    "utf8",
  )
  assert.match(
    route,
    /createSession\(provisioned\.userId, provisioned\.tenantId, \{ method: "passkey" \}\)/,
  )
})

test("the connect API exchanges one-time codes with any valid tenant API key", async () => {
  const [route, compose] = await Promise.all([
    readFile(
      new URL("../app/api/integrations/generous/connect/exchange/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../docker-compose.yml", import.meta.url), "utf8"),
  ])
  assert.match(route, /isApiKey\(presented\) \? await resolveApiKey\(presented\) : null/)
  assert.doesNotMatch(route, /surface:write|apiKeyCanAny|Missing .* scope/)
  assert.doesNotMatch(route, /getRequestIdentity/)
  const genericRoute = await readFile(
    new URL("../app/api/connect/exchange/route.ts", import.meta.url),
    "utf8",
  )
  assert.match(genericRoute, /integrations\/generous\/connect\/exchange/)
  assert.match(
    compose,
    /CONNECT_CALLBACK_URL: \$\{CONNECT_CALLBACK_URL:-\$\{GENEROUS_CONNECT_CALLBACK_URL:-\}\}/,
  )
})
