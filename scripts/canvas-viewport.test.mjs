import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  atlasCanvasSwitchHasPendingWork,
  findAtlasCanvasSwitchTarget,
  normalizeAtlasCanvasCatalog,
  selectAtlasWorkspaceId,
} from "../lib/canvas/atlas-canvas-catalog.js"
import {
  atlasCanvasCreateRecoveryKey,
  confirmAtlasCanvasCreateResponse,
  discardAtlasCanvasCreateRecovery,
  prepareAtlasCanvasCreateOperation,
  readPendingAtlasCanvasCreate,
  removePendingAtlasCanvasCreate,
  requirePendingAtlasCanvasCreate,
  writePendingAtlasCanvasCreate,
} from "../lib/canvas/atlas-canvas-create.js"
import { hashCanvasSnapshot } from "../lib/canvas/canvas-snapshot.js"
import { selectAtlasBaseProjection } from "../lib/canvas/atlas-projection-mode.js"
import { atlasCanvasHref } from "../lib/canvas/atlas-location.js"
import { pointOnCanvas, zoomCanvasAt } from "../lib/canvas-viewport.js"

const WORKSPACE_ID = "workspace-main"
const TENANT_ID = "10000000-0000-4000-8000-000000000001"
const PRINCIPAL_ID = "20000000-0000-4000-8000-000000000002"
const OPERATION_ID = "30000000-0000-4000-8000-000000000003"
const CANVAS_ID = "40000000-0000-4000-8000-000000000004"
const MUTATION_ID = "50000000-0000-4000-8000-000000000005"

function memoryStorage() {
  const values = new Map()
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null },
    setItem(key, value) { values.set(key, String(value)) },
    removeItem(key) { values.delete(key) },
  }
}

function emptyCanvasSnapshot() {
  return {
    schemaId: "gb.canvas.snapshot.v1",
    items: [],
    edges: [],
    removedItemIds: [],
    removedEdgeIds: [],
  }
}

function canvas(index, overrides = {}) {
  return {
    canvasId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    workspaceId: WORKSPACE_ID,
    slug: `canvas-${index + 1}`,
    title: `Canvas ${index + 1}`,
    isDefault: index === 0,
    projectionMode: "ambient",
    version: 1,
    contentHash: `sha256:${"a".repeat(64)}`,
    ...overrides,
  }
}

test("Atlas workspace selection prefers durable server state over stale browser caches", () => {
  const staleBrowserWorkspaces = [{ id: "workspace-stale" }]
  const serverCanvases = [
    canvas(1, { workspaceId: "workspace-secondary", isDefault: false }),
    canvas(0, { workspaceId: "workspace-server", isDefault: true }),
  ]

  assert.equal(selectAtlasWorkspaceId(null, serverCanvases, staleBrowserWorkspaces), "workspace-server")
  assert.equal(selectAtlasWorkspaceId(null, [serverCanvases[0]], staleBrowserWorkspaces), "workspace-secondary")
  assert.equal(selectAtlasWorkspaceId(null, [], staleBrowserWorkspaces), "workspace-stale")
  assert.equal(selectAtlasWorkspaceId(null, [], []), "default-workspace")
  assert.equal(selectAtlasWorkspaceId(
    { workspaceId: "workspace-requested" },
    serverCanvases,
    staleBrowserWorkspaces,
  ), "workspace-requested")
  assert.throws(
    () => selectAtlasWorkspaceId(null, [{ workspaceId: "bad workspace", isDefault: true }], []),
    /server canvas workspace id is invalid/,
  )
})

test("drop and double-click coordinates invert viewport pan and zoom", () => {
  const rect = { left: 100, top: 40 }
  assert.deepEqual(pointOnCanvas(480, 290, rect, { x: 80, y: -50 }, 2), { x: 150, y: 150 })
})

