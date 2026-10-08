# Phase 1 Spec

## Goal

Phase 1 is the first real product slice of Galaxy Brain as an AI-first knowledge workspace.

By the end of this phase, a user should be able to:

1. drag in a file or paste a URL
2. have it normalized into a `KnowledgeNode`
3. receive AI-generated summary and tags
4. automatically get a `Research Board` on an infinite writable canvas
5. interact with that board through contextual menus
6. trigger at least one useful action by voice
7. save locally
8. share a read-only snapshot
9. bring content in through at least one datasource plugin using the same ingest pipeline
10. share either the whole board or one useful component from it

This phase is the proving ground for the product thesis. It should be impressive, but it must be built on primitives we will keep.

## Scope

In scope:

- file ingestion
- URL ingestion
- datasource plugin contract
- one reference datasource plugin
- normalized knowledge schema
- AI enrichment for title, summary, tags
- one surface type: `Research Board`
- infinite writable canvas behavior for that surface
- small typed component registry
- context-sensitive menus
- one voice command loop
- local persistence
- read-only share snapshots

Out of scope:

- full multiplayer collaboration
- general-purpose template authoring UI
- browser extension clipper
- unrestricted AI-generated arbitrary UI
- full voice dictation everywhere
- a large third-party plugin marketplace UI

## User story

"I drop a paper and a link into Galaxy Brain. It parses both, gives me a summary and tags, lays them out on a research board, lets me right-click to compare or summarize, and I can say 'share this board read-only' without digging through menus."

Also valid for Phase 1:

"I point Galaxy Brain at a local vault or folder, it imports content through a datasource connector, and those items behave exactly like manually imported knowledge."

## Deliverables

- schema for `KnowledgeNode`, `Surface`, `SurfaceComponent`, `Template`, `ShareSnapshot`, `IntentContext`, and `VoiceSession`
- datasource plugin manifest and connector contract
- backend endpoints for ingest, enrich, board creation, action execution, and snapshot fetch
- target-typed share model for surfaces, components, and nodes
- `Research Board` template definition
- first component catalog
- action registry and contextual action filtering
- voice command UI with transcript and confirmation

## System boundaries

Phase 1 should reuse the current architecture where possible:

- `services/markitdown-server`
  - document parsing
- `services/galaxy-brain-api`
  - authoritative API for Phase 1 objects beyond HAM
- `lib/ham-service.ts`
  - retrieval and enrichment-adjacent memory functions
- `lib/content-processing-service.ts`
  - frontend-orchestrated parsing/enqueue patterns that can be formalized
- current Next.js frontend
  - app shell and infinite-canvas UI surface work

Phase 1 should also create an explicit seam for external datasources so future connectors do not bypass the core pipeline.

## Canonical Phase 1 data model

These are the minimum objects we should implement now.

```ts
type KnowledgeNodeType =
  | "document"
  | "webpage"
  | "note"
  | "image"
  | "summary"

type KnowledgeNode = {
  id: string
  type: KnowledgeNodeType
  title: string
  content: string
  summary?: string
  sourceType: "upload" | "url" | "manual" | "ai"
  mimeType?: string
  sourceUrl?: string
  rawAssetRef?: string
  parsedAssetRef?: string
  previewAssetRef?: string
  metadata: {
    filename?: string
    extension?: string
    pageTitle?: string
    author?: string
    siteName?: string
    datasourceId?: string
    datasourceItemId?: string
    datasourcePath?: string
    datasourceCursor?: string
    createdFromSurfaceId?: string
    ingestStatus?: "pending" | "parsed" | "enriched" | "failed"
    parseWarnings?: string[]
  }
  tags: string[]
  createdAt: string
  updatedAt: string
}

type Relation = {
  id: string
  fromId: string
  toId: string
  relationType: "related" | "source-of" | "summary-of" | "derived-from" | "mentioned-with"
  confidence?: number
  provenance?: string
}

type Surface = {
  id: string
  title: string
  kind: "board"
  templateId: "research-board-v1"
  createdBy: string
  createdAt: string
  updatedAt: string
}

type SurfaceComponent = {
  id: string
  surfaceId: string
  componentType:
    | "SourceList"
    | "DocumentPreview"
    | "SummaryCard"
    | "TagCluster"
    | "RelatedNodes"
    | "RichText"
    | "CommandSuggestions"
  bindings: {
    nodeIds?: string[]
    primaryNodeId?: string
    query?: string
  }
  props: Record<string, unknown>
  layout: {
    x: number
    y: number
    w: number
    h: number
    z?: number
  }
}

type Template = {
  id: "research-board-v1"
  name: string
  allowedComponents: string[]
  starterLayoutVersion: number
}

type ShareSnapshot = {
  id: string
  targetType: "surface" | "component" | "node"
  targetId: string
  access: "public-read"
  snapshotJson: string
  createdAt: string
}

type IntentContext = {
  surfaceId?: string
  selectedNodeIds: string[]
  selectedComponentIds: string[]
  mode: "browse" | "edit" | "voice"
  selectionType: "none" | "node" | "component" | "text" | "multi"
  allowedActions: string[]
}

type VoiceSession = {
  id: string
  status: "idle" | "listening" | "processing" | "confirming"
  transcript: string
  inferredActionId?: string
  inferredArgs?: Record<string, unknown>
  targetSurfaceId?: string
}

type DatasourcePluginManifest = {
  id: string
  displayName: string
  kind: "filesystem" | "cloud" | "api" | "reference"
  capabilities: ("list" | "fetch" | "sync" | "watch")[]
  authType: "none" | "path" | "token" | "oauth"
}
```

