import { redirect } from "next/navigation"

import { AuthForm } from "@/components/auth-form"
import { getCurrentUser } from "@/lib/auth"
import { getRecoveryContact } from "@/lib/auth-config"
import { ensureAppSchema, getPool } from "@/lib/db"

export default async function RegisterPage() {
  const user = await getCurrentUser()
  if (user) redirect("/workspace")
  await ensureAppSchema()
  const existingOwner = await getPool().query("SELECT 1 FROM app_users LIMIT 1")
  return (
    <AuthForm
      mode="register"
      requireInviteCode
      registrationClosed={Boolean(existingOwner.rowCount)}
      recoveryContact={getRecoveryContact()}
    />
  )
}
