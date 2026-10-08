# Federated code, proof, and memory graph

Galaxy projects one authorized neighborhood without copying every provider
graph into one database. The durable Galaxy graph and provider overlays retain
separate authority:

- the code-graph provider owns repository, file, symbol, and structural edges;
- Galaxy owns each registered immutable, content-addressed
  `galaxy.proof-dag.v1`; its exact bytes live once in the canonical artifact
  store, while any tenant-scoped proof-work overlay remains a separate object;
- Prove2Me imports, exports, or synchronizes compatible mission structures and
  remote status, but is not required to read an already registered Galaxy DAG;
- HAM owns memories and semantic retrieval candidates;
- Galaxy owns append-only cross-domain assertions and their retractions.

The visible chain is therefore assembled from references, not duplicated
objects:

```text
HAM memory --context_for--> Galaxy proof node
Galaxy proof graph --contains--> proof node
proof node --formalized_by--> Lean symbol --defined_in--> Lean file
Lean replay receipt --verifies--> proof node
```

`context_for` and `formalized_by` are durable assertions. `contains` and
`defined_in` are deterministic source structure. `verifies` is shown only with
an explicit accepted, sorry-free verification receipt. A HAM similarity hit is
always projected as `near`, even if its upstream label says `supports` or
`verifies`.

## Reproducible identities

Durable code and proof assertions require pinned canonical references:

```text
gb:object:v1:code.symbol:<code-v1-id>:pinned:
  git:<commit>;snapshot:sha256:<code-graph-digest>

gb:object:v1:proof.node:<graph-id>%23<node-id>:pinned:
  sha256:<proof-dag-digest>
```

The exact code ID and revision helpers live in `lib/code-graph-provider.js`.
Proof-node IDs use `<graph-id>#<node-id>` when that composite fits the canonical
reference bound. Maximum-length identifiers use the registry's deterministic,
hash-bound opaque proof-node ID instead. Both forms resolve only against the
registered immutable artifact selected by the pinned digest; proof-work rows do
not authorize proof structure.

## Authorization gateway

Galaxy resolves proof references locally. HAM and code references are sent to
a server-only authorization gateway in one bounded, de-duplicated request:

```json
{
  "schema": "gb.referent-resolution-batch.v1",
  "references": ["gb:object:v1:ham.memory:3262:latest"],
  "tenant_id": "30000000-0000-4000-8000-000000000001",
  "principal_id": "40000000-0000-4000-8000-000000000001",
  "operation": "read"
}
```

The gateway returns only decisions bound to the exact request identity:

```json
{
  "decisions": [{
    "reference": "gb:object:v1:ham.memory:3262:latest",
    "tenant_id": "30000000-0000-4000-8000-000000000001",
    "principal_id": "40000000-0000-4000-8000-000000000001",
    "readable": true,
    "resolved_revision": null,
    "provider": "ham"
  }]
}
```

For a pinned reference, `resolved_revision` must exactly equal its decoded
revision. Missing decisions mean not found or not readable. Duplicate, foreign,
or malformed decisions fail closed; gateway outages return 503 instead of a
partial graph. Configure the service with
`GB_OBJECT_REFERENCE_RESOLVER_URL` and the server-only
`GB_OBJECT_REFERENCE_RESOLVER_TOKEN`. HTTPS is mandatory except for a loopback
development gateway.

Galaxy's web service includes a narrow HAM-only implementation at
`/api/internal/object-references/resolve`. It accepts authenticated
server-to-server batches for the one configured Galaxy tenant, resolves exact
latest HAM memory IDs with the server-side HAM credential, and emits no
decision for code or other unsupported provider kinds. Configure the API's
resolver URL to the deployed HTTPS route and share
`GB_OBJECT_REFERENCE_RESOLVER_TOKEN` with the web service. This makes durable
paper/proof-to-memory links usable without granting the browser HAM authority;
code references still require a separately authorized provider gateway.

HAM's exact task-detail resolver contract currently proves the requested
`task_id` and positive live `version`, but does not return one authoritative
project reference. Consequently the read bearer used by this resolver must be
project-scoped to exactly `HAM_TASK_PROJECT_REF`; a tenant-wide or multi-project
task bearer is not a valid deployment. The bearer is the project authorization
boundary until HAM adds an exact project field to the task-detail contract,
at which point Galaxy must also compare that field with
`HAM_TASK_PROJECT_REF` before returning a readable decision.

## Projection boundary

`projectFederatedGraph` receives only already-authorized nodes, provider edges,
and active object-link rows. It de-duplicates canonical references, preserves
source and ledger provenance, prioritizes verified and deterministic evidence,
and enforces hard node, edge, and fanout limits. `SemanticField` accepts the
result through its `federatedProjection` property and exposes canonical deep
links for every projected object.

The development Semantic Field preview contains a complete fixture-only Lean,
proof, and HAM chain with Prove2Me interoperability metadata. The authenticated
`/field` route does not use those fixtures: it reuses the production Graph
loader, strict authorized source assembly, exact projection gateway, and active
`/api/eln/object-links` responses. The browser never receives an unrestricted
provider query interface or treats a canonical reference as an access token.

