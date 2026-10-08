"use client"

import Link from "next/link"
import { ArrowLeft, FileText, GitFork, Link2, ListTodo, Orbit, Quote } from "lucide-react"
import { useMemo, useState } from "react"

import { mechanismHref, mechanismId, mechanismLabel } from "@/lib/paper-mechanisms"
import { cn } from "@/lib/utils"

export type MechanismNeighborhoodItem = {
  id: string
  kind: "paper" | "claim" | "evidence" | "task" | "mechanism"
  label: string
  detail: string
  relation: "contains" | "supports" | "challenges" | "context" | "resembles" | "task-from"
  mechanismTag?: string
}

export type MechanismNeighborhoodProps = React.ComponentProps<"section"> & {
  mechanismTag: string
  items: MechanismNeighborhoodItem[]
  basePath?: string
  closeHref?: string
}

const nodePositions = [
  [18, 22], [72, 17], [82, 54], [62, 76], [22, 73], [8, 48],
] as const

const kindIcon = {
  paper: FileText,
  claim: Quote,
  evidence: Link2,
  task: ListTodo,
  mechanism: Orbit,
}

export function MechanismNeighborhood({
  mechanismTag,
  items,
  basePath = "/papers",
  closeHref = "/papers",
  className,
  ...props
}: MechanismNeighborhoodProps) {
  const [relation, setRelation] = useState<"all" | MechanismNeighborhoodItem["relation"]>("all")
  const [selectedId, setSelectedId] = useState(items[0]?.id ?? "")
  const visibleItems = useMemo(
    () => items.filter((item) => relation === "all" || item.relation === relation).slice(0, 6),
    [items, relation],
  )
  const selected = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0]

  const relations = useMemo(
    () => ["all", ...new Set(items.map((item) => item.relation))] as Array<"all" | MechanismNeighborhoodItem["relation"]>,
    [items],
  )

  return (
    <section
      data-slot="mechanism-neighborhood"
      className={cn("research-panel overflow-hidden rounded-[1.4rem] border", className)}
      aria-labelledby="mechanism-neighborhood-title"
      {...props}
    >
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[color:var(--research-line)] px-5 py-4">
        <div>
          <p className="research-kicker">Mechanism neighborhood</p>
          <h2 id="mechanism-neighborhood-title" className="research-display mt-1 text-2xl font-bold">
            {mechanismLabel(mechanismTag)}
          </h2>
          <p className="research-muted mt-1 text-sm">Every line states why these objects meet.</p>
        </div>
        <Link className="research-control inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-sm" href={closeHref}>
          <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Return to paper
        </Link>
      </header>

      <div className="border-b border-[color:var(--research-line)] px-5 py-3">
        <div className="flex flex-wrap gap-2" aria-label="Relationship lens">
          {relations.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={relation === value}
              data-state={relation === value ? "active" : "inactive"}
              className="research-relation-filter min-h-9 rounded-full px-3 text-xs capitalize"
              onClick={() => setRelation(value)}
            >
              {value === "all" ? "All relations" : value}
            </button>
          ))}
        </div>
      </div>

      <div className="grid min-h-[360px] lg:grid-cols-[minmax(180px,0.72fr)_minmax(360px,1.5fr)_minmax(210px,0.82fr)]">
        <ol className="border-b border-[color:var(--research-line)] p-3 lg:border-b-0 lg:border-r" aria-label="Objects in this neighborhood">
          {visibleItems.map((item, index) => {
            const Icon = kindIcon[item.kind]
            return (
              <li key={item.id}>
                <button
                  type="button"
                  data-state={selected?.id === item.id ? "active" : "inactive"}
                  className="research-object-row flex min-h-12 w-full items-start gap-2 rounded-xl px-3 py-2 text-left"
                  onClick={() => setSelectedId(item.id)}
                >
                  <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold">{item.label}</span>
                    <span className="research-muted block text-[11px]">{index + 1}. {item.relation}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ol>

        <div className="research-field relative min-h-[360px] overflow-hidden" aria-label={`Spatial field for ${mechanismLabel(mechanismTag)}`}>
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" aria-hidden="true" preserveAspectRatio="none">
            {visibleItems.map((item, index) => {
              const [x, y] = nodePositions[index]
              return <line key={item.id} x1="50" y1="48" x2={x} y2={y} className={`research-edge research-edge-${item.relation}`} />
            })}
          </svg>
          <div className="research-orbit-core absolute left-1/2 top-[48%] flex h-28 w-28 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-center">
            <span>
              <Orbit aria-hidden="true" className="mx-auto mb-1 h-5 w-5" />
              <strong className="research-smallcaps block text-sm">{mechanismLabel(mechanismTag)}</strong>
              <span className="research-muted text-[10px]">mechanism</span>
            </span>
          </div>
          {visibleItems.map((item, index) => {
            const [x, y] = nodePositions[index]
            const Icon = kindIcon[item.kind]
            return (
              <button
                key={item.id}
                type="button"
                aria-label={`${item.label}; ${item.relation} ${mechanismLabel(mechanismTag)}`}
                aria-pressed={selected?.id === item.id}
                data-kind={item.kind}
                data-state={selected?.id === item.id ? "active" : "inactive"}
                className="research-field-node absolute flex min-h-11 max-w-36 -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-full px-3 py-2 text-left text-[11px] leading-tight"
                style={{ left: `${x}%`, top: `${y}%` }}
                onClick={() => setSelectedId(item.id)}
              >
                <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                <span className="line-clamp-2">{item.label}</span>
              </button>
            )
          })}
        </div>

        <aside className="border-t border-[color:var(--research-line)] p-5 lg:border-l lg:border-t-0" aria-label="Selected relationship detail">
          {selected ? (
            <div role="status" aria-live="polite">
              <p className="research-kicker">{selected.kind} · {selected.relation}</p>
              <h3 className="research-display mt-2 text-xl font-semibold leading-tight">{selected.label}</h3>
              <p className="research-prose research-muted mt-3 text-sm leading-6">{selected.detail}</p>
              {selected.mechanismTag && selected.mechanismTag !== mechanismTag && (
                <Link
                  href={mechanismHref(selected.mechanismTag, basePath)}
                  className="research-control mt-4 inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-sm"
                >
                  <GitFork aria-hidden="true" className="h-4 w-4" /> Explore {mechanismLabel(selected.mechanismTag)}
                </Link>
              )}
            </div>
          ) : (
            <p className="research-muted text-sm">No objects match this relationship lens.</p>
          )}
          <p className="research-muted mt-8 text-xs">Addressable as <code>?mechanism={mechanismId(mechanismTag)}</code></p>
        </aside>
      </div>
    </section>
  )
}
