import type { GraphScale } from "./graph-layout-client.js"

export type GraphSemanticNavigationPlan =
  | Readonly<{ kind: "local"; scale: GraphScale }>
  | Readonly<{ kind: "route"; href: string; focusRef: string }>

export function isExactPinnedProofGraphReference(reference: unknown): boolean

export function planProofCorpusScaleNavigation(
  currentUrl: string,
  requestedScale: GraphScale,
  proofGraphReference: string | null | undefined,
): GraphSemanticNavigationPlan

export function proofGraphReturnHref(
  currentUrl: string,
  focusReference: string | null | undefined,
): string | null
