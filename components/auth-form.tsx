"use client"

import Link from "next/link"
import { useActionState } from "react"
import { KeyRound, Radio } from "lucide-react"

import { loginAction, registerAction } from "@/app/auth/actions"
import { AlternativeSignIn } from "@/components/alternative-sign-in"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type AuthFormProps = {
  mode: "login" | "register"
  requireInviteCode?: boolean
  registrationClosed?: boolean
  recoveryContact?: string | null
  returnTo?: string
  nostrOnly?: boolean
}

export function AuthForm({
  mode,
  requireInviteCode = false,
  registrationClosed = false,
  recoveryContact = null,
  returnTo = "/workspace",
  nostrOnly = false,
}: AuthFormProps) {
  const action = mode === "login" ? loginAction : registerAction
  const [state, formAction, pending] = useActionState(action, undefined)
  const isLogin = mode === "login"

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-md items-center px-6">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>{isLogin ? "Sign in" : "Create your account"}</CardTitle>
            <CardDescription>
              {isLogin ? "Use your Nostr identity to access the same account across Galaxy Brain, HAM, and Hyades." : "Create the first self-hosted workspace user."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLogin && (
              <>
                <AlternativeSignIn
                  passkeyIcon={<KeyRound aria-hidden="true" />}
                  nostrIcon={<Radio aria-hidden="true" />}
                  returnTo={returnTo}
                  nostrOnly={nostrOnly}
                />
                {!nostrOnly && <div className="my-5 flex items-center gap-3" aria-hidden="true">
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-xs text-muted-foreground">or use recovery sign-in</span>
                  <div className="h-px flex-1 bg-border" />
                </div>}
              </>
            )}

            {nostrOnly ? null : registrationClosed ? (
              <div className="space-y-4 text-sm text-muted-foreground">
                <p>
                  Public registration is closed. Ask the original owner for a one-time personal workspace invitation.
                </p>
                <p>
                  {recoveryContact ? (
                    <>
                      Contact the workspace administrator at{" "}
                      <a className="font-medium text-primary hover:underline" href={recoveryContact.includes("@") ? `mailto:${recoveryContact}` : recoveryContact}>
                        {recoveryContact}
                      </a>
                      .
                    </>
                  ) : (
                    "Contact the person who operates this Galaxy Brain for an invitation."
                  )}
                </p>
                <Button asChild className="w-full">
                  <Link href="/login">Return to sign in</Link>
                </Button>
              </div>
            ) : (
            <form action={formAction} className="space-y-4">
              {!isLogin && (
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" name="name" autoComplete="name" />
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" autoComplete="email" required />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete={isLogin ? "current-password" : "new-password"}
                  minLength={isLogin ? undefined : 10}
                  required
                />
              </div>

              {!isLogin && requireInviteCode && (
                <div className="space-y-2">
                  <Label htmlFor="inviteCode">Invite code</Label>
                  <Input id="inviteCode" name="inviteCode" type="password" required />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    The administrator who runs this self-hosted workspace provides the code for its first owner.
                    {recoveryContact ? ` Contact: ${recoveryContact}` : " Ask the workspace administrator directly."}
                  </p>
                </div>
              )}

              {state?.error && (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {state.error}
                </p>
              )}

              <Button className="w-full" type="submit" disabled={pending}>
                {pending ? "Working..." : isLogin ? "Sign in" : "Create account"}
              </Button>
            </form>
            )}

            {!nostrOnly && !registrationClosed && <p className="mt-4 text-center text-sm text-muted-foreground">
              {isLogin ? "Need an account?" : "Already have an account?"}{" "}
              <Link className="font-medium text-primary hover:underline" href={isLogin ? "/register" : "/login"}>
                {isLogin ? "Register" : "Sign in"}
              </Link>
            </p>}
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
