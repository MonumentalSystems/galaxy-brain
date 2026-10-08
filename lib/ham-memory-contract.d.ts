import type { HamMemoryDetail, HamMemoryEdge, HamMemoryView } from "./ham-memory-client"

export const HAM_MEMORY_MAX_LINKS: number
export const HAM_MEMORY_MAX_HYDRATED_NEIGHBORS: number
export const HAM_MEMORY_REQUEST_MAX_BYTES: number
export const HAM_MEMORY_UPSTREAM_REQUEST_MAX_BYTES: number
export const HAM_MEMORY_UPSTREAM_RESPONSE_MAX_BYTES: number
export const HAM_MEMORY_RELATIONS: readonly string[]

export class HamMemoryContractError extends Error {
  status: number
  constructor(message: string, status?: number)
}

export class HamMemoryUpstreamResponseError extends Error {}

export type ParsedHamMemoryMutation =
  | {
      action: "supersede"
      body: {
        expectedVersion: number
        idempotencyKey: string
        content?: string
        title?: string | null
        type?: string | null
        project?: string | null
        repo?: string | null
        task?: string | null
        sequence?: string | null
        scopes?: string[]
        cues?: string[]
        reason?: string | null
      }
    }
  | { action: "link"; targetMemoryId: string; relation: string }
  | { action: "unlink"; linkId: string; expectedVersion: number; reason?: string | null }

export function parseHamMemoryId(value: unknown, label?: string): string
export function parseHamMemoryMutation(input: unknown): ParsedHamMemoryMutation
export function buildHamMemorySupersedeChanges(
  memory: HamMemoryDetail,
  draft: {
    title: string
    content: string
    organization: HamMemoryDetail["organization"]
  },
): {
  content?: string
  title?: string | null
  project?: string | null
  repo?: string | null
  task?: string | null
  sequence?: string | null
  scopes?: string[]
}
export function buildHamSupersedeUpstreamBody(
  rawMemory: unknown,
  input: Extract<ParsedHamMemoryMutation, { action: "supersede" }>["body"],
): Record<string, unknown>
export function findHamMemoryLinkSource(
  rawLinks: unknown,
  viewedMemoryId: string,
  linkId: string,
): string
export function projectHamMemoryForBrowser(raw: unknown): HamMemoryView["memory"]
export function normalizeHamMemoryLinks(
  rawLinks: unknown,
  viewedMemoryId: string,
): { edges: HamMemoryView["edges"]; truncated: boolean }
export function buildHamMemoryView(
  rawMemory: unknown,
  rawLinks: unknown,
  adjacentMemories?: Map<string, unknown> | Record<string, unknown>,
): HamMemoryView
export function hamMemoryAdjacentIds(rawMemory: unknown, rawLinks: unknown): string[]
export function describeHamMemoryEdge(
  edge: HamMemoryEdge,
  currentMemoryId: string,
): { label: string; other: string; tone: string }
