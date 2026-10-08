"use client"

import { MarkdownRenderer } from "@/components/markdown-renderer"

export function ResearchMarkdownDocument({ markdown }: { markdown: string }) {
  return <MarkdownRenderer content={markdown} images="omit" />
}
