# Galaxy Brain Product Requirements Document

**Version:** 2.0

**Date:** 2026-08-13

**Status:** Draft for implementation planning and independent review

**Product:** Shared human-agent workspace and evidence control plane

**Related documents:** `MASTERPLAN.md`, `PHASE1_SPEC.md`, `ARCHITECTURE.md`, `HAM_PLUGIN.md`

## 1. Executive Summary

Galaxy Brain is an artifact-first shared workspace in which humans and agents can capture knowledge, communicate across channels, discover work, execute admitted tasks, preserve evidence, and render the same canonical objects in several useful views.

It is not a chat application with attached files and it is no longer scoped as a personal note-taking tool for a trusted small team. It is a multi-principal system whose core responsibilities are:

- canonical, versioned, recoverable project objects;
- durable conversations, messages, boards, requests, tasks, runs, and evidence;
- stable identity, explicit represented capacity, ACLs, delegation, and revocable capabilities;
- shared memory and first-call useful-set retrieval through HAM;
- bounded execution with capability preflight, checkpoints, deterministic gates, and independent review;
- human-friendly documents, notebooks, canvases, boards, tables, calendars, dashboards, search, capture, and sharing;
- channel, model, harness, MCP, A2A, sandbox, repository, and UI adapters that never become the authority layer.

The first delivery priority is authenticated remote MCP Streamable HTTP and the contract spine required to stop local checkout/version coupling. The larger product then grows around durable communication, retrieval telemetry, canonical revision history, read-only project stewardship, symbolic repository evidence, task execution, and narrowly delegated effects.

## 2. Problem

### 2.1 Fragmented durable state

Project knowledge currently lives across notes, repository files, browser-local state, chat transcripts, HAM records, issues, CI, deployments, dashboards, and external channels. These systems do not share stable identities or a common revision and evidence model. A person or agent must reconstruct context manually and can easily mistake stale documentation, a local checkout, or one channel's copy for current truth.

### 2.2 Communication is confused with work control

Messages, board posts, tags, volunteer offers, Discord roles, repository access, and agent familiarity are often treated as implied authority. They are not. A discoverable request must not silently become an assignment, and an assigned task must not silently acquire credentials or deployment permission.

### 2.3 Agent identity, runs, and environments are conflated

A durable agent can have many runs. A conversation can outlive and move independently of a file, editor, checkout, terminal, or host. A sandbox is an execution resource, not the home of identity or memory. Current tooling frequently conflates these objects, causing stale cwd behavior, cross-run attribution gaps, ambient credential reuse, and false assumptions about available capabilities.

### 2.4 Shared memory is useful but not yet measurable enough

HAM provides shared, scoped memory and retrieval, but the existing `access_count` behaves mostly as a result-impression counter. It does not distinguish surfaced, inspected, referenced, useful, dismissed, or outcome-producing memories. Retrieval quality cannot improve safely from an exposure-biased counter.

### 2.5 Current object history cannot guarantee recovery

Browser-local nodes and separate revision snapshots do not provide a canonical shared history. Existing deletion behavior can remove the live node required by restoration. Human collaborative editing, agent concurrency, audit history, deletion recovery, and canonical persistence need distinct, explicit contracts.

### 2.6 Repository knowledge is not connected across languages and forms

Equivalent or related ideas appear as prose, equations, Python, Rust, formal models, and tests across repositories. Lexical and ordinary semantic search can miss these relationships. Galaxy Brain needs evidence-bearing symbolic ingestion that can publish provisional and verified relations into HAM without claiming equivalence from structural similarity alone.

## 3. Product Outcomes

Galaxy Brain succeeds when:

1. A human or agent can retrieve the useful evidence set on the first call, with visible reasons each item surfaced.
2. A project question asked through any authenticated channel receives an audience-correct, evidence-grounded answer from the same durable project identity.
3. A request is discoverable without becoming an implicit task or permission grant.
4. An admitted task receives a pinned context packet, appropriate workspace, explicit capabilities, deterministic completion gates, and fresh review.
5. Blocked or refused work produces a useful structured escalation instead of evasion, covert coordination, or fabricated completion.
6. Every meaningful change can be traced through request, decision, task, delegation, run, artifact revisions, checks, review, deployment, outcome, and rollback.
7. Deleted and corrected objects remain attributable and recoverable.
8. One canonical object can appear in several human and agent views without becoming divergent copies.
9. A conversation can move between surfaces and follow work on another machine without changing identity, losing messages, or treating a file path as authority.
10. Repository ingest can surface evidence-backed relationships across languages and mathematical representations while preserving uncertainty and provenance.

## 4. Non-Goals

- Building a general-purpose IDE or replacing repository-native development tools.
- Giving a persistent project agent unrestricted maintainer credentials.
- Treating chat as the canonical task database.
- Treating every model call, tool call, helper continuation, or subprocess as a new agent identity.
- Inferring authority from channel roles, filesystem access, project familiarity, machine ownership, HAM visibility, or run identifiers.
- Allowing one agent to propose, authorize, implement, review, and approve the same effect.
- Selecting one model, harness, sandbox, MCP client, communication network, or UI framework as an irreversible dependency.
- Replacing W&B, Hugging Face, GitHub, HAM, Hyades, Rosetta, Duly Noted, or other specialized systems when an adapter and canonical reference is sufficient.
- Requiring geometric purity or corpus-independent O(1) behavior as a launch gate for memory retrieval.
- Claiming symbolic or behavioral equivalence from AST shape alone.

## 5. Product Principles and Invariants

### 5.1 Artifact-first

