"use client"

import { useId } from "react"

import { Badge } from "@/components/ui/badge"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { SurfaceSvg } from "@/components/surfaces/surface-svg"
import { projectSurface, surfaceDisplayText, type ProjectedSurfaceNode } from "@/lib/surface-projection"
import { formatSurfaceCell, projectChartData, projectKnowledgeGraphData, projectTimelineData } from "@/lib/surface-render-data"
import type { GalaxySurfaceSpec, SurfaceBinding } from "@/lib/types/surfaces"

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback
}

function componentData(props: UnknownRecord) {
  return record(props.data)
}

function renderText(node: ProjectedSurfaceNode, heading = false) {
  const value = surfaceDisplayText(node.props, ["text", "title", "content"], heading ? "Untitled" : "")
  const usageHint = text(node.props.usageHint)
  if (heading || node.type === "Title" || ["h1", "h2"].includes(usageHint)) {
    return <h2 className="font-display text-2xl font-semibold tracking-tight text-cosmic-950 dark:text-white">{value}</h2>
  }
  if (["h3", "h4", "h5", "h6"].includes(usageHint)) {
    return <h3 className="font-display text-lg font-semibold text-cosmic-900 dark:text-white">{value}</h3>
  }
  return (
    <div className="text-sm leading-6 text-cosmic-700 dark:text-cosmic-200">
      <MarkdownRenderer content={value} images="omit" />
    </div>
  )
}

