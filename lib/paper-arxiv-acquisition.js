import { validateDurableDocumentImport } from "./durable-document-import.js"
import { builtinPluginRegistry } from "./plugins/builtins.js"
import { resolveIngestionPlanDefinition } from "./plugins/ingestion-plans.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256 = /^[0-9a-f]{64}$/u
const ARXIV_FETCH_PLAN_ID = "arxiv.fetch-default"
const ARXIV_FETCH_PLAN_VERSION = "1.0.0"
const ARXIV_FETCH_PLAN_SHA256 = "46401cc8ea4e916304239fc6dc0fa5511790cf95d3f8cf52bf4de368c8d1f08a"

export class PaperArxivAcquisitionError extends TypeError {
  constructor(code, message) {
    super(message)
    this.name = "PaperArxivAcquisitionError"
    this.code = code
  }
}

function fail(code, message) {
  throw new PaperArxivAcquisitionError(code, message)
}

export function paperArxivImportRegistered() {
  const command = builtinPluginRegistry.resolve("commands", "paper.import")
  const source = builtinPluginRegistry.resolve("sources", "arxiv.pdf")
  const route = builtinPluginRegistry.resolve("routes", "arxiv.private-fetch-route")
  const planRegistration = builtinPluginRegistry.resolve("ingestionPlans", ARXIV_FETCH_PLAN_ID)
  const plan = resolveIngestionPlanDefinition(ARXIV_FETCH_PLAN_ID)
  return Boolean(
    command?.pluginId === "papers"
    && command.handler.implementationId === "builtin.paper.import"
    && source?.pluginId === "papers"
    && source.handler.implementationId === "builtin.arxiv.pdf-source"
    && route?.pluginId === "papers"
    && route.handler.implementationId === "builtin.arxiv.private-fetch-route"
    && planRegistration?.pluginId === "papers"
    && planRegistration.handler.implementationId === "builtin.ingestion-plan.arxiv-fetch-default"
    && plan?.id === ARXIV_FETCH_PLAN_ID
    && plan.version === ARXIV_FETCH_PLAN_VERSION
    && plan.contentSha256 === ARXIV_FETCH_PLAN_SHA256
    && plan.owner?.pluginId === "papers"
    && plan.source?.contributionId === "arxiv.pdf"
    && plan.persist?.routeId === "arxiv.private-fetch-route"
  )
}

function requireRecord(value, code, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, message)
  return value
}

function requireBoundedString(value, code, message, maximum = 2_048) {
  if (typeof value !== "string" || value.length < 1 || Array.from(value).length > maximum) {
    fail(code, message)
  }
  return value
}

export function exactArxivVersionedId(value) {
  const selection = requireRecord(
    value,
    "invalid_selection",
    "Choose one exact versioned arXiv result.",
  )
  const arxivId = requireBoundedString(
    selection.arxiv_id,
    "invalid_selection",
    "The selected arXiv identifier is invalid.",
    64,
  )
  if (!/^[A-Za-z0-9][A-Za-z0-9./-]*$/u.test(arxivId)) {
    fail("invalid_selection", "The selected arXiv identifier is invalid.")
  }
  if (!Number.isSafeInteger(selection.arxiv_version) || selection.arxiv_version < 1) {
    fail("invalid_selection", "The selected arXiv version is invalid.")
  }
  return `${arxivId}v${selection.arxiv_version}`
}

function validateSearchResult(value) {
  exactArxivVersionedId(value)
  requireBoundedString(value.title, "invalid_search_response", "arXiv returned an invalid paper title.", 2_000)
  if (
    !Array.isArray(value.authors)
    || value.authors.some((author) => (
      !author
      || typeof author !== "object"
      || typeof author.name !== "string"
      || !author.name.trim()
    ))
  ) fail("invalid_search_response", "arXiv returned invalid paper authors.")
  return value
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError")
}

