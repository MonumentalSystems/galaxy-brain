# Galaxy Brain Architecture

> **Architecture status:** this file describes the current repository service
> layout. The canonical Galaxy Brain v2 target, ownership decisions, and atomic
> implementation order are in
> [`docs/GALAXY_V2_IMPLEMENTATION_PRD.md`](docs/GALAXY_V2_IMPLEMENTATION_PRD.md).
> Where older component or plugin language conflicts with that PRD, the PRD
> governs.

## Overview

Galaxy Brain is a versioned research workspace. **Harmonic Addressable Memory
(HAM)** is an optional external memory/retrieval plugin; it is not Galaxy's
canonical object store, canvas, or authorization authority.

The system consists of a public Galaxy Brain app plus optional plugin services:

| Service | Port | Purpose |
|---------|------|---------|
| **Galaxy Brain Frontend** | 3000 | Next.js workspace UI |
| **HAM Memory Server** | 8042 | Optional external memory plugin |
| **MarkItDown Service** | 8043 | File format conversion to Markdown |
| **Galaxy Brain API** | 8044 | ELN backend — notebook, entry, and protocol CRUD |

## System Architecture

```
User imports file (PDF, DOCX, PPTX, XLSX, etc.)
  |
  v
MarkItDown Service (port 8043)
  | converts to clean Markdown
  v
Galaxy Brain Frontend (Next.js)
  | creates node, enqueues for processing
  v
External HAM Memory Plugin (port 8042 by default)
  | Tiered ingestion:
  |   IMMEDIATE (<1ms): Clifford centroid + QKPS phasor encode
  |   BACKGROUND (~2s): BitNet 1-bit LLM generates tags + summary
  |   POST /enrich/{id}: re-encodes with enriched text
  v
PostgreSQL + Holographic Fields
  | centroid + spectrum + tags + summary + phase_rotor
  v
Retrieval (multiple paths):
  /retrieve/fused   — QKPS field + centroid + temporal phase (PRODUCTION)
  /retrieve         — 3-channel RRF (spectral + centroid + BM25)
  /retrieve/qkps    — per-doc matched filter
  /retrieve/resonance — holographic superposition field
```

## Retrieval Paths

### Fused Retrieval (`/retrieve/fused`) — Production

The recommended endpoint. Combines three signals:
1. **QKPS phasor field** (30% weight) — lexical matching via holographic superposition
2. **Clifford centroid cosine** (65% weight) — structural/semantic similarity
3. **KAN harmonic spectrum** (5% weight) — trained surface-form tiebreaker (13.4x discrimination)
4. **Temporal phase boost** (20% when detected) — phase rotor scoring for temporal queries

Achieves **8/8 R@1 at 2000 items** on needle-in-haystack, beating SBERT+FAISS (7/8).

### Holographic Field

Multiple field implementations for different use cases:
- **FieldStore** (QKPS per-doc): 5/5 at 4000+ items, matched filter with Q_dB scoring
- **RotorField** (true superposition): Clifford rotor binding/unbinding, dense QKPS projection, Wiener + SIC detectors
- **HarmonicField** (legacy): JL-projected centroid, research only

### Tiered Ingestion

```
Upload -> IMMEDIATE: Clifford + QKPS encode (searchable in <1ms)
       -> BACKGROUND: BitNet b1.58 generates tags + summary (~2s, daemon thread)
       -> /enrich/{id}: stores tags/summary, re-encodes with enriched text
       -> HAM plugin persists its own field state outside this repo
```

No blocking — documents are searchable instantly, then get semantically richer in the background. BitNet enrichment is auto-detected on startup (checks for binary + model at configured paths).

## Per-Memory Storage Schema

Every memory in the HAM field carries multiple representations:

| Column | Type | Dim | Purpose | Status |
|--------|------|-----|---------|--------|
| `content` | text | - | Raw text content | Active |
| `centroid` | vector | 1920 | Cl(6,0) content representation — **what it IS** | Active, 0.40 hit@5 |
| `spectrum` | vector | 128 | JL spectral address — **how you FIND it** (coarse) | Active, 5.73x disc |
| `harmonic_spectrum` | vector | 32 | Gegenbauer address after KAN+Lohe (true harmonics) | Active, 13.4x disc (v2 KAN) |
| `phase_rotor` | float8[] | 8 | Multi-frequency temporal [cos_y,sin_y,cos_m,sin_m,cos_w,sin_w,cos_d,sin_d] | Active |
| `rare_indices` | int[] | var | Defect cache — rare bivector anchor indices | Stored |

