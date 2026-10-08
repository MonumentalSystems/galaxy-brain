# Canvas Harness Integration Plan

Status: proposed

Audience: Galaxy Brain, Generous, and canvas-harness maintainers

The canonical implementation order and product decisions live in
[`GALAXY_V2_IMPLEMENTATION_PRD.md`](GALAXY_V2_IMPLEMENTATION_PRD.md). This
document supplies the canvas adapter and persistence detail for that roadmap.

## Outcome

Galaxy Brain should use `canvas-harness` as the spatial interaction and
rendering engine for its research canvas while retaining Galaxy Brain as the
authority for tenants, resources, revisions, provenance, and permissions.
Generous remains the bounded generative-presentation vocabulary through the
existing `gb.surface.v1` and `generous.a2ui` contracts.

The infinite canvas is the primary spatial experience: a canvas-first atlas,
not another competing content or component system. Canonical objects remain
portable, versioned, addressable records in their owning systems, while list,
search, and detail routes remain accessible ways to reach the same objects.

```text
Galaxy Brain canonical data and authorization
  resources, revisions, canonical references, bindings, provenance
                              |
                              v
Galaxy canvas projection adapter
  authorized objects -> scene nodes; scene commands -> versioned mutations
                              |
                              v
canvas-harness runtime
  viewport, geometry, selection, hit-testing, edges, LOD, ink, history
                              |
                              v
Galaxy and Generous React views
  notes, assets, experiments, tasks, and bounded A2UI surfaces
```

The integration is a projection boundary, not a data-model merger. A canvas
may cache authorized display data, but it must never become an authoritative
copy of a note, experiment, proof, task, HAM memory, or Generous surface.

## Current state

Galaxy Brain currently has two hand-built spatial implementations:

- `components/galaxy-canvas.tsx` owns camera transforms, pointer capture,
  selection, node dragging, inline editing, file drops, and DOM rendering.
- `components/infinite-canvas.tsx` implements an older overlapping pan, zoom,
  and absolute-positioned DOM canvas.

Both implementations mount their workspace nodes as DOM elements and keep
rendering, geometry, and application mutations closely coupled. They do not
provide a common spatial index, viewport culling, typed operation boundary, or
level-of-detail policy.

Galaxy Brain already has the complementary presentation boundary:

- `gb.surface.v1` bounds component count, encoded size, depth, string length,
  properties, and bindings.
- `generous.a2ui` is the approved component catalog.
- surfaces are tenant-scoped, versioned, content-hashed, revisioned, and
  explicitly promoted;
- the contract rejects arbitrary JSX, executable props, scripts, handlers,
  event properties, and undeclared network bindings;
- binding resolution is permission-filtered and revalidates the materialized
  surface before rendering.

The first integration should therefore replace the spatial machinery while
leaving the surface contract and canonical resource APIs intact.

## Goals

1. Provide one high-performance spatial workspace for notes, documents,
   papers, assets, experiments, hypotheses, tasks, proofs, and promoted
   surfaces, and make it the primary spatial experience.
2. Preserve canonical identity, revisions, provenance, tenant isolation, and
   optimistic concurrency across every durable canvas mutation.
3. Render rich Galaxy and Generous content as bounded custom React nodes while
   using lightweight canvas placeholders during motion or at distant zoom.
4. Separate durable resource content from reusable canvas placement so the
   same resource can appear in multiple canvases or more than once in one
   canvas.
5. Expose bounded, permission-filtered canvas context and commands to agents
   without treating the canvas-harness operation log as an authorization
   protocol.
6. Preserve accessible list, search, and detail views alongside the graphical
   workspace.
7. Retire the fallback only after parity gates pass, while retaining ordinary
   versioned-deployment rollback during the adoption window.

## Non-goals

- Replacing Galaxy Brain's database, resource APIs, object-reference scheme,
  RLS policies, or revision ledgers.
- Importing the Generous application shell, chat product, authentication, or
  arbitrary JSX renderer into Galaxy Brain.
- Preserving or importing the Flowise-derived workflow editor; its useful
  task-planning behavior is rebuilt through the canonical Task Constructor.
- Making HAM similarity results durable assertions merely because they are
  drawn as nearby nodes or edges.
