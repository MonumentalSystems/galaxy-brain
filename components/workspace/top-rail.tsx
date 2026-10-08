"use client"

import type { ReactNode } from "react"
import { Settings } from "lucide-react"

import { ThemeToggle } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"

type TopRailProps = {
  /** Leading slot: the surface's own name, or a menu that opens onto it. */
  lead: ReactNode
  /** The surface's own controls, laid out after the lead. */
  children?: ReactNode
  /** Trailing controls a surface adds ahead of the shared ones. */
  actions?: ReactNode
  /** The account control, rendered by the page because it needs a server action. */
  accountMenu?: ReactNode
  onOpenSettings?: () => void
}

/*
  Every surface used to invent its own chrome: the desk had a rail, Papers and
  Views carried headers inside their components, Tasks hand-rolled a back
  button, and the account chip floated over all of them. This owns the parts
  that are the same everywhere — where the name sits, where the theme switch,
  settings and account sit — so a surface only supplies what is actually its
  own, and none of them has to reserve space around a floating element.

  The trailing controls share one flex row with the shared ones rather than
  nesting, so a surface's last control and the theme switch keep the same gap
  as everything else on the bar.
*/
export function TopRail({ lead, children, actions, accountMenu, onOpenSettings }: TopRailProps) {
  return (
    <div
      data-slot="top-rail"
      className="mb-3 flex min-h-[3.5rem] items-center gap-2 overflow-x-auto rounded-[1.5rem] border border-[var(--research-line)] bg-[hsl(var(--research-panel))] px-3 py-2 shadow-[0_1px_2px_hsl(var(--galaxy-shadow)/0.06)]"
    >
      {lead}
      {children}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {actions}
        <ThemeToggle />
        {onOpenSettings && (
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 shrink-0 border-[var(--research-line)] bg-[hsl(var(--research-panel))] hover:bg-[hsl(var(--research-accent-soft))]"
            aria-label="Settings"
            title="Settings"
            onClick={onOpenSettings}
          >
            <Settings className="h-4 w-4" />
          </Button>
        )}
        {accountMenu}
      </div>
    </div>
  )
}

/*
  The name a surface shows when it has nothing to open onto — the desk swaps
  this for a menu button, so the two read the same at rest.
*/
export function TopRailTitle({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      className="font-display max-w-[14rem] shrink-0 truncate px-2 text-lg font-semibold text-foreground"
      title={title}
    >
      {children}
    </span>
  )
}
