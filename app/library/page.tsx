import { AccountMenu } from "@/components/account-menu"
import { AuthShell } from "@/components/auth-shell"
import { LibraryWorkbench } from "@/components/library/library-workbench"
import { requireUser } from "@/lib/auth"

export default async function LibraryPage() {
  const user = await requireUser()
  return (
    <AuthShell user={user} ownsAccountMenu>
      <LibraryWorkbench accountMenu={<AccountMenu user={user} />} />
    </AuthShell>
  )
}
