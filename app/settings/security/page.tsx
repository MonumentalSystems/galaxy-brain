import { SecuritySettings } from "@/components/security-settings"
import { requireUser } from "@/lib/auth"
import { canManagePersonalWorkspaceInvitations } from "@/lib/auth-security"

export default async function SecuritySettingsPage() {
  const user = await requireUser()
  return <SecuritySettings canInvite={canManagePersonalWorkspaceInvitations(user)} />
}
