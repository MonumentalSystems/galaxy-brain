"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useRef, useState } from "react"
import { BookOpen, FlaskConical, Layers3, Library, ListTodo, Network, Orbit, Search, Telescope } from "lucide-react"

import { AtlasHamMemoryBrowser } from "@/components/atlas/atlas-ham-memory-browser"

const GALAXY_LENSES = [
  { href: "/workspace", matchPath: "/workspace", label: "Desk", icon: Orbit },
  { href: "/field", matchPath: "/field", label: "Field", icon: Telescope },
  { href: "/graph", matchPath: "/graph", label: "Graph", icon: Network },
  { href: "/library", matchPath: "/library", label: "Library", icon: Library },
  { href: "/papers", matchPath: "/papers", label: "Papers", icon: BookOpen },
  { href: "/tasks", matchPath: "/tasks", label: "Tasks", icon: ListTodo },
  { href: "/eln", matchPath: "/eln", label: "ELN", icon: FlaskConical },
  { href: "/surfaces", matchPath: "/surfaces", label: "Surfaces", icon: Layers3 },
] as const

function lensIsActive(pathname: string, matchPath: string) {
  if (matchPath === "/workspace") return pathname === "/workspace" || pathname === "/atlas-v2"
  if (matchPath === "/field") return pathname === "/field" || pathname === "/dev/semantic-field-preview"
  return pathname === matchPath || pathname.startsWith(`${matchPath}/`)
}

export function GalaxyLensNav() {
  const pathname = usePathname()
  const [hamSearchOpen, setHamSearchOpen] = useState(false)
  const hamSearchTriggerRef = useRef<HTMLButtonElement>(null)

  return (
    <>
      <nav
        aria-label="Galaxy lenses"
        className="pointer-events-auto fixed inset-x-3 bottom-3 z-40 mx-auto flex w-fit max-w-[calc(100%-1.5rem)] items-center gap-1 overflow-x-auto overscroll-x-contain rounded-xl border border-[var(--research-line)] bg-[hsl(var(--research-panel)/0.95)] p-1.5 text-muted-foreground shadow-[0_18px_50px_-28px_hsl(var(--research-ink)/0.4)] backdrop-blur-xl"
        data-slot="galaxy-lens-nav"
      >
        <p className="sr-only">Move between projections of the same Galaxy knowledge</p>
        <button
          ref={hamSearchTriggerRef}
          type="button"
          aria-label="Search HAM memory"
          aria-haspopup="dialog"
          aria-expanded={hamSearchOpen}
          className="group flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg border border-[var(--research-line)] bg-secondary px-2.5 text-xs font-semibold text-foreground transition-[border-color,background-color,color] hover:bg-[hsl(var(--research-accent-soft))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none"
          title="Search HAM memory"
          onClick={() => setHamSearchOpen(true)}
        >
          <Search className="h-[1.1rem] w-[1.1rem] shrink-0" aria-hidden="true" />
          <span>HAM Search</span>
        </button>
        {GALAXY_LENSES.map(({ href, matchPath, label, icon: Icon }) => {
          const active = lensIsActive(pathname, matchPath)
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`group flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg border px-2.5 text-xs font-semibold transition-[border-color,background-color,color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none ${active ? "border-[var(--research-line)] bg-secondary text-foreground" : "border-transparent hover:border-[var(--research-line)] hover:bg-secondary hover:text-foreground"}`}
              title={`${label} lens`}
            >
              <Icon className="h-[1.1rem] w-[1.1rem] shrink-0" aria-hidden="true" />
              <span className="hidden md:inline">{label}</span>
            </Link>
          )
        })}
      </nav>
      <AtlasHamMemoryBrowser
        open={hamSearchOpen}
        onOpenChange={setHamSearchOpen}
        returnFocus={hamSearchTriggerRef.current}
      />
    </>
  )
}
