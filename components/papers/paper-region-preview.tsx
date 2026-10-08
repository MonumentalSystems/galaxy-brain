"use client"

import { BoxSelect, MousePointer2, PenLine, Pin, PinOff } from "lucide-react"
import { useMemo, useState } from "react"

import { MechanismNeighborhood, type MechanismNeighborhoodItem } from "@/components/papers/mechanism-neighborhood"
import { PaperSelectionPalette } from "@/components/papers/paper-selection-palette"
import { PaperTimeRail, type PaperTimeEvent } from "@/components/papers/paper-time-rail"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { HudAction, HudDivider, HudStatus, HudToolbar } from "@/components/ui/hud-toolbar"
import { mechanismTag, normalizeMechanismTag, suggestMechanisms } from "@/lib/paper-mechanisms"

const papers = [
  ["BKT vortex unbinding", "arXiv · superconductors"],
  ["Kelvin–Helmholtz instabilities", "Nature · solar plasma"],
  ["Defects in active living matter", "Nature Physics · active matter"],
  ["Floquet topological insulator", "Nature Physics · condensed matter"],
  ["Exciton condensate defect states", "Nature Nanotechnology · quantum matter"],
  ["Wigner crystal polarons", "Nature Physics · 2D materials"],
]

const neighborhoodItems: MechanismNeighborhoodItem[] = [
  { id: "paper-bkt", kind: "paper", label: "BKT vortex unbinding", detail: "The origin paper measures the transition from bound vortex–antivortex pairs to free vortices.", relation: "contains" },
  { id: "evidence-region", kind: "evidence", label: "Boxed region · p.3", detail: "An immutable visual coordinate describing free-vortex proliferation above the transition.", relation: "supports" },
  { id: "claim-defect", kind: "claim", label: "Defect unbinding may transfer", detail: "A deliberately provisional cross-domain claim connecting topological defects in superconductors and active matter.", relation: "resembles", mechanismTag: "mechanism:defect-dynamics" },
  { id: "paper-kh", kind: "paper", label: "Solar plasma mixing", detail: "Kelvin–Helmholtz vortices connect circulation to an observable mixing mechanism without claiming identical physics.", relation: "context", mechanismTag: "mechanism:mixing" },
  { id: "task-enhance", kind: "task", label: "Challenge this transfer", detail: "A bounded task asks whether helicity is explanatory, merely correlated, or unsupported here.", relation: "task-from", mechanismTag: "mechanism:helicity" },
  { id: "mechanism-topology", kind: "mechanism", label: "Topological transition", detail: "A neighboring mechanism with its own evidence, papers, and tasks—not a decorative synonym.", relation: "contains", mechanismTag: "mechanism:topological-transition" },
]

const timelineEvents: PaperTimeEvent[] = [
  { id: "published", kind: "publication", label: "Paper published", detail: "The source enters the corpus as an external scholarly record.", date: "2024-04-09T00:00:00Z" },
  { id: "revision", kind: "revision", label: "Immutable revision v1", detail: "Galaxy records the metadata and source revision addressed by every coordinate.", date: "2024-04-10T00:00:00Z" },
  { id: "coordinate", kind: "coordinate", label: "Vortex region boxed", detail: "Page 3 coordinates become an atomic evidence object.", date: "2026-09-04T19:12:00Z" },
  { id: "claim", kind: "claim", label: "Cross-domain claim", detail: "The vortex-to-defect comparison becomes a separately versioned claim.", date: "2026-09-04T19:14:00Z" },
  { id: "task", kind: "task", label: "Enhance task branched", detail: "A bounded HAM task inherits the exact paper coordinate and research goal.", date: "2026-09-04T19:16:00Z" },
]

