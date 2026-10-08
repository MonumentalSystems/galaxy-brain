import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { createHash } from "node:crypto"
import vm from "node:vm"
import ts from "typescript"
import sharp from "sharp"

import { isSafeElnPath, requiredElnScopes } from "../lib/eln-scope.js"
import {
  decodeDurableImportMetadataHeader,
  encodeRasterImageManifestHeader,
  hasRasterImageSignature,
  isRasterImageCandidate,
  MAX_RASTER_IMAGE_BYTES,
  RasterImageContractError,
} from "../lib/raster-image-contract.js"
import { validateRasterImageImport } from "../lib/server/raster-image-validation.js"
import { durableUploadMediaType, IngestionContractError } from "../lib/durable-document-import.js"
import {
  hasWebmSignature,
  isAudioOriginalCandidate,
  MAX_AUDIO_ORIGINAL_BYTES,
} from "../lib/audio-original-contract.js"
import { createDocumentCorpusSearchRequest } from "../lib/document-corpus-search.js"
import {
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "../lib/galaxy-object-reference.js"

const require = createRequire(import.meta.url)
const { getRouteRegex } = require("next/dist/shared/lib/router/utils/route-regex")
const { getRouteMatcher } = require("next/dist/shared/lib/router/utils/route-matcher")
const matchRoute = getRouteMatcher(getRouteRegex("/api/eln/[...path]"))

async function proxyHarness(scopes, {
  tenantWide = false,
  identity = {},
  sessionUser = null,
  upstreamResponseHeaders = {},
  upstreamResponseBody = null,
} = {}) {
  const source = await readFile(new URL("../app/api/eln/[...path]/route.ts", import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const forwarded = []
  const verifiedCalls = []
  const identityBodyBytes = []
  class NextResponse extends Response {
    static json(body, init) { return Response.json(body, init) }
  }
  const sandbox = {
    exports: {}, Headers, TextDecoder, TextEncoder, URL, URLSearchParams,
    crypto: {
      subtle: {
        digest: async (_algorithm, bytes) => createHash("sha256")
          .update(Buffer.from(bytes))
          .digest(),
      },
    },
    process: { env: { GALAXY_API_PROXY_TOKEN: "test-only-proxy-token" } },
    require(name) {
      if (name === "next/server") return { NextResponse }
      if (name === "@/lib/eln-scope") return { isSafeElnPath, requiredElnScopes }
      if (name === "@/lib/raster-image-contract.js") return {
        decodeDurableImportMetadataHeader,
        encodeRasterImageManifestHeader,
        hasRasterImageSignature: (bytes) => hasRasterImageSignature(
          Uint8Array.from(new Uint8Array(bytes)),
        ),
        isRasterImageCandidate,
        MAX_RASTER_IMAGE_BYTES,
        RasterImageContractError,
      }
      if (name === "@/lib/server/raster-image-validation.js") return { validateRasterImageImport }
      if (name === "@/lib/durable-document-import.js") return {
        durableUploadMediaType: (file, bytes) => durableUploadMediaType(
          file,
          Uint8Array.from(new Uint8Array(bytes)).buffer,
        ),
        IngestionContractError,
      }
      if (name === "@/lib/audio-original-contract.js") return {
        hasWebmSignature: (bytes) => hasWebmSignature(
          Uint8Array.from(new Uint8Array(bytes)),
        ),
        isAudioOriginalCandidate,
        MAX_AUDIO_ORIGINAL_BYTES,
      }
      if (name === "@/lib/document-corpus-search.js") return { createDocumentCorpusSearchRequest }
      if (name === "@/lib/galaxy-object-reference.js") return {
        parseGalaxyObjectReference,
        serializeGalaxyObjectReference,
      }
      if (name === "@/lib/request-identity") return {
        getRequestIdentity: async (_request, bodyBytes) => {
          identityBodyBytes.push(bodyBytes?.byteLength ?? null)
          return {
            tenantId: "tenant-a", principalId: "agent-a", kind: "agent", nostrPubkey: null,
            ...identity,
          }
        },
        getVerifiedNostrRequestIdentity: async (_request, bodyBytes) => {
          verifiedCalls.push(bodyBytes.byteLength)
          return {
            tenantId: "tenant-a", principalId: "agent-a", kind: "agent",
            nostrPubkey: "a".repeat(64), ...identity,
          }
        },
        identityCanAny: (_identity, accepted) => tenantWide || accepted.some((scope) =>
          scopes.includes("*") || scopes.includes(scope) || scopes.includes(`${scope.split(":")[0]}:*`),
        ),
      }
      if (name === "@/lib/auth") return {
        getCurrentUser: async () => sessionUser,
      }
      throw new Error(`Unexpected import: ${name}`)
    },
    fetch: async (url, init) => {
      forwarded.push({ url, ...init })
      return upstreamResponseBody === null
        ? Response.json({ ok: true }, { headers: upstreamResponseHeaders })
        : new Response(upstreamResponseBody, { headers: upstreamResponseHeaders })
    },
  }
  vm.runInNewContext(compiled, sandbox)
  return {
    forwarded,
    verifiedCalls,
    identityBodyBytes,
    async request(pathname, method = "POST", body = {}, headers = {}) {
      const serializedBody = body instanceof Uint8Array
        ? body
        : typeof body === "string" ? body : JSON.stringify(body)
      const request = new Request(`http://test.local/api/eln/${pathname}`, {
        method,
        headers,
        ...(["GET", "HEAD"].includes(method) ? {} : { body: serializedBody }),
      })
      request.nextUrl = new URL(request.url)
      return sandbox.exports[method](request, { params: Promise.resolve(matchRoute(request.nextUrl.pathname)) })
    },
  }
}

function importMetadata(filename, sourceKind = "upload") {
  return Buffer.from(JSON.stringify({
    title: "Exact image",
    filename,
    sourceKind,
    sourceUri: sourceKind === "url" ? "https://example.invalid/image.png" : null,
    arxivId: null,
  }), "utf8").toString("base64url")
}

test("surface-only credentials cannot escape their scope through decoded route segments", async () => {
  const proxy = await proxyHarness(["surface:write", "surface:read"])
  for (const path of [
    "surfaces/id%2Fpromote", "surfaces/..%2Fexperiments", "surfaces/..%5Cexperiments",
    "surfaces/id%252Fpromote", "surfaces/%252e%252e/experiments",
    "surfaces/id%3F/promote", "surfaces/id%23/promote", "surfaces/id%00/promote",
  ]) {
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      assert.equal((await proxy.request(path, method)).status, 400, `${method} ${path}`)
    }
  }
  assert.equal(proxy.forwarded.length, 0)
  assert.equal((await proxy.request("surfaces/30000000-0000-4000-8000-000000000001/promote")).status, 403)
  assert.equal((await proxy.request("experiments")).status, 403)
  assert.equal((await proxy.request("surfaces?status=promoted", "GET")).status, 200)
  assert.equal(proxy.forwarded[0].url.pathname, "/surfaces")
  assert.equal(proxy.forwarded[0].url.search, "?status=promoted")
  assert.equal(proxy.forwarded[0].headers.get("X-GB-Tenant-ID"), "tenant-a")
})

test("surface routes are a closed allowlist with exact promoted and revision queries", async () => {
  const reader = await proxyHarness(["surface:read"])
  const surfaceId = "30000000-0000-4000-8000-000000000001"
  for (const path of [
    "surfaces?status=promoted",
    "surfaces?status=promoted&q=vortex&limit=200",
    "surfaces/contract",
    `surfaces/${surfaceId}`,
    `surfaces/${surfaceId}/revisions`,
    `surfaces/${surfaceId}/revisions?limit=100`,
    `surfaces/${surfaceId}/revisions?version=7&limit=1`,
    `surfaces/${surfaceId}/resolve`,
    `surfaces/${surfaceId}/resolve?version=7`,
  ]) assert.equal((await reader.request(path, "GET")).status, 200, path)

  const forwardedCount = reader.forwarded.length
  for (const path of [
    "surfaces",
    "surfaces?status=draft",
    "surfaces?status=promoted&status=promoted",
    "surfaces?status=promoted&unknown=1",
    "surfaces?status=promoted&limit=0",
    `surfaces?status=promoted&q=${"q".repeat(241)}`,
    `surfaces/${surfaceId}/revisions?version=0`,
    `surfaces/${surfaceId}/revisions?version=7&version=7`,
    `surfaces/${surfaceId}/revisions?version=7&limit=2`,
    `surfaces/${surfaceId}/revisions?unknown=1`,
    `surfaces/${surfaceId}/resolve?version=0`,
    `surfaces/${surfaceId}/resolve?version=7&version=7`,
    `surfaces/${surfaceId}/resolve?unknown=1`,
  ]) assert.equal((await reader.request(path, "GET")).status, 422, path)
  assert.equal(reader.forwarded.length, forwardedCount)

  for (const [path, method] of [
    ["surfaces/contract?unknown=1", "GET"],
    ["surfaces/not-a-surface-id", "GET"],
    [`surfaces/${surfaceId}?unknown=1`, "GET"],
    [`surfaces/${surfaceId}/unknown`, "GET"],
    [`surfaces/${surfaceId}/revisions`, "POST"],
    [`surfaces/${surfaceId}/resolve`, "POST"],
    [`surfaces/${surfaceId}`, "DELETE"],
  ]) assert.equal((await reader.request(path, method)).status, 404, `${method} ${path}`)
  assert.equal(reader.forwarded.length, forwardedCount)

  const writer = await proxyHarness(["surface:write"])
  assert.equal((await writer.request("surfaces", "POST", {})).status, 200)
  assert.equal((await writer.request(`surfaces/${surfaceId}`, "PATCH", {})).status, 200)
  assert.equal((await writer.request("surfaces?unknown=1", "POST", {})).status, 404)
  assert.equal((await writer.request(`surfaces/${surfaceId}?unknown=1`, "PATCH", {})).status, 404)
  assert.equal(writer.forwarded.length, 2)

  const promoter = await proxyHarness(["surface:promote"])
  assert.equal((await promoter.request(`surfaces/${surfaceId}/promote`, "POST", {})).status, 200)
  assert.equal((await promoter.request(`surfaces/${surfaceId}/promote?unknown=1`, "POST", {})).status, 404)
  assert.equal(promoter.forwarded.length, 1)
})

test("private aggregate routes cannot cross the generic ELN proxy", async () => {
  const proxy = await proxyHarness(["*"])
  for (const path of ["object-projection-sources", "agent-anchor-creations", "relation-proposals"]) {
    assert.equal((await proxy.request(path, "GET")).status, 404)
    assert.equal((await proxy.request(path, "POST", {})).status, 404)
  }
  assert.equal(proxy.forwarded.length, 0)
})

test("task plan proposal production cannot cross the generic ELN proxy", async () => {
  const proxy = await proxyHarness(["*"])
  assert.equal((await proxy.request("task-plans", "GET")).status, 200)
  assert.equal((await proxy.request("task-plans", "POST", {})).status, 200)
  assert.equal((await proxy.request("task-plans/plan-1", "GET")).status, 200)
  assert.equal((await proxy.request("task-plans/plan-1", "PATCH", {})).status, 200)
  assert.equal((await proxy.request("task-plans/plan-1/revisions", "GET")).status, 200)
  assert.equal((await proxy.request("task-plans/plan-1/proposals", "POST", {})).status, 404)
  assert.equal((await proxy.request("task-plans/plan-1", "DELETE")).status, 404)
  assert.equal(proxy.forwarded.length, 5)
})

test("canonical promotion and paper download routes retain their intended scopes", async () => {
  const promoter = await proxyHarness(["surface:promote"])
  assert.equal((await promoter.request("surfaces/30000000-0000-4000-8000-000000000001/promote")).status, 200)
  assert.equal(promoter.forwarded[0].url.pathname, "/surfaces/30000000-0000-4000-8000-000000000001/promote")
  const reader = await proxyHarness(["eln:read"])
  assert.equal((await reader.request("papers/id/download?revision_id=revision-1", "GET")).status, 200)
  assert.equal(reader.forwarded[0].url.search, "?revision_id=revision-1")
  assert.equal((await reader.request("surfaces", "POST")).status, 403)
})

test("object links use narrow scopes and a bounded authenticated proxy", async () => {
  const reader = await proxyHarness(["object-link:read"])
  assert.equal((await reader.request("object-links?ref=gb%3Aobject%3Av1%3Apaper%3Aid%3Alatest", "GET")).status, 200)
  assert.equal((await reader.request("object-links/50000000-0000-4000-8000-000000000001/history", "GET")).status, 200)
  assert.equal((await reader.request("object-links/50000000-0000-4000-8000-000000000001/retract", "POST", {})).status, 403)
  assert.equal((await reader.request("object-links", "POST", {})).status, 403)
  assert.equal((await reader.request("object-links/other", "GET")).status, 404)
  const human = { tenantId: "tenant-a", principalId: "human-a", kind: "human", nostrPubkey: "b".repeat(64) }
  const sessionUser = { tenantId: "tenant-a", principalId: "human-a", nostrPubkey: "b".repeat(64) }
  const writer = await proxyHarness(["object-link:write"], { identity: human, sessionUser })
  const body = { from_ref: "gb:object:v1:paper:a:latest", to_ref: "gb:object:v1:ham.memory:1:latest" }
  assert.equal((await writer.request("object-links", "POST", body)).status, 200)
  assert.equal(writer.forwarded[0].headers.get("X-GB-Tenant-ID"), "tenant-a")
  assert.equal(writer.forwarded[0].url.pathname, "/object-links")
  assert.equal(writer.forwarded[0].headers.get("X-GB-Human-Session"), "v1")
  assert.equal(writer.identityBodyBytes[0], JSON.stringify(body).length)
  const correction = { expected_version: 1, reason: "wrong", idempotency_key: "retract-link-1" }
  assert.equal((await writer.request("object-links/50000000-0000-4000-8000-000000000001/retract", "POST", correction)).status, 200)
  assert.equal(writer.forwarded[1].url.pathname, "/object-links/50000000-0000-4000-8000-000000000001/retract")
  assert.equal(writer.forwarded[1].headers.get("X-GB-Human-Session"), "v1")
  assert.equal(writer.identityBodyBytes[1], JSON.stringify(correction).length)
  assert.equal((await writer.request("object-links/50000000-0000-4000-8000-000000000001/history", "POST", {})).status, 404)
  assert.equal((await writer.request("object-links", "POST", "x".repeat(32769))).status, 413)
  assert.equal(writer.identityBodyBytes.length, 2)

  for (const options of [
    { identity: human, sessionUser: null },
    { identity: { ...human, principalId: "api-key-human" }, sessionUser },
    { identity: { ...human, kind: "agent", principalId: "agent-a" }, sessionUser: null },
    { identity: { ...human, kind: "service", principalId: "service-a" }, sessionUser: null },
  ]) {
    const denied = await proxyHarness(["object-link:write"], options)
    assert.equal((await denied.request("object-links", "POST", body)).status, 403)
    assert.equal(denied.forwarded.length, 0)
  }
})

test("object reference resolution has one explicit GET shape and read scope", async () => {
  const reference = "gb%3Aobject%3Av1%3Aproof.graph%3Agraph-1%3Apinned%3Asha256%253Aabc"
  const reader = await proxyHarness(["object-link:read"])
  assert.equal((await reader.request(`object-references/resolve?ref=${reference}`, "GET")).status, 200)
  assert.equal(reader.forwarded[0].url.pathname, "/object-references/resolve")
  assert.equal(reader.forwarded[0].url.search, `?ref=${reference}`)
  assert.equal((await reader.request("object-references", "GET")).status, 404)
  assert.equal((await reader.request("object-references/resolve", "POST", {})).status, 404)
  assert.equal((await reader.request("object-references/resolve/extra", "GET")).status, 404)
  const denied = await proxyHarness(["object-link:write"])
  assert.equal((await denied.request(`object-references/resolve?ref=${reference}`, "GET")).status, 403)
  assert.equal(denied.forwarded.length, 0)
})

test("private paper document uploads preserve bounded PDF bytes and require write scope", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.4\nprivate-paper")
  const denied = await proxyHarness(["eln:read"])
  assert.equal((await denied.request(
    "papers/paper-1/document?revision_id=revision-1",
    "PUT",
    pdf,
    { "Content-Type": "application/pdf" },
  )).status, 403)

  const writer = await proxyHarness(["eln:write"])
  assert.equal((await writer.request(
    "papers/paper-1/document?revision_id=revision-1",
    "PUT",
    pdf,
    { "Content-Type": "application/pdf" },
  )).status, 200)
  assert.equal(writer.forwarded[0].headers.get("Content-Type"), "application/pdf")
  assert.deepEqual(new Uint8Array(writer.forwarded[0].body), pdf)

  const oversized = await proxyHarness(["eln:write"])
  assert.equal((await oversized.request(
    "papers/paper-1/document?revision_id=revision-1",
    "PUT",
    pdf,
    { "Content-Type": "application/pdf", "Content-Length": "100000001" },
  )).status, 413)
  assert.equal(oversized.forwarded.length, 0)

  const bridge = await proxyHarness(["eln:write"])
  assert.equal((await bridge.request(
    "papers/paper-1/document/bridge?revision_id=revision-1",
    "POST",
    "",
  )).status, 200)
  assert.equal(bridge.forwarded[0].url.pathname, "/papers/paper-1/document/bridge")
  assert.equal(bridge.forwarded[0].url.search, "?revision_id=revision-1")
  assert.equal(bridge.forwarded[0].body, undefined)
  assert.equal((await bridge.request(
    "papers/paper-1/document/bridge?revision_id=revision-1",
    "POST",
    { unexpected: true },
  )).status, 400)
  assert.equal(bridge.forwarded.length, 1)

  const bridgeDenied = await proxyHarness(["eln:read"])
  assert.equal((await bridgeDenied.request(
    "papers/paper-1/document/bridge?revision_id=revision-1",
    "POST",
    "",
  )).status, 403)
  assert.equal(bridgeDenied.forwarded.length, 0)
})

test("private arXiv fetch is an exact bodyless paper-document write", async () => {
  assert.deepEqual(requiredElnScopes("POST", ["papers", "paper-1", "document", "fetch"]), {
    primary: "eln:write",
    accepted: ["eln:write"],
  })

  const denied = await proxyHarness(["eln:read"])
  assert.equal((await denied.request(
    "papers/paper-1/document/fetch?revision_id=revision-1",
    "POST",
    "",
  )).status, 403)
  assert.equal(denied.forwarded.length, 0)

  const writer = await proxyHarness(["eln:write"], {
    identity: {
      tenantId: "tenant-private", principalId: "researcher-1", kind: "human", nostrPubkey: "b".repeat(64),
    },
  })
  assert.equal((await writer.request(
    "papers/paper-1/document/fetch?revision_id=revision-1",
    "POST",
    "",
  )).status, 200)
  assert.equal(writer.forwarded[0].url.pathname, "/papers/paper-1/document/fetch")
  assert.equal(writer.forwarded[0].url.search, "?revision_id=revision-1")
  assert.equal(writer.forwarded[0].body, undefined)
  assert.equal(writer.forwarded[0].headers.get("X-GB-Tenant-ID"), "tenant-private")
  assert.equal(writer.forwarded[0].headers.get("X-GB-Principal-ID"), "researcher-1")
  assert.equal(writer.forwarded[0].headers.get("X-GB-Principal-Kind"), "human")
  assert.equal(writer.forwarded[0].headers.get("X-GB-Nostr-Pubkey"), "b".repeat(64))
  assert.equal(writer.forwarded[0].headers.get("X-GB-Proxy-Token"), "test-only-proxy-token")
  assert.equal(writer.identityBodyBytes[0], null)

  assert.equal((await writer.request(
    "papers/paper-1/document/fetch?revision_id=revision-1",
    "POST",
    { url: "https://example.invalid/not-allowed" },
  )).status, 400)
  assert.equal((await writer.request(
    "papers/paper-1/document/fetch/extra?revision_id=revision-1",
    "POST",
    "",
  )).status, 404)
  assert.equal((await writer.request(
    "papers/paper-1/document/fetch?revision_id=revision-1",
    "GET",
  )).status, 404)
  assert.equal(writer.forwarded.length, 1)
})

test("document proxy authors one trusted raster manifest after full decode and never forwards a client manifest", async () => {
  const bytes = new Uint8Array(await sharp({
    create: { width: 6, height: 4, channels: 4, background: "#205080ff" },
  }).png().toBuffer())
  const writer = await proxyHarness(["document:write"])
  const response = await writer.request("documents/import", "POST", bytes, {
    "Content-Type": "image/png",
    "Idempotency-Key": "document-import:raster-proxy-test",
    "X-GB-Import-Metadata": importMetadata("figure.png"),
    "X-GB-Raster-Image": "attacker-authored",
  })
  assert.equal(response.status, 200)
  assert.equal(writer.forwarded.length, 1)
  const header = writer.forwarded[0].headers.get("X-GB-Raster-Image")
  assert.notEqual(header, "attacker-authored")
  const manifest = JSON.parse(Buffer.from(header, "base64url").toString("utf8"))
  assert.equal(manifest.schemaId, "gb.raster-image.v1")
  assert.equal(manifest.mediaType, "image/png")
  assert.equal(manifest.width, 6)
  assert.equal(manifest.height, 4)
  assert.equal(manifest.frameCount, 1)
  assert.equal(writer.identityBodyBytes.at(-1), bytes.byteLength)
})

test("document proxy rejects mismatched, animated, URL, audio, and oversized raster requests before upstream", async () => {
  const png = new Uint8Array(await sharp({
    create: { width: 2, height: 2, channels: 4, background: "#205080ff" },
  }).png().toBuffer())
  const frames = Buffer.alloc(2 * 4 * 4)
  for (let pixel = 0; pixel < 8; pixel += 1) {
    frames[(pixel * 4) + (pixel < 4 ? 0 : 2)] = 255
    frames[(pixel * 4) + 3] = 255
  }
  const animated = new Uint8Array(await sharp(frames, {
    raw: { width: 2, height: 4, channels: 4, pageHeight: 2 },
  }).gif({ delay: [100, 100] }).toBuffer())
  const cases = [
    [png, { "Content-Type": "image/jpeg", "X-GB-Import-Metadata": importMetadata("figure.png") }, 415],
    [animated, { "Content-Type": "image/gif", "X-GB-Import-Metadata": importMetadata("animated.gif") }, 415],
    [png, { "Content-Type": "image/png", "X-GB-Import-Metadata": importMetadata("figure.png", "url") }, 415],
    [new Uint8Array([1, 2, 3]), { "Content-Type": "audio/mpeg", "X-GB-Import-Metadata": importMetadata("audio.mp3") }, 415],
    [new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]), {
      "Content-Type": "text/plain", "X-GB-Import-Metadata": importMetadata("renamed-audio.txt"),
    }, 415],
    [png, {
      "Content-Type": "image/png",
      "Content-Length": String(MAX_RASTER_IMAGE_BYTES + 1),
      "X-GB-Import-Metadata": importMetadata("figure.png"),
    }, 413],
  ]
  for (const [body, headers, status] of cases) {
    const writer = await proxyHarness(["document:write"])
    const response = await writer.request("documents/import", "POST", body, {
      "Idempotency-Key": "document-import:raster-reject-test",
      ...headers,
    })
    assert.equal(response.status, status)
    assert.equal(writer.forwarded.length, 0)
  }

  const streamedOversize = new Uint8Array(MAX_RASTER_IMAGE_BYTES + 1)
  streamedOversize.set(png.subarray(0, 8))
  const writer = await proxyHarness(["document:write"])
  const response = await writer.request("documents/import", "POST", streamedOversize, {
    "Content-Type": "image/png",
    "X-GB-Import-Metadata": importMetadata("figure.png"),
  })
  assert.equal(response.status, 413)
  assert.match(await response.text(), /20 MiB/u)
  assert.equal(writer.forwarded.length, 0)

  const disguisedRaster = new Uint8Array(MAX_RASTER_IMAGE_BYTES + 1)
  disguisedRaster.set(png.subarray(0, 8))
  const disguisedWriter = await proxyHarness(["document:write"])
  const disguisedResponse = await disguisedWriter.request("documents/import", "POST", disguisedRaster, {
    "Content-Type": "text/plain",
    "X-GB-Import-Metadata": importMetadata("payload.txt"),
  })
  assert.equal(disguisedResponse.status, 413, await disguisedResponse.clone().text())
  assert.match(await disguisedResponse.text(), /20 MiB/u)
  assert.equal(disguisedWriter.forwarded.length, 0)
})

