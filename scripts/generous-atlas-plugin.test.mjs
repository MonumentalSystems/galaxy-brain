import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { parseGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import { listAgentTools } from "../lib/plugins/agent-tools.js"
import { promotedSurfaceReference } from "../lib/surface-placement.js"
import { listAtlasCommands } from "../lib/plugins/atlas-commands.js"

const HASH = "A".repeat(64)

function surface(overrides = {}) {
  return {
    id: "surface-reviewed",
    status: "promoted",
    current_content_hash: HASH,
    ...overrides,
  }
}

test("promoted surface placement pins the exact canonical content hash", () => {
  const reference = promotedSurfaceReference(surface())
  const parsed = parseGalaxyObjectReference(reference)
  assert.deepEqual(parsed, {
    schema: "gb.object-ref.v1",
    format: "canonical",
    kind: "surface",
    id: "surface-reviewed",
    selector: { mode: "pinned", revision: `sha256:${HASH.toLowerCase()}` },
  })
})

test("draft, archived, malformed and unhashed surfaces fail closed", () => {
  assert.throws(() => promotedSurfaceReference(surface({ status: "draft" })), /Only promoted/)
  assert.throws(() => promotedSurfaceReference(surface({ status: "archived" })), /Only promoted/)
  assert.throws(() => promotedSurfaceReference(surface({ current_content_hash: "sha256:not-a-digest" })), /SHA-256/)
  assert.throws(() => promotedSurfaceReference(surface({ id: "" })), /Surface id/)
  assert.throws(() => promotedSurfaceReference(null), /required/)
})

test("Atlas hydration and picker both request promoted surfaces only", async () => {
  const [atlas, dialog] = await Promise.all([
    readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/surfaces/promoted-surface-place-dialog.tsx", import.meta.url), "utf8"),
  ])
  assert.match(atlas, /\/api\/eln\/surfaces\?status=promoted&limit=60/)
  assert.doesNotMatch(atlas, /\/api\/eln\/surfaces\?limit=60/)
  assert.match(atlas, /surfaces\.values\.filter\(\(surface\) => surface\.status === "promoted"\)/)
  assert.match(atlas, /surfaces: promotedSurfaces\.values\.map/)
  assert.match(dialog, /getSurfaces\(\{ status: "promoted", query: deferredQuery \|\| undefined, limit: 200 \}\)/)
  assert.match(dialog, /records\.filter\(\(surface\) => surface\.status === "promoted"\)/)
  assert.match(dialog, /promotedSurfaceReference\(selected\)/)
  assert.match(dialog, /onPlace: \(subjectRef: string\) => boolean/)
  assert.match(dialog, /focus-within:ring-2/)
  assert.match(dialog, /disabled=\{busy \|\| loading \|\| !selectedVisible\}/)
  assert.match(dialog, /Showing 200 matches\. Refine the search/)
  assert.match(dialog, /<DialogTitle className="research-display text-2xl">Place promoted Generous surface<\/DialogTitle>/)
  assert.equal(
    listAtlasCommands({ canPlaceReference: true })
      .find((command) => command.id === "surface.place.open")?.title,
    "Place promoted Generous surface",
  )
})

test("server boundaries reject draft surface projection and accept searchable promoted listings", async () => {
  const [server, sources, genericDialog] = await Promise.all([
    readFile(new URL("../services/galaxy-brain-api/server.py", import.meta.url), "utf8"),
    readFile(new URL("../services/galaxy-brain-api/object_projection_sources.py", import.meta.url), "utf8"),
    readFile(new URL("../components/atlas/reference-place-dialog.tsx", import.meta.url), "utf8"),
  ])
  assert.match(server, /def _validate_surface_placement_commands/)
  assert.match(server, /_validate_surface_placement_commands\(cur, commands, identity\)/)
  assert.match(server, /revision\.status = 'promoted'/)
  assert.match(server, /position\(lower\(%s\) in lower\(title\)\) > 0/)
  assert.match(sources, /revision\.status = 'promoted'/)
  assert.match(sources, /AND status = 'promoted'/)
  assert.match(genericDialog, /inspectPlaceableReference\(value, \{ allowSurface: false \}\)/)
  assert.match(genericDialog, /Use “Place promoted Generous surface” for Generous surfaces\./)
})

test("Generous command is routed through the existing reference placement saga", async () => {
  const atlas = await readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8")
  assert.match(atlas, /commandId === "surface\.place\.open"/)
  assert.match(atlas, /result\.effect\.kind !== "open-surface-place"/)
  assert.match(atlas, /<PromotedSurfacePlaceDialog/)
  assert.match(atlas, /onPlace=\{placeReference\}/)
  assert.match(atlas, /setSurfacePlaceOpen\(false\)/)
})

test("Generous owns only the reviewable surface draft mutation", () => {
  const registration = listAgentTools().find((tool) => tool.id === "surface.draft.create")
  assert.deepEqual(registration, {
    id: "surface.draft.create",
    pluginId: "generous",
    plugin: { id: "generous", displayName: "Generous", version: "1.0.0" },
    implementationId: "builtin.surface.draft.create",
    readOnly: false,
  })
  assert.equal(Object.isFrozen(registration), true)
  assert.equal(Object.isFrozen(registration.plugin), true)
  assert.equal(listAgentTools().some((tool) => /promote|place|execute|publish/u.test(tool.id)), false)
})
