import { AccountMenu } from "@/components/account-menu"
import { AuthShell } from "@/components/auth-shell"
import { SurfaceBrowser } from "@/components/surfaces/surface-browser"
import { requireUser } from "@/lib/auth"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export default async function SurfacesPage({
  searchParams,
}: {
  searchParams: Promise<{
    surface?: string | string[]
    version?: string | string[]
    hash?: string | string[]
  }>
}) {
  const user = await requireUser()
  const requested = await searchParams
  const exactSelectorPresent = requested.surface !== undefined
    || requested.version !== undefined
    || requested.hash !== undefined
  const requestedSurface = typeof requested.surface === "string" ? requested.surface : undefined
  const requestedVersion = typeof requested.version === "string" ? requested.version : undefined
  const requestedHash = typeof requested.hash === "string" ? requested.hash : undefined
  const validExactSelector = exactSelectorPresent
    && requestedSurface !== undefined
    && UUID.test(requestedSurface)
    && requestedVersion !== undefined
    && /^[1-9]\d{0,8}$/.test(requestedVersion)
    && requestedHash !== undefined
    && /^[0-9a-f]{64}$/.test(requestedHash)
  const invalidExactLink = exactSelectorPresent && !validExactSelector
  const initialSurfaceId = validExactSelector && requestedSurface
    ? requestedSurface.toLowerCase()
    : undefined
  const initialSurfaceVersion = validExactSelector && requestedVersion
    ? Number(requestedVersion)
    : undefined
  const initialSurfaceHash = validExactSelector && requestedHash ? requestedHash : undefined
  return (
    <AuthShell user={user} ownsAccountMenu>
      <SurfaceBrowser
        initialSurfaceId={initialSurfaceId}
        initialSurfaceVersion={initialSurfaceVersion}
        initialSurfaceHash={initialSurfaceHash}
        invalidExactLink={invalidExactLink}
        accountMenu={<AccountMenu user={user} />}
      />
    </AuthShell>
  )
}
