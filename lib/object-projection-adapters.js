import { createGalaxyObjectReference, parseGalaxyObjectReference } from "./galaxy-object-reference.js"
import { createGalaxyObjectProjection } from "./object-projection.js"

const SHA256 = /^[a-f0-9]{64}$/iu
const PROOF_COMPONENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/
const PROOF_NODE_FALLBACK_ID = /^proof-node-([a-f0-9]{64})-(?:0|[1-9][0-9]{0,3})$/

function bounded(value, maximum, fallback) {
  if (typeof value !== "string") return fallback
  const normalized = value.trim()
  if (!normalized) return fallback
  return Array.from(normalized).length <= maximum
    ? normalized
    : `${Array.from(normalized).slice(0, maximum - 1).join("")}…`
}

function revision(kind, id, revisionId, contentHash) {
  const normalizedRevision = bounded(revisionId, 256, null)
  const hash = typeof contentHash === "string" && SHA256.test(contentHash) ? contentHash.toLowerCase() : null
  return {
    ref: createGalaxyObjectReference(
      kind,
      id,
      normalizedRevision ? { mode: "pinned", revision: normalizedRevision } : { mode: "latest" },
    ),
    revision: {
      policy: normalizedRevision ? "pinned" : "latest",
      id: normalizedRevision,
      contentHash: hash,
    },
  }
}

function digestRevision(value, label) {
  return `sha256:${requiredSha256(value, label)}`
}

function canonicalDigestRevision(value, label) {
  if (typeof value !== "string" || !value.startsWith("sha256:")) {
    throw new TypeError(`${label} must use a sha256: selector`)
  }
  return digestRevision(value.slice("sha256:".length), label)
}

function proofIdentity(source, contentSha256) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("Proof source must be an object")
  }
  const hasGraphId = Object.hasOwn(source, "graphId")
  const hasNodeRefId = Object.hasOwn(source, "nodeRefId")
  if (hasGraphId === hasNodeRefId) {
    throw new TypeError("Proof source must provide exactly one of graphId or nodeRefId")
  }
  if (hasGraphId) {
    if (typeof source.graphId !== "string" || !PROOF_COMPONENT_ID.test(source.graphId)) {
      throw new TypeError("Proof graphId is not canonical")
    }
    return { kind: "proof.graph", id: source.graphId }
  }
  if (typeof source.nodeRefId !== "string") throw new TypeError("Proof nodeRefId is not canonical")
  const separator = source.nodeRefId.indexOf("#")
  const readable = separator > 0
    && source.nodeRefId.indexOf("#", separator + 1) === -1
    && PROOF_COMPONENT_ID.test(source.nodeRefId.slice(0, separator))
    && PROOF_COMPONENT_ID.test(source.nodeRefId.slice(separator + 1))
    && Array.from(source.nodeRefId).length <= 512
  const fallback = source.nodeRefId.match(PROOF_NODE_FALLBACK_ID)
  if (!readable && !fallback) {
    throw new TypeError("Proof nodeRefId is not a canonical registry identity")
  }
  if (fallback && fallback[1] !== contentSha256) {
    throw new TypeError("Proof nodeRefId digest does not match its immutable revision")
  }
  return { kind: "proof.node", id: source.nodeRefId }
}

function proofRevision(source) {
  const hasContentSha256 = Object.hasOwn(source, "contentSha256")
  const hasRevisionId = Object.hasOwn(source, "revisionId")
  if (hasContentSha256 === hasRevisionId) {
    throw new TypeError("Proof source must provide exactly one immutable digest")
  }
  if (hasContentSha256) {
    const contentSha256 = requiredSha256(source.contentSha256, "Proof revision")
    return { contentSha256, revisionId: `sha256:${contentSha256}` }
  }
  const revisionId = canonicalDigestRevision(source.revisionId, "Proof revision")
  return { contentSha256: revisionId.slice("sha256:".length), revisionId }
}

function representation(ref, kind, mediaType, contentHash, label) {
  return {
    ref,
    kind,
    mediaType,
    contentHash: typeof contentHash === "string" && SHA256.test(contentHash) ? contentHash.toLowerCase() : null,
    label,
  }
}

function finalize(value) {
  return createGalaxyObjectProjection(value)
}