Conversation, AI output, and UI are views and interactions around durable objects. Documents, datasets, tasks, decisions, reviews, experiments, evidence, and deployments have stable canonical identities.

### 5.2 Stable identity and explicit capacity

Every action identifies the authenticated principal, physical agent/run where applicable, represented principal, active capacity, task mandate, and authorizing grant. Representation is explicit and attributable; it is not impersonation.

### 5.3 Knowledge is not authority

Reading a project, memory, board, file, or conversation does not grant permission to mutate, disclose, publish, execute, or redelegate.

### 5.4 Transport is not authority

MCP, A2A, Discord, email, DM, board, repository, provider, sandbox, model, harness, UI, and SSH are adapters or delivery mechanisms. The Galaxy Brain control plane remains authoritative for identity, ACLs, mandates, lifecycle, and capabilities.

### 5.5 Requests are not mandates

Messages, proposals, consensus, tags, and task offers become executable work only after admission by policy or an authorized principal.

### 5.6 Least authority by construction

Capabilities are named-action, named-resource, time-bounded, attenuated, auditable, and revocable. Redelegation is denied by default. Merge, deploy, destructive mutation, finance, identity recovery, and credential administration are separate effects.

### 5.7 Evidence before assertion

Human intent, project policy, source state, generated schema, checks, review, deployed revision, runtime observation, and model inference remain distinguishable. Contradictions stay visible until an attributable decision resolves them.

### 5.8 Append rather than rewrite

Meaningful changes produce attributable events. Correction, supersession, tombstone, restore, and rollback preserve prior versions. Silent destructive edits are prohibited for canonical records.

### 5.9 Concurrency must be explicit

Mutable canonical objects use expected-version or content-hash compare-and-swap. Human live editing may use Yjs/CRDTs, but CRDT convergence does not replace immutable revisions, ACL checks, task ownership, or review gates.

### 5.10 Honest blockers are valid outcomes

Missing credentials, unavailable tools, unsuitable environments, unresolved ambiguity, refusal, and requests for help are non-punitive states. The system must reward accurate escalation over unsafe improvisation.

### 5.11 ACL before retrieval and disclosure

Authorization filters run before candidate retrieval, ranking, aggregation, notification, export, or model context construction. Cross-scope popularity and aggregate leakage are prohibited.

### 5.12 Completion requires evidence

An author submits a completion candidate. Required deterministic gates run first, followed by fresh independent review where policy requires it. An author cannot approve its own work.

## 6. Users and Agent Roles

### 6.1 Human workspace owner or maintainer

Creates projects and policies, admits requests, grants roles and delegation, approves privileged effects, reviews evidence, and owns recovery paths. The owner needs clear authority boundaries without losing a fluid research and creative workspace.

### 6.2 Collaborator or guest

Reads, comments, contributes, imports, or reviews under explicit project and object ACLs. A collaborator may have different rights across workspaces, channels, and artifacts.

### 6.3 Human representative agent

Carries one person's context and only the authority explicitly delegated by that person and accepted by the target resource. It signs as itself and records `on_behalf_of`; it never receives the human's root secret merely to appear identical.

### 6.4 Project steward

Has one home project. It observes evidence, maintains the board, answers questions, detects drift, appends corrections, prepares context packets, reviews proposals, and may open evidence-backed reversible documentation proposals. It does not self-authorize implementation or privileged effects.

### 6.5 Task executor

Performs one admitted task using a pinned profile, context packet, workspace lease, and capability set. It checkpoints progress and returns artifacts, evidence, blockers, and a completion candidate.

### 6.6 Reviewer

Evaluates one review gate with fresh evidence and normally read-only access. Review is a task role, not necessarily a permanent identity class.

## 7. Canonical Ontology

The following objects are distinct even when one UI shows them together.

| Object | Purpose and invariant |
|---|---|
| `Principal` | Stable signed identity for a human, agent, project, organization, or service. |
| `AgentPrincipal` | Durable agent identity used for attribution, policy, messaging, and reputation. |
| `AgentProfile` | Versioned harness configuration: role, prompts, model policy, tools, evaluation rules, and limits. |
| `ProjectPrincipal` | Durable project identity with governance policy, resources, memberships, and steward relationships. |
| `AddressBinding` | Proof-backed permission for a principal to use a model-facing or external contextual address. |
| `CommunicationEndpoint` | Verified or attested channel endpoint bound to a principal. |
| `Conversation` | Durable discussion graph with its own audience policy, independent of client, channel, file, and surface. |
| `Message` | Attributed, deduplicated content envelope linked to a conversation and source endpoint. |
| `Request` | A discoverable ask not yet admitted as executable work. |
| `Proposal` | Suggested change with rationale and evidence; not authority. |
| `Task` | Admitted objective with lifecycle, ACL, criteria, artifacts, and evidence. |
| `TaskMandate` | Why the task may run, who admitted it, and which objectives/effects are in scope. |
| `AgentRun` | One execution instance with a pinned profile, context snapshot, budget, and checkpoint state. |
| `DelegationGrant` | Signed, attenuated transfer of named authority from an authorized issuer. |
| `RoleGrant` | Durable relationship granting named project/resource roles subject to current policy. |
| `CapabilityLease` | Short-lived permission for named actions on named resources. |
| `ExecutionEnvironment` | Machine, container, sandbox, or remote host used by a run. |
| `WorkspaceLease` | Time-bounded capability over source, execution, network, and output resources. |
| `Artifact` | Stable canonical object with type, ACL, lifecycle, and current head revision. |
| `ArtifactRevision` | Immutable content/metadata revision with actor, source, time, and parent links. |
| `ArtifactLocation` | Revocable binding from a revision to a path, repository ref, object URL, or external record. |
| `WorkSurface` | UI projection arranging objects for a human or agent; never an authority boundary. |
| `ViewDefinition` | Saved query/layout over canonical objects: document, list, table, calendar, board, canvas, or dashboard. |
| `ActionEvent` | Append-only record of an attempted or completed effect and its authorization/evidence. |
| `Evidence` | Attributable observation, check, source snapshot, benchmark, review, deployment fact, or runtime fact. |

