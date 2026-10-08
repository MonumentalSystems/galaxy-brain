# Canonical Galaxy object references

`gb.object-ref.v1` is the small, store-neutral identity seam shared by Galaxy projections. It names an object and states whether resolution follows the current head or pins one immutable revision. A reference is never a credential, capability, proof, or assertion that the object exists.

## Wire grammar

```text
gb:object:v1:<kind>:<percent-encoded-id>:latest
gb:object:v1:<kind>:<percent-encoded-id>:pinned:<percent-encoded-revision>
```

Approved canonical kinds are `paper`, `document`, `document.anchor`, `eln.experiment`, `eln.observation`, `eln.hypothesis`, `ham.task`, `ham.memory`, `task-plan`, `surface`, `chat`, `run`, `turn`, `claim`, `artifact`, `code.repo`, `code.commit`, `code.file`, `code.symbol`, `code.graph`, `proof.graph`, and `proof.node`. The existing `gb:entity:<id>` and `gb:node:<id>` wire forms remain unchanged and parse as discriminated `legacy.entity` or `legacy.node` follow-latest references for resolver dispatch. Canonical creation and parsing reject those legacy kinds, so there is only one wire form for each legacy reference.

IDs are 1–512 Unicode characters and revision identifiers are 1–256 Unicode characters after decoding. Control characters, unknown kinds, malformed percent encoding, ambiguous selector shapes, and oversized inputs fail closed.

## Resolution boundary

`planGalaxyObjectResolution(reference, scope)` requires a caller-supplied cache partition containing both `tenantId` and `authorityScope`, then produces an authority-neutral request:

```ts
{
  scope: {
    tenantId: "tenant-a",
    authorityScope: "principal:reader-a|grants:eln:read"
  },
  kind: "paper",
  id: "paper-1",
  followLatest: false,
  revision: "sha256:..."
}
```

The generated `identityKey` includes the tenant, authority partition, object kind and ID, and either `latest` or the exact pinned revision. Missing, empty, control-bearing, or oversized scope fields fail closed. `authorityScope` must be a stable, non-secret description of the effective authorization/cache partition; callers must never put bearer tokens or other credentials in it. A change to effective grants must produce a different authority scope.

`selectGalaxyObjectResolver` performs exact own-property dispatch by object kind but does not invoke the adapter. Each owning store supplies its adapter and remains responsible for validating the supplied scope against the authenticated caller, tenant scoping, authorization, existence, revision lookup, provenance, and content-integrity checks. UI projections may carry and resolve these references; they must not treat them as private copies of canonical state.

Use follow-latest for navigation that intentionally tracks an evolving object. Use pinned references for citations, exported Markdown manifests, experiment evidence, task inputs, and any result that must remain reproducible.

### Revision selector vocabulary

Immutable Galaxy-owned revisions use `sha256:<lowercase-content-digest>` as
their selector. Paper objects use the Galaxy paper ID and pin the normalized
metadata digest; surfaces pin the bounded surface-definition digest; and proof
objects pin the proof-graph content digest. Database UUIDs, row version numbers,
and update timestamps stay in projection provenance or display metadata; they
are not portable revision identities. Proof nodes use `<graph-id>#<node-id>`
when that fits the reference bound, otherwise the registry's deterministic
`proof-node-<graph-digest>-<target-ordinal>` identifier. Renderers must not
invent a shorter proof-node identity.

HAM tasks and current ELN experiments intentionally use `latest` because their
providers do not yet expose immutable historical reads through this boundary.
An observed task version or ELN update timestamp is provenance, not a pin.
Previously persisted `version:N`, timestamp, paper-revision UUID, or bare-digest
selectors are never silently translated into another object identity. A future
migration may re-resolve and replace them explicitly; until then resolution
must fail closed or present a clearly unavailable placeholder.

ELN observations are immutable experiment-scoped events. Durable observation
links, receipts, and placements use `pinned:sha256:<revision-digest>`. A latest
observation request may resolve to that exact pin for interactive hydration,
but it cannot turn the mutable experiment aggregate into a pinned object. The
ELN provider rechecks tenant authority and the exact stored revision; the
reference itself grants no access.

