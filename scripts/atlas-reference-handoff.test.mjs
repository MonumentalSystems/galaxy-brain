import assert from "node:assert/strict"
import test from "node:test"

import {
  ATLAS_REFERENCE_HANDOFF_PARAMETER,
  atlasReferenceHandoffHref,
  authorizeAtlasReferenceHandoff,
  clearAtlasReferenceHandoffHref,
  inspectAtlasReferenceHandoff,
  parseAtlasReferenceHandoff,
} from "../lib/atlas-reference-handoff.js"
import { atlasWorkspaceHref, parseAtlasLocation } from "../lib/canvas/atlas-location.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"

const documentId = "123e4567-e89b-42d3-a456-426614174000"
const documentRevisionId = "223e4567-e89b-42d3-a456-426614174000"
const revisionSha256 = "a".repeat(64)
const subjectRef = createGalaxyObjectReference("document", documentId, {
  mode: "pinned",
  revision: `sha256:${revisionSha256}`,
})

function resolved(overrides = {}) {
  return {
    requestedRef: subjectRef,
    status: "resolved",
    resolvedRef: subjectRef,
    provider: "galaxy.document",
    documentRevisionId,
    handles: [],
    projection: {
      schemaId: "gb.object-projection.v1",
      ref: subjectRef,
      kind: "document",
      revision: {
        policy: "pinned",
        id: `sha256:${revisionSha256}`,
        contentHash: revisionSha256,
      },
      title: "Exact document",
      representations: [],
      provenance: {
        provider: "galaxy.document",
        sourceId: documentId,
        sourceRevision: `sha256:${revisionSha256}`,
      },
      capabilities: ["open", "place"],
    },
    ...overrides,
  }
}

test("reference handoff accepts only registered canonical pinned sha256 references", () => {
  assert.equal(ATLAS_REFERENCE_HANDOFF_PARAMETER, "placeRef")
  assert.deepEqual(inspectAtlasReferenceHandoff(subjectRef), {
    ok: true,
    subjectRef,
    kind: "document",
    objectId: documentId,
    revisionSha256,
  })

  const latest = createGalaxyObjectReference("document", documentId)
  const unsupported = createGalaxyObjectReference("paper", documentId, {
    mode: "pinned",
    revision: `sha256:${revisionSha256}`,
  })
  const noncanonical = subjectRef.replace(documentId, documentId.replace("1", "%31"))
  const uppercaseHash = createGalaxyObjectReference("document", documentId, {
    mode: "pinned",
    revision: `sha256:${revisionSha256.toUpperCase()}`,
  })

  assert.deepEqual(inspectAtlasReferenceHandoff(""), { ok: false, code: "invalid_reference" })
  assert.deepEqual(inspectAtlasReferenceHandoff("x".repeat(1025)), { ok: false, code: "invalid_reference" })
  assert.deepEqual(inspectAtlasReferenceHandoff("gb:node:legacy"), { ok: false, code: "invalid_reference" })
  assert.deepEqual(inspectAtlasReferenceHandoff(noncanonical), { ok: false, code: "noncanonical_reference" })
  assert.deepEqual(inspectAtlasReferenceHandoff(latest), { ok: false, code: "pinned_required" })
  assert.deepEqual(inspectAtlasReferenceHandoff(unsupported), { ok: false, code: "unsupported_kind" })
  assert.deepEqual(inspectAtlasReferenceHandoff(uppercaseHash), { ok: false, code: "invalid_revision" })
})

test("URL handoff intent is distinct from Atlas selection and rejects ambiguity", () => {
  const href = atlasReferenceHandoffHref(subjectRef)
  assert.equal(href, `/workspace?placeRef=${encodeURIComponent(subjectRef)}`)
  assert.deepEqual(parseAtlasReferenceHandoff(""), { state: "none" })
  assert.deepEqual(parseAtlasReferenceHandoff("?placeRef="), {
    state: "invalid",
    code: "invalid_reference",
  })
  assert.deepEqual(parseAtlasReferenceHandoff(`?placeRef=${encodeURIComponent(subjectRef)}&placeRef=${encodeURIComponent(subjectRef)}`), {
    state: "invalid",
    code: "duplicate_intent",
  })
  assert.deepEqual(parseAtlasReferenceHandoff(href.split("?")[1]), {
    state: "ready",
    subjectRef,
    kind: "document",
    objectId: documentId,
    revisionSha256,
  })

  const canvasId = "323e4567-e89b-42d3-a456-426614174000"
  const redirected = atlasWorkspaceHref({
    canvas: canvasId,
    placement: "existing-placement",
    ref: "existing-selection",
    placeRef: subjectRef,
    ignored: "no",
  })
  assert.equal(
    redirected,
    `/workspace?canvas=${canvasId}&placement=existing-placement&ref=existing-selection&placeRef=${encodeURIComponent(subjectRef)}`,
  )
  assert.deepEqual(parseAtlasLocation(redirected.split("?")[1]), {
    canvasId,
    placementId: "existing-placement",
  })
})

