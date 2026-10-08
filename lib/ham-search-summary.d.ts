import type { HamSearchResult } from "./ham-search-client"

export function summarizeHamSearchResult(result: HamSearchResult): Readonly<{
  title: string
  snippet: string
}>
