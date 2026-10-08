import { createGalaxyObjectReference } from "../galaxy-object-reference.js"

const PAPER_REVISION = `sha256:${"1".repeat(64)}`
const NOTE_REVISION = `sha256:${"2".repeat(64)}`
const PDF_REVISION = `sha256:${"3".repeat(64)}`
const MEDIA_REVISION = `sha256:${"4".repeat(64)}`
const PROOF_REVISION = `sha256:${"5".repeat(64)}`
const SURFACE_REVISION = `sha256:${"6".repeat(64)}`
const RECEIPT_REVISION = `sha256:${"7".repeat(64)}`

const proofReceiptRef = createGalaxyObjectReference(
  "artifact",
  "canvas-preview:lean-replay-receipt",
  { mode: "pinned", revision: RECEIPT_REVISION },
)

function researchSurfaceSpec() {
  return {
    schema: "gb.surface.v1",
    catalog: { id: "generous.a2ui", version: "1" },
    surfaceUpdate: {
      surfaceId: "canvas-preview-research-summary",
      components: [
        {
          id: "root",
          component: { Column: {} },
          children: ["title", "summary", "stats"],
        },
        {
          id: "title",
          component: { Title: { text: "Vortex memory review" } },
          parentId: "root",
        },
        {
          id: "summary",
          component: {
            Markdown: {
              markdown: "Evidence remains provisional until its proof receipt is accepted.",
            },
          },
          parentId: "root",
        },
        {
          id: "stats",
          component: {
            StatsDisplay: {
              data: {
                stats: [
                  { id: "papers", label: "Papers", value: 1 },
                  { id: "proofs", label: "Verified proofs", value: 1 },
                ],
              },
            },
          },
          parentId: "root",
        },
      ],
    },
    bindings: [],
  }
}

/**
 * Synthetic, already-authorized display data for the development-only canvas
 * spike. The records deliberately contain no tenant identifiers, credentials,
 * external URLs, raw PDF bytes, or mutable application state.
 */
