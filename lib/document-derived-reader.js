const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u
const STATUSES = new Set(["success", "partial", "fallback", "failed", "skipped"])
const SUCCESS_STATUSES = new Set(["success", "partial", "fallback"])
const KINDS = new Map([
  ["document-structure", "application/vnd.galaxy.document-structure+json"],
  ["markdown", "text/markdown; charset=utf-8"],
])

export class DerivedDocumentError extends Error {}

function invalid(label) {
  throw new DerivedDocumentError(`Derived ${label} reading state is invalid`)
}

function string(value, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || CONTROL.test(value)) invalid(label)
  return value
}

function uuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) invalid(label)
  return value
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) invalid(label)
  return value
}

function representation(value, descriptor, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(label)
  const id = uuid(value.id, label)
  const kind = string(value.kind, 64, label)
  const mediaType = string(value.media_type, 256, label)
  const contentSha256 = sha256(value.content_sha256, label)
  if (kind === "original") {
    if (id !== descriptor.representationId || mediaType !== descriptor.mediaType
      || contentSha256 !== descriptor.contentSha256 || value.artifact_id !== descriptor.artifactId
      || value.content !== null) invalid(label)
  } else {
    if (KINDS.get(kind) !== mediaType || value.artifact_id !== null) invalid(label)
    if (kind === "document-structure") {
      if (!value.content || typeof value.content !== "object" || Array.isArray(value.content)) invalid(label)
    } else if (typeof value.content !== "string" || value.content.length > 8_000_000) invalid(label)
  }
  string(value.created_at, 128, label)
  return value
}

function receipt(value, descriptor, representations, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(label)
  const id = uuid(value.id, label)
  const pluginId = string(value.plugin_id, 128, label)
  const engine = string(value.engine, 128, label)
  string(value.plugin_version, 128, label)
  string(value.engine_version, 128, label)
  sha256(value.config_sha256, label)
  if (sha256(value.input_sha256, label) !== descriptor.contentSha256 || !STATUSES.has(value.status)) invalid(label)
  if (value.diagnostic_code !== null) string(value.diagnostic_code, 128, label)
  string(value.created_at, 128, label)
  if (value.fallback_receipt_id !== null) uuid(value.fallback_receipt_id, label)
  if (!value.output_manifest || typeof value.output_manifest !== "object" || Array.isArray(value.output_manifest)) invalid(label)
  const manifestKeys = Object.keys(value.output_manifest).sort().join(",")
  if (manifestKeys !== "representations,schemaId" && manifestKeys !== "fallbackReceiptId,representations,schemaId") invalid(label)
  if (value.output_manifest.schemaId !== "gb.transform-output-manifest.v1"
    || !Array.isArray(value.output_manifest.representations)
    || value.output_manifest.representations.length > 2) invalid(label)
  const manifestedIds = new Set()
  for (const item of value.output_manifest.representations) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).sort().join(",") !== "contentSha256,id,kind,mediaType") invalid(label)
    const representationId = uuid(item.id, label)
    if (manifestedIds.has(representationId)) invalid(label)
    manifestedIds.add(representationId)
    const kind = string(item.kind, 64, label)
    const mediaType = string(item.mediaType, 256, label)
    const contentSha256 = sha256(item.contentSha256, label)
    if (KINDS.get(kind) !== mediaType) invalid(label)
    const output = representations.find((candidate) => candidate.id === representationId)
    if (!output || output.kind !== kind || output.media_type !== mediaType
      || output.content_sha256 !== contentSha256) invalid(label)
  }
  if (SUCCESS_STATUSES.has(value.status)) {
    const outputId = uuid(value.output_representation_id, label)
    const outputSha256 = sha256(value.output_sha256, label)
    const output = representations.find((candidate) => candidate.id === outputId)
    if (!output || output.content_sha256 !== outputSha256 || !manifestedIds.has(outputId)) invalid(label)
  } else if (value.output_representation_id !== null || value.output_sha256 !== null || manifestedIds.size !== 0) invalid(label)
  return { id, pluginId, engine, receipt: value, manifestedIds }
}

