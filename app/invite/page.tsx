import { redirect } from "next/navigation"

import { InvitePasskeyForm } from "@/components/invite-passkey-form"
import { getCurrentUser } from "@/lib/auth"

export default async function InvitePage() {
  if (await getCurrentUser()) redirect("/workspace")
  return <InvitePasskeyForm />
}
