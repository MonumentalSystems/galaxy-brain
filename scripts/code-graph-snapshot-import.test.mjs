import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  CODE_GRAPH_SNAPSHOT_MEDIA_TYPE,
  MAX_CODE_GRAPH_SNAPSHOT_BYTES,
  assertCodeGraphSnapshotImportConfirmation,
  createCodeGraphSnapshotImportTitle,
  normalizeCodeGraphSnapshotReview,
  openCodeGraphSnapshotProvider,
  parseCodeGraphSnapshotBytes,
  validateCodeGraphSnapshotFileDescriptor,
} from "../lib/code-graph-snapshot-import.js"

const fixtureUrl = new URL("../docs/samples/codebase-memory.snapshot.json", import.meta.url)
const fixtureBytes = await readFile(fixtureUrl)
const fixture = JSON.parse(fixtureBytes.toString("utf8"))

test("reviews exact UTF-8 bytes without equating provider metadata to the raw-file digest", async () => {
  const review = await parseCodeGraphSnapshotBytes(fixtureBytes)
  assert.equal(review.schemaId, "codebase-memory.snapshot.v1")
  assert.equal(review.byteSize, fixtureBytes.byteLength)
  assert.match(review.contentSha256, /^[a-f0-9]{64}$/u)
  assert.equal(review.declaredSnapshotDigest, fixture.snapshot.digest)
  assert.notEqual(`sha256:${review.contentSha256}`, review.declaredSnapshotDigest)
  assert.deepEqual(review.provider, fixture.provider)
  assert.deepEqual(review.repository, fixture.repository)
  assert.equal(review.nodeCount, fixture.nodes.length)
  assert.equal(review.edgeCount, fixture.edges.length)
  assert.equal(Object.isFrozen(review), true)
})

test("opens an inert provider only after enforcing the smaller interactive source cap", async () => {
  const opened = await openCodeGraphSnapshotProvider(fixtureBytes, { maxNodes: 20_000, maxEdges: 80_000 })
  assert.equal(opened.review.contentSha256, (await parseCodeGraphSnapshotBytes(fixtureBytes)).contentSha256)
  assert.equal(opened.provider.provider, fixture.provider.name)
  await assert.rejects(
    openCodeGraphSnapshotProvider(fixtureBytes, { maxNodes: fixture.nodes.length - 1, maxEdges: 80_000 }),
    /graph lens supports at most/u,
  )
})

test("rejects duplicate fields, malformed UTF-8, extra schema fields, and unsafe provider shapes", async () => {
  const duplicate = fixtureBytes.toString("utf8").replace(
    '  "provider": {',
    '  "provider": null,\n  "provider": {',
  )
  await assert.rejects(parseCodeGraphSnapshotBytes(Buffer.from(duplicate)), /duplicate JSON field/u)
  await assert.rejects(parseCodeGraphSnapshotBytes(Uint8Array.from([0xc3, 0x28])), /valid UTF-8/u)
  await assert.rejects(
    parseCodeGraphSnapshotBytes(Buffer.from(JSON.stringify({ ...fixture, query: "MATCH (n) DELETE n" }))),
    /supported Codebase Memory snapshot schema/u,
  )
  await assert.rejects(
    parseCodeGraphSnapshotBytes(Buffer.from(JSON.stringify({
      ...fixture,
      nodes: [...fixture.nodes, { id: "secret", type: "File", path: "../secret" }],
    }))),
    /supported Codebase Memory snapshot schema/u,
  )
  await assert.rejects(
    parseCodeGraphSnapshotBytes(Buffer.from(JSON.stringify({
      ...fixture,
      edges: [...fixture.edges, { id: "dangling", type: "CALLS", source: "repo", target: "missing" }],
    }))),
    /supported Codebase Memory snapshot schema/u,
  )
})

test("bounds file admission before worker parsing and canonicalizes the media type", () => {
  assert.deepEqual(validateCodeGraphSnapshotFileDescriptor({
    name: "snapshot.json",
    size: fixtureBytes.byteLength,
    type: "",
  }), {
    name: "snapshot.json",
    byteSize: fixtureBytes.byteLength,
    mediaType: CODE_GRAPH_SNAPSHOT_MEDIA_TYPE,
  })
  assert.throws(
    () => validateCodeGraphSnapshotFileDescriptor({ name: "snapshot.txt", size: 1, type: "application/json" }),
    /ends in \.json/u,
  )
  assert.throws(
    () => validateCodeGraphSnapshotFileDescriptor({ name: "snapshot.json", size: 1, type: "text/plain" }),
    /application\/json/u,
  )
  assert.throws(
    () => validateCodeGraphSnapshotFileDescriptor({ name: "snapshot.json", size: MAX_CODE_GRAPH_SNAPSHOT_BYTES + 1, type: "" }),
    /no larger/u,
  )
})

test("fails closed across the worker result and durable confirmation boundaries", async () => {
  const review = await parseCodeGraphSnapshotBytes(fixtureBytes)
  assert.throws(
    () => normalizeCodeGraphSnapshotReview({ ...review, execute: true }),
    /unsupported fields/u,
  )
  const confirmation = {
    document: {
      media_type: "application/json",
      content_sha256: review.contentSha256,
      byte_size: review.byteSize,
      original_filename: "snapshot.json",
    },
    placementOperationId: "operation-1",
  }
  assert.equal(
    assertCodeGraphSnapshotImportConfirmation(confirmation, review, "snapshot.json"),
    confirmation,
  )
  for (const document of [
    { ...confirmation.document, media_type: "text/plain" },
    { ...confirmation.document, content_sha256: "f".repeat(64) },
    { ...confirmation.document, byte_size: review.byteSize + 1 },
    { ...confirmation.document, original_filename: "other.json" },
  ]) {
    assert.throws(
      () => assertCodeGraphSnapshotImportConfirmation({ ...confirmation, document }, review, "snapshot.json"),
      /did not match/u,
    )
  }
  assert.equal(
    createCodeGraphSnapshotImportTitle(review),
    `Code graph: ${fixture.repository.repositoryId} @ ${fixture.repository.commit.slice(0, 12)}`,
  )
})