export function shouldAcceptDerivedDocumentCompletion(completion, current) {
  return Boolean(completion && current && Number.isSafeInteger(completion.generation)
    && completion.generation === current.generation && typeof completion.revisionId === "string"
    && completion.revisionId === current.revisionId)
}

export function selectExactDerivedDocumentState(descriptor, representations, receipts, options = {}) {
  const label = typeof options.label === "string" && options.label ? options.label : "document"
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)
    || !UUID.test(descriptor.representationId) || !UUID.test(descriptor.artifactId)
    || !SHA256.test(descriptor.contentSha256) || typeof descriptor.mediaType !== "string"
    || !Array.isArray(representations) || representations.length < 1 || representations.length > 3
    || !Array.isArray(receipts) || receipts.length > 2) invalid(label)
  const parsedRepresentations = representations.map((value) => representation(value, descriptor, label))
  const representationIds = new Set(parsedRepresentations.map((value) => value.id))
  if (representationIds.size !== parsedRepresentations.length
    || parsedRepresentations.filter((value) => value.kind === "original").length !== 1) invalid(label)
  if (receipts.length === 0) {
    if (parsedRepresentations.some((value) => value.kind !== "original")) invalid(label)
    return Object.freeze({ structure: null, markdown: null, receipt: null, primaryReceipt: null, fallbackReceipt: null })
  }
  const parsedReceipts = receipts.map((value) => receipt(value, descriptor, parsedRepresentations, label))
  if (new Set(parsedReceipts.map((value) => value.id)).size !== parsedReceipts.length) invalid(label)
  const allManifestedIds = new Set(parsedReceipts.flatMap((value) => [...value.manifestedIds]))
  if (parsedRepresentations.some((value) => value.kind !== "original" && !allManifestedIds.has(value.id))) invalid(label)
  const fallbackIds = new Set(parsedReceipts.map((value) => value.receipt.fallback_receipt_id).filter(Boolean))
  const primaryCandidates = parsedReceipts.filter((value) => !fallbackIds.has(value.id))
  if (primaryCandidates.length !== 1) invalid(label)
  const primary = primaryCandidates[0]
  const fallback = primary.receipt.fallback_receipt_id === null
    ? null : parsedReceipts.find((value) => value.id === primary.receipt.fallback_receipt_id) ?? null
  const manifestFallbackId = primary.receipt.output_manifest.fallbackReceiptId
  if ((primary.receipt.fallback_receipt_id === null) !== (fallback === null)
    || (fallback === null ? manifestFallbackId !== undefined : manifestFallbackId !== fallback.id)
    || (fallback !== null && fallback.receipt.fallback_receipt_id !== null)
    || (fallback !== null && fallback.receipt.output_manifest.fallbackReceiptId !== undefined)) invalid(label)
  const primaryPluginId = options.primaryPluginId ?? "docling"
  const primaryEngine = options.primaryEngine ?? "docling"
  const fallbackPluginId = options.fallbackPluginId ?? "markitdown"
  const fallbackEngine = options.fallbackEngine ?? "markitdown"
  if (primary.pluginId !== primaryPluginId || primary.engine !== primaryEngine) invalid(label)
  if (fallback) {
    if (fallback.pluginId !== fallbackPluginId || fallback.engine !== fallbackEngine
      || !new Set(["failed", "skipped"]).has(primary.receipt.status)
      || !new Set(["fallback", "failed"]).has(fallback.receipt.status)) invalid(label)
  } else if (primary.receipt.status === "fallback") invalid(label)
  const effective = new Set(["success", "partial"]).has(primary.receipt.status) ? primary : (fallback ?? primary)
  const scoped = parsedRepresentations.filter((value) => effective.manifestedIds.has(value.id))
  const structures = scoped.filter((value) => value.kind === "document-structure")
  const markdown = scoped.filter((value) => value.kind === "markdown")
  if (structures.length > 1 || markdown.length > 1) invalid(label)
  return Object.freeze({
    structure: structures[0] ?? null,
    markdown: markdown[0] ?? null,
    receipt: effective.receipt,
    primaryReceipt: primary.receipt,
    fallbackReceipt: fallback?.receipt ?? null,
  })
}
