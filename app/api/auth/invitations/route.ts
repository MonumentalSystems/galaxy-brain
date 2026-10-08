import { getCurrentUser } from "@/lib/auth"
import { getAuthOrigin } from "@/lib/auth-config"
import { assertSameAuthOrigin, AuthRequestError, readBoundedAuthJson } from "@/lib/auth-request"
import { authRequestIdentifier, takeAuthRateLimit } from "@/lib/auth-rate-limit"
import {
  canIssuePersonalWorkspaceInvitation,
  canManagePersonalWorkspaceInvitations,
  insertPersonalWorkspaceInvitation,
} from "@/lib/auth-security"
import { createAuthToken, hashAuthToken } from "@/lib/auth-tokens"
import { ensureAppSchema, getPool } from "@/lib/db"

const NO_STORE = { "Cache-Control": "no-store" }
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE })
}

export async function GET() {
  await ensureAppSchema()
  const user = await getCurrentUser()
  if (!user) return json({ error: "Unauthorized" }, 401)
  if (!canManagePersonalWorkspaceInvitations(user)) {
    return json({ error: "Personal workspace invitations are available only to the original owner." }, 403)
  }
  const result = await getPool().query(
    `SELECT id, email, name, created_at, expires_at, accepted_at, revoked_at,
            CASE
              WHEN accepted_at IS NOT NULL THEN 'accepted'
              WHEN revoked_at IS NOT NULL THEN 'revoked'
              WHEN expires_at <= now() THEN 'expired'
              ELSE 'pending'
            END AS status
       FROM app_registration_invitations
      WHERE issuer_tenant_id = $1
      ORDER BY created_at DESC
      LIMIT 50`,
    [user.tenantId],
  )
  return json({ invitations: result.rows })
}

export async function POST(request: Request) {
  try {
    assertSameAuthOrigin(request)
    const body = await readBoundedAuthJson(request, 8 * 1024)
    await ensureAppSchema()
    const user = await getCurrentUser()
    if (!user) return json({ error: "Unauthorized" }, 401)
    if (!canManagePersonalWorkspaceInvitations(user)) {
      return json({ error: "Personal workspace invitations are available only to the original owner." }, 403)
    }
    if (!canIssuePersonalWorkspaceInvitation(user)) {
      return json({ error: "Sign out and sign in again before creating an invitation." }, 403)
    }

    const email = String(body.email || "").trim().toLowerCase()
    const name = String(body.name || "").trim() || null
    if (!email || email.length > 320 || !EMAIL_PATTERN.test(email)) {
      return json({ error: "Enter a valid email address." }, 400)
    }
    if (name && name.length > 100) return json({ error: "Name must be 100 characters or fewer." }, 400)

    const requestIdentifier = await authRequestIdentifier(request)
    const [principalAllowed, addressAllowed] = await Promise.all([
      takeAuthRateLimit("personal-invite-principal", user.principalId, 20, 60 * 60),
      takeAuthRateLimit("personal-invite-address", requestIdentifier, 30, 60 * 60),
    ])
    if (!principalAllowed || !addressAllowed) {
      return json({ error: "Too many invitation attempts. Wait before trying again." }, 429)
    }

    const token = createAuthToken()
    const client = await getPool().connect()
    try {
      await client.query("BEGIN")
      const invitation = await insertPersonalWorkspaceInvitation(client, {
        tokenHash: hashAuthToken(token),
        email,
        name,
        issuerTenantId: user.tenantId,
        createdByPrincipalId: user.principalId,
        lifetimeDays: 7,
      })
      if (!invitation) {
        await client.query("ROLLBACK")
        return json({ error: "An account with that email already exists." }, 409)
      }
      await client.query("COMMIT")
      const inviteUrl = new URL("/invite", getAuthOrigin())
      inviteUrl.hash = new URLSearchParams({ token }).toString()
      return json({ invitation, inviteUrl: inviteUrl.toString() }, 201)
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  } catch (error: unknown) {
    if (error instanceof AuthRequestError) return json({ error: error.message }, error.status)
    console.error("Personal workspace invitation failed", error)
    return json({ error: "The invitation could not be created." }, 500)
  }
}
