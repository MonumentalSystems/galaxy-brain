import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  AtlasWebCaptureError,
  atlasWebCapturePlacementRecoveryNamespace,
  atlasWebCaptureRegistered,
  captureAtlasWebContent,
  claimAtlasWebCaptureFlight,
  createAtlasWebCapturePlacementRecovery,
  listAtlasWebCapturePlacementRecoveries,
  prepareAtlasWebCaptureIntent,
  releaseAtlasWebCaptureFlight,
  removeAtlasWebCapturePlacementRecovery,
  writeAtlasWebCapturePlacementRecovery,
} from "../lib/atlas-web-capture.js"
import { captureToDocumentSource } from "../lib/capture-contract.js"
import { resolveIngestionPlanDefinition } from "../lib/plugins/ingestion-plans.js"

class MemoryStorage {
  values = new Map()
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, value) }
  removeItem(key) { this.values.delete(key) }
}

const scope = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  principalId: "20000000-0000-4000-8000-000000000001",
}
const otherScope = { ...scope, principalId: "20000000-0000-4000-8000-000000000002" }
const captureUuid = "30000000-0000-4000-8000-000000000001"
const placementUuid = "40000000-0000-4000-8000-000000000001"

function relativeLuminance(hex) {
  const channels = hex.match(/[a-f\d]{2}/giu).map((channel) => Number.parseInt(channel, 16) / 255)
  const [red, green, blue] = channels.map((channel) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4)
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

function input(overrides = {}) {
  return {
    url: "https://example.test/research?edition=2",
    title: "Captured note",
    format: "markdown",
    content: "# Exact note\n\n$\\alpha + \\beta$\n",
    ...overrides,
  }
}

function intent(overrides = {}) {
  return prepareAtlasWebCaptureIntent(input(overrides), {
    randomUUID: () => captureUuid,
    now: () => new Date("2026-09-27T15:00:00.000Z"),
  })
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function durableDocument(capture, overrides = {}) {
  const source = captureToDocumentSource(capture)
  const revisionSha256 = "b".repeat(64)
  return {
    schemaId: "gb.document.import.v1",
    persisted: true,
    ref: `gb:object:v1:document:50000000-0000-4000-8000-000000000001:pinned:sha256%3A${revisionSha256}`,
    document_id: "50000000-0000-4000-8000-000000000001",
    revision_id: "60000000-0000-4000-8000-000000000001",
    artifact_id: "70000000-0000-4000-8000-000000000001",
    source_id: "80000000-0000-4000-8000-000000000001",
    title: capture.title,
    display_filename: source.filename,
    version: 1,
    content_sha256: await sha256(source.bytes),
    revision_sha256: revisionSha256,
    byte_size: source.bytes.byteLength,
    media_type: source.mediaType,
    source_kind: "url",
    original_filename: source.filename,
    source_uri: capture.url,
    ingestion_plan: resolveIngestionPlanDefinition("web.capture-default"),
    replayed: false,
    deduplicatedArtifact: false,
    ...overrides,
  }
}

async function responseFor(frozenIntent, documentOverrides = {}, responseOverrides = {}) {
  return {
    schemaId: "gb.web-capture.result.v1",
    id: null,
    title: frozenIntent.capture.title,
    url: frozenIntent.capture.url,
    capturedAt: frozenIntent.capture.capturedAt,
    document: await durableDocument(frozenIntent.capture, documentOverrides),
    ingestion: { status: "persisted", plan: resolveIngestionPlanDefinition("web.capture-default"), derivation: { status: "deferred" } },
    transform: null,
    hamMirror: { status: "unavailable" },
    ...responseOverrides,
  }
}

test("registered Atlas capture freezes replay identity and accepts only the exact pinned durable bytes", async () => {
  assert.equal(atlasWebCaptureRegistered(), true)
  const frozen = intent()
  const calls = []
  const document = await captureAtlasWebContent(frozen, {
    fetcher: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(new TextDecoder().decode(init.body)) })
      return new Response(JSON.stringify(await responseFor(frozen)), { status: 201 })
    },
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "/api/capture")
  assert.equal(calls[0].init.headers["Idempotency-Key"], `atlas-web-capture:${captureUuid}`)
  assert.equal(calls[0].init.redirect, "error")
  assert.equal(calls[0].body.capturedAt, "2026-09-27T15:00:00.000Z")
  assert.equal(calls[0].body.url, "https://example.test/research?edition=2")
  assert.equal(document.ref, (await durableDocument(frozen.capture)).ref)
  assert.equal(document.source_kind, "url")
})

