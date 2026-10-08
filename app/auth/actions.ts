"use server"

import { randomInt } from "crypto"
import { redirect } from "next/navigation"
import { after } from "next/server"

import { createSession, destroySession, hashPassword, verifyPassword } from "@/lib/auth"
import { getAuthOrigin } from "@/lib/auth-config"
import { isPasswordResetEmailConfigured, sendPasswordResetEmail } from "@/lib/auth-mail"
import { authRequestIdentifier, takeAuthRateLimit } from "@/lib/auth-rate-limit"
import { insertInitialOwner, invalidateResetCredentials } from "@/lib/auth-security"
import { createRecoveryToken, hashAuthToken } from "@/lib/auth-tokens"
import { ensureAppSchema, getPool } from "@/lib/db"

function readString(formData: FormData, key: string) {
  return String(formData.get(key) || "").trim()
}

export async function registerAction(_prevState: { error?: string } | undefined, formData: FormData) {
  const email = readString(formData, "email").toLowerCase()
  const name = readString(formData, "name")
  const password = readString(formData, "password")
  const inviteCode = readString(formData, "inviteCode")
  const requiredInviteCode = process.env.REGISTRATION_INVITE_CODE

  const requestIdentifier = await authRequestIdentifier()
  if (!(await takeAuthRateLimit("register", requestIdentifier, 5, 60 * 60))) {
    return { error: "Too many registration attempts. Wait before trying again." }
  }

  await ensureAppSchema()

  const existingOwner = await getPool().query("SELECT 1 FROM app_users LIMIT 1")
  if (existingOwner.rowCount) {
    return { error: "This workspace already has an owner. Ask the workspace administrator for access." }
  }

  if (!email || !password) return { error: "Email and password are required." }
  if (password.length < 10) return { error: "Use a password with at least 10 characters." }
  if (!requiredInviteCode) return { error: "Registration is disabled until the administrator configures an invite code." }
  if (inviteCode !== requiredInviteCode) return { error: "That invite code is not valid for this workspace." }

  const client = await getPool().connect()
  try {
    await client.query("BEGIN")
    const owner = await insertInitialOwner(client, {
      email,
      name: name || null,
      passwordHash: hashPassword(password),
    })
    if (!owner) {
      await client.query("ROLLBACK")
      return { error: "This single-user workspace already has an owner." }
    }
    await client.query("COMMIT")
    await createSession(owner.userId, owner.tenantId)
  } catch (error: any) {
    await client.query("ROLLBACK").catch(() => undefined)
    if (error?.code === "23505") return { error: "An account with that email already exists." }
    console.error("Registration failed", error)
    return { error: "Registration failed. Check the server logs and database connection." }
  } finally {
    client.release()
  }

  redirect("/workspace")
}

export async function loginAction(_prevState: { error?: string } | undefined, formData: FormData) {
  const email = readString(formData, "email").toLowerCase()
  const password = readString(formData, "password")

  if (!email || !password) return { error: "Email and password are required." }

  const requestIdentifier = await authRequestIdentifier()
  if (!(await takeAuthRateLimit("password-login", requestIdentifier, 10, 15 * 60))) {
    return { error: "Too many sign-in attempts. Wait before trying again." }
  }

  await ensureAppSchema()
  const result = await getPool().query(
    "SELECT id, password_hash FROM app_users WHERE email = $1 LIMIT 1",
    [email],
  )
  const user = result.rows[0]

  if (!user || !verifyPassword(password, user.password_hash)) {
    return { error: "Invalid email or password." }
  }

  await createSession(user.id)
  redirect("/workspace")
}

type RecoveryState = {
  error?: string
  message?: string
  emailConfigured?: boolean
}

async function padRecoveryResponse(startedAt: number) {
  const targetDuration = 350 + randomInt(151)
  const remaining = targetDuration - (Date.now() - startedAt)
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
}

export async function requestPasswordResetAction(
  _prevState: RecoveryState | undefined,
  formData: FormData,
): Promise<RecoveryState> {
  const startedAt = Date.now()
  const email = readString(formData, "email").toLowerCase()
  if (!email) return { error: "Enter your account email." }

  const emailConfigured = isPasswordResetEmailConfigured()
  const genericMessage = "If that address belongs to this workspace, a reset link will arrive shortly."
  if (!emailConfigured) {
    return {
      message: "Email recovery is not configured for this self-hosted workspace.",
      emailConfigured: false,
    }
  }

  await ensureAppSchema()
  const requestIdentifier = await authRequestIdentifier()
  const [requestAllowed, addressAllowed] = await Promise.all([
    takeAuthRateLimit("password-reset-ip", requestIdentifier, 5, 15 * 60),
    takeAuthRateLimit("password-reset-address", email, 3, 60 * 60),
  ])
  if (!requestAllowed || !addressAllowed) {
    await padRecoveryResponse(startedAt)
    return { message: genericMessage, emailConfigured: true }
  }

  const result = await getPool().query("SELECT id, email FROM app_users WHERE email = $1 LIMIT 1", [email])
  const user = result.rows[0]
  if (user) {
    const token = await createRecoveryToken(user.id)
    if (token) {
      const tokenHash = hashAuthToken(token)
      const resetUrl = new URL("/reset-password", getAuthOrigin())
      resetUrl.searchParams.set("token", token)
      after(async () => {
        try {
          await sendPasswordResetEmail(user.email, resetUrl.toString())
        } catch (error) {
          await getPool().query("DELETE FROM app_password_reset_tokens WHERE token_hash = $1", [tokenHash])
          console.error("Password reset email failed", error)
        }
      })
    }
  }

  await padRecoveryResponse(startedAt)
  return { message: genericMessage, emailConfigured: true }
}

export async function resetPasswordAction(
  _prevState: { error?: string } | undefined,
  formData: FormData,
) {
  const token = readString(formData, "token")
  const password = readString(formData, "password")
  const confirmation = readString(formData, "passwordConfirmation")

  if (!token) return { error: "This reset link is incomplete." }
  if (password.length < 10) return { error: "Use a password with at least 10 characters." }
  if (password !== confirmation) return { error: "The passwords do not match." }

  await ensureAppSchema()
  const client = await getPool().connect()
  let userId: string | null = null
  try {
    await client.query("BEGIN")
    const result = await client.query(
      `SELECT user_id
         FROM app_password_reset_tokens
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        FOR UPDATE`,
      [hashAuthToken(token)],
    )
    userId = result.rows[0]?.user_id || null
    if (!userId) {
      await client.query("ROLLBACK")
      return { error: "This reset link is invalid or has expired." }
    }

    await client.query("UPDATE app_users SET password_hash = $1, updated_at = now() WHERE id = $2", [
      hashPassword(password),
      userId,
    ])
    await invalidateResetCredentials(client, userId)
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    console.error("Password reset failed", error)
    return { error: "The password could not be reset. Try requesting a new link." }
  } finally {
    client.release()
  }

  await createSession(userId)
  redirect("/workspace")
}

export async function logoutAction() {
  await destroySession()
  redirect("/login")
}
