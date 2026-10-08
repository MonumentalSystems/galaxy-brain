import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { normalizeTextAnchor } from "../lib/paper-anchors.js"
import {
  paperTaskRecoveryNamespace,
  readPaperTaskRecoveries,
  removePaperTaskRecovery,
  writePaperTaskRecovery,
} from "../lib/paper-task-recovery.js"

class MemoryStorage {
  values = new Map()
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, value) }
  removeItem(key) { this.values.delete(key) }
}

test("text anchors keep exact quotes and offsets aligned after trimming and truncation", () => {
  assert.deepEqual(normalizeTextAnchor("  evidence  ", 10), {
    quote: "evidence",
    startOffset: 12,
    endOffset: 20,
  })
  assert.deepEqual(normalizeTextAnchor(` ${"x".repeat(5_000)} `, 7), {
    quote: "x".repeat(4_000),
    startOffset: 8,
    endOffset: 4_008,
  })
  assert.equal(normalizeTextAnchor("   ", 0), null)
})

test("paper task links retain one operation key and task id across retries", async () => {
  const workbench = await readFile(
    new URL("../components/papers/paper-workbench.tsx", import.meta.url),
    "utf8",
  )

  assert.match(workbench, /paperTaskRecoveryNamespace\(tenantId, principalId\)/)
  assert.match(workbench, /writePaperTaskRecovery\(window\.localStorage, recoveryNamespace, operation\)/)
  assert.match(workbench, /if \(!recoverable\.taskId\)[\s\S]*createTask\(recoverable\.taskInput, recoverable\.idempotencyKey\)/)
  assert.match(workbench, /recoverable = \{ \.\.\.recoverable, taskId: task\.id, taskTitle: task\.title \}[\s\S]*persistTaskLink\(recoverable\)/)
  assert.match(workbench, /createPaperTaskLink\(recoverable\.paperId,[\s\S]*ham_task_id: recoverable\.taskId!/)
  assert.match(workbench, /clearTaskLink\(recoverable\)/)
  assert.match(workbench, /Retry pending link/)
})

test("paper task recovery is a per-identity queue safe across tabs", () => {
  const storage = new MemoryStorage()
  const tenant = "10000000-0000-4000-8000-000000000001"
  const principalA = "20000000-0000-4000-8000-000000000001"
  const principalB = "20000000-0000-4000-8000-000000000002"
  const scopeA = paperTaskRecoveryNamespace(tenant, principalA)
  const scopeB = paperTaskRecoveryNamespace(tenant, principalB)
  const operation = (idempotencyKey, createdAt) => ({ idempotencyKey, createdAt })

  writePaperTaskRecovery(storage, scopeA, operation("operation-1", "2026-09-04T00:00:01Z"))
  writePaperTaskRecovery(storage, scopeA, operation("operation-2", "2026-09-04T00:00:02Z"))
  writePaperTaskRecovery(storage, scopeB, operation("operation-3", "2026-09-04T00:00:03Z"))

  assert.deepEqual(readPaperTaskRecoveries(storage, scopeA).map((item) => item.idempotencyKey), [
    "operation-1",
    "operation-2",
  ])
  assert.deepEqual(readPaperTaskRecoveries(storage, scopeB).map((item) => item.idempotencyKey), ["operation-3"])
  removePaperTaskRecovery(storage, scopeA, "operation-1")
  assert.deepEqual(readPaperTaskRecoveries(storage, scopeA).map((item) => item.idempotencyKey), ["operation-2"])
  assert.deepEqual(readPaperTaskRecoveries(storage, scopeB).map((item) => item.idempotencyKey), ["operation-3"])
})

test("paper review records render comment bodies and evidence relations", async () => {
  const workbench = await readFile(
    new URL("../components/papers/paper-workbench.tsx", import.meta.url),
    "utf8",
  )

  assert.match(workbench, /annotation\.body/)
  assert.match(workbench, /selected\.evidence_links\.flatMap/)
  assert.match(workbench, /link\.relation/)
  assert.doesNotMatch(workbench, /annotation\.kind === "comment"\) return \[\]/)
})

