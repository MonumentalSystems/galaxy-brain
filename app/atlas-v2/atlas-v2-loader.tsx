"use client"

import dynamic from "next/dynamic"
import type { ReactNode } from "react"

const AtlasV2Client = dynamic(
  () => import("./atlas-v2-client").then((module) => module.AtlasV2Client),
  {
    ssr: false,
    loading: () => (
      <main className="flex min-h-screen items-center justify-center bg-[#dfe9e0] px-6 text-[#315f49]">
        <div className="rounded-2xl border border-[#315f49]/20 bg-[#fffef9]/95 px-8 py-7 shadow-sm">
          <p className="research-kicker">Authorized atlas</p>
          <p className="research-display mt-2 text-2xl font-semibold">Loading the spatial client…</p>
        </div>
      </main>
    ),
  },
)

export type AtlasV2LoaderProps = {
  tenantId: string
  principalId: string
  headerSlot?: ReactNode
}

export function AtlasV2Loader({ tenantId, principalId, headerSlot }: AtlasV2LoaderProps) {
  const authorizationScope = JSON.stringify([tenantId, principalId])
  return (
    <AtlasV2Client
      key={authorizationScope}
      tenantId={tenantId}
      principalId={principalId}
      headerSlot={headerSlot}
    />
  )
}

/** canvas-harness hooks do not expose a server snapshot in v0.2.0. */
