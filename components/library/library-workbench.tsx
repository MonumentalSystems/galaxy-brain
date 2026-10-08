"use client"

import Link from "next/link"
import { FormEvent, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  AudioLines,
  BookOpen,
  BrainCircuit,
  FileText,
  FlaskConical,
  ImageIcon,
  Loader2,
  Search,
  Upload,
} from "lucide-react"

import { TopRail, TopRailTitle } from "@/components/workspace/top-rail"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  loadLibraryCatalog,
  searchLibrary,
  type LibraryCatalog,
  type LibrarySearchResults,
} from "@/lib/library-client"

type Filter = "all" | "documents" | "papers" | "eln" | "images" | "audio"

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })
const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "documents", label: "Notes & files" },
  { id: "papers", label: "Papers" },
  { id: "eln", label: "ELN" },
  { id: "images", label: "Images" },
  { id: "audio", label: "Audio & video" },
]
const INTAKE_OPTIONS = [
  { icon: Upload, label: "Files & notes", text: "PDF, DOCX, Markdown, text", href: "/workspace" },
  { icon: BookOpen, label: "Papers", text: "arXiv search and exact PDF", href: "/papers" },
  { icon: ImageIcon, label: "Images", text: "Figures and observations", href: "/workspace" },
  { icon: AudioLines, label: "Audio & video", text: "Media intake at the Atlas desk", href: "/workspace" },
] as const

const EMPTY_RESULTS: LibrarySearchResults = Object.freeze({
  documents: Object.freeze([]),
  ham: Object.freeze([]),
  arxiv: Object.freeze([]),
  arxivTotal: 0,
  unavailable: Object.freeze([]),
})

function dateLabel(value: string) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? DATE_FORMATTER.format(date) : "Unknown date"
}

function documentKind(filename: string): Exclude<Filter, "all" | "papers" | "eln"> {
  if (/\.(?:avif|gif|jpe?g|png|tiff?|webp)$/iu.test(filename)) return "images"
  if (/\.(?:m4a|mp3|mp4|ogg|opus|wav|webm)$/iu.test(filename)) return "audio"
  return "documents"
}

function Section({ title, eyebrow, children }: { title: string; eyebrow: string; children: ReactNode }) {
  return (
    <section className="border-t border-[#78806b]/35 pt-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#66705c]">{eyebrow}</p>
      <h2 className="font-display mt-1 text-2xl text-[#18352a]">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  )
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="border-l border-[#78806b]/50 pl-3 text-sm italic text-[#66705c]">{children}</p>
}

