import "server-only"

import { getAuthOrigin } from "@/lib/auth-config"

export class AuthRequestError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
  }
}

export function assertSameAuthOrigin(request: Request) {
  const origin = request.headers.get("origin")?.replace(/\/$/, "")
  const expectedOrigin = getAuthOrigin().replace(/\/$/, "")
  if (!origin || origin !== expectedOrigin) {
    throw new AuthRequestError("Authentication request origin is not allowed.", 403)
  }
}

export async function readBoundedAuthJson(request: Request, maxBytes = 64 * 1024) {
  const declaredLength = Number(request.headers.get("content-length") || 0)
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AuthRequestError("Authentication request is too large.", 413)
  }
  const text = await request.text()
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new AuthRequestError("Authentication request is too large.", 413)
  }
  try {
    return JSON.parse(text || "{}") as Record<string, unknown>
  } catch {
    throw new AuthRequestError("Authentication request must contain valid JSON.", 400)
  }
}
