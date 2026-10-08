import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("paper result transport remains bound to an exact anchor, linked task, and terminal candidate", async () => {
  const client = await readFile(new URL("../lib/paper-reader-client.ts", import.meta.url), "utf8")

  assert.match(client, /provenance\?\.source_ref/u)
  assert.match(client, /source\.kind !== "ham\.task"/u)
  assert.match(client, /source\.selector\.mode !== "pinned"/u)
  assert.match(client, /createdTaskVersion: version/u)
  assert.doesNotMatch(client, /taskVersion: version/u)
  assert.match(client, /const exactBacklinks = new Map<string, PaperReaderBacklink>\(\)/u)
  assert.match(client, /!exactBacklinks\.has\(backlink\.taskId\)/u)
  assert.match(client, /response\.status === 403 \|\| response\.status === 404 \|\| response\.status === 409/u)
  assert.match(client, /Promise\.allSettled\(/u)
  assert.match(client, /fulfilled\.length === 0/u)
  assert.match(client, /if \(failure\) throw failure\.reason/u)
  assert.doesNotMatch(client, /const results = await Promise\.all\(/u)
  assert.match(client, /documentRevisionId: anchor\.document_revision_id/u)
  assert.match(client, /anchorId: anchor\.id/u)
  assert.match(client, /source\.taskId !== expected\.taskId/u)
  assert.match(client, /expected\.eventId !== undefined && source\.eventId !== expected\.eventId/u)
  assert.match(client, /expected\.resultHash !== undefined && source\.resultHash !== expected\.resultHash/u)
})

test("paper result projection rejects unbounded or mutable citations and accepts the review wrapper", async () => {
  const client = await readFile(new URL("../lib/paper-reader-client.ts", import.meta.url), "utf8")

  assert.match(client, /gb\.paper-agent-result-review\.v1/u)
  assert.match(client, /const candidate = nestedCandidate \?\? envelope/u)
  assert.match(client, /source\.performedByRef/u)
  assert.match(client, /PAPER_AGENT_RESULT_MAX_SUMMARY_CHARACTERS = 20_000/u)
  assert.match(client, /PAPER_AGENT_RESULT_MAX_EVIDENCE_REFS = 50/u)
  assert.match(client, /parsed\.selector\.mode !== "pinned"/u)
  assert.match(client, /serializeGalaxyObjectReference\(parsed\) === value/u)
  assert.match(client, /Galaxy Brain returned an invalid agent result citation/u)
  assert.match(client, /rawDecision\.action !== "accept" && rawDecision\.action !== "reject"/u)
  assert.match(client, /Galaxy Brain did not acknowledge the agent result decision/u)
})

test("reader cancels stale result loads and exposes explicit accessible review controls", async () => {
  const [reader, card] = await Promise.all([
    readFile(new URL("../components/papers/durable-paper-reader.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/papers/paper-agent-result-card.tsx", import.meta.url), "utf8"),
  ])

  assert.match(reader, /const controller = new AbortController\(\)/u)
  assert.match(reader, /agentResultGeneration\.current === generation/u)
  assert.match(reader, /return \(\) => controller\.abort\(\)/u)
  assert.match(reader, /backlinksAnchorRef !== selectedAnchor\.ref/u)
  assert.match(reader, /Refresh results/u)
  assert.match(reader, /<PaperAgentResultCard/u)
  assert.match(reader, /`paper-result:\$\{candidate\.resultHash\.slice\("sha256:"\.length\)\}:\$\{action\}`/u)
  assert.match(reader, /agentResultAnchorRef\.current = selectedAnchor\?\.ref \?\? ""/u)
  assert.match(reader, /if \(agentResultAnchorRef\.current !== anchorRef\) return/u)
  assert.match(reader, /if \(agentResultAnchorRef\.current === anchorRef\)/u)
  assert.match(reader, /setAgentResultBusyKey\(\(current\) => current === busyKey \? "" : current\)/u)
  assert.doesNotMatch(reader, /if \(agentResultGeneration\.current === generation\) setAgentResultBusyKey/u)

  assert.match(card, /<article/u)
  assert.match(card, /aria-labelledby=\{headingId\}/u)
  assert.match(card, /<MarkdownRenderer content=\{candidate\.summary\} images="omit"/u)
  assert.match(card, /<ul/u)
  assert.match(card, /<details/u)
  assert.match(card, /Accept into Galaxy/u)
  assert.match(card, /Reject result/u)
  assert.equal(card.match(/className="min-h-11"/gu)?.length, 2)
  assert.match(card, /role="status"/u)
  assert.match(card, /aria-live="polite"/u)
  assert.match(card, /decisionStatusRef\.current\?\.focus\(\)/u)
  assert.match(card, /Only Accept admits these exact reviewed bytes into Galaxy/u)
  assert.doesNotMatch(card, /result artifact|<dt>Artifact<\/dt>/u)
})
