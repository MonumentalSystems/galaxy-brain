import { AuthShell } from "@/components/auth-shell"
import { DocumentReaderRoute } from "@/components/papers/document-reader-route"
import { requireUser } from "@/lib/auth"

export default async function DocumentRevisionPage({
  params,
}: {
  params: Promise<{ revisionId: string }>
}) {
  const user = await requireUser()
  const { revisionId } = await params
  return (
    <AuthShell user={user}>
      <DocumentReaderRoute
        documentRevisionId={revisionId}
        tenantId={user.tenantId}
        principalId={user.principalId}
      />
    </AuthShell>
  )
}
