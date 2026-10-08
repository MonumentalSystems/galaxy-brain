import { createHash } from "node:crypto"

export const DEFAULT_TENANT_ID = "00000000-0000-4000-8000-000000000001"

export function hashOpaqueToken(opaqueToken) {
  return createHash("sha256").update(opaqueToken).digest("hex")
}

export function isWebAuthnRpIdAllowed(origin, rpID) {
  let hostname
  try {
    hostname = new URL(origin).hostname.toLowerCase()
  } catch {
    return false
  }
  const normalizedRpID = rpID.trim().toLowerCase()
  if (!normalizedRpID || normalizedRpID.includes(":")) return false
  return hostname === normalizedRpID || hostname.endsWith(`.${normalizedRpID}`)
}

export function isNostrTimestampFresh(createdAt, nowSeconds) {
  return (
    Number.isInteger(createdAt) &&
    createdAt >= nowSeconds - 120 &&
    createdAt <= nowSeconds + 30
  )
}

export function isInviteToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value)
}

export function canManagePersonalWorkspaceInvitations(user) {
  return Boolean(user && user.tenantId === DEFAULT_TENANT_ID && user.role === "owner")
}

export function canIssuePersonalWorkspaceInvitation(user, nowMs = Date.now(), maxAgeMinutes = 15) {
  if (!canManagePersonalWorkspaceInvitations(user)) return false
  const authenticatedMs = Date.parse(user.authenticatedAt)
  if (!Number.isFinite(authenticatedMs) || authenticatedMs > nowMs) return false
  const boundedMinutes = Math.max(1, Math.min(maxAgeMinutes, 60))
  return nowMs - authenticatedMs <= boundedMinutes * 60 * 1_000
}

export async function invalidateResetCredentials(client, userId) {
  await client.query(
    "UPDATE app_password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
    [userId],
  )
  await client.query("DELETE FROM app_sessions WHERE user_id = $1", [userId])
}

export async function insertInitialOwner(client, owner) {
  await client.query("SELECT pg_advisory_xact_lock(145972531)")
  const userCount = await client.query("SELECT COUNT(*)::int AS count FROM app_users")
  if (userCount.rows[0].count > 0) return null
  const tenant = await client.query(
    "SELECT id FROM app_tenants WHERE slug = 'default' FOR UPDATE",
  )
  if (!tenant.rowCount) throw new Error("default tenant is missing")
  const principal = await client.query(
    `INSERT INTO app_principals (kind, display_name)
     VALUES ('human', $1)
     RETURNING id`,
    [owner.name || owner.email],
  )
  await client.query(
    `INSERT INTO app_tenant_memberships (tenant_id, principal_id, role)
     VALUES ($1, $2, 'owner')`,
    [tenant.rows[0].id, principal.rows[0].id],
  )
  const result = await client.query(
    `INSERT INTO app_users (email, name, password_hash, principal_id, default_tenant_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [owner.email, owner.name, owner.passwordHash, principal.rows[0].id, tenant.rows[0].id],
  )
  return {
    userId: result.rows[0].id,
    principalId: principal.rows[0].id,
    tenantId: tenant.rows[0].id,
  }
}

export async function insertPersonalWorkspaceInvitation(client, invitation) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [invitation.email])
  const existingUser = await client.query("SELECT 1 FROM app_users WHERE email = $1 LIMIT 1", [invitation.email])
  if (existingUser.rowCount) return null
  await client.query(
    `UPDATE app_registration_invitations
        SET revoked_at = now()
      WHERE email = $1
        AND accepted_at IS NULL
        AND revoked_at IS NULL`,
    [invitation.email],
  )
  const result = await client.query(
    `INSERT INTO app_registration_invitations
       (token_hash, email, name, issuer_tenant_id, created_by_principal_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6::text || ' days')::interval)
     RETURNING id, email, name, created_at, expires_at`,
    [
      invitation.tokenHash,
      invitation.email,
      invitation.name,
      invitation.issuerTenantId,
      invitation.createdByPrincipalId,
      invitation.lifetimeDays,
    ],
  )
  return result.rows[0]
}

export async function provisionPersonalWorkspaceInvitation(client, invitation) {
  const hasPasskey = Boolean(invitation.credential)
  const hasNostr = typeof invitation.nostrPubkey === "string" && /^[0-9a-f]{64}$/.test(invitation.nostrPubkey)
  if (hasPasskey === hasNostr) {
    throw new Error("personal workspace provisioning requires exactly one verified sign-in credential")
  }
  const invitationLookup = await client.query(
    `SELECT email
       FROM app_registration_invitations
      WHERE token_hash = $1
      LIMIT 1`,
    [invitation.tokenHash],
  )
  const invitationEmail = invitationLookup.rows[0]?.email
  if (!invitationEmail) return null
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [invitationEmail])
  const invitationResult = await client.query(
    `SELECT id, email, name
       FROM app_registration_invitations
      WHERE token_hash = $1
        AND accepted_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > now()
      FOR UPDATE`,
    [invitation.tokenHash],
  )
  const pending = invitationResult.rows[0]
  if (!pending) return null

  const existingUser = await client.query("SELECT 1 FROM app_users WHERE email = $1 LIMIT 1", [pending.email])
  if (existingUser.rowCount) return null

  const tenant = await client.query(
    `INSERT INTO app_tenants (slug, name)
     VALUES ($1, $2)
     RETURNING id`,
    [`personal-${pending.id}`, `${pending.name || pending.email} Galaxy Brain`],
  )
  const principal = await client.query(
    `INSERT INTO app_principals (kind, display_name)
     VALUES ('human', $1)
     RETURNING id`,
    [pending.name || pending.email],
  )
  await client.query(
    `INSERT INTO app_tenant_memberships (tenant_id, principal_id, role)
     VALUES ($1, $2, 'owner')`,
    [tenant.rows[0].id, principal.rows[0].id],
  )
  const user = await client.query(
    `INSERT INTO app_users (email, name, password_hash, principal_id, default_tenant_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      pending.email,
      pending.name,
      invitation.passwordHash,
      principal.rows[0].id,
      tenant.rows[0].id,
    ],
  )
  if (hasPasskey) {
    await client.query(
      `INSERT INTO app_passkeys
         (user_id, credential_id, public_key, counter, transports, device_type, backed_up, label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        user.rows[0].id,
        invitation.credential.id,
        invitation.credential.publicKey,
        invitation.credential.counter,
        invitation.credential.transports,
        invitation.credential.deviceType,
        invitation.credential.backedUp,
        invitation.credential.label,
      ],
    )
  } else {
    await client.query(
      `INSERT INTO app_nostr_keys (user_id, pubkey, label)
       VALUES ($1, $2, $3)`,
      [user.rows[0].id, invitation.nostrPubkey, invitation.nostrLabel || "Primary Nostr identity"],
    )
  }
  const accepted = await client.query(
    `UPDATE app_registration_invitations
        SET accepted_at = now(), accepted_user_id = $1
      WHERE id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [user.rows[0].id, pending.id],
  )
  if (accepted.rowCount !== 1) throw new Error("personal workspace invitation changed during redemption")
  return {
    userId: user.rows[0].id,
    principalId: principal.rows[0].id,
    tenantId: tenant.rows[0].id,
  }
}