## Persistence plan

Phase 1 should add persistence for surface-native concepts in the Galaxy Brain API database.

Minimum new tables:

- `gb_nodes`
- `gb_relations`
- `gb_surfaces`
- `gb_surface_components`
- `gb_share_snapshots`
- `gb_voice_sessions`
- `gb_datasource_plugins`
- `gb_datasource_connections`
- `gb_datasource_sync_runs`

Expected ownership split:

- HAM stores search/memory representations
- Galaxy Brain API stores app-domain objects and shareable surface state
- datasource provenance and sync cursors live in Galaxy Brain API tables

## Ingestion contract

All import paths must emit the same normalized contract.

### Input types

- `multipart/form-data` upload
- JSON URL import
- datasource plugin import

### Normalized parser output

```ts
type ParsedImport = {
  title?: string
  content: string
  mimeType?: string
  sourceUrl?: string
  sourcePluginId?: string
  sourceItemId?: string
  metadata: Record<string, unknown>
  previewAssetRef?: string
  rawAssetRef?: string
  parsedAssetRef?: string
  warnings?: string[]
}
```

### Rules

- parsers may differ internally
- API consumers must never care which parser produced the result
- missing fields should degrade gracefully
- every ingest should be storable before enrichment completes
- datasource imports must not have a separate downstream storage path

## Datasource plugin contract

Phase 1 should define the connector shape even if only one reference plugin ships.

### Goals

- external systems should plug into Galaxy Brain without special-case core logic
- plugin-provided content must become normal `KnowledgeNode`s
- provenance and refresh should be preserved

### Required Phase 1 connector methods

```ts
type DatasourcePlugin = {
  manifest: DatasourcePluginManifest
  listItems?: (connectionId: string) => Promise<DatasourceItem[]>
  fetchItem: (connectionId: string, itemId: string) => Promise<ParsedImport>
  sync?: (connectionId: string, cursor?: string) => Promise<DatasourceSyncResult>
}

type DatasourceItem = {
  id: string
  title: string
  path?: string
  mimeType?: string
  updatedAt?: string
}

type DatasourceSyncResult = {
  nextCursor?: string
  importedItemIds: string[]
}
```

### Reference plugin for Phase 1

Recommended first plugin:

- `filesystem-vault`

Why:

- no external auth required
- useful immediately
- closest to the Obsidian mental model
- exercises path config, listing, fetch, and sync without cloud complexity

Capabilities:

- configure root folder
- list markdown and supported document files
- import selected items
- optionally rescan for changes

### Plugin UI requirements for Phase 1

- simple datasource settings page or modal
- add connection
- choose/configure folder path
- run import
- show last sync status

### Provenance rules

Every imported node should preserve:

- datasource plugin id
- source item id
- human-readable path or origin label
- last known sync cursor or timestamp if available

This enables:

- refresh from source
- open origin
- deduplication
- future incremental sync

## AI enrichment contract

Phase 1 AI enrichment should be intentionally narrow.

Outputs:

- improved title if needed
- summary
- 3 to 8 tags

Optional later fields:

- entities
- relation candidates
- citation extraction

```ts
type EnrichmentResult = {
  title?: string
  summary: string
  tags: string[]
}
```

Behavior:

- ingestion should succeed even if enrichment fails
- enrichment may run asynchronously
- enrichment output should be persisted on the source node
- enriched text can be re-sent to HAM if helpful

## Research Board template

This is the only template in Phase 1.

### Purpose

Turn one or more ingested knowledge nodes into a visually understandable board on an infinite writable canvas.

