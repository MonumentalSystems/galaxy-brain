# Galaxy Brain

Galaxy Brain is an experimental, self-hosted research workspace: an infinite writable canvas for notes, files, experiments, structured views, and optional agent memory.

> [!IMPORTANT]
> This release is an invite-only alpha for a small trusted group. The original owner can create one-time links that provision separate personal tenants; server-backed ELN records and browser notebook caches are tenant-scoped. Public registration and collaborative cross-tenant sharing remain disabled.

## Repository contents

- `app/`, `components/`, `lib/`: Next.js 15 application
- `services/galaxy-brain-api`: structured ELN and datasource API
- `services/markitdown-server`: document-to-Markdown conversion
- `docker-compose.yml`: hardened single-host deployment
- `HAM_PLUGIN.md`: optional HAM HTTP integration contract

HAM is not vendored in this repository. A compatible service may be connected through the authenticated server-side proxy.

## Secure self-hosting

Prerequisites: Docker with Compose.

1. Copy `.env.example` to `.env`.
2. Replace every `replace-with-...` value with a different long random secret.
3. Apply the ordered database migrations and start the stack. For the bundled
   local-development database, enable its explicit profile:

   ```console
   docker compose -f docker-compose.yml -f docker-compose.local-db.yml \
     --profile local-db up --build
   ```

   The local override runs migrations as `POSTGRES_USER`, then provisions the
   distinct non-owner web and API roles configured in `.env`. The API uses the
   same fail-closed RLS role checks as production; there is no single-role
   development bypass. If an old local volume predates these settings, create a
   new disposable local database volume rather than weakening the runtime role.

4. Open `http://localhost:3001/register`, enter the configured invite code, and create the original owner. Public registration then closes. The original owner can create seven-day personal workspace links from **Sign-in security**; an invited person redeems the link with either a passkey or a NIP-07 Nostr signer.

Set `AUTH_ORIGIN` to the exact public origin and `WEBAUTHN_RP_ID` to its hostname before adding passkeys. Nostr sign-in is exposed on both the normal login and invitation flows, and people can add passkeys or NIP-07 Nostr keys from **Sign-in security** after signing in. The same verified Nostr public key can identify one human across Galaxy Brain, HAM, and Hyades. Galaxy Brain stores only public credential material and invitation hashes; never paste an `nsec` into the application.

## Connect an app

Set one exact `CONNECT_CALLBACK_URL`, then send the user to
`/connect?callback=...&state=...`. The user signs in with Nostr and presses
**Connect**. The app exchanges the one-time code at
`POST /api/connect/exchange` using any active Galaxy API key from the same
tenant. There are no scopes or permission screens. The older
`/integrations/generous/connect` and `/api/integrations/generous/connect/*`
paths remain compatibility aliases.

Password recovery uses `SMTP_URL` and `AUTH_EMAIL_FROM` when configured. If SMTP is unavailable, the host administrator can issue a 30-minute, one-time reset link from the web container:

```console
pnpm auth:issue-reset owner@example.com
```

The command requires `DATABASE_URL` and `AUTH_ORIGIN` in its environment. Treat the printed URL as a secret and send it to the owner through a trusted channel.

Production uses a dedicated PostgreSQL/PGVector database with separate
migration, web-runtime, and API-runtime roles. Runtime processes verify the
migration ledger and never perform schema DDL. See
[`docs/NEON_TO_POSTGRES_MIGRATION.md`](docs/NEON_TO_POSTGRES_MIGRATION.md) for
the auth-preserving Neon consolidation and rollback procedure.

For Coolify deployments, store credential values in the `GALAXY_DEPLOY_*`
variables listed in `.env.example`. Keep them as ordinary editable secrets,
literal, available at runtime, and unavailable during build. Compose projects
each source into the runtime name expected by its container and retains the
legacy name only as a rollout fallback. Rotate the stable source variable and
redeploy; do not lock the source variable or create numbered replacements.

Only the Next.js web application is published by the default Compose configuration. The production PostgreSQL resource, ELN API, Docling Serve, and MarkItDown stay on private networks. Docling uses the digest-pinned CPU image `v1.35.0`, a 500-page ceiling, and a deploy-owned API key; its endpoint and credential are never projected into the browser container. The Galaxy API does not wait for Docling health: an outage produces a durable primary failure receipt and eligible PDFs continue through the existing MarkItDown fallback. The internal APIs also require shared proxy tokens; browser clients cannot supply identity headers directly.

