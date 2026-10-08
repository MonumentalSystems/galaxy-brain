import { AccountMenu } from "@/components/account-menu"
import { AuthShell } from "@/components/auth-shell"
import { PaperWorkbench } from "@/components/papers/paper-workbench"
import { requireUser } from "@/lib/auth"

export default async function PapersPage({
  searchParams,
}: {
  searchParams: Promise<{ mechanism?: string; paper?: string }>
}) {
  const user = await requireUser()
  const { mechanism, paper } = await searchParams
  return (
    <AuthShell user={user} ownsAccountMenu>
      <PaperWorkbench
        tenantId={user.tenantId}
        principalId={user.principalId}
        initialMechanism={mechanism}
        initialPaperId={paper}
        accountMenu={<AccountMenu user={user} />}
      />
    </AuthShell>
  )
}