export async function searchExactArxivPapers(client, query, limit = 10, signal) {
  if (!paperArxivImportRegistered()) {
    fail("capability_unavailable", "Exact arXiv import is unavailable because its registered Papers capability changed.")
  }
  const normalized = typeof query === "string" ? query.trim() : ""
  if (Array.from(normalized).length < 2 || Array.from(normalized).length > 300) {
    fail("invalid_query", "Enter an arXiv search between 2 and 300 characters.")
  }
  if (!client || typeof client.searchArxiv !== "function") {
    fail("invalid_client", "The arXiv search client is unavailable.")
  }
  throwIfAborted(signal)
  const response = requireRecord(
    await client.searchArxiv(normalized, limit, signal),
    "invalid_search_response",
    "arXiv returned an invalid search response.",
  )
  if (!Number.isSafeInteger(response.total) || response.total < 0 || !Array.isArray(response.results)) {
    fail("invalid_search_response", "arXiv returned an invalid search response.")
  }
  const results = response.results.map(validateSearchResult)
  throwIfAborted(signal)
  return Object.freeze({ total: response.total, results: Object.freeze(results) })
}

function validateImportedPaper(value, selection) {
  const paper = requireRecord(
    value,
    "invalid_import_response",
    "Galaxy returned an invalid paper import confirmation.",
  )
  if (!UUID.test(paper.id)) fail("invalid_import_response", "Galaxy returned an invalid paper identity.")
  if (!SHA256.test(paper.metadata_hash)) {
    fail("invalid_import_response", "Galaxy returned an invalid paper metadata hash.")
  }
  if (paper.arxiv_id !== selection.arxiv_id) {
    fail("version_mismatch", "Galaxy imported a different arXiv paper than the one selected.")
  }
  if (!Number.isSafeInteger(paper.arxiv_version) || paper.arxiv_version < 1) {
    fail("invalid_import_response", "Galaxy returned an invalid current paper version.")
  }
  if (
    !UUID.test(paper.imported_revision_id)
    || !SHA256.test(paper.imported_revision_metadata_hash)
    || paper.imported_revision_arxiv_version !== selection.arxiv_version
  ) {
    fail("invalid_import_response", "Galaxy returned an invalid exact revision receipt.")
  }
  return paper
}

function exactImportedRevision(detail, imported, selection) {
  if (!Array.isArray(detail.revisions)) {
    fail("invalid_detail_response", "Galaxy returned an invalid paper revision history.")
  }
  const matches = detail.revisions.filter((revision) => (
    revision
    && typeof revision === "object"
    && revision.id === imported.imported_revision_id
    && revision.metadata_hash === imported.imported_revision_metadata_hash
    && revision.arxiv_version === imported.imported_revision_arxiv_version
    && revision.metadata?.arxiv_id === selection.arxiv_id
    && revision.metadata?.arxiv_version === selection.arxiv_version
  ))
  if (
    matches.length !== 1
    || !UUID.test(matches[0].id)
    || matches[0].paper_id !== imported.id
    || !SHA256.test(matches[0].metadata_hash)
  ) {
    fail("revision_mismatch", "Galaxy could not confirm the one exact imported paper revision.")
  }
  return matches[0]
}

export async function importExactArxivPaper(client, selectionInput, signal) {
  if (!paperArxivImportRegistered()) {
    fail("capability_unavailable", "Exact arXiv import is unavailable because its registered Papers capability changed.")
  }
  const selection = validateSearchResult(selectionInput)
  if (
    !client
    || typeof client.importArxivPaper !== "function"
    || typeof client.getPaper !== "function"
  ) fail("invalid_client", "The paper import client is unavailable.")

  throwIfAborted(signal)
  const imported = validateImportedPaper(
    await client.importArxivPaper(exactArxivVersionedId(selection), signal),
    selection,
  )
  const detail = requireRecord(
    await client.getPaper(imported.id, signal),
    "invalid_detail_response",
    "Galaxy could not load the imported paper revision.",
  )
  if (
    detail.id !== imported.id
    || detail.arxiv_id !== selection.arxiv_id
  ) fail("version_mismatch", "Galaxy loaded a different paper revision than the one imported.")

  throwIfAborted(signal)
  const revision = exactImportedRevision(detail, imported, selection)
  return Object.freeze({ paper: detail, revision })
}

