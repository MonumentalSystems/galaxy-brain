import type { GalaxyNode } from "./galaxy-brain-service"

export type BoardLayout = "columns" | "grid" | "freeform"

export type BoardColumn = {
  name: string
  nodes: GalaxyNode[]
}

export declare const BOARD_LAYOUTS: BoardLayout[]
export declare const UNSORTED_COLUMN: string

export function isBoardLayout(value: unknown): value is BoardLayout
export function nodeColumn(node: GalaxyNode): string
export function groupIntoColumns(nodes: GalaxyNode[], columnNames?: string[]): BoardColumn[]
export function assignToColumn(column: string, order?: number): Record<string, string | number>
export function boardNodes(nodes: GalaxyNode[], boardId: string): GalaxyNode[]
