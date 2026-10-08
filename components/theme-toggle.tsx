"use client"

import { useEffect, useState } from "react"
import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"

/*
  A labelled button stated the mode you would get, which reads as an action and
  costs a whole button of rail width. A switch shows both icons at once and the
  knob says which one you are in, so the control is its own legend.
*/
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const isDark = mounted && resolvedTheme === "dark"

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label="Dark mode"
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="relative inline-flex min-h-11 w-[4.75rem] shrink-0 items-center rounded-full border border-[var(--research-line)] bg-[hsl(var(--research-panel)/0.84)] px-1 shadow-sm backdrop-blur transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {/* The knob sits under the icons so both stay legible as it slides. */}
      <span
        aria-hidden="true"
        className={`absolute left-1 top-1 h-9 w-9 rounded-full bg-primary shadow transition-transform duration-200 motion-reduce:transition-none ${isDark ? "translate-x-8" : "translate-x-0"}`}
      />
      <span className="absolute left-1 z-10 grid h-9 w-9 place-items-center">
        <Sun className={`h-4 w-4 transition-colors ${isDark ? "text-muted-foreground" : "text-primary-foreground"}`} aria-hidden="true" />
      </span>
      <span className="absolute right-1 z-10 grid h-9 w-9 place-items-center">
        <Moon className={`h-4 w-4 transition-colors ${isDark ? "text-primary-foreground" : "text-muted-foreground"}`} aria-hidden="true" />
      </span>
    </button>
  )
}