test("compatibility redirect preserves duplicate handoff intents for fail-closed parsing", () => {
  const first = createGalaxyObjectReference("document", "11111111-1111-4111-8111-111111111111", {
    mode: "pinned",
    revision: `sha256:${"a".repeat(64)}`,
  })
  const second = createGalaxyObjectReference("document", "22222222-2222-4222-8222-222222222222", {
    mode: "pinned",
    revision: `sha256:${"b".repeat(64)}`,
  })
  const redirected = atlasWorkspaceHref({ placeRef: [first, second] })

  assert.equal(
    redirected,
    `/workspace?placeRef=${encodeURIComponent(first)}&placeRef=${encodeURIComponent(second)}`,
  )
  assert.deepEqual(parseAtlasReferenceHandoff(redirected.split("?")[1]), {
    state: "invalid",
    code: "duplicate_intent",
  })
})

test("clearing intent preserves history-compatible selection, other parameters, and hash", () => {
  assert.equal(
    clearAtlasReferenceHandoffHref(`/workspace?canvas=one&placeRef=${encodeURIComponent(subjectRef)}&ref=selected&placeRef=duplicate#node`),
    "/workspace?canvas=one&ref=selected#node",
  )
  assert.equal(
    clearAtlasReferenceHandoffHref(`https://example.test/workspace?placeRef=${encodeURIComponent(subjectRef)}&view=list`),
    "/workspace?view=list",
  )
})

test("authorization binds the exact requested, resolved, projected, and source revisions", () => {
  assert.deepEqual(authorizeAtlasReferenceHandoff(subjectRef, resolved(), {
    kind: "document",
    objectId: documentId,
    sourceRevisionId: documentRevisionId,
    revisionSha256,
  }), {
    ok: true,
    subjectRef,
    kind: "document",
    objectId: documentId,
    sourceRevisionId: documentRevisionId,
    revisionSha256,
    projection: resolved().projection,
  })

  assert.deepEqual(authorizeAtlasReferenceHandoff(subjectRef, { status: "unavailable", requestedRef: subjectRef }), {
    ok: false,
    code: "unavailable",
  })
  assert.deepEqual(authorizeAtlasReferenceHandoff(subjectRef, resolved({ resolvedRef: `${subjectRef}-other` })), {
    ok: false,
    code: "identity_mismatch",
  })
  assert.deepEqual(authorizeAtlasReferenceHandoff(subjectRef, resolved({
    projection: { ...resolved().projection, ref: `${subjectRef}-other` },
  })), { ok: false, code: "identity_mismatch" })
  assert.deepEqual(authorizeAtlasReferenceHandoff(subjectRef, resolved({
    projection: {
      ...resolved().projection,
      revision: { ...resolved().projection.revision, contentHash: "b".repeat(64) },
    },
  })), { ok: false, code: "revision_mismatch" })
  assert.deepEqual(authorizeAtlasReferenceHandoff(subjectRef, resolved(), {
    sourceRevisionId: "323e4567-e89b-42d3-a456-426614174000",
  }), { ok: false, code: "source_mismatch" })
})