### Trigger

Create automatically after successful ingest of one or more items, or on demand through action/voice.

### Starter layout

Required components:

- `SourceList`
  - left rail showing imported sources
- `SummaryCard`
  - top center summary of primary source
- `TagCluster`
  - top right tags
- `DocumentPreview`
  - center preview of selected primary node
- `RelatedNodes`
  - right rail for HAM-suggested related items
- `RichText`
  - lower center freeform notes, editable directly on the canvas
- `CommandSuggestions`
  - lower left AI/context suggestions

### Board creation rules

- if one source is present, it becomes `primaryNodeId`
- if multiple sources are present, the first ingested item is primary and the rest appear in `SourceList`
- `RelatedNodes` should be populated from HAM when available, else empty state
- `RichText` should start with a generated seed note:
  - `"What stands out?"`
  - `"What should be compared next?"`
- the user must be able to click into `RichText` and continue writing immediately without leaving the canvas

## Component contracts

Each Phase 1 component must be typed and schema-validated.

### `SourceList`

Purpose:

- show imported nodes for the board

Inputs:

- `nodeIds[]`
- selected node state

Actions:

- select source
- summarize source
- compare source
- remove from board

### `DocumentPreview`

Purpose:

- show parsed text preview or document frame for the selected source

Inputs:

- `primaryNodeId`

Actions:

- ask AI about selection
- extract quote
- add note from selection

### `SummaryCard`

Purpose:

- display AI summary for the selected source

Inputs:

- `primaryNodeId`

Actions:

- regenerate summary
- expand into note
- copy to notes

### `TagCluster`

Purpose:

- show AI and user tags

Inputs:

- `primaryNodeId`

Actions:

- retag
- add tag
- filter board by tag

### `RelatedNodes`

Purpose:

- show HAM-based related items

Inputs:

- `primaryNodeId`

Actions:

- open related node
- add related node to board
- compare related node

### `RichText`

Purpose:

- provide editable note space directly on the infinite canvas

Inputs:

- optional seed content

Actions:

- dictate into note
- summarize note
- convert note to standalone node

### `CommandSuggestions`

Purpose:

- display ranked actions based on `IntentContext`

Inputs:

- current context

Actions:

- invoke suggested action

## Share model

Phase 1 sharing must support more than full-board snapshots.

### Share targets

- `surface`
  - the entire `Research Board`
- `component`
  - one component instance, such as `SummaryCard`, `QuoteCard`, `KnowledgeGraph`, or `ExperimentPanel`
- `node`
  - one source or note item as a standalone share

### Why this matters

Users often want to share:

- just the summary
- just the graph
- just the quote
- just the note

without exposing or requiring the whole workspace.

### Share rules

- all share links are target-typed
- component shares should render with enough context to stand alone
- node shares should render source metadata and content preview
- surface shares remain the default for full-workspace sharing

## Action registry

All menus, command palette entries, and voice commands should route into the same action registry.

### Action shape

```ts
type ActionDefinition = {
  id: string
  label: string
  appliesTo: ("surface" | "node" | "component" | "text-selection" | "multi-selection")[]
  requiresSelection?: boolean
  confirm?: boolean
  argsSchema?: Record<string, unknown>
}
```

### Required Phase 1 actions

- `create_research_board`
- `summarize_node`
- `retag_node`
- `add_to_board`
- `compare_nodes`
- `convert_selection_to_note`
- `share_surface_read_only`
- `open_related_node`
- `set_primary_source`
- `refresh_from_source`
- `sync_datasource`
- `share_component_read_only`
- `share_node_read_only`

### Execution rule

The frontend can request action execution, but the backend should validate:

- action exists
- target objects exist
- required args are present
- action is allowed in the current context

## Context-sensitive menu spec

Phase 1 menus should be small and high-confidence.

### Node menu

Shown when:

- right-clicking source item
- selecting a node card

Actions:

- `Summarize`
- `Retag`
- `Add to Board`
- `Compare With...`
- `Set as Primary`
- `Refresh From Source` when provenance exists

### Text selection menu

Shown when:

- selecting text in preview or notes

Actions:

- `Ask AI`
- `Quote`
- `Turn Into Note`
- `Tag Selection`

### Component menu

Shown when:

- right-clicking component chrome

Actions:

- `Refresh Data`
- `Move`
- `Duplicate`
- `Remove`
- `Share Read-Only`

### Surface menu

Shown when:

- blank canvas / board background

Actions:

- `Create Note`
- `Add Sources`
- `Share Read-Only`
- `Ask This Board`
- `Sync Datasource` when the board contains plugin-backed nodes or a datasource is active

