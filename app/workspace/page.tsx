import { AccountMenu } from "@/components/account-menu"
import { AuthShell } from "@/components/auth-shell"
import { AtlasV2Loader } from "@/app/atlas-v2/atlas-v2-loader"
import { requireUser } from "@/lib/auth"

export default async function WorkspacePage() {
  const user = await requireUser()

  return (
    <AuthShell user={user} ownsAccountMenu>
      <AtlasV2Loader
        tenantId={user.tenantId}
        principalId={user.principalId}
        headerSlot={<AccountMenu user={user} />}
      />
    </AuthShell>
  )
}
