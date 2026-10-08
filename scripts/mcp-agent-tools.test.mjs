import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"

import {
  classifyMcpRequest,
  createGalaxyMcpHandler,
  createMcpToolSuccess,
  MAX_MCP_REQUEST_BYTES,
  MAX_MCP_RESPONSE_BYTES,
} from "../lib/agent-tools/mcp.js"
import { AGENT_TOOL_IDS } from "../lib/agent-tools/contracts.js"

const IDENTITY = Object.freeze({
  principalId: "principal-a",
  tenantId: "tenant-a",
  kind: "agent",
  role: "agent",
  scopes: ["*"],
  nostrPubkey: "a".repeat(64),
})

const META = Object.freeze({
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
})

const DOCUMENT_MARK_AUTHORING_TOOL_IDS = Object.freeze([
  "document.mark.create", "document.mark.update",
])

async function mcpExchange(handler, method, params = {}) {
  const body = { jsonrpc: "2.0", id: 1, method, params: { _meta: META, ...params } }
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
    ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
  }
  const response = await handler.fetch(new Request("https://galaxy.example/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }), { parsedBody: body })
  return { response, body: await response.json() }
}

test("MCP publishes only the exact static agent-tool catalog with permissive object schemas", async () => {
  const handler = createGalaxyMcpHandler({ identity: IDENTITY, authStrength: "ambient" })
  try {
    const { response, body } = await mcpExchange(handler, "tools/list")
    assert.equal(response.status, 200)
    assert.deepEqual(body.result.tools.map((tool) => tool.name), AGENT_TOOL_IDS)
    for (const name of DOCUMENT_MARK_AUTHORING_TOOL_IDS) {
      assert.equal(body.result.tools.some((tool) => tool.name === name), false)
    }
    for (const tool of body.result.tools) {
      assert.deepEqual(tool.inputSchema, { type: "object", additionalProperties: true })
    }
    assert.equal(
      body.result.tools.find((tool) => tool.name === "objects.search")?.annotations?.readOnlyHint,
      true,
    )
    const hamSearch = body.result.tools.find((tool) => tool.name === "ham.memory.search")
    assert.equal(hamSearch?.annotations?.readOnlyHint, true)
    assert.match(hamSearch?.description || "", /HAM memories/u)
    assert.equal(body.result.tools.some((tool) => tool.name === "ham.memory.write"), false)
    const graphWindow = body.result.tools.find((tool) => tool.name === "graph.window.get")
    assert.equal(graphWindow?.annotations?.readOnlyHint, true)
    assert.match(graphWindow?.description || "", /bounded authorized aggregate graph window/u)
    assert.equal(
      body.result.tools.find((tool) => tool.name === "proof.claim")?.annotations?.readOnlyHint,
      false,
    )
    assert.equal(body.result.tools.some((tool) => "uri" in tool || "module" in tool), false)
  } finally {
    await handler.close()
  }
})

test("MCP leaves existing contract parsing authoritative and returns one bounded structured error", async () => {
  const handler = createGalaxyMcpHandler({ identity: IDENTITY, authStrength: "ambient" })
  try {
    const { response, body } = await mcpExchange(handler, "tools/call", {
      name: "objects.get",
      arguments: {},
    })
    assert.equal(response.status, 200)
    assert.equal(body.result.isError, true)
    assert.deepEqual(body.result.content, [{ type: "text", text: "Galaxy agent tool failed." }])
    assert.equal(body.result.structuredContent.error.code, "invalid_request")
    assert.equal(JSON.stringify(body).includes("call.input.ref is required"), true)
    assert.equal(JSON.stringify(body).match(/gb\.agent-tool-error\.v1/gu)?.length, 1)
  } finally {
    await handler.close()
  }
})

test("MCP successful results appear once in structuredContent with fixed small text", () => {
  const result = {
    schemaId: "gb.agent-tool-result.v1",
    tool: "objects.get",
    result: { object: { id: "object-a" } },
  }
  const output = createMcpToolSuccess(result)
  assert.equal(output.structuredContent, result)
  assert.deepEqual(output.content, [{ type: "text", text: "Galaxy agent tool completed." }])
  assert.equal(JSON.stringify(output).match(/gb\.agent-tool-result\.v1/gu)?.length, 1)
})

test("MCP requires fresh NIP-98 strength for durable mutations but not pure or graph-window reads", async () => {
  const ambient = createGalaxyMcpHandler({ identity: IDENTITY, authStrength: "ambient" })
  const fresh = createGalaxyMcpHandler({ identity: IDENTITY, authStrength: "fresh-nip98" })
  try {
    const denied = await mcpExchange(ambient, "tools/call", { name: "anchors.create", arguments: {} })
    assert.equal(denied.body.result.structuredContent.error.code, "fresh_signature_required")
    const pure = await mcpExchange(ambient, "tools/call", { name: "task.plan.propose", arguments: {} })
    assert.equal(pure.body.result.structuredContent.error.code, "invalid_request")
    const graphRead = await mcpExchange(ambient, "tools/call", {
      name: "graph.window.get", arguments: { workspaceId: "caller-owned" },
    })
    assert.equal(graphRead.body.result.structuredContent.error.code, "invalid_request")
    const hamRead = await mcpExchange(ambient, "tools/call", {
      name: "ham.memory.search", arguments: { tenantId: "caller-owned" },
    })
    assert.equal(hamRead.body.result.structuredContent.error.code, "invalid_request")
    const acceptedAuth = await mcpExchange(fresh, "tools/call", { name: "anchors.create", arguments: {} })
    assert.equal(acceptedAuth.body.result.structuredContent.error.code, "invalid_request")
    const deniedSurface = await mcpExchange(ambient, "tools/call", { name: "surface.draft.create", arguments: {} })
    assert.equal(deniedSurface.body.result.structuredContent.error.code, "fresh_signature_required")
    const acceptedSurfaceAuth = await mcpExchange(fresh, "tools/call", { name: "surface.draft.create", arguments: {} })
    assert.equal(acceptedSurfaceAuth.body.result.structuredContent.error.code, "invalid_request")
    const deniedClaim = await mcpExchange(ambient, "tools/call", { name: "proof.claim", arguments: {} })
    assert.equal(deniedClaim.body.result.structuredContent.error.code, "fresh_signature_required")
    const acceptedClaimAuth = await mcpExchange(fresh, "tools/call", { name: "proof.claim", arguments: {} })
    assert.equal(acceptedClaimAuth.body.result.structuredContent.error.code, "invalid_request")
  } finally {
    await Promise.all([ambient.close(), fresh.close()])
  }
})

test("MCP enforces the nested 64 KiB agent-tool contract inside its 80 KiB envelope", async () => {
  const handler = createGalaxyMcpHandler({ identity: IDENTITY, authStrength: "ambient" })
  try {
    const { body } = await mcpExchange(handler, "tools/call", {
      name: "objects.get",
      arguments: { ref: "x".repeat(66_000) },
    })
    assert.equal(body.result.isError, true)
    assert.equal(body.result.structuredContent.error.code, "request_too_large")
  } finally {
    await handler.close()
  }
})

test("MCP request classification recognizes only exact mutation tool names", () => {
  assert.deepEqual(classifyMcpRequest({ method: "tools/call", params: { name: "canvas.arrange" } }), {
    method: "tools/call", tool: "canvas.arrange", mutation: true,
  })
  assert.equal(classifyMcpRequest({ method: "tools/call", params: { name: "task.plan.propose" } }).mutation, false)
  assert.equal(classifyMcpRequest({ method: "tools/call", params: { name: "graph.window.get" } }).mutation, false)
  assert.equal(classifyMcpRequest({ method: "tools/call", params: { name: "surface.draft.create" } }).mutation, true)
  assert.equal(classifyMcpRequest({ method: "tools/call", params: { name: "proof.claim" } }).mutation, true)
  assert.equal(classifyMcpRequest({ method: "tools/call", params: { name: "canvas.arrange.extra" } }).mutation, false)
  assert.equal(classifyMcpRequest([{ method: "tools/call", params: { name: "canvas.arrange" } }]).mutation, false)
})

class TestContractError extends TypeError {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

async function routeHarness({ responseFactory } = {}) {
  const source = await readFile(new URL("../app/mcp/route.ts", import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const calls = { ambient: [], fresh: [], fetched: [], closed: 0 }
  const sandbox = {
    exports: {}, Response, Request, Headers, URL, Uint8Array, TextDecoder, ReadableStream,
    require(name) {
      if (name === "next/server") return { NextResponse: Response }
      if (name === "@/lib/auth-config") return { getAuthOrigin: () => "https://galaxy.example" }
      if (name === "@/lib/agent-tools/contracts.js") {
        return {
          AgentToolContractError: TestContractError,
          createAgentToolError(error) {
            const safe = error instanceof TestContractError
              ? error
              : new TestContractError("tool_unavailable", "Agent tool is unavailable", 503)
            return { status: safe.status, body: { schemaId: "gb.agent-tool-error.v1", error: { code: safe.code, message: safe.message } } }
          },
        }
      }
      if (name === "@/lib/request-identity") {
        return {
          async getRequestIdentity(_request, bytes) {
            calls.ambient.push(Buffer.from(bytes).toString("utf8"))
            return IDENTITY
          },
          async getVerifiedNostrRequestIdentity(_request, bytes) {
            calls.fresh.push(Buffer.from(bytes).toString("utf8"))
            return IDENTITY
          },
        }
      }
      if (name === "@/lib/agent-tools/mcp.js") {
        return {
          MAX_MCP_REQUEST_BYTES,
          MAX_MCP_RESPONSE_BYTES,
          mcpRequestTooLargeError: () => new TestContractError("request_too_large", "MCP request exceeds 80 KiB", 413),
          classifyMcpRequest(value) {
            const method = value?.method || null
            const tool = method === "tools/call" ? value?.params?.name || null : null
            return {
              method,
              tool,
              mutation: ["anchors.create", "canvas.arrange", "proof.claim", "relations.propose", "surface.draft.create"].includes(tool),
            }
          },
          createGalaxyMcpHandler(authContext) {
            return {
              async fetch(_request, options) {
                calls.fetched.push({ authContext, parsedBody: options.parsedBody })
                return responseFactory ? responseFactory() : Response.json({ jsonrpc: "2.0", id: 1, result: {} })
              },
              async close() { calls.closed += 1 },
            }
          },
        }
      }
      throw new Error(`Unexpected import: ${name}`)
    },
  }
  vm.runInNewContext(compiled, sandbox)
  return { POST: sandbox.exports.POST, calls }
}

function routeRequest(body, path = "/mcp", headers = {}) {
  const url = `https://galaxy.example${path}`
  const request = new Request(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Host: "galaxy.example",
      ...headers,
    },
    body,
  })
  Object.defineProperty(request, "nextUrl", { value: new URL(url) })
  return request
}

test("MCP route sends exact raw mutation bytes only through fresh request-local auth", async () => {
  const { POST, calls } = await routeHarness()
  const mutation = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "relations.propose", arguments: {} } })
  const response = await POST(routeRequest(mutation))
  assert.equal(response.status, 200)
  assert.deepEqual(calls.fresh, [mutation])
  assert.deepEqual(calls.ambient, [])
  assert.equal(calls.fetched[0].authContext.identity, IDENTITY)
  assert.equal(calls.fetched[0].authContext.authStrength, "fresh-nip98")
  assert.equal(calls.fetched[0].parsedBody.params.name, "relations.propose")
  assert.equal(calls.closed, 1)

  const pureBody = JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "task.plan.propose", arguments: {} } })
  await POST(routeRequest(pureBody))
  assert.deepEqual(calls.ambient, [pureBody])
})

