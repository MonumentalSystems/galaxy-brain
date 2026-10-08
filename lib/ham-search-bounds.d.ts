export const HAM_SEARCH_REQUEST_MAX_BYTES: number
export const HAM_SEARCH_RESPONSE_MAX_BYTES: number
export class HamSearchBodyTooLargeError extends Error {}
export function readBoundedHamSearchText(
  source: Request | Response,
  maximumBytes: number,
  message?: string,
): Promise<string>
