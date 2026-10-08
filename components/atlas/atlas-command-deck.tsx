"use client"

import { Wrench } from "lucide-react"

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  getAtlasCommandSearchValue,
  type AtlasCommand,
} from "@/lib/plugins/atlas-commands.js"

export type AtlasCommandDeckProps = {
  commands: AtlasCommand[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (commandId: string) => void
  returnFocus: HTMLElement | null
}

type AtlasCommandGroup = {
  plugin: AtlasCommand["plugin"]
  commands: AtlasCommand[]
}

function groupCommandsByPlugin(commands: AtlasCommand[]): AtlasCommandGroup[] {
  const groups = new Map<string, AtlasCommandGroup>()
  for (const command of commands) {
    const existing = groups.get(command.plugin.id)
    if (existing) {
      existing.commands.push(command)
      continue
    }
    groups.set(command.plugin.id, { plugin: command.plugin, commands: [command] })
  }
  return [...groups.values()].sort((left, right) => (
    left.plugin.id < right.plugin.id ? -1 : left.plugin.id > right.plugin.id ? 1 : 0
  ))
}

export function AtlasCommandDeck({ commands, open, onOpenChange, onSelect, returnFocus }: AtlasCommandDeckProps) {
  const commandGroups = groupCommandsByPlugin(commands)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[calc(100dvh-1rem)] max-w-[min(94vw,620px)] flex-col gap-0 overflow-hidden p-0"
        onEscapeKeyDown={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          if (!returnFocus?.isConnected) return
          event.preventDefault()
          returnFocus.focus()
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Atlas commands</DialogTitle>
          <DialogDescription>
            Search capabilities registered by code-owned Galaxy plugin manifests.
          </DialogDescription>
        </DialogHeader>
        <Command className="min-h-0 flex-1" label="Atlas commands">
          <div className="border-b border-border/70 px-4 py-3 pr-12">
            <p className="font-semibold text-foreground">Registered capabilities</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              These labels describe bundled code, not connector configuration or service health.
            </p>
          </div>
          <CommandInput aria-label="Search Atlas commands" placeholder="Find a command…" />
          <CommandList className="min-h-0 flex-1 max-h-[min(64dvh,520px)] p-2">
            <CommandEmpty>No matching commands.</CommandEmpty>
            {commandGroups.map((group) => (
              <CommandGroup
                key={group.plugin.id}
                heading={(
                  <span className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <span className="truncate">{group.plugin.displayName}</span>
                    <span className="font-mono text-[10px] font-normal normal-case tracking-normal text-muted-foreground">
                      {group.plugin.id} · v{group.plugin.version}
                    </span>
                  </span>
                )}
              >
                {group.commands.map((command) => (
                  <CommandItem
                    key={command.id}
                    value={getAtlasCommandSearchValue(command)}
                    disabled={!command.enabled}
                    className="min-h-14 items-start rounded-lg px-3 py-3"
                    onSelect={() => onSelect(command.id)}
                  >
                    <Wrench className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="break-words font-semibold">{command.title}</span>
                      <span className="break-words text-xs text-muted-foreground">{command.description}</span>
                      {command.unavailableReason ? (
                        <span className="break-words text-xs font-medium text-foreground">
                          Unavailable: {command.unavailableReason}
                        </span>
                      ) : null}
                      <span className="break-all font-mono text-[10px] text-muted-foreground">
                        {command.id}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