test("chat handoff preserves one exact conversation revision without a document revision id", () => {
  const conversationId = "623e4567-e89b-42d3-a456-426614174000"
  const chatRef = createGalaxyObjectReference("chat", conversationId, {
    mode: "pinned",
    revision: `sha256:${revisionSha256}`,
  })
  const projection = {
    schemaId: "gb.object-projection.v1",
    ref: chatRef,
    kind: "chat",
    revision: { policy: "pinned", id: `sha256:${revisionSha256}`, contentHash: revisionSha256 },
    title: "Exact conversation",
    representations: [],
    provenance: {
      provider: "galaxy.conversation",
      sourceId: conversationId,
      sourceRevision: `sha256:${revisionSha256}`,
    },
    capabilities: ["open", "place"],
  }
  const resolution = {
    requestedRef: chatRef,
    status: "resolved",
    resolvedRef: chatRef,
    provider: "galaxy.conversation",
    handles: [],
    projection,
  }
  assert.deepEqual(inspectAtlasReferenceHandoff(chatRef), {
    ok: true,
    subjectRef: chatRef,
    kind: "chat",
    objectId: conversationId,
    revisionSha256,
  })
  assert.equal(atlasReferenceHandoffHref(chatRef), `/workspace?placeRef=${encodeURIComponent(chatRef)}`)
  assert.deepEqual(authorizeAtlasReferenceHandoff(chatRef, resolution, {
    kind: "chat",
    objectId: conversationId,
    revisionSha256,
  }), {
    ok: true,
    subjectRef: chatRef,
    kind: "chat",
    objectId: conversationId,
    revisionSha256,
    projection,
  })
  assert.deepEqual(authorizeAtlasReferenceHandoff(chatRef, { ...resolution, documentRevisionId }), {
    ok: false,
    code: "revision_mismatch",
  })
  assert.deepEqual(authorizeAtlasReferenceHandoff(chatRef, {
    ...resolution,
    provider: "galaxy.document",
  }), { ok: false, code: "source_mismatch" })
})

test("surface handoff reauthorizes one exact currently promoted revision", () => {
  const surfaceId = "723e4567-e89b-42d3-a456-426614174000"
  const surfaceRef = createGalaxyObjectReference("surface", surfaceId, {
    mode: "pinned",
    revision: `sha256:${revisionSha256}`,
  })
  const projection = {
    schemaId: "gb.object-projection.v1",
    ref: surfaceRef,
    kind: "surface",
    revision: { policy: "pinned", id: `sha256:${revisionSha256}`, contentHash: revisionSha256 },
    title: "Exact promoted surface",
    representations: [],
    provenance: {
      provider: "galaxy.surface",
      sourceId: surfaceId,
      sourceRevision: "version:7",
    },
    capabilities: ["open", "place"],
  }
  const resolution = {
    requestedRef: surfaceRef,
    status: "resolved",
    resolvedRef: surfaceRef,
    provider: "galaxy.surface",
    handles: [],
    projection,
  }

  assert.deepEqual(inspectAtlasReferenceHandoff(surfaceRef), {
    ok: true,
    subjectRef: surfaceRef,
    kind: "surface",
    objectId: surfaceId,
    revisionSha256,
  })
  assert.equal(atlasReferenceHandoffHref(surfaceRef), `/workspace?placeRef=${encodeURIComponent(surfaceRef)}`)
  assert.deepEqual(authorizeAtlasReferenceHandoff(surfaceRef, resolution, {
    kind: "surface",
    objectId: surfaceId,
    revisionSha256,
  }), {
    ok: true,
    subjectRef: surfaceRef,
    kind: "surface",
    objectId: surfaceId,
    revisionSha256,
    projection,
  })
  assert.deepEqual(authorizeAtlasReferenceHandoff(surfaceRef, {
    ...resolution,
    projection: { ...projection, capabilities: ["open"] },
  }), { ok: false, code: "source_mismatch" })
  assert.deepEqual(authorizeAtlasReferenceHandoff(surfaceRef, {
    ...resolution,
    projection: { ...projection, provenance: { ...projection.provenance, sourceRevision: `sha256:${revisionSha256}` } },
  }), { ok: false, code: "revision_mismatch" })
  assert.deepEqual(authorizeAtlasReferenceHandoff(surfaceRef, { ...resolution, documentRevisionId }), {
    ok: false,
    code: "revision_mismatch",
  })
})

test("latest intent never degrades to a resolved pinned reference", () => {
  const latest = createGalaxyObjectReference("document", documentId)
  assert.deepEqual(authorizeAtlasReferenceHandoff(latest, resolved({ requestedRef: latest })), {
    ok: false,
    code: "pinned_required",
  })
  assert.throws(() => atlasReferenceHandoffHref(latest), /pinned_required/)
})
