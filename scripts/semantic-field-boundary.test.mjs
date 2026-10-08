import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8")

test("the synthetic semantic preview fails closed outside development", async () => {
  const preview = await read("app/dev/semantic-field-preview/page.tsx")

  assert.doesNotMatch(preview, /^"use client"/m)
  assert.match(preview, /devPreviewsEnabled\(\)/)
  assert.match(preview, /notFound\(\)/)
})

test("the ELN semantic zoom design lab fails closed outside development", async () => {
  const preview = await read("app/dev/eln-semantic-zoom-preview/page.tsx")

  assert.doesNotMatch(preview, /^"use client"/m)
  assert.match(preview, /devPreviewsEnabled\(\)/)
  assert.match(preview, /notFound\(\)/)
  assert.match(preview, /defaultScale="atlas"/)
  assert.match(preview, /Atlas → Board → Record → Source/)
})

test("the production Field is a bounded authenticated lens while workspace remains Atlas-only", async () => {
  const route = await read("app/workspace/page.tsx")
  const fieldRoute = await read("app/field/page.tsx")
  const graphClient = await read("app/graph/graph-client.tsx")
  const designPacket = await read("docs/SEMANTIC_FIELD_DESIGN_PACKET.md")
  const projection = await read("lib/semantic-field.ts")
  const preview = await read("app/dev/semantic-field-preview/semantic-field-preview-client.tsx")

  assert.match(route, /<AtlasV2Loader/)
  assert.doesNotMatch(route, /SemanticField|requestedView|requestedShell/)
  assert.match(fieldRoute, /await requireUser\(\)/)
  assert.match(fieldRoute, /presentation="field"/)
  assert.match(graphClient, /loadAuthorizedGraph\(tenantId, routeSearch, controller\.signal, codeGraphClientRef\.current/)
  assert.match(graphClient, /presentation === "graph" && shouldUseCorpusWindow/)
  assert.doesNotMatch(fieldRoute, /includeConceptFixtures|projectFederatedGraph/)
  assert.match(projection, /includeConceptFixtures\?: boolean/)
  assert.match(preview, /includeConceptFixtures/)
  assert.match(preview, /projectFederatedGraph/)
  assert.match(preview, /federatedProjection=\{federatedProjection\}/)
  assert.match(preview, /formalized_by/)
  assert.match(preview, /context_for/)
  assert.match(designPacket, /counts, relations, and most timestamps are synthetic fixtures/)
})

test("the shared dev preview gate defaults closed", async () => {
  const gate = await read("lib/dev-previews.ts")

  // Anything other than the exact string "true" must keep the previews hidden
  // outside development, so a typo in a deployment cannot expose them.
  assert.match(gate, /process\.env\.GALAXY_DEV_PREVIEWS === "true"/)
  assert.match(gate, /process\.env\.NODE_ENV === "development"/)
})
