import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { webcrypto } from "node:crypto"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"

async function browserHarness({ canonicalUrl = "https://galaxy.example/api/eln/proof-graphs" } = {}) {
  const source = await readFile(new URL("../lib/nostr-browser.ts", import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const signed = []
  const requested = []
  const signer = {
    async signEvent(event) {
      signed.push(event)
      return { ...event, id: "event-id", pubkey: "a".repeat(64), sig: "b".repeat(128) }
    },
  }
  const sandbox = {
    exports: {},
    URL, URLSearchParams, Uint8Array, TextEncoder,
    crypto: webcrypto,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    Date,
    window: { nostr: signer },
    async fetch(url, init) {
      requested.push({ url, init })
      return Response.json({ schemaId: "gb.nostr-request-target.v1", url: canonicalUrl })
    },
    Response,
    Buffer,
  }
  vm.runInNewContext(compiled, sandbox)
  return { api: sandbox.exports, requested, signed, signer }
}

async function routeHarness({ user = { authMethod: "nostr", nostrPubkey: "a".repeat(64) } } = {}) {
  const source = await readFile(new URL("../app/api/auth/nostr/request-target/route.ts", import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const sandbox = {
    exports: {}, Response, URL,
    require(name) {
      if (name === "next/server") return {}
      if (name === "@/lib/auth-config") return { getAuthOrigin: () => "https://galaxy.example" }
      if (name === "@/lib/auth") return { getCurrentUser: async () => user }
      throw new Error(`Unexpected import: ${name}`)
    },
  }
  vm.runInNewContext(compiled, sandbox)
  return async function request(path) {
    const target = new URL("https://local.test/api/auth/nostr/request-target")
    if (path !== undefined) target.searchParams.set("path", path)
    return sandbox.exports.GET({ nextUrl: target })
  }
}

test("browser signing uses the canonical server target without requesting raw key material", async () => {
  const harness = await browserHarness()
  const canonical = await harness.api.getCanonicalNostrRequestTarget("/api/eln/proof-graphs?limit=25")
  const authorization = await harness.api.signNostrHttpRequest({
    url: canonical,
    method: "post",
    body: new TextEncoder().encode("proof graph bytes"),
  })
  assert.equal(harness.requested[0].url, "/api/auth/nostr/request-target?path=%2Fapi%2Feln%2Fproof-graphs%3Flimit%3D25")
  assert.equal(harness.requested[0].init.cache, "no-store")
  assert.match(authorization, /^Nostr /u)
  assert.deepEqual(Array.from(harness.signed[0].tags[0]), ["u", "https://galaxy.example/api/eln/proof-graphs"])
  assert.deepEqual(Array.from(harness.signed[0].tags[1]), ["method", "POST"])
  assert.match(harness.signed[0].tags[2][1], /^[0-9a-f]{64}$/u)
  assert.equal(harness.signed[0].kind, 27235)
  assert.deepEqual(Object.keys(harness.signer), ["signEvent"])
})

test("request-target route requires a Nostr session and returns only a no-store canonical URL", async () => {
  const request = await routeHarness()
  const response = await request("/api/eln/proof-graphs?limit=25")
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("Cache-Control"), "private, no-store")
  assert.deepEqual(await response.json(), {
    schemaId: "gb.nostr-request-target.v1",
    url: "https://galaxy.example/api/eln/proof-graphs?limit=25",
  })
  const unauthorized = await routeHarness({ user: { authMethod: "password", nostrPubkey: null } })
  assert.equal((await unauthorized("/api/eln/proof-graphs")).status, 401)

  const agentTool = await request("/api/agent-tools/canvas.arrange")
  assert.equal(agentTool.status, 200)
  assert.equal((await agentTool.json()).url, "https://galaxy.example/api/agent-tools/canvas.arrange")
  const anchorTool = await request("/api/agent-tools/anchors.create")
  assert.equal(anchorTool.status, 200)
  assert.equal((await anchorTool.json()).url, "https://galaxy.example/api/agent-tools/anchors.create")
  const relationTool = await request("/api/agent-tools/relations.propose")
  assert.equal(relationTool.status, 200)
  assert.equal((await relationTool.json()).url, "https://galaxy.example/api/agent-tools/relations.propose")
  const surfaceTool = await request("/api/agent-tools/surface.draft.create")
  assert.equal(surfaceTool.status, 200)
  assert.equal((await surfaceTool.json()).url, "https://galaxy.example/api/agent-tools/surface.draft.create")
  const proofClaim = await request("/api/agent-tools/proof.claim")
  assert.equal(proofClaim.status, 200)
  assert.equal((await proofClaim.json()).url, "https://galaxy.example/api/agent-tools/proof.claim")
  const mcp = await request("/mcp")
  assert.equal(mcp.status, 200)
  assert.equal((await mcp.json()).url, "https://galaxy.example/mcp")
})

test("request-target signs only the exact bounded Hyades reconcile route", async () => {
  const request = await routeHarness()
  const exact = "/api/proof-workspaces/workspace-%E2%98%83/hyades-task-bindings/reconcile"
  const response = await request(exact)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    schemaId: "gb.nostr-request-target.v1",
    url: `https://galaxy.example${exact}`,
  })
  for (const path of [
    "/api/proof-workspaces/workspace-a/hyades-task-bindings/reconcile?target=other",
    "/api/proof-workspaces/workspace-a/hyades-task-bindings/reconcile/extra",
    "/api/proof-workspaces/workspace%2Fa/hyades-task-bindings/reconcile",
    `/api/proof-workspaces/${"a".repeat(513)}/hyades-task-bindings/reconcile`,
  ]) {
    assert.equal((await request(path)).status, 400, path)
  }
})

test("request-target route rejects unbounded, non-ELN, fragmented, and traversal shapes", async () => {
  const request = await routeHarness()
  for (const path of [
    "/api/auth/session",
    "/api/agent-tools/canvas.get",
    "/api/agent-tools/anchors.create?tenant=caller-owned",
    "/api/agent-tools/anchors.create/extra",
    "/api/agent-tools/canvas.arrange?tenant=caller-owned",
    "/api/agent-tools/relations.propose?tenant=caller-owned",
    "/api/agent-tools/relations.propose/extra",
    "/api/agent-tools/surface.draft.create?tenant=caller-owned",
    "/api/agent-tools/surface.draft.create/extra",
    "/api/agent-tools/proof.claim?tenant=caller-owned",
    "/api/agent-tools/proof.claim/extra",
    "/mcp?tenant=caller-owned",
    "/mcp/extra",
    "/api/eln//proof-graphs",
    "/api/eln/proof-graphs#fragment",
    "/api/eln/../auth/session",
    "/api/eln/%2e%2e/auth/session",
    `/api/eln/${"a".repeat(2_001)}`,
  ]) {
    assert.equal((await request(path)).status, 400, path)
  }
})
