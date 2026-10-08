# Galaxy Brain Plugin Architecture

This document defines the Galaxy Brain v2 extension boundary. The canonical
roadmap and product decisions live in
[`docs/GALAXY_V2_IMPLEMENTATION_PRD.md`](docs/GALAXY_V2_IMPLEMENTATION_PRD.md).

## Definition

A **plugin** is a versioned feature bundle. It may contribute any bounded
combination of commands, sources, transforms, ingestion-plan IDs, projectors,
surface renderers, agent tools, server routes, and optional connection types.

A **connector** is a configured instance used by a plugin when an external
system is required. Examples include a GitHub repository, Prove2Me endpoint,
watched folder, or remote document store. A connector is not a plugin category,
and a feature that needs no external configuration has no connector.

Plugins extend behavior; they do not replace Galaxy's canonical identity,
revision, artifact, placement, relation, authorization, or provenance models.
They exchange canonical references and validated envelopes rather than database
rows or React props.

## Contribution model

The implemented `galaxy-plugin.v1` manifest has one contribution vocabulary:

```json
{
  "schemaId": "galaxy-plugin.v1",
  "id": "paper-research",
  "version": "1.0.0",
  "contributes": {
    "commands": ["paper.import", "paper.clip", "paper.enhance"],
    "sources": ["file", "url", "arxiv"],
    "transforms": ["pdf.markdown", "pdf.structure"],
    "projectors": ["paper.card", "paper.reader", "paper.atomic"],
    "surfaceRenderers": [],
    "agentTools": ["paper.open", "paper.anchor.create"],
    "routes": ["paper.import"],
    "ingestionPlans": ["paper.upload-default"]
  },
  "connections": []
}
```

Contribution semantics:

| Contribution | Responsibility |
| --- | --- |
| `commands` | Typed user/agent actions with explicit inputs and outputs. |
| `sources` | Acquire original bytes or records and preserve source provenance. |
| `transforms` | Produce immutable derived representations and transform receipts. |
| `projectors` | Render an authorized object at declared semantic-zoom levels. |
| `surfaceRenderers` | Render an allowlisted bounded surface contract. |
| `agentTools` | Expose bounded reference-based operations to agents. |
| `routes` | Select fixed server-owned operations; never arbitrary upstream URLs. |
| `ingestionPlans` | Select a frozen, code-owned source-to-durable-object policy by stable ID; never submit workflow code or connector configuration. |
| `connections` | Declare optional external configuration required by contributions. |

A plugin may add a projector without owning the object it renders. A missing
plugin degrades to an unknown-object card that retains identity, provenance,
and a deep link; it does not make a workspace unreadable.

## Runtime and trust boundary

The v1 registry is static, code-owned, and allowlisted. A manifest cannot load
arbitrary browser code or self-register an executable endpoint.
Projector and surface-renderer manifests select only fixed implementation IDs
whose modules are imported by Galaxy source. Removing a projector descriptor
falls back to the common unknown-object projection. Removing a surface-renderer
descriptor preserves the surface object's identity and immutable record but
withholds its rich surface render. Neither case turns manifest data into
executable code.

```text
Browser or agent
  -> authenticated Galaxy command/route
  -> manifest-declared, allowlisted contribution
  -> optional server-owned connector configuration
  -> canonical object/artifact/relation APIs
```

Server routes must:

- require a current Galaxy session or the existing signed agent authority;
- derive tenant and principal identity server-side;
- validate the public contract before selecting an upstream operation;
- ignore browser-supplied ownership or authorization headers;
- use server-owned destination URLs and credentials;
- project upstream responses into bounded Galaxy envelopes;
- apply time, byte, item, and fanout limits;
- record source and transform provenance without copying secrets or raw logs.

The browser may select a registered connection by opaque ID. It may not submit
an arbitrary proxy URL, authorization header, or executable handler.

Ingestion plans follow the same rule. A manifest contributes only a stable plan
ID and selects an allowlisted implementation ID. The browser submits only the
registered plan ID, version, and canonical hash. The server independently
resolves that claim, binds the canonical snapshot to import identity, and
stores the snapshot with append-only source provenance. Plan data cannot add
URLs, headers, modules, callbacks, credentials, arbitrary transforms, or Atlas
geometry. The first built-in plan persists one exact local document original
before requesting the existing durable representation transform. Transform
receipts remain the authority for what actually ran, while Atlas placement is
a separate, independently retryable canvas mutation.

## Canonical data boundary

Plugins consume `gb.object-ref.v1` identities and, when a common read shape is
needed, return `gb.object-projection.v1`. The projection is not a new source of
truth. The resolver for the referenced domain remains responsible for
authorization and revision resolution.

Ingestion plugins preserve four distinct records:

1. the conceptual resource/object;
2. its immutable revision;
3. exact original artifact bytes, addressed by content hash;
4. derived representations and their versioned transform receipts.

The registered ingestion-plan snapshot is provenance for that process; it is
not a fifth mutable workflow record. A failed optional derivative returns the
committed original confirmation and may be retried without repeating or
rolling back the import.

Docling is the structure-rich adapter for supported PDF, DOCX, and HTML inputs.
It preserves reading order, page coordinates, headings, tables, figures, and
formula regions before normalization into Galaxy's versioned document envelope.
MarkItDown is the lightweight Markdown/text adapter and bounded fallback. Neither
library-specific model becomes the canonical database schema, and failure of a
derived transform never invalidates the stored original artifact.

## Initial built-ins

- core object projection and canvas;
- paper/PDF/HTML/Markdown research;
- ELN;
- task and proof coordination;
- HAM memory and search;
- Docling and MarkItDown transform adapters;
- Generous bounded surfaces;
- Prove2Me import/export;
- code viewer/editor;
- voice capture/transcription.

Prove2Me is an interoperable plugin/provider, not the owner of Galaxy's durable
proof graph. Imported or synchronized mission structures retain remote IDs and
provenance, while Galaxy keeps its immutable content-addressed proof DAG usable
when Prove2Me is unavailable.

## Current proxy mapping

Existing routes remain bounded adapters behind the v1 registry:

| Feature | Internal environment | Host route |
| --- | --- | --- |
| HAM search | `HAM_API_INTERNAL` | `/api/ham/search` |
| ELN | `GALAXY_API_INTERNAL` | `/api/eln/*` |
| Generic registered plugins | code-owned registry | `/api/plugins/{plugin}/*` |

HAM and MarkItDown are represented in the contribution model without a behavior
change. New product categories must not be added to the legacy type-based
compatibility manifest.

## Templates and task construction

Templates and task plans are canonical versioned Galaxy objects. Plugins may
contribute constructors, schemas, or commands for them, but their storage and
history do not depend on the plugin remaining installed.

The focused Task Constructor interaction is rebuilt as a task projector over a
goal, bounded context references, atomic jobs, typed dependencies, branch/join
structure, approvals, executor binding, and versioned outputs. This preserves
the useful constructor workflow without retaining the Flowise-derived editor or
making arbitrary workflow nodes a plugin execution surface.

## Compatibility rule

`galaxy-plugin.v1` is the canonical static contribution registry. Older
plugin-registry contracts are compatibility adapters only. Projector and
surface-renderer contributions remain data-only selectors for code-owned
implementations: a fixture may declare a descriptor, but it cannot supply a
module, component, URL, or browser executable.
