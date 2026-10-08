# Galaxy Brain Master Plan

> **Historical plan:** this document records the earlier component/surface
> exploration. It is not the current implementation contract. The canonical v2
> roadmap, primitive vocabulary, ownership boundaries, plugin model, and PR
> order are in
> [`docs/GALAXY_V2_IMPLEMENTATION_PRD.md`](docs/GALAXY_V2_IMPLEMENTATION_PRD.md).
> In particular, use canonical versioned objects and projections rather than
> the draft `KnowledgeNode`/`SurfaceComponent` model below, and use feature
> plugins with optional connectors rather than datasource plugins as the top
> level abstraction.

## Purpose

This document is the build plan for turning the current Galaxy Brain codebase into an AI-first knowledge management demo that combines:

- Galaxy Brain / Quivr-style ingestion and parsing of "anything"
- AFFiNE-style local-first canvas, sync, and web clipping
- Generous Works / A2UI-style component-native rendering instead of block-native editing
- sharable collaboration patterns closer to Excalidraw and Google Docs

This is intentionally a "mother of all demos" plan: opinionated, ambitious, and staged so we can ship meaningful slices without waiting for the entire platform to exist.

## Source inspirations

- the earlier Galaxy Brain prototype
  - broad file compatibility
  - second-brain / AI assistant behavior
  - public/private sharing model
- the AFFiNE-inspired local-first prototype
  - local-first collaborative surfaces
  - docs + canvas fusion
  - web clipper and spatial workspace behavior
- the Generous Works streaming-UI prototype
  - streaming generative UI
  - component catalog
  - dual rendering pipeline
- `https://github.com/DavinciDreams/a2ui-canvas`
  - A2UI protocol
  - structured agent-driven surfaces
  - schema-bound components and renderers

## Product thesis

Galaxy Brain should not be "Notion with AI."

It should be:

- a local-first infinite canvas that is itself writable
- an AI-native ingestion and synthesis system
- a component-based workspace where rich views are assembled from composable templates
- a voice-native workspace where speaking is a first-class input, not an afterthought
- a context-sensitive interface that adapts tools and actions to the user's current object, selection, and intent
- an extensible platform that can plug into external datasources the way Obsidian plugins extend a vault
- a shareable collaborative environment where notes, sources, and AI outputs live in the same graph

The core product bet is:

`knowledge objects + component templates + AI-generated surfaces` beats `documents made of opaque blocks`.

## Vision statement

Galaxy Brain is a local-first, AI-native knowledge workspace where the primary surface is an infinite writable canvas: anything can be dropped in, clipped, parsed, auto-tagged, linked, written on directly, rendered as composable components, and shared as live collaborative surfaces.

## Non-goals

These are explicitly out of scope for the first major demo:

- rebuilding all of AFFiNE's editor internals
- rebuilding all of Quivr's auth / marketplace / SaaS concerns
- unrestricted AI-generated React execution for every surface
- enterprise admin, billing, or multi-tenant architecture
- perfect multiplayer across every UI mode before the core knowledge loop works

## Design principles

1. Local-first by default.
2. AI is a participant in the knowledge loop, not just a chatbot.
3. Every imported artifact becomes a durable knowledge object.
4. The infinite canvas is the primary writing surface, not just a presentation surface.
5. Components are first-class; rich text is just one component among many.
6. Templates should be composable and schema-driven, not hardcoded page types.
7. Voice should work anywhere meaningful work happens.
8. Menus and actions should be contextual, not globally overwhelming.
9. Sharing must feel lightweight and obvious.
10. External datasources should enter through a clean connector/plugin contract.
11. The first demo should be impressive, but built on primitives that scale.

## Product model

The system should be modeled around these primitives:

- `KnowledgeNode`
  - any source item: note, PDF, webpage, image, experiment, clip, transcript, spreadsheet, AI output
- `Relation`
  - semantic or authored links between nodes
- `Surface`
  - a visible workspace, with the infinite writable canvas as the primary form
