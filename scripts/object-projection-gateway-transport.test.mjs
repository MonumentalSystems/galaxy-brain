import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import {
  ObjectProjectionGatewayError,
  resolveObjectProjectionSources,
} from "../lib/object-projection-gateway.js"

const TENANT_ID = "11111111-1111-4111-8111-111111111111"
const HASH = "a".repeat(64)
const CHAT_ID = "80000000-0000-4000-8000-000000000001"
const identity = Object.freeze({
  principalId: "principal-1",
  tenantId: TENANT_ID,
  kind: "human",
  role: "owner",
  scopes: ["*"],
  nostrPubkey: null,
})

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
    ...init,
  })
}

function resolvedPaper(requestedRef, resolvedRef) {
  return {
    requestedRef,
    status: "resolved",
    resolvedRef,
    provider: "galaxy.paper",
    sourceKind: "paper",
    source: {
      paper: { id: "paper-1", title: "Paper", metadataHash: HASH },
      revision: { id: "revision-1", metadataHash: HASH },
    },
  }
}

function resolvedChat(requestedRef) {
  return {
    requestedRef,
    status: "resolved",
    resolvedRef: requestedRef,
    provider: "galaxy.conversation",
    sourceKind: "chat",
    source: {
      conversationId: CHAT_ID,
      workspaceId: "research-field",
      title: "Pinned research chat",
      goalSummary: "Compare exact proof obligations.",
      version: 5,
      contentSha256: HASH,
      turnCount: 4,
      branchCount: 2,
    },
  }
}

test("gateway uses one fixed private local route and preserves requested order", async () => {
  const paper = createGalaxyObjectReference("paper", "paper-1")
  const chat = createGalaxyObjectReference("chat", CHAT_ID, {
    mode: "pinned", revision: `sha256:${HASH}`,
  })
  const unsupported = createGalaxyObjectReference("artifact", "artifact-1")
  const calls = []
  const result = await resolveObjectProjectionSources(
    [paper, chat, unsupported],
    identity,
    { GALAXY_API_INTERNAL: "https://galaxy-api.example/internal", GALAXY_API_PROXY_TOKEN: "proxy-secret" },
    async (url, init) => {
      calls.push({ url: String(url), init })
      assert.equal(String(url), "https://galaxy-api.example/internal/object-projection-sources/resolve")
      assert.equal(init.method, "POST")
      assert.equal(init.redirect, "error")
      assert.equal(init.cache, "no-store")
      assert.equal(init.headers.get("X-GB-Projection-Gateway"), "v3")
      assert.equal(init.headers.get("X-GB-Tenant-ID"), TENANT_ID)
      assert.equal(init.headers.get("X-GB-Principal-ID"), identity.principalId)
      assert.equal(init.headers.get("Authorization"), "Bearer proxy-secret")
      assert.deepEqual(JSON.parse(init.body), {
        schemaId: "gb.object-projection-source-request.v3",
        references: [paper, chat],
      })
      return jsonResponse({
        schemaId: "gb.object-projection-source-response.v3",
        results: [
          { requestedRef: paper, status: "unavailable" },
          resolvedChat(chat),
        ],
      })
    },
  )
  assert.equal(calls.length, 1)
  assert.deepEqual(result.results, [
    { requestedRef: paper, status: "unavailable" },
    resolvedChat(chat),
    { requestedRef: unsupported, status: "unavailable" },
  ])
})

test("gateway falls back to the unchanged v2 contract without placement authority", async () => {
  const paper = createGalaxyObjectReference("paper", "paper-1")
  const calls = []
  const result = await resolveObjectProjectionSources(
    [paper],
    identity,
    { GALAXY_API_INTERNAL: "https://galaxy-api.example", GALAXY_API_PROXY_TOKEN: "proxy-secret" },
    async (_url, init) => {
      calls.push({
        version: init.headers.get("X-GB-Projection-Gateway"),
        body: JSON.parse(init.body),
      })
      if (calls.length === 1) {
        return jsonResponse({ detail: "Unsupported projection request schema" }, { status: 422 })
      }
      return jsonResponse({
        schemaId: "gb.object-projection-source-response.v2",
        results: [{ requestedRef: paper, status: "unavailable" }],
      })
    },
  )
  assert.deepEqual(calls, [
    {
      version: "v3",
      body: { schemaId: "gb.object-projection-source-request.v3", references: [paper] },
    },
    {
      version: "v2",
      body: { schemaId: "gb.object-projection-source-request.v2", references: [paper] },
    },
  ])
  assert.deepEqual(result.results, [{ requestedRef: paper, status: "unavailable" }])
})