test("capture retries use the same frozen body and replay key after an ambiguous failure", async () => {
  const frozen = intent()
  const calls = []
  const fetcher = async (_url, init) => {
    calls.push({ key: init.headers["Idempotency-Key"], body: new TextDecoder().decode(init.body) })
    return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      captureAtlasWebContent(frozen, { fetcher }),
      (error) => error instanceof AtlasWebCaptureError && error.ambiguous === true,
    )
  }
  assert.deepEqual(calls[0], calls[1])
})

test("a successful response stream error is redacted and preserves the frozen ambiguous replay", async () => {
  const frozen = intent()
  const calls = []
  const fetcher = async (_url, init) => {
    calls.push({ key: init.headers["Idempotency-Key"], body: new TextDecoder().decode(init.body) })
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"schemaId":"gb.web-capture.result.v1"'))
        queueMicrotask(() => controller.error(new Error("private upstream stream detail")))
      },
    })
    return new Response(body, { status: 201 })
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      captureAtlasWebContent(frozen, { fetcher }),
      (error) => {
        assert.ok(error instanceof AtlasWebCaptureError)
        assert.equal(error.code, "invalid_response")
        assert.equal(error.ambiguous, true)
        assert.doesNotMatch(error.message, /private upstream/u)
        return true
      },
    )
  }
  assert.deepEqual(calls[0], calls[1])
})

test("the synchronous flight owner admits one same-turn capture request and replay key", async () => {
  const ownerRef = { current: null }
  const generationRef = { current: 0 }
  const calls = []
  let resolveFetch
  const frozen = intent()
  const confirmed = await responseFor(frozen)
  const fetcher = async (_url, init) => {
    calls.push({ key: init.headers["Idempotency-Key"], body: new TextDecoder().decode(init.body) })
    return await new Promise((resolve) => { resolveFetch = resolve })
  }
  const submit = async () => {
    const generation = claimAtlasWebCaptureFlight(ownerRef, generationRef)
    if (generation === null) return null
    try {
      return await captureAtlasWebContent(frozen, { fetcher })
    } finally {
      releaseAtlasWebCaptureFlight(ownerRef, generation)
    }
  }

  const first = submit()
  const second = submit()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].key, `atlas-web-capture:${captureUuid}`)
  resolveFetch(new Response(JSON.stringify(confirmed), { status: 201 }))
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.ref, confirmed.document.ref)
  assert.equal(secondResult, null)
  assert.equal(ownerRef.current, null)

  const nextGeneration = claimAtlasWebCaptureFlight(ownerRef, generationRef)
  assert.equal(nextGeneration, 2)
  releaseAtlasWebCaptureFlight(ownerRef, 1)
  assert.equal(ownerRef.current, 2)
  releaseAtlasWebCaptureFlight(ownerRef, nextGeneration)
  assert.equal(ownerRef.current, null)
})

test("capture fails closed for mismatched provenance, bytes, unpinned refs, and expanded receipts", async () => {
  const frozen = intent()
  const invalid = [
    await responseFor(frozen, { source_uri: "https://other.example.test/" }),
    await responseFor(frozen, { content_sha256: "c".repeat(64) }),
    await responseFor(frozen, { ref: "gb:object:v1:document:50000000-0000-4000-8000-000000000001:latest" }),
    await responseFor(frozen, {}, { callerSelectedDestination: "https://evil.test" }),
  ]
  for (const payload of invalid) {
    await assert.rejects(
      captureAtlasWebContent(frozen, { fetcher: async () => new Response(JSON.stringify(payload), { status: 201 }) }),
      AtlasWebCaptureError,
    )
  }
})

