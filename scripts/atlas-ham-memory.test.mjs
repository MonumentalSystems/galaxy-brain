import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { summarizeHamSearchResult } from "../lib/ham-search-summary.js"
import { dispatchAtlasCommand, listAtlasCommands } from "../lib/plugins/atlas-commands.js"

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8")

test("HAM search summaries are bounded plain text", () => {
  const summary = summarizeHamSearchResult({
    id: "3262",
    content: `  evidence\u0000 with\nspace \u202E${"x".repeat(400)}  `,
    tier: 2,
    metadata: { title: `  Project\tdecision ${"y".repeat(150)}` },
  })

  assert.equal(Object.isFrozen(summary), true)
  assert.equal(summary.title.includes("\u0000"), false)
  assert.equal(summary.title.includes("\t"), false)
  assert.equal(summary.snippet.includes("\u202E"), false)
  assert.equal(summary.title.length <= 120, true)
  assert.equal(summary.snippet.length <= 240, true)
})

test("HAM contributes one static Atlas command with no injected request payload", () => {
  const command = listAtlasCommands({ canSearchHam: true })
    .find((candidate) => candidate.id === "ham.memory.search.open")
  assert.equal(command?.enabled, true)
  assert.deepEqual(dispatchAtlasCommand("ham.memory.search.open", {}), {
    ok: true,
    effect: { kind: "open-ham-memory-search" },
  })
  assert.deepEqual(dispatchAtlasCommand("ham.memory.search.open", { endpoint: "https://invalid.test" }), {
    ok: false,
    code: "invalid_input",
  })
})

test("Atlas HAM browser composes canonical clients and does not persist memory copies", async () => {
  const browser = await read("components/atlas/atlas-ham-memory-browser.tsx")
  const atlas = await read("app/atlas-v2/atlas-v2-client.tsx")
  const workspace = await read("components/ham-memory-workspace.tsx")

  for (const operation of ["getHamMemory", "supersedeHamMemory", "linkHamMemories", "unlinkHamMemories"]) {
    assert.match(browser, new RegExp(operation))
  }
  assert.match(browser, /<HAMSearchModal/)
  assert.match(browser, /<HamMemoryWorkspace/)
  assert.match(atlas, /ham\.memory\.search\.open/)
  assert.match(atlas, /<AtlasHamMemoryBrowser/)
  assert.doesNotMatch(browser, /galaxyBrainService|createNode|\/api\/ham\//)
  assert.match(workspace, /createGalaxyObjectReference\("ham\.memory", memory\.id\)/)
  assert.match(workspace, /memory\.state === "active"/)
  assert.match(workspace, /historical and read-only/)
  assert.match(workspace, /readOnly=\{Boolean\(mutationReadOnlyReason\)\}/)
  assert.match(browser, /result\.status === "committed"/)
  assert.match(browser, /do not repeat the committed action/)
  assert.equal(workspace.includes("Historical reads"), true)
  assert.equal(workspace.includes("canonical follow-latest selector"), true)
})

test("HAM search and workspace retain accessible modal behavior", async () => {
  const search = await read("components/ham-search-modal.tsx")
  const workspace = await read("components/ham-memory-workspace.tsx")

  assert.match(search, /<Dialog open=/)
  assert.match(search, /<Label htmlFor=\{queryId\}>Memory query<\/Label>/)
  assert.match(search, /role="status" aria-live="polite" aria-atomic="true"/)
  assert.match(search, /role="alert"/)
  assert.match(search, /onCloseAutoFocus/)
  assert.match(search, /returnFocus\.focus\(\)/)
  assert.match(search, /max-h-\[min\(88dvh,760px\)\]/)
  assert.match(search, /min-h-11/)
  assert.match(workspace, /returnFocus\?\.isConnected/)
})

test("the global Galaxy lens rail exposes HAM search and restores focus", async () => {
  const nav = await read("components/workspace/galaxy-lens-nav.tsx")

  assert.match(nav, /import \{ AtlasHamMemoryBrowser \}/)
  assert.match(nav, /ref=\{hamSearchTriggerRef\}/)
  assert.match(nav, /aria-label="Search HAM memory"/)
  assert.match(nav, /aria-haspopup="dialog"/)
  assert.match(nav, /aria-expanded=\{hamSearchOpen\}/)
  assert.match(nav, />HAM Search<\/span>/)
  assert.match(nav, /<AtlasHamMemoryBrowser[\s\S]*open=\{hamSearchOpen\}/)
  assert.match(nav, /returnFocus=\{hamSearchTriggerRef\.current\}/)
})