- `SurfaceComponent`
  - a rendered component instance on a surface
- `Template`
  - a reusable component composition with bindings and layout rules
- `Collection`
  - a saved query or curated set of nodes
- `ShareLink`
  - a public or private access path to a surface, component, node, or snapshot
- `SyncOp`
  - a local-first operation used for collaboration and replay
- `DatasourcePlugin`
  - a connector definition that can enumerate, fetch, sync, and normalize external content into `KnowledgeNode`s
- `IntentContext`
  - the current object, selection, surface, cursor state, and inferred user intent used to drive menus and AI actions
- `VoiceSession`
  - transcript, utterance timing, current mode, and action routing state for voice-native interaction

## Architecture direction

The target architecture should have five layers.

### 1. Ingestion layer

Responsibilities:

- drag-and-drop file ingestion
- paste URL ingestion
- clipboard ingestion
- web clipper ingestion
- datasource plugin ingestion
- background parsing and normalization
- MIME-aware preview extraction

Supported inputs for the demo:

- markdown, txt, pdf
- docx, pptx, xlsx, csv
- html, web pages, pasted links
- images with OCR-ready hooks
- audio/video as future-ready placeholders
- plugin-provided records from external systems

Existing assets we can reuse now:

- MarkItDown service in this repo
- current HAM ingest flow
- current frontend document import patterns

### Datasource plugin model

Galaxy Brain should support external datasources through a plugin/connector contract rather than one-off integrations.

Examples:

- local folders / vaults
- Git repositories
- Google Drive / Docs
- Notion exports or APIs
- email inboxes
- RSS feeds
- Zotero / reference libraries
- Slack / Discord / chat archives
- databases and internal APIs

Each datasource plugin should be responsible for:

- authentication or path configuration
- listing available items
- fetching raw content
- incremental sync using source-native cursors or timestamps
- mapping external records into the normalized ingestion contract
- storing provenance so nodes can be refreshed or traced back

Core app responsibilities:

- plugin registration and lifecycle
- permission and secret handling
- scheduling sync jobs
- deduplication and normalization
- unified UI for connected datasources

### 2. Knowledge layer

Responsibilities:

- canonical node storage
- metadata, tags, summaries, embeddings
- relation graph
- full-text + semantic retrieval
- provenance tracking
- version history for edited knowledge objects

Storage model:

- PostgreSQL remains the system of record
- HAM remains the retrieval/memory engine
- raw file asset refs are stored separately from parsed content
- every node should preserve datasource provenance so sync and refresh are possible

### 3. Surface layer

Responsibilities:

- infinite writable canvas as the default surface
- freeform placement plus structured layouts
- rendering knowledge through components
- template application
- progressive enhancement from simple writing to rich boards on the same surface
- context-sensitive action surfaces
- keyboard, pointer, and voice parity where possible

Key decision:

We should not center the data model on block trees, nor on a separate document mode.

Instead:

- a surface contains positioned or ordered component instances
- components bind to nodes, collections, or queries
- rich text is implemented as one component type
- the canvas itself is writable through text, note, quote, and other editable components placed directly on the infinite surface

### Infinite writable canvas

The default mental model should be:

- one infinite canvas
- everything lives on it
- writing happens directly on it
- structure emerges through components, templates, and layout

This means:

- users should not need to "switch into a doc" to write
- notes, summaries, quotes, annotations, and AI outputs should be placeable and editable directly on the canvas
- templates should arrange writable components on the same surface rather than opening a separate editor paradigm

The canvas should feel like:

- Excalidraw in freedom
- AFFiNE in mixed media
- but component-native and knowledge-aware

### Context-sensitive menus

Menus should be driven by context instead of static toolbars.

The action system should consider:

- current surface type
- selected component type
- selected text or node count
- current user role
- whether the user is typing, dragging, speaking, or browsing
- AI-inferred likely next actions

Examples:

- selecting a PDF node surfaces `summarize`, `extract entities`, `compare with...`, `add to board`
- selecting text surfaces `quote`, `explain`, `tag`, `turn into note`, `ask AI`
- right-clicking a template-backed component surfaces layout and data actions specific to that component
- opening a board in presentation mode reduces authoring actions and prioritizes navigation and sharing

This should feel closer to Figma, Excalidraw, and modern command palettes than a traditional app menu bar.

### 4. AI orchestration layer

Responsibilities:

- summarize imported content
- auto-tag and classify content
- extract entities and relations
- suggest templates
- generate A2UI-compatible surfaces
- answer questions over a surface or collection
- infer likely actions for context-sensitive menus
- route voice commands into safe structured intents

Guardrails:

- AI may propose components only from the approved catalog
- templates and schemas constrain output shape
- arbitrary JSX generation is not the default path for the first demo

### 5. Sync and sharing layer

Responsibilities:

- local-first persistence
- offline-capable editing
- sync ops for collaboration
- public snapshot links
- live shared editing
- comments and annotations

Target feel:

- open a link and immediately see the board
- collaborate live with low ceremony
- publish a clean read-only view when needed
- share a single useful component without having to publish the whole board

## Shareable units

Sharing should exist at more than one level.

Primary share targets:

- `Surface`
  - share the full board, canvas, or workspace
- `SurfaceComponent`
  - share a single component such as a summary card, quote, graph, or experiment panel
- `KnowledgeNode`
  - share one imported artifact or note as a standalone item

This matters because a lot of real knowledge work is "send me just that one thing," not "open my whole workspace."

Examples:

- share one summary card with a collaborator
- publish a single graph or experiment result panel
- send one quote block or note card as a link or embed
- embed one component in another board later

## Voice-native interaction

Voice should be treated as a core input channel, not just dictation.

Core modes:

- `Dictate`
  - insert or revise text in the active writing component on the canvas
- `Command`
  - issue structured commands such as "summarize this", "make a board from these three sources", or "tag this as KAN research"
- `Navigate`
  - move around surfaces, open nodes, zoom canvas, switch views
- `Collaborate`
  - leave spoken comments, record audio notes, or turn a discussion into structured artifacts

Voice-native means:

- push-to-talk and hands-free variants
- visible transcript and action confirmation
- disambiguation when intent is uncertain
- reversible actions
- context-aware routing based on current selection and surface

High-value voice examples:

- "Clip this page and add it to the current board"
- "Compare these two papers"
- "Turn this meeting audio into action items and a research note"
- "Create a timeline from everything tagged memory retrieval"
- "Share this board read-only"

## Context engine

To support both voice and menus, the app should maintain a lightweight context engine.

The engine should assemble:

- active surface
- selected nodes/components
- selection type
- current mode
- recent user actions
- related knowledge candidates from HAM
- datasource capabilities for the selected node or collection
- allowed actions from the current template/component schemas

Outputs:

- context menu items
- command palette ranking
- voice intent routing
- inline AI suggestions
- default follow-up actions after ingest
- datasource-specific actions such as `refresh from source`, `open origin`, or `sync folder`
- share-target options for the current surface, component, or node

## Why components instead of blocks

The current opportunity is bigger than another block editor.

Blocks are good for writing systems, but this project needs richer knowledge views:

- source cards
- summaries
- citation clusters
- entity chips
- graph views
- timelines
- experiment panels
- canvases
- AI action cards
- semantic search result panels

These are better modeled as typed components with schemas and bindings.

The writing experience can still be excellent, but the platform core should be component-native and canvas-native.

## Template strategy

Templates should be the primary authoring abstraction.

Each template should define:

- allowed component types
- starter layout
- required data bindings
- optional AI-generated sections
- editing affordances

Initial template set:

- `Research Board`
- `Paper Brief`
- `Source Comparison`
- `Experiment Record`
- `Knowledge Map`
- `Project Hub`
- `Clip Review Board`