test("ordinary ELN routes retain their existing scopes", () => {
  assert.deepEqual(requiredElnScopes("GET", ["experiments"]), {
    primary: "eln:read",
    accepted: ["eln:read"],
  })
  assert.deepEqual(requiredElnScopes("PATCH", ["experiments", "experiment-1"]), {
    primary: "eln:write",
    accepted: ["eln:write"],
  })
})

test("experiment creation forwards one bounded idempotent request", async () => {
  const denied = await proxyHarness(["eln:read"])
  assert.equal((await denied.request("experiments", "POST", { title: "Trial" })).status, 403)

  const writer = await proxyHarness(["eln:write"])
  const body = { title: "Vortex trial", tags: ["vortex"] }
  assert.equal((await writer.request("experiments", "POST", body)).status, 422)
  assert.equal((await writer.request(
    "experiments", "POST", body, { "Idempotency-Key": "short" },
  )).status, 422)
  assert.equal(writer.forwarded.length, 0)

  assert.equal((await writer.request(
    "experiments", "POST", body, { "Idempotency-Key": "experiment-create-1" },
  )).status, 200)
  assert.equal(writer.forwarded.length, 1)
  assert.equal(writer.forwarded[0].headers.get("Idempotency-Key"), "experiment-create-1")
  assert.equal(writer.identityBodyBytes.at(-1), JSON.stringify(body).length)
  assert.equal(new TextDecoder().decode(writer.forwarded[0].body), JSON.stringify(body))

  assert.equal((await writer.request(
    "experiments",
    "POST",
    "x".repeat(262_145),
    { "Idempotency-Key": "experiment-create-2" },
  )).status, 413)
  assert.equal(writer.forwarded.length, 1)
})