export function buildResearchCanvasFixture() {
  return {
    placements: [
      {
        id: "preview-paper",
        authorized: true,
        subjectRef: createGalaxyObjectReference(
          "paper",
          "canvas-preview:paper:vortex-memory",
          { mode: "pinned", revision: PAPER_REVISION },
        ),
        nodeType: "galaxy.paper",
        x: 80,
        y: 90,
        width: 420,
        height: 270,
        display: {
          title: "Topological memory in a driven vortex lattice",
          subtitle: "Synthetic paper fixture · two authors",
          summary: "A bounded drive preserves winding memory after the external field relaxes.",
          revision: PAPER_REVISION,
          status: "pinned",
          provenance: "Synthetic scholarly record; no source is fetched by this preview.",
          href: "/papers",
          badges: ["paper", "pinned revision", "read-only"],
        },
      },
      {
        id: "preview-note",
        authorized: true,
        // Notes do not yet have a canonical object kind. Use an immutable
        // artifact reference while keeping the presentation type independent.
        subjectRef: createGalaxyObjectReference(
          "artifact",
          "canvas-preview:note:winding-derivation",
          { mode: "pinned", revision: NOTE_REVISION },
        ),
        nodeType: "galaxy.note",
        x: 590,
        y: 70,
        width: 430,
        height: 300,
        display: {
          title: "Winding-memory derivation",
          subtitle: "Markdown and KaTeX",
          summary: "A compact note exercises the existing safe Markdown renderer.",
          revision: NOTE_REVISION,
          status: "read-only",
          href: `/workspace?ref=${encodeURIComponent(createGalaxyObjectReference(
            "artifact",
            "canvas-preview:note:winding-derivation",
            { mode: "pinned", revision: NOTE_REVISION },
          ))}`,
          markdown: [
            "## Candidate invariant",
            "",
            "For a closed contour $C$, retain the winding",
            "",
            "\\[",
            "W(C)=\\frac{1}{2\\pi}\\oint_C \\nabla \\theta \\cdot d\\ell.",
            "\\]",
            "",
            "This note is an authored interpretation, not verified evidence.",
          ].join("\n"),
          badges: ["note", "Markdown", "KaTeX"],
        },
      },
      {
        id: "preview-pdf",
        authorized: true,
        subjectRef: createGalaxyObjectReference(
          "artifact",
          "canvas-preview:document:vortex-paper-pdf",
          { mode: "pinned", revision: PDF_REVISION },
        ),
        nodeType: "galaxy.document",
        x: 1100,
        y: 100,
        width: 360,
        height: 230,
        display: {
          title: "vortex-memory-review.pdf",
          subtitle: "12 pages · 842 KiB · application/pdf",
          summary: "PDF metadata and an authorized handoff are shown without loading PDF.js or external assets.",
          revision: PDF_REVISION,
          status: "available",
          provenance: "Synthetic immutable document metadata.",
          href: "/papers",
          mediaType: "application/pdf",
          badges: ["PDF", "SHA-256 pinned", "handoff only"],
        },
      },
      {
        id: "preview-media",
        authorized: true,
        subjectRef: createGalaxyObjectReference(
          "artifact",
          "canvas-preview:media:vortex-field-frame",
          { mode: "pinned", revision: MEDIA_REVISION },
        ),
        nodeType: "galaxy.media",
        x: 120,
        y: 460,
        width: 350,
        height: 240,
        display: {
          title: "Vortex field frame 017",
          subtitle: "Image artifact · 2048 × 2048",
          summary: "Authorized media metadata; distant canvas views do not mount a player.",
          revision: MEDIA_REVISION,
          status: "captured",
          provenance: "Synthetic experiment output.",
          href: `/workspace?ref=${encodeURIComponent(createGalaxyObjectReference(
            "artifact",
            "canvas-preview:media:vortex-field-frame",
            { mode: "pinned", revision: MEDIA_REVISION },
          ))}`,
          mediaType: "image/png",
          badges: ["media", "image/png", "artifact"],
        },
      },
      {
        id: "preview-eln",
        authorized: true,
        subjectRef: createGalaxyObjectReference(
          "eln.experiment",
          "canvas-preview:experiment:vortex-memory-017",
        ),
        nodeType: "galaxy.eln-record",
        x: 550,
        y: 470,
        width: 420,
        height: 260,
        display: {
          title: "Driven vortex lattice · run 017",
          subtitle: "ELN research record · fusion",
          summary: "Five repeats retain distinct winding populations; the no-drive recovery control remains open.",
          revision: "version:3",
          status: "running",
          provenance: "Galaxy ELN synthetic record projection.",
          href: "/eln/experiment/canvas-preview%3Aexperiment%3Avortex-memory-017",
          badges: ["ELN", "running", "3 artifacts"],
        },
      },
      {
        id: "preview-task",
        authorized: true,
        subjectRef: createGalaxyObjectReference(
          "ham.task",
          "canvas-preview:task:recovery-control",
        ),
        nodeType: "galaxy.task",
        x: 1050,
        y: 440,
        width: 390,
        height: 250,
        display: {
          title: "Run the no-drive recovery control",
          subtitle: "HAM bounded task · diagnostic",
          summary: "Compare winding retention against the zero-field control without modifying the source record.",
          revision: "version:7",
          status: "running",
          provenance: "HAM remains authoritative for task lifecycle.",
          href: "/tasks",
          badges: ["task", "diagnostic", "read resources"],
        },
      },
      {
        id: "preview-proof",
        authorized: true,
        subjectRef: createGalaxyObjectReference(
          "proof.node",
          "canvas-preview:vortex-proof#goal-7",
          { mode: "pinned", revision: PROOF_REVISION },
        ),
        nodeType: "galaxy.proof",
        x: 360,
        y: 830,
        width: 450,
        height: 280,
        display: {
          title: "Discharge the winding-conservation goal",
          subtitle: "Galaxy DAG node · Prove2Me interop",
          summary: "Galaxy stores the immutable proof target and keeps provider metadata external. A separately versioned, accepted, sorry-free Lean replay receipt supplies verification evidence.",
          revision: PROOF_REVISION,
          status: "verified",
          provenance: `Galaxy verification overlay backed by ${proofReceiptRef}`,
          href: "/dev/proof-dag-preview",
          badges: ["Galaxy structure", "Prove2Me interop", "Lean verified"],
        },
      },
      {
        id: "preview-surface",
        authorized: true,
        subjectRef: createGalaxyObjectReference(
          "surface",
          "canvas-preview:surface:research-summary",
          { mode: "pinned", revision: SURFACE_REVISION },
        ),
        nodeType: "galaxy.surface",
        x: 930,
        y: 800,
        width: 510,
        height: 350,
        display: {
          title: "Vortex memory review",
          subtitle: "Promoted Generous surface · generous.a2ui@1",
          summary: "A bounded, unbound gb.surface.v1 fixture rendered through the existing safe catalog.",
          revision: SURFACE_REVISION,
          status: "promoted",
          provenance: "Synthetic promoted surface with no live bindings.",
          href: "/surfaces",
          badges: ["gb.surface.v1", "promoted", "0 bindings"],
          surfaceSpec: researchSurfaceSpec(),
        },
      },
    ],
    relations: [
      {
        id: "paper-has-pdf",
        sourcePlacementId: "preview-paper",
        targetPlacementId: "preview-pdf",
        relationType: "has_revision_document",
        trustClass: "deterministic",
        owner: "Galaxy paper importer",
        provenance: "Pinned paper revision metadata.",
      },
      {
        id: "note-comments-on-paper",
        sourcePlacementId: "preview-note",
        targetPlacementId: "preview-paper",
        relationType: "context_for",
        trustClass: "asserted",
        owner: "Galaxy object-link ledger",
        provenance: "Synthetic authored assertion; retractable and not proof evidence.",
      },
      {
        id: "proof-verifies-paper",
        sourcePlacementId: "preview-proof",
        targetPlacementId: "preview-paper",
        relationType: "verifies",
        trustClass: "verified",
        owner: "Registered Lean replay verifier",
        provenance: "Accepted sorry-free verification projected by Galaxy.",
        evidenceRef: proofReceiptRef,
      },
      {
        id: "media-near-paper",
        sourcePlacementId: "preview-media",
        targetPlacementId: "preview-paper",
        relationType: "near",
        trustClass: "near",
        owner: "HAM",
        provenance: "Synthetic similarity candidate; not an authored assertion.",
      },
    ],
  }
}

