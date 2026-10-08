import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("Atlas paper import keeps exact private acquisition separate from placement retry", async () => {
  const [client, dialog, acquisition] = await Promise.all([
    readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/papers/arxiv-paper-import-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/paper-arxiv-acquisition.js", import.meta.url), "utf8"),
  ])

  assert.match(client, /const operationId = crypto\.randomUUID\(\)/)
  assert.match(client, /writePaperImportPlacementRecovery\([\s\S]*window\.localStorage[\s\S]*durableDocument: acquisition\.document/)
  assert.match(client, /subjectRef: acquisition\.document\.ref/)
  assert.match(client, /workspaceId: target\.workspaceId/)
  assert.match(client, /current\.workspaceId !== recovery\.workspaceId/)
  assert.match(client, /current\.canvasId !== recovery\.canvasId/)
  assert.match(client, /placeReference\(recovery\.subjectRef, recovery\.operationId\)/)
  assert.match(client, /paperImportRecovery\?\.subjectRef === completion\.subjectRef[\s\S]*paperImportRecovery\.operationId === completion\.operationId/)
  assert.match(client, /paperImportRecovery\?\.subjectRef === referencePlacementRequest\.subjectRef[\s\S]*paperImportRecovery\.operationId === referencePlacementRequest\.operationId/)
  assert.match(client, /bindReferencePlacementTarget[\s\S]*paperImportRecovery\?\.operationId === operationId/)
  assert.match(client, /Retry placement only; do not import or fetch it again/)
  assert.match(client, /listPaperImportPlacementRecoveries\(window\.localStorage/)
  assert.match(client, /removePaperImportPlacementRecovery\([\s\S]*window\.localStorage/)
  assert.equal((client.match(/openActionForAtlasNode\(/g) ?? []).length, 3)
  assert.equal((client.match(/\{openAction\.label\}/g) ?? []).length, 3)
  assert.match(client, /Use Open document in the selected placement\./)
  assert.doesNotMatch(acquisition, /operationId:\s*imported\.revision\.id/)
  assert.match(acquisition, /client\.fetchPaperDocument\(paper\.id, revision\.id, signal\)/)
  assert.doesNotMatch(acquisition, /pdf_url|response\.blob|storePaperDocument/)

  assert.match(dialog, /closeDisabled=\{busy\}/)
  assert.match(dialog, /onCloseAutoFocus/)
  assert.match(dialog, /returnFocus\.focus\(\)/)
  assert.match(dialog, /role="search"/)
  assert.match(dialog, /type="radio"/)
  assert.match(dialog, /role="alert"/)
  assert.match(dialog, /role="status"/)
  assert.match(dialog, /searchAbortRef\.current\?\.abort\(\)/)
  assert.match(dialog, /searchGenerationRef\.current !== generation/)
  assert.match(dialog, /Keep without placing/)
  assert.match(client, /\|\| paperImportOpen/)
})

test("Atlas placement completion survives callback identity churn", async () => {
  const client = await readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8")
  const effectStart = client.indexOf("    const request = referencePlacementRequest")
  const effectEnd = client.indexOf("\n\n  useEffect(() => {", effectStart)
  assert.notEqual(effectStart, -1)
  assert.notEqual(effectEnd, -1)
  const placementEffect = client.slice(effectStart, effectEnd)

  assert.match(client, /const referencePlacementCallbacksRef = useRef<[\s\S]*useLayoutEffect\(\(\) => \{[\s\S]*referencePlacementCallbacksRef\.current = callbacks/)
  assert.match(placementEffect, /referencePlacementCallbacksRef\.current\?\.publish/)
  assert.match(placementEffect, /callbacks\.onError/)
  assert.match(placementEffect, /\}, \[\s*preview,\s*referencePlacementRequest,\s*\]\)$/)
  for (const unstableDependency of [
    "ensureCanvas",
    "onReferencePlacementError",
    "onReferencePlacementTarget",
    "publishReferencePlacement",
  ]) assert.doesNotMatch(placementEffect, new RegExp(`\\n\\s+${unstableDependency},`))
})

test("Atlas preflights the whole Papers capability before acquisition", async () => {
  const [client, acquisition] = await Promise.all([
    readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/paper-arxiv-acquisition.js", import.meta.url), "utf8"),
  ])
  assert.match(client, /if \(!paperArxivImportRegistered\(\)\)[\s\S]*registered Papers capability changed/)
  for (const identity of [
    "paper.import",
    "builtin.paper.import",
    "arxiv.pdf",
    "builtin.arxiv.pdf-source",
    "arxiv.private-fetch-route",
    "builtin.arxiv.private-fetch-route",
    "arxiv.fetch-default",
    "builtin.ingestion-plan.arxiv-fetch-default",
  ]) assert.match(acquisition, new RegExp(identity.replaceAll(".", String.raw`\.`)))
})
