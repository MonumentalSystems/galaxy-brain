"use client"

import Link from "next/link"
import { useActionState } from "react"

import { requestPasswordResetAction } from "@/app/auth/actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function PasswordRecoveryForm({ recoveryContact }: { recoveryContact: string | null }) {
  const [state, formAction, pending] = useActionState(requestPasswordResetAction, undefined)

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-md items-center px-6">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Reset your password</CardTitle>
            <CardDescription>We will send a short-lived reset link to the workspace owner email.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form action={formAction} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" autoComplete="email" required />
              </div>
              {state?.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
              {state?.message && (
                <div className="space-y-2 rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
                  <p>{state.message}</p>
                  {state.emailConfigured === false && (
                    <p>
                      {recoveryContact ? `Contact ${recoveryContact} for a one-time reset link.` : "Ask the server administrator to issue a one-time reset link."}
                    </p>
                  )}
                </div>
              )}
              <Button className="w-full" type="submit" disabled={pending}>
                {pending ? "Requesting..." : "Send reset link"}
              </Button>
            </form>
            <p className="text-center text-sm">
              <Link className="font-medium text-primary hover:underline" href="/login">Return to sign in</Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
