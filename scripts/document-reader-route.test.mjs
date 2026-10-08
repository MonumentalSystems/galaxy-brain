import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  documentReaderRequestIdentity,
  shouldAcceptDocumentReaderCompletion,
} from "../lib/document-reader-request.js"

const revisionA = "10000000-0000-4000-8000-000000000001"
const revisionB = "20000000-0000-4000-8000-000000000002"

function identity(documentRevisionId, tenantId = "tenant-a", principalId = "principal-a") {
  return documentReaderRequestIdentity({ documentRevisionId, tenantId, principalId })
}

test("request identity is bound to revision, tenant, and principal", () => {
  const a = identity(revisionA)
  assert.notEqual(a, identity(revisionB))
  assert.notEqual(a, identity(revisionA, "tenant-b"))
  assert.notEqual(a, identity(revisionA, "tenant-a", "principal-b"))

  assert.notEqual(identity("a:b", "c", "d"), identity("a", "b:c", "d"))
  assert.throws(() => identity(revisionA, "tenant\nforged"), /Tenant is invalid/)
})

test("completion authority remains exact to one committed request identity", () => {
  const a = identity(revisionA)
  const b = identity(revisionB)
  const settlingA = { active: true, aborted: false, generation: 1, identityKey: a }

  // A remounted request boundary uses B; an A completion cannot satisfy it.
  assert.equal(shouldAcceptDocumentReaderCompletion(settlingA, { generation: 1, identityKey: b }), false)
  assert.equal(
    shouldAcceptDocumentReaderCompletion(settlingA, {
      generation: 1,
      identityKey: identity(revisionA, "tenant-b", "principal-a"),
    }),
    false,
  )
  assert.equal(
    shouldAcceptDocumentReaderCompletion(settlingA, {
      generation: 1,
      identityKey: identity(revisionA, "tenant-a", "principal-b"),
    }),
    false,
  )
})

test("inactive, aborted, and superseded generations cannot replace current reader state", () => {
  const a = identity(revisionA)
  const current = { generation: 2, identityKey: a }
  assert.equal(shouldAcceptDocumentReaderCompletion({ active: false, aborted: false, generation: 2, identityKey: a }, current), false)
  assert.equal(shouldAcceptDocumentReaderCompletion({ active: true, aborted: true, generation: 2, identityKey: a }, current), false)
  assert.equal(shouldAcceptDocumentReaderCompletion({ active: true, aborted: false, generation: 1, identityKey: a }, current), false)
  assert.equal(shouldAcceptDocumentReaderCompletion({ active: true, aborted: false, generation: 2, identityKey: a }, current), true)
})

test("route keys the request boundary and guards both completion paths without render-phase mutation", async () => {
  const source = await readFile(new URL("../components/papers/document-reader-route.tsx", import.meta.url), "utf8")
  assert.match(source, /<DocumentReaderRequest\s+key=\{requestIdentityKey\}/)
  assert.doesNotMatch(source, /requestIdentityRef\.current\s*=/)
  assert.equal(source.match(/shouldAcceptDocumentReaderCompletion\(/g)?.length, 2)
  assert.doesNotMatch(source, /\.then\(setRevision\)/)
  assert.match(source, /active = false[\s\S]*controller\.abort\(\)/)
  assert.match(source, /\[documentRevisionId, requestIdentityKey\]/)
  assert.match(source, /\[documentRevisionId, principalId, tenantId\]/)
  assert.match(source, /createGalaxyPaperReaderDataPort\(fetch\)/)
  assert.equal(source.match(/createGalaxyPaperReaderActionPort\(/g)?.length, 1)
  assert.match(source, /searchParams\.get\("documentAnchor"\)/)
  assert.match(source, /<ExactTextDocumentReader[\s\S]*tenantId=\{tenantId\}[\s\S]*principalId=\{principalId\}[\s\S]*dataPort=\{dataPort\}[\s\S]*actionPort=\{paperActionPort\}/)
  assert.match(source, /scope: \{ tenantId, principalId, documentRevisionId \}/)
  assert.match(source, /storage: \(\) => window\.localStorage/)
  assert.match(source, /<DurablePaperReader[\s\S]*actionPort=\{paperActionPort\}/)
})

test("the common exact reader emits a pinned document handoff only after authorized hydration", async () => {
  const [route, link] = await Promise.all([
    readFile(new URL("../components/papers/document-reader-route.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/atlas/atlas-reference-handoff-link.tsx", import.meta.url), "utf8"),
  ])

  assert.match(route, /<ExactDocumentReaderSurface revision=\{revision\}>/)
  assert.match(route, /subjectRef=\{revision\.ref\}/)
  assert.match(route, /expectedDocumentId=\{revision\.document_id\}/)
  assert.match(route, /expectedDocumentRevisionId=\{revision\.revision_id\}/)
  assert.match(route, /expectedRevisionSha256=\{revision\.revision_sha256\}/)
  assert.match(link, /inspectAtlasReferenceHandoff\(subjectRef\)/)
  assert.match(link, /hydrateAtlasObjectReferences\(\[subjectRef\], \{ signal: controller\.signal \}\)/)
  assert.match(link, /authorizeAtlasReferenceHandoff\(subjectRef, currentResolution,/)
  assert.match(link, /href=\{atlasReferenceHandoffHref\(authorization\.subjectRef\)\}/)
  assert.match(link, />\s*Place document in Atlas\s*</)
  assert.match(link, /controller\.abort\(\)/)
  assert.doesNotMatch(link, /eln\.experiment/u)
})
