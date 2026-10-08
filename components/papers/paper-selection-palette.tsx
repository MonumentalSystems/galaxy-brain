"use client"

import { ArrowUpRight, ChevronDown, Link2 } from "lucide-react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { mechanismHref, mechanismLabel, mechanismTag, type MechanismSuggestion } from "@/lib/paper-mechanisms"

export type PaperSelectionPaletteProps = {
  pageNumber: number
  selectionLabel: string
  isTextSelection: boolean
  mechanisms: string[]
  suggestions: MechanismSuggestion[]
  customMechanism: string
  note: string
  busy: boolean
  mechanismBasePath?: string
  onClear: () => void
  onToggleMechanism: (tag: string) => void
  onCustomMechanismChange: (value: string) => void
  onAddMechanism: (value: string) => void
  onNoteChange: (value: string) => void
}

export function PaperSelectionPalette({
  pageNumber,
  selectionLabel,
  isTextSelection,
  mechanisms,
  suggestions,
  customMechanism,
  note,
  busy,
  mechanismBasePath = "/papers",
  onClear,
  onToggleMechanism,
  onCustomMechanismChange,
  onAddMechanism,
  onNoteChange,
}: PaperSelectionPaletteProps) {
  const suggestedTags = new Set(suggestions.map((item) => mechanismTag(item.id)))

  return (
    <Card data-slot="paper-selection-palette" className="selection-hud-card border-primary/50 bg-primary/[0.025] shadow-sm">
      <CardContent className="space-y-4 p-4">
        <div>
          <p className="research-smallcaps text-xs text-muted-foreground">Selected coordinate · page {pageNumber}</p>
          <p className="research-prose mt-1 max-w-4xl text-sm">{selectionLabel}</p>
        </div>

        <details open className="selection-hud-context rounded-xl border border-primary/15 bg-background/70 px-3 py-2">
          <summary className="research-smallcaps flex min-h-9 cursor-pointer list-none items-center gap-2 text-xs text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronDown aria-hidden="true" className="h-4 w-4" />
            Context · mechanisms, note, links
          </summary>
          <div className="space-y-4 pb-2 pt-3">
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Mechanism links</p>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((item) => {
                  const tag = mechanismTag(item.id)
                  const active = mechanisms.includes(tag)
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={active}
                      className={`min-h-8 rounded-full border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? "border-primary bg-primary text-primary-foreground" : "hover:border-primary/60 hover:bg-muted"}`}
                      onClick={() => onToggleMechanism(tag)}
                    >
                      {item.label}
                    </button>
                  )
                })}
                {mechanisms.filter((tag) => !suggestedTags.has(tag)).map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="min-h-8 rounded-full border border-primary bg-primary px-3 text-xs text-primary-foreground"
                    onClick={() => onToggleMechanism(tag)}
                    aria-label={`Remove ${mechanismLabel(tag)} mechanism`}
                  >
                    {mechanismLabel(tag)} ×
                  </button>
                ))}
              </div>
              <form className="mt-2 flex max-w-md gap-2" onSubmit={(event) => { event.preventDefault(); onAddMechanism(customMechanism) }}>
                <Label htmlFor="custom-mechanism" className="sr-only">Add a mechanism</Label>
                <Input id="custom-mechanism" value={customMechanism} onChange={(event) => onCustomMechanismChange(event.target.value)} placeholder="Add mechanism, e.g. helicity" maxLength={68} />
                <Button type="submit" size="sm" variant="outline" disabled={!customMechanism.trim()}><Link2 className="mr-1 h-3.5 w-3.5" />Link</Button>
              </form>
              {mechanisms.length > 0 && (
                <nav className="mt-3 flex flex-wrap gap-2" aria-label="Explore selected mechanisms">
                  {mechanisms.map((tag) => (
                    <Link
                      key={tag}
                      href={mechanismHref(tag, mechanismBasePath)}
                      className="research-smallcaps inline-flex min-h-11 items-center gap-1 rounded-full border border-primary/25 bg-background px-3 text-[11px] text-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {mechanismLabel(tag)} <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
                    </Link>
                  ))}
                </nav>
              )}
            </div>
            <Textarea value={note} maxLength={20_000} onChange={(event) => onNoteChange(event.target.value)} placeholder={isTextSelection ? "Optional note or interpretation" : "Describe what matters in this visual region"} aria-label="Selection note" />
          </div>
        </details>
      </CardContent>
    </Card>
  )
}
