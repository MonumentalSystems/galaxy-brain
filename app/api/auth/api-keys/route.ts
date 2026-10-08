import { NextRequest, NextResponse } from "next/server"

import { createApiKey, listApiKeys } from "@/lib/api-keys"
import { getCurrentUser } from "@/lib/auth"

const MAX_LABEL_LENGTH = 80

/**
 * Managing keys is deliberately session-only: getCurrentUser rather than
 * getRequestIdentity, so a key can never mint another key or list its siblings.
 * Compromising one key then cannot escalate into persistent access.
 */
export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  return NextResponse.json({ keys: await listApiKeys(user.principalId) })
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 })
  }

  const payload = body as { label?: unknown; expiresInDays?: unknown }
  const label = typeof payload.label === "string" ? payload.label.trim() : ""
  if (!label || label.length > MAX_LABEL_LENGTH) {
    return NextResponse.json(
      { error: `A label of 1 to ${MAX_LABEL_LENGTH} characters is required` },
      { status: 400 },
    )
  }

  let expiresInDays: number | null = null
  if (payload.expiresInDays !== undefined && payload.expiresInDays !== null) {
    const days = Number(payload.expiresInDays)
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return NextResponse.json(
        { error: "expiresInDays must be a whole number of days from 1 to 365" },
        { status: 400 },
      )
    }
    expiresInDays = days
  }

  const { key, record } = await createApiKey({
    tenantId: user.tenantId,
    principalId: user.principalId,
    label,
    expiresInDays,
  })

  // The only time the plaintext is ever available.
  return NextResponse.json({ key, record }, { status: 201 })
}
