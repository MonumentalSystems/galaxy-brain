export type PaperEnhanceIntent = "explain" | "challenge" | "compare" | "synthesize"

export const PAPER_ENHANCE_INTENTS: readonly PaperEnhanceIntent[]
export const MAX_PAPER_ENHANCE_REFERENCES: 8
export const MAX_PAPER_ENHANCE_REFERENCE_CHARACTERS: 500

export function normalizePaperEnhanceReferences(
  anchorRef: string,
  additionalRefs?: string | readonly string[],
): readonly string[]
export function paperEnhanceReferenceInputState(
  anchorRef: string,
  additionalRefs?: string | readonly string[],
): Readonly<{ references: readonly string[]; error: string }>
export function paperEnhancePreset(intent: PaperEnhanceIntent, paperTitle: string): Readonly<{
  intent: PaperEnhanceIntent
  title: string
  goal: string
}>
export function paperEnhanceIntentAvailability(
  intent: PaperEnhanceIntent,
  references: readonly string[],
  readable: boolean,
): Readonly<{ enabled: boolean; reason: string }>
export function paperEnhanceIntentAvailabilityForInput(
  intent: PaperEnhanceIntent,
  input: Readonly<{ references: readonly string[]; error: string }>,
  readable: boolean,
): Readonly<{ enabled: boolean; reason: string }>
export function paperTaskConstructorHref(task: { id: string; version: number }): string
export function paperTaskConstructorHrefFromLink(value: unknown): string | undefined
export function parsePaperTaskConstructorRequest(value: unknown): Readonly<{
  taskId: string
  version: number
}> | null