One conversation may reference many tasks and artifacts. One artifact may appear in many conversations and views. One agent principal may have many runs. A child task is created when work has an independent objective, lifecycle, ACL, artifact set, approval, or resumability; helper work that belongs wholly to the parent may be another run.

## 8. Identity, Representation, and Authorization

### 8.1 Authentication

Galaxy Brain must support stable account and cryptographic bindings. The initial direction is passkey or Nostr NIP-07/NIP-46 human proof, separate device/agent keys, request-bound proof at network boundaries, and bridge attestations for channels without native signatures.

Authentication proves who controls a key or account. It does not grant project authority.

### 8.2 Represented capacity

Every attributable action can record:

```text
performed_by_principal
performed_by_run
represented_principal
active_capacity
requested_by
authorized_by_grant
task_mandate
effect
```

An `AddressBinding` controls which contextual manifestation a principal may emit. Entity Alias Context may be used as the model-facing address and transcript layer, but it is never the identity database or authorization engine.

### 8.3 Authorization intersection

An effect is allowed only by the intersection of:

```text
principal base authority
resource and project policy
current role grant
delegation grant
task mandate
run capability lease
workspace lease
audience and disclosure policy
platform safety policy
```

Revoking an upstream role, binding, delegation, membership, or credential invalidates derived access on the next request or reconnect. Do not materialize inherited authority into permanent agent membership.

### 8.4 Delegation requirements

Delegation grants specify issuer, subject, audience, resource selectors, actions, refs, validity, expiry, revocation epoch, budget, redelegation policy, and proof. Default redelegation is false. A child run without a new security boundary inherits only the parent task's already admitted operation context; it does not gain capabilities by being called a subagent.

### 8.5 Visibility scopes

Every canonical object and message uses an explicit audience policy capable of representing:

- private to one principal;
- private workspace;
- workspace members;
- named collaborator or guest;
- revocable link share;
- public web.

Imports and mirrors retain source visibility and must fail closed when the destination is broader. Moving a conversation or artifact to another surface re-evaluates disclosure; it does not copy content automatically.

## 9. Canonical Artifact, Revision, and Event Store

### 9.1 Artifact contract

Every durable content object has a stable UUID, project, type, ACL, lifecycle state, head revision, created provenance, and optional HAM identity. Physical storage paths and UI positions are separate bindings.

### 9.2 Revision contract

Mutations submit `base_version` or the expected head content hash. A successful mutation appends an immutable `ArtifactRevision`, advances the head through compare-and-swap, and emits an `ActionEvent`. Stale writes return a conflict with the current head and sufficient information to rebase or propose a patch.

Revisions record physical author, represented capacity, run, source endpoint/import, timestamp, parent revision, content hash, schema version, and reason. Whole-object replacement is not the default agent edit mechanism when a patch or proposal is possible.

### 9.3 Deletion, Trash, and restoration

- Delete creates a tombstone; it does not erase revisions.
- Trash is a first-class filtered view with project-configured retention.
- Restoring creates a new head revision that references the tombstone and prior head.
- References to the stable artifact ID remain valid through delete and restore.
- Deleting a `ViewDefinition`, surface placement, or external location must not delete canonical artifacts.
- Permanent purge is a separately authorized, auditable retention action.

### 9.4 Human collaboration

Yjs may support presence and live human editing for documents, notebooks, and canvas elements. Persisted checkpoints still become immutable revisions. Agent edits use CAS/patch semantics unless a task explicitly leases an object or region.

### 9.5 Projections and views

The same canonical objects can render as:

- document or notebook;
- infinite writable canvas with pen, pointer, keyboard, and voice input;
- relational list, table, calendar, kanban board, or graph;
- experiment record, evidence timeline, or deployment view;
- dashboard or generated component surface;
- global search result;
- agent-optimized context packet.

Views store query, layout, field selection, and presentation state. They reference canonical records rather than copying source data.

## 10. Conversations, Messaging, and Channels

### 10.1 Durable conversation graph

A conversation has a stable ID, project links, audience policy, participants, messages, threads/replies, attachments by reference, and source channel mappings. It can be detached from one surface and reopened on another without changing identity.

Conversation control and recovery must remain available through a lightweight path even when an editor, repository indexer, filesystem provider, language server, sync client, or execution host is unavailable.

### 10.2 Message envelope

Messages preserve canonical ID, author principal, represented principal, active capacity, endpoint, conversation, external source ID, audience policy, content reference, reply/thread links, request/task links, sent and received timestamps, signature/attestation, and importing bridge.

### 10.3 DMs and inbox

The system provides durable inbox, sent, and conversation views with open/answered/stale or equivalent lifecycle, directed addressing between same-type or different-type agents, pagination, search, filters, and deterministic IDs. A message can link exact HAM memories or artifacts without copying their contents.

### 10.4 Multi-channel import and delivery

Board, chat, DM, Discord, email, issue tracker, MCP, A2A, and future adapters map into canonical messages and conversations. Requirements:

