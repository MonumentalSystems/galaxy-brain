"use client"

import { FormEvent, useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { Copy, KeyRound, Radio, RefreshCw, ShieldCheck, UserPlus } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { isPrincipalExpired } from "@/lib/ham-admin-contract.js"

type Principal = {
  pubkey: string
  label: string | null
  created_at: string
  expires_at: string | null
  revoked_at: string | null
}

type Member = {
  membership_id: string
  project_id: string
  subject_type: "nostr" | "legacy_credential"
  principal: Principal | null
  revoked_at: string | null
}

type Project = {
  project_id: string
  slug: string
  name: string
  repo: string | null
  scope: string
  description: string | null
}

type Overview = {
  identity: {
    agent_id?: string
    auth_method?: string
    nostr_pubkey?: string | null
  }
  galaxyIdentity: {
    principalId: string
    authMethod: "password" | "passkey" | "nostr"
    nostrPubkey: string | null
  }
  projects: Project[]
  principals: Principal[]
  membersByProject: Record<string, Member[]>
  sessionFresh: boolean
}

const selectClass = "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"

function formatTime(value: string | null) {
  if (!value) return "No expiry"
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value
}

function shortPubkey(pubkey: string) {
  return `${pubkey.slice(0, 12)}…${pubkey.slice(-8)}`
}

async function readJson(response: Response) {
  const data = await response.json().catch(() => ({ error: "The server returned an unreadable response." }))
  if (!response.ok) throw new Error(data.error || data.detail || "HAM administration request failed.")
  return data
}

function MutationDialog({
  label,
  title,
  description,
  destructive = false,
  disabled,
  onConfirm,
}: {
  label: string
  title: string
  description: string
  destructive?: boolean
  disabled?: boolean
  onConfirm: () => void
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" size="sm" variant={destructive ? "destructive" : "outline"} disabled={disabled}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{label}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function HamAdminSettings() {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/ham", { cache: "no-store" })
    setOverview(await readJson(response))
    setError(null)
  }, [])

  useEffect(() => {
    load().catch((cause) => {
      setError(cause instanceof Error ? cause.message : "HAM administration could not be loaded.")
    })
  }, [load])

  // A minted HAM key is returned once and stored only as a hash, so it is held
  // here until the operator dismisses it and never re-fetched.
  const [freshCredential, setFreshCredential] = useState<{ id?: string; key: string } | null>(null)

  const mutate = async (payload: Record<string, unknown>, success: string) => {
    setPending(String(payload.action))
    setError(null)
    setMessage(null)
    try {
      const response = await fetch("/api/admin/ham", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await readJson(response)
      setMessage(success)
      await load()
      return body
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "HAM administration request failed.")
    } finally {
      setPending(null)
    }
  }

  const submitCredential = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const body = await mutate({
      action: "createCredential",
      agentId: form.get("agentId"),
    }, "Managed credential created.")
    const record = body as { id?: string; key?: string; credential?: { id?: string; key?: string } } | undefined
    const key = record?.key || record?.credential?.key
    if (key) setFreshCredential({ id: record?.id || record?.credential?.id, key })
  }

  const submitProject = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    void mutate({
      action: "createProject",
      name: form.get("name"),
      slug: form.get("slug"),
      repo: form.get("repo"),
      description: form.get("description"),
    }, "Organizational project created.")
  }

  const submitPrincipal = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    void mutate({
      action: "registerAgentPrincipal",
      pubkey: form.get("pubkey"),
      durationDays: Number(form.get("durationDays")),
      label: form.get("label"),
    }, "Agent Nostr public key registered. Its secret remains on the agent's machine.")
  }

  const submitMember = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    void mutate({
      action: "createMember",
      projectId: form.get("projectId"),
      pubkey: form.get("pubkey"),
    }, "Principal associated with the project for organization only.")
  }

  const principals = overview?.principals || []
  const activePrincipals = principals.filter(
    (principal) => !principal.revoked_at && !isPrincipalExpired(principal.expires_at),
  )
  const galaxyPubkey = overview?.galaxyIdentity.nostrPubkey || null
  const currentKeyRegistered = Boolean(
    galaxyPubkey && activePrincipals.some((principal) => principal.pubkey === galaxyPubkey),
  )

  return (
    <main className="min-h-screen bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <p className="text-sm font-medium text-primary">Owner control plane</p>
          <h1 className="font-display text-3xl font-semibold">Nostr principals and memory organization</h1>
          <p className="mt-2 max-w-3xl text-muted-foreground">
            Use the same signed-in human public key across Galaxy Brain, HAM, and Hyades. Agents keep separate Nostr keys so they can be revoked independently.
          </p>
        </header>

        {(error || message) ? (
          <p role={error ? "alert" : "status"} className={error ? "rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" : "rounded-md border p-3 text-sm"}>
            {error || message}
          </p>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle><h2 className="flex items-center gap-2 text-xl"><Radio aria-hidden="true" />Signed-in identity</h2></CardTitle>
            <CardDescription>The browser signer proves one identity across Galaxy Brain and HAM.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Badge variant={overview?.galaxyIdentity.authMethod === "nostr" ? "default" : "destructive"}>
                {overview?.galaxyIdentity.authMethod || "Unavailable"}
              </Badge>
              <code className="[overflow-wrap:anywhere]">{galaxyPubkey || "No Nostr public key in this session"}</code>
              <Badge variant={overview?.sessionFresh ? "outline" : "destructive"}>
                {overview?.sessionFresh ? "Recent sign-in" : "Reauthentication required"}
              </Badge>
              <Button type="button" size="sm" variant="outline" disabled={pending !== null} onClick={() => void load().catch((cause) => setError(cause instanceof Error ? cause.message : "HAM administration could not be loaded."))}>
                <RefreshCw aria-hidden="true" />Refresh
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="default">HAM connected</Badge>
              <span className="text-sm text-muted-foreground">Tenant-wide access</span>
              {currentKeyRegistered ? (
                <Badge variant="secondary">Current key registered in HAM</Badge>
              ) : (
                <Button
                  type="button"
                  disabled={!galaxyPubkey || pending !== null || !overview?.sessionFresh}
                  onClick={() => void mutate({ action: "registerCurrentPrincipal" }, "The signed-in Nostr key now identifies this owner in HAM.")}
                >
                  <ShieldCheck aria-hidden="true" />Register current key in HAM
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle><h2 className="text-xl">Register an agent key</h2></CardTitle>
              <CardDescription>The agent creates its key locally and sends only its public key. Never paste an nsec here.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={submitPrincipal}>
                <div className="space-y-2">
                  <Label htmlFor="principal-pubkey">Nostr public key</Label>
                  <Input id="principal-pubkey" name="pubkey" required minLength={64} maxLength={64} pattern="[0-9a-f]{64}" autoComplete="off" />
                </div>
                <div className="space-y-2"><Label htmlFor="principal-duration">Expiry</Label><select id="principal-duration" name="durationDays" className={selectClass} defaultValue="365"><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="3650">10 years</option></select></div>
                <div className="space-y-2"><Label htmlFor="principal-label">Label</Label><Input id="principal-label" name="label" maxLength={200} placeholder="Codex on build-host" autoComplete="off" /></div>
                <Button type="submit" disabled={pending !== null || !overview?.sessionFresh}><UserPlus aria-hidden="true" />Register public key</Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle><h2 className="text-xl">Issue a managed credential</h2></CardTitle>
              <CardDescription>
                A bearer key for something that cannot sign Nostr events — a service, a hosted client, or a
                deployment such as Galaxy Brain itself. Prefer a registered Nostr key for anything that can sign.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <form className="space-y-4" onSubmit={submitCredential}>
                <div className="space-y-2">
                  <Label htmlFor="credential-agent">Agent ID</Label>
                  <Input id="credential-agent" name="agentId" required maxLength={120} pattern="[a-z0-9][a-z0-9._-]*" placeholder="galaxy-brain-bff" autoComplete="off" />
                </div>
                <p className="text-xs text-muted-foreground">The key connects this application to the current tenant. There are no scopes to configure.</p>
                <Button type="submit" disabled={pending !== null || !overview?.sessionFresh}>
                  <KeyRound aria-hidden="true" />Issue credential
                </Button>
              </form>

              {freshCredential && (
                <div className="space-y-3 rounded-lg border border-primary p-3">
                  <div>
                    <p className="font-medium">Copy this key now</p>
                    <p className="text-sm text-muted-foreground">
                      HAM stores only a hash, so it cannot be shown again. If it is lost, revoke it and issue another.
                    </p>
                  </div>
                  <code className="block break-all rounded-lg bg-muted p-3 font-mono text-sm">{freshCredential.key}</code>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" onClick={() => { void navigator.clipboard.writeText(freshCredential.key) }}>
                      <Copy aria-hidden="true" />Copy
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setFreshCredential(null)}>Done</Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle><h2 className="text-xl">Create an organizational project</h2></CardTitle>
              <CardDescription>Projects group topics and records. They do not grant HAM task, Hyades workflow, or GitHub permissions.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={submitProject}>
                <div className="space-y-2"><Label htmlFor="project-name">Project name</Label><Input id="project-name" name="name" required maxLength={200} autoComplete="off" /></div>
                <div className="space-y-2"><Label htmlFor="project-slug">Organizational slug</Label><Input id="project-slug" name="slug" required maxLength={120} pattern="[a-z0-9][a-z0-9._-]*" autoComplete="off" /></div>
                <div className="space-y-2"><Label htmlFor="project-repo">Repository label</Label><Input id="project-repo" name="repo" maxLength={300} placeholder="owner/repository" autoComplete="off" /></div>
                <div className="space-y-2"><Label htmlFor="project-description">Description</Label><Textarea id="project-description" name="description" maxLength={2000} /></div>
                <Button type="submit" disabled={pending !== null || !overview?.sessionFresh}>Create project</Button>
              </form>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle><h2 className="text-xl">Organize a principal under a project</h2></CardTitle>
            <CardDescription>This association changes navigation and discovery only. Removing it does not revoke the principal.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={submitMember}>
              <div className="space-y-2"><Label htmlFor="member-project">Project</Label><select id="member-project" name="projectId" className={selectClass} required defaultValue=""><option value="" disabled>Select a project</option>{overview?.projects.map((project) => <option key={project.project_id} value={project.project_id}>{project.name}</option>)}</select></div>
              <div className="space-y-2"><Label htmlFor="member-pubkey">Nostr principal</Label><select id="member-pubkey" name="pubkey" className={selectClass} required defaultValue=""><option value="" disabled>Select a public key</option>{activePrincipals.map((principal) => <option key={principal.pubkey} value={principal.pubkey}>{principal.label || shortPubkey(principal.pubkey)}</option>)}</select></div>
              <Button type="submit" disabled={pending !== null || !overview?.sessionFresh || !overview?.projects.length || !activePrincipals.length}>Associate</Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle><h2 className="text-xl">Projects and principals</h2></CardTitle>
            <CardDescription>Membership is organizational metadata, never an authorization grant.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {!overview?.projects.length ? <p className="text-sm text-muted-foreground">No projects are available.</p> : null}
            {overview?.projects.map((project) => (
              <section key={project.project_id} className="rounded-md border p-4" aria-labelledby={`project-${project.project_id}`}>
                <div><h3 id={`project-${project.project_id}`} className="font-semibold">{project.name}</h3><p className="text-sm text-muted-foreground">{project.slug}{project.repo ? ` · ${project.repo}` : ""}</p></div>
                <ul className="mt-3 space-y-2">
                  {(overview.membersByProject[project.project_id] || []).map((member) => (
                    <li key={member.membership_id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-sm">
                      <span>{member.principal ? (member.principal.label || shortPubkey(member.principal.pubkey)) : "Legacy credential association"}</span>
                      {member.revoked_at ? <Badge variant="outline">removed</Badge> : (
                        <MutationDialog label="Remove" title="Remove organizational association?" description="The Nostr principal remains registered and keeps the same HAM memory policy." destructive disabled={pending !== null || !overview?.sessionFresh} onConfirm={() => void mutate({ action: "revokeMember", projectId: project.project_id, membershipId: member.membership_id }, "Organizational association removed; principal authority was unchanged.")} />
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle><h2 className="text-xl">Nostr principal inventory</h2></CardTitle>
            <CardDescription>Public keys are identities. Every active key can use the current tenant.</CardDescription>
          </CardHeader>
          <CardContent>
            {!principals.length ? <p className="text-sm text-muted-foreground">No Nostr principals are registered.</p> : null}
            <ul className="space-y-3">
              {principals.map((principal) => {
                const inactive = Boolean(principal.revoked_at) || isPrincipalExpired(principal.expires_at)
                return (
                  <li key={principal.pubkey} className="rounded-md border p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div><p className="font-medium">{principal.label || shortPubkey(principal.pubkey)}</p><code className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{principal.pubkey}</code><p className="text-xs text-muted-foreground">Expires {formatTime(principal.expires_at)}</p></div>
                      <div className="flex flex-wrap gap-2"><Badge variant="outline">tenant-wide</Badge>{inactive ? <Badge variant="outline">inactive</Badge> : null}</div>
                    </div>
                    {!inactive && principal.pubkey !== galaxyPubkey ? (
                      <div className="mt-3"><MutationDialog label="Revoke" title={`Revoke ${principal.label || shortPubkey(principal.pubkey)}?`} description="HAM will reject new proofs from this key. Hyades and GitHub remain separate." destructive disabled={pending !== null || !overview?.sessionFresh} onConfirm={() => void mutate({ action: "revokePrincipal", pubkey: principal.pubkey }, "HAM principal revoked.")} /></div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </CardContent>
        </Card>

        <Button asChild variant="outline"><Link href="/">Back to workspace</Link></Button>
      </div>
    </main>
  )
}