test("gateway reaches v1 only when an older API rejects both v3 and v2", async () => {
  const paper = createGalaxyObjectReference("paper", "paper-1")
  const calls = []
  const result = await resolveObjectProjectionSources(
    [paper],
    identity,
    { GALAXY_API_INTERNAL: "https://galaxy-api.example", GALAXY_API_PROXY_TOKEN: "proxy-secret" },
    async (_url, init) => {
      calls.push({
        version: init.headers.get("X-GB-Projection-Gateway"),
        body: JSON.parse(init.body),
      })
      if (calls.length < 3) {
        return jsonResponse({ detail: "Unsupported projection request schema" }, { status: 422 })
      }
      return jsonResponse({
        schemaId: "gb.object-projection-source-response.v1",
        results: [{ requestedRef: paper, status: "unavailable" }],
      })
    },
  )
  assert.deepEqual(calls.map((call) => call.version), ["v3", "v2", "v1"])
  assert.deepEqual(result.results, [{ requestedRef: paper, status: "unavailable" }])
})

test("gateway does not downgrade on an unrelated validation failure", async () => {
  const paper = createGalaxyObjectReference("paper", "paper-1")
  let calls = 0
  await assert.rejects(
    resolveObjectProjectionSources(
      [paper],
      identity,
      { GALAXY_API_INTERNAL: "https://galaxy-api.example", GALAXY_API_PROXY_TOKEN: "proxy-secret" },
      async () => {
        calls += 1
        return jsonResponse({ detail: "Projection gateway version does not match request schema" }, { status: 422 })
      },
    ),
    ObjectProjectionGatewayError,
  )
  assert.equal(calls, 1)
})

test("gateway resolves local and HAM providers concurrently into original order", async () => {
  const task = createGalaxyObjectReference("ham.task", "task-1")
  const paper = createGalaxyObjectReference("paper", "paper-1")
  const chat = createGalaxyObjectReference("chat", CHAT_ID, {
    mode: "pinned", revision: `sha256:${HASH}`,
  })
  const memory = createGalaxyObjectReference("ham.memory", "42")
  const paperPinned = createGalaxyObjectReference("paper", "paper-1", {
    mode: "pinned",
    revision: `sha256:${HASH}`,
  })
  const environment = {
    GALAXY_API_INTERNAL: "https://galaxy-api.example",
    GALAXY_API_PROXY_TOKEN: "proxy-secret",
    HAM_TASK_API_INTERNAL: "https://ham-task.example",
    HAM_TASK_GALAXY_TENANT_ID: TENANT_ID,
    HAM_TASK_READ_BEARER_TOKEN: "task-reader",
    HAM_API_INTERNAL: "https://ham-memory.example",
    HAM_SEARCH_GALAXY_TENANT_ID: TENANT_ID,
    HAM_API_BEARER_TOKEN: "memory-reader",
  }
  const result = await resolveObjectProjectionSources(
    [task, chat, paper, memory],
    identity,
    environment,
    async (url, init) => {
      const target = String(url)
      assert.equal(init.redirect, "error")
      if (target === "https://galaxy-api.example/object-projection-sources/resolve") {
        assert.deepEqual(JSON.parse(init.body).references, [chat, paper])
        return jsonResponse({
          schemaId: "gb.object-projection-source-response.v3",
          results: [resolvedChat(chat), resolvedPaper(paper, paperPinned)],
        })
      }
      if (target === "https://ham-task.example/tasks/task-1") {
        assert.equal(init.headers.get("Authorization"), "Bearer task-reader")
        assert.equal(init.headers.get("X-GB-User-ID"), TENANT_ID)
        return jsonResponse({
          task_id: "task-1",
          title: "Proof task",
          goal: "Prove the target",
          rationale: "Close the frontier",
          status: "pending",
          version: 3,
        })
      }
      if (target === "https://ham-memory.example/memories/42") {
        assert.equal(init.headers.get("Authorization"), "Bearer memory-reader")
        return jsonResponse({
          id: 42,
          content: "Bounded memory content",
          metadata: { title: "Memory title" },
          version: 4,
        })
      }
      assert.fail(`unexpected provider URL ${target}`)
    },
  )
  assert.deepEqual(result.results.map((item) => [item.requestedRef, item.status, item.sourceKind]), [
    [task, "resolved", "ham.task"],
    [chat, "resolved", "chat"],
    [paper, "resolved", "paper"],
    [memory, "resolved", "ham.memory"],
  ])
  assert.equal(result.results[0].source.version, 3)
  assert.equal(result.results[1].source.contentSha256, HASH)
  assert.equal(result.results[2].resolvedRef, paperPinned)
  assert.equal(result.results[3].source.version, 4)
})