Set `GALAXY_DEPLOY_DOCLING_API_KEY` as a runtime-only production secret before deployment. Compose projects it into both private containers under their service-specific names, but does not publish the Docling port or make Galaxy API startup depend on Docling readiness. Operators can inspect `GET http://docling:5001/ready` from the private Compose network; the container healthcheck uses that route. Keep the checked-in 25 MiB input, 16 MiB response, 105-second conversion, and 500-page limits aligned if host-level limits are changed.

The baseline CPU image does not contain Docling's optional `code_formula` model, so Galaxy explicitly disables formula OCR enrichment and does not permit runtime model downloads or a writable model cache. Formula nodes already emitted by the converter remain structural evidence, including the bounded `orig` fallback when `text` is empty. Enabling formula OCR later requires a separately versioned and digest-pinned image with that model preloaded.

Filesystem datasources are disabled by default and never use a deployment-global path allowlist. To enable them for a tenant, mount the intended data directory into `galaxy-brain-api` and set `GB_DATASOURCE_ALLOWED_ROOTS_BY_TENANT` to a JSON object mapping that Galaxy tenant UUID to its absolute container paths, for example `{"00000000-0000-4000-8000-000000000001":["/data/tenant"]}`. Tenants absent from the map cannot list, sync, or import filesystem data. Relative paths and `/` are rejected.

## Local frontend development

Prerequisites: Node.js 22.13 or later, pnpm 10.33.2, and a PostgreSQL database configured through `DATABASE_URL`.

Galaxy Brain uses Nostr public keys as the external identity for humans and
agents. A Nostr-authenticated tenant owner registers an independently revocable
agent public key with `POST /api/agents`. The
agent signs each `/api/eln/*` request with a NIP-98 kind-27235 event that binds
the exact URL, HTTP method, and request-body hash. Reusing an event is rejected.
Disable an agent with `DELETE /api/agents/{pubkey}`. The UUID attached to the
record is an internal relational surrogate and is never an agent credential or
public identity.

Once connected, Nostr identities and API keys can use the whole tenant. Legacy
scope arrays remain in the database as `*` for migration compatibility but are
not an authorization boundary. Existing `gbk_` agent tokens are revoked by
migration 011 and are no longer accepted.

See [`llms.txt`](llms.txt) for the agent key bootstrap and NIP-98 request
contract.

Human sessions are bound to one active tenant. Use `GET /api/tenants` to list memberships and same-origin `POST /api/tenants/{tenantId}/select` to switch the current and remembered default tenant.

Bounded generative surfaces use the versioned `gb.surface.v1` contract and the
`generous.a2ui` catalog. The canonical, digest-pinned manifest is checked in at
`services/galaxy-brain-api/contracts/gb.surface.v1.json`; authenticated readers
can discover the same manifest through `GET /api/eln/surfaces/contract`.
Agents with `eln:write` may create a draft with
`POST /api/eln/surfaces`, update a draft with `PATCH /api/eln/surfaces/{id}`,
and explicitly promote it with `POST /api/eln/surfaces/{id}/promote`. Every
mutation requires an idempotency key; updates and promotions also require the
current base version. Patch updates accept bounded RFC 6902 `test`, `add`,
`remove`, and `replace` operations and also
require the exact base content hash; the fully patched surface is revalidated
against `gb.surface.v1` before storage. Indexed component and binding mutations
must be preceded by a successful `test` of that element's stable `id`; `move`
and `copy` are rejected. Promotions may include the same hash as
an additional optimistic precondition. Galaxy Brain stores an immutable revision for each
accepted mutation. The contract accepts only the approved presentation catalog
and rejects arbitrary JSX, executable props, and undeclared network bindings.
Each surface and revision records the exact schema digest, catalog digest, and
Generous renderer version. Migration 006 carries the new-table grants forward
for an existing restricted API role that already has full DML on
`gb_node_revisions`; API startup also fails closed if any required tenant-table
privilege is missing.

`GET /api/eln/surfaces/{id}/resolve` materializes approved experiment and
hypothesis bindings as an ephemeral, permission-filtered projection. It never
changes the stored surface definition. Source kinds, query fields, aggregate
shapes, limits, and target props are allowlisted; the resulting surface is
fully revalidated after every binding. An unavailable or incompatible source
is reported in the binding ledger and leaves the last valid presentation in
place. HAM task bindings remain unavailable until a separately authorized
external task projection is connected.

```console
pnpm install --frozen-lockfile
pnpm dev
```

