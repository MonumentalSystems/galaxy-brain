"use client"

import { useEffect, useState } from "react"
import { startRegistration } from "@simplewebauthn/browser"
import { KeyRound, Radio } from "lucide-react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { signNostrAuthEvent } from "@/lib/nostr-browser"

export function InvitePasskeyForm() {
  const [token, setToken] = useState<string | null | undefined>(undefined)
  const [pending, setPending] = useState<"passkey" | "nostr" | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const inviteToken = new URLSearchParams(window.location.hash.slice(1)).get("token")
    setToken(inviteToken)
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`)
  }, [])

  const createAccount = async () => {
    if (!token) return
    setPending("passkey")
    setError(null)
    try {
      const optionsResponse = await fetch("/api/auth/invitations/passkey/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })
      const options = await optionsResponse.json()
      if (!optionsResponse.ok) throw new Error(options.error || "Passkey setup could not start.")

      const response = await startRegistration({ optionsJSON: options })
      const verifyResponse = await fetch("/api/auth/invitations/passkey/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, challenge: options.challenge, response }),
      })
      const result = await verifyResponse.json()
      if (!verifyResponse.ok) throw new Error(result.error || "Passkey setup failed.")
      window.location.assign("/workspace")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Passkey setup failed.")
      setPending(null)
    }
  }

  const createNostrAccount = async () => {
    if (!token) return
    setPending("nostr")
    setError(null)
    try {
      const optionsResponse = await fetch("/api/auth/invitations/nostr/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })
      const options = await optionsResponse.json()
      if (!optionsResponse.ok) throw new Error(options.error || "Nostr sign-in setup could not start.")

      const event = await signNostrAuthEvent(options)
      const verifyResponse = await fetch("/api/auth/invitations/nostr/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, challenge: options.challenge, event }),
      })
      const result = await verifyResponse.json()
      if (!verifyResponse.ok) throw new Error(result.error || "Nostr verification failed.")
      window.location.assign("/workspace")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nostr sign-in failed.")
      setPending(null)
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-md items-center px-6">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Create your private Galaxy Brain</CardTitle>
            <CardDescription>
              This invitation creates a separate personal workspace. Your notebooks and research stay in your tenant.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {token === undefined ? (
              <p className="text-sm text-muted-foreground">Reading invitation...</p>
            ) : token ? (
              <>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Button type="button" disabled={pending !== null} onClick={createNostrAccount}>
                    <Radio aria-hidden="true" />
                    {pending === "nostr" ? "Signing..." : "Use Nostr identity"}
                  </Button>
                  <Button type="button" variant="outline" disabled={pending !== null} onClick={createAccount}>
                    <KeyRound aria-hidden="true" />
                    {pending === "passkey" ? "Creating..." : "Use a passkey"}
                  </Button>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Use the same NIP-07 public key that identifies you in HAM or Hyades, or create a device passkey.
                  Galaxy Brain stores only the verified public credential, and consumes the invitation only after verification succeeds.
                </p>
              </>
            ) : (
              <p role="alert" className="text-sm text-destructive">
                This invitation link is incomplete. Ask the person who invited you for a new link.
              </p>
            )}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button asChild className="w-full" variant="outline">
              <Link href="/login">Return to sign in</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