- Using `@canvas-harness/sync-broadcast` as production collaboration. It is a
  same-machine demonstration transport, not Galaxy authorization or durable
  synchronization.
- Persisting camera position or selection as shared document state.
- Claiming accessibility through the graphical canvas alone.

## Ownership boundaries

| Concern | Authority |
| --- | --- |
| Tenant and principal identity | Galaxy Brain |
| Resource content and revisions | Owning Galaxy or external provider |
| Surface definition, promotion, and bindings | `gb.surface.v1` APIs |
| Immutable proof DAG and proof-node structure | Galaxy `galaxy.proof-dag.v1` registry |
| Prove2Me mission structure and remote status | Prove2Me interoperability adapter |
| Tenant-scoped proof work and verification overlay | Galaxy proof-work APIs |
| Verification result authority | Registered verifier identity and its accepted receipt; projected by Galaxy |
| Semantic assertions | Galaxy object-link ledger or owning provider |
| HAM similarity candidates | HAM, projected as non-authoritative `near` relations |
| Canvas placement and explicit presentation edges | Galaxy canvas APIs |
| Camera, hover, selection, and active tool | Browser-local canvas state |
| Geometry, hit-testing, spatial index, and frame rendering | canvas-harness |
| Bounded generated UI vocabulary | Generous A2UI catalog |
| Whether an action is authorized | Galaxy server-side policy, never the renderer |

## Dependency and adapter boundary

Pin the first integration to exact versions of
`@canvas-harness/core@0.2.0` and `@canvas-harness/react@0.2.0`. Do not expose
their store directly across the application. Introduce a Galaxy-owned adapter:

```text
lib/canvas/
  canvas-adapter.ts          canonical projection and command boundary
  canvas-node-types.ts       statically registered custom node definitions
  canvas-identifiers.ts      canonical reference <-> scene ID conversion
  canvas-persistence.ts      debounced, versioned mutation batches
  canvas-context.ts          bounded agent/user context projection
  canvas-performance.ts      development-only diagnostics and budgets

components/canvas/
  galaxy-canvas-runtime.tsx  client-only provider and canvas composition
  galaxy-resource-node.tsx   authorized resource card/editor view
  galaxy-surface-node.tsx    bounded surface host
  galaxy-node-placeholder.ts canvas LOD representation
  galaxy-canvas-toolbar.tsx  tools, view controls, and accessible alternatives
```

The adapter converts stable Galaxy projections into canvas-harness nodes and
converts local interactions into Galaxy commands. No API or database record
should depend on canvas-harness's private store layout or raw `Op` wire shape.
That insulates Galaxy Brain from pre-1.0 library changes.

The runtime must be a client component and should be loaded only on routes
that need the spatial workspace. Existing Galaxy Markdown, KaTeX, media, and
asset components remain responsible for rich content. In particular, do not
put durable Galaxy asset URLs into canvas-harness built-in image nodes, whose
self-contained data-URI policy does not match Galaxy's authorized asset model.

## Scene projection

### Canonical vocabulary

The adapter keeps four identities separate:

| Term | Meaning |
| --- | --- |
| Object reference | Durable conceptual identity plus latest or pinned revision policy. |
| Graph node | One object's participation in a particular graph projection. |
| Canvas placement | One spatial occurrence of an object; an object may have many. |
| Panel | Renderer output for a placement or graph node at one zoom level; never durable knowledge by itself. |

A saved Generous surface is itself an object and normally one placement. Its
internal component tree remains layout inside that placement rather than
silently becoming independent graph nodes or canvas items.

### Stable identifiers

Canvas scene IDs must be deterministic projections of placement IDs, not raw
resource IDs. A resource may have multiple placements.

```text
Canvas node ID:  placement:<canvas-item-uuid>
Subject ref:     gb:object:v1:<kind>:<object-id>:<revision-policy>
Surface ref:     gb:object:v1:surface:<surface-id>:pinned:<content-hash>
```

The exact `subject_ref` grammar must use Galaxy's canonical object-reference
helpers. A reference identifies an object; it does not grant permission to
resolve or render it.

### Custom node types

The initial registry should be static and code-owned:

