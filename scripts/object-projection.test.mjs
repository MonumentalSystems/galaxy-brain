import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import {
  projectChatObject,
  projectDocumentAnchorObject,
  projectDocumentObject,
  projectElnObject,
  projectElnObservation,
  projectHamMemoryObject,
  projectMarkdownObject,
  projectMediaObject,
  projectPaperObject,
  projectProofObject,
  projectSurfaceObject,
  projectTaskObject,
  projectUnknownReference,
} from "../lib/object-projection-adapters.js"
import {
  getObjectProjector,
  projectionForContext,
  selectObjectRepresentation,
  semanticZoomLevelFor,
} from "../lib/object-projector-registry.js"
import { DOCUMENTS_PLUGIN_PACKAGE } from "../lib/plugins/builtins.js"
import { createPluginRegistry } from "../lib/plugins/registry.js"
import {
  createGalaxyObjectProjection,
  projectionToMarkdownCitation,
  resolveGalaxyObjectProjection,
} from "../lib/object-projection.js"

const hash = "a".repeat(64)
const documentRef = createGalaxyObjectReference("document", "document-1", {
  mode: "pinned",
  revision: `sha256:${hash}`,
})
const paper = {
  id: "paper-1",
  title: "A pinned paper",
  abstract: "One canonical source, projected into several views.",
  metadata_hash: hash,
  revisions: [],
}
const paperRevision = {
  id: "paper-revision-1",
  metadata_hash: hash,
  document: {
    ref: documentRef,
    document_id: "document-1",
    revision_id: "document-revision-1",
    revision_sha256: hash,
    content_sha256: hash,
    media_type: "application/pdf",
    display_filename: "a-pinned-paper.pdf",
  },
}

test("ELN observations project only their exact immutable revision", () => {
  const id = "90000000-0000-4000-8000-000000000001"
  const projection = projectElnObservation({
    id,
    experimentId: "30000000-0000-4000-8000-000000000001",
    version: 1,
    revisionSha256: hash,
    body: "Stable reading",
    observedAt: "2026-09-28T16:30:00.000000Z",
  })
  assert.equal(projection.kind, "eln.observation")
  assert.equal(projection.ref, createGalaxyObjectReference("eln.observation", id, {
    mode: "pinned", revision: `sha256:${hash}`,
  }))
  assert.deepEqual(projection.revision, { policy: "pinned", id: `sha256:${hash}`, contentHash: hash })
})