test("the browser API requires and forwards an experiment idempotency key", async () => {
  const source = await readFile(new URL("../lib/galaxy-brain-api.ts", import.meta.url), "utf8")
  assert.match(source, /createExperiment\(data: CreateExperimentInput, idempotencyKey: string\)/)
  assert.match(
    source,
    /createExperiment[\s\S]*?headers: \{ "Idempotency-Key": idempotencyKey \}[\s\S]*?JSON\.stringify\(data\)/,
  )
})

test("observation routes are exact, bounded, and forward only the strict operation key", async () => {
  const experimentId = "55555555-5555-4555-8555-555555555555"
  const operationId = "44444444-4444-4444-8444-444444444444"
  const body = { schemaId: "gb.eln-observation-create.v1", body: "Stable reading", observedAt: null }
  const reader = await proxyHarness(["eln:read"])
  assert.equal((await reader.request(`experiments/${experimentId}/observations`, "GET")).status, 200)
  assert.equal((await reader.request(`experiments/${experimentId}/observations?limit=1`, "GET")).status, 422)

  const human = { tenantId: "tenant-a", principalId: "human-a", kind: "human", nostrPubkey: null }
  const sessionUser = { tenantId: "tenant-a", principalId: "human-a" }
  const writer = await proxyHarness(["eln:write"], { identity: human, sessionUser })
  assert.equal((await writer.request(`experiments/${experimentId}/observations`, "POST", body)).status, 422)
  assert.equal((await writer.request(
    `experiments/${experimentId}/observations`, "POST", body,
    { "Idempotency-Key": `eln-observation:${operationId}` },
  )).status, 200)
  assert.equal(writer.forwarded[0].headers.get("Idempotency-Key"), `eln-observation:${operationId}`)
  assert.equal(writer.forwarded[0].headers.get("X-GB-Human-Session"), "v1")
  assert.equal(new TextDecoder().decode(writer.forwarded[0].body), JSON.stringify(body))
  assert.equal((await writer.request(
    `experiments/${experimentId}/observations`, "POST", "x".repeat(32_769),
    { "Idempotency-Key": `eln-observation:${operationId}` },
  )).status, 413)
  assert.equal(writer.forwarded.length, 1)

  for (const options of [
    { identity: { ...human, kind: "agent", principalId: "agent-a" }, sessionUser: null },
    { identity: { ...human, kind: "service", principalId: "service-a" }, sessionUser: null },
    { identity: human, sessionUser: null },
    { identity: { ...human, principalId: "other-human" }, sessionUser },
  ]) {
    const denied = await proxyHarness(["eln:write"], options)
    assert.equal((await denied.request(
      `experiments/${experimentId}/observations`, "POST", body,
      { "Idempotency-Key": `eln-observation:${operationId}` },
    )).status, 403)
    assert.equal(denied.forwarded.length, 0)
  }
})

