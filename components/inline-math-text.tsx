"use client"

import { useMemo } from "react"
import katex from "katex"

/**
 * Renders a single line of text that may carry inline TeX.
 *
 * Titles arrive from arXiv and from agents with the maths left in, so a paper
 * called "Instantons on $S^{4}$" was being shown with its delimiters and
 * backslashes intact wherever a title is displayed. MarkdownRenderer cannot be
 * used here: it emits block markup, and these are headings, table cells and
 * list labels. This renders the maths and leaves everything else alone.
 *
 * Storage and exports keep the raw text; this is display only.
 */

/** `$...$` or `\(...\)`, whichever comes first, without crossing a newline. */
const INLINE_MATH = /\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)/g

/** The options the Markdown pipeline uses, so both render maths identically. */
const KATEX_OPTIONS = { trust: false, throwOnError: true, maxExpand: 1000, displayMode: false } as const

type Segment = { text: string; math: boolean }

function segments(source: string): Segment[] {
  const output: Segment[] = []
  let index = 0
  for (const match of source.matchAll(INLINE_MATH)) {
    const start = match.index ?? 0
    if (start > index) output.push({ text: source.slice(index, start), math: false })
    output.push({ text: match[1] ?? match[2] ?? "", math: true })
    index = start + match[0].length
  }
  if (index < source.length) output.push({ text: source.slice(index), math: false })
  return output
}

export function InlineMathText({ children, className }: { children: string; className?: string }) {
  const parts = useMemo(() => segments(children ?? ""), [children])

  // Nothing to do for the common case, and no wrapper span either.
  if (!parts.some((part) => part.math)) {
    return className ? <span className={className}>{children}</span> : <>{children}</>
  }

  return (
    <span className={className}>
      {parts.map((part, position) => {
        if (!part.math) return <span key={position}>{part.text}</span>
        let html: string
        try {
          html = katex.renderToString(part.text, KATEX_OPTIONS)
        } catch {
          // Unparseable maths stays as the author wrote it rather than vanishing.
          return <span key={position}>{`$${part.text}$`}</span>
        }
        return <span key={position} dangerouslySetInnerHTML={{ __html: html }} />
      })}
    </span>
  )
}