test("zoom holds the pointed canvas position fixed and clamps scale", () => {
  const rect = { left: 100, top: 40 }
  const before = pointOnCanvas(480, 290, rect, { x: 80, y: -50 }, 2)
  const after = zoomCanvasAt(480, 290, rect, { x: 80, y: -50 }, 2, 1)
  assert.deepEqual(pointOnCanvas(480, 290, rect, after.pan, after.zoom), before)
  assert.equal(zoomCanvasAt(0, 0, rect, after.pan, 1, 0.01).zoom, 0.25)
  assert.equal(zoomCanvasAt(0, 0, rect, after.pan, 1, 20).zoom, 2.5)
})

test("the retained legacy canvas stays workspace-scoped without owning the opening route", async () => {
  const canvas = await readFile(new URL("../components/galaxy-canvas.tsx", import.meta.url), "utf8")
  const workspaceRoute = await readFile(new URL("../app/workspace/page.tsx", import.meta.url), "utf8")

  assert.match(canvas, /filterNodesForWorkspace\(allNodes, workspaceRootFolderId\)/)
  assert.doesNotMatch(canvas, /!node\.parentId/)
  assert.match(canvas, /createCanvasNote\(\s*workspaceRootFolderId/)
  assert.match(workspaceRoute, /<AtlasV2Loader/)
  assert.doesNotMatch(workspaceRoute, /GalaxyBrain|galaxy-canvas/)
})

test("Atlas normalizes empty, single, multiple, and bounded canvas catalogs", () => {
  assert.deepEqual(normalizeAtlasCanvasCatalog([], { workspaceId: WORKSPACE_ID }), {
    canvases: [],
    potentiallyPartial: false,
  })

  const one = normalizeAtlasCanvasCatalog([canvas(0)], { workspaceId: WORKSPACE_ID })
  assert.deepEqual(one.canvases.map(({ canvasId }) => canvasId), [canvas(0).canvasId])

  const unicodeTitle = "🌌".repeat(200)
  assert.equal(normalizeAtlasCanvasCatalog([
    canvas(0, { title: unicodeTitle }),
  ], { workspaceId: WORKSPACE_ID }).canvases[0].title, unicodeTitle)
  assert.throws(() => normalizeAtlasCanvasCatalog([
    canvas(0, { title: "🌌".repeat(201) }),
  ], { workspaceId: WORKSPACE_ID }), /title/)

  const two = normalizeAtlasCanvasCatalog([canvas(1), canvas(0)], {
    workspaceId: WORKSPACE_ID,
    activeCanvas: canvas(1),
  })
  assert.deepEqual(two.canvases.map(({ canvasId }) => canvasId), [canvas(0).canvasId, canvas(1).canvasId])

  const current = canvas(1)
  const three = normalizeAtlasCanvasCatalog([canvas(2), current, canvas(0)], {
    workspaceId: WORKSPACE_ID,
    activeCanvas: current,
  })
  assert.deepEqual(three.canvases.map(({ canvasId }) => canvasId), [
    canvas(0).canvasId,
    current.canvasId,
    canvas(2).canvasId,
  ])

  const fifty = normalizeAtlasCanvasCatalog(Array.from({ length: 50 }, (_, index) => canvas(index)), {
    workspaceId: WORKSPACE_ID,
    activeCanvas: canvas(1),
  })
  assert.equal(fifty.canvases.length, 50)
  assert.equal(fifty.potentiallyPartial, true)
  assert.throws(
    () => normalizeAtlasCanvasCatalog(Array.from({ length: 51 }, (_, index) => canvas(index)), { workspaceId: WORKSPACE_ID }),
    /exceeds the 50 canvas limit/,
  )
})

test("Atlas canvas catalogs fail closed for identity, workspace, metadata, and default conflicts", () => {
  const first = canvas(0)
  assert.throws(() => normalizeAtlasCanvasCatalog([first, first], { workspaceId: WORKSPACE_ID }), /duplicate canvas id/)
  assert.throws(() => normalizeAtlasCanvasCatalog([{ ...first, workspaceId: "workspace-foreign" }], { workspaceId: WORKSPACE_ID }), /workspace/)
  assert.throws(() => normalizeAtlasCanvasCatalog([{ ...first, canvasId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }], { workspaceId: WORKSPACE_ID }), /not canonical/)
  assert.throws(() => normalizeAtlasCanvasCatalog([{ ...first, title: " " }], { workspaceId: WORKSPACE_ID }), /title/)
  assert.throws(() => normalizeAtlasCanvasCatalog([{ ...first, title: "x".repeat(201) }], { workspaceId: WORKSPACE_ID }), /title/)
  assert.throws(() => normalizeAtlasCanvasCatalog([{ ...first, isDefault: false }], { workspaceId: WORKSPACE_ID }), /exactly one default/)
  assert.throws(() => normalizeAtlasCanvasCatalog([{ ...first, projectionMode: "unknown" }], { workspaceId: WORKSPACE_ID }), /projection mode/)
  assert.throws(() => normalizeAtlasCanvasCatalog([first, { ...canvas(1), isDefault: true }], { workspaceId: WORKSPACE_ID }), /exactly one default/)
  assert.throws(() => normalizeAtlasCanvasCatalog([first], {
    workspaceId: WORKSPACE_ID,
    activeCanvas: { ...first, title: "Conflicting title" },
  }), /conflicts with its catalog record/)
  const newerActive = { ...first, version: 2, contentHash: `sha256:${"b".repeat(64)}` }
  assert.deepEqual(normalizeAtlasCanvasCatalog([first], {
    workspaceId: WORKSPACE_ID,
    activeCanvas: newerActive,
  }).canvases[0], newerActive)
  const olderActive = { ...first, version: 1, contentHash: first.contentHash }
  assert.deepEqual(normalizeAtlasCanvasCatalog([
    { ...first, version: 2, contentHash: `sha256:${"b".repeat(64)}` },
  ], {
    workspaceId: WORKSPACE_ID,
    activeCanvas: olderActive,
  }).canvases[0], olderActive)
  assert.throws(() => normalizeAtlasCanvasCatalog([first], {
    workspaceId: WORKSPACE_ID,
    activeCanvas: first,
    requestedCanvasId: canvas(1).canvasId,
  }), /response identity does not match/)
  assert.throws(() => normalizeAtlasCanvasCatalog([first], {
    workspaceId: WORKSPACE_ID,
    activeCanvas: { ...first, workspaceId: "workspace-foreign" },
    requestedCanvasId: first.canvasId,
  }), /workspace/)
  assert.throws(() => normalizeAtlasCanvasCatalog(Array.from({ length: 50 }, (_, index) => canvas(index)), {
    workspaceId: WORKSPACE_ID,
    activeCanvas: canvas(50, { isDefault: false }),
  }), /omitted from the bounded catalog/)
})

test("Atlas canvas activation accepts only a new canonical member of the current workspace", () => {
  const catalog = [canvas(0), canvas(1), { ...canvas(2), workspaceId: "workspace-foreign" }]
  assert.equal(findAtlasCanvasSwitchTarget(catalog, WORKSPACE_ID, canvas(0).canvasId, canvas(1).canvasId)?.canvasId, canvas(1).canvasId)
  assert.equal(findAtlasCanvasSwitchTarget(catalog, WORKSPACE_ID, canvas(0).canvasId, canvas(0).canvasId), null)
  assert.equal(findAtlasCanvasSwitchTarget(catalog, WORKSPACE_ID, canvas(0).canvasId, canvas(2).canvasId), null)
  assert.equal(findAtlasCanvasSwitchTarget(catalog, WORKSPACE_ID, canvas(0).canvasId, "not-a-canvas"), null)
  assert.equal(findAtlasCanvasSwitchTarget(catalog, WORKSPACE_ID, canvas(0).canvasId, canvas(4).canvasId), null)
})

test("Atlas canvas switching fences every convergence and top-level persistence state", () => {
  const pendingKinds = [
    "convergence", "referencePlacement", "placementRemoval", "dropImport", "documentImport",
    "referenceHandoff", "formalPackagePlacement", "paperImport", "webCapture", "inkImport",
    "codeImport", "markdownNote", "voiceImport", "relationWrite", "frameMutation",
    "canvasCreate",
  ]
  assert.equal(atlasCanvasSwitchHasPendingWork(Object.fromEntries(pendingKinds.map((kind) => [kind, false]))), false)
  for (const kind of pendingKinds) {
    assert.equal(atlasCanvasSwitchHasPendingWork({ [kind]: true }), true, kind)
  }
})

test("Atlas canvas links contain only one canonical canvas selector", () => {
  const upper = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
  const lower = upper.toLowerCase()
  assert.equal(atlasCanvasHref(upper), `/workspace?canvas=${lower}`)
  assert.equal(atlasCanvasHref(upper).includes("placement="), false)
  assert.equal(atlasCanvasHref(upper).includes("ref="), false)
  assert.equal(atlasCanvasHref(upper).includes("placeRef="), false)
  assert.equal(atlasCanvasHref(upper).includes("#"), false)
  assert.throws(() => atlasCanvasHref("not-a-canvas"), /canvas id is invalid/)
})

test("named-canvas creation freezes one bounded non-default request and scoped recovery identity", () => {
  const scope = { tenantId: TENANT_ID, principalId: PRINCIPAL_ID, workspaceId: WORKSPACE_ID }
  const operation = prepareAtlasCanvasCreateOperation({
    tenantId: TENANT_ID,
    principalId: PRINCIPAL_ID,
    workspaceId: WORKSPACE_ID,
    title: "  Proof atlas  ",
    slug: "proof-atlas",
    operationId: OPERATION_ID.toUpperCase(),
  })
  assert.deepEqual(operation, {
    schemaId: "gb.atlas-canvas-create-recovery.v2",
    state: "pending",
    operationId: OPERATION_ID,
    tenantId: TENANT_ID,
    principalId: PRINCIPAL_ID,
    workspaceId: WORKSPACE_ID,
    title: "Proof atlas",
    slug: "proof-atlas",
    makeDefault: false,
    projectionMode: "curated",
    idempotencyKey: `canvas-create:${WORKSPACE_ID}:${OPERATION_ID}`,
  })
  assert.equal(Object.isFrozen(operation), true)
  assert.equal(
    atlasCanvasCreateRecoveryKey(scope),
    `galaxy.atlas-canvas-create.v1:${TENANT_ID}:${PRINCIPAL_ID}:${WORKSPACE_ID}`,
  )
  assert.throws(() => prepareAtlasCanvasCreateOperation({
    tenantId: TENANT_ID,
    principalId: PRINCIPAL_ID,
    workspaceId: WORKSPACE_ID,
    title: "🌌".repeat(201),
    slug: "too-long",
    operationId: OPERATION_ID,
  }), /1-200/)
  assert.throws(() => prepareAtlasCanvasCreateOperation({
    tenantId: TENANT_ID,
    principalId: PRINCIPAL_ID,
    workspaceId: WORKSPACE_ID,
    title: "Proof atlas",
    slug: "Proof Atlas",
    operationId: OPERATION_ID,
  }), /slug/)
})

test("named-canvas recovery is one exact tenant, principal, and workspace operation", () => {
  const storage = memoryStorage()
  const scope = { tenantId: TENANT_ID, principalId: PRINCIPAL_ID, workspaceId: WORKSPACE_ID }
  const operation = prepareAtlasCanvasCreateOperation({
    tenantId: TENANT_ID,
    principalId: PRINCIPAL_ID,
    workspaceId: WORKSPACE_ID,
    title: "Proof atlas",
    slug: "proof-atlas",
    operationId: OPERATION_ID,
  })
  assert.equal(readPendingAtlasCanvasCreate(storage, scope), null)
  assert.deepEqual(writePendingAtlasCanvasCreate(storage, scope, operation), operation)
  assert.deepEqual(readPendingAtlasCanvasCreate(storage, scope), operation)
  assert.deepEqual(requirePendingAtlasCanvasCreate(storage, scope, operation), operation)
  assert.throws(() => writePendingAtlasCanvasCreate(storage, scope, prepareAtlasCanvasCreateOperation({
    tenantId: TENANT_ID,
    principalId: PRINCIPAL_ID,
    workspaceId: WORKSPACE_ID,
    title: "Changed same operation",
    slug: "proof-atlas",
    operationId: OPERATION_ID,
  })), /another or changed canvas creation/)
  assert.throws(() => writePendingAtlasCanvasCreate(storage, scope, prepareAtlasCanvasCreateOperation({
    tenantId: TENANT_ID,
    principalId: PRINCIPAL_ID,
    workspaceId: WORKSPACE_ID,
    title: "Second",
    slug: "second",
    operationId: MUTATION_ID,
  })), /another or changed canvas creation/)
  assert.equal(removePendingAtlasCanvasCreate(storage, scope, MUTATION_ID), false)
  assert.equal(removePendingAtlasCanvasCreate(storage, scope, OPERATION_ID), true)
  assert.equal(readPendingAtlasCanvasCreate(storage, scope), null)
  assert.throws(() => requirePendingAtlasCanvasCreate(storage, scope, operation), /pending operation is missing/)

  const corruptKey = atlasCanvasCreateRecoveryKey(scope)
  storage.setItem(corruptKey, "{not-json")
  assert.throws(() => readPendingAtlasCanvasCreate(storage, scope), /not valid JSON/)
  assert.equal(storage.getItem(corruptKey), "{not-json")
  assert.throws(() => writePendingAtlasCanvasCreate(storage, scope, operation), /not valid JSON/)
  assert.equal(discardAtlasCanvasCreateRecovery(storage, scope), true)
  assert.equal(storage.getItem(corruptKey), null)

  const legacyOperation = {
    ...operation,
    schemaId: "gb.atlas-canvas-create-recovery.v1",
  }
  delete legacyOperation.projectionMode
  storage.setItem(corruptKey, JSON.stringify(legacyOperation))
  assert.throws(() => readPendingAtlasCanvasCreate(storage, scope), /stored journal is malformed/)
  discardAtlasCanvasCreateRecovery(storage, scope)

  const foreignScope = { ...scope, principalId: MUTATION_ID }
  const foreignOperation = prepareAtlasCanvasCreateOperation({
    tenantId: TENANT_ID,
    principalId: MUTATION_ID,
    workspaceId: WORKSPACE_ID,
    title: "Foreign",
    slug: "foreign",
    operationId: MUTATION_ID,
  })
  storage.setItem(corruptKey, JSON.stringify(foreignOperation))
  assert.throws(() => readPendingAtlasCanvasCreate(storage, scope), /does not match/)
  assert.equal(storage.getItem(corruptKey), JSON.stringify(foreignOperation))
  discardAtlasCanvasCreateRecovery(storage, scope)

  writePendingAtlasCanvasCreate(storage, scope, operation)
  assert.equal(readPendingAtlasCanvasCreate(storage, foreignScope), null)
  assert.deepEqual(readPendingAtlasCanvasCreate(storage, scope), operation)
})

test("named-canvas confirmation binds fresh and replayed responses to the frozen request", async () => {
  const operation = prepareAtlasCanvasCreateOperation({
    tenantId: TENANT_ID,
    principalId: PRINCIPAL_ID,
    workspaceId: WORKSPACE_ID,
    title: "Shared title",
    slug: "proof-atlas",
    operationId: OPERATION_ID,
  })
  const content = emptyCanvasSnapshot()
  const contentHash = await hashCanvasSnapshot(content)
  const fresh = {
    canvasId: CANVAS_ID,
    workspaceId: WORKSPACE_ID,
    slug: operation.slug,
    title: operation.title,
    isDefault: true,
    projectionMode: "curated",
    version: 1,
    contentHash,
    content,
    mutationId: MUTATION_ID,
  }
  const confirmedFresh = await confirmAtlasCanvasCreateResponse(fresh, operation)
  assert.equal(confirmedFresh.isDefault, true, "the server may make the first canvas default")
  assert.equal(confirmedFresh.canvasId, CANVAS_ID)

  const replay = { ...fresh, version: 7, replayed: true }
  delete replay.mutationId
  const confirmedReplay = await confirmAtlasCanvasCreateResponse(replay, operation)
  assert.equal(confirmedReplay.version, 7)
  assert.equal(confirmedReplay.replayed, true)

  await assert.rejects(
    confirmAtlasCanvasCreateResponse({ ...fresh, workspaceId: "workspace-other" }, operation),
    /frozen request/,
  )
  await assert.rejects(
    confirmAtlasCanvasCreateResponse({ ...fresh, slug: "another" }, operation),
    /frozen request/,
  )
  await assert.rejects(
    confirmAtlasCanvasCreateResponse({ ...fresh, projectionMode: "ambient" }, operation),
    /frozen request/,
  )
  await assert.rejects(
    confirmAtlasCanvasCreateResponse({ ...fresh, contentHash: `sha256:${"0".repeat(64)}` }, operation),
    /does not match/,
  )
  await assert.rejects(
    confirmAtlasCanvasCreateResponse({ ...fresh, extra: true }, operation),
    /unexpected fields/,
  )
  await assert.rejects(
    confirmAtlasCanvasCreateResponse({ ...fresh, version: 2 }, operation),
    /initial empty revision/,
  )
  const framedContent = {
    ...content,
    frames: [{
      id: "unexpected", title: "Unexpected", x: 0, y: 0,
      width: 720, height: 480, tone: "sage",
    }],
  }
  await assert.rejects(
    confirmAtlasCanvasCreateResponse({
      ...fresh,
      content: framedContent,
      contentHash: await hashCanvasSnapshot(framedContent),
    }, operation),
    /initial empty revision/,
  )
})

test("named-canvas UI is a registered static presenter with journaled recovery and clean navigation", async () => {
  const [atlas, dialog, switcher] = await Promise.all([
    readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/atlas/atlas-canvas-create-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/atlas/atlas-canvas-switcher.tsx", import.meta.url), "utf8"),
  ])
  assert.match(atlas, /canvasCreateBlockedReason/)
  assert.match(atlas, /dispatchAtlasCommand\(commandId, \{\}\)/)
  assert.match(atlas, /result\.effect\.kind !== "open-canvas-create"/)
  assert.match(atlas, /createAction=\{canvasCreateCommand \? \{/)
  assert.match(dialog, /writePendingAtlasCanvasCreate\(window\.localStorage, scope, prepared\)/)
  assert.match(dialog, /requirePendingAtlasCanvasCreate\(window\.localStorage, scope, nextOperation\)/)
  assert.match(dialog, /discardAtlasCanvasCreateRecovery\(window\.localStorage, scope\)/)
  assert.match(dialog, /recoveryBlocked/)
  assert.match(dialog, /makeDefault: false/)
  assert.match(dialog, /projectionMode: nextOperation\.projectionMode/)
  assert.match(dialog, /idempotencyKey: nextOperation\.idempotencyKey/)
  assert.match(dialog, /confirmAtlasCanvasCreateResponse\(response, nextOperation\)/)
  assert.match(dialog, /window\.location\.assign\(href\)/)
  assert.match(dialog, /removePendingAtlasCanvasCreate\(window\.localStorage, scope, nextOperation\.operationId\)/)
  assert.match(dialog, /Titles may be shared; the slug must be unique/)
  const submitHandler = dialog.slice(dialog.indexOf("async function submit"), dialog.indexOf("const frozen"))
  assert.equal((submitHandler.match(/window\.location\.assign/g) ?? []).length, 1)
  assert.doesNotMatch(submitHandler, /router\.|replaceState|setAtlas/)
  assert.doesNotMatch(switcher, /galaxyBrainAPI|fetch\(|createCanvas|localStorage/)
})

test("curated canvases start from an empty base while ambient and unpersisted canvases retain the workspace projection", () => {
  const projection = {
    placements: [{ id: "workspace-note" }],
    relations: [{ id: "workspace-relation" }],
  }
  assert.equal(selectAtlasBaseProjection(canvas(0), projection), projection)
  assert.equal(selectAtlasBaseProjection(null, projection), projection)
  assert.deepEqual(
    selectAtlasBaseProjection(canvas(1, { projectionMode: "curated" }), projection),
    { placements: [], relations: [] },
  )
  assert.throws(
    () => selectAtlasBaseProjection(canvas(1, { projectionMode: "unknown" }), projection),
    /projection mode/,
  )
})

test("Atlas loads the strict workspace catalog and wires only a guarded hard-navigation switch", async () => {
  const atlas = await readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8")
  const switcher = await readFile(new URL("../components/atlas/atlas-canvas-switcher.tsx", import.meta.url), "utf8")

  assert.match(atlas, /getCanvases\(workspaceId\)/)
  assert.match(atlas, /normalizeAtlasCanvasCatalog\(listedCanvases/)
  assert.match(atlas, /findAtlasCanvasSwitchTarget\(/)
  assert.match(atlas, /canvasConvergenceReaderRef\.current\?\.\(\)\.pendingWork/)
  assert.match(atlas, /Finish the current Atlas placement before switching canvases\./)
  assert.match(atlas, /window\.location\.assign\(atlasCanvasHref\(canvasId\)\)/)
  const handler = atlas.slice(atlas.indexOf("const switchAtlasCanvas"), atlas.indexOf("const restorePendingExperimentPlacement"))
  assert.equal((handler.match(/window\.location\.assign/g) ?? []).length, 1)
  assert.doesNotMatch(handler, /replaceState|router\.|setReload|setAtlas/)
  assert.match(atlas, /workspaceName: workspace\?\.name \?\? "Current workspace"/)
  assert.match(atlas, /Showing the first 50 authorized canvases\./)
  assert.match(atlas, /className="atlas-identity-tagline"/)
  assert.match(atlas, /className="atlas-canvas-catalog-disclosure/)
  assert.doesNotMatch(handler, /setReferencePlacementAnnouncement/)
  assert.match(switcher, /htmlFor="atlas-canvas-switcher"/)
  assert.match(switcher, /No durable canvases yet/)
  assert.match(switcher, /— Current/)
  assert.match(switcher, /— Default/)
  assert.match(switcher, /min-h-11/)
  assert.match(switcher, /max-w-full/)
  assert.match(switcher, /aria-describedby="atlas-canvas-status"/)
  assert.doesNotMatch(switcher, /galaxyBrainAPI|fetch\(|createCanvas|mutateCanvas|plugin|workspaceId/)

  const globals = await readFile(new URL("../app/globals.css", import.meta.url), "utf8")
  assert.match(globals, /\.atlas-identity-tagline \{ display: none; \}/)
  assert.doesNotMatch(globals, /\.atlas-identity > p:last-child/)
  assert.doesNotMatch(globals, /\.atlas-canvas-catalog-disclosure[^}]*display:\s*none/)
})