test("document anchor routes are explicit, bounded, and authenticate the exact body", async () => {
  const revision = "40000000-0000-4000-8000-000000000001"
  const anchor = `sha256:${"a".repeat(64)}`
  const reader = await proxyHarness(["document:read"])
  assert.equal((await reader.request(`documents/${revision}/anchors`, "GET")).status, 200)
  assert.equal((await reader.request(`documents/${revision}/anchors/${anchor}`, "GET")).status, 200)
  assert.equal((await reader.request(`documents/${revision}/anchors/${anchor}`, "POST", {})).status, 404)

  const writer = await proxyHarness(["document:write"])
  const body = {
    representation_id: "50000000-0000-4000-8000-000000000001",
    selector: { kind: "text-quote", exact: "exact evidence" },
  }
  assert.equal((await writer.request(`documents/${revision}/anchors`, "POST", body)).status, 200)
  assert.equal(writer.forwarded[0].url.pathname, `/documents/${revision}/anchors`)
  assert.equal(writer.identityBodyBytes[0], JSON.stringify(body).length)
  assert.equal(new TextDecoder().decode(writer.forwarded[0].body), JSON.stringify(body))
  assert.equal((await writer.request(
    `documents/${revision}/anchors`, "POST", "x".repeat(131_073),
  )).status, 413)
  assert.equal(writer.forwarded.length, 1)
})