Pinned `document` and `document.anchor` projections now use that same boundary.
The unified Graph resolves a selected exact document and a bounded set of
missing paper/document/anchor link endpoints through the authenticated object
projection gateway. A ledger relation is retained only when both endpoints
were independently returned as authorized projections. Denied, malformed,
unavailable, or capped endpoint hydration marks its provider incomplete and
leaves the relation out; it never invents a placeholder node. Derived document
chunks remain indexing records and cannot enter Graph or Field as objects.

Latest `ham.memory` references use the same bounded gateway path. A selected
positive numeric memory ID may seed Graph or Field, and active Galaxy
object-link rows may expand it to another authorized latest HAM memory or an
exact SHA256-pinned paper, document, or document anchor. Both endpoints must be
independently authorized before the edge survives. These edges remain Galaxy
ledger assertions with their original authored basis and provenance; they are
not HAM-native relations, immutable memory snapshots, or proof. The observed
HAM version is display provenance while the canonical reference remains
explicitly follow-latest.

This read projection does not alter Atlas. Resolving an endpoint for Graph or
Field never creates a canvas placement; Atlas continues to place only explicit
user/import operations and its HAM overlay remains relations-only.

Current saved Task Plans use a separate passive source adapter. An authorized
`gb.task-plan.v1` head is projected as one hash-pinned `task-plan` reference and
hash-pinned `task-plan.job` references for its atomic jobs. The latest HAM task
remains a separately authorized object; the plan only contributes structural
`contains`, `depends_on`, `forks`, and `joins` edges. Control, data, and evidence
edges point from a dependent job to its prerequisite while their original edge
kind and ID remain in source provenance. The adapter admits or omits a plan as
a whole under a bounded source page and prioritizes an exact selected plan or
job. It never projects executor configuration, claims, dispatch intents, runs,
or completion. It also never creates Atlas placements. Because the current
task-plan API exposes only the head, a pinned historical revision that no
longer matches the current content hash fails closed rather than resolving to
newer content.

### Relation proposal review boundary

Agent and MCP callers may propose a semantic relation only between two exact
pinned references. Proposals remain pending and absent from Graph and Field.
The bounded Atlas review command is available only through an authenticated
human browser session. It reauthorizes both endpoints independently at decision
time. Accepting atomically binds the append-only human decision to an authored
active object link, creating one if absent; rejecting records only the decision. Legacy proposals
without two pinned endpoints remain rejectable but cannot be accepted. No
proposal or review decision upgrades candidate evidence into proof,
verification, or publication state. Concurrent accepted proposals for the same
active authored tuple converge on that link; direct human-authored assertions
retain the object-link ledger's independent idempotency semantics.

### Authoritative HAM relation overlay

Atlas can enrich already-authorized HAM memory placements through
`POST /api/ham/relation-overlay`. The browser supplies only 1–24 canonical
`ham.memory` references with the `latest` selector. The server uses the fixed
`HAM_API_INTERNAL` exact-memory and exact-memory-links routes under the existing
single-tenant binding and deployment-owned bearer; neither endpoint nor bearer
is browser configuration. Requests, upstream responses, elapsed time, and
concurrency are bounded, redirects are rejected, and individual provider
failures remain explicit per-reference unavailability.

The response is deliberately relations-only. It emits active authored
`cites`, `verifies`, `contradicts`, and `depends-on` rows plus immutable
`supersedes` / `superseded_by` lineage only when both endpoints were requested
and resolved. It never returns memory content, snippets, opaque metadata, or a
new adjacent node. HAM `verifies` is therefore rendered with the `asserted`
trust class; it is not a Galaxy verified receipt. The envelope always states
`follow-latest`, `partial` or `unavailable`, and distinguishes the Atlas
24-reference client-scope ceiling from upstream-provider truncation.

Atlas requests this overlay only after durable reference hydration and merges
the pure canvas adapter after snapshot hydration. The overlay is transient: it
does not enter canvas persistence, sharing, or mutation payloads. Both HAM
mutation success shapes invalidate and reload it. The authenticated `/field`
lens consumes the same already-authorized unified Graph projection through a
pure bounded presentation adapter. Exact focus and its incident neighborhood
are prioritized; unknown or derived-only object kinds fail closed; clipped
nodes/relations and missing requested references remain visibly incomplete.
This adapter performs no fetch, canonical mutation, or Atlas placement. The
development `SemanticField` preview remains separately gated and fixture-only.

## Code provider deployment

The repository includes a vendor-neutral `resolve`/`neighbors` contract and an
inert adapter for a codebase-memory-style JSON snapshot. It deliberately does
not install or execute a third-party MCP server. Generate code snapshots in an
isolated worker with read-only repository mounts, pin the repository commit and
provider version, content-address the output, and expose only fixed structured
operations after repository authorization. See `CODE_GRAPH_PROVIDER.md` for
the normalized schema, bounds, and relation-direction map.
