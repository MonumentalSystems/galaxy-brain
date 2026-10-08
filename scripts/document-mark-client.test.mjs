import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  DocumentMarkClientError,
  DOCUMENT_MARK_LIST_LIMIT,
  createDocumentMark,
  createDocumentMarkRecoverably,
  documentMarkRecoveryStorageKey,
  listDocumentMarks,
  parseDocumentMarkCreateIntent,
  parseDocumentMarkList,
  prepareDocumentMarkCreateIntent,
  readDocumentMarkRecoveries,
  validateDurableDocumentMark,
  writeDocumentMarkRecovery,
} from "../lib/document-mark-client.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import { canonicalAnchorJson } from "../lib/document-anchor.js"

const tenantId = "tenant-alpha"
const principalId = "40000000-0000-4000-8000-000000000001"
const documentRevisionId = "30000000-0000-4000-8000-000000000001"
const representationId = "20000000-0000-4000-8000-000000000001"
const representationSha = "b".repeat(64)
const scope = { tenantId, principalId, documentRevisionId }

function canonicalHash(value) {
  return createHash("sha256").update(canonicalAnchorJson(value), "utf8").digest("hex")
}

function canonicalAnchor(selector) {
  const selectorSha256 = canonicalHash(selector)
  const anchorSha256 = canonicalHash({ representationId, representationSha256: representationSha, selector })
  const id = `sha256:${anchorSha256}`
  return {
    schemaId: "gb.anchor.v1",
    id,
    ref: createGalaxyObjectReference("document.anchor", id, {
      mode: "pinned",
      revision: `sha256:${representationSha}`,
    }),
    document_revision_id: documentRevisionId,
    representation_id: representationId,
    representation_sha256: representationSha,
    selector,
    selector_kind: selector.kind,
    selector_sha256: selectorSha256,
    anchor_sha256: anchorSha256,
  }
}

function quoteAnchor(overrides = {}) {
  const selector = overrides.selector ?? { kind: "text-quote", exact: "An exact theorem $E = mc^2$.", page: 3 }
  return {
    ...canonicalAnchor(selector),
    title: "Ignored presentation field",
    ...overrides,
  }
}

function regionAnchor(selector = {
  kind: "page-region",
  page: 4,
  coordinateSpace: "normalized-page",
  polygon: [0.1, 0.2, 0.7, 0.2, 0.7, 0.8, 0.1, 0.8],
}) {
  return quoteAnchor({ selector, selector_kind: selector.kind })
}

function prepare(overrides = {}, idempotencyKey = "mark-operation-123") {
  return prepareDocumentMarkCreateIntent({
    anchor: quoteAnchor(),
    requestedAt: "2026-09-28T12:00:00.000Z",
    kind: "note",
    bodyMarkdown: "Because $x^2$ is conserved.",
    color: "#6D7A68",
    semanticRole: "note",
    tags: [" vortex ", "vortex", "proof"],
    state: "active",
    ...overrides,
  }, { idempotencyKey })
}

function acknowledgement(intent, overrides = {}) {
  const id = "50000000-0000-4000-8000-000000000001"
  const contentHash = canonicalHash({
    schemaId: "gb.document-mark.v1",
    anchorId: intent.anchor.id,
    kind: intent.kind,
    bodyMarkdown: intent.bodyMarkdown,
    color: intent.color,
    semanticRole: intent.semanticRole,
    tags: intent.tags,
    state: intent.state,
  })
  return {
    schemaId: "gb.document-mark.v1",
    id,
    ref: createGalaxyObjectReference("document.mark", id, {
      mode: "pinned",
      revision: `sha256:${contentHash}`,
    }),
    document_revision_id: documentRevisionId,
    anchor_id: intent.anchor.id,
    anchor_ref: intent.anchor.ref,
    kind: intent.kind,
    version: 1,
    revision_id: "60000000-0000-4000-8000-000000000001",
    content_hash: contentHash,
    body_markdown: intent.bodyMarkdown,
    color: intent.color,
    semantic_role: intent.semanticRole,
    tags: [...intent.tags],
    state: "active",
    created_by_principal_id: principalId,
    created_at: "2026-09-28T12:00:01Z",
    updated_at: "2026-09-28T12:00:01Z",
    replayed: false,
    ...overrides,
  }
}

