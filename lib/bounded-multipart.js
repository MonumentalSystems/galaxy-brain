/** Bound a multipart request before invoking the in-memory form parser. */
export class MultipartTooLargeError extends Error {}
export class RequestBodyTooLargeError extends Error {}

export async function readBoundedRequestBody(stream, maximumBytes) {
  if (!stream || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("Invalid request body or limit")
  }
  const reader = stream.getReader()
  const chunks = []
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new RequestBodyTooLargeError("Request body is too large")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

export async function readBoundedMultipartBody(stream, maximumBytes) {
  try {
    return await readBoundedRequestBody(stream, maximumBytes)
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw new MultipartTooLargeError("Upload is too large")
    }
    throw error
  }
}