| Canvas node type | React view | Distant or moving representation |
| --- | --- | --- |
| `galaxy.paper` | Paper metadata, Markdown/LaTeX excerpt, or PDF handoff | title, authors, revision marker |
| `galaxy.note` | Markdown and KaTeX note preview | type, title, revision marker |
| `galaxy.document` | Authorized document or PDF preview | media type, title, revision marker |
| `galaxy.media` | Authorized image, audio, or video view | media type, title, asset marker |
| `galaxy.surface` | Existing safe `SurfaceRenderer` | title, status, component count |
| `galaxy.eln-record` | Experiment or hypothesis summary | kind, title, state |
| `galaxy.task` | Bounded task projection | title, state, assignee marker |
| `galaxy.chat` | Exact pinned conversation metadata projection | title, revision marker, branch/turn counts |
| `galaxy.proof` | Galaxy proof graph/node plus work overlay and optional Prove2Me metadata | title, work state, verified-receipt marker |
| `galaxy.reference` | External authorized reference | provider, label, revision marker |

Each definition supplies:

- a static `view` marker plus the React layer's
  `renderCustomNodeView` callback for the already-authorized live view;
- `renderCanvas` and `drawPlaceholder` for lightweight motion and LOD
  representations;
- explicit minimum zoom thresholds for live DOM mounting;
- a parser for the small display-data envelope;
- no runtime registration from surface data or agent output.

In canvas-harness 0.2.0, declared node `parse` hooks and `locked` flags are not
enforced by the runtime. Galaxy must therefore validate every `node.data`
envelope at the render boundary and enforce a read-only preview by blocking
scene mutation methods and mutation shortcuts, rather than trusting those
declarations as security controls.

The node `data` envelope should contain identifiers, display-safe summaries,
revision/hash markers, and view preferences. Full canonical content remains in
its owning resource store and is fetched through authorized Galaxy routes.

### Relation trust classes

The canvas must keep four relation classes structurally distinct rather than
encoding all of them as visually interchangeable edges:

1. deterministic structure from an owning source, such as a registered Galaxy
   proof DAG's `contains` or a code provider's `defined_in`;
2. authored, retractable assertions from Galaxy's object-link ledger;
3. verified proof evidence backed by an accepted verifier receipt in Galaxy's
   proof-work overlay; and
4. provisional HAM similarity candidates, always projected as `near`.

Each projected edge carries its trust class, owning source, provenance, and
claim ceiling. Styling, legends, inspection, exports, and agent context must
preserve the distinction. Proximity, color, or an upstream HAM label must
never upgrade a candidate into an assertion or verification result.

### Generous surfaces

A `galaxy.surface` node stores a pinned surface reference or an explicit
`latest` policy selected by the user. Its live React view uses the current
Galaxy `SurfaceRenderer` initially. A later shared Generous renderer package
may replace that local renderer only after its catalog, version, digest, CSP,
and threat model match `gb.surface.v1`.

The surface host must:

1. resolve bindings through the existing authenticated Galaxy API;
2. refuse to render a schema, catalog, digest, or renderer version it does not
   support;
3. retain the last valid presentation when a binding is unavailable;
4. show draft/promoted, version, content hash, and binding health outside the
   generated content;
5. switch to a canvas placeholder during camera motion and at distant zoom;
6. never accept arbitrary JSX or executable component registration.

One bounded surface is normally one spatial node. The internal A2UI component
tree is layout within that node, not a second freely editable canvas scene.

## Persistence prerequisites

Phase 0 and Phase 1 remain read-only. Durable canvas tables and mutation APIs
must not ship until both contracts below have fixtures and cross-runtime tests.

### Deterministic snapshot serialization and hashing

Define `gb.canvas.snapshot.v1` as a Galaxy-owned format independent of
canvas-harness's store and operation types. A snapshot contains only durable
canvas presentation state: items, explicit presentation edges, removal
tombstones for projected items and edges, and their validated Galaxy fields.
It excludes camera, hover,
selection, active tools, transient drag geometry, cached canonical content,
and canvas-harness history.

The API envelope contains `canvasId`, `version`, `contentHash`, and `content`.
The hash input is exactly the `content` value below, so database identity and
revision metadata do not make equivalent layouts hash differently:

```json
{
  "schemaId": "gb.canvas.snapshot.v1",
  "items": [],
  "edges": [],
  "removedItemIds": [],
  "removedEdgeIds": []
}
```

Canonical serialization must:

- normalize the content value as described below, then emit UTF-8 JSON using
  RFC 8785 JSON Canonicalization Scheme (JCS);
- sort items and edges by their stable placement/edge IDs;
- sort object keys recursively while preserving order only for arrays whose
  order is semantically meaningful;
- reject non-finite numbers, normalize `-0` to `0`, use one numeric encoding,
  reject lone Unicode surrogates, and preserve validated Unicode code points
  without NFC/NFD rewriting or renderer-derived values;
- omit timestamps, database row order, current version, and other metadata
  that do not change the represented layout from the hash payload.

`current_content_hash` is `sha256:<lowercase-hex>` over the UTF-8 bytes of that
canonical content payload. The server computes it after every accepted batch
and on reload; clients may recompute it only as a consistency check. Database
JSON rendering is never itself the hash input. Golden fixtures must prove that
Node, browser, API, and database round trips produce identical bytes and hashes
for equivalent snapshots, including reordered input objects and edge cases in
numbers and Unicode.

### Multi-client convergence and change notifications

The Galaxy server is the convergence authority. Clients submit only bounded
Galaxy commands with `expectedVersion`, `expectedContentHash`, and an
idempotency key. Neither the API, revision ledger, nor notification transport
persists or republishes raw canvas-harness operations.

After a successful transaction, publish an authorization-filtered invalidation
event containing only `canvasId`, the new version, the new content hash, and an
opaque mutation ID. SSE or WebSocket delivery is a transport choice, not a
correctness dependency. A reconnecting client supplies its last observed
version; a missing event, version gap, hash mismatch, or transport failure
causes it to fetch the current authorized snapshot.

```json
{
  "schemaId": "gb.canvas.changed.v1",
  "canvasId": "...",
  "version": 13,
  "contentHash": "sha256:...",
  "mutationId": "opaque-server-id"
}
```

A client with no pending gesture reloads when it observes a newer version. A
client with optimistic local changes keeps them visibly pending, submits them
against its recorded base, and handles `409` by reloading the authoritative
snapshot before offering a deliberate retry. Events at the current or an older
version are ignored. This produces deterministic convergence without treating
camera state, renderer state, or last-writer arrival order as shared truth.

Subscriptions require the same tenant and canvas-read authorization as normal
projection reads, are revalidated on reconnect, and reveal no object titles,
command bodies, or hidden placement metadata. Revision rows may retain the
validated Galaxy command batch for audit and inverse mutations; they never
retain canvas-harness `Op` values.

## Durable canvas model

Create a separate placement model rather than storing one global position on
each resource.

### Proposed records

```text
gb_canvases
  id, tenant_id, workspace_id, title
  current_version, current_content_hash
  removed_item_ids, removed_edge_ids
  created_by_principal_id, created_at, updated_at, deleted_at

gb_canvas_items
  id, tenant_id, canvas_id, subject_ref
  node_type, x, y, width, height, angle, z_index
  display_mode, collapsed, style_json
  created_by_principal_id, created_at, updated_at, deleted_at

gb_canvas_edges
  id, tenant_id, canvas_id
  source_item_id, target_item_id
  edge_kind, label, semantic_ref, style_json
  created_by_principal_id, created_at, updated_at, deleted_at

gb_canvas_revisions
  id, tenant_id, canvas_id, version, content_hash
  mutation_json, snapshot_json, idempotency_key, request_hash
  created_by_principal_id, created_at
```

Phase 2 canvases are shared tenant/workspace reasoning surfaces. All tables
require tenant RLS, authenticated runtime access, restricted database grants,
migration-ledger coverage, startup privilege verification, bounded JSON
validation, and the same fail-closed login checks used by existing Galaxy API
tables. The creator remains audit provenance, not an access-control owner.
There is no page-, placement-, reference-, or provenance-level ACL inside an
authenticated tenant canvas.

The snapshot uses bounded item and edge tombstone arrays so a removal can mask
an item or relation supplied by the current authorized projection. A missing
placement row means "use the projected default"; it never means "removed."