The optional backend services can be run independently. Server-only environment variables are documented in `.env.example`; service URLs and credentials are not exposed through `NEXT_PUBLIC_*` variables.

### Authenticated HAM search

The main HAM search modal, explorer search, and connected-search adapter call
the authenticated `/api/ham/search` BFF. Configure `HAM_API_INTERNAL`, the
server-only `HAM_API_BEARER_TOKEN`, and one exact `HAM_SEARCH_GALAXY_TENANT_ID`;
never expose the bearer to the browser. The BFF permits only that signed-in
Galaxy tenant, maps it to `X-GB-User-ID`, and permits only
HAM's `/search`, `/retrieve/multihop/scoped`, and
`/retrieve/temporal/scoped` read operations. Browser requests cannot provide
HAM paths, scopes, or identity headers.

The deployment-global bearer is never inherited by newly invited tenants.
Tenants other than `HAM_SEARCH_GALAXY_TENANT_ID` receive `403`, and a missing or
invalid binding returns `503`. Supporting another personal tenant requires a
separately reviewed Galaxy-to-HAM tenant mapping and dedicated HAM authority;
sharing a Nostr public identity does not grant that authority by itself.

### HAM memory workspace

Galaxy can open one exact HAM memory with a bounded projection of its incoming
and outgoing typed links and immutable `supersedes` / `superseded_by` lineage.
Adjacent memories are hydrated only through fixed numeric-ID routes, and opaque
HAM metadata never reaches the browser. Exact reads reuse `HAM_API_INTERNAL`,
`HAM_API_BEARER_TOKEN`, and the exact `HAM_SEARCH_GALAXY_TENANT_ID` binding.

Memory edits create a new HAM version; Galaxy does not patch or hard-delete HAM
records. Interactive changes reuse the authenticated Galaxy session and the
existing server-side HAM connection; no second write token, mutation flag,
private key, or HAM bearer enters the browser. The browser can change only
content, presentation, and the allowlisted
project/repository/task/sequence/scope fields. Galaxy preserves opaque upstream
metadata server-side while stripping old lifecycle markers before HAM creates
the replacement lineage. Omitting unchanged cues lets HAM inherit their
authored provenance on the replacement.

Atlas also loads a relations-only HAM overlay for at most 24 latest HAM memory
references that are already visible and independently resolved for the current
tenant. The authenticated BFF calls only HAM's fixed exact-memory and
exact-memory-links routes with the deployment-owned credential. It returns no
memory bodies, snippets, metadata, or adjacent synthetic nodes: only active
typed links and lifecycle edges whose two endpoints are both in the resolved
request set. Results are explicitly follow-latest and partial, including
distinct client-scope and upstream-provider truncation plus per-reference
unavailability.

The overlay is requested only after durable Atlas references finish hydration,
is projected as `asserted` HAM provenance, and remains transient render state.
It is never written into, shared with, or mutated through a canvas snapshot;
both fully refreshed and committed-but-refresh-failed HAM mutations invalidate
the overlay. A pure adapter is available for a future production Field host,
but this repository still has no production Field composition point. Until one
is selected, the development Semantic Field preview must not start live HAM
requests or be described as production relation integration.

### Shared HAM task queue

The authenticated tasks page is a bounded projection of HAM's coordination
ledger. HAM projects label related topics; they do not grant observer,
publisher, or executor roles. Every authenticated HAM principal may coordinate
through the task ledger.

Galaxy Brain uses separate server-only read and write transport credentials so
its own product policy can keep task creation disabled by default. Configure
HAM_TASK_API_INTERNAL, HAM_TASK_PROJECT_REF, HAM_TASK_READ_BEARER_TOKEN, and
HAM_TASK_GALAXY_TENANT_ID for reads. Set HAM_TASK_MUTATIONS=enabled and provide
HAM_TASK_WRITE_BEARER_TOKEN only when the Galaxy owner explicitly enables task
posting. These credentials authenticate Galaxy Brain to HAM; project membership
does not authorize them.

Before data reaches the browser, Galaxy Brain removes raw evidence payloads,
credential-like resource keys, and private machine, host, address, cluster, path,
and volume details. HAM remains the canonical coordination ledger.

A HAM task claim or run record does not authorize execution. Hyades alone
decides whether a workflow may execute, including its resources, actions,
approval state, validity window, and revocation. GitHub independently decides
repository access. Galaxy Brain does not infer either permission from a project,
task status, public key, or HAM role.