export function projectPaperObject({ paper, revision: paperRevision }) {
  // `null` explicitly means the authorized latest paper record. Omission keeps
  // the detail-record convenience of selecting its first concrete revision.
  const selectedRevision = paperRevision === undefined
    ? (Array.isArray(paper?.revisions) ? paper.revisions[0] : null)
    : paperRevision
  const identity = revision(
    "paper",
    paper.id,
    selectedRevision ? digestRevision(selectedRevision.metadata_hash, "Paper revision") : null,
    selectedRevision?.metadata_hash || paper.metadata_hash,
  )
  const representations = [representation(
    `gb:representation:paper:${encodeURIComponent(paper.id)}:metadata`,
    "json",
    "application/json",
    selectedRevision?.metadata_hash || paper.metadata_hash,
    "Paper metadata",
  )]
  const selectedDocument = selectedRevision?.document?.durable_document
    ? {
        ref: selectedRevision.document.durable_document.ref,
        document_id: selectedRevision.document.durable_document.document_id,
        revision_id: selectedRevision.document.durable_document.revision_id,
        revision_sha256: selectedRevision.document.durable_document.revision_sha256,
        content_sha256: selectedRevision.document.durable_document.content_sha256,
        media_type: selectedRevision.document.durable_document.media_type,
        display_filename: selectedRevision.document.durable_document.display_filename,
      }
    : selectedRevision?.document?.ref
      ? selectedRevision.document
      : null
  if (selectedDocument) {
    const documentReference = parseGalaxyObjectReference(selectedDocument.ref)
    if (
      !documentReference
      || documentReference.format !== "canonical"
      || documentReference.kind !== "document"
      || documentReference.id !== selectedDocument.document_id
      || documentReference.selector.mode !== "pinned"
      || documentReference.selector.revision !== `sha256:${requiredSha256(selectedDocument.revision_sha256, "Document revision")}`
    ) throw new TypeError("Paper document must provide its exact pinned document reference")
    representations.push(representation(
      selectedDocument.ref,
      "pdf",
      selectedDocument.media_type,
      selectedDocument.content_sha256,
      selectedDocument.display_filename,
    ))
  }
  return finalize({
    schemaId: "gb.object-projection.v1",
    ...identity,
    kind: "paper",
    title: bounded(paper.title, 240, "Untitled paper"),
    summary: bounded(paper.abstract, 4000, undefined),
    mediaType: selectedDocument?.media_type || "application/vnd.galaxy.paper+json",
    representations,
    provenance: {
      provider: "galaxy.paper",
      sourceId: paper.id,
      sourceRevision: selectedRevision?.id || undefined,
      statement: "Authorized Galaxy paper projection.",
    },
    capabilities: ["open", "annotate", "place", "cite", "export", "relate"],
  })
}

function displayText(value) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u0020\u007f-\u009f]+/gu, " ").trim()
    : value
}

function requiredSha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TypeError(`${label} must be an exact SHA-256 digest`)
  }
  return value.toLowerCase()
}

export function projectDocumentObject(source) {
  const digest = requiredSha256(source.revision_sha256, "Document revision")
  const revisionId = `sha256:${digest}`
  const identity = revision("document", source.document_id, revisionId, digest)
  const representations = Array.isArray(source.representations)
    ? source.representations.slice(0, 32).map((item) => representation(
        `gb:representation:document:${encodeURIComponent(source.document_id)}:${encodeURIComponent(item.id)}`,
        item.kind === "document-structure" ? "structure" : item.kind,
        item.media_type,
        requiredSha256(item.content_sha256, "Document representation"),
        item.label || item.kind,
      ))
    : []
  return finalize({
    schemaId: "gb.object-projection.v1",
    ...identity,
    kind: "document",
    title: bounded(displayText(source.title || source.display_filename), 240, "Untitled document"),
    summary: bounded(displayText(source.summary), 4000, undefined),
    mediaType: source.media_type || representations[0]?.mediaType || "application/octet-stream",
    representations,
    rasterImage: source.raster_image,
    audioOriginal: source.audio_original,
    provenance: {
      provider: "galaxy.document",
      sourceId: source.document_id,
      sourceRevision: revisionId || undefined,
      statement: "Immutable document revision with separately addressable representations.",
    },
    capabilities: ["open", "annotate", "place", "cite", "export", "relate"],
  })
}

