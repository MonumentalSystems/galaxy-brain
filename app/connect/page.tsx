import { redirect } from "next/navigation"

import { GenerousConnectConsent } from "@/components/generous-connect-consent"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getCurrentUser } from "@/lib/auth"
import { isAllowedGenerousCallback, isValidGenerousState } from "@/lib/generous-connect"

export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<{ callback?: string; state?: string }>
}) {
  const { callback, state } = await searchParams
  if (!isAllowedGenerousCallback(callback) || !isValidGenerousState(state)) {
    return <main className="mx-auto max-w-lg p-8"><p>That connection request is invalid or expired.</p></main>
  }

  const returnTo = `/connect?${new URLSearchParams({ callback, state }).toString()}`
  const user = await getCurrentUser()
  if (!user || user.authMethod !== "nostr" || !user.nostrPubkey) {
    redirect(`/login?${new URLSearchParams({ returnTo, nostrOnly: "1" }).toString()}`)
  }

  return (
    <main className="min-h-screen bg-background px-6 py-16 text-foreground">
      <Card className="mx-auto max-w-lg">
        <CardHeader>
          <CardTitle>Connect to Galaxy Brain</CardTitle>
          <CardDescription>Sign once with Nostr. There are no scopes or permission screens.</CardDescription>
        </CardHeader>
        <CardContent>
          <GenerousConnectConsent callback={callback} state={state} pubkey={user.nostrPubkey} />
        </CardContent>
      </Card>
    </main>
  )
}
