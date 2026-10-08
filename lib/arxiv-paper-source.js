import { arxivPdfProxyAllowed } from "./arxiv-license.js"

const ARXIV_ID = /^(?:[0-9]{4}\.[0-9]{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/[0-9]{7})$/

export function canonicalArxivPdfUrl(arxivId, version) {
  if (typeof arxivId !== "string" || !ARXIV_ID.test(arxivId)) return ""
  if (!Number.isSafeInteger(version) || version < 1 || version > 10_000) return ""
  return `https://arxiv.org/pdf/${arxivId}v${version}`
}

export function paperPdfFilename(metadata) {
  const title = typeof metadata?.title === "string" ? metadata.title.trim() : "paper"
  const firstAuthor = typeof metadata?.authors?.[0]?.name === "string" ? metadata.authors[0].name.trim() : ""
  const published = typeof metadata?.published_at === "string" ? metadata.published_at : ""
  const year = /^[0-9]{4}/.test(published) ? published.slice(0, 4) : ""
  const suffix = firstAuthor ? `${firstAuthor}${year ? ` (${year})` : ""}` : year ? `(${year})` : ""
  const stem = [title || "paper", suffix].filter(Boolean).join(" - ")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 180)
    .replace(/[. ]+$/g, "") || "paper"
  return `${stem}.pdf`
}

export function arxivPaperSource(metadata, paperId, revisionId, stored = false) {
  const directUrl = canonicalArxivPdfUrl(metadata?.arxiv_id, metadata?.arxiv_version)
  if (!directUrl) return null
  if (stored && paperId && revisionId) {
    return {
      access: "stored-private",
      readerUrl: `/api/eln/papers/${encodeURIComponent(paperId)}/document?revision_id=${encodeURIComponent(revisionId)}`,
      directUrl,
    }
  }
  if (arxivPdfProxyAllowed(metadata?.license_url) && paperId && revisionId) {
    return {
      access: "redistributable",
      readerUrl: `/api/eln/papers/${encodeURIComponent(paperId)}/download?revision_id=${encodeURIComponent(revisionId)}`,
      directUrl,
    }
  }
  return { access: "private-research", readerUrl: directUrl, directUrl }
}