test("paper deep links outside the recent shelf resolve directly by id", async () => {
  const workbench = await readFile(
    new URL("../components/papers/paper-workbench.tsx", import.meta.url),
    "utf8",
  )
  const recentPapers = Array.from({ length: 100 }, (_, index) => ({ id: `paper-${index + 1}` }))
  const requestedPaperId = "paper-101"

  assert.equal(recentPapers.some((paper) => paper.id === requestedPaperId), false)
  assert.match(workbench, /reloadPapers\(\)\.then\(\(items\) => \{[\s\S]*if \(!initialPaperId && items\[0\]\?\.id\) void openPaper\(items\[0\]\.id\)/)
  assert.match(workbench, /if \(initialPaperId\) void openPaper\(initialPaperId\)/)
  assert.doesNotMatch(workbench, /items\.some\(\(paper\) => paper\.id === initialPaperId\)/)
})

test("every revision control clears coordinate-dependent state through one switch", async () => {
  const workbench = await readFile(
    new URL("../components/papers/paper-workbench.tsx", import.meta.url),
    "utf8",
  )

  assert.match(workbench, /const clearRevisionCoordinates = useCallback\(\(\) => \{[\s\S]*setSelection\(null\)[\s\S]*setActiveAnnotationId\(""\)[\s\S]*setActiveClaimId\(""\)/)
  assert.match(workbench, /const switchRevision = useCallback\(\(revisionId: string, preserveCoordinates = false\) => \{[\s\S]*setActiveRevisionId\(revisionId\)[\s\S]*clearRevisionCoordinates\(\)/)
  assert.match(workbench, /aria-label="Paper revision"[\s\S]*onChange=\{\(event\) => switchRevision\(event\.target\.value\)\}/)
  assert.match(workbench, /event\.id\.startsWith\("revision:"\)\) switchRevision\(event\.id\.slice\("revision:"\.length\)\)/)
  assert.equal(workbench.match(/setActiveRevisionId\(/g)?.length, 1)
})

test("papers become durable private revision objects without broadening the redistribution proxy", async () => {
  const workbench = await readFile(
    new URL("../components/papers/paper-workbench.tsx", import.meta.url),
    "utf8",
  )

  const source = await readFile(new URL("../lib/arxiv-paper-source.js", import.meta.url), "utf8")
  assert.match(workbench, /arxivPaperSource\(displayRevision\.metadata, selected\.id, activeRevisionId, Boolean\(displayRevision\.document\)\)/)
  assert.match(workbench, /paperSource\?\.readerUrl/)
  assert.match(workbench, /galaxyBrainAPI\.fetchPaperDocument\(selected\.id, displayRevision\.id\)/)
  assert.doesNotMatch(workbench, /fetch\(paperSource\.readerUrl/)
  assert.doesNotMatch(workbench, /response\.blob\(\)/)
  assert.doesNotMatch(workbench, /storePaperDocument\(selected\.id, displayRevision\.id, blob\)/)
  assert.match(workbench, /Save to Galaxy/)
  assert.match(workbench, /galaxyBrainAPI\.bridgePaperDocument/)
  assert.match(workbench, /Make durable/)
  assert.match(workbench, /Durable in Galaxy/)
  assert.match(workbench, /Stored privately/)
  assert.match(workbench, /durable private Galaxy document/)
  assert.doesNotMatch(workbench, /createElement\("a"\)/)
  assert.match(source, /arxivPdfProxyAllowed\(metadata\?\.license_url\)/)
  assert.match(source, /readerUrl: directUrl/)
  assert.match(source, /access: "stored-private"/)
})

test("paper selections are atomic coordinates with progressively disclosed actions", async () => {
  const [workbench, palette, viewer, types, proxy] = await Promise.all([
    readFile(new URL("../components/papers/paper-workbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/papers/paper-selection-palette.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/pdf-viewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/types/papers.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/eln/[...path]/route.ts", import.meta.url), "utf8"),
  ])

  assert.match(types, /type: "region"; x: number; y: number; width: number; height: number/)
  assert.match(viewer, /onRegionSelection/)
  assert.match(viewer, />\s*Select page\s*</)
  assert.match(workbench, /\{selection && \(/)
  for (const action of ["Note", "Task", "Claim", "Cite", "Enhance"]) {
    assert.match(workbench, new RegExp(String.raw`label="${action}"`))
  }
  assert.match(palette, /Context · mechanisms, note, links/)
  assert.match(workbench, /selectionPoint/)
  assert.match(workbench, /mechanism:/)
  assert.match(workbench, /paper-annotation:/)
  assert.match(
    proxy,
    /new NextResponse\(\s*boundedReadBody === null \? upstream\.body : exactArrayBuffer\(boundedReadBody\)/u,
  )
})

test("mechanism tags produce stable addressable neighborhoods", async () => {
  const mechanisms = await readFile(new URL("../lib/paper-mechanisms.ts", import.meta.url), "utf8")
  assert.match(mechanisms, /export function normalizeMechanismTag/)
  assert.match(mechanisms, /encodeURIComponent\(mechanismId\(value\)\)/)
  assert.match(mechanisms, /basePath = "\/papers"/)
})

test("paper workbench projects canonical objects into neighborhoods and a time rail", async () => {
  const [workbench, palette, neighborhood, rail, styles] = await Promise.all([
    readFile(new URL("../components/papers/paper-workbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/papers/paper-selection-palette.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/papers/mechanism-neighborhood.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/papers/paper-time-rail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ])

  assert.match(workbench, /mechanismNeighborhoodItems/)
  assert.match(workbench, /paperTimeEvents/)
  assert.match(palette, /mechanismHref\(tag, mechanismBasePath\)/)
  assert.match(neighborhood, /data-slot="mechanism-neighborhood"/)
  assert.match(neighborhood, /Every line states why/)
  assert.match(rail, /data-slot="paper-time-rail"/)
  assert.match(rail, /zoom changes temporal granularity/)
  assert.match(styles, /@fontsource\/alegreya\/latin-400\.css/)
  assert.match(styles, /font-family: "Alegreya SC"/)
})

test("paper controls share one accessible HUD primitive", async () => {
  const [hud, workbench, palette, preview, styles] = await Promise.all([
    readFile(new URL("../components/ui/hud-toolbar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/papers/paper-workbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/papers/paper-selection-palette.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/papers/paper-region-preview.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ])

  assert.match(hud, /data-slot="hud-toolbar"/)
  assert.match(hud, /role="toolbar"/)
  assert.match(hud, /ArrowLeft/)
  assert.match(hud, /data-slot="hud-action"/)
  assert.match(workbench, /aria-label="Paper marking tools"/)
  assert.match(workbench, /current === "ink" \? "browse" : "ink"/)
  assert.match(workbench, /aria-label="Ink colour"|<span className="sr-only">Ink colour<\/span>/)
  assert.match(preview, /pinned=\{toolsPinned\}/)
  assert.match(palette, /data-slot="paper-selection-palette"/)
  assert.match(palette, /selection-hud-context/)
  assert.match(preview, /<PaperSelectionPalette/)
  assert.match(styles, /\.hud-toolbar-pinned/)
  assert.match(styles, /\.selection-hud-card\[data-pinned="true"\]/)
})
