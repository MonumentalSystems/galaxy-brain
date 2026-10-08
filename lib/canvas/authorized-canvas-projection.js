import {
  createGalaxyObjectReference,
  parseGalaxyObjectReference,
  serializeGalaxyObjectReference,
} from "../galaxy-object-reference.js"
import {
  HAM_RELATION_OVERLAY_MAX_REFERENCES,
  parseHamRelationOverlayResponse,
} from "../ham-relation-overlay-contract.js"
import { projectSurface } from "../surface-projection.js"

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const MAX_ITEMS_PER_SOURCE = 60
const COLUMN_COUNT = 5
const COLUMN_GAP = 430
const ROW_GAP = 340
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const OBJECT_LINK_RELATIONS = new Set([
  "related",
  "cites",
  "part_of",
  "derived_from",
  "context_for",
  "formalized_by",
  "defined_in",
  "implements",
  "depends_on",
  "documents",
  "corresponds_to",
])
const OBJECT_LINK_BASES = new Set(["authored", "imported", "derived"])
const OBJECT_LINK_PROVENANCE_KEYS = new Set([
  "source",
  "source_system",
  "source_ref",
  "source_snapshot",
  "extractor_version",
  "confidence",
])
const SHA256_REVISION = /^sha256:[0-9a-f]{64}$/u
const CODE_REVISION = /^git:(?:[0-9a-f]{40}|[0-9a-f]{64});snapshot:sha256:[0-9a-f]{64}$/u
const PINNED_OBJECT_LINK_KINDS = new Set([
  "document",
  "document.anchor",
  "document.mark",
  "code.repo",
  "code.commit",
  "code.file",
  "code.symbol",
  "code.graph",
  "proof.graph",
  "proof.node",
])