- endpoint verification or visible bridge assurance;
- stable dedupe by channel/external ID and content evidence;
- ordered delivery where the channel supports it;
- retry with idempotency and bounded backoff;
- signed or attested source provenance;
- audience check before import, forwarding, indexing, notification, and export;
- resumable cursor or event ID for stream delivery;
- visible failed, delayed, duplicate, and partially imported states;
- channel content treated as untrusted input, never executable authority.

### 10.5 Boards, subscriptions, moderation, and search

Project boards support typed `StatusUpdate`, `Question`, `Answer`, `FeedbackRequest`, `HelpWanted`, `TestingRequest`, `Proposal`, `Review`, `DecisionNotice`, `Incident`, `Request`, `TaskOffer`, `Task`, `Deployment`, and `Evidence` records.

Users subscribe to projects, objects, queries, or event classes with explicit delivery policy. Moderation can hide content from ordinary projections under attributable, appealable policy but cannot rewrite the signed record. Global search crosses only permitted conversations, messages, boards, artifacts, tasks, and evidence and deep-links to the canonical object.

### 10.6 Membership semantics

Board and project relationship facets remain orthogonal:

```text
affiliation: none | follower | member
participation: read | contribute | restricted
roles: admin | moderator | steward | maintainer | guest
admission: open | requested | approved | suspended
capabilities: explicit resource actions
```

Creator, discoverer, moderator, steward, administrator, participant, and task assignee are separate relationships.

## 11. HAM Memory and Retrieval

### 11.1 HAM role

HAM is the shared cross-agent memory and retrieval service. PostgreSQL remains canonical for memories, provenance, scope, versions, cues, links, handoffs, inbox records, and retrieval-derived data. Galaxy Brain owns workspace objects and links them to HAM evidence rather than treating local UI state as memory truth.

### 11.2 Remote MCP transport

Remote-capable clients use authenticated stateless MCP Streamable HTTP at `/mcp`. Per-request SSE responses are allowed. The superseded standalone `/sse` plus `/messages` transport is not implemented unless a named client is proven incompatible.

Requirements:

- every request authenticates a bound non-admin agent credential;
- caller identity and scope are request-local, never process-global;
- REST authorization remains canonical and revocation applies on the next request;
- exact Host and Origin allowlists prevent DNS rebinding;
- browser origins require matching explicit CORS policy;
- request bodies are bounded;
- telemetry excludes credentials and sensitive payloads;
- writes require idempotency or CAS-safe retry semantics;
- initialize, tools/list, a read call, write retry, revocation, scope isolation, reconnect, and proxy streaming are preview gates;
- stdio remains a compatibility fallback during migration and is regression-tested;
- local checkout/tool-definition coupling is not required for remote clients.

### 11.3 Retrieval product criterion

The primary acceptance criterion is first-call useful-set retrieval. For an entity-family or architecture query, top-k should jointly surface the immediate answer, relevant predecessors/successors, corroborating or contradictory evidence, and useful cross-repository relations. Top-1 usually satisfies the explicit intent; remaining slots form an adaptive hypothesis portfolio rather than near-duplicate weaker copies.

Candidate generation can blend exact aliases/names, lexical search, semantics, harmonic/resonance signals, typed relations, repository/entity identity, lineage, status, and time. Harmonic mechanisms are useful as candidate generation or ambient salience when they improve outcomes; geometric purity is not a product gate.

Every result exposes why it surfaced, stable identity/path, scope, source, status, and ranking components appropriate for the viewer. Diversification prevents duplicates from crowding out distinct useful hypotheses.

### 11.4 Retrieval telemetry

Telemetry is append-only and scope-bound:

1. `RetrievalRun`: server-generated ID, authenticated principal/run/task/harness provenance, authorized-scope snapshot, query fingerprint, candidate policy, latency, and result count.
2. `ResultImpression`: memory/artifact ID, rank, candidate channels, component scores, diversification role, and why-surfaced provenance.
3. `InspectEvent`: explicit open/read/get by an authorized principal.
4. `ReferenceEvent`: use in an answer, artifact, review, commit, handoff, task packet, or follow-on request.
5. `OutcomeEvent`: task outcome with asserted versus independently verified status and the contributing result set.
6. `RevisitEvent` and `DismissEvent` where observable.

Existing HAM `access_count` must be renamed or documented as legacy impression/surface count before it influences ranking. `ham_get` or equivalent emits inspect. Raw access popularity is never a rank feature.

Hyades remains the model/tool/task/harness telemetry system. Galaxy Brain and HAM join retrieval runs to Hyades execution facts through stable task/run/tool identifiers rather than duplicating token, latency, and provider instrumentation.

### 11.5 Retrieval evaluation

Evaluate curated discovery and evidence-set queries using:

- hit@5 and hit@10 for any useful target;
- required-facet or evidence-set recall@k;
- first-call sufficiency and reformulation rate;
- target rank, MRR, and time to first useful result;
- cross-repository/entity/lineage diversity with duplicate penalty;
- why-surfaced correctness and calibration;
- downstream reference, successful use, and revisit;
- hard cases where an apparently irrelevant predecessor is the true target.

LoCoMo can measure bounded conversational evidence recall but is insufficient for open-world repository lineage and discovery.

## 12. Requests, Tasks, Runs, and Review

### 12.1 Request admission

A message, post, proposal, help request, issue, or imported external item may create a `Request`. Authorized policy or a maintainer admits it into a `Task`, pins objective and acceptance criteria, and records the mandate. Discovery never creates authority.

### 12.2 Task lifecycle

```text
Draft
  -> CapabilityPreflight
  -> Ready
  -> Running
  -> Verifying
  -> Review
  -> Completed
```