export const canvasHarnessPreviewProjection = buildResearchCanvasFixture()

/**
 * Build a stable, minimal scene for primitive/LOD throughput measurements.
 * It uses only the public Galaxy projection contract so the benchmark does not
 * depend on canvas-harness store internals.
 */
export function buildPrimitiveCanvasFixture(count = 2_000) {
  if (!Number.isSafeInteger(count) || count < 0 || count > 10_000) {
    throw new RangeError("Primitive canvas fixture count must be an integer between 0 and 10000")
  }

  const columns = 50
  const placements = Array.from({ length: count }, (_, index) => {
    const number = index + 1
    return {
      id: `primitive-${number}`,
      authorized: true,
      subjectRef: createGalaxyObjectReference("artifact", `canvas-preview:primitive:${number}`),
      nodeType: "galaxy.note",
      x: (index % columns) * 180,
      y: Math.floor(index / columns) * 120,
      width: 120,
      height: 80,
      display: {
        title: `Primitive ${number}`,
        status: "synthetic",
        badges: ["benchmark"],
      },
    }
  })

  const relations = Array.from({ length: Math.max(0, count - 1) }, (_, index) => ({
    id: `primitive-link-${index + 1}`,
    sourcePlacementId: `primitive-${index + 1}`,
    targetPlacementId: `primitive-${index + 2}`,
    relationType: "sequence",
    trustClass: "deterministic",
    owner: "Synthetic benchmark generator",
  }))

  return { placements, relations }
}
