import { parseGalaxyObjectReference, serializeGalaxyObjectReference } from "./galaxy-object-reference.js"

const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/u
const CANVAS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const CONVERSATION_KINDS = new Set(["chat", "run", "turn"])

function failure(code) {
  return Object.freeze({ ok: false, code })
}

function exactPinnedReference(value) {
  const parsed = parseGalaxyObjectReference(value)
  if (!parsed || parsed.format !== "canonical" || parsed.selector.mode !== "pinned") return null
  try {
    const canonical = serializeGalaxyObjectReference(parsed)
    return canonical === value ? Object.freeze({ canonical, parsed }) : null
  } catch {
    return null
  }
}

/**
 * Select the exact resolver-owned identity used by an object-only share.
 * Conversation and run records stay outside this Atlas share surface so a
 * placement cannot become an accidental transcript export.
 */
export function inspectAtlasObjectShareReference(value) {
  const exact = exactPinnedReference(value)
  if (!exact) return failure("exact_reference_required")
  if (CONVERSATION_KINDS.has(exact.parsed.kind)) return failure("conversation_excluded")
  if (!CONTENT_HASH.test(exact.parsed.selector.revision)) return failure("content_hash_required")
  return Object.freeze({
    ok: true,
    selector: Object.freeze({ objectRef: exact.canonical }),
  })
}

/**
 * Explain why a saved Atlas cannot use the canvas-only share contract. Keep
 * this derived from the inspected contract failure so the command deck never
 * mislabels a conversation exclusion or malformed revision as follow-latest.
 */
export function atlasCanvasShareUnavailableReason(inspection, hasDurableCanvas) {
  if (!hasDurableCanvas) return "Move or place an object to create a durable Atlas first."
  if (inspection?.ok) return ""
  if (inspection?.code === "conversation_excluded") {
    return "Remove conversation references before sharing this Atlas. Conversation transcripts are excluded."
  }
  if (inspection?.code === "exact_reference_required") {
    return "Pin every Atlas object to an exact revision, or share an exact selected object instead."
  }
  return "Reload or save this Atlas before sharing; its durable revision is invalid or unavailable."
}

/**
 * Derive the selector for an immutable server-owned canvas revision. The UI
 * sends no canvas payload. Every object and semantic edge must already be
 * pinned because the share bundle is reproducible and cannot follow heads.
 */
export function inspectAtlasCanvasShare(canvas) {
  if (
    !canvas
    || typeof canvas !== "object"
    || Array.isArray(canvas)
    || typeof canvas.canvasId !== "string"
    || !CANVAS_ID.test(canvas.canvasId)
    || !Number.isSafeInteger(canvas.version)
    || canvas.version < 1
    || typeof canvas.contentHash !== "string"
    || !CONTENT_HASH.test(canvas.contentHash)
    || !canvas.content
    || typeof canvas.content !== "object"
    || Array.isArray(canvas.content)
    || !Array.isArray(canvas.content.items)
    || !Array.isArray(canvas.content.edges)
  ) return failure("invalid_canvas")

  const references = [
    ...canvas.content.items.map((item) => item?.subjectRef),
    ...canvas.content.edges
      .filter((edge) => edge?.semanticRef !== undefined && edge?.semanticRef !== null && edge?.semanticRef !== "")
      .map((edge) => edge.semanticRef),
  ]
  for (const reference of references) {
    const exact = exactPinnedReference(reference)
    if (!exact) return failure("exact_reference_required")
    if (CONVERSATION_KINDS.has(exact.parsed.kind)) return failure("conversation_excluded")
  }
  return Object.freeze({
    ok: true,
    selector: Object.freeze({
      canvasId: canvas.canvasId.toLowerCase(),
      version: canvas.version,
      contentHash: canvas.contentHash,
    }),
  })
}

/**
 * Select one explicit immutable chat placement for a combined Atlas bundle.
 * The existing canvas-only contract remains conversation-free. The browser
 * sends only exact identities; the server reconstructs the transcript.
 */
export function inspectAtlasCanvasConversationShare(canvas, selectedReference) {
  if (
    !canvas
    || typeof canvas !== "object"
    || Array.isArray(canvas)
    || typeof canvas.canvasId !== "string"
    || !CANVAS_ID.test(canvas.canvasId)
    || !Number.isSafeInteger(canvas.version)
    || canvas.version < 1
    || typeof canvas.contentHash !== "string"
    || !CONTENT_HASH.test(canvas.contentHash)
    || !canvas.content
    || typeof canvas.content !== "object"
    || Array.isArray(canvas.content)
    || !Array.isArray(canvas.content.items)
    || !Array.isArray(canvas.content.edges)
  ) return failure("invalid_canvas")

  const selected = exactPinnedReference(selectedReference)
  if (!selected || selected.parsed.kind !== "chat") return failure("exact_conversation_required")
  if (!CONTENT_HASH.test(selected.parsed.selector.revision)) return failure("content_hash_required")

  let selectedPlacements = 0
  const values = [
    ...canvas.content.items.map((item) => ({ value: item?.subjectRef, placement: true })),
    ...canvas.content.edges
      .filter((edge) => edge?.semanticRef !== undefined && edge?.semanticRef !== null && edge?.semanticRef !== "")
      .map((edge) => ({ value: edge.semanticRef, placement: false })),
  ]
  for (const entry of values) {
    const exact = exactPinnedReference(entry.value)
    if (!exact) return failure("exact_reference_required")
    if (!CONVERSATION_KINDS.has(exact.parsed.kind)) continue
    if (exact.parsed.kind !== "chat" || exact.canonical !== selected.canonical) {
      return failure("conversation_scope_ambiguous")
    }
    if (entry.placement) selectedPlacements += 1
  }
  if (selectedPlacements !== 1) return failure("conversation_scope_ambiguous")
  return Object.freeze({
    ok: true,
    selector: Object.freeze({
      canvasId: canvas.canvasId.toLowerCase(),
      version: canvas.version,
      contentHash: canvas.contentHash,
      conversationRef: selected.canonical,
    }),
  })
}
