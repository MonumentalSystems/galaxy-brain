import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("Atlas command deck groups static plugin provenance without claiming runtime health", async () => {
  const source = await readFile(
    new URL("../components/atlas/atlas-command-deck.tsx", import.meta.url),
    "utf8",
  )

  assert.match(source, /groupCommandsByPlugin\(commands\)/)
  assert.match(source, /groups\.get\(command\.plugin\.id\)/)
  assert.match(source, /left\.plugin\.id < right\.plugin\.id/)
  assert.match(source, /key=\{group\.plugin\.id\}/)
  assert.match(source, /group\.plugin\.displayName/)
  assert.match(source, /group\.plugin\.id} · v\{group\.plugin\.version/)
  assert.match(source, /registered by code-owned Galaxy plugin manifests/i)
  assert.match(source, /not connector configuration or service health/i)
  assert.match(source, /value=\{getAtlasCommandSearchValue\(command\)\}/)
  assert.match(source, /max-h-\[calc\(100dvh-1rem\)\]/)
  assert.match(source, /Command className="min-h-0 flex-1"/)
  assert.match(source, /CommandList className="min-h-0 flex-1/)
  assert.match(source, /min-w-0 flex-1/)
  assert.match(source, /flex-wrap items-baseline/)
  assert.match(source, /break-all font-mono/)
  assert.doesNotMatch(source, /CommandShortcut|Available tools|installed Galaxy plugins/i)
})