function boundedText(value, maximum, fallback = "") {
  if (typeof value !== "string") return fallback
  const normalized = value.trim()
  if (!normalized) return fallback
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`
}

function boundedIdentifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : null
}

function boundedRevision(value) {
  return typeof value === "string" && value.trim() && value.length <= 256 && !CONTROL_CHARACTERS.test(value)
    ? value.trim()
    : null
}

function digestRevision(value) {
  const normalized = boundedRevision(value)
  if (!normalized) return null
  const digest = normalized.startsWith("sha256:") ? normalized.slice(7) : normalized
  return /^[a-f0-9]{64}$/iu.test(digest) ? `sha256:${digest.toLowerCase()}` : null
}

function placementIdentifier(prefix, id, suffix = "") {
  const candidate = `${prefix}-${id}${suffix}`
  return IDENTIFIER.test(candidate) ? candidate : null
}

function pinnedOrLatest(kind, id, revision) {
  const normalizedRevision = boundedRevision(revision)
  return createGalaxyObjectReference(
    kind,
    id,
    normalizedRevision
      ? { mode: "pinned", revision: normalizedRevision }
      : { mode: "latest" },
  )
}

function exactCanonicalReference(value) {
  const parsed = parseGalaxyObjectReference(value)
  if (!parsed || parsed.format !== "canonical") return null
  if (PINNED_OBJECT_LINK_KINDS.has(parsed.kind)) {
    if (parsed.selector.mode !== "pinned") return null
    const revisionGrammar = parsed.kind.startsWith("code.") ? CODE_REVISION : SHA256_REVISION
    if (!revisionGrammar.test(parsed.selector.revision)) return null
  }
  try {
    const canonical = serializeGalaxyObjectReference(parsed)
    return canonical === value ? canonical : null
  } catch {
    return null
  }
}

function boundedProvenanceText(value, maximum, required = false) {
  if (value === undefined && !required) return null
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > maximum || CONTROL_CHARACTERS.test(value)) {
    return null
  }
  return value
}

function validObjectLinkProvenance(value, basis) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  if (Object.keys(value).some((key) => !OBJECT_LINK_PROVENANCE_KEYS.has(key))) return false

  const expectedSource = { authored: "manual", imported: "import", derived: "derivation" }[basis]
  if (value.source !== expectedSource) return false
  if (!boundedProvenanceText(value.source_system, 128, true)) return false

  const machineGenerated = basis === "imported" || basis === "derived"
  const sourceRef = boundedProvenanceText(value.source_ref, 512, machineGenerated)
  const snapshot = boundedProvenanceText(value.source_snapshot, 71, machineGenerated)
  const extractor = boundedProvenanceText(value.extractor_version, 128, machineGenerated)
  if ((value.source_ref !== undefined && !sourceRef) || (value.source_snapshot !== undefined && !snapshot) || (value.extractor_version !== undefined && !extractor)) {
    return false
  }
  if (snapshot && !SHA256_REVISION.test(snapshot)) return false

  const confidence = value.confidence
  if (confidence !== undefined && (
    typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1
  )) return false
  if (basis === "authored" && (snapshot || extractor || confidence !== undefined)) return false
  return true
}

function normalizeAuthorizedObjectLinkEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.authorized !== true || value.active !== true) return null
  const link = value.link
  if (!link || typeof link !== "object" || Array.isArray(link)) return null

  const id = typeof link.id === "string" && UUID.test(link.id) ? link.id.toLowerCase() : null
  const fromRef = exactCanonicalReference(link.from_ref)
  const toRef = exactCanonicalReference(link.to_ref)
  const relation = typeof link.relation === "string" && OBJECT_LINK_RELATIONS.has(link.relation) ? link.relation : null
  const basis = typeof link.basis === "string" && OBJECT_LINK_BASES.has(link.basis) ? link.basis : null
  if (!id || !fromRef || !toRef || fromRef === toRef || !relation || !basis || !validObjectLinkProvenance(link.provenance, basis)) {
    return null
  }
  return { id, fromRef, toRef, relation, basis }
}

function normalizedLinkKey(link) {
  return [link.fromRef, link.toRef, link.relation, link.basis].join("\u0000")
}

/**
 * Project explicitly-authorized active object-link envelopes onto already
 * authorized, resolved canvas placements. This function performs no lookup:
 * exact canonical endpoint identity is mandatory, and malformed or missing
 * inputs are omitted rather than guessed or repaired.
 */
export function projectAuthorizedObjectLinkRelations(placements, envelopes, options = {}) {
  const preferredPlacementIds = new Set(
    Array.isArray(options.preferredPlacementIds)
      ? options.preferredPlacementIds.filter((id) => boundedIdentifier(id))
      : [],
  )
  const placementByRef = new Map()
  for (const placement of Array.isArray(placements) ? placements : []) {
    if (placement?.authorized !== true || placement.availability === "unavailable" || !boundedIdentifier(placement.id)) continue
    const subjectRef = exactCanonicalReference(placement.subjectRef)
    if (!subjectRef) continue
    const existing = placementByRef.get(subjectRef)
    const preferred = preferredPlacementIds.has(placement.id)
    const existingPreferred = existing ? preferredPlacementIds.has(existing.id) : false
    if (
      !existing
      || (preferred && !existingPreferred)
      || (preferred === existingPreferred && placement.id.localeCompare(existing.id) < 0)
    ) placementByRef.set(subjectRef, placement)
  }

  const linksById = new Map()
  const conflictingIds = new Set()
  for (const envelope of Array.isArray(envelopes) ? envelopes : []) {
    const link = normalizeAuthorizedObjectLinkEnvelope(envelope)
    if (!link || conflictingIds.has(link.id)) continue
    const existing = linksById.get(link.id)
    if (existing && normalizedLinkKey(existing) !== normalizedLinkKey(link)) {
      linksById.delete(link.id)
      conflictingIds.add(link.id)
      continue
    }
    linksById.set(link.id, link)
  }

  return [...linksById.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .flatMap((link) => {
      const source = placementByRef.get(link.fromRef)
      const target = placementByRef.get(link.toRef)
      if (!source || !target) return []
      const trustClass = link.basis === "authored" ? "asserted" : "deterministic"
      return [{
        id: `object-link-${link.id}`,
        sourcePlacementId: source.id,
        targetPlacementId: target.id,
        relationType: link.relation,
        trustClass,
        owner: "Galaxy object-link ledger",
        provenance: trustClass === "asserted"
          ? "Authorized authored object-link assertion; no verification claim is implied."
          : "Authorized object-link structure; no verification claim is implied.",
      }]
    })
}

/**
 * Select the bounded latest-HAM reference scope from independently authorized,
 * resolved placements while retaining the pre-slice count for honest UI and
 * provenance reporting.
 */
export function selectAuthorizedHamRelationReferences(placements) {
  const eligible = []
  const seen = new Set()
  for (const placement of Array.isArray(placements) ? placements : []) {
    if (placement?.authorized !== true || placement.availability === "unavailable") continue
    const subjectRef = exactCanonicalReference(placement.subjectRef)
    const parsed = subjectRef ? parseGalaxyObjectReference(subjectRef) : null
    if (
      !parsed || parsed.format !== "canonical" || parsed.kind !== "ham.memory"
      || parsed.selector.mode !== "latest" || seen.has(subjectRef)
    ) continue
    seen.add(subjectRef)
    eligible.push(subjectRef)
  }
  return Object.freeze({
    eligibleCount: eligible.length,
    references: Object.freeze(eligible.slice(0, HAM_RELATION_OVERLAY_MAX_REFERENCES)),
    clientTruncated: eligible.length > HAM_RELATION_OVERLAY_MAX_REFERENCES,
  })
}

/**
 * Project HAM-owned authored relations onto already-authorized, resolved
 * placements. The overlay contributes no nodes and never becomes canvas
 * snapshot state. In particular, HAM `verifies` remains an assertion rather
 * than a verified receipt.
 */
export function projectAuthorizedHamRelationOverlay(placements, value, options = {}) {
  let overlay
  try {
    overlay = parseHamRelationOverlayResponse(value)
  } catch {
    return []
  }
  const preferredPlacementIds = new Set(
    Array.isArray(options.preferredPlacementIds)
      ? options.preferredPlacementIds.filter((id) => boundedIdentifier(id))
      : [],
  )
  const placementByRef = new Map()
  for (const placement of Array.isArray(placements) ? placements : []) {
    if (placement?.authorized !== true || placement.availability === "unavailable" || !boundedIdentifier(placement.id)) continue
    const subjectRef = exactCanonicalReference(placement.subjectRef)
    const parsed = subjectRef ? parseGalaxyObjectReference(subjectRef) : null
    if (!parsed || parsed.format !== "canonical" || parsed.kind !== "ham.memory" || parsed.selector.mode !== "latest") continue
    const existing = placementByRef.get(subjectRef)
    const preferred = preferredPlacementIds.has(placement.id)
    const existingPreferred = existing ? preferredPlacementIds.has(existing.id) : false
    if (
      !existing
      || (preferred && !existingPreferred)
      || (preferred === existingPreferred && placement.id.localeCompare(existing.id) < 0)
    ) placementByRef.set(subjectRef, placement)
  }
  const clientScope = selectAuthorizedHamRelationReferences(placements)
  const truncation = [
    ...(clientScope.clientTruncated
      ? [`client-truncated to ${HAM_RELATION_OVERLAY_MAX_REFERENCES} of ${clientScope.eligibleCount} eligible references`]
      : []),
    ...(overlay.provider.truncated ? ["provider-truncated"] : []),
  ]

  return overlay.relations.flatMap((relation) => {
    const source = placementByRef.get(relation.sourceRef)
    const target = placementByRef.get(relation.targetRef)
    if (!source || !target) return []
    const id = relation.kind === "typed"
      ? `ham-link-${relation.id}`
      : `ham-lineage-${relation.id.replaceAll(":", "-")}`
    if (!boundedIdentifier(id)) return []
    return [{
      id,
      sourcePlacementId: source.id,
      targetPlacementId: target.id,
      relationType: relation.relation === "depends-on" ? "depends_on" : relation.relation,
      trustClass: "asserted",
      owner: "HAM",
      provenance: `Authorized live HAM authored relation; follow-latest and partial${truncation.length > 0 ? `, ${truncation.join(" and ")}` : ""}, with no verification claim implied.`,
    }]
  })
}

function stableEntries(values) {
  return (Array.isArray(values) ? values : [])
    .filter((value) => value?.authorized === true && boundedIdentifier(value.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, MAX_ITEMS_PER_SOURCE)
}

function geometry(index, width = 380, height = 250) {
  return {
    x: (index % COLUMN_COUNT) * COLUMN_GAP,
    y: Math.floor(index / COLUMN_COUNT) * ROW_GAP,
    width,
    height,
  }
}

function compactSourceLayout(groups) {
  let startRow = 0
  return groups.flatMap((group) => {
    if (group.length === 0) return []
    const positioned = group.map((placement, index) => ({
      ...placement,
      y: (startRow + Math.floor(index / COLUMN_COUNT)) * ROW_GAP,
    }))
    startRow += Math.ceil(group.length / COLUMN_COUNT) + 1
    return positioned
  })
}

function workspaceNodeType(type) {
  if (["note", "canvas-note", "prompt"].includes(type)) return "galaxy.note"
  if (["document", "code", "jupyter", "template"].includes(type)) return "galaxy.document"
  if (["image", "video", "audio", "3d", "drawing", "whiteboard"].includes(type)) return "galaxy.media"
  return null
}

function projectWorkspaceNodes(values) {
  return stableEntries(values).flatMap((node, index) => {
    const nodeType = workspaceNodeType(node.type)
    const id = placementIdentifier("workspace", node.id)
    if (!nodeType || !id) return []
    const version = Number.isSafeInteger(node.version) && node.version > 0
      ? `version:${node.version}`
      : null
    const subjectRef = pinnedOrLatest("artifact", `workspace-node:${node.id}`, version)
    const content = boundedText(node.content, 12_000)
    const mediaType = boundedText(node.mediaType, 160)
    return [{
      id,
      authorized: true,
      subjectRef,
      nodeType,
      ...geometry(index, nodeType === "galaxy.note" ? 400 : 380, 260),
      display: {
        title: boundedText(node.title, 240, "Untitled workspace item"),
        subtitle: "Tenant-scoped workspace object",
        summary: boundedText(node.summary || content, 2_000) || undefined,
        markdown: nodeType !== "galaxy.media" && content ? content : undefined,
        revision: version || "latest",
        status: "read-only",
        provenance: "Existing tenant-scoped Galaxy workspace object.",
        href: `/workspace?ref=${encodeURIComponent(subjectRef)}`,
        mediaType: nodeType === "galaxy.media" ? mediaType || boundedText(node.type, 80) : undefined,
        badges: [boundedText(node.type, 80, "workspace"), "workspace", "read-only"],
      },
    }]
  })
}

function projectPapers(values) {
  return stableEntries(values).flatMap((paper, index) => {
    const id = placementIdentifier("paper", paper.id)
    const revision = digestRevision(paper.metadataHash)
    if (!id || !revision) return []
    const authors = Array.isArray(paper.authors)
      ? paper.authors.map((author) => boundedText(author?.name, 120)).filter(Boolean).slice(0, 4)
      : []
    const categories = Array.isArray(paper.categories)
      ? paper.categories.map((category) => boundedText(category, 80)).filter(Boolean).slice(0, 3)
      : []
    return [{
      id,
      authorized: true,
      subjectRef: pinnedOrLatest("paper", paper.id, revision),
      nodeType: "galaxy.paper",
      ...geometry(index, 420, 270),
      display: {
        title: boundedText(paper.title, 240, "Untitled paper"),
        subtitle: authors.length ? authors.join(", ") : "Galaxy paper library",
        summary: boundedText(paper.abstract, 2_000) || undefined,
        revision: revision || "latest",
        status: "imported",
        provenance: "Authorized Galaxy paper projection.",
        href: "/papers",
        badges: ["paper", ...categories],
      },
    }]
  })
}

function projectExperiments(values) {
  return stableEntries(values).flatMap((experiment, index) => {
    const id = placementIdentifier("experiment", experiment.id)
    if (!id) return []
    const observedRevision = boundedRevision(experiment.updatedAt)
    const summary = experiment.interpretation || experiment.results || experiment.hypothesis
    const tags = Array.isArray(experiment.tags)
      ? experiment.tags.map((tag) => boundedText(tag, 80)).filter(Boolean).slice(0, 2)
      : []
    return [{
      id,
      authorized: true,
      subjectRef: pinnedOrLatest("eln.experiment", experiment.id, null),
      nodeType: "galaxy.eln-record",
      ...geometry(index, 420, 260),
      display: {
        title: boundedText(experiment.title, 240, "Untitled experiment"),
        subtitle: boundedText(experiment.domain, 120, "ELN research record"),
        summary: boundedText(summary, 2_000) || undefined,
        revision: observedRevision || "latest",
        status: boundedText(experiment.status, 80, "unknown"),
        provenance: "Authorized Galaxy ELN projection.",
        href: `/eln/experiment/${encodeURIComponent(experiment.id)}`,
        badges: ["ELN", ...tags],
      },
    }]
  })
}

function taskRevision(task) {
  return Number.isSafeInteger(task.version) && task.version > 0
    ? `version:${task.version}`
    : null
}

function projectTasks(values) {
  return stableEntries(values).flatMap((task, index) => {
    const id = placementIdentifier("task", task.id)
    if (!id) return []
    return [{
      id,
      authorized: true,
      // HAM task identity intentionally follows the operational head. The
      // observed version belongs in display/provenance, not in the ref.
      subjectRef: pinnedOrLatest("ham.task", task.id, null),
      nodeType: "galaxy.task",
      ...geometry(index, 400, 250),
      display: {
        title: boundedText(task.title, 240, "Untitled task"),
        subtitle: `HAM task · ${boundedText(task.riskMode, 80, "unspecified")}`,
        summary: boundedText(task.goal || task.why, 2_000) || undefined,
        revision: taskRevision(task) || "latest",
        status: boundedText(task.state, 80, "unknown"),
        provenance: "Authorized, disclosure-filtered HAM task projection.",
        href: "/tasks",
        badges: ["task", boundedText(task.lifecyclePhase, 80, "unknown"), boundedText(task.riskMode, 80, "unspecified")],
      },
    }]
  })
}

function projectProofReferences(values) {
  const proofs = []
  const relations = []
  for (const task of stableEntries(values)) {
    const claims = Array.isArray(task.resources) ? task.resources : []
    const proofClaims = claims.filter((claim) => (
      claim?.redacted !== true &&
      claim?.resourceClass === "proof-packet" &&
      typeof claim.resourceRef === "string" &&
      claim.resourceRef.length <= 512
    ))
    for (const [claimIndex, claim] of proofClaims.entries()) {
      const taskPlacementId = placementIdentifier("task", task.id)
      const placementId = placementIdentifier("proof", task.id, `-${claimIndex + 1}`)
      if (!taskPlacementId || !placementId) continue
      let subjectRef
      try {
        // A HAM proof-packet claim identifies an authorized packet artifact,
        // not a Prove2Me graph node or a Galaxy verification receipt.
        subjectRef = createGalaxyObjectReference("artifact", claim.resourceRef)
      } catch {
        continue
      }
      const index = proofs.length
      proofs.push({
        id: placementId,
        authorized: true,
        subjectRef,
        nodeType: "galaxy.proof",
        ...geometry(index, 430, 260),
        display: {
          title: boundedText(task.title, 240, "Referenced proof packet"),
          subtitle: "Prove2Me packet reference · HAM work context",
          summary: "Galaxy retains its durable proof graph. This authorized Prove2Me packet reference supplies interoperable work context only.",
          revision: "latest",
          status: boundedText(task.state, 80, "referenced"),
          provenance: "Authorized HAM resource claim; no verification claim is implied.",
          href: "/tasks",
          badges: ["Prove2Me reference", "HAM context", "unverified"],
        },
      })
      relations.push({
        id: `task-proof-${task.id}-${claimIndex + 1}`,
        sourcePlacementId: taskPlacementId,
        targetPlacementId: placementId,
        relationType: "works_on",
        trustClass: "deterministic",
        owner: "HAM task projection",
        provenance: "Task resource declaration; no proof verification claim.",
      })
    }
  }
  return { proofs, relations }
}

function projectSurfaces(values) {
  return stableEntries(values).flatMap((surface, index) => {
    const id = placementIdentifier("surface", surface.id)
    const safeSurface = projectSurface(surface.spec)
    const revision = digestRevision(surface.contentHash)
    if (!id || !safeSurface.ok || !revision) return []
    const bindingCount = Array.isArray(surface.spec?.bindings) ? surface.spec.bindings.length : 0
    return [{
      id,
      authorized: true,
      subjectRef: pinnedOrLatest("surface", surface.id, revision),
      nodeType: "galaxy.surface",
      ...geometry(index, 500, 340),
      display: {
        title: boundedText(surface.title, 240, "Untitled surface"),
        subtitle: "Generous bounded surface · generous.a2ui@1",
        summary: bindingCount === 0
          ? "Rendered through Galaxy's approved component catalog and fail-closed surface projector."
          : "This bound surface remains a definition-only canvas card. Open its owning view for authorized live resolution.",
        revision: revision || "latest",
        status: boundedText(surface.status, 80, "unknown"),
        provenance: "Authorized Galaxy surface projection.",
        href: "/surfaces",
        badges: ["gb.surface.v1", `${bindingCount} bindings`, "read-only"],
        surfaceSpec: bindingCount === 0 ? surface.spec : undefined,
      },
    }]
  })
}

/**
 * Convert already-authorized resource envelopes into a deterministic Phase 1
 * canvas projection. Every input item must carry `authorized: true`; omitted
 * or false entries never reach the renderer.
 */
export function buildAuthorizedCanvasProjection(input = {}) {
  const workspace = projectWorkspaceNodes(input.workspaceNodes)
  const papers = projectPapers(input.papers)
  const experiments = projectExperiments(input.experiments)
  const tasks = projectTasks(input.tasks)
  const { proofs, relations } = projectProofReferences(input.tasks)
  const surfaces = projectSurfaces(input.surfaces)
  return {
    placements: compactSourceLayout([workspace, papers, experiments, tasks, proofs, surfaces]),
    relations,
  }
}

export const AUTHORIZED_CANVAS_SOURCE_LIMIT = MAX_ITEMS_PER_SOURCE
