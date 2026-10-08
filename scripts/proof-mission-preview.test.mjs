import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8")

test("proof mission preview is fail-closed and parses a passive fixture", async () => {
  const page = await read("app/dev/proof-mission-preview/page.tsx")

  assert.doesNotMatch(page, /^"use client"/mu)
  assert.match(page, /devPreviewsEnabled\(\)/u)
  assert.match(page, /notFound\(\)/u)
  assert.match(page, /parseProofDag\(\{/u)
  assert.match(page, /graph_kind: "repository-field"/u)
  assert.match(page, /relation_type: "DEPENDS_ON"/u)
  assert.match(page, /relation_type: "MILESTONE_OF"/u)
  assert.match(page, /<ProofMissionPreviewClient proofDag=\{passiveRepositoryField\}/u)
})

test("proof mission preview confirms intent locally without activation", async () => {
  const client = await read("app/dev/proof-mission-preview/proof-mission-preview-client.tsx")

  assert.match(client, /^"use client"/mu)
  assert.match(client, /<ProofMissionSelector[\s\S]*proofDag=\{proofDag\}[\s\S]*onSelection=\{setConfirmedSelection\}/u)
  assert.match(client, /onDraftInvalidated=\{\(\) => setConfirmedSelection\(null\)\}/u)
  assert.match(client, /confirmedSelection\.missionId/u)
  assert.match(client, /confirmedSelection\.mainTheoremId/u)
  assert.match(client, /confirmedSelection\.milestoneIds/u)
  assert.match(client, /Read-only confirmation/u)
  assert.match(client, /no network request, registration, workspace, claim, run, frontier activation, or verification state/u)
  assert.doesNotMatch(client, /fetch\(|\/api\/|compileProofMission|createProofWorkspace/u)
})
