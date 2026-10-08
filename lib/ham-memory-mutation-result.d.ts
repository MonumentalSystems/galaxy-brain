import type { HamMemoryMutationResult, HamMemoryView } from "./ham-memory-client"

export function refreshCommittedHamMemory(
  action: HamMemoryMutationResult["action"],
  memoryId: string,
  refresh: (memoryId: string) => Promise<HamMemoryView>,
): Promise<HamMemoryMutationResult>