test("same pinned paper projection drives list, graph, canvas, and Markdown citation", () => {
  const projection = projectPaperObject({ paper, revision: paperRevision })
  const expectedRef = createGalaxyObjectReference("paper", paper.id, {
    mode: "pinned",
    revision: `sha256:${hash}`,
  })

  for (const context of ["list", "graph", "canvas", "detail"]) {
    assert.equal(projectionForContext(projection, context, 1.5).projection.ref, expectedRef)
  }
  assert.match(projectionToMarkdownCitation(projection), new RegExp(expectedRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.equal(JSON.stringify(projection).includes("source_url"), false)
  assert.equal(JSON.stringify(projection).includes("content:"), false)
  assert.equal(projection.representations[1].ref, documentRef)
  assert.equal(JSON.stringify(projection).includes("gb:artifact:sha256:"), false)
  assert.equal(projection.provenance.sourceRevision, paperRevision.id)
})

test("an authorized paper listing projects latest identity until a concrete revision is selected", () => {
  const projection = projectPaperObject({ paper, revision: null })
  assert.equal(projection.ref, createGalaxyObjectReference("paper", paper.id))
  assert.deepEqual(projection.revision, { policy: "latest", id: null, contentHash: hash })
})

test("an unbridged legacy paper PDF does not masquerade as a canonical document", () => {
  const projection = projectPaperObject({
    paper,
    revision: {
      ...paperRevision,
      document: {
        content_sha256: hash,
        media_type: "application/pdf",
        filename: "legacy-paper.pdf",
      },
    },
  })
  assert.equal(projection.representations.some((item) => item.representation === "pdf"), false)
  assert.equal(JSON.stringify(projection).includes("gb:artifact:sha256:"), false)
})

test("HAM task projections keep operational latest identity and observed version provenance separate", () => {
  const projection = projectTaskObject({ id: "task-1", title: "Task", goal: "Do work", why: "Evidence", version: 2 })
  assert.equal(projection.ref, createGalaxyObjectReference("ham.task", "task-1"))
  assert.deepEqual(projection.revision, { policy: "latest", id: null, contentHash: null })
  assert.equal(projection.provenance.sourceRevision, "version:2")
})

test("pinned chat projection matches the conversation Graph identity without embedding chat records", () => {
  const conversationId = "80000000-0000-4000-8000-000000000001"
  const projection = projectChatObject({
    conversationId,
    workspaceId: "research-field",
    title: "Pinned research chat",
    goalSummary: "Compare exact proof obligations.",
    version: 5,
    contentSha256: hash,
    turnCount: 4,
    branchCount: 2,
  })
  const expectedRef = createGalaxyObjectReference("chat", conversationId, {
    mode: "pinned", revision: `sha256:${hash}`,
  })

  assert.equal(projection.ref, expectedRef)
  assert.equal(projection.kind, "chat")
  assert.deepEqual(projection.revision, {
    policy: "pinned", id: `sha256:${hash}`, contentHash: hash,
  })
  assert.equal(projection.mediaType, "application/vnd.galaxy.conversation+json")
  assert.deepEqual(projection.representations, [])
  assert.deepEqual(projection.provenance, {
    provider: "galaxy.conversation",
    sourceId: conversationId,
    sourceRevision: `sha256:${hash}`,
    statement: "Immutable tenant-scoped conversation state.",
  })
  assert.deepEqual(projection.capabilities, ["open", "place", "branch", "cite", "inspect", "relate"])
  for (const field of ["turns", "messages", "artifacts", "content", "rawBody"]) {
    assert.equal(Object.hasOwn(projection, field), false)
  }
  assert.deepEqual(
    { id: getObjectProjector(projection).id, label: getObjectProjector(projection).label, pluginId: getObjectProjector(projection).pluginId },
    { id: "conversation", label: "Conversation", pluginId: "tasks" },
  )
  for (const context of ["list", "graph", "canvas", "detail"]) {
    assert.equal(projectionForContext(projection, context, 1.5).projection.ref, expectedRef)
  }
})

test("projection contract rejects embedded canonical bodies and mismatched pinned revisions", () => {
  const valid = projectPaperObject({ paper, revision: paperRevision })
  assert.throws(
    () => createGalaxyObjectProjection({ ...valid, content: "canonical body" }),
    /projection\.content is not part/,
  )
  assert.throws(
    () => createGalaxyObjectProjection({
      ...valid,
      revision: { ...valid.revision, id: "another-revision" },
    }),
    /pinned revision id must match/,
  )
})

test("provider resolver adapters require explicit authorized resolution", async () => {
  const ref = createGalaxyObjectReference("paper", paper.id, { mode: "pinned", revision: `sha256:${hash}` })
  const scope = { tenantId: "tenant-1", authorityScope: "paper:read" }
  const adapter = {
    async resolve() { return { authorized: true, value: { paper, revision: paperRevision } } },
    project(_reference, value) { return projectPaperObject(value) },
  }
  const projected = await resolveGalaxyObjectProjection(ref, scope, { paper: adapter }, {})
  assert.equal(projected?.ref, ref)

  const denied = await resolveGalaxyObjectProjection(ref, scope, {
    paper: { ...adapter, async resolve() { return null } },
  }, {})
  assert.equal(denied, null)
  assert.equal(await resolveGalaxyObjectProjection(ref, scope, {}, {}), null)
})

test("built-in adapters select paper, Markdown/media, ELN, task/conversation, proof, memory, surface, code, and unknown projectors", () => {
  const projections = [
    projectPaperObject({ paper, revision: paperRevision }),
    projectDocumentObject({
      document_id: "document-1", revision_sha256: hash, title: "Durable document",
      representations: [{
        id: "representation-1", kind: "markdown", media_type: "text/markdown",
        content_sha256: hash,
      }],
    }),
    projectDocumentObject({
      document_id: "document-image", revision_sha256: hash, title: "Durable image",
      media_type: "image/png",
      raster_image: {
        schemaId: "gb.raster-image.v1", format: "png", mediaType: "image/png",
        width: 16, height: 9, channels: 4, frameCount: 1, byteSize: 128,
        contentSha256: hash,
      },
      representations: [{
        id: "representation-image", kind: "original", media_type: "image/png",
        content_sha256: hash,
      }],
    }),
    projectDocumentObject({
      document_id: "document-audio", revision_sha256: hash, title: "Durable audio",
      media_type: "audio/webm",
      audio_original: {
        schemaId: "gb.audio-original.v1", container: "webm", codec: "opus",
        mediaType: "audio/webm", trackCount: 1, channels: 1, byteSize: 128,
        contentSha256: hash,
      },
      representations: [{
        id: "representation-audio", kind: "original", media_type: "audio/webm",
        content_sha256: hash,
      }],
    }),
    projectDocumentAnchorObject({
      id: `sha256:${hash}`, representation_sha256: hash, anchor_sha256: hash,
      title: "Durable document", selector: { kind: "text-quote", exact: "Exact evidence" },
    }),
    projectMarkdownObject({
      id: "markdown-1", title: "Markdown", representationRef: "representation:markdown-1", contentHash: hash,
    }),
    projectMediaObject({
      id: "image-1", title: "Image", mediaType: "image/png", representationRef: "artifact:image-1", contentHash: hash,
    }),
    projectElnObject({
      id: "experiment-1",
      title: "Experiment",
      sections: [{ key: "results", title: "Results", content: "Stable" }],
      provenance: { source: "galaxy-brain-eln", updatedAt: "2026-09-23T12:00:00Z" },
    }),
    projectTaskObject({ id: "task-1", title: "Task", goal: "Do work", why: "Evidence", version: 2 }),
    projectChatObject({
      conversationId: "80000000-0000-4000-8000-000000000001",
      title: "Pinned research chat", goalSummary: "Compare proof obligations.",
      contentSha256: hash,
    }),
    projectProofObject({ graphId: "proof-1", title: "Proof graph", contentSha256: hash }),
    projectHamMemoryObject({ id: "memory-1", title: "Memory", content: "Context", version: 3 }),
    projectSurfaceObject({
      id: "surface-1", title: "Surface", status: "promoted", catalog_id: "generous.a2ui",
      current_version: 4, current_content_hash: hash, placement_eligible: true,
    }),
    projectUnknownReference(createGalaxyObjectReference("code.repo", "repo-1")),
    projectUnknownReference(createGalaxyObjectReference("claim", "claim-1")),
  ]

  assert.deepEqual(projections.map((item) => getObjectProjector(item).id), [
    "paper", "document", "image", "audio", "document-anchor", "markdown", "media", "eln", "task", "conversation", "proof", "ham-memory", "surface", "code", "unknown",
  ])
  const unknownProjector = getObjectProjector(projections.at(-1))
  assert.equal(unknownProjector.plugin, null)
  assert.equal(unknownProjector.diagnostic, "projector_unavailable")
})

test("static plugin descriptors own projector availability without loading manifest code", () => {
  const paperProjection = projectPaperObject({ paper, revision: paperRevision })
  const markdownProjection = projectMarkdownObject({
    id: "markdown-1", title: "Markdown", representationRef: "representation:markdown-1", contentHash: hash,
  })
  const documentsWithoutPaper = {
    manifest: {
      ...DOCUMENTS_PLUGIN_PACKAGE.manifest,
      contributes: {
        ...DOCUMENTS_PLUGIN_PACKAGE.manifest.contributes,
        projectors: DOCUMENTS_PLUGIN_PACKAGE.manifest.contributes.projectors.filter((id) => id !== "paper"),
      },
    },
    handlers: DOCUMENTS_PLUGIN_PACKAGE.handlers,
  }
  const registryWithoutPaper = createPluginRegistry([documentsWithoutPaper])

  const paperProjector = getObjectProjector(paperProjection)
  assert.equal(paperProjector.pluginId, "documents")
  assert.equal(paperProjector.diagnostic, null)
  assert.equal(Object.isFrozen(paperProjector.plugin), true)
  assert.deepEqual(Object.keys(paperProjector.plugin).sort(), ["displayName", "id", "version"])
  assert.deepEqual(paperProjector.plugin, {
    id: "documents",
    displayName: "Documents",
    version: "1.0.0",
  })
  assert.notEqual(paperProjection.provenance.provider, paperProjector.plugin.id)

  const missingPaper = getObjectProjector(paperProjection, registryWithoutPaper)
  assert.equal(missingPaper.id, "unknown")
  assert.equal(missingPaper.plugin, null)
  assert.equal(missingPaper.diagnostic, "projector_unavailable")
  assert.equal(getObjectProjector(markdownProjection, registryWithoutPaper).id, "markdown")

  const unallowlistedRegistry = createPluginRegistry([{
    manifest: {
      schemaId: "galaxy-plugin.v1",
      id: "fixture-renderer",
      version: "1.0.0",
      contributes: { projectors: ["paper"] },
      connections: [],
    },
    handlers: {
      projectors: {
        paper: { kind: "projectors", implementationId: "fixture.browser-component" },
      },
    },
  }])
  const unallowlisted = getObjectProjector(paperProjection, unallowlistedRegistry)
  assert.equal(unallowlisted.id, "unknown")
  assert.equal(unallowlisted.plugin, null)
  assert.equal(unallowlisted.diagnostic, "projector_unavailable")
  assert.equal(JSON.stringify(unallowlisted).includes("fixture-renderer"), false)
})

test("canonical projectors use resolver-compatible immutable selectors and mutable-head identities", () => {
  const experiment = projectElnObject({
    id: "experiment-1",
    title: "Experiment",
    sections: [],
    provenance: { source: "galaxy-brain-eln", updatedAt: "2026-09-23T12:00:00Z" },
  })
  const proof = projectProofObject({ graphId: "proof-1", title: "Proof", contentSha256: hash })
  const proofNode = projectProofObject({
    nodeRefId: "proof-1#goal-1",
    title: "Goal",
    contentSha256: hash,
  })
  const memory = projectHamMemoryObject({
    id: "memory-1",
    title: "Memory",
    content: "Context",
    version: 3,
  })
  const surface = projectSurfaceObject({
    id: "surface-1",
    title: "Surface",
    status: "promoted",
    catalog_id: "generous.a2ui",
    current_version: 7,
    current_content_hash: hash,
    placement_eligible: true,
  })

  assert.equal(experiment.ref, createGalaxyObjectReference("eln.experiment", "experiment-1"))
  assert.equal(experiment.provenance.sourceRevision, "2026-09-23T12:00:00Z")
  assert.equal(memory.ref, createGalaxyObjectReference("ham.memory", "memory-1"))
  assert.equal(memory.provenance.sourceRevision, "version:3")
  assert.equal(proof.ref, createGalaxyObjectReference("proof.graph", "proof-1", {
    mode: "pinned", revision: `sha256:${hash}`,
  }))
  assert.equal(proofNode.ref, createGalaxyObjectReference("proof.node", "proof-1#goal-1", {
    mode: "pinned", revision: `sha256:${hash}`,
  }))
  assert.equal(surface.ref, createGalaxyObjectReference("surface", "surface-1", {
    mode: "pinned", revision: `sha256:${hash}`,
  }))
  assert.equal(surface.provenance.sourceRevision, "version:7")
  assert.equal(surface.capabilities.includes("place"), true)
  assert.equal(projectSurfaceObject({
    id: "surface-1",
    title: "Historical promoted surface",
    status: "promoted",
    catalog_id: "generous.a2ui",
    current_version: 6,
    current_content_hash: hash,
    placement_eligible: false,
  }).capabilities.includes("place"), false)
  assert.equal(projectSurfaceObject({
    id: "surface-1",
    title: "Draft surface",
    status: "draft",
    catalog_id: "generous.a2ui",
    current_version: 8,
    current_content_hash: hash,
  }).capabilities.includes("place"), false)
  assert.throws(
    () => projectProofObject({ graphId: "proof-1", revisionId: hash }),
    /sha256: selector/,
  )
  assert.throws(
    () => projectProofObject({ graphId: "proof-1", contentSha256: "not-a-digest" }),
    /exact SHA-256/,
  )
  assert.throws(
    () => projectProofObject({ graphId: "proof-1" }),
    /exactly one immutable digest/,
  )
  assert.throws(
    () => projectProofObject({
      graphId: "proof-1",
      contentSha256: hash,
      revisionId: `sha256:${hash}`,
    }),
    /exactly one immutable digest/,
  )
  assert.throws(
    () => projectProofObject({ nodeRefId: "goal-1", contentSha256: hash }),
    /canonical registry identity/,
  )
  assert.throws(
    () => projectProofObject({
      graphId: "proof-1",
      nodeRefId: "proof-1#goal-1",
      contentSha256: hash,
    }),
    /exactly one/,
  )
  assert.doesNotThrow(() => projectProofObject({
    nodeRefId: `proof-node-${hash}-9999`,
    contentSha256: hash,
  }))
  assert.throws(
    () => projectProofObject({
      nodeRefId: `proof-node-${"a".repeat(64)}-0`,
      contentSha256: "b".repeat(64),
    }),
    /digest does not match/,
  )
  assert.throws(
    () => projectSurfaceObject({ id: "surface-1", current_content_hash: "not-a-digest" }),
    /exact SHA-256/,
  )
})

test("document and anchor projections preserve immutable revision identities without embedding bodies", () => {
  const document = projectDocumentObject({
    document_id: "document-1", revision_sha256: hash, title: "Durable document",
    representations: [{
      id: "representation-1", kind: "document-structure", media_type: "application/json",
      content_sha256: hash,
    }],
  })
  const anchor = projectDocumentAnchorObject({
    id: `sha256:${hash}`, representation_sha256: hash, anchor_sha256: hash,
    title: "Durable document", selector: { kind: "page-region", page: 7 },
  })

  assert.equal(document.ref, createGalaxyObjectReference("document", "document-1", {
    mode: "pinned", revision: `sha256:${hash}`,
  }))
  assert.equal(anchor.ref, createGalaxyObjectReference("document.anchor", `sha256:${hash}`, {
    mode: "pinned", revision: `sha256:${hash}`,
  }))
  assert.equal(anchor.title, "Page 7 — Durable document")
  assert.equal(Object.hasOwn(document, "content"), false)
  assert.equal(Object.hasOwn(anchor, "selector"), false)
})

test("anchor projections make multiline quotes safe and keep location visible beside long titles", () => {
  const quote = projectDocumentAnchorObject({
    id: `sha256:${hash}`, representation_sha256: hash, anchor_sha256: hash,
    title: "A".repeat(240), selector: { kind: "text-quote", exact: "line one\n\tline two" },
  })
  assert.match(quote.title, /^line one line two — /)
  assert.equal(quote.summary, "line one line two")
  assert.equal(/[\u0000-\u001f]/u.test(quote.title), false)
  const page = projectDocumentAnchorObject({
    id: `sha256:${hash}`, representation_sha256: hash, anchor_sha256: hash,
    title: "A".repeat(240), selector: { kind: "page-region", page: 7 },
  })
  assert.match(page.title, /^Page 7 — /)
})

test("document and anchor projections fail closed without exact immutable digests", () => {
  assert.throws(() => projectDocumentObject({
    document_id: "document-1", revision_sha256: "corrupt", title: "Document",
  }), /exact SHA-256/)
  assert.throws(() => projectDocumentObject({
    document_id: "document-1", revision_sha256: hash, title: "Document",
    representations: [{ id: "rep-1", kind: "text", media_type: "text/plain", content_sha256: "corrupt" }],
  }), /exact SHA-256/)
  assert.throws(() => projectDocumentAnchorObject({
    id: `sha256:${hash}`, representation_sha256: "corrupt", anchor_sha256: hash,
    selector: { kind: "text-quote", exact: "evidence" },
  }), /exact SHA-256/)
  assert.throws(() => projectDocumentAnchorObject({
    id: `sha256:${"b".repeat(64)}`, representation_sha256: hash, anchor_sha256: hash,
    selector: { kind: "text-quote", exact: "evidence" },
  }), /must match/)
  const document = projectDocumentObject({
    document_id: "document-1", revision_sha256: hash,
    title: "A durable\n\tdocument",
  })
  assert.equal(document.title, "A durable document")
})

test("semantic zoom substitutes four declared representations and keeps them through motion", () => {
  assert.equal(semanticZoomLevelFor(0.2).id, "far")
  assert.equal(semanticZoomLevelFor(0.9).id, "medium")
  assert.equal(semanticZoomLevelFor(1.8).id, "near")
  assert.equal(semanticZoomLevelFor(4).id, "detail")

  const projection = projectPaperObject({ paper, revision: paperRevision })
  // Motion keeps what is drawn: swapping in a placeholder read as a flicker.
  assert.equal(selectObjectRepresentation(projection, 1.8, true).representation, "card")
  assert.equal(selectObjectRepresentation(projection, 0.9, true).representation, "label")
  assert.equal(selectObjectRepresentation(projection, 4, false).representation, "detail")
})

test("projection host reuses shared Markdown/KaTeX and global Living Field tokens", async () => {
  const [host, css] = await Promise.all([
    readFile(new URL("../components/projections/object-projection-host.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ])
  assert.match(host, /<MarkdownRenderer[\s\S]*images="omit"/)
  assert.match(host, /item\.contentHash === null \|\| item\.contentHash === resolved\.contentHash/)
  assert.ok(host.indexOf("{...articleProps}") < host.indexOf('data-slot="object-projection"'))
  assert.match(host, /data-slot="object-projection"/)
  assert.match(host, /data-projector-plugin=\{selected\.projector\.pluginId \?\? undefined\}/)
  assert.match(host, /data-projector-version=\{selected\.projector\.plugin\?\.version \?\? undefined\}/)
  assert.match(host, /data-projector-diagnostic=\{selected\.projector\.diagnostic \?\? undefined\}/)
  assert.match(host, /Projector unavailable/)
  assert.match(host, /selected\.projector\.diagnostic === "projector_unavailable"[\s\S]*\? "Projector unavailable"/)
  assert.match(host, /No registered code-owned projector handles/)
  assert.match(host, /identity and authorized source metadata remain available/)
  assert.match(host, /selected\.projector\.diagnostic === null && representationPreview/)
  assert.match(host, /object-projection__source-label">Source/)
  assert.match(host, /selected\.projection\.provenance\.provider/)
  assert.match(host, /selected\.projector\.plugin\.displayName/)
  assert.match(host, /selected\.projector\.plugin\.id}@\{selected\.projector\.plugin\.version/)
  assert.match(host, /className="object-projection__projector-name"/)
  assert.match(css, /\.object-projection__projector-name,[\s\S]*\.object-projection__projector-id \{[\s\S]*min-width: 0;[\s\S]*overflow-wrap: anywhere/)
  assert.match(css, /\.object-projection__diagnostic code,[\s\S]*\.object-projection__provider[\s\S]*overflow-wrap: anywhere/)
  assert.match(css, /\.object-projection__footer \{[\s\S]*flex-wrap: wrap/)
  assert.match(css, /\.object-projection__source \{[\s\S]*max-width: 100%[\s\S]*flex-wrap: wrap/)
  assert.doesNotMatch(host, /installed|connected|healthy|credential/iu)
  assert.match(host, /getSurfaceRenderer\(surfaceSpec\)/)
  assert.doesNotMatch(host, /import\s*\(/)
  assert.match(host, /aria-labelledby=\{titleId\}/)
  for (const token of ["--field-surface", "--field-panel", "--field-ink", "--field-border", "--field-core"]) {
    assert.match(css, new RegExp(token))
  }
  assert.match(css, /prefers-reduced-motion/)
  assert.match(css, /\.object-projection__diagnostic \{/)
  assert.match(css, /data-zoom-level="far"[^}]*object-projection__projector/s)
})