Before enabling the page in a live deployment, verify that reads are
topology-redacted, mutations follow Galaxy policy, Hyades rejects execution
without a valid capability, and GitHub rejects repository operations without
GitHub authorization.

### Saved task-plan run adapter

The server exposes a narrow adapter for one exact saved `gb.task-plan.v1`
revision: `POST /api/tasks/{taskId}/runs` dispatches it, `GET
/api/tasks/{taskId}/runs/{runId}` returns bounded status, and `POST
/api/tasks/{taskId}/runs/{runId}/cancel` requests cancellation. This slice adds
no browser UI. It never returns Hyades authority, binding, workspace,
transitions, evaluations, artifacts, output, raw errors, or the embedded plan.

Configure `HYADES_TASK_PLAN_API_INTERNAL`, `HYADES_TASK_PLAN_TENANT`,
`HYADES_TASK_PLAN_HAM_PROJECT`, `TASK_PLAN_EXECUTOR_GALAXY_TENANT_ID`, and the
server-only `HYADES_TASK_PLAN_OPERATOR_BEARER_TOKEN`. Hyades currently requires
a platform-admin bearer for all three upstream routes; deploy with its keyring
enabled so missing keys cannot inherit open-admin behavior. Only after the
saved-plan dispatch route and bound executor are deployed should an owner set
`TASK_PLAN_RUN_MUTATIONS=enabled`. Status remains read-only; dispatch and cancel
also require same-origin requests and recent authentication.

Galaxy re-reads the HAM task and saved plan to require the signed-in owner or
admin to be both the task requester and plan author. Dispatch is fenced by the
exact task version, plan version, content hash, independently computed canonical
spec hash, and a user-namespaced idempotency key. Before contacting Hyades,
Galaxy atomically reserves an append-only dispatch intent while that revision is
current. A retry replays the immutable intent and exact revision, so a lost HTTP
response cannot strand a Hyades run or turn a later plan edit into a different
execution request. For status and cancellation,
the immutable Hyades wake/dispatch ledger is the revision provenance: Galaxy
validates its trigger, configured tenant/project, task, embedded canonical spec,
version, content hash, spec hash, and expected task version before returning a
small projection. A later saved plan revision does not make the earlier run
inaccessible. Cancellation is idempotent upstream but not necessarily
immediate; the returned phase is the authoritative bounded status.

### Proof campaign launcher

Galaxy Brain owners and admins can use the proof-campaign launcher on `/tasks` to inspect a mathematical packet DAG, load a converter-produced `ham.audit-program.v3` manifest, register its immutable controller state, and explicitly dispatch the exact current frontier. The launcher does not compile an arbitrary Galaxy DAG into HAM's audit-specific packet contract and it never publishes its browser-derived frontier directly. The three controller transitions remain separate in the UI: preview is pure, registration is durable but non-executing, and dispatch requires a second confirmation fenced by the current directive SHA-256. HAM remains the canonical program/task/audit ledger; Hyades owns dispatch and execution. The fleet/operator surface lives outside Galaxy Brain and does not need a duplicate research-campaign UI.

A graph-bound v3 manifest may include `galaxy_proof_graph_ref` using `galaxy.proof-graph-ref.v1`. Its `graph_id` must equal the HAM `program_id`, and `content_sha256` must be the exact registered Galaxy DAG revision—not a digest of the converted HAM manifest. Galaxy keeps that source-graph reference separate from the local manifest projection's own digest, then uses the pinned source identity when matching Hyades-created tasks to `proof-packet:sha256:<content_sha256>/<program_id>/<packet_id>` resources. Legacy v3 manifests without this reference remain viewable through their legacy program-scoped resources. Generic human task creation cannot use the reserved `proof-packet:` namespace.

Configure `HYADES_PROGRAM_CONTROL_API_INTERNAL`, `HYADES_PROGRAM_TENANT`, `HYADES_PROGRAM_HAM_PROJECT`, `PROOF_CAMPAIGN_GALAXY_TENANT_ID`, and the server-only `HYADES_PROGRAM_OPERATOR_BEARER_TOKEN`. The control URL may address Hyades on a private network, or a narrow service bridge that preserves only the allowlisted program routes. The browser cannot choose the Hyades tenant or HAM project, cannot submit controller directives, and never receives the operator credential. Galaxy Brain admits only `preview`, `register`, `status`, `registration`, and `dispatch`; arbitrary admin paths are not proxyable.

