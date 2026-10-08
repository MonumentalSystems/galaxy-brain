function safeSummaryText(value, maximum) {
  if (typeof value !== "string") return ""
  const normalized = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
  if (normalized.length <= maximum) return normalized
  return `${normalized.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`
}

export function summarizeHamSearchResult(result) {
  const title = safeSummaryText(result?.metadata?.title, 120)
  const snippet = safeSummaryText(result?.content, 240)
  return Object.freeze({
    title: title || safeSummaryText(snippet, 72) || `HAM memory ${String(result?.id || "")}`,
    snippet,
  })
}