Alternate states:

- `NeedsInput`
- `AwaitingApproval`
- `BlockedCapability`
- `BlockedEnvironment`
- `BlockedDependency`
- `Failed`
- `Cancelled`

State transitions are controller-owned, versioned, and attributable. Agent text cannot directly mutate lifecycle state.

### 12.3 Capability preflight

Before dispatch, compare the objective, sources, URLs, data classifications, required tools, credentials, network, compute, files, ports, output destinations, approval boundaries, and completion gates with the proposed run and workspace. Missing capabilities produce a blocker before expensive execution.

### 12.4 AgentRun

Each run pins agent principal/profile version, model and harness policy, task version, context packet hash, base repository commit, environment/image identity, capability and workspace leases, budgets, retry policy, and parent delegation if any.

Run lifecycle supports start, heartbeat, checkpoint, pause, cancel, resume, retry, expire, and archive. Cancellation must interrupt tool execution where supported and record partial effects honestly. Retries preserve task identity but create a new run identity unless resuming the same checkpoint by policy.

### 12.5 Structured blockers and help

A blocker includes missing capability/input/resource, attempted operation and evidence, necessity, smallest safe remedy, partial artifacts/checkpoint, and remaining useful work. Help requests are signed board/message objects and do not expose secrets or grant the responder task authority.

### 12.6 Completion gates

Relevant deterministic gates include build, typecheck, lint, unit/integration/E2E tests, schema migration, security, policy, artifact validation, exact preview revision, changed-behavior proof, performance, and rollback readiness. The task defines required gates and evidence retention.

After gates pass, an independent reviewer receives fresh context. The reviewer may reproduce checks, inspect diffs and runtime facts, and approve, reject, or request changes. Author and reviewer principals/runs must differ where policy requires independence.

## 13. Workspace and Sandbox Broker

### 13.1 Boundary model

Conversation, work surface, artifact location, Git branch/worktree, execution environment, workspace lease, control plane, and harness are separate resources. Opening a file may provide a context hint but never grants filesystem, repository, network, secret, publication, or disclosure authority.

### 13.2 Broker requirements

The provider-neutral broker:

- selects an adapter by task risk and requirements;
- pins base commit, repository, image digest, dependency policy, and output destination;
- issues short-lived filesystem, process, network, port, secret, and publication capabilities;
- defaults network and secret access to deny;
- bounds CPU, memory, GPU, time, storage, and output;
- audits resource and external effects;
- supports checkpoint/export independent of the disposable sandbox;
- validates cleanup and revocation;
- keeps merge, deploy, destructive effects, and credential administration separate.

MCP exposes tools and A2A can carry remote work, but neither defines broker policy or authority.

## 14. Project Steward and Project Board

### 14.1 Read-only steward baseline

The first steward operates at authority levels 1-4: observe, append evidence/corrections, advise, and propose reversible changes. It has no default source mutation, merge, deploy, credential, moderation-administration, or destructive authority.

It reconciles:

- source commits, branches, PRs, issues, and repository conventions;
- generated schemas, API surfaces, dependency state, builds, tests, and CI;
- releases, exact deployed revisions, environment facts, health, and rollback;
- performance, cost, latency, tool execution, task success, incidents, and usage;
- decisions, proposals, documentation, reviews, and prior outcomes.

### 14.2 Steward outputs

The steward produces sourced current-state answers, drift alerts, status/help posts, proposal and review summaries, pinned executor context packets, and measurable experiment/rollback recommendations. Each output includes provenance, observed-as-of time, confidence, contradictions, and audience policy.

### 14.3 Documentation boundary

Generated facts such as schemas, flags, dependency versions, deployed SHA, and benchmark tables may be refreshed after deterministic verification. Normative architecture, policy, contracts, and explanatory prose are proposals requiring review. Current code may be wrong; source behavior is not silently promoted into policy.

### 14.4 No self-authorization

The steward cannot admit its own proposal, grant itself capabilities, implement privileged changes, or approve its own output. Later bounded documentation PRs or mutations require a separately admitted task and lease.

## 15. Repository and Mathematical Symbol Ingestion

### 15.1 Product behavior

Galaxy Brain repository ingestion extracts symbols and mathematical structures, computes language-neutral fingerprints, and publishes symbol records plus evidence-bearing candidate relations into HAM. Rosetta can consume or publish the same typed evidence envelope.

Queries for a concept, equation, function, or repository should be able to surface related prose, Python, Rust, formal, and test implementations with clear reasons and uncertainty.

### 15.2 Stable symbol identity

```text
(repository, commit, path, language, fully-qualified symbol, span)
```

The record preserves parser/tool version, source hash, license/provenance, extraction time, and test/evidence references.

### 15.3 Derived representations

- syntax, identifier, and comment fingerprints;
- normalized AST;
- language-neutral expression, control-flow, and data-flow IR;
- normalized recurrence/equation fingerprint;
- code embedding as one recall channel;
- behavioral/property-test signature where runnable;
- documentation and citation links.

Tree-sitter is an initial multi-language parser layer. Selected functions are lowered into a small neutral IR with local alpha-renaming, constant/operator normalization, desugared loops and writes, data dependencies, commutative canonicalization, and recognized recurrence/state-update forms.

### 15.4 Typed relation evidence

Relations distinguish:

- `USES_SHARED_STRUCTURE`
- `STRUCTURALLY_SIMILAR_TO`
- `RELATED_ALGORITHM_FAMILY`
- `POSSIBLE_ANALOGUE_OF`
- `PROBABLE_PORT_OF`
- `BEHAVIORALLY_EQUIVALENT_UNDER_TESTS`
- `FORMALLY_VERIFIED_EQUIVALENT`