function snapshot(overrides = {}) {
  const anchor = quoteAnchor()
  const state = {
    kind: "note",
    body_markdown: "Existing note with $x^2$.",
    color: "#6d7a68",
    semantic_role: "question",
    tags: ["proof"],
    state: "resolved",
    ...overrides,
  }
  const contentHash = canonicalHash({
    schemaId: "gb.document-mark.v1",
    anchorId: anchor.id,
    kind: state.kind,
    bodyMarkdown: state.body_markdown,
    color: state.color,
    semanticRole: state.semantic_role,
    tags: state.tags,
    state: state.state,
  })
  const id = state.id ?? "50000000-0000-4000-8000-000000000001"
  return {
    schemaId: "gb.document-mark.v1",
    id,
    ref: createGalaxyObjectReference("document.mark", id, { mode: "pinned", revision: `sha256:${contentHash}` }),
    document_revision_id: documentRevisionId,
    anchor_id: anchor.id,
    anchor_ref: anchor.ref,
    kind: state.kind,
    version: state.version ?? 2,
    revision_id: state.revision_id ?? "60000000-0000-4000-8000-000000000001",
    content_hash: contentHash,
    body_markdown: state.body_markdown,
    color: state.color,
    semantic_role: state.semantic_role,
    tags: state.tags,
    state: state.state,
    created_by_principal_id: principalId,
    created_at: "2026-09-28T12:00:01Z",
    updated_at: "2026-09-28T12:00:02Z",
  }
}

function jsonResponse(value, status = 201, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}

function memoryStorage() {
  const values = new Map()
  return {
    get length() { return values.size },
    key(index) { return [...values.keys()][index] ?? null },
    getItem(key) { return values.has(key) ? values.get(key) : null },
    setItem(key, value) { values.set(String(key), String(value)) },
    removeItem(key) { values.delete(String(key)) },
    values,
  }
}

test("document mark intent freezes caller identity, normalized fields, and exact request bytes", () => {
  const intent = prepare()
  assert.equal(intent.anchor.selector_sha256, "34a6c6132016a8daad143c969d545caaed9c07dc603a9444f695255b52699c5a")
  assert.equal(intent.anchor.anchor_sha256, "8539cbeffb5bb38d182a68e960b79e2bc1a17636c2f85008ef429ec73cc25ea9")
  assert.equal(intent.idempotencyKey, "mark-operation-123")
  assert.equal(intent.color, "#6d7a68")
  assert.deepEqual(intent.tags, ["vortex", "proof"])
  assert.deepEqual(JSON.parse(intent.requestBody), {
    kind: "note",
    body_markdown: "Because $x^2$ is conserved.",
    color: "#6d7a68",
    semantic_role: "note",
    tags: ["vortex", "proof"],
    state: "active",
    idempotency_key: "mark-operation-123",
  })
  assert.equal(parseDocumentMarkCreateIntent(JSON.parse(JSON.stringify(intent))).requestBody, intent.requestBody)
  assert.throws(
    () => parseDocumentMarkCreateIntent({ ...intent, requestBody: `${intent.requestBody} ` }),
    /frozen intent/,
  )
  assert.throws(
    () => parseDocumentMarkCreateIntent({ ...intent, anchor: { ...intent.anchor, presentation: "untrusted" } }),
    /anchor is invalid/i,
  )
  assert.throws(() => prepareDocumentMarkCreateIntent({
    anchor: quoteAnchor(), requestedAt: intent.requestedAt, kind: "note", bodyMarkdown: "x",
    color: "#6d7a68", semanticRole: "note", tags: [], state: "active",
  }), /idempotency/)
})