export function projectDocumentAnchorObject(source) {
  const digest = requiredSha256(source.representation_sha256, "Anchor representation")
  const anchorDigest = requiredSha256(source.anchor_sha256, "Document anchor")
  if (source.id !== `sha256:${anchorDigest}`) {
    throw new TypeError("Document anchor id must match its exact anchor digest")
  }
  const revisionId = `sha256:${digest}`
  const identity = revision("document.anchor", source.id, revisionId, digest)
  const selector = source.selector || {}
  const location = selector.kind === "page-region"
    ? `Page ${selector.page}`
    : selector.kind === "json-pointer"
      ? selector.pointer
      : bounded(displayText(selector.exact), 160, "Text selection")
  const documentTitle = bounded(displayText(source.title), 160, undefined)
  return finalize({
    schemaId: "gb.object-projection.v1",
    ...identity,
    kind: "document.anchor",
    title: bounded(documentTitle ? `${location} — ${documentTitle}` : location, 240, "Document anchor"),
    summary: selector.kind === "text-quote" ? bounded(displayText(selector.exact), 4000, undefined) : undefined,
    mediaType: "application/vnd.galaxy.document-anchor+json",
    representations: [representation(
      `gb:representation:document-anchor:${encodeURIComponent(source.id)}`,
      "json",
      "application/vnd.galaxy.document-anchor+json",
      anchorDigest,
      "Immutable anchor selector",
    )],
    provenance: {
      provider: "galaxy.document",
      sourceId: source.id,
      sourceRevision: revisionId || undefined,
      statement: "Immutable selector bound to an exact document representation.",
    },
    capabilities: ["open", "annotate", "place", "cite", "inspect", "relate"],
  })
}

export function projectMarkdownObject(source) {
  const kind = source.objectKind || "artifact"
  const identity = revision(kind, source.id, source.revisionId, source.contentHash)
  return finalize({
    schemaId: "gb.object-projection.v1",
    ...identity,
    kind,
    title: bounded(source.title, 240, "Untitled Markdown document"),
    summary: bounded(source.summary, 4000, undefined),
    mediaType: source.mediaType || "text/markdown",
    representations: [representation(
      source.representationRef,
      "markdown",
      source.mediaType || "text/markdown",
      source.contentHash,
      "Markdown",
    )],
    provenance: {
      provider: bounded(source.provider, 120, "galaxy.artifact"),
      sourceId: source.id,
      sourceRevision: identity.revision.id || undefined,
    },
    capabilities: ["open", "annotate", "place", "cite", "export", "relate"],
  })
}

export function projectCodeObject(source) {
  const identity = revision(source.objectKind, source.id, source.revisionId, source.contentHash)
  return finalize({
    schemaId: "gb.object-projection.v1",
    ...identity,
    kind: source.objectKind,
    title: bounded(displayText(source.title), 240, "Untitled code object"),
    summary: bounded(displayText(source.summary), 4000, undefined),
    mediaType: "application/vnd.galaxy.code-graph+json",
    representations: [representation(
      source.representationRef,
      "structure",
      "application/json",
      source.contentHash,
      "Exact Codebase Memory snapshot",
    )],
    provenance: {
      provider: "galaxy.code.snapshot",
      sourceId: source.id,
      sourceRevision: source.revisionId,
      statement: "Transient projection derived from an authorized exact Codebase Memory JSON snapshot.",
    },
    capabilities: ["open", "cite", "inspect"],
  })
}

export function projectMediaObject(source) {
  const kind = source.objectKind || "artifact"
  const identity = revision(kind, source.id, source.revisionId, source.contentHash)
  const family = source.mediaType.split("/", 1)[0]
  const representationKind = ["image", "audio", "video"].includes(family) ? family : "original"
  return finalize({
    schemaId: "gb.object-projection.v1",
    ...identity,
    kind,
    title: bounded(source.title, 240, "Untitled media"),
    summary: bounded(source.summary, 4000, undefined),
    mediaType: source.mediaType,
    representations: [representation(
      source.representationRef,
      representationKind,
      source.mediaType,
      source.contentHash,
      bounded(source.label, 120, "Original media"),
    )],
    provenance: {
      provider: bounded(source.provider, 120, "galaxy.artifact"),
      sourceId: source.id,
      sourceRevision: identity.revision.id || undefined,
    },
    capabilities: ["open", "annotate", "place", "cite", "relate"],
  })
}

