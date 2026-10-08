import { HamAdminSettings } from "@/components/ham-admin-settings"
import { requireUser } from "@/lib/auth"

export default async function HamAdminSettingsPage() {
  await requireUser()
  return <HamAdminSettings />
}
