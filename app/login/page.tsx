import { redirect } from "next/navigation"

import { AuthForm } from "@/components/auth-form"
import { getCurrentUser } from "@/lib/auth"
import { safeReturnTo } from "@/lib/generous-connect"

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string; nostrOnly?: string }>
}) {
  const query = await searchParams
  const returnTo = safeReturnTo(query.returnTo)
  const nostrOnly = query.nostrOnly === "1"
  const user = await getCurrentUser()
  if (user && (!nostrOnly || user.authMethod === "nostr")) redirect(returnTo)
  return <AuthForm mode="login" returnTo={returnTo} nostrOnly={nostrOnly} />
}
