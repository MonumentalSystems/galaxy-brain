import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { createPluginRegistry } from "../lib/plugins/registry.js"
import { projectSurface, projectSurfaceProvenance, surfaceDisplayText } from "../lib/surface-projection.js"
import { formatSurfaceCell, projectChartData, projectKnowledgeGraphData, projectTimelineData } from "../lib/surface-render-data.js"
import {
  BUILTIN_GENEROUS_SURFACE_RENDERER,
  getSurfaceRenderer,
  isCompatibleSurfaceCatalogDigest,
  scrubResolvedSurfaceBindings,
} from "../lib/surface-renderer-registry.js"
import { validateResolvedSurface } from "../lib/surface-resolution-contract.js"

/** The catalog before SVGPreview; test_surface_contract.py recomputes it. */
const PREVIOUS_CATALOG_DIGEST = "c2ac06907552b576c9967a85779c539d83ea6b81dab7129058a056e791c5e375"

function researchBoard() {
  return {
    schema: "gb.surface.v1",
    catalog: { id: "generous.a2ui", version: "1" },
    surfaceUpdate: {
      surfaceId: "research-board",
      components: [
        { id: "root", component: { Column: {} }, children: ["title", "table"] },
        { id: "title", component: { Title: { text: "Research Board" } }, parentId: "root" },
        {
          id: "table",
          component: { DataTable: { data: { columns: [], rows: [] } } },
          parentId: "root",
        },
      ],
    },
    bindings: [],
  }
}

test("surface revision selection remains scoped to the selected surface", async () => {
  const browser = await readFile(
    new URL("../components/surfaces/surface-browser.tsx", import.meta.url),
    "utf8",
  )
  assert.match(browser, /setRevisions\(\[\]\)[\s\S]*if \(!sameSurface\) setSelectedVersion\(null\)[\s\S]*getSurfaceRevisions\(selectedId\)/)
  assert.match(browser, /revision\.surface_id === selectedId && revision\.version === selectedVersion/)
  assert.match(browser, /getSurfaceRenderer\(renderSpec\)/)
  assert.match(browser, /surfaceRenderer\?\.implementationId === "builtin\.surface-renderer\.generous-a2ui"/)
  assert.match(browser, /This surface has no registered renderer/)
  assert.match(browser, /<TopRailTitle>Generous surfaces<\/TopRailTitle>/)
  assert.match(browser, /Browse promoted Generous surfaces, inspect their immutable revisions, and keep provenance visible\./)
})