function validatePaperRevisionBinding(paper, revision) {
  requireRecord(paper, "invalid_paper", "The selected Galaxy paper is invalid.")
  requireRecord(revision, "invalid_revision", "The selected Galaxy paper revision is invalid.")
  if (!UUID.test(paper.id) || !UUID.test(revision.id) || revision.paper_id !== paper.id) {
    fail("revision_mismatch", "The selected paper revision does not belong to this paper.")
  }
  if (
    revision.metadata_hash !== paper.metadata_hash
    && !paper.revisions?.some((candidate) => candidate?.id === revision.id)
  ) fail("revision_mismatch", "The selected paper revision is not in this paper's revision history.")
  exactArxivVersionedId(revision.metadata)
}

function validatePaperDocument(value, paper, revision) {
  const record = requireRecord(
    value,
    "invalid_document_response",
    "Galaxy returned an invalid paper document confirmation.",
  )
  if (
    !UUID.test(record.id)
    || record.paper_id !== paper.id
    || record.paper_revision_id !== revision.id
  ) fail("document_mismatch", "Galaxy stored a document for a different paper revision.")
  if (
    record.media_type !== "application/pdf"
    || !Number.isSafeInteger(record.byte_size)
    || record.byte_size < 1
    || !SHA256.test(record.content_sha256)
  ) fail("invalid_document_response", "Galaxy returned invalid exact PDF evidence.")
  requireBoundedString(record.filename, "invalid_document_response", "Galaxy returned an invalid PDF filename.", 512)

  const versionedId = exactArxivVersionedId(revision.metadata)
  const sourceUrl = `https://arxiv.org/pdf/${versionedId}`
  if (record.source_url !== sourceUrl) {
    fail("document_mismatch", "Galaxy returned PDF provenance for a different arXiv revision.")
  }

  const durableCandidate = requireRecord(
    record.durable_document,
    "invalid_durable_document",
    "The exact PDF was stored, but its durable document confirmation is missing.",
  )
  let durable
  if (durableCandidate.source_kind === "arxiv") {
    const plan = resolveIngestionPlanDefinition(ARXIV_FETCH_PLAN_ID)
    if (!plan) fail("invalid_ingestion_plan", "The registered arXiv ingestion plan is unavailable.")
    durable = validateDurableDocumentImport(durableCandidate, { ingestionPlan: plan })
  } else if (durableCandidate.source_kind === "legacy-paper") {
    durable = validateDurableDocumentImport(durableCandidate)
  } else {
    fail("invalid_source_kind", "The durable PDF has unexpected source provenance.")
  }
  if (
    durable.media_type !== "application/pdf"
    || durable.byte_size !== record.byte_size
    || durable.content_sha256 !== record.content_sha256
    || durable.source_uri !== sourceUrl
  ) fail("document_mismatch", "The durable document does not match the exact stored paper PDF.")

  return Object.freeze({ ...record, durable_document: durable })
}

export async function saveExactArxivPaperDocument(client, paper, revision, signal) {
  if (!paperArxivImportRegistered()) {
    fail("capability_unavailable", "Exact arXiv import is unavailable because its registered Papers capability changed.")
  }
  validatePaperRevisionBinding(paper, revision)
  if (!client || typeof client.fetchPaperDocument !== "function") {
    fail("invalid_client", "The private paper storage client is unavailable.")
  }
  throwIfAborted(signal)
  const stored = await client.fetchPaperDocument(paper.id, revision.id, signal)
  throwIfAborted(signal)
  return validatePaperDocument(
    stored,
    paper,
    revision,
  )
}

export async function acquireExactArxivPaper(client, selection, signal) {
  if (!paperArxivImportRegistered()) {
    fail("capability_unavailable", "Exact arXiv import is unavailable because its registered Papers capability changed.")
  }
  const imported = await importExactArxivPaper(client, selection, signal)
  const paperDocument = await saveExactArxivPaperDocument(client, imported.paper, imported.revision, signal)
  return Object.freeze({
    ...imported,
    paperDocument,
    document: paperDocument.durable_document,
  })
}