`semantic_ref` is optional. A visible edge with semantic meaning must point to
an authorized canonical assertion, such as an active object-link record. A
presentation-only connector has no truth semantics. HAM similarities are
ephemeral projected edges until a separately authorized action promotes a
typed assertion.

Camera, selection, hover state, active tools, and temporary drag geometry are
not part of this model. A per-principal viewport preference may be added later,
but it must not increment the shared canvas document version.

### Mutation API

Prefer a bounded command endpoint over storing the library operation stream:

```text
GET  /canvases/{id}
GET  /canvases/{id}/projection?viewport=...&zoom=...&cursor=...
POST /canvases
POST /canvases/{id}/mutations
GET  /canvases/{id}/revisions
```

A mutation request contains:

```json
{
  "expectedVersion": 12,
  "expectedContentHash": "sha256:...",
  "idempotencyKey": "...",
  "commands": [
    {
      "type": "item.move",
      "itemId": "...",
      "position": { "x": 420, "y": -160 }
    }
  ]
}
```

Initial command kinds are `item.place`, `item.move`, `item.resize`,
`item.remove`, `item.reorder`, `edge.connect`, and `edge.disconnect`. The
server validates finite coordinates, dimensions, identifiers, styles, batch
size, edge endpoints, optimistic preconditions, and authenticated tenant.
Placement references and provenance are shared tenant data, not secondary
authorization gates, so persistence and reads do not require an external
per-reference permission gateway. Accepted batches atomically increment the
version and append an immutable revision. Conflicts return `409` with the
current version/hash; the client reloads and offers a deliberate retry rather
than silently applying an operation to a different base.

The client may use canvas-harness undo/redo for an uncommitted local gesture.
Undo after persistence is a new inverse Galaxy mutation with its own actor,
version, and provenance; it is not deletion of history.

## Authorization and agent tools

Authenticated humans and NIP-98 agents operate on the same tenant canvas:

- `canvas:read` reads shared tenant canvas snapshots and projections;
- `canvas:write` performs bounded placement and presentation mutations;
- `canvas:export` requests a permission-filtered export if exports become a
  server capability.

These route capabilities distinguish canvas reads from mutations; they do not
partition tenant data by creator, page, object reference, or provenance.
Mutating a referenced HAM task, proof, surface, or ELN record remains a
separate action from arranging or reading it on the canvas.

Agent tools should expose Galaxy commands, for example:

```text
canvas.get_context
canvas.place_reference
canvas.move_item
canvas.resize_item
canvas.connect_items
canvas.remove_item
```

`canvas.get_context` returns a bounded selection or viewport projection with
canonical references, revision markers, safe summaries, provenance, and
relation ceilings. It must not return the whole tenant, unrestricted resource
content, credentials, private provider metadata, or hidden offscreen objects.

The canvas-harness `getContext()` and typed `Op` facilities may help construct
local context and interactions, but their output must pass through the Galaxy
projection and authorization layer before it becomes an agent tool result or a
durable mutation.

## Rendering and interaction policy

- Built-in primitive nodes may use the canvas renderer directly.
- Rich Galaxy nodes use DOM overlays only above their configured zoom
  threshold and within a capped viewport/overscan region.
- At distant zoom, live views are replaced with placeholders. Canvas-harness
  0.2.0 does not reliably replace every already-mounted DOM overlay during
  camera motion, so Phase 0 must measure that behavior and Phase 1 must add a
  Galaxy-owned motion gate if rich fixtures exceed the overlay/frame budgets.
  Editors, media playback, and other stateful views require an explicit
  keep-alive policy rather than remaining mounted accidentally.
- A resource opens in the existing detail/editor surface when full editing is
  more appropriate than inline editing.
- File drops continue to use Galaxy's conversion, asset, and ingestion
  services. The canvas creates placements only after the canonical resource
  creation succeeds.
- The first live Atlas drop slice is deliberately narrower: one registered
  `document.upload` PDF or closed UTF-8 text/code file, imported durably before
  its pinned reference is placed at the `screenToWorld` drop point. A confirmed
  import retries placement with the same reference, operation ID, and point;
  unsupported, mixed, multi-file, directory, URL, and rich-media payloads make
  no write. Browser-local assets, data URLs, and IndexedDB are not a fallback.
