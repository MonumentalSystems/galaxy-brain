"use client"

import { useState } from "react"
import { ArrowRight, ShieldCheck } from "lucide-react"

import { Button } from "@/components/ui/button"

export function GenerousConnectConsent({
  callback,
  state,
  pubkey,
}: {
  callback: string
  state: string
  pubkey: string
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connect = async () => {
    setPending(true)
    setError(null)
    try {
      const response = await fetch("/api/connect/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback, state }),
      })
      const result = await response.json()
      if (!response.ok || typeof result.redirectUrl !== "string") {
        throw new Error(result.error || "Galaxy Brain could not complete the connection.")
      }
      window.location.assign(result.redirectUrl)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Galaxy Brain could not complete the connection.")
      setPending(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border bg-muted/40 p-4 text-sm">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
          <div>
            <p className="font-medium">Verified Nostr identity</p>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{pubkey}</p>
          </div>
        </div>
      </div>
      <p className="text-sm leading-6 text-muted-foreground">
        The connecting app receives your Galaxy principal, tenant, and public Nostr key. Your private
        key stays in your signer, and the connection code can be used only once.
      </p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-3">
        <Button type="button" onClick={connect} disabled={pending} className="flex-1">
          {pending ? "Connecting…" : "Connect"}
          <ArrowRight aria-hidden="true" />
        </Button>
        <Button type="button" variant="outline" onClick={() => window.location.assign("/workspace")}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
