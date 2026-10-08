export class ResponseBodyTooLargeError extends Error {}

export function readBoundedResponseText(
  response: Pick<Response, "headers" | "body">,
  maximumBytes: number,
): Promise<string>
