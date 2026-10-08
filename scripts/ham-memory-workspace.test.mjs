import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8")

test("memory workspace exposes immutable edits, native organization, and canonical HAM edges", async () => {
  const workspace = await read("components/ham-memory-workspace.tsx")

  assert.match(workspace, /role="dialog"/)
  assert.match(workspace, /aria-modal="true"/)
  assert.match(workspace, /Save as new version/)
  assert.match(workspace, /form=\{editFormId\}/)
  assert.match(workspace, /flex h-full w-full max-w-2xl flex-col overflow-hidden/)
  assert.match(workspace, /min-h-0 flex-1 overflow-y-auto/)
  assert.match(workspace, /bg-\[#fffdf7\] text-slate-950/)
  assert.match(workspace, /HAM-native organization/)
  for (const field of ["project", "repo", "task", "sequence", "scopes"]) {
    assert.match(workspace, new RegExp(field))
  }
  for (const relation of ["cites", "verifies", "contradicts", "depends-on"]) {
    assert.match(workspace, new RegExp(`"${relation}"`))
  }
  assert.match(workspace, /describeHamMemoryEdge/)
  assert.match(workspace, /canonical stored direction/)
  assert.match(workspace, /edge\.kind === "typed"/)
  assert.match(workspace, /buildHamMemorySupersedeChanges/)
  assert.match(workspace, /!draftChange\.changed/)
  assert.doesNotMatch(workspace, /signNostrAuthEvent|Sign in with Nostr to edit HAM/)
  assert.match(workspace, /This is a bounded neighborhood/)
})

test("cross-system links are authored Galaxy assertions with a closed relation vocabulary", async () => {
  const workspace = await read("components/ham-memory-workspace.tsx")

  assert.match(workspace, /fetch\("\/api\/eln\/object-links"/)
  assert.match(workspace, /basis: "authored"/)
  assert.match(workspace, /source: "manual", source_system: "galaxy-ham-workspace"/)
  assert.match(workspace, /parseGalaxyObjectReference\(fromRef\)/)
  assert.match(workspace, /galaxyBrainAPI\.getPapers\(100\)/)
  assert.match(workspace, /mode: "pinned"/)
  assert.match(workspace, /revision: `sha256:\$\{paper\.metadata_hash\}`/)
  assert.match(workspace, /Paper evidence must identify an exact immutable revision/)
  assert.doesNotMatch(workspace, /createGalaxyObjectReference\("paper", event\.target\.value\)/)
  assert.doesNotMatch(workspace, /basis:\s*galaxyBasis/)
})

test("the Field can focus and reopen an authoritative HAM memory", async () => {
  const field = await read("components/knowledge/semantic-field.tsx")

  assert.match(field, /focusReference\?: string/)
  assert.match(field, /onHamMemoryOpen\?: \(memoryId: string\) => void/)
  assert.match(field, /Open canonical HAM memory/)
  assert.match(field, /entry\.sourceReference === focusReference/)
})
