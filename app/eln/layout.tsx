import type { ReactNode } from "react"

import { AuthShell } from "@/components/auth-shell"
import { requireUser } from "@/lib/auth"

export default async function ELNLayout({ children }: { children: ReactNode }) {
  const user = await requireUser()
  return <AuthShell user={user} ownsAccountMenu>{children}</AuthShell>
}