Durable link assertions impose a stronger rule on document, code, and proof objects. A `document` reference uses the Galaxy document ID and pins `sha256:<document-revision-digest>`. A `document.anchor` reference uses the deterministic `sha256:<anchor-digest>` ID and pins `sha256:<representation-digest>` so the same selector cannot silently move when a derived representation is regenerated. Code references use the provider's `code:v1:` identifier grammar and pin `git:<commit>;snapshot:sha256:<digest>`. A proof graph uses its Galaxy graph ID; a proof node uses `<graph-id>#<node-id>`. Both proof kinds pin `sha256:<graph-content-digest>`. A Prove2Me theorem or mission ID is retained as provider provenance or correspondence, not substituted for Galaxy identity. These pins keep citations, extracted regions, Lean symbols, code graphs, and proof DAGs reproducible after document, repository, or provider heads move. Follow-latest document and anchor references remain valid for navigation, but object-link assertions reject them.

## Server-side read authorization

The Galaxy API resolves proof references against tenant-scoped durable proof-graph registrations. Document authorization adapters must resolve `document` against the exact tenant-scoped document revision digest and `document.anchor` against the exact tenant-scoped anchor plus backing representation digest; neither reference is a capability. Existing storage names or imported rows may retain Prove2Me-compatible IDs, but that compatibility does not transfer ownership or make provider availability a read dependency. Provider-owned references, including HAM memories and repository objects, are authorized through the server-only `GB_OBJECT_REFERENCE_RESOLVER_URL` gateway using `GB_OBJECT_REFERENCE_RESOLVER_TOKEN`. The URL must use HTTPS (plain HTTP is accepted only on loopback). The API sends one bounded `gb.referent-resolution-batch.v1` request for de-duplicated references and requires each readable decision to echo the exact tenant, principal, canonical reference, and pinned revision. Client-supplied authorization attestations are never accepted. Missing providers fail closed; unreadable neighbor references are omitted from graph projections.

### Browser projection resolution

Authenticated browser views resolve display-safe projections through
`POST /api/eln/object-projections/resolve`. The public request contains only
`gb.object-projection-resolution-request.v1` plus 1–64 unique canonical
references. It never accepts a tenant, provider URL, authorization decision,
projector name, or open handle from the caller. NIP-98 authentication is bound
to the exact bounded request bytes before JSON decoding.

The Next server splits the batch between two server-owned providers. Galaxy
objects are read from the Python API through the private fixed-path
`gb.object-projection-source-request.v2` boundary under one tenant-scoped,
read-only, repeatable-read snapshot. During rolling deployment, the Next server
may retry the exact v1 request only when an older API explicitly rejects v2;
the API likewise accepts headerless v1 requests from older web runtimes. Request
and response schema versions must match, so compatibility cannot silently drop
v2 durable identity. HAM tasks and memories use their existing
tenant bindings and read credentials, one exact bounded fetch per reference.
The generic ELN catch-all cannot proxy the private source route. Redirects,
malformed provider records, oversized responses, identity/version mismatches,
and provider outages fail the affected request with a sanitized `503`.
Missing, denied, unsupported, and unsupported-selector references all produce
the same `{ requestedRef, status: "unavailable" }` result.

Only code-owned projectors may turn source records into
`gb.object-projection.v1`. A resolved item must preserve object identity,
pinned requests may not move revisions, projector provenance must match the
owning provider. Kinds supported by the Graph exact-reference loader receive a
fixed same-origin `/graph?ref=...` handle; other resolved kinds receive no open
handle rather than a URL that cannot hydrate them. Atlas placement links remain
`/workspace?ref=...` because Atlas only selects objects already in its
authorized projection or durable canvas. Responses preserve request order, are capped
at 2 MiB after UTF-8 serialization, and are always private/no-store. This
endpoint returns transient display envelopes; it does not alter a canvas
snapshot or make a reference durable.

Pinned `chat` references use the existing fixed conversation-tree handle
rather than the generic Graph query shape; the same exact reference is carried
as both conversation and graph focus. Their local source record contains only
bounded conversation metadata and never turns, artifacts, or raw provenance.
Graph may hand that exact reference to Atlas through the separate `placeRef`
confirmation intent; Atlas reauthorizes it and persists only reference identity
plus presentation geometry as a `galaxy.chat` card. The same exact pinned chat
may be an authored object-link endpoint: local tenant authorization verifies
the stored conversation revision before the ordinary Graph/Field relation seam
hydrates it. Mutable/latest chats are not durable link endpoints, and relation
projection never adds turns, messages, artifacts, or transcript bodies.

The Graph loader supports latest `ham.memory` references with canonical
positive numeric IDs through the tenant-bound projection gateway. That handle
does not confer access and does not pin the observed HAM version: every read is
reauthorized, the current version remains provenance, and authored object links
are rendered only after both endpoints independently resolve.

See `FEDERATED_GRAPH.md` for the gateway payload, Lean/proof/memory relation
model, projection trust classes, and deployment boundary.
