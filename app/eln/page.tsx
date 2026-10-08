import { AccountMenu } from "@/components/account-menu"
import { ELNDashboard } from "@/components/eln/eln-dashboard"
import { requireUser } from "@/lib/auth"

export default async function ELNPage() {
  const user = await requireUser()
  return (
    <ELNDashboard
      tenantId={user.tenantId}
      principalId={user.principalId}
      accountMenu={<AccountMenu user={user} />}
    />
  )
}
