"use client"

import { Layers3 } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import { MarkdownRenderer } from "@/components/markdown-renderer"
import { Button } from "@/components/ui/button"
import {
  projectDocumentStructure,
  type ProjectedDocumentBlock,
} from "@/lib/document-structure-projector.js"
import type { GalaxyDocumentStructure } from "@/lib/ingestion-contract.js"

const DISCLOSURE_STEP = 100

export type DocumentStructureReaderProps = {
  structure: GalaxyDocumentStructure
  className?: string
}

function regionSummary(block: ProjectedDocumentBlock) {
  if (!block.region) return null
  const coordinates = Object.entries(block.region)
    .filter(([, value]) => typeof value === "number")
    .slice(0, 4)
    .map(([key, value]) => `${key} ${Number(value).toFixed(2)}`)
  return coordinates.length ? coordinates.join(" · ") : null
}

function blockMarkdown(block: ProjectedDocumentBlock) {
  const parts = []
  if (block.text?.trim()) parts.push(block.text)
  if (block.latex?.trim()) parts.push(`$$\n${block.latex}\n$$`)
  return parts.join("\n\n")
}

export function DocumentStructureReader({ structure, className = "" }: DocumentStructureReaderProps) {
  const projectionState = useMemo(
    () => {
      try {
        return {
          projection: projectDocumentStructure(structure, { maxBlocks: 20_000, batchSize: DISCLOSURE_STEP }),
          error: "",
        }
      } catch {
        return { projection: null, error: "This derived structure is invalid. The exact original remains available." }
      }
    },
    [structure],
  )
  const [batchIndex, setBatchIndex] = useState(0)
  useEffect(() => setBatchIndex(0), [structure])
  if (!projectionState.projection) {
    return <div role="alert" className="m-6 rounded-xl border border-[#b66238] bg-[#fff7e9] p-4 text-sm text-[#8a3524]">{projectionState.error}</div>
  }
  const projection = projectionState.projection
  const totalBatches = Math.max(1, Math.ceil(projection.totalBlocks / DISCLOSURE_STEP))
  const boundedBatchIndex = Math.min(batchIndex, totalBatches - 1)
  const start = boundedBatchIndex * DISCLOSURE_STEP
  const visibleBlocks = projection.blocks.slice(start, start + DISCLOSURE_STEP)

  return (
    <article className={`research-prose mx-auto max-w-4xl px-6 py-10 md:px-12 ${className}`}>
      <header className="mb-8 border-b border-[color:var(--research-line)] pb-4">
        <p className="research-kicker inline-flex items-center gap-2">
          <Layers3 aria-hidden="true" className="h-4 w-4" />Structured text
        </p>
        <p className="research-muted mt-2 text-sm">
          {projection.totalBlocks.toLocaleString()} bounded blocks across {projection.pages.length.toLocaleString()} pages.
          Every block retains its source page and region when the converter supplied them.
        </p>
      </header>

      <div className="space-y-6">
        {visibleBlocks.map((block) => {
          const markdown = blockMarkdown(block)
          const region = regionSummary(block)
          return (
            <section
              key={block.id}
              className="border-l-2 border-[hsl(var(--research-accent)/0.35)] pl-4"
              aria-label={`${block.kind} block${block.page ? ` on page ${block.page}` : ""}`}
            >
              <p className="research-smallcaps mb-2 text-[10px] text-[hsl(var(--research-muted))]">
                {block.kind}{block.page ? ` · page ${block.page}` : ""}{region ? ` · ${region}` : ""}
              </p>
              {markdown ? (
                <MarkdownRenderer content={markdown} images="omit" className="research-markdown" />
              ) : (
                <p className="research-muted text-sm italic">Non-text structure retained at this coordinate.</p>
              )}
            </section>
          )
        })}
      </div>

      {totalBatches > 1 ? (
        <nav className="mt-8 flex flex-wrap items-center justify-center gap-3 border-t border-[color:var(--research-line)] pt-5" aria-label="Structured text batches">
          <Button
            type="button"
            variant="outline"
            disabled={boundedBatchIndex === 0}
            onClick={() => setBatchIndex((index) => Math.max(0, index - 1))}
          >
            Previous blocks
          </Button>
          <p className="research-muted text-xs" aria-live="polite">
            Block batch {boundedBatchIndex + 1} of {totalBatches}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={boundedBatchIndex >= totalBatches - 1}
            onClick={() => setBatchIndex((index) => Math.min(totalBatches - 1, index + 1))}
          >
            Next blocks
          </Button>
        </nav>
      ) : null}
    </article>
  )
}
