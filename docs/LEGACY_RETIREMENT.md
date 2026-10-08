# Galaxy Brain v2 legacy retirement ledger

Status: planned removals; this document does not itself remove runtime code.

Production/source-deletion gate as of 2026-09-27: the fetched default branch is
`94f95b61a14824d10d66a9a9182cf640b23c64da`, while the Atlas overhaul continues
in an open stacked branch series through PR #295. The deployed SHA has not been
proven here. No further production-coupled rollback source—specifically the
remaining `GalaxyCanvas`, Flowise portability/editor, or duplicate-settings
closures—is eligible for deletion until its replacement is verified at an
exact deployed SHA and its 30-day post-deploy rollback window has elapsed.
Earlier branch-only removal of unreachable orphan closures remains reviewable
in Git history and does not establish that this production gate passed.

Current route boundary: authenticated `/workspace` serves Atlas directly.
Legacy `shell` and `view` query parameters no longer select the old workspace;
`/atlas-v2` remains only as a temporary compatibility redirect for canonical
Atlas deep links. The unreachable `components/galaxy-brain.tsx` container is
removed; capability-specific orphan closures remain in the repository until
their removal gates below are complete.

The canonical implementation plan is
[`GALAXY_V2_IMPLEMENTATION_PRD.md`](GALAXY_V2_IMPLEMENTATION_PRD.md). Galaxy v2
does not preserve a legacy surface solely because it exists. A capability is
retained only when it is expressed through the canonical object, projector,
plugin, graph, task, or canvas boundaries.

## Retirement ledger

| Legacy surface | Decision | Preserved capability | Removal gate |
| --- | --- | --- | --- |
| Legacy `components/galaxy-brain.tsx` container | Removed after Atlas became the only `/workspace` route. | No capability was deleted; retained components and stores remain separately gated below. | Complete for the unreachable container and its shell-coupled tests. |
| Global chat panel and overlay | Removed from the source closure. | Conversations remain versioned objects with tree/branch graph, focused detail projectors, and explicit exact-snapshot Atlas placement. | Complete for the ephemeral panel: durable discovery, branches, references, deep links, exact bounded turn reads, and body-free Atlas cards live behind the canonical conversation boundary. |
| Global tool panel | Removed from the source closure. | Retained commands live in the Atlas command deck and contextual HUD. | Complete for the generic panel; capability-specific parity remains tracked separately below. |
| Legacy workflow-node `ConfigPanel` modal wrapper | Removed from the source closure after its workspace owner disappeared. | Its only behaviorful child, `MediaProcessingConfig`, remains directly rendered by the separately gated Flowise editor. The wrapper's AI-model, memory, knowledge, and output controls had no persistence handler. | Complete for this unreachable wrapper only. This does not satisfy the Flowise, duplicate-settings, provider-secret, or deployed rollback gates. |
| Legacy code-editor panel and iframe `CodeSandbox` | Removed from the source closure. | The registered `code.editor.open` command opens the canonical `CodeEditorDialog`, which preserves exact UTF-8 source through durable document import and optional Atlas placement. | Complete for the unreachable legacy closure. The old iframe execution runtime is intentionally retired, not replaced at parity; canonical code editing does not promise in-browser execution. |
| Legacy speech-recorder panel and recorder | Removed from the source closure. | The registered `voice.capture.open` command opens the canonical `VoiceCaptureDialog`, retaining review-first transcript/audio capture, durable persistence, recovery, and Atlas placement through the browser speech/media adapters and voice stores. | Complete for the unreachable legacy closure; drawing, audio ingestion, and text-to-speech remain separate retained capabilities. |
| Datasource controls inside the legacy settings dialog | Keep temporarily while Atlas parity is reviewed. | The registered `datasources` plugin opens an accessible Atlas manager for tenant-authorized connect, explicit non-destructive scan, bounded browse, and selected durable import/placement. | Remove the duplicate settings section only after deployment review confirms connector discovery, root authorization, exact-byte import, retry, keyboard/mobile, and failure-state parity. |
| Social panel, dashboard, feeds, accounts, and social tools | Removed from the legacy shell and Flowise-derived editor. | Relevant imported discourse may enter through an explicit source plugin. | Complete for UI/client code. Browser-local legacy records are intentionally left untouched pending an explicit export-or-purge decision. |
| Flowise-derived flow editor and workflow panel | Remove after the portability gate ships. | Goal, bounded context, atomic jobs, typed dependencies, branch/join, versioned save, and dispatch become the Task Constructor projector. | Atlas can download the bounded local export and reopen a selected flow as a detached, non-executing Task Constructor preview. |
| `components/galaxy-canvas.tsx` | Remove after migration. | Canvas placements, ink, selection, file drop, and editing move to the Atlas canvas adapter. | Persisted layouts migrate losslessly, the replacement is verified at an exact deployed SHA, and the 30-day post-deploy source rollback window has elapsed. |
| `components/infinite-canvas.tsx` | Removed with the unreachable knowledge-canvas orphan closure. | Knowledge-base placements render through the Atlas canvas and projector registry. | Complete for the orphan source closure; this does not satisfy the separate production gate for the still-present `GalaxyCanvas`. |
| Field as a competing home screen | Demote to a lens. | Semantic graph/field projection remains available from its retained non-workspace surfaces while retirement continues. | Atlas `/workspace?ref=...` links select already-projected or durably placed objects; arbitrary exact references stay on `/graph?ref=...`, and graph/list/detail accessibility paths remain available. |
| Product-category plugin manifest | Replace with `galaxy-plugin.v1`. | Existing HAM and MarkItDown behavior remains through compatibility adapters. | Typed fixture contributes one command, projector, and transform without arbitrary runtime registration. |