Live proof task reconciliation is a separate read path. Configure the fixed
`HYADES_PROOF_TASK_BINDINGS_API_INTERNAL` base and server-only
`HYADES_PROOF_TASK_BINDINGS_BEARER_TOKEN`. Galaxy derives the exact program/hash
route, verifies every returned task through its tenant-bound HAM reader, and
only then appends coordination bindings; graph reads never trigger this action.

Keep `PROOF_CAMPAIGN_MUTATIONS=disabled` until the following checks pass against a non-production HAM project:

1. The signed-in Galaxy tenant exactly matches `PROOF_CAMPAIGN_GALAXY_TENANT_ID`, and a member role receives `403` while an owner or admin can preview.
2. The dedicated operator credential reaches the configured Hyades tenant but is not present in browser bundles, responses, logs, or `NEXT_PUBLIC` variables.
3. Preview returns the authoritative program, progress, and directive hashes while creating no registration or task.
4. Registration is idempotent for the exact manifest and rejects a different manifest under the same program ID.
5. Dispatch with a stale directive hash returns `409`; dispatch with the exact hash materializes one idempotent HAM task per current frontier packet, carrying the exact active graph-bound proof-packet resource when `galaxy_proof_graph_ref` is present.
6. HAM task reads show those tasks, while agent claim/run/update still require independently registered agent Nostr identities and Hyades capabilities.

Hyades currently gates these routes with platform-admin authentication. Until it offers the narrower five-endpoint operator scope, use a dedicated key held only by this server path (or by the narrow service bridge), never a general human/session credential. Start with `lean-proof-harness-smoke-v1` in a sandbox project before dispatching `null-pair-intrinsic-projector-degree-v1`.

### Research atlas rollout

The authenticated `/workspace` entry point is the canonical research atlas.
The temporary `/atlas-v2` compatibility route redirects canonical `canvas`,
`placement`, and `ref` deep links to `/workspace`. A `ref` selects an object
that is already in the authorized projection or durable canvas; arbitrary exact
graph references remain on `/graph?ref=...`. The atlas projects
tenant-scoped workspace items plus authorization-filtered papers, ELN records,
HAM tasks, proof-packet references, and bounded Generous surfaces into the
canvas-harness runtime. The same resources remain available through an
accessible list view and their existing owning views. Moving or resizing an
authorized card creates or updates a separate
versioned placement record; the referenced resource content remains read-only
and stays in its owning service. Stale layout writes reload the authoritative
snapshot and require an explicit retry.
Phase 2 canvas snapshots are shared tenant/workspace reasoning state for
authenticated humans and agents. The creator is audit provenance, not an ACL;
canonical references and provenance remain visible throughout the tenant.
Removal tombstones, presentation edges, angle, z-order, display/collapse state,
and styles survive an authoritative reload.
The spatial and accessible list modes now belong to Atlas itself; legacy
`shell` and `view` query parameters no longer select the retired workspace
shell.

### arXiv paper review workbench

The authenticated `/papers` workbench searches the official arXiv Atom API,
stores descriptive metadata and immutable metadata revisions, and looks up the
paper's license through arXiv OAI metadata during import. An explicit **Save to
Galaxy** action sends only the selected paper and immutable revision identities;
the server derives the exact versioned arXiv PDF URL and may store those bytes as
a tenant-private durable research document. Stored private bytes remain behind
the authenticated, `private, no-store` reader and are not made public or
shareable by this operation.