test("document reader content and mark routes are explicit and bounded", async () => {
  const revision = "40000000-0000-4000-8000-000000000001"
  const representation = "50000000-0000-4000-8000-000000000001"
  const anchor = `sha256:${"a".repeat(64)}`
  const mark = "60000000-0000-4000-8000-000000000001"
  const reader = await proxyHarness(["document:read"], {
    upstreamResponseHeaders: { "Cache-Control": "private, no-store" },
  })
  assert.equal((await reader.request(`documents/${revision}`, "GET")).status, 200)
  assert.equal(reader.forwarded[0].url.pathname, `/documents/${revision}`)
  const contentResponse = await reader.request(
    `documents/${revision}/representations/${representation}/content`, "GET", {},
    { Range: "bytes=0-99" },
  )
  assert.equal(contentResponse.status, 200)
  assert.equal(contentResponse.headers.get("Cache-Control"), "private, no-store")
  assert.equal(reader.forwarded[1].url.pathname, `/documents/${revision}/representations/${representation}/content`)
  assert.equal(reader.forwarded[1].headers.get("Range"), "bytes=0-99")
  assert.equal((await reader.request(
    `documents/${revision}/anchors/${anchor}/marks`, "GET", {},
    { "X-GB-Human-Session": "caller-spoof" },
  )).status, 200)
  assert.equal(reader.forwarded[2].headers.get("X-GB-Human-Session"), null)
  assert.equal((await reader.request(`documents/${revision}/anchors/${anchor}/backlinks`, "GET")).status, 200)
  assert.equal((await reader.request(`documents/${revision}/marks/${mark}`, "GET")).status, 200)
  assert.equal((await reader.request(`documents/${revision}/marks/${mark}`, "POST", {})).status, 404)
  assert.equal((await reader.request(`document-anchors/${anchor}`, "GET")).status, 200)
  assert.equal(reader.forwarded.at(-1).url.pathname, `/document-anchors/${encodeURIComponent(anchor)}`)
  assert.equal((await reader.request(`document-anchors/${anchor}`, "POST", {})).status, 404)

  const human = { tenantId: "tenant-a", principalId: "human-a", kind: "human", nostrPubkey: "b".repeat(64) }
  const sessionUser = { tenantId: "tenant-a", principalId: "human-a", nostrPubkey: "b".repeat(64) }
  const writer = await proxyHarness(["document:write"], { identity: human, sessionUser })
  const create = {
    kind: "note", body_markdown: "A $\\LaTeX$ note", color: "#6d7a68",
    semantic_role: "note", tags: ["vortex"], state: "active",
    idempotency_key: "reader-mark-create-1",
  }
  assert.equal((await writer.request(
    `documents/${revision}/anchors/${anchor}/marks`, "POST", create,
  )).status, 200)
  assert.equal(writer.forwarded[0].headers.get("X-GB-Human-Session"), "v1")
  const update = {
    expected_version: 1, body_markdown: "Revised", idempotency_key: "reader-mark-update-1",
  }
  assert.equal((await writer.request(`documents/${revision}/marks/${mark}`, "PATCH", update)).status, 200)
  assert.equal(writer.forwarded[1].headers.get("X-GB-Human-Session"), "v1")
  assert.equal(writer.identityBodyBytes[0], JSON.stringify(create).length)
  assert.equal(writer.identityBodyBytes[1], JSON.stringify(update).length)
  assert.equal((await writer.request(
    `documents/${revision}/marks/${mark}`, "PATCH", "x".repeat(131_073),
  )).status, 413)
  assert.equal(writer.forwarded.length, 2)

  for (const options of [
    { identity: human, sessionUser: null },
    { identity: { ...human, principalId: "api-key-human" }, sessionUser },
    { identity: { ...human, kind: "agent", principalId: "agent-a" }, sessionUser: null },
    { identity: { ...human, kind: "service", principalId: "service-a" }, sessionUser: null },
  ]) {
    const denied = await proxyHarness(["document:write"], options)
    assert.equal((await denied.request(
      `documents/${revision}/anchors/${anchor}/marks`, "POST", create,
      { "X-GB-Human-Session": "v1" },
    )).status, 403)
    assert.equal((await denied.request(
      `documents/${revision}/marks/${mark}`, "PATCH", update,
      { "X-GB-Human-Session": "v1" },
    )).status, 403)
    assert.equal(denied.forwarded.length, 0)
  }

  const anchorWriter = await proxyHarness(["document:write"], { identity: human, sessionUser })
  assert.equal((await anchorWriter.request(
    `documents/${revision}/anchors`, "POST",
    { representation_id: representation, representation_sha256: "b".repeat(64), selector: {
      kind: "text-quote", exact: "evidence",
    } },
    { "X-GB-Human-Session": "v1" },
  )).status, 200)
  assert.equal(anchorWriter.forwarded[0].headers.get("X-GB-Human-Session"), null)
})

