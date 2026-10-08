import { AccountMenu } from "@/components/account-menu"
import { AuthShell } from "@/components/auth-shell"
import { TaskQueueView } from "@/components/tasks/task-queue-view"
import { TopRail, TopRailTitle } from "@/components/workspace/top-rail"
import { requireUser } from "@/lib/auth"
import { hamTaskMutationsEnabled } from "@/lib/ham-task-proxy"
import { parsePaperTaskConstructorRequest } from "@/lib/paper-enhance-handoff.js"
import {
  proofCampaignControlConfigured,
  proofCampaignMutationsEnabled,
} from "@/lib/proof-campaign-proxy"

type TasksPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function TasksPage({ searchParams }: TasksPageProps) {
  const user = await requireUser()
  const campaignControlConfigured = proofCampaignControlConfigured()
  let constructorRequest: { taskId: string; version: number } | { error: true } | null = null
  try {
    constructorRequest = parsePaperTaskConstructorRequest(await searchParams)
  } catch {
    constructorRequest = { error: true }
  }
  return (
    <AuthShell user={user} ownsAccountMenu>
      <main className="flex min-h-screen flex-col p-3 text-foreground">
        <TopRail lead={<TopRailTitle>Tasks</TopRailTitle>} accountMenu={<AccountMenu user={user} />} />
        <div className="mx-auto w-full max-w-[1600px]">
          <header className="mb-8">
            <p className="app-chip mb-3 w-fit">Coordination surface</p>
            <p className="max-w-3xl text-muted-foreground">
              See canonical HAM work, delivery, claims, runs, waits, reviews, outcomes, and safely abstracted resource overlap in one place.
            </p>
          </header>
          <TaskQueueView
            tenantId={user.tenantId}
            constructorRequest={constructorRequest}
            allowMutations={hamTaskMutationsEnabled()}
            showProofCampaignControl={user.role !== "member"}
            proofCampaignControlConfigured={campaignControlConfigured}
            allowProofCampaignMutations={campaignControlConfigured && proofCampaignMutationsEnabled() && user.role !== "member"}
          />
        </div>
      </main>
    </AuthShell>
  )
}
