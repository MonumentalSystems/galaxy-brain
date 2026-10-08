# Proof work state API

Galaxy Brain stores the mutable coordination and verification overlay separately
from the immutable `galaxy.proof-dag.v1` artifact. A workspace is permanently
bound to one `graph_id` and the SHA-256 digest of the exact graph bytes.

## Register immutable structure

Galaxy is the durable authority for proof structure even when Prove2Me or another
source is unavailable. Register the exact UTF-8 JSON bytes with:

`POST /api/eln/proof-graphs`

The body is the `galaxy.proof-dag.v1` document itself, not a JSON wrapper. The
request is limited to 16 MiB and requires a fresh NIP-98 signature over those
exact bytes. Galaxy computes the SHA-256 digest server-side, stores the bytes in
the canonical `gb_artifacts` content store, and appends tenant-scoped registry
metadata. Reposting identical bytes is an idempotent content-hash replay; no
workspace, task, claim, or frontier is created. This generic endpoint accepts
only passive `repository-field` graphs. A browser cannot register a claimable
`campaign` or `mission` by extracting a nested DAG from a local draft.

Browse bounded summaries with:

`GET /api/eln/proof-graphs?limit=50&offset=0`

Fetch one exact artifact with:

`GET /api/eln/proof-graphs/{contentSha256}`

The exact response carries `ETag`, `X-Content-SHA256`, `X-Proof-Graph-ID`, and
`X-Proof-Graph-Kind` headers. A registered `repository-field` is permanently
passive. Existing registered `campaign` and `mission` rows remain readable, but
new active structure can be created only through the server-authoritative
mission activation operation described below.

Prove2Me imports follow the same rule: conversion produces a passive
`repository-field`. An immutable target may retain only its stable Prove2Me
theorem ID under `external.prove2me`; mutable remote status is recorded only in
`galaxy.proof-work-state.v1` through `external.set`. It never becomes a target
category, formal binding, Galaxy verification, or authority to activate work.

## Mission draft and activation boundary

The Graph lens can derive a read-only mission draft from one exact registered
`repository-field`, one explicitly selected main theorem, and optional curated
milestones. The browser compiler hashes the exact source bytes itself and
deterministically selects the main theorem's reverse prerequisite closure. The
result is a preview/export, not structural authority and not work state.
Downloaded bytes use the deliberately non-registerable top-level schema
`galaxy.proof-mission-draft.v1`; its `mission_dag` member is a locally parsed
`galaxy.proof-dag.v1` candidate. The proof registry rejects the envelope itself,
so activation cannot occur by uploading the downloaded draft unchanged.
Compiler output preserves typed LeanProofs correspondence metadata. A source
`bridge_nomination: null` means no nomination and is omitted from the nested
mission relation; a non-null nomination must contain the bounded typed fields.

An authenticated reader can ask the API to independently derive the same
candidate with:

`POST /api/eln/proof-graphs/{sourceContentSha256}/mission-candidates`

The bounded `galaxy.proof-mission-intent.v1` body repeats the exact passive
source `graph_id`, `graph_kind: repository-field`, and `content_sha256`, names
one mission and main target, supplies the curated milestone IDs, and explicitly declares
`prerequisite-to-dependent` relation direction. The API resolves the source in
the current tenant's registry, verifies its exact bytes and metadata, and
recomputes the reverse prerequisite closure. It returns a deterministic
`galaxy.proof-mission-candidate.v1` envelope with `activation_state: inactive`,
`registerable: false`, and the canonical candidate digest. It writes nothing.

Activation is one separate, explicit mutation:

`POST /api/eln/proof-graphs/{sourceContentSha256}/mission-activations`

Its bounded `galaxy.proof-mission-activation-request.v1` body contains the
exact mission intent, the reviewed candidate digest, one exact immutable
verification-set reference, a workspace key, and an idempotency key. It never
accepts a client-authored mission DAG, frontier, node list, work-state seed, or
HAM task. The server resolves and locks the exact passive source and baseline,
recompiles the mission, rejects a stale reviewed digest, and atomically creates
the immutable mission graph, activation record, workspace, and immutable
frontier snapshot. Replaying the same idempotency key and request returns the
same identities; reusing it for different bytes fails closed.

