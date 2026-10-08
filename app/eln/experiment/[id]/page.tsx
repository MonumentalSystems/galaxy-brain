import { AccountMenu } from "@/components/account-menu"
import { ExperimentRecord } from "@/components/eln/experiment-record"
import { requireUser } from "@/lib/auth"

export default async function ExperimentPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const user = await requireUser()
  const { id } = await params
  return (
    <ExperimentRecord
      experimentId={id}
      tenantId={user.tenantId}
      principalId={user.principalId}
      accountMenu={<AccountMenu user={user} />}
    />
  )
}