test("placement recovery is separate, exact, identity-scoped, and corrupt records fail closed", async () => {
  const storage = new MemoryStorage()
  const frozen = intent()
  const document = await durableDocument(frozen.capture)
  const value = {
    operationId: placementUuid,
    workspaceId: "default-workspace",
    canvasId: "90000000-0000-4000-8000-000000000001",
    subjectRef: document.ref,
    durableDocument: document,
    captureUrl: frozen.capture.url,
    title: frozen.capture.title,
    format: frozen.capture.format,
  }
  const memoryRecovery = createAtlasWebCapturePlacementRecovery(value)
  assert.equal(memoryRecovery.operationId, placementUuid)
  assert.notEqual(memoryRecovery.operationId, captureUuid)
  const stored = writeAtlasWebCapturePlacementRecovery(storage, scope, value)
  assert.deepEqual(listAtlasWebCapturePlacementRecoveries(storage, scope), [stored])
  assert.deepEqual(listAtlasWebCapturePlacementRecoveries(storage, otherScope), [])

  const prefix = atlasWebCapturePlacementRecoveryNamespace(scope)
  storage.setItem(`${prefix}a0000000-0000-4000-8000-000000000001`, JSON.stringify({ ...stored, unexpected: true }))
  assert.deepEqual(listAtlasWebCapturePlacementRecoveries(storage, scope), [stored])
  assert.equal(storage.length, 1)
  removeAtlasWebCapturePlacementRecovery(storage, scope, placementUuid)
  assert.equal(storage.length, 0)
})

test("Atlas integration exposes only a paste-owned dialog and checkpoints before placement", async () => {
  const dialog = await readFile(new URL("../components/atlas/web-capture-dialog.tsx", import.meta.url), "utf8")
  const client = await readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8")
  assert.match(dialog, /Provenance URL/)
  assert.match(dialog, /Exact content/)
  assert.match(dialog, /Galaxy never requests this URL/)
  assert.doesNotMatch(dialog, /dangerouslySetInnerHTML|fetch\(|DOMParser|selection|region|tags|note/)
  assert.match(client, /createAtlasWebCapturePlacementRecovery\([\s\S]*writeAtlasWebCapturePlacementRecovery\([\s\S]*placeReference\(recovery\.subjectRef, recovery\.operationId\)/)
  assert.match(client, /setWebCaptureRecovery\(recovery\)[\s\S]*writeAtlasWebCapturePlacementRecovery/)
  assert.match(client, /removeAtlasWebCapturePlacementRecovery/)
  assert.match(client, /captureWebContentAndPlace[\s\S]*claimAtlasWebCaptureFlight[\s\S]*prepareAtlasWebCaptureIntent/)
  assert.match(client, /finally \{[\s\S]*releaseAtlasWebCaptureFlight\(webCaptureFlightOwnerRef, generation\)/)
})

test("web capture dialog keeps actions reachable and focuses the exact invalid field", async () => {
  const dialog = await readFile(new URL("../components/atlas/web-capture-dialog.tsx", import.meta.url), "utf8")
  assert.match(dialog, /max-h-\[calc\(100dvh-1rem\)\][^"]*overflow-y-auto/u)
  assert.match(dialog, /const titleRef = useRef<HTMLInputElement>\(null\)/u)
  assert.match(dialog, /const contentRef = useRef<HTMLTextAreaElement>\(null\)/u)
  assert.match(dialog, /rejectField\("url",[\s\S]*rejectField\("title",[\s\S]*rejectField\("content",/u)
  assert.match(dialog, /field === "url" \? urlRef : field === "title" \? titleRef : contentRef[\s\S]*target\.current\?\.focus\(\)/u)
  for (const field of ["url", "title", "content"]) {
    assert.match(dialog, new RegExp(`aria-invalid=\\{localError\\?\\.field === "${field}"\\}`, "u"))
    assert.match(dialog, new RegExp(`atlas-web-capture-${field}-error`, "u"))
  }
  assert.match(dialog, /text-\[#4f6359\]/u)
  assert.ok(contrastRatio("#4f6359", "#edf1e7") >= 4.5, "recovery metadata must meet WCAG AA normal-text contrast")
})