The initial activation path accepts only an explicit empty verification set.
It therefore inherits no proof claims and creates no proof-item rows. Non-empty
baselines remain blocked until a versioned server adapter can authenticate or
replay their exact receipts. Rosetta correspondence and provider status remain
interoperability metadata, not proof evidence. A textual `category`, formal
binding, or Prove2Me status never becomes verified merely by activation.

## Immutable verification baselines

`POST /api/eln/proof-verification-sets` registers a canonical,
content-addressed `galaxy.proof-verification-set.v1` artifact against one exact
tenant-owned passive `repository-field` graph. `GET
/api/eln/proof-verification-sets` lists registrations and `GET
/api/eln/proof-verification-sets/{contentSha256}` returns the canonical artifact
bytes. Registration does not create a mission graph, workspace, task, claim,
run, frontier, or mutable proof status.

The honest zero-inheritance baseline is explicit:

```json
{
  "schema_id": "galaxy.proof-verification-set.v1",
  "graph_ref": {
    "graph_id": "leanproofs",
    "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "items": []
}
```

A non-empty item names one graph node and candidate digest, then embeds an
opaque exact receipt as bounded base64 bytes with its media type, SHA-256, and
versioned adapter identifier. Parsing that envelope establishes byte integrity
only. It does **not** trust self-described `accepted`, `sorry_free`, verifier,
toolchain, or solution fields. Before storage, an allowlisted server adapter
must authenticate or replay the exact receipt and bind its derived subject to
the graph ID/hash, node, repository declaration and commit, candidate digest,
toolchain, and mathlib revision. The candidate digest must equal the
adapter-derived solution digest, and baseline evidence must be accepted and
sorry-free.

