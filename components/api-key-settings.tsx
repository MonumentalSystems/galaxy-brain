"use client"

import { useCallback, useEffect, useState } from "react"
import { Check, Copy, KeyRound, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

type ApiKey = {
  id: string
  label: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

function formatDate(value: string | null) {
  if (!value) return null
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

export function ApiKeySettings() {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [label, setLabel] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // Held only until the person navigates away: the server cannot show it again.
  const [freshKey, setFreshKey] = useState<string | null>(null)

  const loadKeys = useCallback(async () => {
    const response = await fetch("/api/auth/api-keys", { cache: "no-store" })
    if (!response.ok) {
      setError("Could not load your API keys.")
      return
    }
    const body = (await response.json()) as { keys: ApiKey[] }
    setKeys(body.keys)
  }, [])

  useEffect(() => {
    void loadKeys()
  }, [loadKeys])

  async function createKey() {
    setPending(true)
    setError(null)
    try {
      const response = await fetch("/api/auth/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim() }),
      })
      const body = await response.json()
      if (!response.ok) {
        setError(body?.error || "Could not create the key.")
        return
      }
      setFreshKey(body.key)
      setCopied(false)
      setLabel("")
      await loadKeys()
    } finally {
      setPending(false)
    }
  }

  async function revokeKey(id: string) {
    setError(null)
    const response = await fetch(`/api/auth/api-keys/${id}`, { method: "DELETE" })
    if (!response.ok && response.status !== 204) {
      setError("Could not revoke the key.")
      return
    }
    await loadKeys()
  }

  async function copyFreshKey() {
    if (!freshKey) return
    try {
      await navigator.clipboard.writeText(freshKey)
      setCopied(true)
    } catch {
      setError("Could not copy to the clipboard. Select the key and copy it manually.")
    }
  }

  return (
    <main className="min-h-screen bg-background px-6 py-10 text-foreground">
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <p className="text-sm font-medium text-primary">Account</p>
          <h1 className="font-display text-3xl font-semibold">API keys</h1>
          <p className="mt-2 text-muted-foreground">
            Let something outside the browser act for you — a clipper extension, a script, another
            service. A key can do what you can, so treat it like a password and revoke it if it
            leaks.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Create a key</CardTitle>
            <CardDescription>
              Name it after where it will live, so you know what you are revoking later.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              aria-label="Key label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Example: duly-noted clipper"
              maxLength={80}
            />
            <Button type="button" onClick={createKey} disabled={pending || !label.trim()}>
              <KeyRound aria-hidden="true" />
              {pending ? "Creating..." : "Create key"}
            </Button>
          </CardContent>
        </Card>

        {freshKey && (
          <Card className="border-primary">
            <CardHeader>
              <CardTitle>Copy your key now</CardTitle>
              <CardDescription>
                This is the only time it is shown. Galaxy Brain stores a hash, so it cannot be
                recovered — if you lose it, revoke it and create another.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <code className="block break-all rounded-lg bg-muted p-3 font-mono text-sm">
                {freshKey}
              </code>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={copyFreshKey}>
                  {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setFreshKey(null)}>
                  Done
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Your keys</CardTitle>
            <CardDescription>
              {keys.length === 0
                ? "You have not created any keys yet."
                : "Revoking takes effect immediately and cannot be undone."}
            </CardDescription>
          </CardHeader>
          {keys.length > 0 && (
            <CardContent className="space-y-3">
              {keys.map((key) => (
                <div
                  key={key.id}
                  className="flex items-start justify-between gap-4 rounded-lg border p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{key.label}</p>
                    <p className="text-xs text-muted-foreground">
                      Created {formatDate(key.createdAt)}
                      {key.lastUsedAt
                        ? ` · last used ${formatDate(key.lastUsedAt)}`
                        : " · never used"}
                      {key.expiresAt ? ` · expires ${formatDate(key.expiresAt)}` : ""}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Revoke ${key.label}`}
                    onClick={() => revokeKey(key.id)}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              ))}
            </CardContent>
          )}
        </Card>
      </div>
    </main>
  )
}
