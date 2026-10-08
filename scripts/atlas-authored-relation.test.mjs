import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  ATLAS_AUTHORED_RELATIONS,
  atlasAuthoredRelationEligibility,
  inspectAtlasAuthoredRelationEndpoint,
  mergeAtlasAuthoredRelation,
  prepareAtlasAuthoredRelation,
  projectAtlasExactRelationPlacements,
  readAtlasAuthoredRelationRecovery,
  reconcileAtlasObjectLinks,
  removeAtlasAuthoredRelationRecovery,
  resolveAtlasAuthoredRelationEndpoint,
  validateAtlasAuthoredRelationReceipt,
  writeAtlasAuthoredRelationRecovery,
} from "../lib/canvas/atlas-authored-relation.js"

const fromRef = "gb:object:v1:document:source:pinned:sha256%3Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const otherDocumentRef = "gb:object:v1:document:other:pinned:sha256%3Abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const toRef = "gb:object:v1:ham.task:target:pinned:version%3A7"
const atlasSource = readFileSync(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8")
const dialogSource = readFileSync(new URL("../components/atlas/atlas-relation-compose-dialog.tsx", import.meta.url), "utf8")

test("Atlas authored relation endpoints require exact canonical pins", () => {
  assert.deepEqual(inspectAtlasAuthoredRelationEndpoint(fromRef), { ok: true, ref: fromRef })
  for (const invalid of [
    "gb:object:v1:document:source:latest",
    "gb:object:v1:document:source:pinned:SHA256%3Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "gb:node:source",
    "",
    null,
  ]) {
    assert.deepEqual(inspectAtlasAuthoredRelationEndpoint(invalid), {
      ok: false,
      code: "exact_reference_required",
    })
  }
})

test("Atlas binds authored endpoints only through an identity-matched resolved hydration", () => {
  const hydration = {
    status: "resolved",
    requestedRef: "gb:object:v1:document:source:latest",
    resolvedRef: fromRef,
    projection: { ref: fromRef },
  }
  assert.deepEqual(resolveAtlasAuthoredRelationEndpoint(hydration.requestedRef, hydration), { ok: true, ref: fromRef })
  for (const invalid of [
    { ...hydration, status: "loading" },
    { ...hydration, requestedRef: toRef },
    { ...hydration, resolvedRef: toRef, projection: { ref: toRef } },
    { ...hydration, resolvedRef: otherDocumentRef, projection: { ref: otherDocumentRef } },
    { ...hydration, projection: { ref: toRef } },
  ]) {
    assert.deepEqual(resolveAtlasAuthoredRelationEndpoint(hydration.requestedRef, invalid), {
      ok: false,
      code: "exact_reference_required",
    })
  }
})

test("Atlas projects exact relation refs transiently and rejects duplicate placement ambiguity", () => {
  const requestedRef = "gb:object:v1:document:source:latest"
  const placements = [{
    id: "placement-a",
    subjectRef: requestedRef,
    authorized: false,
    availability: "unavailable",
  }]
  const exact = projectAtlasExactRelationPlacements(placements, {
    [requestedRef]: {
      status: "resolved",
      requestedRef,
      resolvedRef: fromRef,
      projection: { ref: fromRef },
    },
  })
  assert.equal(exact[0].subjectRef, fromRef)
  assert.equal(exact[0].authorized, true)
  assert.equal(exact[0].availability, "resolved")
  assert.deepEqual(atlasAuthoredRelationEligibility(
    { relationRef: fromRef },
    new Map([[fromRef, 1]]),
  ), { ok: true, ref: fromRef })
  assert.deepEqual(atlasAuthoredRelationEligibility(
    { relationRef: fromRef },
    new Map([[fromRef, 2]]),
  ), { ok: false, reason: "This exact object appears more than once on this Atlas." })
})

test("Atlas authors only the closed relation vocabulary with stable provenance", () => {
  assert.equal(ATLAS_AUTHORED_RELATIONS.length, 11)
  const request = prepareAtlasAuthoredRelation({
    fromRef,
    toRef,
    relation: "context_for",
    idempotencyKey: "atlas-relation:00000000-0000-4000-8000-000000000001",
  })
  assert.deepEqual(request, {
    from_ref: fromRef,
    to_ref: toRef,
    relation: "context_for",
    basis: "authored",
    provenance: { source: "manual", source_system: "galaxy.atlas.relation-composer.v1" },
    idempotency_key: "atlas-relation:00000000-0000-4000-8000-000000000001",
  })
  for (const invalid of ["supports", "challenges", "verifies", ""] ) {
    assert.throws(() => prepareAtlasAuthoredRelation({
      fromRef,
      toRef,
      relation: invalid,
      idempotencyKey: "atlas-relation:00000000-0000-4000-8000-000000000001",
    }), /Unsupported authored relation/)
  }
})

test("Atlas rejects self-links, mutable endpoints, and changed retry identities", () => {
  assert.throws(() => prepareAtlasAuthoredRelation({
    fromRef,
    toRef: fromRef,
    relation: "related",
    idempotencyKey: "atlas-relation:00000000-0000-4000-8000-000000000001",
  }), /two different objects/)
  assert.throws(() => prepareAtlasAuthoredRelation({
    fromRef: "gb:object:v1:ham.task:source:latest",
    toRef,
    relation: "related",
    idempotencyKey: "atlas-relation:00000000-0000-4000-8000-000000000001",
  }), /exact pinned/)
  assert.throws(() => prepareAtlasAuthoredRelation({
    fromRef,
    toRef,
    relation: "related",
    idempotencyKey: "short",
  }), /operation identity/)
})

test("Atlas accepts only a request-bound active-link receipt", () => {
  const request = prepareAtlasAuthoredRelation({
    fromRef,
    toRef,
    relation: "related",
    idempotencyKey: "atlas-relation:00000000-0000-4000-8000-000000000001",
  })
  const receipt = {
    id: "50000000-0000-4000-8000-000000000001",
    from_ref: fromRef,
    to_ref: toRef,
    relation: "related",
    basis: "authored",
    provenance: { source: "manual", source_system: "galaxy.atlas.relation-composer.v1" },
    created_by_principal_id: "10000000-0000-4000-8000-000000000001",
    created_at: "2026-09-27T12:00:00Z",
    version: 1,
  }
  assert.deepEqual(validateAtlasAuthoredRelationReceipt(receipt, request), receipt)
  for (const changed of [
    { ...receipt, to_ref: fromRef },
    { ...receipt, relation: "cites" },
    { ...receipt, basis: "derived" },
    { ...receipt, provenance: { source: "manual", source_system: "other" } },
    { ...receipt, version: 2 },
  ]) {
    assert.throws(() => validateAtlasAuthoredRelationReceipt(changed, request), /receipt/)
  }
})

test("confirmed authored relation insertion is idempotent and collision-safe", () => {
  const link = {
    id: "50000000-0000-4000-8000-000000000001",
    from_ref: fromRef,
    to_ref: toRef,
    relation: "related",
    basis: "authored",
    provenance: { source: "manual", source_system: "galaxy.atlas.relation-composer.v1" },
    version: 1,
  }
  const inserted = mergeAtlasAuthoredRelation([], link)
  assert.deepEqual(inserted, [link])
  assert.equal(mergeAtlasAuthoredRelation(inserted, link), inserted)
  assert.throws(() => mergeAtlasAuthoredRelation(inserted, { ...link, relation: "cites" }), /conflicts/)
})

test("bounded exact refresh is linear, deduplicates rows, and never treats omission as retraction", () => {
  const provenance = { source: "manual", source_system: "galaxy.atlas.relation-composer.v1" }
  const stale = {
    id: "50000000-0000-4000-8000-000000000000",
    from_ref: fromRef,
    to_ref: toRef,
    relation: "related",
    basis: "authored",
    provenance,
    version: 1,
  }
  const links = Array.from({ length: 3200 }, (_, index) => ({
    ...stale,
    id: `50000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  }))
  const started = performance.now()
  const reconciled = reconcileAtlasObjectLinks([stale], [
    { links: [...links, ...links] },
  ])
  assert.equal(reconciled.length, links.length + 1)
  assert.ok(reconciled.some((link) => link.id === stale.id))
  assert.ok(performance.now() - started < 1000, "bounded refresh should not regress to quadratic merging")
  assert.deepEqual(reconcileAtlasObjectLinks([stale], [
    { links: [] },
  ]), [stale])
})

test("ambiguous authored relation recovery preserves the exact request and scope", () => {
  const values = new Map()
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
  const scope = { tenantId: "tenant-a", principalId: "principal-a", canvasId: "canvas-a" }
  const request = prepareAtlasAuthoredRelation({
    fromRef,
    toRef,
    relation: "depends_on",
    idempotencyKey: "atlas-relation:00000000-0000-4000-8000-000000000001",
  })
  const draft = {
    source: { placementId: "placement-a", label: "Source", relationRef: fromRef },
    target: { placementId: "placement-b", label: "Target", relationRef: toRef },
    request,
  }
  assert.deepEqual(writeAtlasAuthoredRelationRecovery(storage, scope, draft), {
    schemaId: "gb.atlas-authored-relation-recovery.v1",
    ...draft,
  })
  assert.deepEqual(readAtlasAuthoredRelationRecovery(storage, scope), {
    schemaId: "gb.atlas-authored-relation-recovery.v1",
    ...draft,
  })
  assert.equal(readAtlasAuthoredRelationRecovery(storage, { ...scope, canvasId: "canvas-b" }), null)
  removeAtlasAuthoredRelationRecovery(storage, scope)
  assert.equal(readAtlasAuthoredRelationRecovery(storage, scope), null)
})

test("Atlas relation composer keeps exact links transient and outside canvas persistence", () => {
  assert.match(atlasSource, /projectAtlasExactRelationPlacements\(/)
  assert.match(atlasSource, /projectAuthorizedObjectLinkRelations\(\s*exactRelationPlacements,/)
  assert.match(atlasSource, /mapAtlasObjectLinksWithConcurrency\(references, controller\.signal\)/)
  assert.match(atlasSource, /const normalized = normalizeObjectLinkPage\(body\)/)
  assert.doesNotMatch(atlasSource, /function stripAtlasObjectLink/)
  assert.match(atlasSource, /reconcileAtlasObjectLinks\(current\.objectLinks \?\? \[\], refreshes\)/)
  assert.match(atlasSource, /exactRelationMutationGenerationRef\.current !== mutationGeneration/)
  assert.match(atlasSource, /setExactRelationRefreshEpoch\(\(current\) => current \+ 1\)/)
  assert.match(atlasSource, /mergeAtlasAuthoredRelation\(links, confirmed\)/)
  assert.doesNotMatch(atlasSource, /commandsForPlacementGeometry\([^)]*relation/i)
  assert.match(atlasSource, /writeAtlasAuthoredRelationRecovery\(window\.sessionStorage/)
  assert.match(atlasSource, /Retry the same relation to reconcile it safely/)
  assert.match(atlasSource, /let request = relationRequest\s+if \(!request\) {[\s\S]{0,300}atlasAuthoredRelationEligibility/)
  assert.doesNotMatch(atlasSource, /relationComposeError\([^)]*detail/)
})

test("Canvas HUD, inspector, and accessible list share one explicit directional dialog", () => {
  assert.ok((atlasSource.match(/onRelationAction=/g) ?? []).length >= 3)
  assert.match(atlasSource, /Link from this object/)
  assert.match(atlasSource, /Use \$\{resolvedProjection\.title\} as target/)
  assert.match(atlasSource, /Relation mode canceled/)
  assert.match(dialogSource, /Source/)
  assert.match(dialogSource, /Target/)
  assert.match(dialogSource, /Swap relation source and target/)
  assert.match(dialogSource, /durable authored assertion[\s\S]{0,100}it does not verify either object/i)
  assert.match(dialogSource, /max-h-\[min\(42rem,calc\(100dvh-2rem\)\)\]/)
  assert.match(dialogSource, /min-h-11/)
  assert.match(dialogSource, /onCloseAutoFocus/)
  assert.match(dialogSource, /returnFocusRef/)
  assert.match(dialogSource, /motion-reduce:animate-none/)
  assert.match(dialogSource, /if \(!nextOpen && \(busy \|\| ambiguous\)\) return/)
  assert.match(dialogSource, /Confirm release retry/)
})

test("relation targeting remains visible across views and can be canceled accessibly", () => {
  assert.match(atlasSource, /relationSource && !relationComposeOpen \? \(\s*<section[\s\S]{0,300}aria-label="Relation mode"/)
  assert.match(atlasSource, /const relationModeAnnouncement = relationSource && !relationComposeOpen/)
  assert.match(atlasSource, /<p className="sr-only" role="status" aria-live="polite" aria-atomic="true">\s*\{relationModeAnnouncement\}/)
  assert.doesNotMatch(atlasSource, /atlas-relation-mode-strip[\s\S]{0,400}role="status"/)
  assert.match(atlasSource, /From \{relationSource\.label\}/)
  assert.match(atlasSource, /Choose target in List/)
  assert.match(atlasSource, /const requestRelationListView = useCallback[\s\S]{0,300}requestAnimationFrame[\s\S]{0,180}relationModeCancelRef\.current\?\.focus/)
  assert.match(atlasSource, /onClick=\{requestRelationListView\}/)
  assert.match(atlasSource, /ref=\{relationModeCancelRef\}/)
  assert.match(atlasSource, /aria-keyshortcuts="Escape"/)
  assert.match(atlasSource, /const cancelRelationMode = useCallback[\s\S]{0,600}returnFocus\?\.isConnected[\s\S]{0,300}focus\(\{ preventScroll: true \}\)/)
  assert.match(atlasSource, /relationModeReturnFocusRef\.current = trigger[\s\S]{0,160}setRelationSource\(endpoint\)/)
  assert.match(atlasSource, /if \(!relationSource \|\| relationComposeOpen \|\| relationComposeBusy\)[\s\S]{0,600}cancelRelationMode\(\)/)
  assert.doesNotMatch(atlasSource, /Linking from \$\{selection\.label\}/)
})
