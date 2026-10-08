"use client"

import type { ReactNode } from "react"
import { useState } from "react"
import { startAuthentication } from "@simplewebauthn/browser"

import { Button } from "@/components/ui/button"
import { signNostrAuthEvent } from "@/lib/nostr-browser"

type AlternativeSignInProps = {
  passkeyIcon: ReactNode
  nostrIcon: ReactNode
  returnTo?: string
  nostrOnly?: boolean
}

export function AlternativeSignIn({
  passkeyIcon,
  nostrIcon,
  returnTo = "/workspace",
  nostrOnly = false,
}: AlternativeSignInProps) {
  const [pending, setPending] = useState<"passkey" | "nostr" | null>(null)
  const [error, setError] = useState<string | null>(null)

  const signInWithPasskey = async () => {
    setPending("passkey")
    setError(null)
    try {
      const optionsResponse = await fetch("/api/auth/passkey/authenticate/options", { method: "POST" })
      const options = await optionsResponse.json()
      if (!optionsResponse.ok) throw new Error(options.error || "Passkey sign-in is unavailable.")
      const response = await startAuthentication({ optionsJSON: options })
      const verifyResponse = await fetch("/api/auth/passkey/authenticate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge: options.challenge, response }),
      })
      const result = await verifyResponse.json()
      if (!verifyResponse.ok) throw new Error(result.error || "Passkey verification failed.")
      window.location.assign(returnTo)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Passkey sign-in failed.")
    } finally {
      setPending(null)
    }
  }

  const signInWithNostr = async () => {
    setPending("nostr")
    setError(null)
    try {
      const optionsResponse = await fetch("/api/auth/nostr/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose: "login" }),
      })
      const options = await optionsResponse.json()
      if (!optionsResponse.ok) throw new Error(options.error || "Nostr sign-in is unavailable.")
      const event = await signNostrAuthEvent(options)
      const verifyResponse = await fetch("/api/auth/nostr/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose: "login", challenge: options.challenge, event }),
      })
      const result = await verifyResponse.json()
      if (!verifyResponse.ok) throw new Error(result.error || "Nostr verification failed.")
      window.location.assign(returnTo)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nostr sign-in failed.")
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2">
        <Button type="button" onClick={signInWithNostr} disabled={pending !== null}>
          {nostrIcon}
          {pending === "nostr" ? "Signing..." : "Sign in with Nostr"}
        </Button>
        {!nostrOnly && (
          <Button type="button" variant="outline" onClick={signInWithPasskey} disabled={pending !== null}>
            {passkeyIcon}
            {pending === "passkey" ? "Checking..." : "Use a passkey instead"}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