test("HAM 404 is unavailable while malformed identity or version fails the whole batch", async () => {
  const task = createGalaxyObjectReference("ham.task", "task-1")
  const environment = {
    HAM_TASK_API_INTERNAL: "https://ham-task.example",
    HAM_TASK_GALAXY_TENANT_ID: TENANT_ID,
    HAM_TASK_READ_BEARER_TOKEN: "task-reader",
  }
  const missing = await resolveObjectProjectionSources(
    [task], identity, environment, async () => new Response(null, { status: 404 }),
  )
  assert.deepEqual(missing.results, [{ requestedRef: task, status: "unavailable" }])

  for (const payload of [
    { task_id: "task-other", title: "Wrong task", status: "pending", version: 1 },
    { task_id: "task-1", title: "No version", status: "pending" },
    { task_id: "task-1", title: "String version", status: "pending", version: "1" },
  ]) {
    await assert.rejects(
      resolveObjectProjectionSources([task], identity, environment, async () => jsonResponse(payload)),
      ObjectProjectionGatewayError,
    )
  }
})

test("unsupported HAM identifiers never reach an upstream provider", async () => {
  const invalidTask = createGalaxyObjectReference("ham.task", "../private-task")
  const invalidMemory = createGalaxyObjectReference("ham.memory", "9999999999999999999")
  let calls = 0
  const result = await resolveObjectProjectionSources(
    [invalidTask, invalidMemory],
    identity,
    {},
    async () => {
      calls += 1
      return jsonResponse({})
    },
  )
  assert.equal(calls, 0)
  assert.deepEqual(result.results, [
    { requestedRef: invalidTask, status: "unavailable" },
    { requestedRef: invalidMemory, status: "unavailable" },
  ])
})

test("HAM references denied by tenant binding are indistinguishable unavailable results", async () => {
  const task = createGalaxyObjectReference("ham.task", "task-1")
  const memory = createGalaxyObjectReference("ham.memory", "42")
  const otherTenant = "22222222-2222-4222-8222-222222222222"
  let calls = 0
  const result = await resolveObjectProjectionSources(
    [task, memory],
    identity,
    {
      HAM_TASK_API_INTERNAL: "https://ham-task.example",
      HAM_TASK_GALAXY_TENANT_ID: otherTenant,
      HAM_TASK_READ_BEARER_TOKEN: "task-reader",
      HAM_API_INTERNAL: "https://ham-memory.example",
      HAM_SEARCH_GALAXY_TENANT_ID: otherTenant,
      HAM_API_BEARER_TOKEN: "memory-reader",
    },
    async () => {
      calls += 1
      return jsonResponse({})
    },
  )
  assert.equal(calls, 0)
  assert.deepEqual(result.results, [
    { requestedRef: task, status: "unavailable" },
    { requestedRef: memory, status: "unavailable" },
  ])
})

test("local and HAM providers share the global eight-fetch concurrency ceiling", async () => {
  const paper = createGalaxyObjectReference("paper", "paper-1")
  const tasks = Array.from({ length: 15 }, (_, index) => (
    createGalaxyObjectReference("ham.task", `task-${index}`)
  ))
  const environment = {
    GALAXY_API_INTERNAL: "https://galaxy-api.example",
    GALAXY_API_PROXY_TOKEN: "proxy-secret",
    HAM_TASK_API_INTERNAL: "https://ham-task.example",
    HAM_TASK_GALAXY_TENANT_ID: TENANT_ID,
    HAM_TASK_READ_BEARER_TOKEN: "task-reader",
  }
  let active = 0
  let maximumActive = 0
  const result = await resolveObjectProjectionSources(
    [paper, ...tasks], identity, environment, async (url) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      const target = String(url)
      if (target.includes("object-projection-sources")) {
        return jsonResponse({
          schemaId: "gb.object-projection-source-response.v3",
          results: [{ requestedRef: paper, status: "unavailable" }],
        })
      }
      const taskId = decodeURIComponent(target.slice(target.lastIndexOf("/") + 1))
      return jsonResponse({ task_id: taskId, title: taskId, status: "pending", version: 1 })
    },
  )
  assert.equal(result.results.length, 16)
  assert.ok(maximumActive > 1)
  assert.ok(maximumActive <= 8, `observed ${maximumActive} concurrent fetches`)
})