- Canvas exports must include only resources readable by the requester and
  should visibly mark unresolved or restricted references.
- Search, list, keyboard navigation, and detail views remain available without
  requiring precise pointer use.

## Delivery phases

The sequence is intentional: prove the adapter and development route, render
authorized objects read-only, add semantic zoom and selection routing, and
validate realistic interaction performance before introducing any placement
schema or mutation API. Federated overlays and agent commands follow durable
placement rather than expanding the compatibility spike.

### Phase 0: compatibility spike

Create a development-only `/dev/canvas-harness` route and adapter.

Deliverables:

- exact dependency pins;
- a client-only canvas with synthetic primitives;
- Galaxy-owned projection and identifier adapters that do not expose the
  canvas-harness store;
- representative read-only paper, note, task, proof, and `galaxy.surface`
  prototypes, with Markdown, KaTeX, PDF, media, ELN, and Generous fixtures;
- React 19, Next.js, theme, pointer, clipboard, CSP, and production-build
  compatibility checks;
- explicit checks that read-only mode does not depend on the unenforced
  canvas-harness `locked` field and that math remains in Galaxy's KaTeX path
  instead of the library's CDN-backed built-in MathJax loader;
- representative performance fixtures.

Exit gate: the production build succeeds, no network or CSP exception is
needed for the selected node types, and the realistic fixture remains usable
under the agreed performance budgets.

### Phase 1: read-only authorized projection

Use the canonical `/workspace` route to project existing authorized resources
without changing persistence.

Implementation status: `/workspace` now serves Atlas directly. `/atlas-v2` is
a temporary compatibility redirect that preserves canonical `canvas`,
`placement`, and `ref` deep links. Legacy `shell` and `view` query parameters
no longer select the old workspace. Atlas `ref` links select objects already in
the authorized projection or durable canvas; arbitrary exact references remain
addressable through `/graph?ref=...`. The initial client loads papers, ELN records,
HAM tasks, and bounded Generous surfaces through their existing authenticated,
tenant-filtered browser APIs. The canonical projection gateway is now the
replacement boundary: it accepts only bounded canonical-reference batches and
returns code-owned, display-safe projections with fixed same-origin open
handles. Atlas integration must hydrate those projections into transient React
state; it must not write them into `gb.canvas.snapshot.v1`. Restricted or
temporarily unavailable placements remain geometry-preserving locked
placeholders instead of disappearing. The client also combines resolved
projections with the current tenant-scoped workspace's note, document, and
media nodes. Authorized
proof-packet resource claims are rendered as unverified Prove2Me references,
not as Galaxy-owned proof content or verification evidence. Every source is
bounded to 60 items, unavailable sources fail independently, and the route
offers both the read-only spatial view and an accessible list projection.

Deliverables:

- deterministic placement-to-scene mapping;
- read-only paper, note, task, proof, ELN, media, document, and surface nodes;
- semantic-zoom thresholds and lightweight LOD placeholders for every rich
  node type;
- selection routing to existing panels;
- visible provenance, version, and binding status;
- accessible list fallback;
- development performance diagnostics.

Exit gate: projected content matches the existing workspace, cross-tenant and
unreadable objects never reach the browser, and the release remains revertible
through the versioned deployment. The realistic research fixture must also meet
the interaction and overlay budgets established by the Phase 0 spike.

### Phase 2: durable placement API

Add the canvas tables, RLS, migrations, typed API client, versioned batch
mutations, revision ledger, and persistence adapter.

Implementation status: the Phase 2 vertical slice defines
`gb.canvas.snapshot.v1` with cross-runtime RFC 8785 golden fixtures, adds
tenant-isolated canvas, item, edge, and append-only revision tables, and exposes
bounded `canvas:read`/`canvas:write` APIs. Atlas drag and resize gestures emit
Galaxy placement commands only, debounce until gesture completion, reload on
`409`, and require an explicit retry against the refreshed version. Camera,
selection, display envelopes, canonical resource content, and canvas-harness
operations are excluded from revision snapshots and mutation records.

Entry gate: `gb.canvas.snapshot.v1`, canonical hashing fixtures, and the
multi-client notification/convergence contract are specified and passing.

