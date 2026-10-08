"use client"

import Link from "next/link"
import { useActionState } from "react"

import { resetPasswordAction } from "@/app/auth/actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(resetPasswordAction, undefined)
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-md items-center px-6">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Choose a new password</CardTitle>
            <CardDescription>The link can be used once and expires after 30 minutes.</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={formAction} className="space-y-4">
              <input type="hidden" name="token" value={token} />
              <div className="space-y-2">
                <Label htmlFor="password">New password</Label>
                <Input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="passwordConfirmation">Confirm password</Label>
                <Input id="passwordConfirmation" name="passwordConfirmation" type="password" autoComplete="new-password" minLength={10} required />
              </div>
              {state?.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
              <Button className="w-full" type="submit" disabled={pending || !token}>
                {pending ? "Resetting..." : "Reset password"}
              </Button>
              {!token && <p className="text-sm text-destructive">This reset link is incomplete.</p>}
            </form>
            <p className="mt-4 text-center text-sm">
              <Link className="font-medium text-primary hover:underline" href="/forgot-password">Request another link</Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
