# Bounded agent tools

Status: bounded read/pure-proposal tools plus narrowly authorized mutations.

Galaxy exposes ten code-owned read or pure-proposal tools and five bounded
mutation tools through `galaxy-plugin.v1`:

- `ham.memory.search`
- `objects.search`
- `objects.get`
- `objects.representations`
- `canvas.get`
- `graph.window.get`
- `proof.graph.get`
- `proof.frontier.get`
- `task.plan.get`
- `task.plan.propose`
- `canvas.arrange`
- `anchors.create`
- `proof.claim`
- `relations.propose`
- `surface.draft.create`

Calls use `gb.agent-tool-call.v1` and results use
`gb.agent-tool-result.v1`. Requests are at most 64 KiB, responses are at most
1 MiB. Pageable collection reads use content- or version-bound cursors;
`objects.search` is bounded top-N discovery and instead exposes only
`continuation.hasMore`. The route is
`POST /api/agent-tools/{tool}` with an exact matching `tool` field in the body.

Read tools accept the same browser session, human API key, or NIP-98 agent
identity as the existing authenticated application routes. Every mutation,
including `canvas.arrange`, `anchors.create`, `proof.claim`, `relations.propose`, and
`surface.draft.create`, always requires a fresh
payload-bound NIP-98 signature; a bearer key or ambient browser session cannot
perform it. Tenant and principal headers are derived on
the server and are never accepted from tool input. A plugin manifest may select
only a source-controlled implementation ID; it cannot register a URL, module,
function, or script. Discovery and dispatch also require the registration's
tool ID and plugin owner to agree with that exact validated manifest's
`agentTools` contribution. Internal descriptors retain only its frozen ID,
display name, and package version; this static provenance does not indicate
installation, connection, credentials, reachability, or health and does not
change the HTTP or MCP wire contracts.

## Authority boundary

`canvas.arrange` submits one bounded, atomic command batch to the existing
Galaxy canvas mutation API. The call carries the expected canvas version and
content hash plus an idempotency key. It permits only placement, movement,
resize, reorder, and presentation-only edge creation. It cannot remove items,
disconnect edges, attach a `semanticRef`, mutate a referenced object, claim or
release proof work, dispatch a task, execute code, promote a surface, or
publish an artifact. Semantic relations remain a separate proposal/promotion
slice. HAM contributes only the read-only `ham.memory.search` tool; the plugin
manifest and callable allowlist contain no HAM memory-write capability.

`anchors.create` binds one immutable selector to one representation of one
exact pinned document revision. The caller supplies only the canonical document
reference, representation UUID and content hash, selector, and idempotency key.
The server resolves the provider-local revision identity inside the authenticated
tenant, validates the representation bytes, and returns a small request-bound
receipt. Internal revision UUIDs and caller-authored provenance are not exposed.
Canonical `gb.document-mark.v1` creation and update require a separately
authenticated human browser session. Agents may read authorized marks and use
their exact pinned references where another contract permits them, but no
native agent, plugin, or MCP catalog exposes mark authorship. The legacy
`/papers/{paper_id}/annotations` compatibility surface is not part of this
canonical mark-authority boundary and is unchanged by PR #289.

`relations.propose` records only a tenant-scoped, pending, append-only relation
proposal after both exact pinned endpoints are authorized in the same
transaction. It does not create or project an active object link. The agent
cannot accept, reject, or retract an active relation. A separately authenticated
human browser session reauthorizes both endpoints before accepting or rejecting
the proposal. Acceptance binds the append-only decision to an authored active
link in one transaction, creating one if absent; rejection creates no link. Neither outcome implies
proof or verification.

`proof.graph.get` reads immutable structure only. `proof.frontier.get` derives
available nodes from one exact graph hash and one exact active work-state
version. A passive `repository-field` is always returned with
`coordinationActive: false`, `claimable: false`, and an empty frontier; its
workspace input is not consulted.

`proof.claim` acquires/extends or releases one bounded lease in
`galaxy.proof-work-state.v1`. It accepts the exact graph hash, workspace and
node identifiers, both compare-and-swap versions, an action, and an
idempotency key. Acquire requires a 60-86400 second lease; the existing owner
extends a lease by acquiring again. The server requires an authoritative
mission activation and rechecks the stored prerequisite frontier. Identity and
claim ownership come only from the fresh NIP-98 request. This Galaxy lease does
not claim a linked HAM task, create a Hyades run, submit a candidate, or verify
a proof. Idempotent replay returns current state; if that node has changed since
the original transition, the tool reports `replay_superseded` instead of
misreporting the old action as current.