### Node quick actions

When a node is selected, it should expose:

- `Share Source`
- `Refresh From Source` when provenance exists

### Ranking rules

- max 5 primary actions shown by default
- destructive actions require secondary affordance or confirmation
- same registry powers right-click, slash actions, and command palette

## Voice-native command loop

Phase 1 voice support should be command-first, not general conversational audio.

### UI behavior

- mic button on board chrome
- push-to-talk starts capture
- transcript visible immediately
- inferred action preview appears before execution
- user confirms if action is ambiguous or destructive

### Supported commands

High-confidence initial set:

- "summarize this"
- "retag this"
- "add this to the board"
- "make a research board from these sources"
- "share this board read only"

### Voice routing rules

- "this" resolves from current selection
- no selection means ask for clarification
- destructive actions are not supported in Phase 1
- transcript and resolved target should be visible before execution

### Voice output examples

Input:

- "summarize this"

Resolved action:

- `summarize_node`

Input:

- "share this board read only"

Resolved action:

- `share_surface_read_only`

## API routes

These routes are the minimum needed for Phase 1.

### Ingestion

- `POST /nodes/import-file`
  - upload a file
- `POST /nodes/import-url`
  - import a URL payload
- `POST /datasources/{connectionId}/import`
  - import one or more datasource items through a plugin

### Nodes

- `GET /nodes/{id}`
- `POST /nodes/{id}/enrich`
- `POST /nodes/{id}/retag`

### Surfaces

- `POST /surfaces/research-board`
  - create board from one or more node ids
- `GET /surfaces/{id}`
- `PATCH /surfaces/{id}`

### Components

- `PATCH /surfaces/{id}/components`
  - update layout and component props

### Actions

- `POST /actions/resolve`
  - resolve action candidates from `IntentContext` or voice transcript
- `POST /actions/execute`
  - execute validated action

### Sharing

- `POST /surfaces/{id}/share-snapshot`
- `POST /components/{id}/share-snapshot`
- `POST /nodes/{id}/share-snapshot`
- `GET /share/{snapshotId}`

### Datasources

- `GET /datasources/plugins`
- `POST /datasources/connections`
- `GET /datasources/connections`
- `POST /datasources/{connectionId}/sync`
- `GET /datasources/{connectionId}/items`

## Frontend structure

Recommended new frontend modules:

- `lib/types/knowledge.ts`
- `lib/types/surfaces.ts`
- `lib/actions/registry.ts`
- `lib/actions/filter-actions.ts`
- `lib/datasources/plugin-types.ts`
- `lib/datasources/plugin-registry.ts`
- `lib/voice/intent-parser.ts`
- `components/surfaces/research-board.tsx`
- `components/context/action-menu.tsx`
- `components/voice/voice-composer.tsx`
- `components/voice/voice-confirmation.tsx`
- `components/datasources/datasource-connection-dialog.tsx`

## Suggested implementation order

1. Add shared TypeScript types.
2. Add backend schema tables in `services/galaxy-brain-api/schema.sql`.
3. Add node import endpoints.
4. Define datasource plugin manifest and reference connector contract.
5. Persist imported nodes and call enrichment.
6. Add `research-board-v1` surface creation route.
7. Add typed board renderer in the frontend with editable writing directly on the canvas.
8. Add action registry and context menu primitives.
9. Add voice capture UI and transcript-to-action resolution.
10. Add share snapshot route and public view page.
11. Add one reference datasource plugin, preferably `filesystem-vault`.

## Acceptance criteria

Phase 1 is done when:

- a file import creates a durable node
- a URL import creates a durable node
- a datasource plugin import creates a durable node through the same normalized pipeline
- nodes receive summary and tags
- creating a `Research Board` works from imported nodes
- board components render from stored component data
- the board is writable directly on the canvas through the note/text component
- right-clicking a node or component shows useful context actions
- nodes with provenance expose `Refresh From Source`
- saying "share this board read only" produces a share snapshot after confirmation
- saying "share this summary" or using a component menu can share a single component
- a public snapshot route can render the saved board

## Notes on restraint

The main trap in Phase 1 is overbuilding.

Do not:

- introduce full multiplayer yet
- build a giant component library before validating the board flow
- let voice become an unconstrained chat system
- let AI generate unknown component types
- let templates become ad hoc JSON blobs without schema
- let each datasource invent its own storage or rendering path
- let the canvas devolve into a read-only arrangement layer with writing pushed elsewhere

The right Phase 1 result is a narrow, polished slice that makes the larger platform feel inevitable.
