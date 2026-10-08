import type { ActiveObjectLinkRow } from "./authorized-graph-source"

export function normalizeObjectLinkPage(value: unknown): {
  readonly links: readonly ActiveObjectLinkRow[]
  readonly invalid: number
  readonly total: number
}
