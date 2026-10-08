import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8")

test("Field search keeps lexical corpus retrieval isolated and cancelable", async () => {
  const field = await read("components/knowledge/semantic-field.tsx")

  assert.match(field, /import \{ searchDocumentCorpus \} from "@\/lib\/galaxy-brain-api"/)
  assert.match(field, /window\.setTimeout\(\(\) => \{[\s\S]*searchDocumentCorpus\(\{ query: raw, limit: FIELD_SEARCH_RESULT_LIMIT, signal: controller\.signal \}\)[\s\S]*searchHam\(\{ query: raw, topK: FIELD_SEARCH_RESULT_LIMIT \}, \{ signal: controller\.signal \}\)/)
  assert.match(field, /searchAbortRef\.current\?\.abort\(\)/)
  assert.match(field, /setCorpusSearchError/)
  assert.match(field, /setHamSearchError/)
  assert.match(field, /Galaxy corpus · lexical/)
  assert.match(field, /HAM · durable memory/)
  assert.match(field, /Galaxy · local field/)
  assert.match(field, /representationKind\} · lexical \{result\.matchSource\} match · pinned document revision/)
  assert.doesNotMatch(field, /corpus[^\n]*(?:score|relation|SemanticEntity)/i)
})

test("a corpus hit reloads its exact canonical document through the authorized Field path", async () => {
  const [field, graphClient] = await Promise.all([
    read("components/knowledge/semantic-field.tsx"),
    read("app/graph/graph-client.tsx"),
  ])

  assert.match(field, /onCorpusReferenceSelect\?: \(reference: string\) => void/)
  assert.match(field, /onCorpusReferenceSelect\(result\.documentRef\)/)
  assert.doesNotMatch(field, /entities:\s*\[\.{3}[^\]]*corpus/i)
  assert.match(graphClient, /const canonicalReference = safeCanonicalReference\(reference\)/)
  assert.match(graphClient, /onSelectedReferenceChange\(canonicalReference\)[\s\S]*setSelectionVersion\(\(value\) => value \+ 1\)/)
  assert.match(graphClient, /onCorpusReferenceSelect=\{onFieldCorpusReferenceSelect\}/)
})