test("uses one persistent bounded worker and a closed static Atlas presenter", async () => {
  const [worker, dialog, host, atlas, builtins] = await Promise.all([
    readFile(new URL("../workers/code-graph-snapshot-import.worker.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/atlas/code-graph-snapshot-import-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/atlas/atlas-command-presenter-host.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/plugins/builtins.js", import.meta.url), "utf8"),
  ])
  assert.match(worker, /parseCodeGraphSnapshotBytes\(event\.data\.bytes\)/u)
  assert.doesNotMatch(worker, /fetch\(|indexedDB|localStorage|postMessage\([^)]*bytes/u)
  assert.equal((dialog.match(/new Worker\(/gu) ?? []).length, 1)
  assert.match(dialog, /workerRef\.current \?\? createReviewWorker\(\)/u)
  assert.match(dialog, /worker\.terminate\(\)[\s\S]*workerRef\.current === worker/u)
  assert.match(dialog, /workerRef\.current\?\.terminate\(\)/u)
  assert.match(dialog, /worker\.postMessage\(\{ requestId, bytes \}, \[bytes\]\)/u)
  assert.match(dialog, /accept="application\/json,\.json"/u)
  assert.match(dialog, /atlas-command-presenter research-workbench/u)
  assert.match(dialog, /max-h-\[calc\(100dvh-1rem\)\]/u)
  assert.match(dialog, /focusFirstConnected\(\[returnFocus, fallbackFocus\], contentRef\.current\)/u)
  assert.match(dialog, /focusFirstConnected\(\[stateActionRef\.current, statePanelRef\.current, contentRef\.current\]\)/u)
  assert.match(dialog, /fileInputRef\.current,[\s\S]*stateActionRef\.current,[\s\S]*statePanelRef\.current,[\s\S]*contentRef\.current/u)
  assert.equal((dialog.match(/ref=\{statePanelRef\} tabIndex=\{-1\}/gu) ?? []).length, 1)
  assert.equal((dialog.match(/ref=\{stateActionRef\}/gu) ?? []).length, 2)
  assert.match(dialog, /role="status" aria-live="polite" aria-atomic="true"/u)
  assert.match(dialog, /The declared snapshot digest is provider metadata/u)
  assert.match(dialog, />\{review\.contentSha256\}</u)
  assert.match(dialog, />\{review\.declaredSnapshotDigest\}</u)
  assert.match(dialog, /className="min-w-0 break-all">\{review\.provider\.name\} v\{review\.provider\.version\}<\/dd>/u)
  assert.doesNotMatch(dialog, /shortHash|title=\{review\.(?:contentSha256|declaredSnapshotDigest)\}/u)
  assert.match(dialog, /reviewing \? \([\s\S]*Reviewing snapshot…/u)
  assert.doesNotMatch(dialog, /#[0-9a-f]{3,8}|rgba?\(|text-destructive|text-muted-foreground/iu)
  assert.doesNotMatch(dialog, /fetch\(|createCodebaseMemoryJsonProvider|projectCodeGraphEdgeToDurableRelation/u)
  assert.match(host, /import \{ CodeGraphSnapshotImportDialog \}/u)
  assert.equal(host.match(/<CodeGraphSnapshotImportDialog/gu)?.length, 1)
  assert.match(atlas, /galaxyBrainAPI\.importDocument\(file,[\s\S]*createCodeGraphSnapshotImportTitle\(review\)/u)
  assert.match(atlas, /assertCodeGraphSnapshotImportConfirmation\(confirmation, review, file\.name\)/u)
  assert.match(atlas, /placeReference\(recovery\.document\.ref, recovery\.operationId\)/u)
  assert.match(atlas, /No graph relations were created/u)
  assert.match(atlas, /codeGraphImport: codeGraphSnapshotPhase !== "idle" \|\| codeGraphSnapshotAmbiguous \|\| codeGraphSnapshotRecovery !== null/u)
  assert.match(atlas, /keepCodeGraphSnapshotWithoutPlacing[\s\S]*setCodeGraphSnapshotRecovery\(null\)[\s\S]*setCodeGraphSnapshotTarget\(null\)/u)
  assert.match(atlas, /discardedPlacementMatchesRetry[\s\S]*setReferencePlacementRetry\(null\)[\s\S]*setReferencePlacementAnnouncement\(""\)/u)
  assert.match(atlas, /onKeepWithoutPlacing: keepCodeGraphSnapshotWithoutPlacing/u)
  const codePlugin = builtins.slice(builtins.indexOf("export const CODE_PLUGIN_PACKAGE"), builtins.indexOf("export const VOICE_PLUGIN_PACKAGE"))
  assert.match(codePlugin, /sources: Object\.freeze\(\["code\.graph\.snapshot"\]\)/u)
  assert.match(codePlugin, /projectors: Object\.freeze\(\["code"\]\)/u)
  assert.doesNotMatch(codePlugin, /routes: Object\.freeze\(\[[^\]]+\]\)|agentTools: Object\.freeze\(\[[^\]]+\]\)/u)
})