Atlas now exposes object-only and canvas-only v1 bundle creation through
registered `sharing` plugin commands, plus one closed v2 canvas-plus-conversation
scope. Selected-object sharing uses the resolver's exact pinned identity and
excludes chat, run, and turn objects; saved-canvas sharing accepts only an
immutable canvas revision whose stored references are pinned. The combined
scope binds the locally reviewed exact canvas to one pinned chat and publishes a
bounded redacted transcript projection reconstructed by the server. User and
assistant text is publishable; system and tool bodies become typed redaction
records that preserve source lineage without copying instructions or output.
Artifacts, provenance, runs, logs, presence, credentials, live state, and future
changes remain outside it. Canvas and accessible List use the same explicit confirmation
path. Every generated link remains authenticated and tenant-scoped. This is not
a public-link feature, chat permission inheritance, or a return of the legacy
global share panel.

## Preserved reference fixtures

These archived views are design and interaction tests, not production code to
copy back into the shell:

- `task-constructor-preview.html` defines focused task construction: legible
  goal/context, atomic job DAG, dependencies, inspection, branch/join,
  version-aware save, preview, and separate dispatch.
- `galaxy-brain-semantic-zoom.html` defines constellation-to-object navigation,
  aperture/lens controls, progressive labels, contextual inspection, and graph
  structure as navigable terrain.

Both replacements use the shared living-field theme tokens defined by the PRD;
the archived dark palettes and isolated component chrome are not parity goals.

## Cross-cutting parity gates

Before deleting a legacy component:

1. canonical identity, pinned revisions, artifacts, provenance, and relations
   round-trip without loss;
2. the replacement is accessible through keyboard, search, list, and detail
   routes as well as the canvas;
3. desktop and mobile visual checks pass with no control collisions;
4. deep links, saved view preferences, and browser history still resolve;
5. failures identify the responsible plugin/provider and retain the original
   artifact or last valid projection;
6. task save/preview remains separate from claim, run, and dispatch authority;
7. removal is covered by a focused test and `rg` confirms the retired surface
   is no longer imported by the product shell.
8. shared chrome has one owner: `AuthShell` renders the lens rail exactly once;
   authenticated child routes do not render a second rail.

The retirement implementation belongs to PR 16 of the roadmap. Earlier PRs may
make a legacy entry unreachable behind a temporary rollback flag only after its
specific parity gate passes.

## Preserved legacy browser data

Removing the social dashboard does not read, migrate, clear, or otherwise
mutate its historical browser-local keys:

- `flowiseSocialAccounts`
- `flowiseSocialPosts`
- `flowiseSocialFilters`
- `flowiseSocialTopics`
- `flowiseSocialDrafts`

Those values are not canonical Galaxy objects and no current route consumes
them. They remain in the originating browser profile so a later Flowise
retirement slice can offer an explicit export or purge choice. In particular,
this removal does not touch Nostr login, tenant identity, plugin credentials,
share bundles, conversation records, or any server-side schema/API.

