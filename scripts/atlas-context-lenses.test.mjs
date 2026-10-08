import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { atlasContextLensLinks } from "../lib/canvas/atlas-context-lenses.js"
import {
  createGalaxyObjectReference,
  parseGalaxyObjectReference,
} from "../lib/galaxy-object-reference.js"

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8")

function resolvedHydration(requestedRef, resolvedRef = requestedRef) {
  const parsed = parseGalaxyObjectReference(resolvedRef)
  return {
    requestedRef,
    status: "resolved",
    resolvedRef,
    provider: "test",
    projection: {
      schemaId: "gb.object-projection.v1",
      ref: resolvedRef,
      kind: parsed?.kind,
    },
    handles: [],
  }
}

test("authorized canonical resolutions produce exact Graph and Field links", () => {
  const requestedRef = createGalaxyObjectReference("paper", "paper/研究 🌀")
  const resolvedRef = createGalaxyObjectReference("paper", "paper/研究 🌀", {
    mode: "pinned",
    revision: `sha256:${"a".repeat(64)}`,
  })
  const links = atlasContextLensLinks(requestedRef, resolvedHydration(requestedRef, resolvedRef))

  assert.deepEqual(links, [
    { id: "graph", label: "Open in Graph", href: `/graph?ref=${encodeURIComponent(resolvedRef)}` },
    { id: "field", label: "Open in Field", href: `/field?ref=${encodeURIComponent(resolvedRef)}` },
  ])
  assert.ok(Object.isFrozen(links))
  for (const link of links) {
    assert.ok(Object.isFrozen(link))
    const url = new URL(link.href, "https://galaxy.example")
    assert.equal(url.searchParams.get("ref"), resolvedRef)
    assert.deepEqual([...url.searchParams.keys()], ["ref"])
  }
})

test("only kinds with exact Graph and Field loaders receive lens links", () => {
  const supported = [
    "paper", "document", "document.anchor", "eln.experiment", "ham.task",
    "ham.memory", "task-plan", "task-plan.job", "surface", "proof.graph", "proof.node",
  ]
  for (const kind of supported) {
    const reference = createGalaxyObjectReference(kind, `${kind}-1`)
    assert.equal(atlasContextLensLinks(reference, resolvedHydration(reference)).length, 2, kind)
  }

  for (const kind of ["document.mark", "eln.hypothesis", "chat", "run", "turn", "claim", "artifact", "code.graph"]) {
    const reference = createGalaxyObjectReference(kind, `${kind}-1`)
    assert.deepEqual(atlasContextLensLinks(reference, resolvedHydration(reference)), [], kind)
  }
})

test("ELN observation lenses expose only the resolved immutable revision", () => {
  const latest = createGalaxyObjectReference("eln.observation", "123e4567-e89b-42d3-a456-426614174020")
  const pinned = createGalaxyObjectReference("eln.observation", "123e4567-e89b-42d3-a456-426614174020", {
    mode: "pinned",
    revision: `sha256:${"b".repeat(64)}`,
  })

  const links = atlasContextLensLinks(latest, resolvedHydration(latest, pinned))
  assert.equal(links.length, 2)
  assert.equal(new URL(links[0].href, "https://galaxy.example").searchParams.get("ref"), pinned)
  assert.deepEqual(atlasContextLensLinks(latest, resolvedHydration(latest)), [])
})

test("lens links fail closed for unresolved, legacy, malformed, noncanonical, and mismatched inputs", () => {
  const reference = createGalaxyObjectReference("paper", "paper/1")
  const other = createGalaxyObjectReference("paper", "paper/2")
  const legacy = `gb:node:${encodeURIComponent("paper/1")}`
  const noncanonical = reference.replace("%2F", "%2f")

  for (const [subjectRef, hydration] of [
    [reference, undefined],
    [reference, { status: "loading" }],
    [reference, { requestedRef: reference, status: "unavailable" }],
    [reference, { requestedRef: reference, status: "request-failed" }],
    [legacy, resolvedHydration(legacy)],
    ["not-a-reference", resolvedHydration("not-a-reference")],
    [noncanonical, resolvedHydration(noncanonical)],
    [reference, resolvedHydration(other)],
    [reference, { ...resolvedHydration(reference), resolvedRef: other }],
    [reference, { ...resolvedHydration(reference), projection: { schemaId: "gb.object-projection.v1", ref: other, kind: "paper" } }],
    [reference, { ...resolvedHydration(reference), projection: { schemaId: "gb.object-projection.v1", ref: reference, kind: "document" } }],
  ]) {
    assert.deepEqual(atlasContextLensLinks(subjectRef, hydration), [])
  }
})

test("Atlas exposes the same native lens navigation in the contextual HUD, inspector, and accessible list", async () => {
  const [client, globalNav, helper] = await Promise.all([
    read("app/atlas-v2/atlas-v2-client.tsx"),
    read("components/workspace/galaxy-lens-nav.tsx"),
    read("lib/canvas/atlas-context-lenses.js"),
  ])

  assert.equal((client.match(/atlasContextLensLinks\(/g) ?? []).length, 3)
  assert.equal((client.match(/<AtlasContextLensLinks/g) ?? []).length, 2)
  assert.match(client, /function AtlasContextLensLinks[\s\S]*<nav[\s\S]*aria-label=\{ariaLabel\}/)
  assert.match(client, /<Button[\s\S]*asChild[\s\S]*<a href=\{link\.href\}>\{link\.label\}<\/a>/)
  assert.match(client, /ariaLabel="Selected object lenses"/)
  assert.match(client, /ariaLabel=\{`Lenses for \$\{resolvedProjection\.title\}`\}/)
  assert.doesNotMatch(globalNav, /atlasContextLensLinks|searchParams|\?ref=/)
  assert.doesNotMatch(helper, /fetch\(|localStorage|sessionStorage|history\.|location\.|canvas=|placement=|conversation=/)
})