export function projectElnObject(record) {
  // ELN records currently expose a mutable head, not an immutable content
  // digest. Keep their canonical identity on `latest`; the observed timestamp
  // is provenance and must not masquerade as a resolvable revision selector.
  const identity = revision("eln.experiment", record.id, null, null)
  const summary = record.sections?.find((section) => section.key === "interpretation")?.content
    || record.sections?.find((section) => section.key === "results")?.content
  return finalize({
    schemaId: "gb.object-projection.v1",
    ...identity,
    kind: "eln.experiment",
    title: bounded(record.title, 240, "Untitled experiment"),
    summary: bounded(summary, 4000, undefined),
    mediaType: "application/vnd.galaxy.research-record+json",
    representations: [
      representation(`gb:representation:eln:${encodeURIComponent(record.id)}:record`, "json", "application/json", null, "Research record"),
      representation(`gb:representation:eln:${encodeURIComponent(record.id)}:markdown`, "markdown", "text/markdown", null, "Portable Markdown"),
    ],
    provenance: {
      provider: record.provenance.source,
      sourceId: record.id,
      sourceRevision: bounded(record.provenance.updatedAt, 256, undefined),
      statement: "Versioned ELN research record projection.",
    },
    capabilities: ["open", "annotate", "place", "branch", "cite", "export", "relate"],
  })
}

export function projectElnObservation(source) {
  const digest = requiredSha256(source.revisionSha256, "ELN observation revision")
  const identity = revision("eln.observation", source.id, `sha256:${digest}`, digest)
  return finalize({
    schemaId: "gb.object-projection.v1",
    ...identity,
    kind: "eln.observation",
    title: bounded(source.body, 120, "Observation"),
    summary: bounded(source.body, 4000, undefined),
    mediaType: "application/vnd.galaxy.eln-observation+json",
    representations: [representation(
      `gb:representation:eln-observation:${encodeURIComponent(source.id)}:v${source.version}`,
      "json",
      "application/json",
      digest,
      "Immutable observation",
    )],
    provenance: {
      provider: "galaxy-brain-eln",
      sourceId: source.id,
      sourceRevision: `sha256:${digest}`,
      statement: `Observed ${source.observedAt} in experiment ${source.experimentId}.`,
    },
    capabilities: ["open", "annotate", "place", "cite", "relate"],
  })
}

export function projectTaskObject(task) {
  const revisionId = Number.isSafeInteger(task.version) && task.version > 0 ? `version:${task.version}` : null
  // HAM task links are operational identities and intentionally follow the
  // latest task state. The observed version remains projection provenance; it
  // must not change the canonical task identity used by durable links.
  const identity = revision("ham.task", task.id, null, null)
  return finalize({
    schemaId: "gb.object-projection.v1",
    ...identity,
    kind: "ham.task",
    title: bounded(task.title, 240, "Untitled task"),
    summary: bounded(task.goal || task.why, 4000, undefined),
    mediaType: "application/vnd.ham.task+json",
    representations: [representation(
      `ham:task:${encodeURIComponent(task.id)}${task.version ? `:v${task.version}` : ""}`,
      "json",
      "application/json",
      null,
      "HAM task",
    )],
    provenance: {
      provider: "ham",
      sourceId: task.id,
      sourceRevision: revisionId || undefined,
      statement: "Authorized, disclosure-filtered HAM task projection.",
    },
    capabilities: ["open", "place", "branch", "cite", "inspect", "relate"],
  })
}

export function projectChatObject(chat) {
  const contentSha256 = requiredSha256(chat.contentSha256, "Conversation revision")
  const revisionId = `sha256:${contentSha256}`
  const identity = revision("chat", chat.conversationId, revisionId, contentSha256)
  return finalize({
    schemaId: "gb.object-projection.v1",
    ...identity,
    kind: "chat",
    title: bounded(chat.title, 240, "Untitled conversation"),
    summary: bounded(chat.goalSummary, 4000, undefined),
    mediaType: "application/vnd.galaxy.conversation+json",
    representations: [],
    provenance: {
      provider: "galaxy.conversation",
      sourceId: chat.conversationId,
      sourceRevision: revisionId,
      statement: "Immutable tenant-scoped conversation state.",
    },
    capabilities: ["open", "place", "branch", "cite", "inspect", "relate"],
  })
}