## Legacy flow export boundary

Flow definitions are tenant-scoped browser data under `flowiseFlows`; there is
no Flowise flow table or server API to preserve. Before the editor is removed,
the explicit **Export local flows** action downloads a deterministic,
versioned `gb.legacy-flow-export.v1` bundle. Export is read-only: it never
uploads, imports, clears, rewrites, or otherwise mutates browser storage.

The bundle includes only the fields required to identify, reopen, and migrate
the graph: flow ID, name, description, timestamps, version, template flag,
tags, bounded node identity/type/position, migration-safe node data, and
bounded edge identity/endpoints/type/label. Node data is deliberately limited
to `label`, plus `content` for prompts, `model` for model nodes, and `type` for
memory nodes. Flow ownership, public/share state, collaborators, arbitrary node
or edge data, visual runtime state, API keys, credentials, social tokens, and
chat/collaboration logs are excluded. Invalid or oversized records fail the
whole export rather than being truncated or partially omitted; non-portable
fields produce omission warnings without exposing their values.
Malformed JSON, wrong top-level storage shapes, denied browser storage, unsafe
records, and bundles above the aggregate 2 MiB UTF-8 budget fail closed without
creating a download or reporting success. The budget is enforced incrementally
while bounded records are normalized, before the final bounded serialization.

Each object in the bundle's `flows` array retains the legacy graph shape needed
by the existing importer and `migrateLegacyFlowToTaskPlan`; consumers must first
validate the top-level schema with the retained `parseLegacyFlowExport` parser.

Atlas exposes this boundary as one **Legacy flow portability** command. It can
download the current browser-local bundle or validate a local export, select one
flow, show its conversion diagnostics, and open the resulting plan in the
detached Task Constructor preview. Preview save is memory-only. The command
does not upload, execute, dispatch, persist, or create a HAM task, and importing
a file does not write it back to browser storage.

The Flowise editor may be deleted only after this portability action has shipped.
Its source receives a **30-day post-production-deploy source rollback window**;
that rollback clock starts from the production deployment containing the
replacement, not from merge or local validation. After the window, the pure
parser and converter remain as longer-term compatibility code with their bounded
fixtures even when the old editor source is removed. Those retained functions
are `parseLegacyFlowExport` and `migrateLegacyFlowToTaskPlan`.

Deletion remains a separate change. Galaxy Brain will never automatically purge
`flowiseFlows`, any `flowiseSocial*` key, or any other historical browser key.
This boundary also does not promise that legacy credentials or collaboration
records will be migrated.

## Atlas datasource parity boundary

The Atlas command `datasource.manage.open` is registered by the code-owned
`datasources` feature plugin. Connector instances remain server-owned records;
they are not plugins, browser credentials, or a second object store. The first
manager supports only the built-in filesystem-vault connector. The server
resolves every configured path against `GB_DATASOURCE_ALLOWED_ROOTS_BY_TENANT`
both when the connection is created and whenever content is read.

`Scan now` is an explicit, non-destructive inventory operation. It does not
import, rewrite, or delete source files. `Import and place` reads one exact
authorized file, verifies the server-provided SHA-256 in the browser, sends the
same bytes through the existing durable document import, then places only the
pinned canonical document reference on Atlas. It never creates a legacy local
node or stores a second copy in a browser service.

The exact-byte reader does not validate a path and reopen it later. Tenant
authorization returns the matched configured root plus connection-relative
components; the reader never infers its own authority from the connection
path. On POSIX it holds the configured-root descriptor, walks every connection
and item component with no-follow `openat` operations, retains the resulting
connection-root descriptor, and reads the final held descriptor. On Windows it
holds configured-root and connection-root handles, rejects every root, parent,
and final reparse point, requires each opened final path to equal its expected
canonical target beneath the held authority, and rechecks both root identities
after acquiring the item handle. Connection list,
lookup, and update queries also carry explicit tenant predicates in addition to
database row-level security.

The current durable document contract accepts signature-valid PDF and strictly
valid UTF-8 text, Markdown, code, CSV, JSON, and XML. Known text extensions are
normalized to canonical safe media types at the server boundary; SVG remains
excluded from this text lane. Other connector files remain visible but their
import button is disabled with a stated reason; adding broader original-media
support belongs to the durable ingestion contract rather than a datasource UI
workaround. The old settings section intentionally remains until this parity
slice has been reviewed.
