import { AccountMenu } from "@/components/account-menu"
import { AuthShell } from "@/components/auth-shell"
import { TopRail, TopRailTitle } from "@/components/workspace/top-rail"
import { requireUser } from "@/lib/auth"

import { GraphClient } from "../graph/graph-client"

export default async function FieldPage() {
  const user = await requireUser()

  return (
    <AuthShell user={user} ownsAccountMenu>
      <main className="min-h-screen bg-[#e8ede3] p-3 pb-24 text-[#1e2a24]">
        <TopRail lead={<TopRailTitle>Field</TopRailTitle>} accountMenu={<AccountMenu user={user} />} />
        <div className="mx-auto h-[calc(100dvh-8rem)] min-h-[32rem] w-full max-w-[1680px]">
          <GraphClient key={user.tenantId} tenantId={user.tenantId} presentation="field" />
        </div>
      </main>
    </AuthShell>
  )
}