That private research-copy path does not broaden the separate public download
proxy. Galaxy Brain transiently streams an unmodified PDF through `/download`
only when arXiv metadata declares CC BY, CC BY-SA, or CC0. Missing or other
license metadata is not treated as redistribution permission. This follows
arXiv's [API terms of use](https://info.arxiv.org/help/api/tou.html): descriptive
metadata may be stored, while serving paper content to others requires
permission from the copyright holder or a license that grants redistribution.
The bounded metadata client permits only one process-wide upstream request at a
time, a three-second minimum delay, a 20-result ceiling, and a 24-hour cache,
following the [arXiv API manual](https://info.arxiv.org/help/api/user-manual.html).
Multiple API replicas do not currently share a rate-limit ledger, so production
should run this metadata client as one replica or add a distributed limiter.

Highlights and comments use page-scoped text offsets plus an exact quote. Ink
uses normalized page coordinates. Every annotation records one review lens
(`proof`, `audit`, or `analysis`), one semantic role (`claim`, `evidence`, or
`note`), and bounded tags. Claims and supporting/refuting/context evidence are
canonical Galaxy records. Anchors are tied to the imported arXiv version and
may need explicit re-anchoring when a later paper version changes pagination or
text extraction.

Creating a document task or evidence subtask uses the existing HAM task-write
transport and therefore remains disabled unless `HAM_TASK_MUTATIONS=enabled`
and the tenant-bound write credential is configured. That server credential
enforces Galaxy Brain's own mutation policy; it is not a HAM project role. HAM
owns task lifecycle;
Galaxy stores only typed links from the paper, annotation, or claim to the HAM
task identifier and parent task identifier. Posting a task does not claim it,
assign an agent, or grant execution authority.

### Owner-only HAM identity administration

The settings/ham page registers Nostr public keys and creates organizational
projects. It no longer issues arbitrary agent identifiers, managed agent
secrets, or project task roles.

Configure HAM_ADMIN_API_INTERNAL, HAM_ADMIN_API_BEARER_TOKEN, and
HAM_ADMIN_TENANT_ID for the server-side bootstrap path. Bind that path to one
exact Galaxy tenant, internal human principal, and Nostr public key using
HAM_ADMIN_GALAXY_TENANT_ID, HAM_ADMIN_GALAXY_PRINCIPAL_ID, and
HAM_ADMIN_OWNER_NOSTR_PUBKEY. Access requires a recent Galaxy session created by
a signature from that exact Nostr key. Password and passkey recovery sessions
cannot mutate HAM principals.

The owner can register the active human key in HAM, register separately
revocable agent public keys, issue a simple tenant API key, and associate
principals with projects for navigation. Agent nsecs stay
on agent machines and never pass through Galaxy Brain. Removing project
membership does not revoke a key. Revoking a HAM principal has no effect on
Hyades or GitHub authority.

The bootstrap bearer remains server-side and separate from HAM search and task
transport credentials. It is a migration and administration mechanism, not the
canonical identity exposed to users.

## Validation

```console
pnpm lint
pnpm typecheck
pnpm test:notebook-editor
pnpm test:auth
pnpm test:tasks
pnpm test:ham-admin
pnpm build
pnpm build:turbo # Next 15.5 Turbopack production-build compatibility check
```

## Security model and limitations

- The release is invite-only and designed for a small trusted group on a private host. Each invited person receives a separate personal tenant; there is no public signup or shared-workspace collaboration flow.
- Canvas and notebook content is tenant-scoped in the current browser profile. It is not yet a cross-device document-sync service; server-backed ELN records and revisions remain tenant-isolated.
- The bootstrap invite code and proxy tokens are deployment secrets, not user passwords. Personal invitation links are random, one-time, expire after seven days, and are stored only as hashes.
- Legacy HAM search traffic uses `HAM_API_BEARER_TOKEN`. Task reads and explicitly enabled mutations use separate server-only transport credentials. They express Galaxy Brain's product boundary, not HAM project roles. The optional owner administration surface uses another server-only bootstrap credential and requires a recent session signed by the configured Nostr owner key.
- Document conversion handles untrusted formats. Keep the converter internal and apply host-level container limits appropriate to your deployment.
- Public sharing and real-time collaboration remain product goals, not production-ready authorization guarantees.

See [SECURITY.md](SECURITY.md) for reporting and deployment guidance.

## Project documents

- [docs/GALAXY_V2_IMPLEMENTATION_PRD.md](docs/GALAXY_V2_IMPLEMENTATION_PRD.md): canonical v2 product requirements and atomic implementation roadmap
- [PRD.md](PRD.md): original product requirements and vision
- [ARCHITECTURE.md](ARCHITECTURE.md): current architecture
- [PLUGIN_ARCHITECTURE.md](PLUGIN_ARCHITECTURE.md): extension boundaries
- [docs/CANVAS_HARNESS_INTEGRATION_PLAN.md](docs/CANVAS_HARNESS_INTEGRATION_PLAN.md): proposed spatial-canvas integration and rollout
- [docs/LEGACY_RETIREMENT.md](docs/LEGACY_RETIREMENT.md): deliberate removals and parity gates
- [PROVENANCE.md](PROVENANCE.md): origin and intentional release exclusions

## Contributing

The project is early. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) before opening a pull request.

Galaxy Brain is available under the [MIT License](LICENSE).

## Credits

The Galaxy Brain brain artwork is by [Gerd Altmann (geralt)](https://pixabay.com/users/geralt-9301/), used with the artist's permission. Attribution is not required by the licence; we credit him because the mark is his work.
