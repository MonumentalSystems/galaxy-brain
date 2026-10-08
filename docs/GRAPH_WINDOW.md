# Bounded corpus graph window

`gb.graph-window.v1` is the first server-owned read model for corpus-scale graph navigation. It is deliberately separate from `gb.graph-projection.v1`:

- a graph projection is an exact set of authorized objects and authoritative relations;
- a graph window is a bounded navigation page over a potentially much larger tenant catalog.

The browser sends `gb.graph-window-request.v1` to `POST /api/graph/window`. The authenticated BFF supplies tenant and principal identity to the private API. Callers cannot select either identity or an upstream destination.

## Current contract

- Workspace: `tenant-catalog`
- Mode: `mixed` only; citation and federated modes continue through the existing exact graph projection until their corpus providers exist
- Lens and scale: `explore` / `corpus`
- Consistency: honest `follow-latest`
- Aggregate identities: opaque SHA-256 identifiers over schema, tenant, workspace, provider, and kind; presentation mode and counts do not participate
- Member page: at most 200 exact pinned references
- Pagination: HMAC-signed, 15-minute, tenant/principal/query/cluster-bound keyset cursor
- Page behavior: replace the prior member page; never accumulate a corpus in React
- Exact focus: an independently authorized canonical `rootRef` may accompany the
  aggregate window as navigation context; it does not change counts, members,
  layout, or authority
- Layout: cluster bounds are server-owned; the browser only lays out the bounded member page
- Cache policy: private, no-store
- Database work: repeatable-read, read-only, with a 750 ms statement timeout; one slow aggregate count degrades only that provider

Documents, papers, promoted Generous surfaces, and explicitly referenced ELN observations have exact member projections. ELN experiments remain aggregate-only because the experiment object reference is mutable and has no immutable revision selector. Observations are not added to global discovery; only an already-authorized canonical observation reference resolves to its pinned immutable revision.

Active object-link assertions are not yet aggregated into this response. The provider therefore reports `partial`, and the response emits no aggregate edges. This avoids presenting a sampled or stale relation count as complete. Exact object views continue to use the existing authorized graph projection and active-link ledger.

Member pages use follow-latest keyset pagination. Each page replaces the prior page, and the UI explicitly warns that concurrent inserts or deletions can shift later pages.

This slice establishes the bounded transport and progressive-disclosure behavior. It does not claim a five-million-object performance benchmark, temporal snapshots, HAM/proof aggregate counts, or relation aggregation.

An exact proof projection may now hand its Corpus scale to this read model by
placing the pinned `proof.graph` reference in `rootRef`. The API reauthorizes
that reference in the same tenant-scoped read transaction and echoes it only as
`focus`. The browser replaces the campaign projection with the bounded corpus
window and offers an explicit return link to the same exact graph. It never
combines campaign nodes with corpus members, creates a proof aggregate, or
turns focus into registration, claim, verification, or publication authority.
