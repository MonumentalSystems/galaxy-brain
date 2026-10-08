import { AccountMenu } from "@/components/account-menu"
import { AuthShell } from "@/components/auth-shell"
import { TopRail, TopRailTitle } from "@/components/workspace/top-rail"
import { requireUser } from "@/lib/auth"

import { GraphClient } from "./graph-client"

export default async function GraphPage() {
  const user = await requireUser()
  return (
    <AuthShell user={user} ownsAccountMenu>
      <main className="research-workbench min-h-screen p-3 pb-24">
        <TopRail lead={<TopRailTitle>Graph</TopRailTitle>} accountMenu={<AccountMenu user={user} />} />
        <div className="mx-auto mt-3 w-full max-w-[1680px]">
          <GraphClient key={user.tenantId} tenantId={user.tenantId} />
        </div>
      </main>
    </AuthShell>
  )
}