`objects.search` is a bounded discovery tool over the current tenant-local
document corpus. It returns the exact validated `gb.document-corpus-search.v1`
envelope unchanged: content-only lexical matches, pinned document references,
small snippets, and representation/chunk selector provenance. It does not
expose chunk bodies or chunk objects, fuse provider scores, hydrate Graph,
create relations, or accept a caller-selected tenant, endpoint, or cursor.
`continuation.hasMore` means the caller should refine the query; a returned
reference can be followed with `objects.get` and `objects.representations`.

`ham.memory.search` is a separately ranked read-only discovery tool over the
configured HAM tenant. Its closed request union supports ordinary, two-hop,
and temporal retrieval. The server derives the HAM origin, service bearer,
tenant, and actor from trusted configuration and the authenticated Galaxy
identity; none can be supplied by the caller. Results contain canonical
follow-latest `ham.memory` references only for valid positive memory IDs,
bounded HAM content and metadata, HAM's own score/tier/hop/temporal fields,
and explicit truncation markers. The adapter stream-caps upstream JSON and
keeps its aggregate result below the agent response ceiling. It does not fuse
HAM rank with Galaxy relevance, write memory, create relations or objects,
persist a cache, or expose provider diagnostics.

`graph.window.get` is a read-only adapter over the existing strict
`gb.graph-window-request.v1` to `gb.graph-window.v1` provider. The caller may
supply only `rootRef`, `viewport`, `kinds`, `relations`, `expandClusterId`, and
`cursor`; the server derives `workspaceId: tenant-catalog`, `mode: mixed`,
`lens: explore`, `scale: corpus`, internal origin, identity headers, and the
graph-window gateway header. The returned envelope keeps the provider's
`follow-latest` consistency, per-provider ready/partial/unavailable disclosure,
exact pinned members, empty v1 aggregate-edge list, and nested
`continuation.model: replace-page` semantics. In particular, the visible
`galaxy.object-links` partial state is not upgraded into inferred edges. A
stale or foreign signed cursor yields a sanitized conflict instructing the
caller to restart the replacement page. The tool does not hydrate members,
dispatch to caller-selected providers, infer relations, attach projector
provenance, or create persistence or mutation authority.

`task.plan.get` reads one saved, tenant-scoped `gb.task-plan.v1` record by plan
UUID or HAM task ID and exposes its exact plan version, content hash,
pinned HAM task version, and bounded job DAG. `task.plan.propose` calculates one
exact-base additive patch
with action `branch`, `join`, `compare`, `challenge`, or `synthesize`. Every
external input reference must be canonical, pinned, and readable by the
caller. The Python provider validates the resulting full plan against the
128-node, 512-edge, 512 KiB DAG contract but performs no database write.

The proposal is task-local work intent, not durable semantic truth. It cannot
delete or rewrite jobs, create or mutate a HAM task, claim or run work,
dispatch an executor, change a canvas, write a semantic relation, save a task
plan revision, or promote a surface. The Task Constructor may apply it to a
local draft; the existing explicit task-plan save remains the only durable
plan-revision path. The constructor exposes the same
code-owned producer to humans through `/api/agent-tools/task.plan.propose`.
Every authority-bearing base field comes from the loaded saved-plan record,
and candidate contents remain hidden until the browser independently verifies
the exact base, operation contract, and cryptographic proposal hash. Production
and local application never save, mutate HAM, claim or execute work, or create
a semantic relation.

The same dispatcher is also exposed through the thin MCP 2026-07-28 adapter at
exactly `POST /mcp`. It publishes only the fifteen tools above, uses a permissive
object schema for discovery, and leaves `parseAgentToolCall` as the authoritative
contract validator. The adapter is stateless and JSON-only: it has no legacy
transport, GET/SSE endpoint, session, resource, prompt, OAuth flow, dynamic
plugin loading, or independent provider path.

The MCP envelope is capped at 80 KiB and each nested agent-tool call retains the
64 KiB limit; completed responses are stream-capped at the 1 MiB tool result
limit plus fixed protocol overhead. Results appear once in `structuredContent`
with a fixed small text message. Errors are normalized and bounded. Identity is
resolved once per request and closed over the per-request server. Calls to
`canvas.arrange`, `anchors.create`, `relations.propose`, and
`surface.draft.create` and `proof.claim` require a fresh NIP-98
signature over the exact MCP request bytes and exact `/mcp` target;
`task.plan.propose` remains a pure proposal under ordinary read authentication.