Deliverables:

- create, place, move, resize, reorder, connect, disconnect, and remove;
- debounced drag persistence with final pointer-up flush;
- optimistic conflict handling and idempotent retries;
- exact reload reconstruction;
- migration/startup permission and tenant-isolation tests.

Exit gate: a canvas round-trips exactly after reload; stale writes fail with
`409`; idempotent retries cannot duplicate placements or revisions; restricted
runtime roles cannot cross tenant boundaries.

### Phase 3: primary research canvas

Move the supported note, document, asset, ELN, task, proof, and surface journeys
onto the new runtime.

Deliverables:

- file drop through canonical resource creation;
- inline note editing or explicit editor handoff;
- minimap, frames, grouping, export, and optional ink where product-approved;
- legacy-position migration into a default canvas;
- telemetry for projection size, overlay count, frame cost, mutation latency,
  and conflicts.

Exit gate: supported journeys meet functional, accessibility, and performance
acceptance criteria, and migration is reversible until the legacy canvas is
retired.

### Phase 4: semantic and federated overlays

Project HAM neighborhoods, Galaxy object links, code graphs, proof DAGs, and
other federated relations through the existing authorization gateway.

Deliverables:

- visually distinct deterministic, asserted, verified, and `near` edges;
- viewport/scale/lens-bounded server projection;
- provenance inspection and canonical deep links;
- explicit promotion flow from a candidate relation to a durable typed
  assertion where policy allows it.

Exit gate: visual proximity and edge styling never elevate an evidence claim;
projection outages fail closed without corrupting durable layout.

### Phase 5: bounded agent interaction

Expose canvas context and commands through scoped agent APIs.

Deliverables:

- NIP-98 scope enforcement;
- bounded viewport/selection context;
- idempotent, versioned placement commands;
- human confirmation for destructive multi-item operations and any semantic
  assertion promotion;
- audit events linking actor, command, base version, and result version.

Exit gate: an agent with only `canvas:write` can arrange readable references
but cannot read or mutate their canonical contents, promote surfaces, create
semantic truth claims, or cross tenants.

### Phase 6: retirement and package review

Remove duplicated spatial implementations only after adoption and rollback
criteria are satisfied. Reassess whether to remain pinned, vendor an audited
fork, or upgrade canvas-harness. Evaluate a shared Generous renderer package as
a separate decision.

## Validation plan

### Contract and unit tests

- canonical reference to scene ID mapping is deterministic and collision-safe;
- malformed IDs, non-finite geometry, excessive dimensions, unapproved styles,
  and oversized batches are rejected;
- projection never includes unresolved unauthorized display data;
- surface nodes retain `gb.surface.v1` validation and renderer pin checks;
- canvas-harness ops translate only to the approved Galaxy command set;
- inverse mutations preserve revision history;
- ephemeral HAM edges cannot serialize as semantic assertions.

### API, database, and security tests

- RLS isolation for canvases, items, edges, and revisions;
- restricted runtime-role grants and startup verification;
- idempotent replay and mismatched-request rejection;
- stale version/hash conflict behavior;
- deterministic snapshot bytes and hashes across reordered equivalent input,
  process restart, browser/server runtimes, and database round trips;
- two clients writing from one base version converge by one accepted batch and
  one `409`/reload path, without persisting canvas-harness operations;
- duplicated, reordered, dropped, and post-revocation change notifications do
  not leak data or produce divergent authoritative snapshots;
- subject-readability checks on create and on later projection;
- NIP-98 method, URL, body-hash, replay, revocation, and scope enforcement;
- exports and agent context omit restricted subjects and provider metadata.

### Browser and interaction tests

- cursor-anchored wheel/pinch zoom and pointer capture;
- drag, resize, selection, deletion, clipboard, undo, and reload;
- custom-node LOD transitions without losing committed edits;
- surface binding unavailable/recovery behavior;
- keyboard-accessible selection and equivalent list/detail journeys;
- one supported file drop creates or reuses one canonical resource and one
  placement at the pan/zoom-correct world point; ambiguous placement retries do
  not re-upload, and a repeated same-file/same-canvas drop focuses the existing
  card;
