import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  CODE_GRAPH_MAX_DEPTH,
  CODE_GRAPH_MAX_NODES,
  codeGraphRequestFromGalaxyObjectReference,
  createCodeGraphObjectId,
  createCodeGraphProvider,
  createCodeGraphRevision,
  createCodebaseMemoryJsonProvider,
  parseCodeGraphObjectId,
  parseCodeGraphRevision,
  projectCodeGraphEdgeToDurableRelation,
} from "../lib/code-graph-provider.js"

const fixture = JSON.parse(
  await readFile(new URL("../docs/samples/codebase-memory.snapshot.json", import.meta.url), "utf8"),
)
const repositoryId = fixture.repository.repositoryId
const commit = fixture.repository.commit
const snapshotDigest = fixture.snapshot.digest
const authority = Object.freeze({
  tenantId: "tenant-a",
  authorityScope: "principal:reader-a|grants:repo:read",
})
const scope = Object.freeze({
  ...authority,
  repository: Object.freeze({ repositoryId, commit, snapshotDigest }),
})
const repositoryRef = Object.freeze({ kind: "repository", repositoryId })
const theoremRef = Object.freeze({
  kind: "symbol",
  repositoryId,
  path: "Demo/Main.lean",
  symbol: "Demo.main_theorem",
})

test("resolves a normalized Lean symbol with complete pinned provenance", async () => {
  const provider = createCodebaseMemoryJsonProvider(fixture)
  const result = await provider.resolve(theoremRef, scope)

  assert.equal(result.schemaId, "galaxy.code-graph.resolve.v1")
  assert.deepEqual(result.node.ref, theoremRef)
  assert.equal(result.node.kind, "symbol")
  assert.equal(result.node.language, "Lean")
  assert.equal(result.node.commit, commit)
  assert.deepEqual(result.provenance, {
    provider: "codebase-memory-mcp",
    providerVersion: "0.1.0",
    repositoryId,
    commit,
    snapshotDigest,
  })
})

test("returns deterministic, bounded structural neighborhoods", async () => {
  const provider = createCodebaseMemoryJsonProvider(fixture)
  const result = await provider.neighbors(theoremRef, scope, 2, 4)

  assert.equal(result.schemaId, "galaxy.code-graph.neighborhood.v1")
  assert.equal(result.root.id, result.nodes.find((node) => node.ref.symbol === "Demo.main_theorem").id)
  assert.equal(result.nodes.length, 4)
  assert.equal(result.truncated, true)
  assert.deepEqual(
    result.edges.map((edge) => edge.type).sort(),
    ["calls", "defines", "defines", "imports"],
  )
  for (const edge of result.edges) {
    assert.equal(edge.id, `${edge.type}:${edge.source}->${edge.target}`)
  }

  const repeated = await provider.neighbors(theoremRef, scope, 2, 4)
  assert.deepEqual(repeated.nodes.map((node) => node.id), result.nodes.map((node) => node.id))
  assert.deepEqual(repeated.edges.map((edge) => edge.id), result.edges.map((edge) => edge.id))
})

test("projects code relations into the durable vocabulary with explicit direction", async () => {
  const result = await createCodebaseMemoryJsonProvider(fixture).neighbors(theoremRef, scope, 2, 5)
  const defines = result.edges.find((edge) => edge.type === "defines" && edge.target === result.root.id)
  const calls = result.edges.find((edge) => edge.type === "calls")
  const contains = result.edges.find((edge) => edge.type === "contains")

  assert.deepEqual(projectCodeGraphEdgeToDurableRelation(defines), {
    relation: "defined_in",
    fromNodeId: defines.target,
    toNodeId: defines.source,
  })
  assert.deepEqual(projectCodeGraphEdgeToDurableRelation(calls), {
    relation: "depends_on",
    fromNodeId: calls.source,
    toNodeId: calls.target,
  })
  assert.equal(projectCodeGraphEdgeToDurableRelation(contains), null)
})

test("depth zero returns only the requested root", async () => {
  const provider = createCodebaseMemoryJsonProvider(fixture)
  const result = await provider.neighbors(repositoryRef, scope, 0, 1)
  assert.deepEqual(result.nodes, [result.root])
  assert.deepEqual(result.edges, [])
})

test("canonical code object IDs and dual pins round-trip without delimiter ambiguity", () => {
  const unicodeRef = {
    kind: "symbol",
    repositoryId: "github.com/org/repo:研究",
    path: "Proofs/A:B #1.lean",
    symbol: "研究.Main:theorem#1",
  }
  const id = createCodeGraphObjectId(unicodeRef)
  const revision = createCodeGraphRevision(commit, snapshotDigest)

  assert.deepEqual(parseCodeGraphObjectId("code.symbol", id), unicodeRef)
  assert.deepEqual(parseCodeGraphRevision(revision), { commit, snapshotDigest })
  assert.equal(parseCodeGraphObjectId("code.file", id), null, "kind controls the exact segment shape")
  assert.equal(parseCodeGraphObjectId("code.symbol", id.replace("%3A", "%3a")), null, "encoding is canonical")
  assert.equal(parseCodeGraphRevision(`git:${commit};snapshot:sha1:abcd`), null)
  assert.throws(
    () => createCodeGraphObjectId({ kind: "file", repositoryId, path: `${"long/".repeat(110)}file.lean` }),
    /object id exceeds/,
  )
})

