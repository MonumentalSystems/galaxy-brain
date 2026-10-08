import { ApiKeySettings } from "@/components/api-key-settings"
import { requireUser } from "@/lib/auth"

export default async function ApiKeysSettingsPage() {
  await requireUser()
  return <ApiKeySettings />
}