Long-term goal:

- users can compose templates from smaller template fragments
- AI can suggest or generate template instances from user intent

## Canonical schema draft

This is the minimum schema we should build toward.

```ts
type KnowledgeNode = {
  id: string
  type:
    | "note"
    | "document"
    | "webpage"
    | "clip"
    | "image"
    | "experiment"
    | "dataset"
    | "conversation"
    | "summary"
  title: string
  content?: string
  sourceType: "upload" | "url" | "clipper" | "manual" | "ai"
  mimeType?: string
  rawAssetRef?: string
  parsedAssetRef?: string
  metadata: Record<string, unknown>
  tags: string[]
  embeddingRef?: string
  createdAt: string
  updatedAt: string
}

type Relation = {
  id: string
  fromId: string
  toId: string
  relationType: string
  confidence?: number
  provenance?: string
}

type Surface = {
  id: string
  title: string
  kind: "doc" | "canvas" | "board" | "workspace"
  createdAt: string
  updatedAt: string
}

type SurfaceComponent = {
  id: string
  surfaceId: string
  componentType: string
  templateKey?: string
  bindings: Record<string, unknown>
  props: Record<string, unknown>
  layout: Record<string, unknown>
}

type IntentContext = {
  surfaceId?: string
  selectedNodeIds: string[]
  selectedComponentIds: string[]
  mode: "browse" | "edit" | "present" | "voice"
  selectionType?: "text" | "node" | "component" | "multi" | "none"
  allowedActions: string[]
}

type VoiceSession = {
  id: string
  status: "idle" | "listening" | "processing" | "confirming"
  transcript: string
  inferredIntent?: string
  targetSurfaceId?: string
}

type DatasourcePlugin = {
  id: string
  kind: "filesystem" | "cloud" | "api" | "chat" | "reference"
  displayName: string
  capabilities: ("list" | "fetch" | "sync" | "watch" | "search")[]
}
```

## Recommended technical direction

### Frontend

- keep Next.js + React
- evolve the current frontend into an infinite-canvas app shell
- borrow the component registry idea from Generous Works
- use A2UI-compatible structured messages for AI-generated views
- add a unified action system used by command palette, right-click menus, floating toolbars, and voice actions

### Backend

- keep PostgreSQL + HAM + Galaxy Brain API
- treat MarkItDown as the parsing gateway for document formats
- add a normalization pipeline for URL and clipper ingestion
- add intent/action endpoints that can safely translate voice and contextual requests into structured operations
- add a datasource plugin layer so external systems feed the same normalized ingest contract

### Collaboration

- introduce a sync abstraction early
- prefer CRDT or op-log semantics at the surface layer
- do not bind collaboration directly to one editor implementation

### Extensibility

- datasource plugins should be installable/configurable without changing core ingestion logic
- all plugins must emit the same normalized contract
- plugin capabilities should drive UI affordances and actions

### AI

- use AI for extraction, enrichment, and surface generation
- keep all high-value AI output storable as nodes
- every summary, tag set, and generated surface should be inspectable and reproducible
- use AI to rank actions, resolve ambiguous voice commands, and propose context-aware next steps

## Phased roadmap

## Phase 0: Architecture alignment

Goal:

- define the primitives and remove ambiguity before feature sprawl begins

Deliverables:

- this `MASTERPLAN.md`
- schema definitions for node/surface/component/template
- decision on local-first sync strategy
- component catalog scope for v1

Success criteria:

- the team can describe the product with one architecture diagram
- new work can be mapped to a primitive rather than bolted on ad hoc

## Phase 1: Demo spine

Goal:

- prove the full loop from ingestion to AI-shaped shareable surface

Scope:

- drag/drop files into the app
- paste a URL into the app
- define the datasource plugin contract and support one local plugin path
- parse into normalized knowledge nodes
- auto-generate summary + tags
- create one surface type: `Research Board`
- render with component instances, not block trees
- make the board itself writable on the infinite canvas
- add a minimal context menu system for nodes, text selections, and components
- add a first voice command path for high-value actions
- save locally
- generate a shareable read-only link or snapshot

