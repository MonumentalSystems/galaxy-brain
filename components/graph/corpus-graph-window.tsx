"use client"

import { ArrowLeft, ArrowRight, CircleDot, Layers3, LoaderCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import type {
  GraphWindowCluster,
  GraphWindowMember,
  GraphWindowResponse,
} from "@/lib/graph-window-contract.js"

type CorpusGraphWindowProps = {
  window: GraphWindowResponse
  loading?: boolean
  onExpand: (cluster: GraphWindowCluster) => void
  onBack: () => void
  onNextPage: () => void
  onOpenMember: (member: GraphWindowMember) => void
  focusReturnHref?: string | null
}

const GRAPH_COLOR = Object.freeze({
  surface: "hsl(var(--field-surface))",
  panel: "hsl(var(--field-panel))",
  ink: "hsl(var(--field-ink))",
  muted: "hsl(var(--field-muted-strong))",
  cool: "hsl(var(--field-cool-strong))",
})

function memberPoint(index: number) {
  const columns = 20
  const column = index % columns
  const row = Math.floor(index / columns)
  return { x: -513 + column * 54, y: -243 + row * 54 }
}

function ClusterNode({ cluster }: { cluster: GraphWindowCluster }) {
  const { x, y, width, height } = cluster.bounds
  return (
    <g aria-hidden="true">
      <rect
        x={x - width / 2}
        y={y - height / 2}
        width={width}
        height={height}
        rx="24"
        fill={GRAPH_COLOR.panel}
        stroke={GRAPH_COLOR.muted}
        strokeOpacity="0.55"
      />
      <text x={x} y={y - 8} textAnchor="middle" fill={GRAPH_COLOR.ink} fontSize="24" fontWeight="700">
        {cluster.label}
      </text>
      <text x={x} y={y + 22} textAnchor="middle" fill={GRAPH_COLOR.muted} fontSize="14">
        {cluster.count === null ? "Count unavailable" : `${cluster.count.toLocaleString()} objects`}
      </text>
    </g>
  )
}

export function CorpusGraphWindow({
  window,
  loading = false,
  onExpand,
  onBack,
  onNextPage,
  onOpenMember,
  focusReturnHref = null,
}: CorpusGraphWindowProps) {
  const expandedId = window.query.expandClusterId
  const expanded = expandedId ? window.clusters.find((cluster) => cluster.id === expandedId) ?? null : null
  const relationProvider = window.providers.find((provider) => provider.provider === "galaxy.object-links")
  return (
    <section className="graph-surface overflow-hidden rounded-[1.75rem] border" aria-labelledby="corpus-window-title">
      <header className="graph-surface__header flex flex-wrap items-center justify-between gap-4 border-b px-5 py-4">
        <div>
          <p className="research-kicker">Server-bounded semantic field</p>
          <h2 id="corpus-window-title" className="research-display mt-1 text-2xl font-semibold">
            {expanded ? expanded.label : "Tenant corpus"}
          </h2>
          <p className="graph-surface__muted mt-1 text-xs">
            {expanded
              ? `${window.members.length} exact pinned objects in this page`
              : `${window.clusters.reduce((sum, cluster) => sum + (cluster.count ?? 0), 0).toLocaleString()} counted objects across ${window.clusters.length} aggregates`}
            {" · follow-latest window"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {window.focus && focusReturnHref ? (
            <Button asChild variant="outline" size="sm" className="min-h-11">
              <a href={focusReturnHref} aria-label="Return to the exact proof graph that opened this corpus view">
                <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" /> Return to focused proof graph
              </a>
            </Button>
          ) : null}
          {expanded ? (
            <Button variant="outline" size="sm" onClick={onBack} disabled={loading}>
              <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" /> All aggregates
            </Button>
          ) : null}
          {loading ? <LoaderCircle className="graph-surface__cool h-5 w-5 animate-spin motion-reduce:animate-none" aria-label="Loading graph window" /> : null}
        </div>
      </header>

      <div className="graph-surface__field relative min-h-[39rem] overflow-hidden">
        <svg className="h-[39rem] w-full" viewBox="-610 -360 1220 720" role="img" aria-labelledby="corpus-map-title corpus-map-description">
          <title id="corpus-map-title">{expanded ? `${expanded.label} member page` : "Tenant corpus aggregates"}</title>
          <desc id="corpus-map-description">
            {expanded
              ? "Select an exact pinned object to open its detailed graph."
              : "Select an aggregate to replace this view with a bounded member page."}
          </desc>
          <g aria-hidden="true" opacity="0.35">
            <circle cx="0" cy="0" r="255" fill="none" stroke={GRAPH_COLOR.muted} strokeDasharray="3 10" />
            <circle cx="0" cy="0" r="335" fill="none" stroke={GRAPH_COLOR.muted} strokeDasharray="2 14" />
          </g>
          {!expanded ? window.clusters.map((cluster) => (
            <ClusterNode key={cluster.id} cluster={cluster} />
          )) : (
            <>
              {window.members.map((member, index) => {
                const point = memberPoint(index)
                return (
                  <circle
                    key={member.ref}
                    cx={point.x}
                    cy={point.y}
                    r="10"
                    fill={GRAPH_COLOR.panel}
                    stroke={GRAPH_COLOR.cool}
                    strokeWidth="3"
                    aria-hidden="true"
                  />
                )
              })}
            </>
          )}
        </svg>
        {expanded ? (
          <div className="graph-surface__panel border-t p-4">
            <p className="mb-3 text-sm font-semibold">Exact objects in this bounded page</p>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {window.members.map((member) => (
                <li key={member.ref}>
                  <button
                    type="button"
                    onClick={() => onOpenMember(member)}
                    title={member.title}
                    className="graph-surface__card flex min-h-11 w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm shadow-sm focus-visible:outline-none"
                  >
                    <CircleDot className="graph-surface__cool h-5 w-5 shrink-0" aria-hidden="true" />
                    <span className="truncate">{member.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="graph-surface__panel border-t p-4">
            <p className="mb-3 text-sm font-semibold">Corpus aggregates</p>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {window.clusters.map((cluster) => (
                <li key={cluster.id}>
                  <button
                    type="button"
                    onClick={() => onExpand(cluster)}
                    disabled={!cluster.expandable}
                    className="graph-surface__card min-h-11 w-full rounded-xl border px-3 py-2 text-left text-sm shadow-sm focus-visible:outline-none disabled:cursor-default disabled:opacity-65"
                  >
                    <span className="block font-semibold">{cluster.label}</span>
                    <span className="graph-surface__muted block text-xs">
                      {cluster.count === null ? "Count unavailable" : `${cluster.count.toLocaleString()} objects`}
                      {cluster.expandable ? " · Open bounded page" : " · Aggregate only"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <footer className="graph-surface__footer graph-surface__muted flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3 text-xs">
        <span className="inline-flex items-center gap-2">
          <Layers3 className="h-4 w-4" aria-hidden="true" />
          Aggregates are navigation, not durable objects.
          {relationProvider?.status === "partial" ? " Relation aggregation remains explicitly partial." : ""}
          {" Paging follows latest; inserts or deletions can shift later pages."}
        </span>
        {window.continuation.hasMore ? (
          <Button variant="outline" size="sm" onClick={onNextPage} disabled={loading}>
            Next bounded page <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Button>
        ) : null}
      </footer>
    </section>
  )
}
