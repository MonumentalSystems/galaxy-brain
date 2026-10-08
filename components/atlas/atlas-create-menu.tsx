"use client"

import { Plus } from "lucide-react"
import { forwardRef } from "react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { HudAction } from "@/components/ui/hud-toolbar"
import type { AtlasCommand } from "@/lib/plugins/atlas-commands.js"

export type AtlasCreateMenuProps = Readonly<{
  commands: AtlasCommand[]
  onSelect: (command: AtlasCommand) => void
}>

export const AtlasCreateMenu = forwardRef<HTMLButtonElement, AtlasCreateMenuProps>(
  function AtlasCreateMenu({ commands, onSelect }, ref) {
    if (commands.length === 0) return null

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <HudAction ref={ref} label="Create" icon={<Plus />} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="bottom"
          sideOffset={8}
          collisionPadding={12}
          className="max-h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-80 overflow-y-auto p-2"
        >
          <DropdownMenuLabel className="research-kicker px-2 py-1.5">Create on this Atlas</DropdownMenuLabel>
          {/*
            An unavailable tool is shown disabled with its reason rather than
            removed: a toolbar that empties itself reads as broken, and the
            command already carries the sentence explaining what is missing.
          */}
          {commands.map((command) => (
            <DropdownMenuItem
              key={command.id}
              className="min-h-11 items-start whitespace-normal px-3 py-2"
              disabled={!command.enabled}
              onSelect={() => { if (command.enabled) onSelect(command) }}
            >
              <span className="min-w-0">
                <span className="block break-words font-medium">{command.title}</span>
                <span className="research-muted mt-0.5 block break-words text-xs">
                  {!command.enabled && command.unavailableReason
                    ? command.unavailableReason
                    : command.description}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  },
)
