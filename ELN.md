# Electronic Lab Notebook (ELN)

> **Historical feature note:** implementation has moved beyond several planned
> items below. The ELN remains a canonical versioned research-object plugin
> projected through Record, Canvas, Graph, and Markdown views. The authoritative
> remaining roadmap and ingestion decisions are in
> [`docs/GALAXY_V2_IMPLEMENTATION_PRD.md`](docs/GALAXY_V2_IMPLEMENTATION_PRD.md).
> Attachments retain original artifacts and may derive both Docling structure
> and MarkItDown representations; they are not reduced to one Markdown blob.

A structured, searchable lab notebook built on top of Galaxy Brain's HAM memory backend. Captures experimental records — protocols, observations, results, and conclusions — and makes them retrievable via semantic and temporal search.

## Vision

Scientists and researchers keep notes in scattered documents, spreadsheets, and paper notebooks. The ELN brings those records into Galaxy Brain where every entry is:

- **Semantically indexed** via HAM (Clifford algebra encoding, no GPU required)
- **Temporally anchored** via phase rotors — entries from a given experiment, date, or project cluster naturally
- **Connected** — protocols link to results, results link to conclusions, everything cross-references
- **AI-assisted** — BitNet generates tags and summaries at ingestion; the RAG chat endpoint lets you query your entire notebook in natural language

## Core Concepts

| Concept | Description |
| --- | --- |
| **Experiment** | Top-level container: hypothesis, protocol, timeline |
| **Entry** | A dated observation, result, or note within an experiment |
| **Protocol** | Reusable step-by-step procedure that entries can reference |
| **Sample** | A tracked material or specimen with provenance chain |
| **Attachment** | Raw file (PDF, image, data) converted to Markdown via MarkItDown |

## Planned Features

- [ ] Experiment creation and management
- [ ] Structured entry editor (hypothesis → method → results → conclusion)
- [ ] Protocol library with versioning
- [ ] Sample / reagent tracking with lot numbers and provenance
- [ ] File attachments (PDF, DOCX, images, CSV data) via MarkItDown
- [ ] Temporal search — "show me everything from last week's cell culture run"
- [ ] Cross-experiment search via HAM fused retrieval
- [ ] RAG chat over the full notebook (`POST /chat`)
- [ ] Export to PDF / structured JSON
- [ ] Code execution via Roo-Code headless stdin stream API (Phase 3)

## Stack

| Layer | Technology |
| --- | --- |
| Frontend | Next.js 15, React 19, Tailwind, shadcn/ui |
| Memory backend | HAM (pg_ham) on port 8042 |
| File conversion | MarkItDown on port 8043 |
| Database | PostgreSQL 16 + pgvector + pg_trgm |
| LLM enrichment | BitNet b1.58 2B-4T (optional, local) |

## Development

This feature lives on the `eln` branch. Services start with:

```bash
docker compose up --build
```

Or individually:

```bash
# Optional HAM memory plugin
# Run a compatible HAM service separately and set HAM_API_INTERNAL.

# MarkItDown
cd services/markitdown-server && uvicorn server:app --port 8043

# Frontend
pnpm dev
```

## PRD

PRD to be linked here once finalized.