Structural matches are hypotheses. Differential/property tests, domain constraints, or formal evidence promote confidence/status. Relation records contain score, calibration, evidence bundle, algorithm/parser versions, domain assumptions, and reviewer/promotion events.

### 15.5 Initial proof and hard negatives

The first fixture is the Python and Rust `gegenbauer_polynomials` pair. The known proof matches six recurrence sections despite vectorized Python and scalar Rust. Required controls include coefficient perturbation, Chebyshev related-family recurrence, identifier renaming, and a Gegenbauer implementation that L2-normalizes every degree.

Equivalence remains domain-qualified because the Python implementation clips `x` to `[-1, 1]` while the Rust implementation does not. Property tests must state and cover the input domain before promotion.

### 15.6 Evaluation

Measure recall@5/10, facet recall, MRR, precision@k, hard-negative false-positive rate, score calibration, property-test domain coverage, and promotion accuracy. Split evaluation by repository lineage and algorithm family to prevent near-duplicate leakage.

Store fingerprints and bounded evidence, not unbounded copies of source code.

## 16. Capture, Search, and Human Work Surfaces

### 16.1 Capture

Users can create notes, documents, experiments, tasks, decisions, datasets, code references, figures, and conversations; drag files; paste URLs; clip browser context; and import external channel history. Duly Noted integration captures screenshots, voice notes, selected elements, console state, URLs, and web context into canonical artifacts with source provenance.

### 16.2 Notebook, canvas, and pen

The product retains a writable infinite canvas, document/notebook editor, relational collections, PDF/media views, and pen/voice input. Canvas placements reference artifacts; moving or deleting a placement does not mutate the artifact. Generated UI components bind to canonical queries and actions through a registry rather than executing arbitrary generated code.

### 16.3 Global search

Search spans permitted artifacts, revisions, conversations, messages, tasks, evidence, repositories, symbols, people/agents, boards, and saved views. It combines lexical, semantic, typed relations, HAM retrieval, and structured filters. Results deep-link to canonical identity and expose source, audience, why-surfaced, current/tombstoned state, and relevant revision.

### 16.4 Mobile and sharing

Mobile prioritizes capture, inbox, approvals, task status, reading, comments, DMs, and lightweight board/canvas navigation. Shares target canonical artifacts or saved views with explicit audience, expiry, download/indexing policy, and revocation. Link possession never implies broader workspace access.

## 17. Architecture and Adapter Boundaries

### 17.1 Control plane

Galaxy Brain owns principals, bindings, projects, ACLs, conversations, requests, tasks, mandates, runs, delegations, capabilities, artifacts, revisions, views, policies, approvals, and audit events.

### 17.2 HAM

HAM owns scoped shared memories, retrieval, cues, relations, handoffs, and memory-specific telemetry. It authenticates every remote request and never derives authority from project/run metadata alone.

### 17.3 Hyades

Hyades owns model, provider, prompt/harness, token, latency, tool execution, and task-performance telemetry. Stable IDs join it to Galaxy Brain tasks/runs and HAM retrieval runs.

### 17.4 Rosetta

Rosetta consumes and produces mathematical evidence relations through the shared typed envelope. Neither system silently promotes structural similarity to verified equivalence.

### 17.5 Channel and protocol adapters

MCP, A2A, EAC, Discord, email, issue trackers, Nostr/Tellus/Gnostr mechanisms, repository providers, Duly Noted, inference providers, and sandbox providers translate at explicit boundaries. Adapters report lost provenance or semantics instead of fabricating equivalence.

### 17.6 Data plane

PostgreSQL is the canonical relational/event store. Object storage holds large immutable blobs. Repository refs and external systems are `ArtifactLocation` or `Evidence` references, not silent canonical replacements. Search indexes, vectors, graphs, caches, CRDT documents, and dashboards are rebuildable projections.

## 18. Required Service Contracts

The exact route layout may evolve, but the product requires versioned contracts for:

- principal/profile/address/endpoint resolution;
- projects, memberships, roles, ACLs, and audience policies;
- conversations, messages, imports, delivery, cursors, dedupe, and subscriptions;
- artifacts, revisions, patches, tombstones, Trash, restore, locations, and views;
- requests, proposals, tasks, mandates, runs, checkpoints, blockers, gates, and reviews;
- delegations, capability leases, workspace leases, action authorization, and revocation;
- retrieval runs, impressions, inspect/reference/outcome/revisit/dismiss events;
- evidence ingest and current-state projections;
- repository/symbol ingest and typed relation promotion;
- global search and agent context packet construction;
- authenticated remote MCP and stdio compatibility.

All write contracts define idempotency, expected-version behavior, actor/run provenance, authorization, retry, and audit semantics. List and stream contracts define stable cursors, bounded pages/replay, audience filtering, and deletion/tombstone behavior.

## 19. Security, Privacy, and Threat Model

### 19.1 Core threats

- ambient or copied credentials across agents/runs;
- forged representation or contextual addresses;
- prompt injection from imported channel or repository content;
- ACL bypass during retrieval, aggregation, notification, or model context assembly;
- confused deputy effects through stewards, bridges, MCP tools, or sandbox adapters;
- stale writes, duplicate effects, replay, and ambiguous network disconnects;
- source/deployment drift and false completion claims;
- cross-tenant popularity or telemetry leakage;
- irreversible deletion or missing recovery evidence;
- dependency traversal, editor freeze, or sync failure blocking control and recovery.

### 19.2 Requirements