export function LibraryWorkbench({ accountMenu }: { accountMenu: ReactNode }) {
  const [catalog, setCatalog] = useState<LibraryCatalog | null>(null)
  const [catalogError, setCatalogError] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<LibrarySearchResults>(EMPTY_RESULTS)
  const [searched, setSearched] = useState(false)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState("")

  useEffect(() => {
    const controller = new AbortController()
    void loadLibraryCatalog(controller.signal)
      .then(setCatalog)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setCatalogError(error instanceof Error ? error.message : "Library is unavailable.")
      })
    return () => controller.abort()
  }, [])

  const localItems = useMemo(() => {
    if (!catalog) return []
    const documents = catalog.documents.map((document) => ({
      id: `document:${document.id}`,
      kind: documentKind(document.displayFilename),
      title: document.title,
      detail: document.displayFilename,
      date: document.updatedAt,
      href: `/documents/${document.currentRevisionId}`,
    }))
    const papers = catalog.papers.map((paper) => ({
      id: `paper:${paper.id}`,
      kind: "papers" as const,
      title: paper.title,
      detail: paper.authors.map((author) => author.name).slice(0, 3).join(", ") || paper.arxiv_id,
      date: paper.updated_at,
      href: `/papers?paper=${encodeURIComponent(paper.id)}`,
    }))
    const experiments = catalog.experiments.map((experiment) => ({
      id: `experiment:${experiment.id}`,
      kind: "eln" as const,
      title: experiment.title,
      detail: `${experiment.status} · ${experiment.domain || "general"}`,
      date: experiment.updated_at,
      href: `/eln/experiment/${encodeURIComponent(experiment.id)}`,
    }))
    return [...documents, ...papers, ...experiments]
      .filter((item) => filter === "all" || item.kind === filter)
      .sort((left, right) => Date.parse(right.date) - Date.parse(left.date))
  }, [catalog, filter])

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSearchError("")
    setSearching(true)
    try {
      setResults(await searchLibrary(query))
      setSearched(true)
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : "Search failed.")
    } finally {
      setSearching(false)
    }
  }

  const resultCount = results.documents.length + results.ham.length + results.arxiv.length

  return (
    <main className="min-h-screen bg-[#f4f0e4] p-3 pb-24 text-[#203028]">
      <TopRail lead={<TopRailTitle>Library</TopRailTitle>} accountMenu={accountMenu} />

      <div className="mx-auto max-w-[1520px] overflow-hidden border border-[#65705d]/45 bg-[#faf7ed] shadow-[0_24px_70px_-52px_#18352a]">
        <header className="relative border-b border-[#65705d]/35 px-5 py-8 sm:px-8 lg:px-12">
          <div className="absolute inset-0 opacity-[0.07] [background-image:radial-gradient(#18352a_0.7px,transparent_0.7px)] [background-size:8px_8px]" />
          <div className="relative grid gap-7 lg:grid-cols-[minmax(0,1fr)_minmax(28rem,0.85fr)] lg:items-end">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-[#596650]">Galaxy Brain · Living research atlas</p>
              <h1 className="font-display mt-3 max-w-3xl text-4xl leading-[0.98] text-[#17382a] sm:text-6xl">The whole field, not a dropdown.</h1>
              <p className="mt-4 max-w-2xl font-serif text-lg leading-7 text-[#485548]">
                Papers, notes, experiment records, extracted structures, and shared HAM memory remain distinct objects—visible together and traceable to their source.
              </p>
            </div>
            <form onSubmit={submitSearch} className="border border-[#65705d]/45 bg-[#eef0df] p-4">
              <label htmlFor="library-search" className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#596650]">
                Search document corpus · HAM · arXiv
              </label>
              <div className="mt-2 flex gap-2">
                <Input
                  id="library-search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  minLength={2}
                  maxLength={500}
                  placeholder="A mechanism, method, claim, or exact phrase…"
                  className="h-11 rounded-none border-[#65705d]/45 bg-[#faf7ed] font-serif"
                />
                <Button type="submit" disabled={searching || query.trim().length < 2} className="h-11 rounded-none bg-[#214c38] px-4 text-[#faf7ed] hover:bg-[#17382a]">
                  {searching ? <Loader2 className="h-4 w-4 animate-spin" aria-label="Searching" /> : <Search className="h-4 w-4" aria-hidden="true" />}
                  <span className="hidden sm:inline">Search</span>
                </Button>
              </div>
              {searchError ? <p role="alert" className="mt-2 text-sm text-[#a3482f]">{searchError}</p> : null}
            </form>
          </div>
        </header>

        <section aria-labelledby="intake-heading" className="grid border-b border-[#65705d]/35 lg:grid-cols-[14rem_1fr]">
          <div className="border-b border-[#65705d]/35 bg-[#e4e9d4] p-5 lg:border-b-0 lg:border-r">
            <p className="font-mono text-xs tracking-[0.22em] text-[#214c38]">I · DATA HOOVER</p>
            <h2 id="intake-heading" className="font-display mt-2 text-2xl text-[#17382a]">Bring anything</h2>
            <p className="mt-2 text-sm leading-6 text-[#53604f]">One intake desk; source-specific transforms preserve provenance.</p>
          </div>
          <div className="grid sm:grid-cols-2 xl:grid-cols-4">
            {INTAKE_OPTIONS.map(({ icon: Icon, label, text, href }) => (
              <Link key={label} href={href} className="group min-h-32 border-b border-[#65705d]/25 p-5 transition hover:bg-[#eef0df] sm:border-r xl:border-b-0">
                <Icon className="h-5 w-5 text-[#214c38]" aria-hidden="true" />
                <p className="font-display mt-3 text-lg text-[#17382a] group-hover:underline">{label}</p>
                <p className="mt-1 text-sm text-[#66705c]">{text}</p>
              </Link>
            ))}
          </div>
        </section>

        {searched ? (
          <section aria-live="polite" className="border-b border-[#65705d]/35 bg-[#f7f2e6] px-5 py-7 sm:px-8 lg:px-12">
            <div className="mb-5 flex items-end justify-between gap-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#66705c]">II · Search projection</p>
                <h2 className="font-display mt-1 text-3xl text-[#17382a]">{resultCount} visible results</h2>
              </div>
              <p className="hidden max-w-sm text-right text-xs text-[#66705c] sm:block">Each lane keeps its authority and provenance. Results are not silently blended.</p>
            </div>
            {results.unavailable.length ? (
              <p role="status" className="mb-5 border-l-2 border-[#c27b3a] pl-3 text-sm text-[#765630]">
                Partial search: {results.unavailable.join(", ")} {results.unavailable.length === 1 ? "is" : "are"} unavailable. No substitute results were inserted.
              </p>
            ) : null}
            <div className="grid gap-7 lg:grid-cols-3">
              <Section title="Your documents" eyebrow="Exact corpus passages">
                <div className="space-y-3">
                  {results.documents.map((result) => (
                    <Link key={result.documentRef} href={`/documents/${result.documentRevisionId}`} className="block border-l-2 border-[#c27b3a] pl-3 hover:bg-[#efe8d8]">
                      <p className="font-display text-lg text-[#17382a]">{result.title}</p>
                      <p className="mt-1 line-clamp-3 text-sm leading-5 text-[#4f5c50]">{result.snippet}</p>
                      <p className="mt-1 font-mono text-[10px] text-[#78806b]">{result.displayFilename} · {result.source.representationKind}</p>
                    </Link>
                  ))}
                  {results.documents.length === 0 ? <EmptyLine>No matching document passages.</EmptyLine> : null}
                </div>
              </Section>
              <Section title="Shared memory" eyebrow="HAM multi-hop">
                <div className="space-y-3">
                  {results.ham.map((result) => (
                    <article key={result.id} className="border-l-2 border-[#65705d] pl-3">
                      <p className="font-display text-lg text-[#17382a]">{result.metadata?.title || "Memory"}</p>
                      <p className="mt-1 line-clamp-4 text-sm leading-5 text-[#4f5c50]">{result.content}</p>
                      <p className="mt-1 font-mono text-[10px] text-[#78806b]">HAM {result.id} · tier {result.tier}{result.hop !== undefined ? ` · hop ${result.hop}` : ""}</p>
                    </article>
                  ))}
                  {results.ham.length === 0 ? <EmptyLine>No matching shared memories.</EmptyLine> : null}
                </div>
              </Section>
              <Section title="Outside the atlas" eyebrow={`arXiv · ${results.arxivTotal} possible`}>
                <div className="space-y-3">
                  {results.arxiv.map((result) => (
                    <a key={`${result.arxiv_id}v${result.arxiv_version}`} href={result.abs_url} className="block border-l-2 border-[#4e5a8c] pl-3 hover:bg-[#efe8d8]">
                      <p className="font-display text-lg text-[#17382a]">{result.title}</p>
                      <p className="mt-1 text-sm text-[#4f5c50]">{result.authors.slice(0, 3).map((author) => author.name).join(", ")}</p>
                      <p className="mt-1 font-mono text-[10px] text-[#78806b]">{result.arxiv_id}v{result.arxiv_version}</p>
                    </a>
                  ))}
                  {results.arxiv.length === 0 ? <EmptyLine>No matching arXiv papers.</EmptyLine> : null}
                </div>
              </Section>
            </div>
          </section>
        ) : null}

        <section className="px-5 py-7 sm:px-8 lg:px-12">
          <div className="flex flex-col gap-4 border-b border-[#65705d]/35 pb-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#66705c]">III · Local collection</p>
              <h2 className="font-display mt-1 text-3xl text-[#17382a]">Documents, papers, and ELN together</h2>
            </div>
            <div className="flex flex-wrap gap-1" aria-label="Filter library">
              {FILTERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setFilter(item.id)}
                  aria-pressed={filter === item.id}
                  className={`border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition ${filter === item.id ? "border-[#214c38] bg-[#214c38] text-[#faf7ed]" : "border-[#78806b]/45 bg-transparent text-[#53604f] hover:bg-[#e4e9d4]"}`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {catalogError ? <p role="alert" className="mt-5 text-sm text-[#a3482f]">{catalogError}</p> : null}
          {catalog?.unavailable.length ? (
            <p role="status" className="mt-5 border-l-2 border-[#c27b3a] pl-3 text-sm text-[#765630]">
              Partial collection: {catalog.unavailable.join(", ")} {catalog.unavailable.length === 1 ? "is" : "are"} unavailable. Other sources remain visible.
            </p>
          ) : null}
          {!catalog && !catalogError ? <p className="mt-5 flex items-center gap-2 text-sm text-[#66705c]"><Loader2 className="h-4 w-4 animate-spin" /> Surveying the collection…</p> : null}
          {catalog && localItems.length === 0 ? <EmptyLine>Nothing in this view yet. Use the intake desk to add the first object.</EmptyLine> : null}
          <div className="mt-4 divide-y divide-[#78806b]/25">
            {localItems.map((item, index) => {
              const Icon = item.kind === "papers"
                ? BookOpen
                : item.kind === "eln"
                  ? FlaskConical
                  : item.kind === "images"
                    ? ImageIcon
                    : item.kind === "audio"
                      ? AudioLines
                      : FileText
              return (
                <Link key={item.id} href={item.href} className="grid gap-2 py-4 transition hover:bg-[#eef0df] sm:grid-cols-[3rem_minmax(0,1fr)_10rem] sm:items-center sm:px-3">
                  <span className="font-mono text-xs text-[#78806b]">{String(index + 1).padStart(2, "0")}</span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <Icon className="h-4 w-4 shrink-0 text-[#214c38]" aria-hidden="true" />
                      <span className="font-display truncate text-lg text-[#17382a]">{item.title}</span>
                    </span>
                    <span className="mt-1 block truncate text-sm text-[#66705c]">{item.detail}</span>
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-wide text-[#78806b] sm:text-right">{dateLabel(item.date)}</span>
                </Link>
              )
            })}
          </div>
        </section>

        <footer className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-[#65705d]/35 bg-[#e4e9d4] px-5 py-4 font-mono text-[10px] uppercase tracking-[0.16em] text-[#596650] sm:px-8 lg:px-12">
          <span className="inline-flex items-center gap-1.5"><BrainCircuit className="h-3.5 w-3.5" /> Durable objects</span>
          <span>Source-bound results</span>
          <span>Open to revision</span>
        </footer>
      </div>
    </main>
  )
}