Suggested `Research Board` components:

- source list
- document preview
- summary card
- extracted tags
- related nodes panel
- freeform notes component
- graph or timeline component

Success criteria:

- a user drops in a PDF, a markdown file, and a URL
- the system ingests them within one workflow
- at least one datasource plugin path can import content through the same normalized pipeline
- AI creates a useful board automatically
- the user can trigger at least one useful action by voice
- the user sees contextual actions without hunting through menus
- the result is shareable

## Phase 2: Local-first surfaces

Goal:

- make surfaces durable and pleasant to edit locally

Scope:

- local persistence for surfaces and nodes
- surface operation model
- undo/redo
- optimistic editing
- offline reopen behavior
- persisted command history and voice transcript linkage where appropriate

Success criteria:

- user can close and reopen without losing recent edits
- editing remains responsive without round-trip dependence

## Phase 3: Web clipper

Goal:

- bring external knowledge directly into the same graph

Scope:

- browser extension or bookmarklet MVP
- clip full page, article selection, or simplified view
- send source URL + HTML + text + metadata into ingestion pipeline
- generate clipped-node previews in the app
- keep clipper transport compatible with the broader datasource plugin contract

Success criteria:

- clip a page from the browser into Galaxy Brain
- it appears as a node and can be added to a board immediately

## Phase 4: Collaboration and sharing

Goal:

- reach the "Excalidraw / Google Docs" feel for shared artifacts

Scope:

- live surface presence
- cursor awareness
- comments
- share links
- read-only publish mode
- edit permissions for trusted collaborators
- voice comments / audio-note to text workflows

Success criteria:

- two users can view and edit the same surface
- a public link can show a clean published board

## Phase 5: AI-native knowledge workflows

Goal:

- make the system feel meaningfully smarter than a generic workspace

Scope:

- semantic and relational retrieval over nodes
- "ask this board" and "ask this collection"
- AI-generated collections
- suggested links and related work
- auto-generated comparison boards and project hubs
- context-aware action recommendations based on current work state

Success criteria:

- the app can answer questions using imported knowledge
- users can generate a new useful surface from an intent prompt

## Phase 6: Template platform

Goal:

- make the system extensible and reusable

Scope:

- template authoring
- template composition from smaller fragments
- AI-assisted template creation
- import/export of templates
- pluggable datasource ecosystem and connector settings UI

Success criteria:

- a user can create and reuse their own workflow surface
- templates become the main way teams standardize work

## Immediate MVP recommendation

If we want the strongest near-term build target, we should implement this exact slice first:

1. Ingest files and URLs into a canonical `KnowledgeNode`.
2. Define a datasource plugin contract that feeds the same normalized ingestion path.
3. Run parsing plus AI enrichment for title, summary, tags, and source metadata.
4. Create a `Research Board` surface automatically after ingest.
5. Render that board on the infinite writable canvas from a small approved component catalog.
6. Add contextual menus for the key object types on the board.
7. Add one voice-native command loop for create/summarize/share actions.
8. Persist it locally.
9. Expose a shareable snapshot link.

This slice is small enough to build, but broad enough to prove the whole thesis.

## Proposed component catalog for v1

Keep the initial component set intentionally tight:

- `RichText`
- `SourceList`
- `DocumentPreview`
- `SummaryCard`
- `TagCluster`
- `EntityList`
- `RelatedNodes`
- `Timeline`
- `KnowledgeGraph`
- `ImageCard`
- `LinkCard`
- `QuoteCard`
- `ExperimentPanel`
- `VoiceComposer`
- `ActionMenu`
- `CommandSuggestions`

Each component should have:

- schema
- empty state
- loading state
- AI-safe prop contract

## Proposed implementation tracks

These tracks can run in parallel once the schema and surface model are agreed.