- canonical-route redirect behavior and legacy layout migration.

### Performance fixtures

Maintain two separate fixtures so primitive throughput does not hide rich-node
cost:

1. a high-density primitive scene with thousands of nodes and edges;
2. a realistic research workspace with resource cards, promoted surfaces,
   media placeholders, and semantic overlays.

Record target hardware, browser, device-pixel ratio, node/edge count, live DOM
overlay count, frame time while panning and zooming, initial projection time,
and memory use. Set release budgets from the Phase 0 baseline. Do not adopt
canvas-harness's self-reported benchmark as a Galaxy acceptance result.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Pre-1.0 dependency changes | Exact pins and a Galaxy-owned adapter; no raw store persistence |
| Rich React nodes erase canvas performance gains | LOD placeholders, culling, overlay cap, realistic fixtures |
| Canvas becomes a second source of truth | Store only placements and references; canonical APIs own content |
| Visual edge implies unsupported truth | Typed edge classes, claim ceilings, provenance, explicit promotion |
| Unauthorized cached labels leak | Server projection filters; small safe envelopes; fail-closed resolution |
| Drag streams overload persistence | Local gesture state, debounced batches, mandatory pointer-up flush |
| Conflicting edits silently overwrite | Expected version/hash and immutable revisions |
| Library asset or MathJax behavior conflicts with CSP | Use Galaxy asset/Markdown/KaTeX views; enable no unused loaders |
| Declared `locked` state is not enforced in 0.2.0 | Galaxy read-only store boundary and blocked mutation shortcuts; server remains authoritative |
| Existing rich overlays remain mounted during motion | Measure in Phase 0; add a Galaxy-owned motion gate before Phase 1 if budgets require it |
| Canvas-only UI harms accessibility | Preserve list/search/detail routes and keyboard-equivalent actions |
| Migration strands legacy layouts | Preserve legacy records during the migration window and use versioned-release rollback rather than a second runtime shell |

## Acceptance criteria

The integration is complete when:

1. Galaxy Brain has one supported primary research canvas and no duplicated
   production pan/zoom implementation.
2. Resource content, surfaces, tasks, proofs, and assertions remain canonical
   in their owning stores; the canvas persists only its own layout and
   presentation records.
3. The same canonical resource can have independent placements in multiple
   canvases.
4. Every durable mutation is tenant-scoped, authorized, versioned,
   idempotent, attributed, and revisioned.
5. Promoted Generous surfaces render through `gb.surface.v1` without arbitrary
   JSX or bypassing binding resolution.
6. Realistic workspace benchmarks meet the budgets established in Phase 0.
7. List, search, and detail workflows provide accessible alternatives.
8. Semantic candidates remain distinguishable from durable assertions and
   verified evidence.
9. Scoped agents can arrange authorized references without gaining authority
   over the referenced resources.
10. The legacy canvas can be removed without losing data or changing canonical
    object identity.

## Open decisions

Resolve these during Phase 0 or before the durable schema migration:

1. Whether a workspace owns exactly one default canvas or an arbitrary set of
   named canvases.
2. Whether a pinned surface is the default placement policy, with `latest`
   requiring an explicit opt-in.
3. Which rich node types may stay mounted during motion and how their transient
   UI state is preserved across LOD transitions.
4. Whether ink is presentation-only canvas content or a canonical Galaxy asset
   with its own revision and extraction path.
5. Whether exported images are produced client-side from an already authorized
   projection or by a server job with a durable export receipt.
6. When viewport projection should move from bounded full-canvas loads to a
   server-side spatial index and continuation protocol.
7. Whether Galaxy continues to maintain its safe local surface renderer or
   consumes a separately packaged, digest-pinned Generous renderer.

Snapshot serialization/hashing and multi-client convergence are not open
implementation details: the minimum contracts are fixed in this plan and must
be validated before Phase 2. The remaining transport and library choices may
vary only if they preserve those contracts.

None of these decisions changes the primary boundary: Galaxy Brain owns its
durable objects, immutable proof DAGs, work overlays, and authorization;
Prove2Me interoperates through import/export and remote identifiers;
canvas-harness owns spatial interaction; and Generous owns the bounded
presentation vocabulary.
