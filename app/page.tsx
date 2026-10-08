import type { Metadata } from "next"

import { Footer } from "@/components/footer"
import { GbDataFlow } from "@/components/gb-data-flow"
import { GbEcosystem } from "@/components/gb-ecosystem"
import { GbFeatures } from "@/components/gb-features"
import { GbGetInvolved } from "@/components/gb-get-involved"
import { GbHero } from "@/components/gb-hero"
import { GbIntro } from "@/components/gb-intro"
import { GbStatus } from "@/components/gb-status"

export const metadata: Metadata = {
  title: "Galaxy Brain - A research workspace from Monumental Systems",
  description:
    "A research workspace for people and agents: an infinite canvas joined to an electronic lab notebook. Hosted private workspaces or self-hosted. Invite-only alpha.",
  metadataBase: new URL("https://galaxybrain.info"),
  openGraph: {
    title: "Galaxy Brain - The universal mind",
    description:
      "A research workspace from Monumental Systems, hosted or self-hosted, where people and agents collect material, inspect evidence, and keep the record of how the work was done.",
    url: "https://galaxybrain.info",
    siteName: "Galaxy Brain",
    type: "website",
  },
}

export default function Home() {
  return (
    <div className="landing-page">
      <main>
        <GbHero />
        <GbIntro />
        <GbFeatures />
        <GbDataFlow />
        <GbStatus />
        <GbEcosystem />
        <GbGetInvolved />
      </main>
      <Footer />
    </div>
  )
}