test("only canonical exact quotes and axis-aligned rectangular page regions are markable", () => {
  assert.equal(prepare({
    anchor: regionAnchor(), kind: "highlight", bodyMarkdown: "", semanticRole: "evidence",
  }).anchor.selector.kind, "page-region")
  assert.throws(() => prepare({
    anchor: quoteAnchor({ selector: { kind: "json-pointer", pointer: "/blocks/0" }, selector_kind: "json-pointer" }),
  }), /exact quote or rectangular/)
  assert.throws(() => prepare({
    anchor: regionAnchor({
      kind: "page-region", page: 1, coordinateSpace: "normalized-page",
      polygon: [0.5, 0.1, 0.9, 0.5, 0.5, 0.9, 0.1, 0.5],
    }),
  }), /axis-aligned rectangle/)
  assert.throws(() => prepare({ anchor: quoteAnchor({
    selector: { kind: "text-quote", exact: "x".repeat(16_001) }, selector_kind: "text-quote",
  }) }), /canonical bound/)
  assert.throws(() => prepare({ anchor: quoteAnchor({
    selector: { kind: "text-quote", exact: "exact", unsupported: true }, selector_kind: "text-quote",
  }) }), /selector is invalid/i)
  assert.throws(() => prepare({ anchor: regionAnchor({
    kind: "page-region", page: 1, coordinateSpace: "normalized-page",
    polygon: [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9], quoteHash: "A".repeat(64),
  }) }), /quote hash/)
  assert.throws(() => prepare({ kind: "ink" }), /kind and semantic role/)
  assert.throws(() => prepare({ kind: "highlight", semanticRole: "note" }), /inconsistent/)
  assert.throws(() => prepare({ requestedAt: "September 28, 2026 at noon" }), /request time/)

  const trusted = quoteAnchor()
  assert.throws(() => prepare({
    anchor: { ...trusted, selector: { ...trusted.selector, exact: "substituted selector" } },
  }), /canonical anchor identity/)
  assert.throws(() => prepare({
    anchor: { ...trusted, representation_id: "20000000-0000-4000-8000-000000000002" },
  }), /canonical anchor identity/)
})

test("full durable mark validation binds identity, payload, author, and pinned hashes", () => {
  const intent = prepare()
  const value = acknowledgement(intent)
  const mark = validateDurableDocumentMark(value, { intent, principalId })
  assert.equal(mark.content_hash, "f68d918a17468faa277508988694b239a01b9ae83f50f7bd4f0e04152bedf246")
  assert.equal(mark.ref, value.ref)
  assert.equal(mark.anchor_ref, intent.anchor.ref)
  assert.equal(mark.created_by_principal_id, principalId)
  for (const changed of [
    { ...value, body_markdown: "substituted" },
    { ...value, anchor_ref: createGalaxyObjectReference("document.anchor", intent.anchor.id, { mode: "pinned", revision: `sha256:${"d".repeat(64)}` }) },
    { ...value, created_by_principal_id: "40000000-0000-4000-8000-000000000002" },
    { ...value, version: 2 },
    { ...value, replayed: "false" },
    { ...value, created_at: "September 28, 2026" },
    { ...value, ref: createGalaxyObjectReference("document.mark", value.id, { mode: "pinned", revision: `sha256:${"d".repeat(64)}` }) },
    {
      ...value,
      content_hash: "f".repeat(64),
      ref: createGalaxyObjectReference("document.mark", value.id, {
        mode: "pinned", revision: `sha256:${"f".repeat(64)}`,
      }),
    },
    { ...value, unexpected: true },
  ]) {
    assert.throws(
      () => validateDurableDocumentMark(changed, { intent, principalId }),
      (error) => error instanceof DocumentMarkClientError && error.code === "invalid_response" && error.ambiguous,
    )
  }
})

test("mark history snapshots are strict, revision-bound, and include read-only legacy ink", () => {
  const anchor = quoteAnchor()
  const ink = snapshot({ kind: "ink", semantic_role: "evidence", state: "active", body_markdown: "" })
  const value = {
    schemaId: "gb.document-mark.list.v1",
    document_revision_id: documentRevisionId,
    anchor_id: anchor.id,
    marks: [ink],
  }
  const parsed = parseDocumentMarkList(value, {
    documentRevisionId,
    anchorId: anchor.id,
    anchorRef: anchor.ref,
  })
  assert.equal(parsed.marks[0].kind, "ink")
  assert.equal(parsed.marks[0].version, 2)
  assert.equal(parsed.completeness, "complete")
  for (const malformed of [
    { ...ink, replayed: false },
    { ...ink, version: 0 },
    { ...ink, created_by_principal_id: undefined },
    { ...ink, state: "deleted" },
    { ...ink, anchor_ref: createGalaxyObjectReference("document.anchor", anchor.id, { mode: "pinned", revision: `sha256:${"d".repeat(64)}` }) },
    { ...ink, body_markdown: "tampered" },
  ]) {
    assert.throws(() => parseDocumentMarkList({ ...value, marks: [malformed] }, {
      documentRevisionId, anchorId: anchor.id, anchorRef: anchor.ref,
    }), DocumentMarkClientError)
  }
})

