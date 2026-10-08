"use client"

import { useCallback, useEffect, useState } from "react"
import { Copy, KeyRound, Radio, Trash2, UserPlus, X } from "lucide-react"
import { startRegistration } from "@simplewebauthn/browser"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { signNostrAuthEvent } from "@/lib/nostr-browser"

type Credential = {
  id: string
  label: string
  created_at: string
  last_used_at: string | null
  backed_up?: boolean
  pubkey?: string
}

type Invitation = {
  id: string
  email: string
  name: string | null
  created_at: string
  expires_at: string
  accepted_at: string | null
  revoked_at: string | null
  status: "accepted" | "revoked" | "expired" | "pending"
}

type SecuritySettingsProps = {
  canInvite?: boolean
}

export function SecuritySettings({ canInvite = false }: SecuritySettingsProps) {
  const [passkeys, setPasskeys] = useState<Credential[]>([])
  const [nostrKeys, setNostrKeys] = useState<Credential[]>([])
  const [label, setLabel] = useState("")
  const [pending, setPending] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteName, setInviteName] = useState("")
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)

  const loadCredentials = useCallback(async () => {
    const response = await fetch("/api/auth/credentials", { cache: "no-store" })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || "Security settings could not be loaded.")
    setPasskeys(data.passkeys)
    setNostrKeys(data.nostrKeys)
  }, [])

  const loadInvitations = useCallback(async () => {
    if (!canInvite) return
    const response = await fetch("/api/auth/invitations", { cache: "no-store" })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || "Invitations could not be loaded.")
    setInvitations(data.invitations)
  }, [canInvite])

  useEffect(() => {
    loadCredentials().catch((cause) => setError(cause instanceof Error ? cause.message : "Security settings could not be loaded."))
    loadInvitations().catch((cause) => setError(cause instanceof Error ? cause.message : "Invitations could not be loaded."))
  }, [loadCredentials, loadInvitations])

  const createInvitation = async () => {
    setPending("invite")
    setError(null)
    setMessage(null)
    setInviteUrl(null)
    try {
      const response = await fetch("/api/auth/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail, name: inviteName }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || "Invitation creation failed.")
      setInviteEmail("")
      setInviteName("")
      setInviteUrl(result.inviteUrl)
      setMessage("Invitation created. Copy this link now; Galaxy Brain stores only its hash.")
      await loadInvitations()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invitation creation failed.")
    } finally {
      setPending(null)
    }
  }

  const revokeInvitation = async (id: string) => {
    setPending(id)
    setError(null)
    setMessage(null)
    try {
      const response = await fetch(`/api/auth/invitations/${id}`, { method: "DELETE" })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || "Invitation revocation failed.")
      setMessage("Invitation revoked.")
      await loadInvitations()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invitation revocation failed.")
    } finally {
      setPending(null)
    }
  }

  const copyInvitation = async () => {
    if (!inviteUrl) return
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setMessage("Invitation link copied.")
    } catch {
      setError("Clipboard access was unavailable. Select and copy the link manually.")
    }
  }

  const addPasskey = async () => {
    setPending("passkey")
    setError(null)
    setMessage(null)
    try {
      const optionsResponse = await fetch("/api/auth/passkey/register/options", { method: "POST" })
      const options = await optionsResponse.json()
      if (!optionsResponse.ok) throw new Error(options.error || "Passkey setup could not start.")
      const response = await startRegistration({ optionsJSON: options })
      const verifyResponse = await fetch("/api/auth/passkey/register/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge: options.challenge, response, label }),
      })
      const result = await verifyResponse.json()
      if (!verifyResponse.ok) throw new Error(result.error || "Passkey setup failed.")
      setLabel("")
      setMessage("Passkey added. You can use it from the sign-in screen.")
      await loadCredentials()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Passkey setup failed.")
    } finally {
      setPending(null)
    }
  }

  const addNostrKey = async () => {
    setPending("nostr")
    setError(null)
    setMessage(null)
    try {
      const optionsResponse = await fetch("/api/auth/nostr/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose: "enroll" }),
      })
      const options = await optionsResponse.json()
      if (!optionsResponse.ok) throw new Error(options.error || "Nostr setup could not start.")
      const event = await signNostrAuthEvent(options)
      const verifyResponse = await fetch("/api/auth/nostr/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose: "enroll", challenge: options.challenge, event, label }),
      })
      const result = await verifyResponse.json()
      if (!verifyResponse.ok) throw new Error(result.error || "Nostr key setup failed.")
      setLabel("")
      setMessage("Nostr key added. Its private key remains in your signer.")
      await loadCredentials()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nostr key setup failed.")
    } finally {
      setPending(null)
    }
  }

  const removeCredential = async (kind: "passkey" | "nostr", id: string) => {
    setPending(id)
    setError(null)
    setMessage(null)
    try {
      const response = await fetch("/api/auth/credentials", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, id }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || "Credential removal failed.")
      setMessage("Sign-in credential removed.")
      await loadCredentials()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Credential removal failed.")
    } finally {
      setPending(null)
    }
  }

  const rows = [
    ...passkeys.map((credential) => ({ ...credential, kind: "passkey" as const })),
    ...nostrKeys.map((credential) => ({ ...credential, kind: "nostr" as const })),
  ]

  return (
    <main className="min-h-screen bg-background px-6 py-10 text-foreground">
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <p className="text-sm font-medium text-primary">Account</p>
          <h1 className="font-display text-3xl font-semibold">Sign-in security</h1>
          <p className="mt-2 text-muted-foreground">
            {canInvite
              ? "Manage passwordless credentials and personal workspace invitations."
              : "Manage passwordless credentials for your account."}
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Add a sign-in method</CardTitle>
            <CardDescription>Give it an optional label so you can recognize the device or key later.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Example: laptop or Amber signer" maxLength={80} />
            <div className="grid gap-2 sm:grid-cols-2">
              <Button type="button" onClick={addPasskey} disabled={pending !== null}>
                <KeyRound aria-hidden="true" />
                {pending === "passkey" ? "Adding..." : "Add passkey"}
              </Button>
              <Button type="button" variant="outline" onClick={addNostrKey} disabled={pending !== null}>
                <Radio aria-hidden="true" />
                {pending === "nostr" ? "Signing..." : "Add Nostr key"}
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Galaxy Brain stores passkey public credentials and Nostr public keys only. Your Nostr private key never leaves its signer.
            </p>
          </CardContent>
        </Card>

        {canInvite && (
          <Card>
            <CardHeader>
              <CardTitle>Invite a person</CardTitle>
              <CardDescription>
                Create a one-time link for a separate private workspace. Links expire after seven days.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  aria-label="Invitee name"
                  value={inviteName}
                  onChange={(event) => setInviteName(event.target.value)}
                  placeholder="Name (optional)"
                  maxLength={100}
                />
                <Input
                  aria-label="Invitee email"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  placeholder="friend@example.com"
                  type="email"
                  maxLength={320}
                  required
                />
              </div>
              <Button type="button" onClick={createInvitation} disabled={pending !== null || !inviteEmail.trim()}>
                <UserPlus aria-hidden="true" />
                {pending === "invite" ? "Creating..." : "Create invitation"}
              </Button>
              {inviteUrl && (
                <div className="space-y-2 rounded-md border p-3">
                  <p className="text-sm font-medium">Copy this link now</p>
                  <div className="flex gap-2">
                    <Input aria-label="Invitation link" readOnly value={inviteUrl} onFocus={(event) => event.currentTarget.select()} />
                    <Button type="button" variant="outline" size="icon" aria-label="Copy invitation link" onClick={copyInvitation}>
                      <Copy aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              )}
              <div className="space-y-2">
                {invitations.length === 0 && <p className="text-sm text-muted-foreground">No invitations yet.</p>}
                {invitations.map((invitation) => {
                  const status = invitation.status[0].toUpperCase() + invitation.status.slice(1)
                  return (
                    <div key={invitation.id} className="flex min-w-0 items-center gap-3 border-b py-3 last:border-b-0">
                      <UserPlus aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{invitation.name || invitation.email}</p>
                        <p className="truncate text-xs text-muted-foreground">{invitation.email} · {status}</p>
                      </div>
                      {invitation.status === "pending" && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Revoke invitation for ${invitation.email}`}
                          title={`Revoke invitation for ${invitation.email}`}
                          disabled={pending !== null}
                          onClick={() => revokeInvitation(invitation.id)}
                        >
                          <X aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Registered credentials</CardTitle>
            <CardDescription>Removing a credential immediately prevents future sign-in with it.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {rows.length === 0 && <p className="text-sm text-muted-foreground">No passwordless credentials have been added yet.</p>}
            {rows.map((credential) => (
              <div key={credential.id} className="flex min-w-0 items-center gap-3 border-b py-3 last:border-b-0">
                {credential.kind === "passkey" ? <KeyRound aria-hidden="true" /> : <Radio aria-hidden="true" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{credential.label}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {credential.kind === "nostr" && credential.pubkey
                      ? `${credential.pubkey.slice(0, 12)}...${credential.pubkey.slice(-8)}`
                      : credential.backed_up ? "Synced passkey" : "Device passkey"}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${credential.label}`}
                  title={`Remove ${credential.label}`}
                  disabled={pending !== null}
                  onClick={() => removeCredential(credential.kind, credential.id)}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>

        {(error || message) && (
          <p role={error ? "alert" : "status"} className={error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
            {error || message}
          </p>
        )}
        <Button asChild variant="outline"><Link href="/">Back to workspace</Link></Button>
      </div>
    </main>
  )
}