test("an explicit review link exact-fetches one authorized revision without enumerating drafts", async () => {
  const [browser, page] = await Promise.all([
    readFile(new URL("../components/surfaces/surface-browser.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/surfaces/page.tsx", import.meta.url), "utf8"),
  ])
  assert.match(browser, /getSurfaces\(\{ status: "promoted", limit: 200 \}\)/)
  assert.match(browser, /initialSurfaceId && !compatibleSurfaces\.some\(\(surface\) => surface\.id === initialSurfaceId\)/)
  assert.match(browser, /getSurface\(initialSurfaceId\)/)
  assert.match(browser, /getSurfaceRevision\(selectedId, initialSurfaceVersion\)/)
  assert.match(browser, /authorizedLinkedSurface/)
  assert.match(browser, /!\["draft", "promoted", "archived"\]\.includes\(surface\.status\)/)
  assert.match(browser, /validRenderableSurfaceSpec\(surface\.current_spec\)/)
  assert.match(browser, /revision\.surface_id === selectedId/)
  assert.match(browser, /revision\.version === initialSurfaceVersion/)
  assert.match(browser, /revision\.content_hash === initialSurfaceHash/)
  assert.match(browser, /\["draft", "promoted", "archived"\]\.includes\(revision\.status\)/)
  assert.match(browser, /validRenderableSurfaceSpec\(revision\.spec\)/)
  assert.match(browser, /loadGeneration\.current/)
  assert.match(browser, /mutable surface head was not substituted/)
  assert.doesNotMatch(browser, /getSurfaces\(\{ status: "draft"/)
  assert.match(page, /requestedSurface\.toLowerCase\(\)/)
  assert.match(page, /initialSurfaceVersion/)
  assert.match(page, /initialSurfaceHash/)
})

test("partial, duplicated, and malformed exact selectors fail closed without browsing mutable state", async () => {
  const [browser, page] = await Promise.all([
    readFile(new URL("../components/surfaces/surface-browser.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/surfaces/page.tsx", import.meta.url), "utf8"),
  ])
  assert.match(page, /surface\?: string \| string\[\]/)
  assert.match(page, /version\?: string \| string\[\]/)
  assert.match(page, /hash\?: string \| string\[\]/)
  assert.match(page, /const exactSelectorPresent = requested\.surface !== undefined[\s\S]*requested\.hash !== undefined/)
  assert.match(page, /const validExactSelector = exactSelectorPresent[\s\S]*UUID\.test\(requestedSurface\)[\s\S]*\^\[1-9\][\s\S]*\^\[0-9a-f\]\{64\}\$/)
  assert.match(page, /const invalidExactLink = exactSelectorPresent && !validExactSelector/)
  assert.match(page, /invalidExactLink=\{invalidExactLink\}/)
  assert.match(browser, /invalidExactLink = false/)
  const invalidGuard = browser.indexOf("if (invalidExactLink)")
  const browse = browser.indexOf('galaxyBrainAPI.getSurfaces({ status: "promoted", limit: 200 })')
  assert.ok(invalidGuard >= 0 && browse > invalidGuard)
  assert.match(browser, /setExactReviewError\("The exact surface link is invalid\."\)/)
  assert.match(browser, /\[initialSurfaceId, invalidExactLink, reviewKey\]/)
})

test("exact surface links remain immutable across promoted, archived, and historical revisions", async () => {
  const browser = await readFile(new URL("../components/surfaces/surface-browser.tsx", import.meta.url), "utf8")
  assert.match(browser, /selectedRevision\?\.surface_id === initialSurfaceId/)
  assert.match(browser, /\["draft", "promoted", "archived"\]\.includes\(selectedRevision\.status\)/)
  assert.match(browser, /Viewing the exact \$\{exactRevision\.status\} revision/)
  assert.match(browser, /exactRevision\?\.status === "draft" && surfaceHeadMatchesReview\(selected, exactRevision\)/)
  assert.match(browser, /exactRevision\.status === "draft" \? \(/)
  assert.match(browser, /setDismissedReviewKey\(reviewKey\)/)
  assert.match(browser, /url\.searchParams\.delete\("surface"\)/)
  assert.match(browser, /url\.searchParams\.delete\("version"\)/)
  assert.match(browser, /url\.searchParams\.delete\("hash"\)/)
  assert.match(browser, /window\.history\.replaceState\(null, "", `\$\{url\.pathname\}\$\{url\.search\}\$\{url\.hash\}`\)/)
  assert.match(browser, /onClick=\{\(\) => selectSurfaceRevision\(null\)\}/)
  assert.match(browser, /onClick=\{\(\) => selectSurfaceRevision\(revision\.version\)\}/)
  assert.match(browser, /onClick=\{\(\) => selectSurface\(surface\.id\)\}/)
  assert.match(browser, /const selectSurface = useCallback/)
})

test("resolved bindings are identity-fenced and fail closed before rendering", async () => {
  const [browser, contract, server] = await Promise.all([
    readFile(new URL("../components/surfaces/surface-browser.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/surface-resolution-contract.js", import.meta.url), "utf8"),
    readFile(new URL("../services/galaxy-brain-api/server.py", import.meta.url), "utf8"),
  ])
  assert.match(contract, /candidate\.surface_id !== expected\.surfaceId/)
  assert.match(contract, /candidate\.version !== expected\.version/)
  assert.match(contract, /candidate\.definition_content_hash !== expected\.contentHash/)
  assert.match(contract, /candidate\.schema_digest !== BUILTIN_GENEROUS_SURFACE_RENDERER\.schemaDigest/)
  assert.match(contract, /!isCompatibleSurfaceCatalogDigest\(candidate\.catalog_digest\)/)
  assert.match(contract, /candidate\.renderer_version !== BUILTIN_GENEROUS_SURFACE_RENDERER\.rendererVersion/)
  assert.match(contract, /stableJson\(candidate\.definition\) !== stableJson\(expected\.definition\)/)
  assert.equal((contract.match(/validRenderableSurfaceSpec\(candidate\.(?:definition|materialized_spec)\)/g) ?? []).length, 2)
  assert.match(contract, /candidate\.bindings\.length !== expectedBindings\.size/)
  assert.match(contract, /observed\.has\(binding\.binding_id\)/)
  assert.match(contract, /binding\.target\?\.componentId !== expectedBinding\.target\.componentId/)
  assert.match(contract, /binding\.source_kind !== expectedBinding\.source\.kind/)
  assert.match(contract, /binding\.resolved_at !== candidate\.resolved_at/)
  assert.match(contract, /binding\.status === "resolved" && binding\.error !== undefined/)
  assert.match(contract, /scrubResolvedSurfaceBindings\(candidate\.definition, candidate\.bindings\)/)
  assert.match(contract, /stableJson\(scrubbedDefinition\) !== stableJson\(scrubbedMaterialization\)/)
  assert.match(browser, /const validated = validateResolvedSurface\(next,/)
  assert.match(browser, /if \(!validated\) throw new Error/)
  assert.match(browser, /setResolution\(validated\)/)
  assert.match(browser, /This binding could not be resolved\./)
  assert.doesNotMatch(browser, />\{binding\.error\}</)
  assert.match(server, /SELECT version, spec, content_hash, schema_digest, catalog_digest, renderer_version/)
  assert.match(server, /"schema_digest": schema_digest/)
  assert.match(server, /"catalog_digest": catalog_digest/)
  assert.match(server, /"renderer_version": renderer_version/)
})

test("Atlas can validate an exact materialized surface without owning its immutable definition", () => {
  const definition = researchBoard()
  const resolvedAt = "2026-09-27T12:00:00Z"
  const resolution = {
    surface_id: "surface-1",
    version: 4,
    definition_content_hash: "a".repeat(64),
    schema_digest: BUILTIN_GENEROUS_SURFACE_RENDERER.schemaDigest,
    catalog_digest: BUILTIN_GENEROUS_SURFACE_RENDERER.catalogDigest,
    renderer_version: BUILTIN_GENEROUS_SURFACE_RENDERER.rendererVersion,
    definition,
    materialized_spec: structuredClone(definition),
    bindings: [],
    resolved_at: resolvedAt,
  }
  assert.equal(validateResolvedSurface(resolution, {
    surfaceId: "surface-1",
    version: 4,
    contentHash: "a".repeat(64),
  }), resolution)
  assert.equal(validateResolvedSurface(resolution, {
    surfaceId: "surface-1",
    version: 3,
    contentHash: "a".repeat(64),
  }), null)

  // A revision keeps the catalog digest it was saved under.
  const expected = { surfaceId: "surface-1", version: 4, contentHash: "a".repeat(64) }
  const savedEarlier = { ...resolution, catalog_digest: PREVIOUS_CATALOG_DIGEST }
  assert.equal(validateResolvedSurface(savedEarlier, expected), savedEarlier)
  assert.equal(validateResolvedSurface({ ...resolution, catalog_digest: "d".repeat(64) }, expected), null)
})

test("surfaces saved under an earlier catalog still render after an additive change", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../services/galaxy-brain-api/contracts/gb.surface.v1.json", import.meta.url),
    "utf8",
  ))
  // New saves get the current catalog; it is always the first compatible one.
  assert.equal(BUILTIN_GENEROUS_SURFACE_RENDERER.catalogDigest, manifest.digests.catalog)
  assert.equal(BUILTIN_GENEROUS_SURFACE_RENDERER.compatibleCatalogDigests[0], manifest.digests.catalog)
  assert.ok(isCompatibleSurfaceCatalogDigest(manifest.digests.catalog))
  assert.ok(isCompatibleSurfaceCatalogDigest(PREVIOUS_CATALOG_DIGEST))
  for (const digest of ["d".repeat(64), "", undefined, null, PREVIOUS_CATALOG_DIGEST.toUpperCase()]) {
    assert.equal(isCompatibleSurfaceCatalogDigest(digest), false, String(digest))
  }
  assert.ok(Object.isFrozen(BUILTIN_GENEROUS_SURFACE_RENDERER.compatibleCatalogDigests))
})

test("overlapping resolved binding targets are scrubbed independently of binding order", () => {
  const definition = researchBoard()
  const materialized = structuredClone(definition)
  materialized.surfaceUpdate.components[2].component.DataTable.data = {
    columns: [{ key: "claim", label: "Claim" }],
    rows: [{ claim: "Exact result" }],
  }
  const parent = { status: "resolved", target: { componentId: "table", prop: "data" } }
  const child = { status: "resolved", target: { componentId: "table", prop: "data.rows" } }
  const forward = scrubResolvedSurfaceBindings(materialized, [parent, child])
  const reverse = scrubResolvedSurfaceBindings(materialized, [child, parent])
  assert.deepEqual(forward, reverse)
  assert.equal(forward.surfaceUpdate.components[2].component.DataTable.data, "__galaxy_resolved_binding_value__")
})

test("a requested historical revision never falls back to the mutable head", async () => {
  const browser = await readFile(new URL("../components/surfaces/surface-browser.tsx", import.meta.url), "utf8")
  assert.match(browser, /const requestedRevisionUnavailable = selectedVersion !== null && selectedRevision === null/)
  assert.match(browser, /const previewCompatible = !requestedRevisionUnavailable/)
})

test("exact-link dismissal and same-route selector changes cannot retain stale content", async () => {
  const browser = await readFile(new URL("../components/surfaces/surface-browser.tsx", import.meta.url), "utf8")
  assert.match(browser, /setExactLinkUnavailable\(false\)[\s\S]*setExactReviewError\(null\)/)
  assert.match(browser, /const selectorPending = loadedReviewKey !== reviewKey/)
  assert.match(browser, /selectorPending \? \[\] : linkedDraft/)
  assert.match(browser, /selectorPending \? \([\s\S]*Loading the requested surface/)
})

test("only the exact current promoted surface offers an explicit Atlas handoff", async () => {
  const browser = await readFile(new URL("../components/surfaces/surface-browser.tsx", import.meta.url), "utf8")
  assert.match(browser, /atlasReferenceHandoffHref\(promotedSurfaceReference\(selected\)\)/)
  assert.match(browser, /selected\.status !== "promoted"/)
  assert.match(browser, /selectedVersion !== null && selectedRevision\?\.version !== selected\.current_version/)
  assert.match(browser, /previewHash !== selected\.current_content_hash/)
  assert.match(browser, />Place exact surface on Atlas</)
})

test("surface records and revisions must match the code-pinned renderer contract", async () => {
  const [browser, api, types, registry] = await Promise.all([
    readFile(new URL("../components/surfaces/surface-browser.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/galaxy-brain-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/types/surfaces.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/surface-renderer-registry.js", import.meta.url), "utf8"),
  ])
  assert.match(types, /interface GalaxySurfaceContractManifest/)
  assert.match(api, /getSurfaceContract\(\)/)
  assert.match(api, /this\.gbFetch\("\/surfaces\/contract"\)/)
  assert.match(browser, /galaxyBrainAPI\.getSurfaceContract\(\)/)
  assert.match(browser, /authorizedSurfaceContract\(contractResponse\)/)
  assert.match(registry, /BUILTIN_GENEROUS_SURFACE_RENDERER/)
  assert.match(registry, /schemaDigest:/)
  assert.match(registry, /catalogDigest:/)
  assert.match(registry, /rendererVersion:/)
  assert.match(browser, /manifest\.catalog\.renderer\?\.id !== BUILTIN_GENEROUS_SURFACE_RENDERER\.rendererId/)
  assert.match(browser, /manifest\.digests\.schema !== BUILTIN_GENEROUS_SURFACE_RENDERER\.schemaDigest/)
  assert.match(browser, /surface\.schema_digest === contract\.digests\.schema/)
  assert.match(browser, /isCompatibleSurfaceCatalogDigest\(surface\.catalog_digest\)/)
  assert.match(browser, /isCompatibleSurfaceCatalogDigest\(revision\.catalog_digest\)/)
  assert.match(browser, /surface\.renderer_version === contract\.catalog\.renderer\.version/)
  assert.match(browser, /revision\.schema_digest === contract\.digests\.schema/)
  assert.match(browser, /surfaceRevisionMatchesContract\(revision, contract\)/)
  assert.match(browser, /authorizedLinkedSurface\(receipt\.surface, receipt\.surface\.id, surfaceContract\)/)
  assert.match(browser, /surface\.status === "promoted" && authorizedLinkedSurface/)
  assert.match(browser, /function authorizedSurfaceRevision/)
  assert.match(browser, /function normalizedSurfaceRevisions/)
  assert.match(browser, /ids\.has\(revision\.id\) \|\| versions\.has\(revision\.version\)/)
  assert.match(browser, /const desiredVersion = sameSurface \? selectedVersionRef\.current : null/)
  assert.match(browser, /restoredRevision\?\.version/)
})

test("an exact current draft requires explicit review before version-fenced promotion", async () => {
  const [browser, api] = await Promise.all([
    readFile(new URL("../components/surfaces/surface-browser.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/galaxy-brain-api.ts", import.meta.url), "utf8"),
  ])
  assert.match(browser, /surfaceHeadMatchesReview\(selected, exactRevision\)/)
  assert.match(browser, /Promote this exact surface revision\?/)
  assert.match(browser, /baseVersion: promotableDraft\.version/)
  assert.match(browser, /baseContentHash: promotableDraft\.content_hash/)
  assert.match(browser, /promotionRetry\.current\?\.candidateKey === candidateKey/)
  assert.match(browser, /normalizeSurfacePromotionResponse\(result, promotableDraft\)/)
  assert.match(browser, /surfacePromotionProvenance\(promotableDraft\.provenance\)/)
  assert.match(browser, /selectedIdRef\.current !== selected\.id/)
  assert.match(browser, /generation !== promotionGeneration\.current/)
  assert.match(browser, /useLayoutEffect\(\(\) => \{[\s\S]*promotionGeneration\.current \+= 1[\s\S]*return \(\) => \{[\s\S]*promotionGeneration\.current \+= 1[\s\S]*\}, \[reviewKey\]\)/)
  const promotionUrlCleanup = browser.indexOf('promotedUrl.searchParams.delete("surface")')
  const staleSelectionBranch = browser.indexOf("if (selectedIdRef.current !== selected.id)")
  assert.ok(promotionUrlCleanup >= 0 && promotionUrlCleanup < staleSelectionBranch)
  assert.match(browser, /promotedUrl\.searchParams\.delete\("version"\)/)
  assert.match(browser, /promotedUrl\.searchParams\.delete\("hash"\)/)
  assert.match(browser, /Open Atlas and choose <strong>Place promoted Generous surface<\/strong>/)
  assert.match(browser, /ref=\{promotionTriggerRef\}/)
  assert.match(browser, /ref=\{promotionSuccessRef\}/)
  assert.match(browser, /onCloseAutoFocus=\{\(event\) =>/)
  assert.match(browser, /promotionSuccessRef\.current\.focus\(\)/)
  assert.match(browser, /promotionNoticeRef\.current\.focus\(\)/)
  assert.match(browser, /promotionTriggerRef\.current\?\.focus\(\)/)
  assert.match(browser, /Promotion does not place the surface, execute anything, or publish it outside this tenant/)
  assert.match(api, /\/surfaces\/\$\{encodeURIComponent\(id\)\}\/promote/)
  assert.match(api, /base_version: input\.baseVersion/)
  assert.match(api, /base_content_hash: input\.baseContentHash/)
  assert.match(api, /idempotency_key: input\.idempotencyKey/)
})

test("projects the bounded Research Board into one stable tree", () => {
  const projected = projectSurface(researchBoard())
  assert.equal(projected.ok, true)
  assert.equal(projected.roots.length, 1)
  assert.equal(projected.roots[0].type, "Column")
  assert.deepEqual(projected.roots[0].children.map((child) => child.id), ["title", "table"])
})

test("surface renderer selection requires a registered allowlisted implementation", () => {
  assert.deepEqual(getSurfaceRenderer(researchBoard()), {
    ...BUILTIN_GENEROUS_SURFACE_RENDERER,
    pluginId: "generous",
    implementationId: "builtin.surface-renderer.generous-a2ui",
  })
  assert.equal(getSurfaceRenderer(researchBoard(), createPluginRegistry([])), null)

  const unallowlistedRegistry = createPluginRegistry([{
    manifest: {
      schemaId: "galaxy-plugin.v1",
      id: "fixture-surface",
      version: "1.0.0",
      contributes: { surfaceRenderers: ["generous.a2ui"] },
      connections: [],
    },
    handlers: {
      surfaceRenderers: {
        "generous.a2ui": {
          kind: "surfaceRenderers",
          implementationId: "fixture.dynamic-component",
        },
      },
    },
  }])
  assert.equal(getSurfaceRenderer(researchBoard(), unallowlistedRegistry), null)
})

test("fails closed for unapproved components and broken references", () => {
  const jsx = researchBoard()
  jsx.surfaceUpdate.components[1].component = { JSX: { code: "<button />" } }
  assert.match(projectSurface(jsx).error, /unapproved component/)

  const missing = researchBoard()
  missing.surfaceUpdate.components[0].children.push("missing")
  assert.match(projectSurface(missing).error, /Unknown child/)

  const executable = researchBoard()
  executable.surfaceUpdate.components[1].component = { Card: { onClick: "mutate" } }
  assert.match(projectSurface(executable).error, /unsafe properties/)
})

test("fails closed for cyclic component graphs", () => {
  const cyclic = researchBoard()
  cyclic.surfaceUpdate.components[2].children = ["root"]
  assert.match(projectSurface(cyclic).error, /cycle|valid root/)
})

test("selects the first useful display string", () => {
  assert.equal(surfaceDisplayText({ title: "", text: "Finding" }, ["title", "text"]), "Finding")
})

test("validates bindings again at the browser boundary", () => {
  const unknownSource = researchBoard()
  unknownSource.bindings = [{
    id: "binding-1",
    target: { componentId: "table", prop: "data.rows" },
    source: { kind: "http.fetch", resourceId: "https://example.com" },
  }]
  assert.match(projectSurface(unknownSource).error, /approved contract/)
})

test("projects provenance without internal principal ids or arbitrary nested evidence", () => {
  assert.deepEqual(projectSurfaceProvenance({
    source: "generous.canvas",
    actor_ref: "clerk:sha256:abc",
    evidence_refs: ["memory:1", { raw: "private" }],
    unexpected: { secret: true },
    galaxy: {
      event: "promoted",
      principal_id: "internal-principal",
      principal_kind: "agent",
      recorded_at: "2026-08-30T00:00:00Z",
    },
  }), {
    source: "generous.canvas",
    actor_ref: "clerk:sha256:abc",
    evidence_refs: ["memory:1"],
    galaxy: {
      event: "promoted",
      principal_kind: "agent",
      recorded_at: "2026-08-30T00:00:00Z",
    },
  })
})

test("projects canonical chart points without coercing them to zero", () => {
  assert.deepEqual(projectChartData({ data: {
    title: "Measurements",
    series: [{ name: "accuracy", data: [{ x: "run-1", y: 0.82 }, { x: 2, y: -1.5, label: "run-2" }] }],
  } }), {
    title: "Measurements",
    series: [{ name: "accuracy", points: [
      { x: "run-1", y: 0.82, label: "" },
      { x: "2", y: -1.5, label: "run-2" },
    ] }],
  })
})

test("formats structured table cells as semantic text rather than serialized JSON", () => {
  assert.equal(formatSurfaceCell(null), "—")
  assert.equal(formatSurfaceCell(true), "Yes")
  assert.equal(formatSurfaceCell(["claim", "evidence"]), "claim · evidence")
  assert.equal(
    formatSurfaceCell({ estimate: 0.82, unit: "probability", reviewed: true }),
    "Estimate: 0.82 · Unit: probability · Reviewed: Yes",
  )
  assert.equal(formatSurfaceCell({ label: "Primary claim" }), "Primary claim")
  assert.doesNotMatch(formatSurfaceCell({ nested: { raw: { hidden: true } } }), /[{}\[\]"]/)
})

test("renders bounded charts and knowledge graphs as accessible SVG instruments", async () => {
  const renderer = await readFile(
    new URL("../components/surfaces/surface-renderer.tsx", import.meta.url),
    "utf8",
  )
  assert.match(renderer, /<svg[\s\S]*role="img"[\s\S]*aria-labelledby=/)
  assert.match(renderer, /Plot of \{series\.length\} series/)
  assert.match(renderer, /Node-link diagram with \{entities\.length\} visible entities/)
  assert.match(renderer, /markerEnd=\{`url\(#\$\{markerId\}\)`\}/)
  assert.match(renderer, /formatSurfaceCell\(row\[column\.key\]\)/)
  assert.doesNotMatch(renderer, /JSON\.stringify\(row\[column\.key\]\)/)
})

test("projects every canonical specialized chart payload into visible data", () => {
  assert.deepEqual(projectChartData({ data: { title: "Risk", type: "gauge", value: 42 } }), {
    title: "Risk",
    series: [{ name: "Risk", points: [{ x: "gauge", y: 42, label: "" }] }],
  })

  const variants = [
    ["data", [{ x: "A", value: 3 }]],
    ["stages", [{ name: "Reviewed", value: 2 }]],
    ["sankeyNodes", [{ id: "source" }]],
    ["sankeyLinks", [{ from: "source", to: "result", value: 9 }]],
    ["chordNodes", ["group"]],
    ["chordLinks", [{ from: "a", to: "b", value: 6 }]],
    ["treeMapData", [{ name: "claim", children: [{ name: "evidence", value: 8 }] }]],
    ["graphNodes", [{ id: "node-1" }]],
    ["graphLinks", [{ from: "node-1", to: "node-2", value: 3 }]],
    ["words", [{ text: "evidence", value: 7 }]],
    ["vennSets", [{ name: "proof", value: 4 }]],
    ["vennIntersections", [{ sets: ["proof", "audit"], value: 1 }]],
    ["ranges", [{ label: "confidence", start: 0, end: 95 }]],
  ]
  for (const [field, value] of variants) {
    const projected = projectChartData({ data: { type: "bar", [field]: value } })
    assert.equal(projected.series.length, 1, field)
    assert.equal(projected.series[0].points.length, 1, field)
  }
  assert.equal(projectChartData({ data: {
    type: "hierarchy",
    hierarchyData: { name: "root", children: [{ name: "leaf", value: 5 }] },
  } }).series[0].points[0].y, 5)
  assert.deepEqual(projectChartData({ data: {
    type: "candlestick",
    data: [{ date: "2026-09-04", open: 4, high: 8, low: 3, close: 7 }],
  } }).series[0].points[0], { x: "2026-09-04", y: 7, label: "" })
})

test("projects canonical timeline and knowledge graph fields", () => {
  assert.deepEqual(projectTimelineData({ data: { events: [{
    unique_id: "milestone-1",
    start_date: { year: 2026, month: 9, day: 4 },
    text: { headline: "Reviewed", text: "Evidence was checked." },
  }] } }), [{ id: "milestone-1", title: "Reviewed", date: "2026-09-04", description: "Evidence was checked." }])

  assert.deepEqual(projectKnowledgeGraphData({ title: "Claims", data: {
    entities: [{ id: "claim-1", label: "Claim", type: "concept" }],
    relationships: [{ id: "edge-1", source: "claim-1", target: "paper-1", type: "supported_by" }],
  } }), {
    title: "Claims",
    entities: [{ id: "claim-1", label: "Claim", type: "concept" }],
    relationships: [{ id: "edge-1", source: "claim-1", target: "paper-1", type: "supported_by" }],
  })
})

test("withholds bound definitions when live resolution fails", async () => {
  const browser = await readFile(
    new URL("../components/surfaces/surface-browser.tsx", import.meta.url),
    "utf8",
  )

  assert.match(browser, /const renderSpec = requiresResolution \? resolution\?\.materialized_spec \?\? null : previewSpec/)
  assert.match(browser, /const validated = validateResolvedSurface\(next,/)
  assert.match(browser, /if \(!validated\) throw new Error/)
  assert.match(browser, /\.catch\(\(\) =>/)
  assert.match(browser, /The unresolved definition has not been rendered/)
  assert.match(browser, /Retry resolution/)
})