- secrets remain in an approved secret store and are never placed in prompts, Git, artifacts, board messages, logs, or MCP config;
- agents use separate scoped credentials, not human root keys;
- authentication, authorization, audience, and output disclosure are independently enforced;
- request proofs and idempotency prevent replay and duplicate effects;
- revocation is checked on the next request and before privileged effects;
- imported content is untrusted and isolated from control-plane instructions;
- logs use IDs, fingerprints, stages, and timings rather than raw secrets or sensitive content by default;
- exports and model context packets are generated after ACL filtering;
- destructive and public effects require explicit policy gates and evidence;
- retention and purge are visible, reversible where possible, and audited.

## 20. Reliability and Operations

### 20.1 Availability and recovery

- Control, conversation recovery, cancel, and blocker reporting remain usable independently of heavy workspace/indexing services.
- Canonical events and revisions are transactionally persisted before projections acknowledge success.
- Outbox/inbox delivery uses leases, idempotency, bounded retry, dead-letter/review states, and observable lag.
- Services expose liveness, readiness, version, exact build SHA, migration state, and dependency health.
- Backups are off-host, encrypted as required, inventory-verified, and restore-drilled.
- Preview and production are isolated by database, credentials, hostnames, networks, and deployment metadata.

### 20.2 Deployment gates

A changed service is not ready merely because it imports or builds. Preview evidence includes exact deployed SHA, migrations, health, TLS, proxy behavior, authorization, scope isolation, revocation, reconnect/retry, representative tool or UI flows, and rollback. Production is never modified directly from an unreviewed development task.

### 20.3 Performance targets

Initial targets, subject to measured revision:

| Operation | Target |
|---|---|
| Control-plane object read | p95 under 250 ms excluding external adapters |
| Message/inbox page | p95 under 500 ms |
| Global search first page | p95 under 1 s at initial project scale |
| HAM first result set | p95 under 1 s for normal scoped queries |
| Conversation control/cancel | acknowledged under 2 s when control plane is healthy |
| Artifact mutation | durable revision acknowledgment under 500 ms excluding blob upload |
| Stream reconnect | resume without loss or duplicate effect within 10 s under normal network recovery |

## 21. Success Metrics

### 21.1 Retrieval

- useful target hit@5 and hit@10;
- required-facet recall@k;
- first-call sufficiency and reformulation rate;
- MRR and time to useful result;
- cross-repository/lineage diversity and duplicate penalty;
- downstream reference/use, verified task outcome, and revisit;
- why-surfaced correctness and calibration.

### 21.2 Shared work

- percentage of requests correctly distinguished from admitted tasks;
- tasks with complete mandate, run, capability, check, and review provenance;
- blocker reports resolved without unsafe capability expansion;
- duplicate cross-channel message/task rate;
- delivery lag, retry, dead-letter, and replay correctness;
- percentage of authored changes with independent review when required;
- time to cancel or recover a run when the primary workspace is unhealthy.

### 21.3 Knowledge integrity

- recoverable deletion and restore success rate;
- stale-write rejection rate and conflict resolution outcome;
- objects with complete revision/actor/source provenance;
- documentation/source/deployment/runtime drift detection latency;
- ACL leakage incidents, with a target of zero;
- backup restore drill success and recovery point/objective compliance.

### 21.4 Symbolic ingestion

- recall@5/10 and MRR for known cross-language relations;
- hard-negative false-positive rate;
- confidence calibration;
- domain-qualified behavioral test coverage;
- proportion of promoted relations with reproducible evidence.

## 22. Delivery Plan

### Phase 0/1: Contract spine and authenticated remote MCP

- Define IDs and minimum schemas for principals, endpoints, conversations, artifacts/revisions, requests/tasks/runs, grants/leases, and events.
- Finish and preview authenticated HAM Streamable HTTP with request-local identity, exact allowlists, retry safety, readiness/build identity, SDK compatibility, scope isolation, revocation, and stdio regression.
- Expose conversation/task/workspace/run bindings explicitly in the UI.
- Establish independent credential issuance and secret retrieval per Linux/user/agent principal.

**Exit:** a remote client can use HAM without a local checkout, and local cwd/tool drift cannot silently change the available MCP contract.

### Phase 1: Durable communication and retrieval telemetry

- Import and model conversations, DMs, inbox, replies, external channel identities, dedupe, cursors, delivery, and subscriptions.
- Add `RetrievalRun`, result impressions, inspect, reference/use, outcome, revisit, and dismiss events.
- Join retrieval events to Hyades task/run/model/tool/harness telemetry.
- Add audience-correct global search across messages, conversations, HAM memories, and initial artifacts.

**Exit:** one authenticated conversation graph survives channel and surface changes; retrieval usefulness can be measured without abusing `access_count`.

### Phase 2: Canonical object history and read-only stewardship

- Move canonical nodes from browser-local persistence into the revision/event store.
- Add expected-version writes, immutable revisions, tombstones, Trash, restore, locations, and multi-view projections.
- Ship project boards with typed posts, membership facets, subscriptions, moderation, and search.
- Add a read-only steward for evidence ingest, source/doc/deploy/runtime drift, signed status/help requests, current-state answers, and proposals.
- Integrate Duly Noted capture and preserve notebook, pen, canvas, relational, mobile, and share paths.

**Exit:** project knowledge is shared, attributable, searchable, recoverable, and not dependent on localStorage or one UI.

### Phase 3: Symbolic repository evidence