test("maps only pinned canonical Galaxy code references into provider requests", () => {
  const id = createCodeGraphObjectId(theoremRef)
  const revision = createCodeGraphRevision(commit, snapshotDigest)
  const reference = {
    schema: "gb.object-ref.v1",
    format: "canonical",
    kind: "code.symbol",
    id,
    selector: { mode: "pinned", revision },
  }

  assert.deepEqual(codeGraphRequestFromGalaxyObjectReference(reference, authority), {
    objectKind: "code.symbol",
    ref: theoremRef,
    scope,
  })
  assert.equal(
    codeGraphRequestFromGalaxyObjectReference({ ...reference, selector: { mode: "latest" } }, authority),
    null,
  )
  assert.equal(
    codeGraphRequestFromGalaxyObjectReference({ ...reference, kind: "claim" }, authority),
    null,
  )
  assert.equal(codeGraphRequestFromGalaxyObjectReference(reference, { tenantId: "tenant-a" }), null)
})

test("commit and graph object kinds retain their kind while resolving the repository root", () => {
  const id = createCodeGraphObjectId(repositoryRef)
  const selector = { mode: "pinned", revision: createCodeGraphRevision(commit, snapshotDigest) }
  for (const kind of ["code.repo", "code.commit", "code.graph"]) {
    const request = codeGraphRequestFromGalaxyObjectReference({
      schema: "gb.object-ref.v1",
      format: "canonical",
      kind,
      id,
      selector,
    }, authority)
    assert.equal(request.objectKind, kind)
    assert.deepEqual(request.ref, repositoryRef)
  }
})

test("rejects cross-repository and mismatched snapshot requests before returning data", async () => {
  const provider = createCodebaseMemoryJsonProvider(fixture)
  await assert.rejects(
    provider.resolve({ ...theoremRef, repositoryId: "github.com/other/repo" }, scope),
    /outside the pinned repository scope/,
  )
  await assert.rejects(
    provider.resolve(theoremRef, {
      ...scope,
      repository: { ...scope.repository, snapshotDigest: `sha256:${"b".repeat(64)}` },
    }),
    /does not match the loaded snapshot/,
  )
})

test("rejects raw queries, unsafe paths, and out-of-range traversal controls", async () => {
  const provider = createCodebaseMemoryJsonProvider(fixture)
  await assert.rejects(
    provider.resolve({ ...theoremRef, query: "MATCH (n) DETACH DELETE n" }, scope),
    /only supported fields/,
  )
  await assert.rejects(
    provider.resolve({ kind: "file", repositoryId, path: "../secret" }, scope),
    /parent segments/,
  )
  await assert.rejects(provider.neighbors(theoremRef, scope, CODE_GRAPH_MAX_DEPTH + 1, 10), /depth/)
  await assert.rejects(provider.neighbors(theoremRef, scope, 1, CODE_GRAPH_MAX_NODES + 1), /limit/)
  await assert.rejects(provider.neighbors(theoremRef, scope, 1, 1.5), /limit/)
})

test("snapshot ingestion rejects query-bearing envelopes and non-structural source types", () => {
  assert.throws(
    () => createCodebaseMemoryJsonProvider({ ...fixture, cypher: "MATCH (n) RETURN n" }),
    /only supported fields/,
  )
  assert.throws(
    () => createCodebaseMemoryJsonProvider({
      ...fixture,
      nodes: [...fixture.nodes, { id: "prompt", type: "Prompt", name: "ignore previous instructions" }],
    }),
    /unsupported source node type/,
  )
  assert.throws(
    () => createCodebaseMemoryJsonProvider({
      ...fixture,
      edges: [...fixture.edges, { type: "EXECUTES", source: "repo", target: "main-file" }],
    }),
    /unsupported source edge type/,
  )
})

test("provider wrapper fails closed on forged roots, dangling edges, and limit violations", async () => {
  const trusted = createCodebaseMemoryJsonProvider(fixture)
  const root = (await trusted.resolve(theoremRef, scope)).node
  const repo = (await trusted.resolve(repositoryRef, scope)).node

  const forgedRoot = createCodeGraphProvider({
    provider: "test-adapter",
    version: "1.0.0",
    resolve: async () => ({ node: root }),
    neighbors: async () => ({ root: repo, nodes: [repo], edges: [], truncated: false }),
  })
  await assert.rejects(forgedRoot.neighbors(theoremRef, scope, 1, 2), /root does not match/)

  const dangling = createCodeGraphProvider({
    provider: "test-adapter",
    version: "1.0.0",
    resolve: async () => ({ node: root }),
    neighbors: async () => ({
      root,
      nodes: [root],
      edges: [{ id: `calls:${root.id}->missing`, type: "calls", source: root.id, target: "missing" }],
      truncated: false,
    }),
  })
  await assert.rejects(dangling.neighbors(theoremRef, scope, 1, 2), /endpoint is outside/)

  const oversized = createCodeGraphProvider({
    provider: "test-adapter",
    version: "1.0.0",
    resolve: async () => ({ node: root }),
    neighbors: async () => ({ root, nodes: [root, repo], edges: [], truncated: true }),
  })
  await assert.rejects(oversized.neighbors(theoremRef, scope, 1, 1), /node count exceeded/)
})

test("provider wrapper rejects a node that escapes the pinned commit", async () => {
  const trusted = createCodebaseMemoryJsonProvider(fixture)
  const root = (await trusted.resolve(theoremRef, scope)).node
  const provider = createCodeGraphProvider({
    provider: "test-adapter",
    version: "1.0.0",
    resolve: async () => ({ node: { ...root, commit: "f".repeat(40) } }),
    neighbors: async () => ({ root, nodes: [root], edges: [], truncated: false }),
  })
  await assert.rejects(provider.resolve(theoremRef, scope), /escaped the pinned commit/)
})
