"use client"

import { CalendarClock, Minus, Plus } from "lucide-react"
import { useMemo, useState } from "react"

import { cn } from "@/lib/utils"

export type PaperTimeEvent = {
  id: string
  label: string
  detail: string
  date: string
  kind: "publication" | "revision" | "coordinate" | "claim" | "task"
}

export type PaperTimeRailProps = React.ComponentProps<"section"> & {
  events: PaperTimeEvent[]
  onEventSelect?: (event: PaperTimeEvent) => void
}

const overviewKinds = new Set<PaperTimeEvent["kind"]>(["publication", "revision", "task"])
const dateFormatter = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })

export function PaperTimeRail({ events, onEventSelect, className, ...props }: PaperTimeRailProps) {
  const [detail, setDetail] = useState(false)
  const ordered = useMemo(
    () => [...events].sort((a, b) => Date.parse(a.date) - Date.parse(b.date)),
    [events],
  )
  const visible = detail ? ordered : ordered.filter((event) => overviewKinds.has(event.kind))

  return (
    <section
      data-slot="paper-time-rail"
      data-zoom={detail ? "detail" : "overview"}
      className={cn("research-panel rounded-[1.4rem] border p-4", className)}
      aria-labelledby="paper-time-rail-title"
      {...props}
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="research-kicker">Temporal lens</p>
          <h2 id="paper-time-rail-title" className="research-display mt-1 flex items-center gap-2 text-lg font-semibold">
            <CalendarClock aria-hidden="true" className="h-4 w-4" /> Research history
          </h2>
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Timeline detail">
          <button
            type="button"
            className="research-control flex h-11 w-11 items-center justify-center rounded-full"
            aria-label="Show overview"
            aria-pressed={!detail}
            onClick={() => setDetail(false)}
          ><Minus aria-hidden="true" className="h-4 w-4" /></button>
          <span className="research-smallcaps min-w-20 text-center text-[11px]">{detail ? "Close detail" : "Long view"}</span>
          <button
            type="button"
            className="research-control flex h-11 w-11 items-center justify-center rounded-full"
            aria-label="Show detailed events"
            aria-pressed={detail}
            onClick={() => setDetail(true)}
          ><Plus aria-hidden="true" className="h-4 w-4" /></button>
        </div>
      </header>

      <div className="mt-4 overflow-x-auto pb-2">
        <ol className="research-timeline relative grid min-w-[720px] auto-cols-[minmax(132px,1fr)] grid-flow-col gap-2 pt-7" aria-label="Paper and research events">
          {visible.map((event, index) => (
            <li key={event.id} className={cn("relative", index % 2 ? "mt-10" : "") }>
              <span className="research-timeline-tick absolute -top-7 left-4 h-7 w-px" aria-hidden="true" />
              <button
                type="button"
                data-kind={event.kind}
                className="research-time-box min-h-20 w-full rounded-xl p-3 text-left"
                onClick={() => onEventSelect?.(event)}
              >
                <span className="research-smallcaps block text-[10px]">{event.kind}</span>
                <span className="mt-1 block text-sm font-semibold leading-tight">{event.label}</span>
                <time className="research-muted mt-2 block text-[11px]" dateTime={event.date}>{dateFormatter.format(new Date(event.date))}</time>
                {detail && <span className="research-muted mt-2 block text-xs leading-5">{event.detail}</span>}
              </button>
            </li>
          ))}
        </ol>
      </div>
      <p className="research-muted mt-2 text-xs" role="status">{visible.length} of {ordered.length} events visible · zoom changes temporal granularity, not the underlying objects.</p>
    </section>
  )
}