export async function insertReplacementResetToken(
  client,
  { userId, tokenHash, lifetimeMinutes, throttleSeconds },
) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [userId])
  const recent = await client.query(
    `SELECT 1 FROM app_password_reset_tokens
      WHERE user_id = $1 AND created_at > now() - ($2::text || ' seconds')::interval
      LIMIT 1`,
    [userId, throttleSeconds],
  )
  if (recent.rowCount) return false
  await client.query("DELETE FROM app_password_reset_tokens WHERE user_id = $1", [userId])
  await client.query(
    `INSERT INTO app_password_reset_tokens (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + ($3::text || ' minutes')::interval)`,
    [tokenHash, userId, lifetimeMinutes],
  )
  return true
}

export async function consumeChallengeRow(client, tokenHash, purpose, userId) {
  const result = await client.query(
    `DELETE FROM app_auth_challenges
      WHERE token_hash = $1
        AND purpose = $2
        AND user_id IS NOT DISTINCT FROM $3::uuid
        AND expires_at > now()
      RETURNING token_hash`,
    [tokenHash, purpose, userId],
  )
  return result.rowCount === 1
}

export async function consumeChallengeByPurposePrefixRow(client, tokenHash, purposePrefix) {
  const result = await client.query(
    `DELETE FROM app_auth_challenges
      WHERE token_hash = $1
        AND purpose LIKE $2 || '%'
        AND user_id IS NOT NULL
        AND expires_at > now()
      RETURNING user_id AS "userId", purpose`,
    [tokenHash, purposePrefix],
  )
  return result.rows[0] || null
}

export async function updatePasskeyCounter(client, passkeyId, previousCounter, nextCounter) {
  if (!Number.isSafeInteger(nextCounter) || nextCounter < 0) return false
  const result = await client.query(
    `UPDATE app_passkeys
        SET counter = $1, last_used_at = now()
      WHERE id = $2
        AND counter = $3
        AND $1 >= counter`,
    [nextCounter, passkeyId, previousCounter],
  )
  return result.rowCount === 1
}