test("gateway rejects unsafe provider configuration and bounded-response violations", async () => {
  const paper = createGalaxyObjectReference("paper", "paper-1")
  let called = false
  await assert.rejects(resolveObjectProjectionSources(
    [paper],
    identity,
    {
      GALAXY_API_INTERNAL: "https://user:secret@galaxy-api.example/?redirect=https://evil.example",
      GALAXY_API_PROXY_TOKEN: "proxy-secret",
    },
    async () => {
      called = true
      return jsonResponse({})
    },
  ), ObjectProjectionGatewayError)

  await assert.rejects(resolveObjectProjectionSources(
    [paper],
    identity,
    { GALAXY_API_INTERNAL: "https://galaxy-api.example", GALAXY_API_PROXY_TOKEN: "proxy-secret" },
    async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }),
  ), ObjectProjectionGatewayError)
  assert.equal(called, false)

  await assert.rejects(resolveObjectProjectionSources(
    [paper],
    identity,
    { GALAXY_API_INTERNAL: "https://galaxy-api.example", GALAXY_API_PROXY_TOKEN: "proxy-secret" },
    async () => new Response("{}", {
      status: 200,
      headers: { "content-length": String(2_097_153), "content-type": "application/json" },
    }),
  ), ObjectProjectionGatewayError)

  const oversizedChunk = new Uint8Array(2_097_153)
  await assert.rejects(resolveObjectProjectionSources(
    [paper],
    identity,
    { GALAXY_API_INTERNAL: "https://galaxy-api.example", GALAXY_API_PROXY_TOKEN: "proxy-secret" },
    async () => new Response(oversizedChunk, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ), ObjectProjectionGatewayError)
})

test("malformed local batches fail instead of being rewritten as unavailable", async () => {
  const paper = createGalaxyObjectReference("paper", "paper-1")
  const environment = {
    GALAXY_API_INTERNAL: "https://galaxy-api.example",
    GALAXY_API_PROXY_TOKEN: "proxy-secret",
  }
  for (const results of [
    [],
    [{ requestedRef: paper, status: "unavailable" }, { requestedRef: paper, status: "unavailable" }],
    [{ requestedRef: createGalaxyObjectReference("paper", "paper-2"), status: "unavailable" }],
  ]) {
    await assert.rejects(resolveObjectProjectionSources(
      [paper], identity, environment, async () => jsonResponse({
        schemaId: "gb.object-projection-source-response.v3",
        results,
      }),
    ), ObjectProjectionGatewayError)
  }
})

test("public route binds auth to raw bytes and the generic proxy blocks private source records", async () => {
  const route = await readFile(
    new URL("../app/api/eln/object-projections/resolve/route.ts", import.meta.url),
    "utf8",
  )
  const genericProxy = await readFile(
    new URL("../app/api/eln/[...path]/route.ts", import.meta.url),
    "utf8",
  )
  assert.match(route, /getRequestIdentity\(request, rawBody\)/)
  assert.match(route, /MAX_OBJECT_PROJECTION_REQUEST_BYTES/)
  assert.match(route, /mediaType !== "application\/json"/)
  assert.match(route, /Object projection provider is unavailable/)
  assert.match(route, /private, no-store/)
  assert.match(route, /new TextDecoder\("utf-8", \{ fatal: true/)
  assert.match(route, /total > MAX_OBJECT_PROJECTION_REQUEST_BYTES/)
  assert.match(
    genericProxy,
    /\["object-projection-sources", "agent-anchor-creations", "relation-proposals"\]\.includes\(path\[0\]\)/,
  )
  assert.match(genericProxy, /status: 404/)
})
