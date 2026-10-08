"use client"

import * as React from "react"

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export type HudToolbarProps = Omit<React.ComponentProps<"div">, "aria-label"> & {
  label: string
  pinned?: boolean
}

export const HudToolbar = React.forwardRef<HTMLDivElement, HudToolbarProps>(
  ({ label, pinned = false, className, children, onKeyDown, ...props }, ref) => {
    function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
      onKeyDown?.(event)
      if (event.defaultPrevented || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]")]
      if (!controls.length) return
      const current = controls.indexOf(document.activeElement as HTMLElement)
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? controls.length - 1
          : event.key === "ArrowRight"
            ? (current + 1 + controls.length) % controls.length
            : (current - 1 + controls.length) % controls.length
      event.preventDefault()
      controls[next]?.focus()
    }

    return (
      <TooltipProvider delayDuration={350}>
        <div
          ref={ref}
          data-slot="hud-toolbar"
          data-pinned={pinned ? "true" : "false"}
          role="toolbar"
          aria-label={label}
          className={cn("hud-toolbar", pinned && "hud-toolbar-pinned", className)}
          onKeyDown={handleKeyDown}
          {...props}
        >
          {children}
        </div>
      </TooltipProvider>
    )
  },
)
HudToolbar.displayName = "HudToolbar"

export type HudActionProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  icon: React.ReactNode
  active?: boolean
  tone?: "default" | "primary" | "quiet"
}

export const HudAction = React.forwardRef<HTMLButtonElement, HudActionProps>(
  ({ label, icon, active = false, tone = "default", className, type = "button", ...props }, ref) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={ref}
          type={type}
          data-slot="hud-action"
          data-state={active ? "active" : "inactive"}
          data-tone={tone}
          aria-label={props["aria-label"] ?? label}
          aria-pressed={props["aria-pressed"] ?? (active || undefined)}
          className={cn("hud-action", className)}
          {...props}
        >
          <span className="hud-action-icon" aria-hidden="true">{icon}</span>
          <span className="hud-action-label" aria-hidden="true">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">{label}</TooltipContent>
    </Tooltip>
  ),
)
HudAction.displayName = "HudAction"

export type HudLinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  label: string
  icon: React.ReactNode
  tone?: "default" | "primary" | "quiet"
}

export const HudLink = React.forwardRef<HTMLAnchorElement, HudLinkProps>(
  ({ label, icon, tone = "default", className, ...props }, ref) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          ref={ref}
          data-slot="hud-action"
          data-state="inactive"
          data-tone={tone}
          aria-label={props["aria-label"] ?? label}
          className={cn("hud-action", className)}
          {...props}
        >
          <span className="hud-action-icon" aria-hidden="true">{icon}</span>
          <span className="hud-action-label" aria-hidden="true">{label}</span>
        </a>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">{label}</TooltipContent>
    </Tooltip>
  ),
)
HudLink.displayName = "HudLink"

export function HudDivider({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="hud-divider" aria-hidden="true" className={cn("hud-divider", className)} {...props} />
}

export function HudStatus({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="hud-status" className={cn("hud-status", className)} {...props} />
}
