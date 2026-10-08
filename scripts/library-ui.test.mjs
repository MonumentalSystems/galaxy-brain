import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8")

test("Library is an authenticated first-class lens rather than a paper dropdown", async () => {
  const [page, workbench, nav] = await Promise.all([
    read("app/library/page.tsx"),
    read("components/library/library-workbench.tsx"),
    read("components/workspace/galaxy-lens-nav.tsx"),
  ])

  assert.match(page, /await requireUser\(\)/)
  assert.match(page, /<AuthShell user=\{user\} ownsAccountMenu>/)
  assert.match(nav, /href: "\/library", matchPath: "\/library", label: "Library"/)
  assert.match(workbench, /The whole field, not a dropdown\./)
  assert.match(workbench, /Search document corpus · HAM · arXiv/)
  assert.match(workbench, /Documents, papers, and ELN together/)
  assert.match(workbench, /DATA HOOVER/)
})

test("Library search keeps provider authority visible and tolerates independent failures", async () => {
  const client = await read("lib/library-client.ts")
  const workbench = await read("components/library/library-workbench.tsx")

  assert.match(client, /Promise\.allSettled\(\[/)
  assert.match(client, /searchDocumentCorpus/)
  assert.match(client, /mode: "multihop"/)
  assert.match(client, /searchArxiv/)
  assert.match(workbench, /Exact corpus passages/)
  assert.match(workbench, /HAM multi-hop/)
  assert.match(workbench, /arXiv ·/)
  assert.doesNotMatch(workbench, /JSON\.stringify/)
})

test("Library paper rows deep-link to the selected durable paper", async () => {
  const [route, workbench, papers] = await Promise.all([
    read("app/papers/page.tsx"),
    read("components/library/library-workbench.tsx"),
    read("components/papers/paper-workbench.tsx"),
  ])

  assert.match(workbench, /`\/papers\?paper=\$\{encodeURIComponent\(paper\.id\)\}`/)
  assert.match(route, /initialPaperId=\{paper\}/)
  assert.match(papers, /initialPaperId\?: string/)
  assert.match(papers, /if \(initialPaperId\) void openPaper\(initialPaperId\)/)
  assert.doesNotMatch(papers, /items\.some\(\(paper\) => paper\.id === initialPaperId\)/)
  assert.match(papers, /setLibraryOpen\(true\)/)
  assert.match(papers, /href="\/library"[\s\S]*Open full Library/)
})