test("MCP route rejects queries, wrong origins, batches, subscriptions, and oversized declared bodies before dispatch", async () => {
  const { POST, calls } = await routeHarness()
  const ordinary = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  const cases = [
    routeRequest(ordinary, "/mcp?tenant=other"),
    routeRequest(ordinary, "/mcp", { Origin: "https://evil.example" }),
    routeRequest(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }])),
    routeRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "subscriptions/listen", params: {} })),
    routeRequest(ordinary, "/mcp", { "Content-Length": String(MAX_MCP_REQUEST_BYTES + 1) }),
  ]
  for (const request of cases) assert.notEqual((await POST(request)).status, 200)
  assert.equal(calls.fetched.length, 0)
})

test("MCP route caps a streamed SDK response and redacts the failure", async () => {
  const { POST, calls } = await routeHarness({
    responseFactory: () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_MCP_RESPONSE_BYTES))
        controller.enqueue(new Uint8Array(1))
        controller.close()
      },
    }), { headers: { "Content-Type": "application/json" } }),
  })
  const request = routeRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }))
  const response = await POST(request)
  assert.equal(response.status, 502)
  const body = await response.json()
  assert.equal(body.error.data.error.code, "response_too_large")
  assert.equal(JSON.stringify(body).includes("ReadableStream"), false)
  assert.equal(calls.closed, 1)
})
