"use client"

import { useMemo, useState, type ReactNode } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { BookOpenText, Boxes, FileText, FlaskConical, Plus, Scale } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TopRail, TopRailTitle } from "@/components/workspace/top-rail"
import { ExperimentBrowser } from "./experiment-browser"
import { HypothesisTracker } from "./hypothesis-tracker"
import { NewExperimentDialog } from "./new-experiment-dialog"

type NotebookSection = "experiments" | "hypotheses"

const notebookSections = new Set<NotebookSection>(["experiments", "hypotheses"])

export function ELNDashboard({
  tenantId,
  principalId,
  accountMenu,
}: {
  tenantId: string
  principalId: string
  accountMenu?: ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [newExpOpen, setNewExpOpen] = useState(false)
  const [expRefreshKey, setExpRefreshKey] = useState(0)
  const experimentRecoveryScope = useMemo(
    () => ({ tenantId, principalId }),
    [principalId, tenantId],
  )
  const requestedSection = searchParams.get("section") as NotebookSection | null
  const section = requestedSection && notebookSections.has(requestedSection)
    ? requestedSection
    : "experiments"

  const changeSection = (nextSection: string) => {
    const next = new URLSearchParams(searchParams.toString())
    if (nextSection === "experiments") next.delete("section")
    else next.set("section", nextSection)
    const query = next.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  return (
    <main className="research-workbench min-h-screen pb-28 md:pb-12">
      <div className="p-3">
        <TopRail lead={<TopRailTitle>ELN</TopRailTitle>} accountMenu={accountMenu} />
      </div>
      {/* The top padding used to hold space for a chip that floated here. */}
      <div className="mx-auto max-w-[1500px] px-4 pb-12 pt-4 sm:px-7 lg:px-10">
        <header className="border-b border-[var(--research-line)] pb-7">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_26rem] lg:items-end">
            <div className="min-w-0">
              <p className="research-kicker flex items-center gap-2">
                <FlaskConical className="h-4 w-4" aria-hidden="true" />
                Galaxy Brain · Living Research Atlas
              </p>
              <h1 className="research-display mt-3 max-w-4xl text-4xl font-semibold leading-[1.02] text-foreground sm:text-5xl">
                Electronic Lab Notebook
              </h1>
              <p className="research-prose mt-3 max-w-3xl text-lg leading-7 text-muted-foreground">
                Inquiry becomes a durable research record. Move from atlas to source without losing identity, evidence, or provenance.
              </p>
              <Button
                onClick={() => setNewExpOpen(true)}
                className="mt-6 min-h-11 rounded-lg border border-primary bg-primary px-4 text-primary-foreground shadow-none hover:bg-primary/90"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                New Research Record
              </Button>
            </div>

            <div className="border-y border-[var(--research-line)] py-4">
              <div className="flex items-center justify-between gap-4">
                <p className="research-smallcaps text-xs text-muted-foreground">Scale of Observation <span className="font-normal normal-case tracking-normal">· for reference</span></p>
                <Scale className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              </div>
              <div className="mt-4 grid cursor-default select-none grid-cols-4 text-center text-[11px] text-muted-foreground" role="list" aria-label="Semantic zoom progression, for reference">
                {[
                  ["○", "Atlas"],
                  ["▱", "Board"],
                  ["¶", "Record"],
                  ["□", "Source"],
                ].map(([symbol, label], index) => (
                  <div key={label} role="listitem" className="relative border-t border-[var(--research-line)] pt-3">
                    <span className="absolute left-1/2 top-0 h-2 w-px -translate-x-1/2 -translate-y-1/2 bg-primary" aria-hidden="true" />
                    <span className="research-display block text-xl text-foreground" aria-hidden="true">{symbol}</span>
                    <span className="mt-1 block">{label}</span>
                    <span className="sr-only">Scale {index + 1} of 4</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </header>

        <section className="mt-7 grid gap-px overflow-hidden rounded-2xl border border-[var(--research-line)] bg-[var(--research-line)] md:grid-cols-3" aria-label="Notebook principles">
          <NotebookPrinciple icon={BookOpenText} label="Durable Record" copy="The same inquiry remains addressable across every representation." />
          <NotebookPrinciple icon={Boxes} label="Evidence in Context" copy="References, artifacts, and branches stay distinct and traceable." />
          <NotebookPrinciple icon={FileText} label="Agent-Readable" copy="Structured data and portable Markdown are projections of one object." />
        </section>

        <Tabs value={section} onValueChange={changeSection} className="mt-9">
          <div className="flex flex-col gap-4 border-b border-[var(--research-line)] pb-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="research-kicker">Research Index</p>
              <h2 className="research-display mt-1 text-3xl font-semibold text-foreground">Browse the Lab</h2>
            </div>
            <TabsList className="grid h-auto grid-cols-2 rounded-lg border border-[var(--research-line)] bg-[hsl(var(--research-panel)/0.8)] p-1">
              <TabsTrigger
                value="experiments"
                className="min-h-11 rounded-md px-4 text-muted-foreground data-[state=active]:bg-secondary data-[state=active]:text-foreground data-[state=active]:shadow-none"
              >
                Research Records
              </TabsTrigger>
              <TabsTrigger
                value="hypotheses"
                className="min-h-11 rounded-md px-4 text-muted-foreground data-[state=active]:bg-secondary data-[state=active]:text-foreground data-[state=active]:shadow-none"
              >
                Hypotheses
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="experiments" className="mt-5">
            <ExperimentBrowser refreshKey={expRefreshKey} onCreate={() => setNewExpOpen(true)} />
          </TabsContent>

          <TabsContent value="hypotheses" className="mt-5">
            <div className="research-panel rounded-xl border p-4 sm:p-6">
              <HypothesisTracker />
            </div>
          </TabsContent>
        </Tabs>

        <footer className="mt-10 flex flex-col gap-2 border-t border-[var(--research-line)] pt-4 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p className="research-prose italic">Quiet structure. Infinite surface. Living knowledge.</p>
          <p className="font-mono text-[10px] uppercase tracking-[0.08em]">ELN · versioned · auditable · reproducible</p>
        </footer>
      </div>

      <NewExperimentDialog
        open={newExpOpen}
        onOpenChange={setNewExpOpen}
        onCreated={() => setExpRefreshKey((key) => key + 1)}
        recoveryScope={experimentRecoveryScope}
      />
    </main>
  )
}

function NotebookPrinciple({
  icon: Icon,
  label,
  copy,
}: {
  icon: typeof BookOpenText
  label: string
  copy: string
}) {
  return (
    <div className="bg-secondary p-5">
      <div className="flex items-center gap-2 text-primary">
        <Icon className="h-4 w-4" aria-hidden="true" />
        <h2 className="research-smallcaps text-xs">{label}</h2>
      </div>
      <p className="research-prose mt-2 text-sm leading-6 text-muted-foreground">{copy}</p>
    </div>
  )
}