test("the exact 1000-mark server boundary is reported as possibly incomplete", () => {
  const anchor = quoteAnchor()
  const marks = Array.from({ length: DOCUMENT_MARK_LIST_LIMIT }, (_, index) => snapshot({
    id: `50000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    revision_id: `60000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
  }))
  const parsed = parseDocumentMarkList({
    schemaId: "gb.document-mark.list.v1",
    document_revision_id: documentRevisionId,
    anchor_id: anchor.id,
    marks,
  }, { documentRevisionId, anchorId: anchor.id, anchorRef: anchor.ref })
  assert.equal(parsed.completeness, "possibly-incomplete")
  assert.throws(() => parseDocumentMarkList({
    schemaId: "gb.document-mark.list.v1",
    document_revision_id: documentRevisionId,
    anchor_id: anchor.id,
    marks: [...marks, snapshot({ id: "50000000-0000-4000-8000-ffffffffffff" })],
  }, { documentRevisionId, anchorId: anchor.id, anchorRef: anchor.ref }), /does not match/)
})

test("mark history transport is a bounded no-store same-origin GET bound to the full anchor", async () => {
  const anchor = quoteAnchor()
  let observed
  const result = await listDocumentMarks(anchor, {
    origin: "https://galaxy.example",
    fetcher: async (url, init) => {
      observed = { url, init }
      return new Response(JSON.stringify({
        schemaId: "gb.document-mark.list.v1",
        document_revision_id: documentRevisionId,
        anchor_id: anchor.id,
        marks: [snapshot()],
      }), {
        headers: { "Content-Type": "application/json" },
      })
    },
  })
  assert.equal(observed.init.method, "GET")
  assert.equal(observed.init.cache, "no-store")
  assert.equal(observed.init.redirect, "error")
  assert.equal(observed.init.headers.Accept, "application/json")
  assert.match(observed.url, new RegExp(encodeURIComponent(anchor.id)))
  assert.equal(result.marks.length, 1)
})

test("transport sends the frozen request body verbatim and rejects invalid successful responses ambiguously", async () => {
  const intent = prepare()
  let observed = null
  const mark = await createDocumentMark(intent, {
    principalId,
    async fetcher(url, init) {
      observed = { url, init }
      return jsonResponse(acknowledgement(intent))
    },
  })
  assert.equal(observed.init.body, intent.requestBody)
  assert.equal(observed.url, `/api/eln/documents/${documentRevisionId}/anchors/${encodeURIComponent(intent.anchor.id)}/marks`)
  assert.equal(mark.body_markdown, intent.bodyMarkdown)
  await assert.rejects(
    createDocumentMark(intent, {
      principalId,
      fetcher: async () => jsonResponse({ ok: true }),
    }),
    (error) => error instanceof DocumentMarkClientError && error.code === "invalid_response" && error.ambiguous,
  )
  await assert.rejects(
    createDocumentMark(intent, {
      principalId,
      fetcher: async () => jsonResponse({ error: "offline" }, 503),
    }),
    (error) => error instanceof DocumentMarkClientError && error.code === "request_failed"
      && error.ambiguous && error.status === 503,
  )
})

test("recovery enumeration is isolated by tenant, principal, and exact document revision", () => {
  const storage = memoryStorage()
  const intent = prepare()
  const otherScope = { ...scope, tenantId: "tenant-beta" }
  const otherPrincipalScope = { ...scope, principalId: "40000000-0000-4000-8000-000000000002" }
  const otherRevisionId = "30000000-0000-4000-8000-000000000002"
  const otherRevisionScope = { ...scope, documentRevisionId: otherRevisionId }
  const otherRevisionIntent = prepare({
    anchor: quoteAnchor({ document_revision_id: otherRevisionId }),
  }, "mark-other-revision")
  writeDocumentMarkRecovery(storage, scope, intent)
  writeDocumentMarkRecovery(storage, otherScope, intent)
  writeDocumentMarkRecovery(storage, otherPrincipalScope, intent)
  writeDocumentMarkRecovery(storage, otherRevisionScope, otherRevisionIntent)
  const invalidKey = documentMarkRecoveryStorageKey(scope, "malformed-operation")
  storage.setItem(invalidKey, "not-json")
  const otherKey = documentMarkRecoveryStorageKey(otherScope, intent.idempotencyKey)
  assert.equal(readDocumentMarkRecoveries(storage, scope).length, 1)
  assert.equal(storage.getItem(invalidKey), null)
  assert.notEqual(storage.getItem(otherKey), null, "another tenant's recovery is never removed")
  assert.equal(readDocumentMarkRecoveries(storage, otherPrincipalScope).length, 1)
  assert.equal(readDocumentMarkRecoveries(storage, otherRevisionScope).length, 1)
  assert.equal(readDocumentMarkRecoveries(storage, otherScope).length, 1)
})