function SurfaceTable({ props }: { props: UnknownRecord }) {
  const data = componentData(props)
  const columns = list(data.columns).map(record)
  const rows = list(data.rows).map(record)
  const inferredKeys = rows[0] ? Object.keys(rows[0]).slice(0, 12) : []
  const normalizedColumns = columns.length > 0
    ? columns.slice(0, 12).map((column) => ({
        key: text(column.accessorKey ?? column.key ?? column.id),
        label: text(column.header ?? column.label ?? column.title ?? column.accessorKey ?? column.id),
      })).filter((column) => column.key)
    : inferredKeys.map((key) => ({ key, label: key }))

  return (
    <section className="overflow-hidden rounded-2xl border border-cosmic-200/70 bg-white/70 dark:border-white/10 dark:bg-cosmic-950/55">
      {text(data.title ?? props.title) && (
        <h3 className="border-b border-cosmic-200/70 px-4 py-3 font-display text-base font-semibold dark:border-white/10">
          {text(data.title ?? props.title)}
        </h3>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-sm">
          <thead className="bg-cosmic-50/80 text-left text-xs uppercase tracking-wide text-cosmic-500 dark:bg-white/5 dark:text-cosmic-300">
            <tr>{normalizedColumns.map((column) => <th key={column.key} className="px-4 py-2.5 font-semibold">{column.label}</th>)}</tr>
          </thead>
          <tbody>
            {rows.slice(0, 100).map((row, index) => (
              <tr key={index} className="border-t border-cosmic-100 dark:border-white/5">
                {normalizedColumns.map((column) => (
                  <td key={column.key} className="max-w-[24rem] px-4 py-3 align-top text-cosmic-700 dark:text-cosmic-200">
                    {formatSurfaceCell(row[column.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="px-4 py-8 text-center text-sm text-muted-foreground">No rows in this snapshot.</p>}
      {rows.length > 100 && <p className="border-t px-4 py-2 text-xs text-muted-foreground">Showing the first 100 of {rows.length} rows.</p>}
    </section>
  )
}

function SurfaceStats({ props }: { props: UnknownRecord }) {
  const data = componentData(props)
  const stats = list(data.stats ?? props.stats).map(record)
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {stats.map((stat, index) => (
        <div key={text(stat.id, String(index))} className="rounded-2xl border border-cosmic-200/70 bg-white/70 p-4 dark:border-white/10 dark:bg-cosmic-950/55">
          <p className="text-xs font-medium uppercase tracking-wide text-cosmic-500 dark:text-cosmic-300">{text(stat.label ?? stat.title ?? stat.name, `Metric ${index + 1}`)}</p>
          <p className="mt-2 font-display text-2xl font-semibold text-cosmic-950 dark:text-white">{text(stat.value, "—")}</p>
          {text(stat.description ?? stat.change) && <p className="mt-1 text-xs text-muted-foreground">{text(stat.description ?? stat.change)}</p>}
        </div>
      ))}
      {stats.length === 0 && <p className="text-sm text-muted-foreground">No statistics in this snapshot.</p>}
    </div>
  )
}

function SurfaceChart({ props }: { props: UnknownRecord }) {
  const chart = projectChartData(props)
  const titleId = `surface-chart-${useId().replace(/:/g, "")}`
  const descriptionId = `${titleId}-description`
  const width = 720
  const height = 320
  const margin = { top: 24, right: 24, bottom: 48, left: 58 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  const series = chart.series.slice(0, 8).map((item) => ({ ...item, points: item.points.slice(0, 40) }))
  const values = series.flatMap((item) => item.points.map((point) => point.y))
  const minimum = Math.min(0, ...values)
  const maximum = Math.max(0, ...values)
  const span = maximum - minimum || 1
  const yPosition = (value: number) => margin.top + (maximum - value) / span * plotHeight
  const xPosition = (index: number, count: number) => margin.left + (count < 2 ? plotWidth / 2 : index / (count - 1) * plotWidth)
  const palette = ["#31593d", "#b85f36", "#4e5a8c", "#a87532", "#58756a", "#884f57", "#64733d", "#78664f"]
  const yTicks = Array.from({ length: 5 }, (_, index) => maximum - index / 4 * span)
  const longestSeries = series.reduce((longest, item) => item.points.length > longest.points.length ? item : longest, series[0] ?? { points: [] })
  const xTickStep = Math.max(1, Math.ceil(longestSeries.points.length / 6))
  const hasData = values.length > 0
  return (
    <section className="rounded-2xl border border-cosmic-200/70 bg-white/70 p-4 dark:border-white/10 dark:bg-cosmic-950/55">
      <h3 className="font-display font-semibold">{chart.title}</h3>
      {hasData ? (
        <>
          <div className="mt-3 overflow-x-auto">
            <svg
              role="img"
              aria-labelledby={`${titleId} ${descriptionId}`}
              viewBox={`0 0 ${width} ${height}`}
              className="min-w-[34rem] text-cosmic-500 dark:text-cosmic-300"
            >
              <title id={titleId}>{chart.title}</title>
              <desc id={descriptionId}>Plot of {series.length} series with {values.length} visible observations.</desc>
              {yTicks.map((tick, index) => {
                const y = yPosition(tick)
                return (
                  <g key={index} aria-hidden="true">
                    <line x1={margin.left} x2={width - margin.right} y1={y} y2={y} stroke="currentColor" strokeOpacity="0.16" />
                    <text x={margin.left - 10} y={y + 4} textAnchor="end" fill="currentColor" fontSize="11">{Number(tick.toPrecision(4))}</text>
                  </g>
                )
              })}
              <line aria-hidden="true" x1={margin.left} x2={width - margin.right} y1={yPosition(0)} y2={yPosition(0)} stroke="currentColor" strokeOpacity="0.45" />
              {longestSeries.points.map((point, index) => index % xTickStep === 0 || index === longestSeries.points.length - 1 ? (
                <text
                  key={`${point.x}-${index}`}
                  x={xPosition(index, longestSeries.points.length)}
                  y={height - 18}
                  textAnchor="middle"
                  fill="currentColor"
                  fontSize="11"
                  aria-hidden="true"
                >
                  {String(point.label || point.x || index + 1).slice(0, 14)}
                </text>
              ) : null)}
              {series.map((item, seriesIndex) => {
                const path = item.points.map((point, index) =>
                  `${index === 0 ? "M" : "L"} ${xPosition(index, item.points.length)} ${yPosition(point.y)}`,
                ).join(" ")
                return (
                  <g key={`${item.name}-${seriesIndex}`}>
                    {item.points.length > 1 && <path d={path} fill="none" stroke={palette[seriesIndex]} strokeWidth="2.5" strokeLinejoin="round" />}
                    {item.points.map((point, index) => (
                      <circle
                        key={`${point.x}-${index}`}
                        cx={xPosition(index, item.points.length)}
                        cy={yPosition(point.y)}
                        r="4"
                        fill={palette[seriesIndex]}
                        stroke="white"
                        strokeWidth="1.5"
                      >
                        <title>{item.name}: {point.label || point.x || index + 1}, {point.y}</title>
                      </circle>
                    ))}
                  </g>
                )
              })}
            </svg>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2" aria-label="Plot legend">
            {series.map((item, index) => (
              <span key={`${item.name}-${index}`} className="inline-flex items-center gap-2 text-xs text-cosmic-700 dark:text-cosmic-200">
                <span className="h-0.5 w-5" style={{ backgroundColor: palette[index] }} aria-hidden="true" />
                {item.name}
              </span>
            ))}
          </div>
          <dl className="sr-only">
            {series.flatMap((item) => item.points.map((point, index) => (
              <div key={`${item.name}-${point.x}-${index}`}>
                <dt>{item.name}, {point.label || point.x || index + 1}</dt>
                <dd>{point.y}</dd>
              </div>
            )))}
          </dl>
        </>
      ) : <p className="mt-3 text-sm text-muted-foreground">No point series in this snapshot.</p>}
    </section>
  )
}

function SurfaceTimeline({ props }: { props: UnknownRecord }) {
  const events = projectTimelineData(props)
  return (
    <ol className="border-l border-galaxy-300 pl-5 dark:border-galaxy-700">
      {events.map((event, index) => (
        <li key={`${event.id}-${index}`} className="relative pb-5 last:pb-0">
          <span className="absolute -left-[1.56rem] top-1 h-3 w-3 rounded-full border-2 border-background bg-galaxy-500" />
          <p className="font-medium text-cosmic-900 dark:text-white">{event.title || `Event ${index + 1}`}</p>
          {event.date && <p className="text-xs text-galaxy-700 dark:text-galaxy-300">{event.date}</p>}
          {event.description && <p className="mt-1 text-sm text-muted-foreground">{event.description}</p>}
        </li>
      ))}
    </ol>
  )
}

function SurfaceKnowledgeGraph({ props }: { props: UnknownRecord }) {
  const graph = projectKnowledgeGraphData(props)
  const titleId = `surface-graph-${useId().replace(/:/g, "")}`
  const descriptionId = `${titleId}-description`
  const markerId = `${titleId}-arrow`
  const entities = graph.entities.slice(0, 32)
  const entityIds = new Set(entities.map((entity) => entity.id))
  const relationships = graph.relationships
    .filter((relationship) => entityIds.has(relationship.source) && entityIds.has(relationship.target))
    .slice(0, 80)
  const columns = Math.min(6, Math.max(1, Math.ceil(Math.sqrt(entities.length))))
  const rows = Math.max(1, Math.ceil(entities.length / columns))
  const width = 760
  const height = Math.max(260, rows * 82 + 70)
  const positions = new Map(entities.map((entity, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    return [entity.id, {
      x: columns === 1 ? width / 2 : 75 + column * ((width - 150) / (columns - 1)),
      y: rows === 1 ? height / 2 : 55 + row * ((height - 110) / (rows - 1)),
    }]
  }))
  return (
    <section className="rounded-2xl border border-cosmic-200/70 bg-cosmic-50/60 p-4 dark:border-white/10 dark:bg-white/5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-display font-semibold">{graph.title}</h3>
        <span className="text-xs text-muted-foreground">{graph.entities.length} entities · {graph.relationships.length} relationships</span>
      </div>
      {entities.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <svg
            role="img"
            aria-labelledby={`${titleId} ${descriptionId}`}
            viewBox={`0 0 ${width} ${height}`}
            className="min-w-[38rem]"
          >
            <title id={titleId}>{graph.title}</title>
            <desc id={descriptionId}>Node-link diagram with {entities.length} visible entities and {relationships.length} visible directed relationships.</desc>
            <defs>
              <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>
            <g className="text-cosmic-500 dark:text-cosmic-300">
              {relationships.map((relationship, index) => {
                const source = positions.get(relationship.source)
                const target = positions.get(relationship.target)
                if (!source || !target) return null
                const challenged = /contradict|challenge|oppose/i.test(relationship.type)
                return (
                  <g key={`${relationship.id}-${index}`}>
                    <line
                      x1={source.x}
                      y1={source.y}
                      x2={target.x}
                      y2={target.y}
                      stroke="currentColor"
                      strokeOpacity="0.58"
                      strokeWidth="1.5"
                      strokeDasharray={challenged ? "6 4" : undefined}
                      markerEnd={`url(#${markerId})`}
                    >
                      <title>{relationship.type}</title>
                    </line>
                    {relationships.length <= 16 && (
                      <text
                        x={(source.x + target.x) / 2}
                        y={(source.y + target.y) / 2 - 5}
                        textAnchor="middle"
                        fill="currentColor"
                        fontSize="9"
                      >
                        {relationship.type.slice(0, 18)}
                      </text>
                    )}
                  </g>
                )
              })}
            </g>
            {entities.map((entity, index) => {
              const position = positions.get(entity.id)
              if (!position) return null
              return (
                <g key={`${entity.id}-${index}`} transform={`translate(${position.x} ${position.y})`}>
                  <rect x="-54" y="-19" width="108" height="38" rx="8" fill="white" stroke="#31593d" strokeWidth="1.5" />
                  <text x="0" y={entity.type ? "-1" : "4"} textAnchor="middle" fill="#173c25" fontSize="11" fontWeight="600">
                    {entity.label.slice(0, 18)}
                  </text>
                  {entity.type && <text x="0" y="12" textAnchor="middle" fill="#58756a" fontSize="8">{entity.type.slice(0, 20)}</text>}
                  <title>{entity.label}{entity.type ? `, ${entity.type}` : ""}</title>
                </g>
              )
            })}
          </svg>
        </div>
      ) : <p className="mt-3 text-sm text-muted-foreground">No entities in this snapshot.</p>}
      {(graph.entities.length > entities.length || graph.relationships.length > relationships.length) && (
        <p className="mt-2 text-xs text-muted-foreground">Diagram bounded to the first {entities.length} entities and {relationships.length} drawable relationships.</p>
      )}
    </section>
  )
}

function SurfaceMarkdown({ props }: { props: UnknownRecord }) {
  const data = componentData(props)
  const content = text(data.content ?? data.markdown ?? props.content ?? props.markdown ?? props.text)
  return (
    <MarkdownRenderer content={content} images="omit" />
  )
}

function SurfaceNode({ node }: { node: ProjectedSurfaceNode }) {
  const children = node.children.map((child) => <SurfaceNode key={child.id} node={child} />)
  switch (node.type) {
    case "Title": return renderText(node, true)
    case "Heading": return renderText(node, true)
    case "Text": return renderText(node)
    case "Badge": return <Badge variant="secondary">{surfaceDisplayText(node.props, ["text", "label", "title"], "Badge")}</Badge>
    case "Separator": return <hr className="border-cosmic-200/80 dark:border-white/10" />
    case "Card": return <section className="rounded-2xl border border-cosmic-200/70 bg-white/75 p-5 shadow-sm dark:border-white/10 dark:bg-cosmic-950/55">{children}</section>
    case "Row": return <div className="flex flex-wrap items-center gap-3">{children}</div>
    case "Column":
    case "Stack": return <div className="flex flex-col gap-4">{children}</div>
    case "Grid": {
      const columns = typeof node.props.columns === "number" ? Math.max(1, Math.min(4, node.props.columns)) : 2
      return <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>{children}</div>
    }
    case "DataTable": return <SurfaceTable props={node.props} />
    case "StatsDisplay": return <SurfaceStats props={node.props} />
    case "Charts": return <SurfaceChart props={node.props} />
    case "Timeline": return <SurfaceTimeline props={node.props} />
    case "KnowledgeGraph": return <SurfaceKnowledgeGraph props={node.props} />
    case "Markdown": return <SurfaceMarkdown props={node.props} />
    case "SVGPreview": return <SurfaceSvg svg={text(node.props.svg)} title={text(node.props.title) || undefined} width={node.props.width} />
  }
}

function BindingLedger({ bindings }: { bindings: SurfaceBinding[] }) {
  if (bindings.length === 0) return null
  return (
    <details className="rounded-2xl border border-cosmic-200/70 bg-cosmic-50/60 p-4 text-sm dark:border-white/10 dark:bg-white/5">
      <summary className="cursor-pointer font-medium">Data bindings ({bindings.length})</summary>
      <div className="mt-3 space-y-2">
        {bindings.map((binding) => (
          <div key={binding.id} className="grid gap-1 rounded-xl bg-white/70 p-3 text-xs dark:bg-cosmic-950/60 sm:grid-cols-2">
            <span className="font-mono text-cosmic-700 dark:text-cosmic-200">{binding.target.componentId}.{binding.target.prop}</span>
            <span className="font-mono text-muted-foreground sm:text-right">{binding.source.kind}</span>
          </div>
        ))}
      </div>
    </details>
  )
}

export function SurfaceRenderer({ spec }: { spec: GalaxySurfaceSpec }) {
  const projected = projectSurface(spec)
  if (!projected.ok) {
    return (
      <div role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5">
        <p className="font-medium text-destructive">This surface cannot be rendered safely.</p>
        <p className="mt-1 text-sm text-muted-foreground">{projected.error}</p>
      </div>
    )
  }
  return (
    <div className="space-y-5" data-surface-schema="gb.surface.v1">
      {projected.roots.map((root) => <SurfaceNode key={root.id} node={root} />)}
      <BindingLedger bindings={projected.bindings} />
    </div>
  )
}
