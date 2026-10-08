import type { CreateTaskInput, TaskDetail, TaskEventPage, TaskPage } from "@/lib/types/tasks"
import { mergeTaskPages } from "@/lib/ham-task-adapter"

async function requestJson(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, cache: "no-store" })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(body?.detail || body?.error || `Task request failed (${response.status})`)
  }
  return body
}

export async function fetchTaskPage(cursor?: string, signal?: AbortSignal): Promise<TaskPage> {
  const query = new URLSearchParams({ limit: "200" })
  if (cursor) query.set("cursor", cursor)
  return await requestJson(`/api/tasks?${query}`, { signal }) as TaskPage
}

export async function fetchTaskSnapshot(signal?: AbortSignal, maxPages = 5): Promise<TaskPage> {
  let tasks = [] as TaskPage["tasks"]
  let cursor: string | undefined
  let nextCursor: string | undefined
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await fetchTaskPage(cursor, signal)
    tasks = mergeTaskPages(tasks, page.tasks)
    nextCursor = page.nextCursor
    if (!nextCursor) return { tasks, truncated: false }
    cursor = nextCursor
  }
  return { tasks, nextCursor, truncated: Boolean(nextCursor) }
}

export async function createTask(input: CreateTaskInput, idempotencyKey: string) {
  return requestJson("/api/tasks", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(input),
  })
}

export async function fetchTaskDetail(taskId: string, signal?: AbortSignal): Promise<TaskDetail> {
  return await requestJson(`/api/tasks/${encodeURIComponent(taskId)}`, { signal }) as TaskDetail
}

export async function recordExternalTaskCompletion(
  taskId: string,
  input: { expectedVersion: number; summary: string; performedByRef: string; references: string[] },
  idempotencyKey: string,
): Promise<TaskDetail> {
  return await requestJson(
    `/api/tasks/${encodeURIComponent(taskId)}/external-completion`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(input),
    },
  ) as TaskDetail
}

export async function fetchTaskEvents(taskId: string, cursor = 0, signal?: AbortSignal): Promise<TaskEventPage> {
  const query = new URLSearchParams({ limit: "100" })
  if (cursor) query.set("cursor", String(cursor))
  return await requestJson(`/api/tasks/${encodeURIComponent(taskId)}/events?${query}`, { signal }) as TaskEventPage
}

export async function fetchAllTaskEvents(
  taskId: string,
  afterEventId = 0,
  signal?: AbortSignal,
  maxPages = 100,
): Promise<TaskEventPage> {
  const events = [] as TaskEventPage["events"]
  const seenEventIds = new Set<string>()
  let cursor = afterEventId
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await fetchTaskEvents(taskId, cursor, signal)
    for (const event of page.events) {
      if (seenEventIds.has(event.id)) continue
      seenEventIds.add(event.id)
      events.push(event)
    }
    if (!page.hasMore) return { events, nextCursor: page.nextCursor ?? cursor, hasMore: false }
    if (page.nextCursor === undefined || page.nextCursor <= cursor) {
      throw new Error("HAM returned a non-advancing task event cursor")
    }
    cursor = page.nextCursor
  }
  return { events, nextCursor: cursor, hasMore: true }
}
