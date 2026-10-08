import type { AtlasHydrationAvailability } from "../atlas-object-hydration"

export type AtlasContextLensLink = Readonly<{
  id: "graph" | "field"
  label: "Open in Graph" | "Open in Field"
  href: string
}>

export function atlasContextLensLinks(
  subjectRef?: unknown,
  hydration?: AtlasHydrationAvailability[string],
): readonly AtlasContextLensLink[]
