import type { AtlasHydrationAvailability } from "../atlas-object-hydration"
import type { TaskSummary } from "../types/tasks"

export type AtlasTaskSelection = Readonly<{
  task: TaskSummary
  subjectRef: string
}>

export function resolveAtlasTaskSelection(input?: {
  subjectRef?: unknown
  availability?: unknown
  hydration?: AtlasHydrationAvailability[string]
  tasks?: readonly TaskSummary[]
}): AtlasTaskSelection | null
