import assert from "node:assert/strict"
import test from "node:test"

import { arxivPdfProxyAllowed } from "../lib/arxiv-license.js"
import { arxivPaperSource, canonicalArxivPdfUrl, paperPdfFilename } from "../lib/arxiv-paper-source.js"

test("PDF proxy policy accepts only Creative Commons licenses with commercial sharing rights", () => {
  for (const licenseUrl of [
    "https://creativecommons.org/licenses/by/4.0/",
    "https://creativecommons.org/licenses/by-sa/4.0/",
    "https://creativecommons.org/publicdomain/zero/1.0/",
  ]) {
    assert.equal(arxivPdfProxyAllowed(licenseUrl), true, licenseUrl)
  }

  for (const licenseUrl of [
    "https://creativecommons.org/licenses/by-nc/4.0/",
    "https://creativecommons.org/licenses/by-nd/4.0/",
    "https://arxiv.org/licenses/nonexclusive-distrib/1.0/",
    "http://creativecommons.org/licenses/by/4.0/",
    "https://example.com/licenses/by/4.0/",
    null,
  ]) {
    assert.equal(arxivPdfProxyAllowed(licenseUrl), false, String(licenseUrl))
  }
})

test("paper source URLs are canonical and never trust imported remote URLs", () => {
  assert.equal(canonicalArxivPdfUrl("2402.08954", 3), "https://arxiv.org/pdf/2402.08954v3")
  assert.equal(canonicalArxivPdfUrl("hep-th/9108001", 1), "https://arxiv.org/pdf/hep-th/9108001v1")
  assert.equal(canonicalArxivPdfUrl("https://example.com/paper", 1), "")
  assert.equal(canonicalArxivPdfUrl("2402.08954", 0), "")
})

test("non-redistributable papers read directly while CC papers retain the authenticated proxy", () => {
  const base = { arxiv_id: "2402.08954", arxiv_version: 2 }
  assert.deepEqual(arxivPaperSource({
    ...base,
    license_url: "https://arxiv.org/licenses/nonexclusive-distrib/1.0/",
    pdf_url: "https://attacker.example/paper.pdf",
  }, "paper-1", "revision-1"), {
    access: "private-research",
    readerUrl: "https://arxiv.org/pdf/2402.08954v2",
    directUrl: "https://arxiv.org/pdf/2402.08954v2",
  })
  assert.deepEqual(arxivPaperSource({
    ...base,
    license_url: "https://creativecommons.org/licenses/by/4.0/",
  }, "paper/1", "revision/1"), {
    access: "redistributable",
    readerUrl: "/api/eln/papers/paper%2F1/download?revision_id=revision%2F1",
    directUrl: "https://arxiv.org/pdf/2402.08954v2",
  })
})

test("stored paper revisions always reopen through the authenticated private document route", () => {
  assert.deepEqual(arxivPaperSource({
    arxiv_id: "2402.08954",
    arxiv_version: 2,
    license_url: "https://arxiv.org/licenses/nonexclusive-distrib/1.0/",
  }, "paper/1", "revision/1", true), {
    access: "stored-private",
    readerUrl: "/api/eln/papers/paper%2F1/document?revision_id=revision%2F1",
    directUrl: "https://arxiv.org/pdf/2402.08954v2",
  })
})

test("private research copies receive human paper filenames", () => {
  assert.equal(paperPdfFilename({
    title: "A proof: with <unsafe> / characters?",
    authors: [{ name: "Ada Lovelace" }],
    published_at: "2026-09-14T00:00:00Z",
  }), "A proof with unsafe characters - Ada Lovelace (2026).pdf")
})
