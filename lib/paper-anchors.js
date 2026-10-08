export const MAX_TEXT_ANCHOR_LENGTH = 4_000

/**
 * Preserve exact-quote semantics when trimming or bounding a browser selection.
 * Offsets are UTF-16 positions, matching the DOM Range and JavaScript string model.
 */
export function normalizeTextAnchor(rawQuote, rawStartOffset, maxLength = MAX_TEXT_ANCHOR_LENGTH) {
  if (typeof rawQuote !== "string" || !Number.isSafeInteger(rawStartOffset) || rawStartOffset < 0) return null
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) return null

  const leadingWhitespace = rawQuote.length - rawQuote.trimStart().length
  const quote = rawQuote.slice(leadingWhitespace).trimEnd().slice(0, maxLength)
  if (!quote) return null
  const startOffset = rawStartOffset + leadingWhitespace
  return { quote, startOffset, endOffset: startOffset + quote.length }
}
