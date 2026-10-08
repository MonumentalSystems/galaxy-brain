export const FIELD_SEARCH_RESULT_LIMIT = 8
export const FIELD_SEARCH_QUERY_MAX = 500
export const FIELD_SEARCH_SNIPPET_MAX = 280

function boundedSnippet(value, maximum = FIELD_SEARCH_SNIPPET_MAX) {
  const text = typeof value === "string" ? value.trim() : ""
  if (text.length <= maximum) return text
  return `${text.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`
}

/**
 * Build a deliberately source-separated result model for the Field UI.
 *
 * Galaxy matching is a local text predicate. HAM ranking is a remote retrieval
 * score. They are kept in separate groups because those signals are not
 * calibrated and must not be sorted or described as one shared score.
 */
export function projectSemanticFieldSearch(entities, corpusResults, hamResults, query) {
  const normalized = typeof query === "string" ? query.trim().toLowerCase() : ""
  const galaxyMatches = normalized
    ? entities.filter((entry) => (
        entry.title.toLowerCase().includes(normalized)
        || entry.detail.toLowerCase().includes(normalized)
      ))
    : []
  const safeHamResults = Array.isArray(hamResults) ? hamResults : []
  const safeCorpusResults = Array.isArray(corpusResults) ? corpusResults : []

  return {
    query: typeof query === "string" ? query.trim() : "",
    galaxy: {
      total: galaxyMatches.length,
      items: galaxyMatches.slice(0, FIELD_SEARCH_RESULT_LIMIT),
    },
    corpus: {
      total: safeCorpusResults.length,
      items: safeCorpusResults.slice(0, FIELD_SEARCH_RESULT_LIMIT),
      hasMore: false,
    },
    ham: {
      total: safeHamResults.length,
      items: safeHamResults.slice(0, FIELD_SEARCH_RESULT_LIMIT).map((result) => ({
        id: result.id,
        title: boundedSnippet(result.metadata?.title || result.content, 160),
        summary: boundedSnippet(result.content),
        tier: result.tier,
        score: typeof result.score === "number" && Number.isFinite(result.score)
          ? result.score
          : undefined,
        type: result.metadata?.type,
      })),
    },
  }
}