Exactly one receipt adapter is enabled: `proofs-blah-dev` version `1`, which
authenticates signed proofs.blah.dev verification reports (see
[proofs.blah.dev signed reports](#proofsblahdev-signed-reports)). A non-empty set
can be registered only when every item uses that adapter and passes it; any
other adapter, including the `hyades` placeholder, fails closed. Explicit empty
sets remain valid. Current LeanProofs categories, formal bindings,
repository-level Rosetta receipts, and Prove2Me provider status still do not
prove each conceptual target. Another adapter can be enabled only by a later
migration that ships its own authenticated/replay implementation.

Registering a non-empty set records baseline evidence only. Mission activation
still accepts only an explicit empty baseline, so no inherited node is marked
verified at activation yet.

Direct `POST /api/eln/proof-workspaces` requests fail closed. Existing
workspaces, their reads, and their append-only transition history remain
available; new workspaces are created only inside the atomic mission activation
transaction.

Selecting or downloading a mission draft creates no graph registration,
workspace, frontier, claim, run, HAM task, or verification. Mission activation
creates only the exact mission structure, workspace, and frontier snapshot;
claims, runs, HAM materialization, and verification remain later explicit
operations.

Public requests use the existing `/api/eln` proxy. Every authenticated principal
has the same proof-work API authority throughout its tenant; legacy scope names,
human roles, and agent classes do not gate reads or transitions. Tenant isolation
still applies. Every mutation also requires a fresh NIP-98 event whose `u`,
`method`, and `payload` tags bind the signature to the exact request. A browser
session does not replace this request signature.

Nostr authentication identifies the requester; it does not make that requester
a proof verifier. Public generic transitions therefore reject `proof.verify` and
`proof.reject`. Accepted proof truth may enter only through the dedicated
trusted-verifier boundary described below. The separate `proof.override`
transition remains restricted to the tenant owner and is visibly distinct from
machine verification.

## Register a workspace

`POST /api/eln/proof-workspaces`

```json
{
  "workspace_id": "vortex-proof-v1",
  "graph_ref": {
    "graph_id": "vortex-proof-v1",
    "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "node_ids": ["derive-helicity", "vortex-corollary"],
  "idempotency_key": "register:vortex-proof-v1:aaaaaaaaaaaa"
}
```

Registration returns an empty `galaxy.proof-work-state.v1` document at version
1. Reusing the same idempotency key with byte-equivalent semantic input returns
the existing state with `replayed: true`; conflicting reuse returns HTTP 409.

The referenced immutable graph must already be registered, must have kind
`campaign` or `mission`, and `node_ids` must equal its complete target set.
Selecting a smaller prerequisite closure requires registering that closure as a
distinct mission artifact first. Legacy workspace rows are preserved by the
database migration, but they do not become structural authority and cannot
resolve proof references until their original DAG bytes are registered.

Discover explicitly created workspaces for one exact graph with:

`GET /api/eln/proof-workspaces?graph_id={graphId}&content_sha256={sha256}&limit=50&offset=0`

Callers must choose one returned workspace; Galaxy never merges multiple mutable
overlays implicitly.

Only nodes with at least one transition appear in `items`; a missing graph node
has the version-zero state shown below and has not been silently claimed:

```json
{
  "schema_id": "galaxy.proof-work-state.v1",
  "workspace_id": "vortex-proof-v1",
  "graph_ref": {
    "graph_id": "vortex-proof-v1",
    "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "version": 1,
  "updated_at": "2026-09-13T12:00:00+00:00",
  "items": []
}
```

A materialized item has this stable shape:

```json
{
  "node_id": "derive-helicity",
  "version": 1,
  "work": {
    "status": "claimed",
    "claim": {
      "claim_id": "server-generated-uuid",
      "nostr_pubkey": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "claimed_at": "2026-09-13T12:00:00Z",
      "expires_at": "2026-09-13T12:15:00Z"
    },
    "hyades": null,
    "blocker": "",
    "task_id": "",
    "linked_task_count": 0
  },
  "proof": {
    "status": "open",
    "candidate_sha256": null,
    "candidate_provenance": null,
    "candidate_authority": null,
    "candidate_submitted_at": null,
    "attestation": null,
    "verification": null,
    "override": null
  },
  "external": {}
}
```

## Read current state

`GET /api/eln/proof-workspaces/{workspaceId}?graph_id={graphId}&content_sha256={sha256}`

Both graph reference fields are mandatory. A mismatch returns HTTP 409 rather
than serving state for the wrong immutable graph.

## Append a transition

`POST /api/eln/proof-workspaces/{workspaceId}/transitions`

```json
{
  "graph_ref": {
    "graph_id": "vortex-proof-v1",
    "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "node_id": "derive-helicity",
  "expected_version": 1,
  "expected_item_version": 0,
  "transition": {
    "type": "claim.acquire",
    "payload": { "lease_seconds": 900 }
  },
  "idempotency_key": "claim:derive-helicity:request-1"
}
```

`expected_version` is the workspace version. `expected_item_version` is zero
for a node without prior state and otherwise matches that item's current
version. The workspace and item are locked and checked in one transaction.
Stale versions return HTTP 409. A successful transition increments both
versions, updates the current item snapshot, and appends an immutable audit row.

Supported transition types:

- `claim.acquire`: `lease_seconds` must be 60-86400. Galaxy supplies the claim
  ID, signer public key, claim time, and expiry. An unexpired foreign claim wins;
  only the existing owner can renew a running node. Claims require a persisted
  mission-activation frontier row; legacy workspaces without one fail closed.
- `claim.release`: only the Nostr identity that owns the claim may release it,
  and running work must first leave the running state.
- `work.set`: sets `idle`, `running`, `submitted`, `blocked`, or `closed` work.
  Running work requires a bounded Hyades workflow/run/status object. An active
  claim prevents other identities from updating the work state.
- `proof.candidate`: records one lowercase SHA-256 candidate digest. An active
  claim prevents other identities from replacing the candidate. Optional exact
  commit/toolchain/mathlib provenance supports importing an existing Lean proof.
- `proof.attest`: records an external claim and evidence digest without
  presenting it as machine verification or releasing dependent nodes.
- `proof.verify` and `proof.reject`: reserved internal transition types. The
  public generic transition endpoint rejects both; callers cannot establish
  proof truth by submitting verification fields.
- `proof.supersede`: retires the current candidate or verification before a new
  candidate is recorded. This is administrative lifecycle authority, not
  verification authority.
- `proof.override`: the tenant owner deliberately accepts the current candidate
  with a mandatory reason. It releases dependents but remains visibly distinct
  from machine verification.
- `external.set`: records bounded, non-secret `rosetta` or `prove2me` status.
- `coordination.task.bind`: reserved to the dedicated server reconciliation
  endpoint. The generic `/api/eln` transition path rejects it.

The transition payloads are:

```json
{ "type": "claim.acquire", "payload": { "lease_seconds": 900 } }
{ "type": "claim.release", "payload": {} }
{ "type": "work.set", "payload": {
  "status": "running",
  "hyades": { "workflow_id": "workflow-1", "run_id": "run-1", "status": "running" },
  "blocker": "",
  "task_id": "ham-task-id-if-linked",
  "linked_task_count": 1
} }
{ "type": "proof.candidate", "payload": {
  "candidate_sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "provenance": {
    "source_commit": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    "lean_toolchain": "leanprover/lean4:v4.30.0",
    "mathlib_revision": "ffffffffffffffffffffffffffffffffffffffff"
  }
} }
{ "type": "proof.attest", "payload": {
  "statement": "Independent source attests this candidate.",
  "evidence_sha256": "1111111111111111111111111111111111111111111111111111111111111111"
} }
{ "type": "proof.supersede", "payload": {} }
{ "type": "proof.override", "payload": {
  "reason": "Accepted for this campaign after independent review.",
  "evidence_sha256": "1111111111111111111111111111111111111111111111111111111111111111"
} }
{ "type": "external.set", "payload": {
  "system": "rosetta",
  "value": { "submission_id": "submission-1", "status": "pending_review" }
} }
```

The bounded Tasks-plugin mutation tool `proof.claim` wraps only these two claim
transitions for agents and MCP clients. It requires fresh NIP-98 identity and
both workspace/item versions. `action: "acquire"` is also the current owner's
lease-extension operation and rotates the server-generated claim ID; there is
no distinct renew transition. The tool does not claim a HAM task, launch
Hyades, or establish proof status.

Hyades status is one of `pending`, `queued`, `running`, `verifying`,
`completed`, `failed`, or `cancelled`. Every transition, transition payload,
Hyades reference, verification receipt, candidate provenance object, and
external status object uses an exact field allowlist; unknown fields are
rejected before the append-only ledger write. External status accepts only
bounded identifiers, `status`, `updated_at`, `message`, and
`evidence_sha256`. Sensitive keys such as `api_key`, `password`,
`authorization`, access/refresh tokens, credentials, private keys, secrets, and
raw log/output fields are also rejected at any depth. The complete transition
is capped at 32 KiB; an external value is capped at 8 KiB.

The public proxy reads a proof mutation stream once through a hard 2 MiB cap.
Those bounded bytes are then used for the NIP-98 payload hash, transition
dispatch, and upstream body; a missing or false `Content-Length` cannot bypass
the measured limit.

## Pull Hyades task bindings

`POST /api/proof-workspaces/{workspaceId}/hyades-task-bindings/reconcile`

This is an explicit, signed action; loading or rendering a graph never invokes
it. The browser supplies only the exact graph reference, expected workspace
version, and an idempotency key. Galaxy uses a fixed server-configured Hyades
read endpoint and credential, requires a complete
`galaxy.hyades-proof-task-bindings.v1` projection, and exact-GETs every named
HAM task through Galaxy's existing tenant-bound read client before writing.
Galaxy recomputes Hyades' ordinal-sorted, newline-terminated canonical public
projection digest and rejects a mismatch. It also requires the raw HAM
`audit_contract_sha256` to equal the projected materialized-assignment digest,
recomputes that assignment digest, and corroborates its strict v3 program,
packet, directive, graph-reference, and proof-resource fields.
Each HAM task must expose exactly one unredacted `observe` resource equal to
`proof-packet:sha256:{graphHash}/{programId}/{packetId}`.

One internal bulk operation locks the exact tenant workspace, checks every node
against its authoritative `node_ids`, and preflights every workspace/item CAS,
dispatch sequence, replay, and transition before it writes anything. The
complete projection commits or rolls back as one transaction; each applied
binding receives a deterministic ledger idempotency key and consecutive
workspace version. It may update only `work.task_id`, `work.linked_task_count`, and
`external.hyades_task_binding`. Work status, claim, run, blocker, every proof
field, and unrelated external state remain byte-for-byte unchanged. Per-node
`dispatch_sequence` must increase; an identical sequence and binding is a
no-op, while an older sequence or same sequence with different provenance is a
conflict. Hyades `state` is materialization provenance and is exactly
`dispatched` or `reused`, not Galaxy work lifecycle state. Successful changes
remain in the immutable transition ledger.

The server transport is configured with `HYADES_PROOF_TASK_BINDINGS_API_INTERNAL` and
`GALAXY_DEPLOY_HYADES_PROOF_TASK_BINDINGS_BEARER_TOKEN` (or the local
`HYADES_PROOF_TASK_BINDINGS_BEARER_TOKEN` fallback). Galaxy appends the encoded
graph ID and exact content hash to the fixed server-owned base as
`/ham/proof-task-bindings/{programId}?content_sha256={hash}`; callers cannot
select a destination, tenant, program, packet, or task.

## Trusted proof verification boundary

`POST /api/eln/proof-workspaces/{workspaceId}/nodes/{nodeId}/verify`

The dedicated endpoint accepts only the exact graph, candidate, concurrency,
replay, and opaque receipt material below. It rejects caller-authored outcomes,
solution hashes, verifier identities, proof statuses, and timestamps.

```json
{
  "schema_id": "galaxy.trusted-proof-verification-request.v1",
  "graph_ref": {
    "graph_id": "vortex-proof-v1",
    "content_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "node_id": "vortex-corollary",
  "candidate_sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "expected_workspace_version": 4,
  "expected_item_version": 2,
  "idempotency_key": "verify:vortex-corollary:cccccccccccc",
  "receipt": {
    "adapter_id": "proofs-blah-dev",
    "adapter_version": "1",
    "media_type": "application/vnd.proofs-blah-dev.verification-report+json",
    "content_encoding": "base64",
    "content_sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    "content_base64": "ZXhhY3Qgb3BhcXVlIHJlY2VpcHQgYnl0ZXM="
  }
}
```

The proxy and API both enforce the same 2 MiB exact-body limit. Only an enabled,
code-owned adapter can turn receipt bytes into accepted evidence. Today that is
`proofs-blah-dev@1`. The `hyades@1` placeholder is still disabled, so a Hyades
receipt returns HTTP 503 before any database access.

For an enabled adapter, the API first reads the activated mission and derives
the exact subject. It takes revision provenance from the passive source graph
and the declaration binding from the mission target. It then runs the adapter.
A receipt that fails authentication or binding returns HTTP 422 and nothing is
written.

Only after that does the API open a separate database connection
(`GB_PROOF_VERIFIER_DATABASE_URL`) and run `SET LOCAL ROLE gb_proof_verifier`.
In one transaction it locks the workspace and item and re-checks both versions.
It stores the exact receipt bytes and calls the sealed registrar, which
re-derives the subject under lock. It then appends the `proof.verify`
transition. That transition's `receipt_id` is the ledger row ID, and its
`method` is the adapter's method (`signed-report` for proofs.blah.dev).
Replaying the same idempotency key and exact bytes returns the stored state with
`replayed: true`. When `GB_PROOF_VERIFIER_DATABASE_URL` is unset, the endpoint
returns HTTP 503 and performs no database access.

### Verifier authority

Migration `049_proofs_blah_dev_verifier_authority` installs the authority that
migration 029 deferred:

- `gb_proof_verifier` is a NOLOGIN role without superuser, BYPASSRLS, CREATEROLE,
  CREATEDB, or replication rights. It has EXECUTE on
  `gb_record_accepted_proof_verification`. Beyond that, it has only
  SELECT/UPDATE on `gb_proof_workspaces` and `gb_proof_work_items`,
  SELECT/INSERT on `gb_proof_work_transitions` and `gb_artifacts`, and SELECT on
  `gb_proof_work_verifications`. It cannot insert into the ledger directly, and
  the owner-only insert guard and append-only triggers are unchanged. Tenant RLS
  still applies.
- A separate LOGIN identity is provisioned outside migrations and granted
  membership. Locally, set `LOCAL_VERIFIER_DATABASE_ROLE` and
  `LOCAL_VERIFIER_DATABASE_PASSWORD` for `provision-local-runtime-roles.mjs`.
  That login is NOINHERIT, so it gains the authority only by explicit
  `SET ROLE`.
- The ordinary API runtime role is never a member. The migration revokes
  membership from every runtime role it recognizes. API startup refuses to run
  if the runtime role can assume `gb_proof_verifier`. When a verifier URL is
  configured, startup also checks the verifier side. The login must differ from
  the runtime role, must not bypass RLS, and must be a member. After
  `SET ROLE`, the authority must have exactly the privileges listed above.
  `pnpm db:verify` reports these properties under
  `trustedProofVerificationBoundary`.

The CHECK constraints on the ledger and on verification-set records list the
allowed providers explicitly: `hyades`/`hyades-run`, `lean-replay`/`lean-replay`,
and `proofs-blah-dev`/`signed-report`. `hyades_run` and `provider_run_ref` must
be NULL for `proofs-blah-dev`. Another provider, such as Prove2Me, needs its own
migration and its own authenticated adapter.

Legacy self-asserted `verified` state does not release dependents and is
projected as blocked until explicitly superseded.

### proofs.blah.dev signed reports

The receipt bytes are the exact JSON body returned by
`GET https://proofs.blah.dev/api/research/v1/verification-reports/{id}`, with
the keys `report_id`, `report`, `report_hash`, `attestation`, and `created_at`.
The media type is `application/vnd.proofs-blah-dev.verification-report+json`, and
a receipt may contain at most 256 KiB. The adapter
(`services/galaxy-brain-api/proofs_blah_dev_adapter.py`) performs no network
access and checks the following:

- `report_hash` equals `sha256:` plus the hex SHA-256 of the canonical report
  JSON. Canonical JSON is JavaScript `JSON.stringify` with object keys sorted
  recursively by UTF-16 code units and no whitespace. JavaScript number
  formatting is reproduced. The adapter rejects any number it cannot reproduce
  exactly, any integer outside the JavaScript safe range, integer-like object
  keys, unpaired surrogates, and duplicate keys.
- `attestation.signature` is a canonical base64url Ed25519 signature over the
  raw 32-byte digest. It must verify under the key named by
  `attestation.key_id`. Keys are pinned in the adapter source and never
  fetched. The only pinned key is `ed25519:4d09a2be99b9a36d`, and every key ID
  must equal `ed25519:` plus the first 16 hex digits of the SHA-256 of the key's
  SPKI DER. When the signed `report.attestation_key_id` is present, it must name
  the same key.
- Signed report fields: `schema_version` is `proofs-verification-report/v1`,
  `outcome` is `verified`, `intent` is `prove`, and `rejection_code` is
  present and null. `axioms` is a subset of `propext`, `Classical.choice`, and
  `Quot.sound`, so `sorryAx` or any other axiom is rejected.
  `theorem_revision_id` equals `input_manifest.theorem_revision_id`.
- The Galaxy candidate equals `report.source_hash` without its `sha256:`
  prefix. That digest covers the exact submitted `Solution.lean` bytes.
- `lean_toolchain` comes from `report.formal_environment.lean_toolchain`,
  `mathlib_revision` from `report.formal_environment.mathlib_commit`, and
  `verified_at` from `report.finished_at`. All three must match the graph
  revision through the shared binder.
- The subject binding fails closed. `report.origin` must be present and
  non-null. Its `repository`, `revision`, and `declaration` become
  `source_repository`, `source_commit`, and `subject_declaration_ids`. They must
  equal the graph node's repository, commit, and exact single-declaration
  binding. When `origin.key` is present, it must equal
  `lean:{repository}@{revision}/{declaration}`.

What this does **not** establish: Galaxy does not re-run Lean. It trusts the
kernel check that proofs.blah.dev performed, as attested by the pinned
signature. `report.origin` is the producer's recorded provenance. It is signed,
but it is not kernel-checked. Reports without an origin, including every
report issued before proofs.blah.dev recorded origins, cannot be bound to a
Galaxy subject and are rejected.

The registered `implementation_sha256` is the SHA-256 of the adapter source
with LF line endings. Any change to that file requires a new adapter version
and a migration that registers it. A test enforces this.

This first trusted boundary establishes accepted, sorry-free proof only. A
trusted rejection result is intentionally unsupported in this slice; a later
adapter must add a separate typed accepted/rejected result contract rather than
weakening the accepted-proof binder.

## Read the transition ledger

`GET /api/eln/proof-workspaces/{workspaceId}/transitions?graph_id={graphId}&content_sha256={sha256}&limit=100`

The ledger contains the normalized transition, before/after snapshots, exact
workspace and item versions, Nostr actor public key, and server timestamp.
Database triggers reject update or deletion of transition rows.

Clients should handle `401` (missing or invalid fresh signature), `409` (stale
version, graph mismatch, lease, or idempotency conflict), `413` (body over 2
MiB), and `422` (invalid contract or a transition-specific invariant such as a
non-owner override).