export function PaperRegionPreview({ initialMechanism }: { initialMechanism?: string }) {
  const [mode, setMode] = useState<"read" | "pen" | "box">("box")
  const [mechanisms, setMechanisms] = useState(["mechanism:vortex", "mechanism:topological-transition"])
  const [custom, setCustom] = useState("")
  const [note, setNote] = useState("")
  const [toolsPinned, setToolsPinned] = useState(false)
  const [status, setStatus] = useState("Preview data only — nothing here is saved.")
  const suggestions = useMemo(() => suggestMechanisms("BKT vortex unbinding transition helicity"), [])
  const activeMechanism = initialMechanism ? normalizeMechanismTag(initialMechanism) : ""

  function addMechanism() {
    const tag = mechanismTag(custom)
    if (tag && !mechanisms.includes(tag)) setMechanisms((current) => [...current, tag])
    setCustom("")
  }

  return (
    <main className="research-workbench min-h-screen p-4">
      <div className="mx-auto grid max-w-[1680px] gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="research-panel rounded-2xl border p-3">
          <div className="border-b border-[color:var(--research-line)] px-2 pb-4 pt-2">
            <p className="research-kicker">Research corpus</p>
            <h1 className="research-display mt-2 text-2xl font-bold">Vortices across matter</h1>
            <p className="research-muted mt-1 text-sm">6 references · 4 mechanism links</p>
          </div>
          <nav className="mt-3 space-y-1" aria-label="Preview paper library">
            {papers.map(([title, detail], index) => (
              <button key={title} className={`min-h-12 w-full rounded-xl px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2f6758] ${index === 0 ? "bg-[#dfeae4]" : "hover:bg-[#efede7]"}`}>
                <span className="research-display block text-base font-semibold">{title}</span>
                <span className="research-muted mt-0.5 block text-xs">{detail}</span>
              </button>
            ))}
          </nav>
        </aside>

        <section className="min-w-0 space-y-3">
          <header className="research-panel rounded-2xl border px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-4xl">
                <p className="research-kicker">Paper · immutable revision v1</p>
                <h2 className="research-display mt-2 text-2xl font-bold leading-tight">Probing the Berezinskii–Kosterlitz–Thouless vortex unbinding transition in two-dimensional superconductors</h2>
                <p className="research-muted mt-2 text-sm">Local noise magnetometry · arXiv:2404.06147v1</p>
                <div className="mt-3 flex flex-wrap gap-2"><Badge variant="outline">domain:cond-mat.supr-con</Badge><Badge variant="outline">domain:quant-ph</Badge></div>
              </div>
              <Button variant="outline" size="sm">Download “Probing the BKT….pdf”</Button>
            </div>
          </header>

          <HudToolbar label="Paper selection tools" pinned={toolsPinned}>
            <HudAction label="Read" icon={<MousePointer2 />} active={mode === "read"} onClick={() => setMode("read")} />
            <HudAction label="Pen" icon={<PenLine />} active={mode === "pen"} onClick={() => setMode("pen")} />
            <HudAction label="Box" icon={<BoxSelect />} active={mode === "box"} onClick={() => setMode("box")} />
            <HudDivider />
            <HudStatus>One gesture creates one atomic evidence coordinate.</HudStatus>
            <HudDivider />
            <HudAction label={toolsPinned ? "Unpin" : "Pin"} icon={toolsPinned ? <PinOff /> : <Pin />} active={toolsPinned} aria-pressed={toolsPinned} onClick={() => setToolsPinned((current) => !current)} />
          </HudToolbar>

          <PaperSelectionPalette
            pageNumber={3}
            selectionLabel="Boxed region: vortex–antivortex pairs become free above the transition."
            isTextSelection={false}
            mechanisms={mechanisms}
            suggestions={suggestions}
            customMechanism={custom}
            note={note}
            busy={false}
            mechanismBasePath="/dev/paper-region-preview"
            onClear={() => setStatus("Selection cleared in the real workbench.")}
            onToggleMechanism={(tag) => setMechanisms((current) => current.includes(tag) ? current.filter((value) => value !== tag) : [...current, tag])}
            onCustomMechanismChange={setCustom}
            onAddMechanism={() => addMechanism()}
            onNoteChange={setNote}
          />

          {activeMechanism && <MechanismNeighborhood mechanismTag={activeMechanism} items={neighborhoodItems} basePath="/dev/paper-region-preview" closeHref="/dev/paper-region-preview" />}

          <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_280px]">
            <article className="relative min-h-[700px] overflow-hidden rounded-2xl border border-[#c8c6bb] bg-[#fffef9] p-10 shadow-sm">
              <div className="research-prose mx-auto max-w-3xl text-[17px] leading-8 text-[#29332e]">
                <p className="research-display text-center text-2xl font-bold">Vortex unbinding across the BKT transition</p>
                <p className="research-smallcaps research-muted mt-2 text-center text-xs">Page 3 · Results</p>
                <div className="mt-8 columns-1 gap-10 md:columns-2">
                  <p>At low temperature, vortices and antivortices occur as bound pairs. Their far-field circulation cancels, preserving quasi-long-range order across the film.</p>
                  <p className="mt-4">As temperature approaches the transition, the effective interaction weakens and pairs separate over progressively larger length scales.</p>
                  <p className="mt-4">Above the transition, free vortices proliferate. Local magnetic noise provides a spatially resolved probe of the resulting dynamics.</p>
                  <p className="mt-4 italic">This mechanism suggests a bridge to defect unbinding in active matter and to vorticity-mediated mixing in plasma, while the evidential claims remain distinct.</p>
                </div>
              </div>
              <div className="pointer-events-none absolute left-[48%] top-[39%] h-[30%] w-[39%] rounded-sm border-2 border-[#d78b32] bg-[#f5c36c]/15 shadow-[0_0_0_9999px_rgba(31,44,38,0.025)]" />
              <div className="research-prose absolute right-3 top-[42%] rotate-2 rounded-lg border border-[#d78b32] bg-[#fff8e9] px-3 py-2 text-sm italic text-[#7b4c18] shadow-sm">vortex unbinding<br />↔ helicity?</div>
            </article>
            <aside className="space-y-3">
              <div role="status" className="research-panel research-prose rounded-2xl border p-4 text-sm">{status}</div>
              <details className="research-panel rounded-2xl border" open>
                <summary className="research-display cursor-pointer px-4 py-3 text-base font-semibold">Paper memory</summary>
                <div className="research-muted space-y-3 border-t border-[color:var(--research-line)] p-4 text-xs">
                  <p><strong className="text-[#17211d]">3</strong> coordinates</p><p><strong className="text-[#17211d]">2</strong> claims</p><p><strong className="text-[#17211d]">1</strong> linked HAM task</p>
                  <p>The dense proof map stays folded until you ask for it.</p>
                </div>
              </details>
            </aside>
          </div>

          <PaperTimeRail events={timelineEvents} onEventSelect={(event) => setStatus(`${event.label}: ${event.detail}`)} />
        </section>
      </div>
    </main>
  )
}