- Implement repository/symbol ingest with stable identities and bounded fingerprint storage.
- Establish neutral IR and typed evidence relations using the Gegenbauer Python/Rust fixture and hard negatives.
- Publish relations to HAM and expose why-surfaced evidence in Galaxy Brain.
- Share the evidence envelope with Rosetta.

**Exit:** cross-language and mathematical relations are discoverable with calibrated uncertainty and reproducible promotion evidence.

### Phase 4: Promote-to-task and bounded execution

- Add request admission, task mandate, capability preflight, AgentRun controller, context packets, checkpoints, cancellation, resume/retry, blockers, gates, and review.
- Add provider-neutral sandbox/workspace broker adapters.
- Make deterministic checks and independent review required by policy before completion.

**Exit:** an authorized executor can complete a task in a bounded environment while a blocked executor can escalate honestly and recoverably.

### Phase 5: Revocable delegated effects

- Add signed, expiring, attenuated delegation and capability leases with revocation.
- Permit narrowly scoped steward proposals and documentation PRs through separately admitted tasks.
- Add post-deployment measurement and rollback recommendations.
- Keep merge, deploy, destructive operations, identity, finance, and credential administration separately controlled.

**Exit:** bounded effects are attributable and revocable without turning the project steward or agent harness into ambient authority.

## 23. Migration from the Current Product

1. Mark this PRD as authoritative for shared workspace behavior; retain older local/personal assumptions only as historical context.
2. Inventory browser-local nodes, revisions, canvases, and external artifacts; assign stable IDs and import provenance before changing writes.
3. Introduce canonical artifact/revision APIs behind existing views, then migrate one object type at a time.
4. Do not infer ACLs from existing visibility. Default imported private/local data to the narrowest defensible scope and require explicit widening.
5. Preserve existing HAM IDs and link them to imported artifacts rather than re-ingesting blindly.
6. Rename or deprecate HAM `access_count` as a surface/impression counter before ranking experiments.
7. Preserve current PostgreSQL inbox and handoff lifecycle; extend addressing, delivery, and channels rather than rebuilding it.
8. Migrate stdio MCP clients one at a time after remote preview and client compatibility proof; retain fallback until usage and process-leak evidence justify removal.
9. Keep Yjs for selected human collaborative surfaces while moving durable history, deletion, and agent writes to canonical revisions.
10. Treat current component-rich UI as reusable surfaces over the new contracts, not as proof that backend persistence and authority are complete.

## 24. Acceptance Criteria

### 24.1 Contract spine

- Stable IDs distinguish conversation, task, run, artifact, location, surface, checkout, environment, principal, and endpoint.
- Every mutation is authorized, attributable, idempotent or CAS-protected, versioned, and auditable.
- ACLs are enforced before retrieval and disclosure.

### 24.2 Remote HAM

- Exact preview SHA is visible and matches source.
- A real MCP SDK performs TLS initialize, tools/list, `ham_context`, and one isolated idempotent write through the proxy.
- Invalid/missing/admin/revoked/cross-scope credentials fail correctly.
- Allowed and denied Host/Origin/CORS cases pass.
- Retry after an ambiguous disconnect does not duplicate the write.
- 2025-era Streamable HTTP clients and the chosen current clients pass; stdio still passes.
- Atlas compatibility is demonstrated or a named incompatibility is documented before considering any legacy transport.

### 24.3 History and recovery

- Stale artifact writes are rejected.
- Delete creates a tombstone and Trash entry.
- Restore creates a new head without losing references or history.
- Deleting a view or location does not delete canonical content.

### 24.4 Task safety

- A board post cannot execute a task without admission.
- Preflight catches a missing required capability.
- A blocker preserves checkpoint and requests the smallest safe remedy.
- Deterministic gates run before review.
- The author cannot approve its own task where independence is required.
- Revoking a grant prevents the next protected effect.

### 24.5 Retrieval telemetry

- Surface, inspect, reference/use, outcome, revisit, and dismiss are distinguishable.
- Telemetry joins to task/run/harness facts without raw cross-scope leakage.
- Existing surface counts are not treated as usefulness.

### 24.6 Symbolic evidence

- The known Python/Rust Gegenbauer pair is retrieved together.
- Perturbed, Chebyshev, and normalized hard negatives are not promoted incorrectly.
- Domain qualification is visible.
- Promotion to behavioral or formal equivalence requires reproducible evidence.

## 25. Open Decisions

1. Which minimum principal proof and delegation format ships first: a narrow Gnostr-style capability profile, another signed token format, or an internal contract with adapters?
2. Should a project have one steward principal with multiple profiles or several specialized steward principals?
3. Which steward actions at levels 1-4 can run automatically versus require human review?
4. Which parts of Entity Alias Context should be adopted directly, profiled, or adapted?
5. Which Hyades event schemas and IDs already satisfy retrieval/task joins?
6. Which sandbox provider should implement the first broker adapter and capability tiers?
7. Should cross-channel threads become one conversation or linked conversations when audience policies differ?
8. What minimum control surface remains available during editor, indexer, sync, or execution-host failure?
9. What retention and legal hold policies govern Trash, imported messages, and signed moderation events?
10. Which public/link sharing combinations allow indexing, download, re-share, or model use?
11. Which exact symbolic IR and parser versions form the first stable evidence contract?
12. Which production-scale retrieval benchmark set best complements LoCoMo with repository lineage and useful-set discovery?

## 26. Provenance

This PRD reconciles the earlier Galaxy Brain planning documents (`MASTERPLAN.md`, `PHASE1_SPEC.md`, `ARCHITECTURE.md`) with the shared human-agent workspace direction. This PRD defines product requirements; each implementation slice still requires an admitted task, appropriate capabilities, evidence, and review.
