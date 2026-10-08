export const HAM_SEARCH_REQUEST_MAX_BYTES = 32_768
export const HAM_SEARCH_RESPONSE_MAX_BYTES = 32_768

export class HamSearchBodyTooLargeError extends Error {}

export async function readBoundedHamSearchText(
  source,
  maximumBytes,
  message = "HAM search body is too large",
) {
  const declared = Number(source.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await source.body?.cancel().catch(() => undefined)
    throw new HamSearchBodyTooLargeError(message)
  }
  if (!source.body) return ""

  const reader = source.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new HamSearchBodyTooLargeError(message)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined)
}