## Clifford Encoder Pipeline

The encoder (`symbiotic_memory/clifford_encoder.py`) produces a `CliffordSignature` with no neural embedding model — deterministic at inference, no GPU required.

### Centroid (Content)

```
Text
  → char-trigram extraction (n=3)
  → blake2b hashing into 128 groups × 15 Cl(6,0) bivector slots
  → per-group L2 normalization + global L2 normalization
  → 1920-dim unit vector (centroid)
```

The centroid is the **content representation** — what the memory contains. Retrieval uses cosine similarity via HNSW.

### JL Spectrum (Coarse Address)

```
Centroid (1920-dim)
  → fixed random harmonic basis (Johnson-Lindenstrauss, seed=42)
  → matrix multiply: centroid @ basis
  → 128-dim spectral address
```

The JL spectrum is the **primary retrieval signal**. It inherits the centroid's discrimination (5.73x) while being compact enough for full-field correlation scan (no HNSW index — true resonance).

### KAN Harmonic Spectrum (Surface-Form Tiebreaker)

```
Raw hash-bucket field (128 × 15, pre-normalization)
  → KAN v2 proj_to_osc: Linear(1920,512) → KAN(Chebyshev order=8) → LayerNorm → Linear(512,512) → KAN → LayerNorm → Linear(512,1920) + residual skip
  → reshape to (128, 15) oscillator states on S^14
  → L2 normalize per group
  → Lohe sync (4 steps, K=0.3, dt=0.1) — creates coupled dynamic structure
  → Gegenbauer spectral fingerprint (32 harmonic orders, α=6.5)
  → energy-weighted average across groups
  → 32-dim harmonic address
```

