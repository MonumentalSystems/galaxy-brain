export async function refreshCommittedHamMemory(action, memoryId, refresh) {
  try {
    return {
      status: "committed",
      action,
      memoryId,
      view: await refresh(memoryId),
    }
  } catch {
    return {
      status: "committed-refresh-failed",
      action,
      memoryId,
      view: null,
    }
  }
}
