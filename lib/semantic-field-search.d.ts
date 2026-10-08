import type { HamSearchResult } from "./ham-search-client"
import type { DocumentCorpusSearchItem } from "./document-corpus-search.js"
import type { SemanticEntity } from "./semantic-field"

export const FIELD_SEARCH_RESULT_LIMIT: 8
export const FIELD_SEARCH_QUERY_MAX: 500
export const FIELD_SEARCH_SNIPPET_MAX: 280

export interface SemanticFieldHamSearchItem {
  id: string
  title: string
  summary: string
  tier: number
  score?: number
  type?: HamSearchResult["metadata"] extends { type?: infer Type } ? Type : string
}

export type SemanticFieldCorpusSearchItem = DocumentCorpusSearchItem

export interface SemanticFieldSearchProjection {
  query: string
  galaxy: { total: number; items: SemanticEntity[] }
  corpus: { total: number; items: readonly SemanticFieldCorpusSearchItem[]; hasMore: boolean }
  ham: { total: number; items: SemanticFieldHamSearchItem[] }
}

export function projectSemanticFieldSearch(
  entities: SemanticEntity[],
  corpusResults: SemanticFieldCorpusSearchItem[],
  hamResults: HamSearchResult[],
  query: string,
): SemanticFieldSearchProjection