The KAN v2 projection was trained contrastively (InfoNCE, augmentation positives, 20K steps, 50 min on 1070 Ti). **13.4x discrimination** (up from v1's 3.67x). Used as a tiebreaker at 5% weight in fused retrieval — higher weights hurt because it discriminates surface form, not semantics. The encoder auto-detects v1 vs v2 weights (checks for `norm1_weight` key).

### Phase Rotor (Temporal)

```
Timestamp
  → Multi-frequency encoding (4 bands):
    θ_year  = day-of-year / 365 × 2π
    θ_month = day-of-month / 31 × 2π
    θ_week  = day-of-week / 7 × 2π
    θ_day   = hour / 24 × 2π
  → [cos_y, sin_y, cos_m, sin_m, cos_w, sin_w, cos_d, sin_d] (8 values)
```

Multi-frequency phase rotor enables phase-window filtering at any timescale. `_phase_distance()` computes average cosine similarity across all 4 frequency bands.

### Wave Encoder (Learned Oscillator Frequencies — In Development)

```
Text → word tokenization
  → learned embedding per token (freq_embed_dim=256)
  → local context mixing (Conv1d, window=3)
  → frequency assignment: softmax over n_bins=1920 (soft distribution)
  → phase assignment: learned phase per token in context
  → amplitude assignment: learned importance per token
  → QKPS-style phasor superposition (sum over tokens)
  → output projection → 1024-dim L2-normalized embedding
```

The wave encoder replaces hash-determined frequencies with **learned** frequency assignments distilled from Jina v3. Architecture: 21M params, word-level tokenizer. Achieves **0.73 similarity correlation** with Jina v3 (vs -0.06 for hash-feature MLP). Currently v0 (5420-word vocab, 10 LoCoMo conversations) — needs more training data + BPE tokenizer to reach Jina parity. Training run on larger corpus in progress.

## Retrieval

Retrieval uses **3-channel Reciprocal Rank Fusion (RRF)**:

1. **Spectral resonance** (2x weight): Full-field sequential scan with `inner_product()` on the 128-dim JL spectrum. No HNSW — this is true resonant correlation across the entire memory field.

2. **Centroid cosine** (1x weight): HNSW approximate nearest-neighbor on the 1920-dim centroid. Content-level similarity.

3. **BM25 lexical** (1x weight): pg_trgm trigram similarity on raw text content. Lexical tie-breaker.

The spectral channel uses full-field scan because:
- HNSW forces retrieval back into location-addressable mode (ANN ≠ resonance)
- The `inner_product()` of two spectra IS the Funk-Hecke resonance coefficient
- At ~400 memories, sequential scan is fast; at 10K+ memories, consider batched GPU correlation

## Document transform integration

The current MarkItDown microservice converts rich document formats to clean
Markdown before optional HAM ingestion. It is the lightweight Markdown/text
adapter and bounded fallback in the v2 plan:

**Supported formats:** PDF, DOCX, DOC, PPTX, PPT, XLSX, XLS, HTML, CSV, JSON, XML, EPUB, MSG, EML, JPG/PNG/GIF/BMP/TIFF/WEBP, MP3/WAV/M4A/OGG/FLAC, ZIP

**Flow:**
1. User imports file in Galaxy Explorer
2. `canConvert(filename)` checks if MarkItDown supports the format
3. `convertFile(file)` sends to MarkItDown service → receives Markdown
4. Falls back to native extraction (PDF.js for PDFs, direct read for text) if service is down
5. Node created → `contentProcessingService.enqueueNode()` → HAM ingestion

The v2 ingestion spine also adds Docling as the structure-rich adapter for
supported PDF, DOCX, and HTML inputs. Docling output is normalized into a
versioned Galaxy document envelope that preserves reading order, page regions,
headings, tables, figures, and formulas. Docling's internal object model is not
the canonical schema. Original bytes are persisted before either transform;
failure of Docling or MarkItDown never invalidates the original artifact.

## File Layout

### Galaxy Brain Frontend (`galaxybraindecent/`)

```
app/
  workspace/page.tsx      # Authenticated canonical Atlas entry
  atlas-v2/               # Infinite canvas loader and client
components/
  galaxy-explorer.tsx     # File import with MarkItDown + HAM ingestion
  workspace/              # Shared Atlas controls and bounded projectors
  knowledge/              # Retained semantic field and knowledge projections
  pdf-viewer.tsx          # PDF rendering + native text extraction
lib/
  markitdown-service.ts   # MarkItDown client (canConvert, convertFile, isAvailable)
  ham-service.ts          # HAM backend client (ingest, search, multihop)
  galaxy-brain-service.ts # Workspace/node management
  content-processing-service.ts  # Chunking, keywords, local embeddings
  weaviate-service.ts     # Re-export from ham-service (backward compat)
services/
  markitdown-server/
    server.py             # FastAPI service wrapping Microsoft MarkItDown
    requirements.txt      # fastapi, uvicorn, markitdown[all], python-multipart
```

### HAM Backend Plugin

HAM is intentionally not vendored as a submodule in this public repository.
Galaxy Brain talks to HAM through the HTTP contract documented in
`HAM_PLUGIN.md`. A private or separately published HAM implementation can be
run locally, hosted elsewhere, or swapped for another memory backend as long as
it exposes the same endpoints.

```
pg_ham/
  server.py               # FastAPI REST API — 3-channel fused retrieval + BitNet enrichment
  schema.sql              # Table definitions (centroid, spectrum, harmonic, phase_rotor)
  functions.sql            # SQL functions (ingest, retrieve, retrieve_multihop, consolidate)
  migrate_to_clifford.sql  # Migration from SBERT vector(384) to Clifford
  mcp_server.py            # MCP server for Claude integration
symbiotic_memory/
  clifford_encoder.py      # CliffordTextEncoder — centroid + JL + KAN v2 harmonic + defect cache
  harmonic_spectrum_encoder.py  # QKPS phasor encoding (near-orthogonal, 4000+ capacity)
  field_store.py           # FieldStore — per-doc matched filter with Q_dB + persistence
  rotor_field.py           # RotorField — true holographic superposition + Wiener/SIC
  harmonic_field.py        # HarmonicField — legacy JL field
  gegenbauer.py            # Gegenbauer polynomial helpers
scripts/
  train_proj_to_osc.py     # KAN v2 training (augmentation positives, 13.4x disc)
  train_proj_to_osc_semantic.py  # KAN v3 training (centroid-mined positives)
  train_wave_encoder.py    # Wave encoder training (Jina distillation, 0.73 correlation)
  train_distilled_encoder.py  # Hash-feature distillation (negative result, -0.06 correlation)
  benchmark_3ch.py         # LoCoMo 2ch vs 3ch comparison
  benchmark_all.py         # Full benchmark suite
```

## Running the Stack

### Prerequisites

- Python 3.10+ with `pip`
- Node.js 22.13+ with `pnpm`
- PostgreSQL with `pgvector` and `pg_trgm` extensions

### Start all services

```bash
# 1. Optional HAM Memory Plugin (port 8042)
# Run a compatible HAM service separately, then set HAM_API_INTERNAL.

# 2. MarkItDown Service (port 8043)
cd galaxybraindecent/services/markitdown-server
pip install -r requirements.txt
python server.py

# 3. Frontend (port 3000)
cd galaxybraindecent
pnpm dev
```

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `HAM_API_INTERNAL` | `http://localhost:8042` | Optional HAM service URL used by the authenticated, read-only search BFF |
| `HAM_API_BEARER_TOKEN` | none | Server-only credential used by the closed HAM search BFF |
| `MARKITDOWN_API_INTERNAL` | `http://localhost:8043` | Internal MarkItDown service URL |
| `GALAXY_API_INTERNAL` | `http://localhost:8044` | Internal Galaxy Brain ELN API URL |
| `MARKITDOWN_PROXY_TOKEN` | none | Required shared token for the conversion proxy |
| `GALAXY_API_PROXY_TOKEN` | none | Required shared token for the ELN proxy |
| HAM database variables | plugin-specific | Optional HAM plugin database configuration |

## Training

### KAN v2 Projection (surface-form tiebreaker)

```bash
cd ../ham
python scripts/train_proj_to_osc.py   # ~50 min on 1070 Ti, ~10 min on RTX 3060
```

Trains KAN projection from hash features → Gegenbauer spectrum. 13.4x discrimination. Exports weights auto-loaded by CliffordTextEncoder.

| Parameter | Default | Effect |
|-----------|---------|--------|
| `proj_hidden` | 512 | Bottleneck width (v1 was 256) |
| `max_steps` | 20000 | Training iterations |
| `temperature` | 0.07 | InfoNCE (cooled from 0.15 over 2000 steps) |

### Wave Encoder (semantic encoder — in development)

```bash
cd ../ham
python scripts/train_wave_encoder.py   # ~27 min on 1070 Ti
```

Learns oscillator frequency assignments distilled from Jina v3. 21M params, 0.73 correlation with Jina similarity structure. Currently limited by 5420-word vocab from 10 LoCoMo conversations.

**To scale**: train on larger corpus with BPE tokenizer. The architecture is proven — needs data, not architecture changes.

## Roadmap

### Completed

- Clifford Cl(6,0) encoder replacing SBERT (no GPU, deterministic)
- JL spectrum: 5.73x discrimination, full-field scan (no HNSW)
- KAN v2 harmonic: 13.4x discrimination (trained on 1070 Ti, 50 min)
- QKPS phasor encoding: near-orthogonal (cosine ~0.02), scales to 4000+ items
- Holographic fields: FieldStore (per-doc, persisted), RotorField (true superposition), HarmonicField (JL)
- Clifford rotor binding/unbinding for holographic superposition
- Wiener noise-whitened + SIC detectors
- 3-channel fused retrieval: 8/8 R@1 at 2000 items (beats SBERT+FAISS)
- Multi-frequency phase rotors: 4-band temporal encoding + phase-window filtering
- Tiered ingestion: instant encode + background BitNet enrichment (daemon thread)
- Field persistence: FieldStore save/load, instant server restarts
- BitNet background enrichment: auto-detected, daemon worker, frontend fallback wiring
- MCP server updated for Clifford
- LoCoMo benchmark: HAM Fused 0.399 Hit@5 (vs SBERT 0.434), beats MRR
- HAM Fused + Jina v3: 0.530 Hit@5 (beats SBERT by 18%)
- LongMemEval: 38.8% with chunked+HAM+BitNet (fully CPU, no API)
- Needle-in-haystack: 8/8 perfect at all scales vs SBERT 7/8
- Wave encoder v0: learned oscillator frequencies, 0.73 Jina correlation, 21M params
- CUDA PyTorch on 1070 Ti (cu126)

### Negative Results (documented)

- Hash-feature MLP distillation: 0.61 alignment but -0.06 correlation — hash features can't capture semantics
- KAN v2 at >5% weight hurts retrieval — discriminates surface form, not semantics
- Conversation-aware positives collapse different topics within same conversation

### Next Steps

1. **Scale wave encoder** — train on larger corpus + BPE tokenizer, target Hit@5 > 0.460 (Jina parity). GPU training run in progress.
2. **Wire wave encoder into server** — replace centroid with wave encoder output in fused retrieval
3. **LoRA on BitNet** — train adapter on LongMemEval failure cases for answer extraction
4. **Learned fusion weights** — per-query-type weight optimization (replace fixed alpha)
5. **Spread spectrum binding** — PN code spreading for processing gain on rotor field