export function projectProofObject(source) {
  const { contentSha256, revisionId } = proofRevision(source)
  const { kind, id } = proofIdentity(source, contentSha256)
  const identity = revision(kind, id, revisionId, contentSha256)
  return finalize({
    schemaId: "gb.object-projection.v1",
    ...identity,
    kind,
    title: bounded(source.title, 240, kind === "proof.node" ? "Untitled proof target" : "Untitled proof graph"),
    summary: bounded(source.objective || source.summary, 4000, undefined),
    mediaType: "application/vnd.galaxy.proof-dag+json",
    representations: [representation(
      `gb:representation:proof:${encodeURIComponent(id)}:dag`,
      "structure",
      "application/json",
      contentSha256,
      kind === "proof.node" ? "Proof target" : "Proof DAG",
    )],
    provenance: {
      provider: bounded(source.provider, 120, "galaxy.proof"),
      sourceId: id,
      sourceRevision: revisionId || undefined,
      statement: "Proof structure projection; work and verification state remain separate.",
    },
    capabilities: ["open", "place", "cite", "inspect", "relate"],
  })
}

export function projectHamMemoryObject(memory) {
  const revisionId = Number.isSafeInteger(memory.version) && memory.version > 0 ? `version:${memory.version}` : null
  // HAM memory reads currently expose only the operational head. Preserve the
  // observed version as provenance without fabricating an immutable selector.
  const identity = revision("ham.memory", memory.id, null, null)
  return finalize({
    schemaId: "gb.object-projection.v1",
    ...identity,
    kind: "ham.memory",
    title: bounded(memory.title, 240, `HAM memory ${memory.id}`),
    summary: bounded(memory.content, 4000, undefined),
    mediaType: "application/vnd.ham.memory+json",
    representations: [representation(
      `ham:memory:${encodeURIComponent(memory.id)}${memory.version ? `:v${memory.version}` : ""}`,
      "text",
      "text/plain",
      null,
      "Memory content",
    )],
    provenance: {
      provider: "ham",
      sourceId: memory.id,
      sourceRevision: revisionId || undefined,
      statement: "Authorized HAM memory projection.",
    },
    capabilities: ["open", "place", "cite", "inspect", "relate"],
  })
}

export function projectSurfaceObject(surface) {
  // Surface version numbers are display/provenance metadata. The content hash
  // is the immutable selector understood by the canonical referent resolver.
  const revisionId = digestRevision(surface.current_content_hash, "Surface revision")
  const identity = revision("surface", surface.id, revisionId, surface.current_content_hash)
  return finalize({
    schemaId: "gb.object-projection.v1",
    ...identity,
    kind: "surface",
    title: bounded(surface.title, 240, "Untitled surface"),
    summary: `Generous ${surface.catalog_id || "bounded"} surface · ${surface.status || "unknown"}`,
    mediaType: "application/vnd.galaxy.surface+json",
    representations: [representation(
      `gb:representation:surface:${encodeURIComponent(surface.id)}:${revisionId || "latest"}`,
      "surface",
      "application/json",
      surface.current_content_hash,
      "Bounded surface",
    )],
    provenance: {
      provider: "galaxy.surface",
      sourceId: surface.id,
      sourceRevision: Number.isSafeInteger(surface.current_version) && surface.current_version > 0
        ? `version:${surface.current_version}`
        : revisionId,
      statement: "Bounded surface definition; live bindings require separate authorized resolution.",
    },
    capabilities: surface.placement_eligible === true
      ? ["open", "place", "cite", "inspect", "relate"]
      : ["open", "cite", "inspect", "relate"],
  })
}

export function projectUnknownReference(reference, reason = "No registered projector is available.") {
  const parsed = typeof reference === "string" ? parseGalaxyObjectReference(reference) : reference
  if (!parsed || parsed.format !== "canonical") throw new TypeError("Unknown projection requires a canonical object reference")
  return finalize({
    schemaId: "gb.object-projection.v1",
    ref: createGalaxyObjectReference(parsed.kind, parsed.id, parsed.selector),
    kind: parsed.kind,
    revision: {
      policy: parsed.selector.mode,
      id: parsed.selector.mode === "pinned" ? parsed.selector.revision : null,
      contentHash: null,
    },
    title: `Unknown ${parsed.kind} reference`,
    summary: bounded(reason, 4000, "No registered projector is available."),
    representations: [],
    provenance: {
      provider: "galaxy.reference",
      sourceId: parsed.id,
      sourceRevision: parsed.selector.mode === "pinned" ? parsed.selector.revision : undefined,
      statement: "Identity retained without fabricating canonical content.",
    },
    capabilities: ["inspect", "cite"],
  })
}