### Track A: Ingestion and parsing

- formalize import pipeline
- add URL ingestion endpoint
- define normalized parser output contract
- define datasource plugin contract and provenance model

### Track B: Surface engine

- create `Surface` and `SurfaceComponent` model
- define the infinite-canvas layout model first
- render from typed component registry

### Track C: AI enrichment

- title generation
- summarization
- auto-tagging
- relation extraction

### Track D: Sharing

- snapshot representation
- public route for surface viewing
- minimal permission model
- shareable component and node targets

### Track E: Clipper

- browser-side capture flow
- server-side import endpoint
- clip preview and deduplication rules

### Track F: Voice and context

- action registry with context-aware filtering
- voice capture UI and transcript handling
- intent parsing for a small safe command set
- contextual toolbar and right-click menu primitives

### Track G: Datasource plugins

- plugin manifest and capability model
- one local filesystem or vault connector as the first reference plugin
- connector config UI and sync trigger
- source provenance and refresh actions

## Risks and how to avoid them

### Risk: accidental block-editor gravity

Mitigation:

- keep block trees out of the canonical model
- make components and bindings the primary unit

### Risk: canvas becomes read-only decoration

Mitigation:

- require writing workflows to happen directly on the canvas
- treat editable text/note components as first-class surface citizens
- avoid splitting authorship into a separate document-only mode

### Risk: parser sprawl

Mitigation:

- every parser must emit the same normalized contract
- raw assets and parsed output are stored separately

### Risk: plugin ecosystem becomes bespoke per integration

Mitigation:

- require every datasource to implement the same connector lifecycle
- separate connector fetch from normalization and storage
- preserve source provenance and sync cursors centrally

### Risk: AI rendering chaos

Mitigation:

- AI can only choose from approved templates and components
- validate all props through schemas

### Risk: collaboration becomes the entire project

Mitigation:

- ship read-only snapshots before full live co-editing
- isolate sync ops from rendering concerns

### Risk: voice becomes gimmicky or noisy

Mitigation:

- start with a narrow, high-confidence command set
- always show transcript plus action preview
- require confirmation for destructive or ambiguous operations

### Risk: context menus become cluttered

Mitigation:

- filter actions by object type and mode
- rank likely actions and hide low-value ones
- unify the same action registry across menus, palette, and voice

### Risk: impressive demo, fragile foundation

Mitigation:

- only demo flows that use the real schema and storage primitives
- avoid fake one-off UI paths

### Risk: sharing model only works for whole documents

Mitigation:

- treat surface, component, and node sharing as first-class targets
- keep share links target-typed rather than surface-only

## First build backlog

These are the highest-value next tasks after approving this plan.

1. Define TypeScript types for `KnowledgeNode`, `Surface`, `SurfaceComponent`, `Template`, and `Relation`.
2. Add database tables or persistence structures for surfaces and components.
3. Implement a normalized ingestion contract returned by file and URL import flows.
4. Build a small component registry for the v1 catalog.
5. Create `Research Board` as the first template.
6. Add AI enrichment job for title, summary, and tags.
7. Define an action registry and `IntentContext` contract.
8. Build context menus for node, text-selection, and component states.
9. Add one voice-native command flow with transcript + confirmation UI.
10. Define a datasource plugin manifest and first connector contract.
11. Implement one reference datasource plugin, ideally local filesystem/vault.
12. Add shareable links for surfaces, single components, and single nodes.
13. Scope the web clipper transport contract.

## Suggested success metric for the demo

The demo is successful if a new user can:

- drag in a source
- understand what the AI extracted
- see it arranged on a compelling board
- ask a question about it
- share that board with someone else

without needing a manual setup ritual or explanation-heavy onboarding.

## Recommended next document

After this plan, the next useful artifact should be a short implementation spec for Phase 1:

- exact schema
- first database tables
- first API routes
- first component contracts
- first `Research Board` template definition

That is the point where planning should stop and building should begin.
