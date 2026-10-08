import { readBoundedRequestBody, RequestBodyTooLargeError } from "./bounded-multipart.js"

export class ResponseBodyTooLargeError extends Error {}

/** Read one HTTP response without trusting Content-Length or buffering past the byte limit. */
export async function readBoundedResponseText(response, maximumBytes) {
  if (!response || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("Invalid response or limit")
  }
  const declaredValue = response.headers.get("content-length")
  if (declaredValue && /^\d+$/u.test(declaredValue)
    && Number(declaredValue) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new ResponseBodyTooLargeError("Response body is too large")
  }
  if (!response.body) return ""
  try {
    const bytes = await readBoundedRequestBody(response.body, maximumBytes)
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw new ResponseBodyTooLargeError("Response body is too large")
    }
    throw error
  }
}
