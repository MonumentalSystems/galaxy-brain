import { redirect } from "next/navigation"

import { atlasWorkspaceHref } from "@/lib/canvas/atlas-location.js"

type AtlasV2PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function AtlasV2Page({ searchParams }: AtlasV2PageProps) {
  redirect(atlasWorkspaceHref(await searchParams))
}
