export class MultipartTooLargeError extends Error {}
export class RequestBodyTooLargeError extends Error {}
export function readBoundedRequestBody(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Buffer>
export function readBoundedMultipartBody(
  stream: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
): Promise<Buffer>
