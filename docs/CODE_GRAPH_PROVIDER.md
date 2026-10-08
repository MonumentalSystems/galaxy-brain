# Code graph provider boundary

Galaxy treats code topology as a bounded, read-only graph provider. The provider
does not own durable cross-domain assertions: it supplies pinned repository,
file, and symbol nodes that the object-link layer may reference after applying
tenant authorization.

## Provider calls

`createCodeGraphProvider(adapter)` exposes only two structured operations:

```ts
provider.resolve(ref, scope)
provider.neighbors(ref, scope, depth, limit)
```

A `ref` is one of:

```ts
{ kind: "repository", repositoryId: "github.com/org/repo" }
{ kind: "file", repositoryId: "github.com/org/repo", path: "Demo/Main.lean" }
{
  kind: "symbol",
  repositoryId: "github.com/org/repo",
  path: "Demo/Main.lean",
  symbol: "Demo.main_theorem"
}
```

The scope includes a tenant, a secret-free authorization/cache partition, and
the exact repository input:

```ts
{
  tenantId: "tenant-a",
  authorityScope: "principal:reader-a|grants:repo:read",
  repository: {
    repositoryId: "github.com/org/repo",
    commit: "0123456789abcdef0123456789abcdef01234567",
    snapshotDigest: "sha256:..."
  }
}
```

The wrapper verifies the scope before dispatch and validates every returned
node and edge. A result cannot change repository or commit, exceed the caller's
depth or node limit, exceed the global edge bound, contain dangling edges, or
substitute a different root. Every result records provider name and version,
repository, commit, and snapshot digest. `depth` is limited to 4, nodes to 250,
and edges to 2,000.

There is deliberately no `query`, `cypher`, or arbitrary command operation in
this browser-facing contract. A server adapter for an MCP service should map
these structured calls to fixed, parameterized, allowlisted queries and apply
repository authorization before calling the provider.

## Durable Galaxy references

The helper functions in `lib/code-graph-provider.js` map canonical Galaxy code
objects to provider requests without a catalog lookup. IDs have this grammar:

```text
code.repo, code.commit, code.graph:
  code:v1:<percent-encoded repositoryId>

code.file:
  code:v1:<percent-encoded repositoryId>:<percent-encoded repository path>

code.symbol:
  code:v1:<percent-encoded repositoryId>:<percent-encoded path>:<percent-encoded qualified symbol>
```

All durable code references must use a pinned selector. Its revision pins both
the source tree and the derived graph:

```text
git:<40-or-64-character lowercase hex commit>;snapshot:sha256:<64 lowercase hex>
```

`codeGraphRequestFromGalaxyObjectReference` rejects latest selectors,
non-canonical encoding, malformed pins, and missing tenant/authority scope.
`createCodeGraphObjectId` also enforces the canonical Galaxy object ID's
512-character bound; unusually long repository paths remain queryable from a
provider but cannot be made into an ambiguous or oversized durable reference.
`code.commit` and `code.graph` resolve to the pinned repository root while
retaining their original object kind for the owning resolver.

## Relation direction at the federation seam

Provider edges remain native, deterministic code structure. They are not
silently written to the durable assertion ledger. When a caller intentionally
projects one, `projectCodeGraphEdgeToDurableRelation` uses this explicit map:

| Provider edge | Provider direction | Durable projection |
| --- | --- | --- |
| `defines` | file → symbol | symbol `defined_in` file (inverted) |
| `imports` | importing file → imported file | source `depends_on` target |
| `calls` | caller → callee | source `depends_on` target |
| `references` | referer → referenced symbol | source `depends_on` target |
| `extends` | subtype → supertype | source `depends_on` target |
| `depends_on` | dependent → dependency | source `depends_on` target |
| `implements` | implementation → contract | source `implements` target |
| `contains` | repository/directory → child | navigation only; no durable assertion |

