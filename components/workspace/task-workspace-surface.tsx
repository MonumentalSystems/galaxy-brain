"use client"

import type { ReactNode } from "react"
import { useState } from "react"
import dynamic from "next/dynamic"
import {
  BookOpenText,
  Clipboard,
  FileCode2,
  LayoutGrid,
  Map,
  Plus,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { groupIntoColumns } from "@/lib/board-layout.js"
import type { GalaxyNode } from "@/lib/galaxy-brain-service"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import {
  researchRecordToMarkdown,
  type ResearchRecordDocument,
  type ResearchRecordResource,
} from "@/lib/research-record"

export type TaskWorkspaceScale = "atlas" | "board" | "record" | "source"

export interface TaskWorkspaceContext {
  id?: string
  goal: string
  state: "draft" | "linked"
}

export interface TaskWorkspaceSurfaceProps {
  record: ResearchRecordDocument
  task: TaskWorkspaceContext
  children: ReactNode
  scale?: TaskWorkspaceScale
  defaultScale?: TaskWorkspaceScale
  onScaleChange?: (scale: TaskWorkspaceScale) => void
  className?: string
  /**
   * Cards pinned to this record's board. A board is a layout over nodes rather
   * than a container that owns them, so these are ordinary canvas nodes and
   * adding one means creating a node.
   */
  cards?: GalaxyNode[]
  /** Columns to show even when empty, so a board has drop targets. */
  boardColumns?: string[]
  onAddCard?: (column: string) => void
  onOpenCard?: (node: GalaxyNode) => void
}

const scaleOptions = [
  { value: "atlas", label: "Atlas", detail: "far", icon: Map },
  { value: "board", label: "Board", detail: "medium", icon: LayoutGrid },
  { value: "record", label: "Record", detail: "near", icon: BookOpenText },
  { value: "source", label: "Source", detail: "atomic", icon: FileCode2 },
] as const

const ResearchMarkdownDocument = dynamic(
  () => import("@/components/workspace/research-markdown-document")
    .then((module) => module.ResearchMarkdownDocument),
  {
    loading: () => <p className="research-prose text-sm italic text-[#61766b]">Rendering document…</p>,
  },
)

export function TaskWorkspaceSurface({
  record,
  task,
  children,
  scale,
  defaultScale = "record",
  onScaleChange,
  className,
  cards,
  boardColumns,
  onAddCard,
  onOpenCard,
}: TaskWorkspaceSurfaceProps) {
  const [internalScale, setInternalScale] = useState<TaskWorkspaceScale>(defaultScale)
  const [copyStatus, setCopyStatus] = useState("")
  const activeScale = scale ?? internalScale
  const activeScaleIndex = scaleOptions.findIndex((option) => option.value === activeScale)
  const markdown = researchRecordToMarkdown(record)

  const setScale = (next: string) => {
    const nextScale = next as TaskWorkspaceScale
    if (scale === undefined) setInternalScale(nextScale)
    onScaleChange?.(nextScale)
  }

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(markdown)
      setCopyStatus("Markdown copied")
    } catch {
      setCopyStatus("Could not copy Markdown")
    }
  }

  return (
    <section
      className={cn("research-workbench overflow-hidden rounded-2xl border border-[#456c59]/35 bg-[#f9f6f1]", className)}
      aria-labelledby={`task-workspace-${record.id}`}
    >
      <header className="border-b border-[#456c59]/30 bg-[#f8f5eb] px-5 py-6 sm:px-7">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="research-kicker">ELN Research Record · {record.schemaVersion}</p>
              <Badge variant="outline" className="rounded-md border-[#456c59]/30 bg-[#eff3ec] font-mono text-[10px] font-normal text-[#294b3b]">
                {task.state === "linked" ? `HAM ${task.id}` : "local draft"}
              </Badge>
            </div>
            <h2 id={`task-workspace-${record.id}`} className="research-display mt-2 max-w-4xl text-2xl font-semibold leading-tight text-[#18372b] sm:text-3xl">
              {task.goal}
            </h2>
            <p className="research-prose mt-2 max-w-3xl text-sm leading-6 text-[#4c6559]">
              The record remains one durable object while its representation changes with observational scale.
            </p>
            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-[#61766b]">
              <span><strong className="font-medium text-[#294b3b]">Status</strong> · {record.status}</span>
              <span><strong className="font-medium text-[#294b3b]">Domain</strong> · {record.domain}</span>
              <span><strong className="font-medium text-[#294b3b]">References</strong> · {record.references.length}</span>
              <span><strong className="font-medium text-[#294b3b]">Artifacts</strong> · {record.artifacts.length}</span>
            </div>
          </div>

          <div className="border-y border-[#456c59]/25 py-3">
            <div className="flex items-center justify-between gap-3">
              <p className="research-smallcaps text-xs text-[#456c59]">Observational Scale</p>
              <p className="font-mono text-[10px] text-[#61766b]">{activeScaleIndex + 1} / {scaleOptions.length}</p>
            </div>
            <div className="mt-3 h-px bg-[#456c59]/40" aria-hidden="true">
              <span
                className="block h-0.5 bg-[#18372b] transition-[width] duration-200 motion-reduce:transition-none"
                style={{ width: `${((activeScaleIndex + 1) / scaleOptions.length) * 100}%` }}
              />
            </div>
            <p className="research-prose mt-3 text-sm italic text-[#4c6559]">
              {activeScale === "atlas" && "Identity, region, and density."}
              {activeScale === "board" && "Objects, evidence, and active relationships."}
              {activeScale === "record" && "The editable scientific manuscript."}
              {activeScale === "source" && "Exact identifiers, provenance, and portable source."}
            </p>
          </div>
        </div>
      </header>

      <Tabs value={activeScale} onValueChange={setScale} className="p-3 sm:p-5">
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 rounded-lg border border-[#456c59]/30 bg-[#eff3ec] p-1 sm:grid-cols-4 lg:w-fit" aria-label="Semantic zoom scale">
          {scaleOptions.map(({ value, label, detail, icon: Icon }, index) => (
            <TabsTrigger
              key={value}
              value={value}
              className="min-h-11 gap-2 rounded-md px-4 text-[#61766b] data-[state=active]:bg-[#fcfbf8] data-[state=active]:text-[#18372b] data-[state=active]:shadow-[0_2px_8px_rgba(31,45,40,.08)]"
              title={`${label} scale: ${detail}`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span>{label}</span>
              <span className="sr-only">Scale {index + 1}: {detail}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="atlas" className="mt-4">
          <AtlasProjection record={record} />
        </TabsContent>
        <TabsContent value="board" className="mt-4">
          <BoardProjection
            record={record}
            cards={cards}
            columnNames={boardColumns}
            onAddCard={onAddCard}
            onOpenCard={onOpenCard}
          />
        </TabsContent>
        <TabsContent value="record" className="mt-4">
          <div className="rounded-xl border border-[#456c59]/25 bg-[#fcfbf8] px-4 py-6 shadow-[0_22px_50px_-42px_rgba(31,45,40,.45)] sm:px-8">
            <div className="mb-7 flex items-center justify-between gap-4 border-b border-[#456c59]/20 pb-3">
              <p className="research-kicker">Annotated Manuscript · Editable</p>
              <p className="font-mono text-[10px] text-[#61766b]">record:{record.id}</p>
            </div>
            {children}
          </div>
        </TabsContent>
        <TabsContent value="source" className="mt-4">
          <SourceProjection record={record} markdown={markdown} copyStatus={copyStatus} onCopy={copyMarkdown} />
        </TabsContent>
      </Tabs>
    </section>
  )
}

function AtlasProjection({ record }: { record: ResearchRecordDocument }) {
  const relatedCount = record.references.length + record.artifacts.length + record.linkedRecordIds.length
  return (
    <div className="relative min-h-[500px] overflow-hidden rounded-xl border border-[#456c59]/25 bg-[#dfe9e0] p-6 sm:p-10">
      <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1000 500" preserveAspectRatio="none" aria-hidden="true">
        <path d="M500 250 L180 115 M500 250 L810 105 M500 250 L170 385 M500 250 L825 390" fill="none" stroke="#456c59" strokeOpacity="0.42" strokeWidth="1.2" />
        <path d="M180 115 Q500 45 810 105 M170 385 Q500 455 825 390" fill="none" stroke="#577766" strokeOpacity="0.28" strokeDasharray="5 5" />
      </svg>
      <div className="relative grid min-h-[420px] grid-cols-2 grid-rows-[1fr_auto_1fr] items-center gap-5 sm:grid-cols-[1fr_1.2fr_1fr]">
        <AtlasNode symbol="◆" label="Statements" value={record.sections.length} className="justify-self-start sm:col-start-1" />
        <AtlasNode symbol="□" label="Sources" value={record.references.length} className="justify-self-end sm:col-start-3" />
        <div className="col-span-2 row-start-2 mx-auto flex h-44 w-44 flex-col items-center justify-center rounded-full border border-[#18372b]/50 bg-[#f9f6f1] p-5 text-center shadow-[0_20px_45px_-35px_rgba(31,45,40,.7)] sm:col-span-1 sm:col-start-2">
          <span className="research-smallcaps text-[10px] text-[#456c59]">Research Record</span>
          <h3 className="research-display mt-2 line-clamp-3 text-xl font-semibold leading-tight text-[#18372b]">{record.title}</h3>
          <p className="mt-2 font-mono text-[9px] text-[#61766b]">{relatedCount} related objects</p>
        </div>
        <AtlasNode symbol="▣" label="Artifacts" value={record.artifacts.length} className="justify-self-start sm:col-start-1 sm:row-start-3" />
        <AtlasNode symbol="⎇" label="Branches" value={record.linkedRecordIds.length} className="justify-self-end sm:col-start-3 sm:row-start-3" />
      </div>
      <p className="research-prose relative mt-2 text-center text-sm italic text-[#4c6559]">
        Far view: one recognizable object within its evidence neighborhood.
      </p>
    </div>
  )
}

function AtlasNode({ symbol, label, value, className }: { symbol: string; label: string; value: number; className?: string }) {
  return (
    <div className={cn("w-32 border-y border-[#456c59]/35 bg-[#eff3ec]/85 px-3 py-3 text-center", className)}>
      <span className="research-display text-xl text-[#294b3b]" aria-hidden="true">{symbol}</span>
      <p className="research-smallcaps mt-1 text-[10px] text-[#456c59]">{label}</p>
      <p className="font-mono text-xs text-[#1f2d28]">{value}</p>
    </div>
  )
}

function BoardProjection({
  record,
  cards,
  columnNames,
  onAddCard,
  onOpenCard,
}: {
  record: ResearchRecordDocument
  cards?: GalaxyNode[]
  columnNames?: string[]
  onAddCard?: (column: string) => void
  onOpenCard?: (node: GalaxyNode) => void
}) {
  // The record's own sections are its fixed shape; cards are whatever has been
  // added to the board since, which is why they are grouped separately.
  const columns = groupIntoColumns(cards ?? [], columnNames)
  const canAdd = typeof onAddCard === "function"

  return (
    <div className="research-field rounded-xl border border-[#456c59]/25 p-4 sm:p-7">
      <div className="grid auto-rows-fr gap-4 md:grid-cols-2 xl:grid-cols-3">
        {record.sections.map((section, index) => (
          <article
            key={section.key}
            className="border border-[#456c59]/25 bg-[#fcfbf8]/95 p-4 shadow-[0_16px_30px_-26px_rgba(31,45,40,.6)]"
          >
            <div className="flex items-center justify-between gap-3 border-b border-[#456c59]/15 pb-2">
              <h3 className="research-display font-semibold text-[#1f2d28]">{section.title}</h3>
              <span className="research-smallcaps text-[9px] text-[#61766b]">¶ {String(index + 1).padStart(2, "0")}</span>
            </div>
            <p className="research-prose mt-3 line-clamp-5 whitespace-pre-wrap text-sm leading-6 text-[#4c6559]">
              {section.content || "Not recorded yet."}
            </p>
          </article>
        ))}
      </div>

      {(columns.length > 0 || canAdd) && (
        <div className="mt-6 space-y-4">
          <p className="research-kicker">Board cards</p>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {columns.map((column) => (
              <section key={column.name} aria-label={column.name} className="space-y-3">
                <div className="flex items-center justify-between gap-2 border-b border-[#456c59]/20 pb-1">
                  <h4 className="research-smallcaps text-[10px] text-[#456c59]">{column.name}</h4>
                  <span className="font-mono text-[9px] text-[#61766b]">{column.nodes.length}</span>
                </div>

                {column.nodes.map((node) => (
                  <article
                    key={node.id}
                    className="border border-[#456c59]/25 bg-[#fcfbf8]/95 p-3 shadow-[0_16px_30px_-26px_rgba(31,45,40,.6)]"
                  >
                    <button
                      type="button"
                      onClick={() => onOpenCard?.(node)}
                      disabled={!onOpenCard}
                      className="w-full text-left disabled:cursor-default"
                    >
                      <h5 className="research-display line-clamp-2 font-semibold text-[#1f2d28]">{node.title}</h5>
                      {node.content && (
                        <p className="research-prose mt-2 line-clamp-4 whitespace-pre-wrap text-sm leading-6 text-[#4c6559]">
                          {node.content}
                        </p>
                      )}
                    </button>
                    {/* Where a clipped card came from is the reason to keep it. */}
                    {typeof node.metadata?.url === "string" && (
                      <p className="mt-2 truncate font-mono text-[9px] text-[#61766b]">
                        {typeof node.metadata?.region === "object" && node.metadata.region !== null
                          ? String((node.metadata.region as { label?: string }).label || node.metadata.url)
                          : node.metadata.url}
                      </p>
                    )}
                  </article>
                ))}

                {canAdd && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => onAddCard?.(column.name)}
                    className="research-control min-h-10 w-full rounded-lg"
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    Add card
                  </Button>
                )}
              </section>
            ))}
          </div>
        </div>
      )}

      <div className="mt-5 grid gap-px overflow-hidden border border-[#456c59]/25 bg-[#456c59]/25 lg:grid-cols-2">
        <ResourceStrip symbol="□" title="References" resources={record.references} emptyLabel="No references attached." />
        <ResourceStrip symbol="▣" title="Artifacts" resources={record.artifacts} emptyLabel="No artifacts attached." />
      </div>
    </div>
  )
}

function ResourceStrip({
  symbol,
  title,
  resources,
  emptyLabel,
}: {
  symbol: string
  title: string
  resources: ResearchRecordResource[]
  emptyLabel: string
}) {
  return (
    <section className="bg-[#e8efe7] p-4">
      <h3 className="research-smallcaps text-xs text-[#294b3b]"><span aria-hidden="true">{symbol}</span> {title}</h3>
      {resources.length === 0 ? (
        <p className="research-prose mt-2 text-sm italic text-[#61766b]">{emptyLabel}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {resources.map((resource) => (
            <li key={resource.id} className="border-l border-[#456c59]/35 pl-3 text-sm text-[#4c6559]">
              {resource.href ? (
                <a className="underline decoration-[#456c59]/40 underline-offset-4 hover:text-[#18372b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2f6552]" href={resource.href} target="_blank" rel="noreferrer">
                  {resource.title}
                </a>
              ) : resource.title}
              {resource.mediaType && <p className="mt-1 font-mono text-[9px] text-[#61766b]">{resource.mediaType}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function SourceProjection({
  record,
  markdown,
  copyStatus,
  onCopy,
}: {
  record: ResearchRecordDocument
  markdown: string
  copyStatus: string
  onCopy: () => void
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="rounded-xl border border-[#456c59]/25 bg-[#e8efe7] p-5">
        <p className="research-kicker">Critical Edition</p>
        <h3 className="research-display mt-1 text-xl font-semibold text-[#18372b]">Provenance</h3>
        <dl className="mt-5 space-y-4 text-xs">
          <SourceDatum label="Record" value={record.id} />
          <SourceDatum label="Schema" value={record.schemaVersion} />
          <SourceDatum label="Tenant" value={record.provenance.tenantId} />
          <SourceDatum label="Principal" value={record.provenance.principalId || "not recorded"} />
          <SourceDatum label="HAM node" value={record.provenance.hamNodeId || "not linked"} />
          <SourceDatum label="Created" value={record.provenance.createdAt} />
          <SourceDatum label="Updated" value={record.provenance.updatedAt} />
        </dl>
      </aside>
      <Tabs defaultValue="rendered" className="overflow-hidden rounded-xl border border-[#456c59]/25 bg-[#fcfbf8]">
        <header className="flex flex-col gap-3 border-b border-[#456c59]/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="research-kicker">Portable Projection</p>
            <h3 className="research-display mt-1 text-lg font-semibold text-[#1f2d28]">Markdown Document</h3>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <TabsList className="grid h-10 grid-cols-2 rounded-lg border border-[#456c59]/25 bg-[#eff3ec] p-1" aria-label="Markdown display">
              <TabsTrigger value="rendered" className="rounded-md px-3 text-xs text-[#61766b] data-[state=active]:bg-[#fcfbf8] data-[state=active]:text-[#18372b]">
                Rendered
              </TabsTrigger>
              <TabsTrigger value="raw" className="rounded-md px-3 text-xs text-[#61766b] data-[state=active]:bg-[#fcfbf8] data-[state=active]:text-[#18372b]">
                Raw
              </TabsTrigger>
            </TabsList>
            <span role="status" aria-live="polite" className="text-xs text-[#61766b]">{copyStatus}</span>
            <Button type="button" variant="outline" size="sm" onClick={onCopy} className="research-control min-h-10 rounded-lg">
              <Clipboard className="h-4 w-4" aria-hidden="true" />
              Copy Markdown
            </Button>
          </div>
        </header>
        <TabsContent value="rendered" className="m-0">
          <article className="research-markdown max-h-[68vh] overflow-auto p-5 sm:p-7">
            <ResearchMarkdownDocument markdown={markdown} />
          </article>
        </TabsContent>
        <TabsContent value="raw" className="m-0">
          <pre className="max-h-[68vh] overflow-auto whitespace-pre-wrap p-5 font-mono text-xs leading-6 text-[#294b3b] sm:p-7">
            <code>{markdown}</code>
          </pre>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function SourceDatum({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="research-smallcaps text-[9px] text-[#61766b]">{label}</dt>
      <dd className="mt-1 break-words font-mono text-[10px] leading-4 text-[#294b3b]">{value}</dd>
    </div>
  )
}