test("durable canvas routes use narrow scopes, explicit shapes, and bounded bodies", async () => {
  assert.deepEqual(requiredElnScopes("GET", ["canvases", "canvas-1"]), {
    primary: "canvas:read",
    accepted: ["canvas:read"],
  })
  assert.deepEqual(requiredElnScopes("POST", ["canvases", "canvas-1", "mutations"]), {
    primary: "canvas:write",
    accepted: ["canvas:write"],
  })
  const reader = await proxyHarness(["canvas:read"])
  assert.equal((await reader.request("canvases?workspace_id=workspace-1", "GET")).status, 200)
  assert.equal((await reader.request("canvases/canvas-1", "GET")).status, 200)
  assert.equal((await reader.request("canvases/canvas-1/revisions", "GET")).status, 200)
  assert.equal((await reader.request("canvases/canvas-1/mutations", "GET")).status, 404)
  assert.equal((await reader.request("canvases", "POST", {})).status, 403)

  const writer = await proxyHarness(["canvas:write"])
  const body = {
    expectedVersion: 1,
    expectedContentHash: `sha256:${"a".repeat(64)}`,
    idempotencyKey: "canvas-mutation-1",
    commands: [{ type: "item.remove", itemId: "item-1" }],
  }
  assert.equal((await writer.request("canvases/canvas-1/mutations", "POST", body)).status, 200)
  assert.equal(writer.identityBodyBytes[0], JSON.stringify(body).length)
  assert.equal(new TextDecoder().decode(writer.forwarded[0].body), JSON.stringify(body))
  assert.equal((await writer.request("canvases/canvas-1/unknown", "POST", {})).status, 404)

  const oversized = await proxyHarness(["canvas:write"])
  assert.equal((await oversized.request(
    "canvases/canvas-1/mutations",
    "POST",
    "x".repeat(262_145),
  )).status, 413)
  assert.equal(oversized.forwarded.length, 0)
})

test("conversation Markdown export forwards only one matching exact chat reference", async () => {
  const conversationId = "3abcdef0-0000-4000-8000-000000000001"
  const requestConversationId = conversationId.toUpperCase()
  const revision = `sha256:${"a".repeat(64)}`
  const reference = `gb:object:v1:chat:${requestConversationId}:pinned:${encodeURIComponent(revision)}`
  const markdown = "# Exact conversation\n"
  const digest = createHash("sha256").update(markdown).digest("hex")
  const reader = await proxyHarness(["conversation:read"], {
    upstreamResponseBody: markdown,
    upstreamResponseHeaders: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": "attachment; filename=exact.md",
      "Content-Length": String(Buffer.byteLength(markdown)),
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "ETag": `"sha256-${digest}"`,
      "X-Content-SHA256": digest,
      "X-Content-Type-Options": "nosniff",
    },
  })
  const response = await reader.request(
    `conversations/${requestConversationId}/exports/markdown?conversation_ref=${encodeURIComponent(reference)}`,
    "GET",
  )
  assert.equal(response.status, 200)
  assert.equal(reader.forwarded.length, 1)
  assert.equal(reader.forwarded[0].url.pathname, `/conversations/${requestConversationId}/exports/markdown`)
  assert.equal(reader.forwarded[0].url.searchParams.get("conversation_ref"), reference)
  assert.equal(response.headers.get("Content-Disposition"), "attachment; filename=exact.md")
  assert.equal(response.headers.get("Cache-Control"), "private, no-store")
  assert.equal(response.headers.get("Content-Security-Policy"), "sandbox; default-src 'none'")
  assert.equal(response.headers.get("Content-Length"), String(Buffer.byteLength(markdown)))
  assert.equal(response.headers.get("ETag"), `"sha256-${digest}"`)
  assert.equal(response.headers.get("X-Content-SHA256"), digest)
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff")

  for (const invalid of [
    `conversations/${requestConversationId}/exports/markdown`,
    `conversations/${requestConversationId}/exports/markdown?conversation_ref=${encodeURIComponent(reference)}&extra=1`,
    `conversations/${requestConversationId}/exports/markdown?conversation_ref=${encodeURIComponent(reference)}&conversation_ref=${encodeURIComponent(reference)}`,
    `conversations/${requestConversationId}/exports/markdown?conversation_ref=${encodeURIComponent(`gb:object:v1:chat:${requestConversationId}:latest`)}`,
    `conversations/${requestConversationId}/exports/markdown?conversation_ref=${encodeURIComponent(reference.replace(requestConversationId, "30000000-0000-4000-8000-000000000002"))}`,
  ]) assert.equal((await reader.request(invalid, "GET")).status, 422)
  assert.equal(reader.forwarded.length, 1)

  const oversized = await proxyHarness(["conversation:read"], {
    upstreamResponseHeaders: { "Content-Length": "16777217" },
  })
  assert.equal((await oversized.request(
    `conversations/${requestConversationId}/exports/markdown?conversation_ref=${encodeURIComponent(reference)}`,
    "GET",
  )).status, 502)

  for (const upstream of [
    {
      upstreamResponseBody: markdown,
      upstreamResponseHeaders: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Length": "1",
        "ETag": `"sha256-${digest}"`,
        "X-Content-SHA256": digest,
      },
    },
    {
      upstreamResponseBody: markdown,
      upstreamResponseHeaders: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Length": String(Buffer.byteLength(markdown)),
        "ETag": `"sha256-${"b".repeat(64)}"`,
        "X-Content-SHA256": "b".repeat(64),
      },
    },
  ]) {
    const inconsistent = await proxyHarness(["conversation:read"], upstream)
    assert.equal((await inconsistent.request(
      `conversations/${requestConversationId}/exports/markdown?conversation_ref=${encodeURIComponent(reference)}`,
      "GET",
    )).status, 502)
  }
})