For example, the sample's native
`Demo/Main.lean --defines--> Demo.main_theorem` becomes
`Demo.main_theorem --defined_in--> Demo/Main.lean`. This is a structural code
fact, not a proof-verification receipt. Cross-domain assertions such as a
Prove2Me node `formalized_by` that symbol or a HAM memory `documents` it must be
created separately with their own authorization and provenance.

## JSON snapshot adapter

`createCodebaseMemoryJsonProvider(snapshot)` is an inert compatibility adapter
for a supplied codebase-memory-style export. It does not install or invoke the
third-party binary, access a checkout, or evaluate a graph query. It maps an
allowlist of repository, file, and symbol-like source nodes and deterministic
structural relations into the provider-neutral contract. The committed sample
`docs/samples/codebase-memory.snapshot.json` demonstrates a Lean theorem and a
supporting lemma connected through files and deterministic `defines`,
`imports`, and `calls` edges.

For deployment, generate the export in an isolated indexing worker with a
read-only checkout, pin the provider version and commit, content-address the
result, and grant a request only after independently confirming tenant access
to the repository. Do not pass GitHub credentials, bearer tokens, filesystem
roots, raw source contents, or arbitrary query text through this contract.

## Exact snapshot admission

The Code-owned `code.graph.snapshot.import` command is an admission surface,
not a graph provider. It accepts one local `.json` file, applies the import
size, fatal UTF-8, strict JSON, duplicate-key, structural, and adapter-schema
bounds in a dedicated persistent browser worker, and returns only a bounded
review. Explicit confirmation then stores the unchanged bytes through the
canonical durable document import and places only the confirmed pinned
document reference on the originating Atlas canvas.

The resulting `application/json` artifact and its Galaxy raw-byte SHA-256 are
the only canonical authority created by admission. The repository ID, commit,
provider name/version, and `snapshot.digest` are declarations inside those
immutable bytes. In particular, `snapshot.digest` is not the raw-file digest:
the provider format defines no full-file canonical hashing algorithm and its
digest field is itself part of the file. Import therefore displays both values
but never compares, substitutes, or indexes one as the other.

Admission creates no `code.repo`, `code.file`, `code.symbol`, or `code.graph`
objects and writes no relation. Authorized projection must refetch the exact
pinned original, verify its raw bytes against the durable document hash, and
strictly validate the provider shape again. That separate boundary is the only
place code graph objects or structural edges may enter the unified graph.

## Authorized exact-source graph lens

Graph and Field activate the provider only when the URL explicitly supplies
`codeSnapshot=<exact pinned document ref>`. An optional pinned code `ref`
selects the neighborhood root; a code reference without `codeSnapshot` never
discovers or guesses a snapshot. The client resolves the document through the
authorized object-projection gateway, requires exactly one JSON original,
refetches that exact representation, and checks content type, any declared byte length,
`X-Content-SHA256`, ETag, and the recomputed raw-byte digest before parsing.

Strict JSON and provider-shape validation run again in a persistent worker.
The interactive lens rejects sources above 20,000 nodes or 80,000 edges before
provider construction, then returns only a depth-at-most-4 neighborhood capped
at 250 nodes and 2,000 edges. The worker retains no credentials and performs no
network or storage operations. Route generations and abort signals ensure a
late result cannot replace a newer selection. Source or tenant changes terminate
the prior worker before the next authorization attempt, so prior exact bytes
cannot survive a failed source transition.

The main thread validates the returned neighborhood again and projects the
source document, a synthetic `code.graph`, and addressable repository, file,
and symbol objects through the fixed `galaxy.code.snapshot` authority. Native
`contains`, `defines`, `imports`, `calls`, `references`, `extends`,
`implements`, and `depends_on` edges remain transient UnifiedGraph structure.
They do not call `projectCodeGraphEdgeToDurableRelation` and never write the
object-link ledger. Oversized code identities are omitted visibly; if the
requested root itself cannot be represented, the lens fails closed.