test("an occupied recovery identity permits only the exact frozen intent without replacement", () => {
  const storage = memoryStorage()
  const intent = prepare()
  const key = documentMarkRecoveryStorageKey(scope, intent.idempotencyKey)
  writeDocumentMarkRecovery(storage, scope, intent)
  const exactRaw = storage.getItem(key)
  assert.deepEqual(writeDocumentMarkRecovery(storage, scope, intent).intent, intent)
  assert.equal(storage.getItem(key), exactRaw)

  const conflicting = prepare({ bodyMarkdown: "Different request bytes" }, intent.idempotencyKey)
  assert.throws(
    () => writeDocumentMarkRecovery(storage, scope, conflicting),
    (error) => error instanceof DocumentMarkClientError && error.code === "recovery_conflict",
  )
  assert.equal(storage.getItem(key), exactRaw)

  storage.setItem(key, "not-json")
  assert.throws(
    () => writeDocumentMarkRecovery(storage, scope, intent),
    (error) => error instanceof DocumentMarkClientError && error.code === "recovery_conflict",
  )
  assert.equal(storage.getItem(key), "not-json", "occupied malformed recovery is not overwritten or deleted")
})

test("recoverable create writes before delivery, retains uncertainty, and retries identical bytes and key", async () => {
  const storage = memoryStorage()
  const intent = prepare()
  const key = documentMarkRecoveryStorageKey(scope, intent.idempotencyKey)
  const bodies = []
  await assert.rejects(
    createDocumentMarkRecoverably(intent, {
      scope,
      storage,
      async fetcher(_url, init) {
        assert.notEqual(storage.getItem(key), null, "recovery exists before fetch")
        bodies.push(init.body)
        throw new TypeError("network dropped after send")
      },
    }),
    (error) => error instanceof DocumentMarkClientError && error.code === "transport_error" && error.ambiguous,
  )
  const [recovery] = readDocumentMarkRecoveries(storage, scope)
  assert.equal(recovery.intent.requestBody, intent.requestBody)
  assert.equal(recovery.intent.idempotencyKey, intent.idempotencyKey)
  const mark = await createDocumentMarkRecoverably(recovery.intent, {
    scope,
    storage,
    async fetcher(_url, init) {
      assert.notEqual(storage.getItem(key), null)
      bodies.push(init.body)
      return jsonResponse(acknowledgement(intent, { replayed: true }))
    },
  })
  assert.deepEqual(bodies, [intent.requestBody, intent.requestBody])
  assert.equal(mark.replayed, true)
  assert.equal(storage.getItem(key), null)
})

test("invalid successful acknowledgement retains the exact recovery", async () => {
  const storage = memoryStorage()
  const intent = prepare()
  const key = documentMarkRecoveryStorageKey(scope, intent.idempotencyKey)
  await assert.rejects(
    createDocumentMarkRecoverably(intent, {
      scope,
      storage,
      fetcher: async () => jsonResponse({ ...acknowledgement(intent), body_markdown: "wrong" }),
    }),
    (error) => error instanceof DocumentMarkClientError && error.ambiguous,
  )
  assert.notEqual(storage.getItem(key), null)
})

test("successful acknowledgement does not clear a recovery replaced while the request is in flight", async () => {
  for (const replacement of [
    "not-json",
    JSON.stringify({
      schemaId: "gb.document-mark-recovery.v1",
      ...scope,
      intent: prepare({ bodyMarkdown: "A different frozen request" }, "mark-operation-123"),
    }),
  ]) {
    const storage = memoryStorage()
    const intent = prepare()
    const key = documentMarkRecoveryStorageKey(scope, intent.idempotencyKey)
    await createDocumentMarkRecoverably(intent, {
      scope,
      storage,
      fetcher: async () => {
        storage.setItem(key, replacement)
        return jsonResponse(acknowledgement(intent))
      },
    })
    assert.equal(storage.getItem(key), replacement)
  }
})
