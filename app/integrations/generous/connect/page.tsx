import { redirect } from "next/navigation"

export default async function LegacyGenerousConnectPage({
  searchParams,
}: {
  searchParams: Promise<{ callback?: string; state?: string }>
}) {
  const { callback, state } = await searchParams
  const query = new URLSearchParams()
  if (callback) query.set("callback", callback)
  if (state) query.set("state", state)
  redirect(`/connect?${query.toString()}`)
}
