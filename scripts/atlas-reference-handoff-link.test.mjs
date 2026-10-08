import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("the reusable source link remains a document-only independently authorized handoff", async () => {
  const link = await readFile(
    new URL("../components/atlas/atlas-reference-handoff-link.tsx", import.meta.url),
    "utf8",
  )

  assert.match(link, /inspectAtlasReferenceHandoff\(subjectRef\)/u)
  assert.match(link, /inspected\.kind !== "document"/u)
  assert.match(link, /hydrateAtlasObjectReferences\(\[subjectRef\], \{ signal: controller\.signal \}\)/u)
  assert.match(link, /authorizeAtlasReferenceHandoff\(subjectRef, currentResolution, \{/u)
  assert.match(link, /kind: "document"/u)
  assert.match(link, /objectId: expectedDocumentId/u)
  assert.match(link, /sourceRevisionId: expectedDocumentRevisionId/u)
  assert.match(link, /href=\{atlasReferenceHandoffHref\(authorization\.subjectRef\)\}/u)
  assert.match(link, /min-h-11/u)
  assert.match(link, />\s*Place document in Atlas\s*</u)
  assert.doesNotMatch(link, /placeReference|mutateCanvas|item\.place/u)
})
