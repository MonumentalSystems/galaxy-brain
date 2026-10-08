import { getCurrentUser } from "@/lib/auth"
import { assertSameAuthOrigin, AuthRequestError } from "@/lib/auth-request"
import {
  canIssuePersonalWorkspaceInvitation,
  canManagePersonalWorkspaceInvitations,
} from "@/lib/auth-security"
import { ensureAppSchema, getPool } from "@/lib/db"

type RouteContext = { params: Promise<{ invitationId: string }> }
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function DELETE(request: Request, context: RouteContext) {
  const respond = (body: unknown, status = 200) => Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  })
  try {
    assertSameAuthOrigin(request)
    await ensureAppSchema()
    const user = await getCurrentUser()
    if (!user) return respond({ error: "Unauthorized" }, 401)
    if (!canManagePersonalWorkspaceInvitations(user)) {
      return respond({ error: "Personal workspace invitations are available only to the original owner." }, 403)
    }
    if (!canIssuePersonalWorkspaceInvitation(user)) {
      return respond({ error: "Sign out and sign in again before revoking an invitation." }, 403)
    }
    const { invitationId } = await context.params
    if (!UUID_PATTERN.test(invitationId)) return respond({ error: "Invalid invitation identifier." }, 400)
    const result = await getPool().query(
      `UPDATE app_registration_invitations
          SET revoked_at = now()
        WHERE id = $1
          AND issuer_tenant_id = $2
          AND accepted_at IS NULL
          AND revoked_at IS NULL
        RETURNING id`,
      [invitationId, user.tenantId],
    )
    if (!result.rowCount) return respond({ error: "Active invitation not found." }, 404)
    return respond({ ok: true })
  } catch (error: unknown) {
    if (error instanceof AuthRequestError) return respond({ error: error.message }, error.status)
    console.error("Invitation revocation failed", error)
    return respond({ error: "The invitation could not be revoked." }, 500)
  }
}