test("surface reads and draft writes have narrow scopes with legacy compatibility", () => {
  assert.deepEqual(requiredElnScopes("GET", ["surfaces"]), {
    primary: "surface:read",
    accepted: ["surface:read", "eln:read"],
  })
  assert.deepEqual(requiredElnScopes("POST", ["surfaces"]), {
    primary: "surface:write",
    accepted: ["surface:write", "eln:write"],
  })
  assert.deepEqual(requiredElnScopes("PATCH", ["surfaces", "surface-1"]), {
    primary: "surface:write",
    accepted: ["surface:write", "eln:write"],
  })
})

test("task plan reads and writes have narrow scopes with ELN compatibility", () => {
  assert.deepEqual(requiredElnScopes("GET", ["task-plans"]), {
    primary: "task-plan:read",
    accepted: ["task-plan:read", "eln:read"],
  })
  assert.deepEqual(requiredElnScopes("PATCH", ["task-plans", "plan-1"]), {
    primary: "task-plan:write",
    accepted: ["task-plan:write", "eln:write"],
  })
})

test("proof work is tenant-wide and requires fresh Nostr proof for every mutation", async () => {
  assert.deepEqual(requiredElnScopes("GET", ["proof-workspaces", "workspace-1"]), {
    primary: "proof-work:read",
    accepted: ["proof-work:read"],
  })
  assert.deepEqual(requiredElnScopes("POST", ["proof-workspaces", "workspace-1", "transitions"]), {
    primary: "proof-work:invalid-transition",
    accepted: ["proof-work:invalid-transition"],
  })
  assert.deepEqual(requiredElnScopes("POST", ["proof-workspaces", "workspace-1", "transitions"], "proof.verify"), {
    primary: "proof-work:invalid-transition",
    accepted: ["proof-work:invalid-transition"],
  })
  assert.deepEqual(requiredElnScopes(
    "POST",
    ["proof-workspaces", "workspace-1", "nodes", "node-1", "verify"],
  ), {
    primary: "proof-work:verify",
    accepted: ["proof-work:verify"],
  })
  assert.deepEqual(requiredElnScopes("POST", ["proof-workspaces", "workspace-1", "transitions"], "proof.attest"), {
    primary: "proof-work:execute",
    accepted: ["proof-work:execute"],
  })
  assert.deepEqual(requiredElnScopes("POST", ["proof-workspaces", "workspace-1", "transitions"], "proof.override"), {
    primary: "proof-work:override",
    accepted: ["proof-work:override"],
  })
  assert.deepEqual(requiredElnScopes("POST", ["proof-workspaces", "workspace-1", "transitions"], "proof.supersede"), {
    primary: "proof-work:admin",
    accepted: ["proof-work:admin"],
  })
  const writer = await proxyHarness([], {
    tenantWide: true,
    identity: { principalId: "human-member", kind: "human", role: "member" },
  })
  assert.equal((await writer.request(
    "proof-workspaces/workspace-1/transitions",
    "POST",
    { transition: { type: "claim.acquire" } },
  )).status, 200)
  assert.equal(writer.verifiedCalls.length, 1)
  assert.ok(writer.verifiedCalls[0] > 0)
  assert.equal((await writer.request(
    "proof-workspaces/workspace-1/transitions",
    "POST",
    { transition: { type: "proof.verify", payload: { verification: {} } } },
  )).status, 400)
  assert.equal(writer.verifiedCalls.length, 2)
  assert.equal((await writer.request(
    "proof-workspaces/workspace-1/nodes/node-1/verify",
    "POST",
    { schema_id: "galaxy.trusted-proof-verification-request.v1" },
  )).status, 200)
  assert.equal(writer.verifiedCalls.length, 3)
  assert.equal((await writer.request(
    "proof-workspaces/workspace-1/nodes/node-1/verify/extra",
    "POST",
    {},
  )).status, 404)
})

test("proof graph registry preserves exact bytes behind narrow read and signed write scopes", async () => {
  assert.deepEqual(requiredElnScopes("GET", ["proof-graphs"]), {
    primary: "proof-graph:read",
    accepted: ["proof-graph:read"],
  })
  assert.deepEqual(requiredElnScopes("POST", ["proof-graphs"]), {
    primary: "proof-graph:write",
    accepted: ["proof-graph:write"],
  })
  assert.deepEqual(requiredElnScopes("POST", ["proof-graphs", "digest", "mission-candidates"]), {
    primary: "proof-graph:read",
    accepted: ["proof-graph:read"],
  })
  const reader = await proxyHarness(["proof-graph:read"])
  assert.equal((await reader.request("proof-graphs", "GET")).status, 200)
  const exactReader = await proxyHarness(["proof-graph:read"], {
    upstreamResponseHeaders: {
      "X-Proof-Graph-ID": "leanproofs",
      "X-Proof-Graph-Kind": "repository-field",
    },
  })
  const exact = await exactReader.request(`proof-graphs/${"a".repeat(64)}`, "GET")
  assert.equal(exact.status, 200)
  assert.equal(exact.headers.get("X-Proof-Graph-ID"), "leanproofs")
  assert.equal(exact.headers.get("X-Proof-Graph-Kind"), "repository-field")
  assert.equal((await reader.request(`proof-graphs/${"a".repeat(64)}/extra`, "GET")).status, 404)
  const intent = {
    schema_id: "galaxy.proof-mission-intent.v1",
    source_graph: {
      graph_id: "leanproofs",
      graph_kind: "repository-field",
      content_sha256: "a".repeat(64),
    },
    mission_id: "prove-main-v1",
    main_target_id: "main",
    curated_milestone_target_ids: [],
    relation_direction: "prerequisite-to-dependent",
  }
  assert.equal((await reader.request(
    `proof-graphs/${"a".repeat(64)}/mission-candidates`, "POST", intent,
  )).status, 200)
  assert.equal(reader.identityBodyBytes.at(-1), JSON.stringify(intent).length)
  assert.equal(reader.verifiedCalls.length, 0)
  assert.equal(
    reader.forwarded.at(-1).url.pathname,
    `/proof-graphs/${"a".repeat(64)}/mission-candidates`,
  )
  assert.equal((await reader.request(
    `proof-graphs/${"a".repeat(64)}/mission-candidates`, "POST", "x".repeat(65_537),
  )).status, 413)

  const writer = await proxyHarness(["proof-graph:write"])
  const artifact = JSON.stringify({
    schema_id: "galaxy.proof-dag.v1",
    graph_id: "graph-1",
    graph_kind: "repository-field",
    targets: [{ target_id: "node-1" }],
    relations: [],
  })
  assert.equal((await writer.request("proof-graphs", "POST", artifact)).status, 200)
  assert.equal(writer.verifiedCalls[0], artifact.length)
  assert.equal(new TextDecoder().decode(writer.forwarded[0].body), artifact)
  assert.equal((await writer.request(
    "proof-graphs", "POST", "x".repeat(16_777_217), { "Content-Length": "1" },
  )).status, 413)
  assert.equal(writer.forwarded.length, 1)
})

test("formal project package import forwards one exact signed bounded envelope", async () => {
  assert.deepEqual(requiredElnScopes("GET", ["formal-project-packages", "a".repeat(64)]), {
    primary: "proof-graph:read",
    accepted: ["proof-graph:read"],
  })
  assert.deepEqual(requiredElnScopes("POST", ["formal-project-packages"]), {
    primary: "proof-graph:write",
    accepted: ["proof-graph:write"],
  })
  const reader = await proxyHarness(["proof-graph:read"])
  assert.equal((await reader.request(`formal-project-packages/${"a".repeat(64)}`, "GET")).status, 200)
  assert.equal((await reader.request("formal-project-packages", "GET")).status, 404)
  assert.equal((await reader.request(`formal-project-packages/${"a".repeat(64)}/extra`, "GET")).status, 404)

  const writer = await proxyHarness(["proof-graph:write"])
  const envelope = Uint8Array.from([0x47, 0x42, 0x46, 0x50, 0x50, 0x31, 0, 0, 1, 2, 3, 4])
  const response = await writer.request("formal-project-packages", "POST", envelope, {
    "Content-Type": "application/vnd.galaxy.formal-project-package",
  })
  assert.equal(response.status, 200)
  assert.deepEqual(writer.verifiedCalls, [envelope.byteLength])
  assert.deepEqual([...new Uint8Array(writer.forwarded[0].body)], [...envelope])
  assert.equal(writer.forwarded[0].headers.get("Content-Type"), "application/vnd.galaxy.formal-project-package")
  assert.equal((await writer.request("formal-project-packages", "POST", envelope, {
    "Content-Length": "50397209",
  })).status, 413)
  assert.equal(writer.forwarded.length, 1)
})

test("proof mission activation is an exact signed admin mutation with a 128 KiB cap", async () => {
  const graphHash = "a".repeat(64)
  const path = `proof-graphs/${graphHash}/mission-activations`
  assert.deepEqual(requiredElnScopes("POST", ["proof-graphs", graphHash, "mission-activations"]), {
    primary: "proof-work:admin",
    accepted: ["proof-work:admin"],
  })

  const activation = JSON.stringify({
    schema_id: "galaxy.proof-mission-activation.v1",
    verification_set_sha256: "b".repeat(64),
    workspace_id: "prove-main-v1",
    idempotency_key: "activate-prove-main-v1",
  })
  const admin = await proxyHarness(["proof-work:admin"])
  assert.equal((await admin.request(path, "POST", activation)).status, 200)
  assert.equal(admin.verifiedCalls[0], activation.length)
  assert.equal(new TextDecoder().decode(admin.forwarded[0].body), activation)
  assert.equal(admin.forwarded[0].url.pathname, `/${path}`)

  const graphWriter = await proxyHarness(["proof-graph:write"])
  assert.equal((await graphWriter.request(path, "POST", activation)).status, 403)
  assert.equal((await admin.request(path, "POST", "x".repeat(131_073))).status, 413)
  assert.equal((await admin.request(`${path}/extra`, "POST", activation)).status, 404)
})

test("proof verification set registry preserves exact bytes behind narrow read and signed write scopes", async () => {
  assert.deepEqual(requiredElnScopes("GET", ["proof-verification-sets"]), {
    primary: "proof-verification:read",
    accepted: ["proof-verification:read"],
  })
  assert.deepEqual(requiredElnScopes("POST", ["proof-verification-sets"]), {
    primary: "proof-verification:write",
    accepted: ["proof-verification:write"],
  })
  const reader = await proxyHarness(["proof-verification:read"])
  assert.equal((await reader.request("proof-verification-sets", "GET")).status, 200)
  assert.equal((await reader.request(
    `proof-verification-sets/${"a".repeat(64)}`,
    "GET",
  )).status, 200)
  assert.equal((await reader.request("proof-verification-sets/not-a-hash/extra", "GET")).status, 404)

  const body = {
    schema_id: "galaxy.proof-verification-set.v1",
    graph_ref: { graph_id: "leanproofs", content_sha256: "a".repeat(64) },
    items: [],
  }
  const writer = await proxyHarness(["proof-verification:write"])
  assert.equal((await writer.request("proof-verification-sets", "POST", body)).status, 200)
  assert.equal(writer.verifiedCalls.length, 1)
  assert.ok(writer.verifiedCalls[0] > 0)
  assert.equal((await reader.request("proof-verification-sets", "POST", body)).status, 403)
  assert.equal((await writer.request(
    "proof-verification-sets",
    "POST",
    "x".repeat(16_777_217),
    { "Content-Length": "1" },
  )).status, 413)
  assert.equal(writer.verifiedCalls.length, 1)
  assert.equal(writer.forwarded.length, 1)
})

test("request identities grant tenant-wide proof authority without scope or role gates", async () => {
  const source = await readFile(new URL("../lib/request-identity.ts", import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const sandbox = {
    exports: {},
    require(name) {
      if (name === "server-only") return {}
      if (name === "@/lib/api-keys") return { isApiKey() {}, resolveApiKey() {} }
      if (name === "@/lib/auth") return { getCurrentUser() {} }
      if (name === "@/lib/db") return { ensureAppSchema() {}, getPool() {} }
      if (name === "@/lib/nostr-http-auth") return { verifyNostrHttpAuth() {} }
      throw new Error(`Unexpected import: ${name}`)
    },
  }
  vm.runInNewContext(compiled, sandbox)
  const member = {
    principalId: "human-member", tenantId: "tenant-a", kind: "human", role: "member",
    scopes: [], nostrPubkey: "a".repeat(64),
  }
  assert.equal(sandbox.exports.identityCan(member, "proof-work:verify"), true)
  assert.equal(sandbox.exports.identityCanAny(member, ["proof-work:verify"]), true)
})

test("proof mutations enforce the measured body cap before Nostr verification", async () => {
  const proxy = await proxyHarness(["proof-work:claim"])
  const oversized = "x".repeat(2_097_153)
  const response = await proxy.request(
    "proof-workspaces/workspace-1/transitions",
    "POST",
    oversized,
    { "Content-Length": "1", "Content-Type": "application/json" },
  )
  assert.equal(response.status, 413)
  assert.equal(proxy.verifiedCalls.length, 0)
  assert.equal(proxy.forwarded.length, 0)
})

test("legacy scope labels do not restrict tenant-wide proof authority", async () => {
  const legacyWildcard = await proxyHarness(["eln:*"], { tenantWide: true })
  assert.equal((await legacyWildcard.request(
    "experiments", "POST", {}, { "Idempotency-Key": "experiment-create-legacy" },
  )).status, 200)
  assert.equal((await legacyWildcard.request(
    "proof-workspaces/workspace-1/transitions",
    "POST",
    { transition: { type: "claim.acquire" } },
  )).status, 200)
})

test("promotion requires its own narrow authority", () => {
  assert.deepEqual(requiredElnScopes("POST", ["surfaces", "surface-1", "promote"]), {
    primary: "surface:promote",
    accepted: ["surface:promote", "eln:write"],
  })
})
